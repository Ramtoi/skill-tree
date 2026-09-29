use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

use super::{data_home, expand_tilde, sha256_hex};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct SaveSkillMeta {
    pub version: String,
    pub description: String,
    pub scope: String,
    pub upstream: String,
    /// Harness-affinity CSV (e.g. `"claude-code,codex"`). Empty string clears the
    /// affinity back to "all effective harnesses". Always forwarded (idempotent).
    pub harnesses: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
pub struct SkillDocument {
    pub name: String,
    pub description: String,
    pub body: String,
    /// Every frontmatter key other than `name`/`description`, in file order —
    /// `disable-model-invocation`, `user-invocable`, `allowed-tools`, `license`,
    /// `metadata`, anything a future harness adds. The editor's IPC payload
    /// carries only name/description/body, so this is never sent over the
    /// bridge in either direction (`skip`); the save path re-reads it from the
    /// SKILL.md on disk. Without it, saving a skill silently stripped these
    /// keys and the next `hub sync` mirrored the loss into the registry.
    #[serde(default, skip)]
    pub extra: serde_yaml::Mapping,
}

#[tauri::command]
pub async fn read_registry() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(read_registry_impl)
        .await
        .map_err(|e| format!("read_registry task failed: {e}"))?
}

fn read_registry_impl() -> Result<Value, String> {
    let registry_path = data_home()?.join("registry.yaml");
    let content = std::fs::read_to_string(&registry_path)
        .map_err(|e| format!("Cannot read registry.yaml: {e}"))?;
    serde_yaml::from_str(&content).map_err(|e| format!("Cannot parse registry.yaml: {e}"))
}

/// Live fingerprint of `registry.yaml`, computed at read time so the frontend
/// can compare it against the report's sync-time fingerprint (staleness).
/// `sha256` is authoritative; `mtime` is stored for cheap eyeballing only.
#[derive(Debug, Serialize)]
pub struct RegistryFingerprint {
    pub sha256: String,
    pub mtime: f64,
}

/// The report (opaque, passed through as raw JSON — schema evolution is guarded
/// by its own `schema_version`) plus the live registry fingerprint.
#[derive(Debug, Serialize)]
pub struct SyncReportEnvelope {
    pub report: Value,
    pub registry_current: RegistryFingerprint,
}

/// Read `<data_home>/state/sync-report.json`, returning `None` when it is absent,
/// alongside a freshly computed fingerprint of the live `registry.yaml`.
#[tauri::command]
pub async fn sync_report() -> Result<Option<SyncReportEnvelope>, String> {
    tauri::async_runtime::spawn_blocking(sync_report_impl)
        .await
        .map_err(|e| format!("sync_report task failed: {e}"))?
}

fn sync_report_impl() -> Result<Option<SyncReportEnvelope>, String> {
    let home = data_home()?;
    sync_report_in(&home)
}

fn sync_report_in(home: &Path) -> Result<Option<SyncReportEnvelope>, String> {
    let report_path = home.join("state").join("sync-report.json");
    let raw = match std::fs::read_to_string(&report_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Cannot read sync report: {e}")),
    };
    let report: Value =
        serde_json::from_str(&raw).map_err(|e| format!("Cannot parse sync report: {e}"))?;
    // Unknown schema ⇒ treat as absent: the UI degrades to its honest
    // "unknown — run sync" state instead of rendering mistyped fields.
    if report.get("schema_version").and_then(Value::as_i64) != Some(1) {
        return Ok(None);
    }
    let registry_current = registry_fingerprint(home);
    Ok(Some(SyncReportEnvelope {
        report,
        registry_current,
    }))
}

fn registry_fingerprint(home: &Path) -> RegistryFingerprint {
    let reg = home.join("registry.yaml");
    let sha256 = match std::fs::read(&reg) {
        Ok(bytes) => sha256_hex(&bytes),
        Err(_) => String::new(),
    };
    let mtime = std::fs::metadata(&reg)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    RegistryFingerprint { sha256, mtime }
}

fn skill_md_path_for(name: &str) -> Result<std::path::PathBuf, String> {
    let registry_path = data_home()?.join("registry.yaml");
    let content = std::fs::read_to_string(&registry_path)
        .map_err(|e| format!("Cannot read registry.yaml: {e}"))?;
    let yaml: Value =
        serde_yaml::from_str(&content).map_err(|e| format!("Cannot parse registry.yaml: {e}"))?;

    let source = yaml["skills"][name]["source"]
        .as_str()
        .ok_or_else(|| format!("Skill '{name}' not found in registry"))?;

    Ok(expand_tilde(source).join("SKILL.md"))
}

