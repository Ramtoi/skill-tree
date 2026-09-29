//! One-shot read of every searchable BODY in the data home — the corpus
//! behind the Library's content search. Read-only; writes nothing.
//!
//! Frontmatter is stripped only when the fence is well-formed (a matching
//! opening and closing `---`, same line-ending style). An unterminated
//! fence, or a same-line-ending mismatch, is NOT an error here — the whole
//! file (frontmatter syntax included) becomes the searchable body instead,
//! same as `keeps_body_with_unterminated_fence` below pins. So a malformed
//! `SKILL.md` CAN surface `description:`/`allowed-tools:` text in a search
//! excerpt; this is a deliberate "still searchable" fallback, not a bug.

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

use super::registry::split_frontmatter;
use super::{data_home, expand_tilde};

/// Bodies keyed by the name the Library already knows the item as: a registry
/// skill key, or a snippet's file stem. BTreeMap so the JSON payload is
/// deterministic (a stable payload keeps the react-query cache entry stable).
#[derive(Debug, Serialize, Default, PartialEq, Eq)]
pub struct SearchCorpus {
    pub skills: BTreeMap<String, String>,
    pub snippets: BTreeMap<String, String>,
}

/// Hard ceiling per document. The largest real SKILL.md today is 96 KB; this
/// only bounds a pathological file, and truncation is silent because the tail
/// of a 512 KB document is not what a Library search is for.
const MAX_DOC_BYTES: usize = 512 * 1024;

#[tauri::command]
pub async fn read_search_corpus() -> Result<SearchCorpus, String> {
    tauri::async_runtime::spawn_blocking(read_search_corpus_impl)
        .await
        .map_err(|e| format!("read_search_corpus task failed: {e}"))?
}

fn read_search_corpus_impl() -> Result<SearchCorpus, String> {
    let home = data_home()?;
    collect_corpus(&home.join("registry.yaml"), &home.join("snippets"))
}

/// Truncates `s` to at most `max` bytes, walking back to the nearest UTF-8
/// character boundary so the result is always valid. `floor_char_boundary` is
/// unstable on stable Rust — this is the manual equivalent.
fn truncate_at_char_boundary(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Path-taking so the tests can drive it against a temp dir without touching
/// the process-wide `data_home()` OnceLock (same trick `registry.rs` uses for
/// `rewrite_skill_document`).
fn collect_corpus(registry_path: &Path, snippets_dir: &Path) -> Result<SearchCorpus, String> {
    let content = std::fs::read_to_string(registry_path)
        .map_err(|e| format!("Cannot read registry.yaml: {e}"))?;
    let yaml: Value =
        serde_yaml::from_str(&content).map_err(|e| format!("Cannot parse registry.yaml: {e}"))?;

    let mut skills = BTreeMap::new();
    if let Some(map) = yaml.get("skills").and_then(Value::as_object) {
        for (name, entry) in map {
            // No `source` (a malformed entry) — skip silently, same as the
            // registry validator elsewhere treats an unresolvable skill.
            let Some(source) = entry.get("source").and_then(Value::as_str) else {
                continue;
            };
            let path = expand_tilde(source).join("SKILL.md");
            match std::fs::read_to_string(&path) {
                Ok(raw) => {
                    let (_, body) = split_frontmatter(&raw);
                    skills.insert(
                        name.clone(),
                        truncate_at_char_boundary(body, MAX_DOC_BYTES).to_string(),
                    );
                }
                Err(e) => {
                    eprintln!("read_search_corpus: skipping {name}: {e}");
                }
            }
        }
    }

    let mut snippets = BTreeMap::new();
    match std::fs::read_dir(snippets_dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                match std::fs::read_to_string(&path) {
                    Ok(raw) => {
                        let (_, body) = split_frontmatter(&raw);
                        snippets.insert(
                            stem.to_string(),
                            truncate_at_char_boundary(body, MAX_DOC_BYTES).to_string(),
                        );
                    }
                    Err(e) => {
                        eprintln!("read_search_corpus: skipping snippet {stem}: {e}");
                    }
                }
            }
        }
        // A registry with no snippets yet has no `snippets/` dir at all —
        // that's an empty map, not a failure.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            eprintln!("read_search_corpus: cannot read snippets dir: {e}");
        }
    }

    Ok(SearchCorpus { skills, snippets })
}

#[cfg(test)]
mod tests {
    use super::collect_corpus;
    use std::fs;
    use tempfile::TempDir;

    /// Writes `registry.yaml` naming one skill whose `source` is `<td>/<dir>`,
    /// and returns that skill dir (caller writes `SKILL.md` into it, or not).
    fn registry_with_one_skill(td: &TempDir, name: &str, dir: &str) -> std::path::PathBuf {
        let skill_dir = td.path().join(dir);
        fs::create_dir_all(&skill_dir).unwrap();
        let registry = td.path().join("registry.yaml");
        fs::write(
            &registry,
            format!("skills:\n  {name}:\n    source: {}\n", skill_dir.display()),
        )
        .unwrap();
        skill_dir
    }