/// Splits a leading `---\n … \n---\n` YAML frontmatter fence off `content`.
/// Tolerates a leading BOM and CRLF line endings (the opening and closing
/// fence must use the same style; real files are consistent about this).
/// Returns `(Some(frontmatter), body)` for a complete, well-formed fence;
/// otherwise `(None, content-after-BOM)` unchanged — the caller decides
/// whether "no fence" and "an unterminated fence" are both fine (a corpus
/// reader, where an unclosed fence is still searchable text) or whether the
/// latter is an error (`parse_skill_document`, which owns metadata).
pub fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let stripped = content.trim_start_matches('\u{feff}');

    let (after_open, eol) = if let Some(r) = stripped.strip_prefix("---\r\n") {
        (r, "\r\n")
    } else if let Some(r) = stripped.strip_prefix("---\n") {
        (r, "\n")
    } else {
        return (None, stripped);
    };

    let closer = format!("{eol}---{eol}");
    match after_open.find(&closer) {
        Some(idx) => {
            let frontmatter = &after_open[..idx];
            let body = &after_open[idx + closer.len()..];
            (Some(frontmatter), body.trim_start_matches(eol))
        }
        None => (None, stripped),
    }
}

fn parse_skill_document(content: &str) -> Result<SkillDocument, String> {
    let (frontmatter, body_str) = split_frontmatter(content);
    let Some(frontmatter) = frontmatter else {
        let trimmed = content.trim_start_matches('\u{feff}');
        // A fence was attempted but never closed — that's a real error (an
        // absent fence is not: the whole file is just body).
        if trimmed.starts_with("---\n") || trimmed.starts_with("---\r\n") {
            return Err("Invalid SKILL.md frontmatter: missing closing ---".into());
        }
        return Ok(SkillDocument {
            body: trimmed.to_string(),
            ..Default::default()
        });
    };

    let body = body_str.to_string();

    // A Mapping (IndexMap-backed) rather than a BTreeMap: `extra` must round-trip
    // in the author's original key order, not alphabetised.
    let meta: serde_yaml::Mapping = serde_yaml::from_str(frontmatter)
        .map_err(|e| format!("Invalid SKILL.md frontmatter: {e}"))?;

    let get_str = |key: &str| {
        meta.get(serde_yaml::Value::String(key.to_string()))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let name = get_str("name");
    let description = get_str("description");

    let extra: serde_yaml::Mapping = meta
        .into_iter()
        .filter(|(k, _)| !matches!(k.as_str(), Some("name") | Some("description")))
        .collect();

    Ok(SkillDocument {
        name,
        description,
        body,
        extra,
    })
}

fn indent_block(value: &str) -> String {
    if value.is_empty() {
        return "  ".to_string();
    }

    value
        .lines()
        .map(|line| {
            if line.is_empty() {
                "  ".to_string()
            } else {
                format!("  {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Render the frontmatter keys the editor does not own back into YAML, in the
/// order they were read from the file. Returns an empty string when there are
/// none — `serde_yaml` would otherwise emit a literal `{}` flow mapping.
fn render_extra_frontmatter(extra: &serde_yaml::Mapping) -> String {
    if extra.is_empty() {
        return String::new();
    }
    let Ok(rendered) = serde_yaml::to_string(extra) else {
        // Unserialisable frontmatter is vanishingly unlikely (it came from a
        // successful parse). Dropping it here is no worse than the old
        // behaviour, and refusing the save outright would be worse.
        return String::new();
    };
    let body = rendered
        .trim_start_matches("---\n")
        .trim_end()
        .trim_end_matches("...")
        .trim_end();
    if body.is_empty() {
        return String::new();
    }
    format!("{body}\n")
}

fn build_skill_document(document: &SkillDocument) -> String {
    let mut output = String::new();
    output.push_str("---\n");
    output.push_str(&format!("name: {}\n", document.name.trim()));
    output.push_str("description: |\n");
    output.push_str(&indent_block(document.description.trim_end()));
    output.push('\n');
    output.push_str(&render_extra_frontmatter(&document.extra));
    output.push_str("---\n\n");
    output.push_str(document.body.trim_end());
    output.push('\n');
    output
}

/// Atomically replace `skill_md` with `document`, returning the previous
/// on-disk content so the caller can roll back.
///
/// Takes the path rather than a skill name so it is testable against a temp
/// dir without touching the process-wide `data_home()` / `code_home()` caches.
fn rewrite_skill_document(skill_md: &Path, document: &SkillDocument) -> Result<String, String> {
    let previous_content = std::fs::read_to_string(skill_md).unwrap_or_default();

    // The IPC payload is only name/description/body, so every other
    // frontmatter key has to come off disk or it is lost. An unparseable
    // current file yields no extras rather than blocking the save.
    let mut merged = document.clone();
    merged.extra = parse_skill_document(&previous_content)
        .map(|d| d.extra)
        .unwrap_or_default();
    let rebuilt = build_skill_document(&merged);

    let tmp_path = skill_md.with_extension("md.tmp");
    std::fs::write(&tmp_path, &rebuilt)
        .map_err(|e| format!("Cannot stage SKILL.md at {}: {e}", tmp_path.display()))?;
    std::fs::rename(&tmp_path, skill_md)
        .map_err(|e| format!("Cannot replace SKILL.md at {}: {e}", skill_md.display()))?;

    Ok(previous_content)
}

fn run_hub_command(args: &[String]) -> Result<(), String> {
    let output = super::hub_output(args)?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{}{}", stdout, stderr).trim().to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn read_skill_content(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_skill_content_impl(name))
        .await
        .map_err(|e| format!("read_skill_content task failed: {e}"))?
}

fn read_skill_content_impl(name: String) -> Result<String, String> {
    let skill_md = skill_md_path_for(&name)?;
    std::fs::read_to_string(&skill_md)
        .map_err(|e| format!("Cannot read SKILL.md at {}: {e}", skill_md.display()))
}

#[tauri::command]
pub async fn read_skill_document(name: String) -> Result<SkillDocument, String> {
    tauri::async_runtime::spawn_blocking(move || read_skill_document_impl(name))
        .await
        .map_err(|e| format!("read_skill_document task failed: {e}"))?
}

fn read_skill_document_impl(name: String) -> Result<SkillDocument, String> {
    let skill_md = skill_md_path_for(&name)?;
    let content = std::fs::read_to_string(&skill_md)
        .map_err(|e| format!("Cannot read SKILL.md at {}: {e}", skill_md.display()))?;
    parse_skill_document(&content)
}

#[tauri::command]
pub async fn write_skill_content(name: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_skill_content_impl(name, content))
        .await
        .map_err(|e| format!("write_skill_content task failed: {e}"))?
}

fn write_skill_content_impl(name: String, content: String) -> Result<(), String> {
    let skill_md = skill_md_path_for(&name)?;
    std::fs::write(&skill_md, content)
        .map_err(|e| format!("Cannot write SKILL.md at {}: {e}", skill_md.display()))
}

#[tauri::command]
pub async fn save_skill_full(
    name: String,
    document: SkillDocument,
    meta: SaveSkillMeta,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || save_skill_full_impl(name, document, meta))
        .await
        .map_err(|e| format!("save_skill_full task failed: {e}"))?
}

fn save_skill_full_impl(
    name: String,
    document: SkillDocument,
    meta: SaveSkillMeta,
) -> Result<String, String> {
    let current_name = name;
    let target_name = document.name.trim().to_string();

    if target_name.is_empty() {
        return Err("Skill name cannot be empty".into());
    }

    if current_name != target_name {
        run_hub_command(&[
            "rename".to_string(),
            current_name.clone(),
            target_name.clone(),
        ])?;
    }

    let skill_md = skill_md_path_for(&target_name)?;
    let previous_content = rewrite_skill_document(&skill_md, &document)?;

    let args = vec![
        "set-meta".to_string(),
        target_name.clone(),
        "--version".to_string(),
        meta.version,
        "--description".to_string(),
        meta.description,
        "--scope".to_string(),
        meta.scope,
        "--upstream".to_string(),
        meta.upstream,
        "--harnesses".to_string(),
        meta.harnesses,
    ];

    if let Err(err) = run_hub_command(&args) {
        let _ = std::fs::write(&skill_md, previous_content);
        return Err(err);
    }

    Ok(target_name)
}

/// Shared spawn for the JSON-returning bridge commands below. Marshals one
/// `hub.py <args>` subprocess (optionally piping `stdin`), returns parsed JSON on
/// success, and the combined stdout+stderr as an error string otherwise.
fn run_hub_json(args: &[String], stdin: Option<&str>) -> Result<Value, String> {
    super::hub_json_value(args, stdin)
}

/// Aggregate array of hand-authored project-local skills not yet adopted, across
/// all registered projects. Wraps `hub project scan-skills --json` (read-only).
#[tauri::command]
pub async fn local_skill_candidates() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(local_skill_candidates_impl)
        .await
        .map_err(|e| format!("local_skill_candidates task failed: {e}"))?
}

fn local_skill_candidates_impl() -> Result<Value, String> {
    run_hub_json(
        &[
            "project".to_string(),
            "scan-skills".to_string(),
            "--json".to_string(),
        ],
        None,
    )
}

/// Registry-only toggle of a bundle or skill on a configured remote (no box
/// push). Wraps `hub remote equip <id> --kind {bundle|skill} --name <name>
/// --state {on|off} --json`; returns `{ ok, bundles, enabled }`.
#[tauri::command]
pub async fn remote_equip(id: String, kind: String, name: String, on: bool) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || remote_equip_impl(id, kind, name, on))
        .await
        .map_err(|e| format!("remote_equip task failed: {e}"))?
}

fn remote_equip_impl(id: String, kind: String, name: String, on: bool) -> Result<Value, String> {
    let state = if on { "on" } else { "off" };
    run_hub_json(
        &[
            "remote".to_string(),
            "equip".to_string(),
            id,
            "--kind".to_string(),
            kind,
            "--name".to_string(),
            name,
            "--state".to_string(),
            state.to_string(),
            "--json".to_string(),
        ],
        None,
    )
}

/// Shape the argv for a decisions-driven source apply: the caller's
/// `["source","add","git",url,…]` vector (WITHOUT `--dry-run`) with
/// `--decisions-stdin --json` appended. Extracted so the flag contract is
/// unit-testable without spawning Python.
fn source_apply_args(args: Vec<String>) -> Vec<String> {
    let mut full = args;
    full.push("--decisions-stdin".to_string());
    full.push("--json".to_string());
    full
}

/// Apply a source add with per-conflict decisions. Appends `--decisions-stdin
/// --json` to the caller's `["source","add","git",url,…]` vector (which must NOT
/// include `--dry-run`) and pipes `{ "decisions": <decisions> }` on stdin.
///
/// `selected_new` (JS: `selectedNew`) narrows which NEW candidates get imported.
/// It is OMITTED from the stdin payload when null/absent, which the CLI reads as
/// "import every NEW candidate" — the back-compatible default.
#[tauri::command]
pub async fn source_add_apply(
    args: Vec<String>,
    decisions: Value,
    selected_new: Option<Vec<String>>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        source_add_apply_impl(args, decisions, selected_new)
    })
    .await
    .map_err(|e| format!("source_add_apply task failed: {e}"))?
}

fn source_add_apply_impl(
    args: Vec<String>,
    decisions: Value,
    selected_new: Option<Vec<String>>,
) -> Result<Value, String> {
    let full = source_apply_args(args);
    let mut payload = serde_json::json!({ "decisions": decisions });
    if let Some(selected) = selected_new {
        payload["selected_new"] = serde_json::json!(selected);
    }
    let serialized = serde_json::to_string(&payload)
        .map_err(|e| format!("Cannot serialize decisions: {e}"))?;
    run_hub_json(&full, Some(&serialized))
}

#[cfg(test)]
mod sync_report_tests {
    use super::sync_report_in;
    use crate::commands::hex_encode;
    use sha2::{Digest, Sha256};
    use tempfile::TempDir;

    #[test]
    fn sync_report_absent_returns_none() {
        let td = TempDir::new().unwrap();
        // No state/sync-report.json under this home.
        let out = sync_report_in(td.path()).expect("should not error");
        assert!(out.is_none());
    }

    #[test]
    fn sync_report_present_returns_envelope_with_fingerprint() {
        let td = TempDir::new().unwrap();
        let registry_bytes = b"version: '1'\nprojects: {}\n";
        std::fs::write(td.path().join("registry.yaml"), registry_bytes).unwrap();
        std::fs::create_dir_all(td.path().join("state")).unwrap();
        std::fs::write(
            td.path().join("state").join("sync-report.json"),
            r#"{"schema_version":1,"ok":true,"projects":{"alpha":{"ok":true}}}"#,
        )
        .unwrap();

        let out = sync_report_in(td.path())
            .expect("should not error")
            .expect("report present");
        assert_eq!(out.report["schema_version"], 1);
        assert_eq!(out.report["projects"]["alpha"]["ok"], true);

        let mut hasher = Sha256::new();
        hasher.update(registry_bytes);
        let expected = hex_encode(&hasher.finalize());
        assert_eq!(out.registry_current.sha256, expected);
        assert_eq!(expected.len(), 64, "full sha-256, not truncated");
        assert!(out.registry_current.mtime > 0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_skill_document, parse_skill_document, rewrite_skill_document, source_apply_args,
        split_frontmatter, SaveSkillMeta, SkillDocument,
    };
    use tempfile::TempDir;

    #[test]
    fn split_frontmatter_tolerates_a_bom() {
        let content = "\u{feff}---\nname: x\n---\nBODY";
        assert_eq!(split_frontmatter(content), (Some("name: x"), "BODY"));
    }

    #[test]
    fn split_frontmatter_tolerates_crlf() {
        let content = "---\r\nname: x\r\n---\r\nBODY\r\n";
        assert_eq!(split_frontmatter(content), (Some("name: x"), "BODY\r\n"));
    }

    #[test]
    fn source_apply_args_appends_decisions_flags() {
        let base = vec![
            "source".to_string(),
            "add".to_string(),
            "git".to_string(),
            "https://example/x.git".to_string(),
            "--id".to_string(),
            "x".to_string(),
        ];
        let full = source_apply_args(base.clone());
        // Contract: the caller's argv must pass through untouched (hub.py parses
        // positionally), and apply mode must never inherit a stray --dry-run.
        assert_eq!(&full[..base.len()], &base[..]);
        assert_eq!(full[base.len()], "--decisions-stdin");
        assert_eq!(full[base.len() + 1], "--json");
        assert!(!full.iter().any(|a| a == "--dry-run"));
    }

    #[test]
    fn save_skill_meta_carries_harnesses_field() {
        // The forwarding contract: SaveSkillMeta round-trips a harnesses CSV so
        // save_skill_full can append `--harnesses <csv>` (empty clears).
        let json = r#"{"version":"1.0.0","description":"d","scope":"portable","upstream":"","harnesses":"claude-code,codex"}"#;
        let meta: SaveSkillMeta = serde_json::from_str(json).expect("deserialize");
        assert_eq!(meta.harnesses, "claude-code,codex");
        let empty = r#"{"version":"1.0.0","description":"d","scope":"portable","upstream":"","harnesses":""}"#;
        let meta: SaveSkillMeta = serde_json::from_str(empty).expect("deserialize empty");
        assert_eq!(meta.harnesses, "");
    }

    #[test]
    fn parses_frontmatter_and_body() {
        let content = "---\nname: brainstorm\ndescription: |\n  First line\n  Second line\n---\n\n# Heading\nBody\n";
        let parsed = parse_skill_document(content).expect("parse should succeed");
        assert_eq!(
            parsed,
            SkillDocument {
                name: "brainstorm".into(),
                description: "First line\nSecond line".into(),
                body: "# Heading\nBody\n".into(),
                extra: serde_yaml::Mapping::new(),
            }
        );
    }

    /// The skill editor's IPC payload is only `{name, description, body}`, and
    /// `hub.py set-meta` restores just version/description/scope/upstream/
    /// harnesses — it rewrites the invocation flags ONLY under `--invocation`.
    /// So anything the parse → build round trip drops is gone for good, and the
    /// next `hub sync` mirrors the stripped frontmatter back into the registry
    /// (a `user-only` skill silently reverts to `auto`).
    #[test]
    fn round_trip_preserves_unknown_frontmatter_keys() {
        let content = concat!(
            "---\n",
            "name: brainstorm\n",
            "description: |\n",
            "  Old description\n",
            "disable-model-invocation: true\n",
            "allowed-tools:\n",
            "  - Read\n",
            "  - Grep\n",
            "license: MIT\n",
            "metadata:\n",
            "  author: x\n",
            "---\n",
            "\n",
            "# Heading\n",
            "Body text\n",
        );

        let mut parsed = parse_skill_document(content).expect("parse should succeed");
        assert_eq!(parsed.name, "brainstorm");
        // A `|` block scalar keeps one trailing newline when another key
        // follows; `build_skill_document` trims it, so compare trimmed.
        assert_eq!(parsed.description.trim_end(), "Old description");
        parsed.description = "New description".into();

        let rebuilt = build_skill_document(&parsed);

        // The two keys the editor owns take the new values...
        assert!(
            rebuilt.contains("name: brainstorm"),
            "name lost:\n{rebuilt}"
        );
        assert!(
            rebuilt.contains("description: |\n  New description"),
            "description not updated:\n{rebuilt}"
        );
        // ...and every other key survives with its value.
        assert!(
            rebuilt.contains("disable-model-invocation: true"),
            "invocation flag dropped — the skill silently reverts to `auto`:\n{rebuilt}"
        );
        assert!(
            rebuilt.contains("license: MIT"),
            "license dropped:\n{rebuilt}"
        );
        assert!(
            rebuilt.contains("allowed-tools:") && rebuilt.contains("Grep"),
            "allowed-tools sequence dropped:\n{rebuilt}"
        );
        assert!(
            rebuilt.contains("metadata:") && rebuilt.contains("author: x"),
            "metadata mapping dropped:\n{rebuilt}"
        );
        assert!(
            rebuilt.ends_with("# Heading\nBody text\n"),
            "body damaged:\n{rebuilt}"
        );
        // The result must still be a single well-formed frontmatter block.
        assert_eq!(
            rebuilt.matches("\n---\n").count(),
            1,
            "expected exactly one closing fence:\n{rebuilt}"
        );
        let reparsed = parse_skill_document(&rebuilt).expect("rebuilt doc must re-parse");
        assert_eq!(reparsed.description.trim_end(), "New description");
        assert_eq!(reparsed.body, "# Heading\nBody text\n");
        // Values, types and key order all survive the round trip.
        assert_eq!(reparsed.extra, parsed.extra);
        assert_eq!(
            reparsed.extra.keys().filter_map(|k| k.as_str()).collect::<Vec<_>>(),
            vec!["disable-model-invocation", "allowed-tools", "license", "metadata"]
        );
    }

    /// End-to-end on disk: the save path re-reads the current SKILL.md and
    /// carries its unknown keys forward, because the IPC payload never has them.
    /// Exercised through `rewrite_skill_document` (the exact step
    /// `save_skill_full_impl` performs) so the test needs no `data_home()` /
    /// `code_home()` — both are process-wide `OnceLock`s that other tests in
    /// this binary already populate, and racing them risks writing into the
    /// developer's real `~/.skill-hub`.
    #[test]
    fn save_path_carries_forward_on_disk_frontmatter() {
        let td = TempDir::new().unwrap();
        let skill_md = td.path().join("SKILL.md");
        std::fs::write(
            &skill_md,
            "---\nname: probe\ndescription: |\n  old\ndisable-model-invocation: true\nlicense: MIT\n---\n\nold body\n",
        )
        .unwrap();

        // What the editor actually sends: name + description + body, nothing else.
        let incoming = SkillDocument {
            name: "probe".into(),
            description: "new".into(),
            body: "new body".into(),
            ..Default::default()
        };

        let previous = rewrite_skill_document(&skill_md, &incoming).expect("rewrite");
        assert!(
            previous.contains("disable-model-invocation: true"),
            "previous content must be returned intact for rollback"
        );

        let on_disk = std::fs::read_to_string(&skill_md).unwrap();
        assert!(
            on_disk.contains("description: |\n  new"),
            "description not saved:\n{on_disk}"
        );
        assert!(
            on_disk.contains("new body"),
            "body not saved:\n{on_disk}"
        );
        assert!(
            on_disk.contains("disable-model-invocation: true"),
            "the save destroyed the invocation flag already on disk:\n{on_disk}"
        );
        assert!(
            on_disk.contains("license: MIT"),
            "the save destroyed `license` already on disk:\n{on_disk}"
        );
        // The staging file must not survive the atomic rename.
        assert!(!td.path().join("SKILL.md.tmp").exists());
    }

    #[test]
    fn rebuilds_structured_skill_markdown() {
        let doc = SkillDocument {
            name: "brainstorm".into(),
            description: "Use this skill when...\nTrigger on X.".into(),
            body: "# Brainstorm\n\nBody text".into(),
            ..Default::default()
        };

        let rebuilt = build_skill_document(&doc);
        assert!(rebuilt.contains("name: brainstorm"));
        assert!(rebuilt.contains("description: |\n  Use this skill when...\n  Trigger on X."));
        assert!(rebuilt.ends_with("# Brainstorm\n\nBody text\n"));
    }
}