    #[test]
    fn strips_yaml_frontmatter() {
        let td = TempDir::new().unwrap();
        let skill_dir = registry_with_one_skill(&td, "x", "skills/x");
        fs::write(skill_dir.join("SKILL.md"), "---\nname: x\n---\n\nBODY").unwrap();

        let out = collect_corpus(&td.path().join("registry.yaml"), &td.path().join("snippets"))
            .expect("should not error");
        assert_eq!(out.skills.get("x").map(String::as_str), Some("BODY"));
    }

    #[test]
    fn keeps_body_without_frontmatter() {
        let td = TempDir::new().unwrap();
        let skill_dir = registry_with_one_skill(&td, "x", "skills/x");
        fs::write(skill_dir.join("SKILL.md"), "Just a body, no fence.").unwrap();

        let out = collect_corpus(&td.path().join("registry.yaml"), &td.path().join("snippets"))
            .expect("should not error");
        assert_eq!(
            out.skills.get("x").map(String::as_str),
            Some("Just a body, no fence.")
        );
    }

    #[test]
    fn keeps_body_with_unterminated_fence() {
        let td = TempDir::new().unwrap();
        let skill_dir = registry_with_one_skill(&td, "x", "skills/x");
        fs::write(skill_dir.join("SKILL.md"), "---\nname: x\nBODY").unwrap();

        let out = collect_corpus(&td.path().join("registry.yaml"), &td.path().join("snippets"))
            .expect("should not error");
        // Not an error, not stripped, not empty — verbatim.
        assert_eq!(
            out.skills.get("x").map(String::as_str),
            Some("---\nname: x\nBODY")
        );
    }

    #[test]
    fn skips_skill_with_missing_skill_md() {
        let td = TempDir::new().unwrap();
        registry_with_one_skill(&td, "missing", "skills/missing");
        let present_dir = registry_with_one_skill(&td, "present", "skills/present");
        // `registry_with_one_skill` overwrites registry.yaml — rebuild it with
        // BOTH entries.
        fs::write(
            td.path().join("registry.yaml"),
            format!(
                "skills:\n  missing:\n    source: {}\n  present:\n    source: {}\n",
                td.path().join("skills/missing").display(),
                present_dir.display(),
            ),
        )
        .unwrap();
        fs::write(present_dir.join("SKILL.md"), "present body").unwrap();
        // `missing`'s dir exists but has no SKILL.md in it.

        let out = collect_corpus(&td.path().join("registry.yaml"), &td.path().join("snippets"))
            .expect("a missing SKILL.md must not fail the whole read");
        assert!(!out.skills.contains_key("missing"));
        assert_eq!(out.skills.get("present").map(String::as_str), Some("present body"));
    }

    #[test]
    fn reads_snippets_and_ignores_non_md() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("registry.yaml"), "skills: {}\n").unwrap();
        let snippets_dir = td.path().join("snippets");
        fs::create_dir_all(&snippets_dir).unwrap();
        fs::write(snippets_dir.join("a.md"), "snippet body").unwrap();
        fs::write(snippets_dir.join("notes.txt"), "not a snippet").unwrap();

        let out =
            collect_corpus(&td.path().join("registry.yaml"), &snippets_dir).expect("should not error");
        assert_eq!(out.snippets.len(), 1);
        assert_eq!(out.snippets.get("a").map(String::as_str), Some("snippet body"));
    }

    #[test]
    fn missing_snippets_dir_is_not_an_error() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("registry.yaml"), "skills: {}\n").unwrap();

        let out = collect_corpus(
            &td.path().join("registry.yaml"),
            &td.path().join("no-such-snippets-dir"),
        )
        .expect("a missing snippets dir must not fail the read");
        assert!(out.snippets.is_empty());
    }

    #[test]
    fn unreadable_registry_is_an_error() {
        let td = TempDir::new().unwrap();
        let err = collect_corpus(
            &td.path().join("registry.yaml"), // never written
            &td.path().join("snippets"),
        )
        .unwrap_err();
        assert!(err.contains("Cannot read registry.yaml"), "{err}");
    }

    #[test]
    fn truncates_at_a_char_boundary() {
        let td = TempDir::new().unwrap();
        let skill_dir = registry_with_one_skill(&td, "x", "skills/x");
        // A multi-byte char ("é", 2 bytes in UTF-8) straddling the truncation
        // boundary: pad with ASCII up to MAX_DOC_BYTES - 1, then the char.
        const MAX_DOC_BYTES: usize = 512 * 1024;
        let mut body = "a".repeat(MAX_DOC_BYTES - 1);
        body.push('é');
        body.push_str("more text after the boundary");

        fs::write(skill_dir.join("SKILL.md"), &body).unwrap();

        let out = collect_corpus(&td.path().join("registry.yaml"), &td.path().join("snippets"))
            .expect("should not error");
        let got = out.skills.get("x").expect("skill present");
        assert!(got.len() <= MAX_DOC_BYTES);
        assert!(std::str::from_utf8(got.as_bytes()).is_ok(), "must be valid UTF-8");
    }
}
