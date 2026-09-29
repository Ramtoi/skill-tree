//! Global agent-doc commands — read and write the USER-LEVEL instruction file
//! each harness reads for every session (`~/.claude/CLAUDE.md`,
//! `~/.codex/AGENTS.md`, …).
//!
//! Distinct from `agent_docs.rs`, which owns the per-PROJECT root docs. Here the
//! target path is resolved ONLY from the harness registry by id — the frontend
//! never names an absolute path, so a caller cannot redirect a write anywhere
//! but a known harness's own dotfile. Writes are drift-guarded (sha256),
//! atomic (sibling temp + rename), and serialized through a module mutex.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::sha256_hex;

/// Serializes all global-doc writes so a drift re-check + atomic rename never
/// races another write to the same (or a sibling) file.
static GLOBAL_DOC_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize)]
pub struct GlobalDocReadResult {
    /// Absolute, tilde-expanded path of the harness's global instruction file
    /// (the harness's OWN dotfile — unchanged whether or not it is a link).
    pub path: String,
    /// Where reads/writes actually land: `path` itself, or — when `path` is a
    /// symlink resolving to another harness's doc (global-doc-sharing) — that
    /// real file. Equal to `path` when `is_link` is false.
    pub resolved_path: String,
    /// Whether `path` is a symlink (a "follower" doc). A dangling symlink is
    /// still `true` here; `resolved_path` then falls back to `path` and
    /// `exists` reports `false`.
    pub is_link: bool,
    pub exists: bool,
    /// File body ("" when the file does not exist yet).
    pub content: String,
    /// Hex sha256 of the current bytes, or `None` when the file is absent.
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GlobalDocWriteResult {
    /// Hex sha256 of the freshly written bytes.
    pub sha256: String,
}

/// Resolve the absolute global-doc path for a harness id from the registry.
/// Unknown id (or a harness that declares no global doc) is an error — the path
/// is NEVER taken from a caller-supplied argument.
#[derive(Deserialize)]
struct DocPathProjection {
    harness_id: String,
    path: Option<String>,
    error: Option<String>,
}

fn projected_doc_path(harness_id: &str, row: DocPathProjection) -> Result<PathBuf, String> {
    if row.harness_id != harness_id {
        return Err("Harness document projection has a different identity".into());
    }
    if let Some(error) = row.error {
        return Err(error);
    }
    let path = PathBuf::from(
        row.path
            .ok_or_else(|| format!("Harness {harness_id} has no user-global instruction file"))?,
    );
    if !path.is_absolute() {
        return Err("Harness document path is not absolute".into());
    }
    Ok(path)
}

fn resolve_global_doc_path(harness_id: &str) -> Result<PathBuf, String> {
    let row = super::hub_json(["harness", "doc", "resolve", harness_id, "--json"], None)?;
    projected_doc_path(harness_id, row)
}

/// Resolve the REAL file a read/write must operate against.
///
/// `abs` is the harness's own dotfile path. When global-doc-sharing
/// (`hub harness doc link`) has turned it into a symlink to another harness's
/// doc, `fs::rename`-based `atomic_write` onto `abs` would silently unlink
/// that symlink and replace it with a plain file — breaking the follow
/// relationship on the very first save. Canonicalizing first and writing
/// through the real target keeps the symlink intact.
///
/// A broken symlink (target does not exist) is deliberately left unresolved:
/// `abs` itself is returned, so a write naturally creates a real file where
/// the dangling link was — the same outcome as `hub harness doc unlink`.
/// Returns `(target, is_link)`.
fn resolve_doc_target(abs: &Path) -> (PathBuf, bool) {
    let is_link = abs.is_symlink();
    if is_link {
        if let Ok(real) = fs::canonicalize(abs) {
            return (real, true);
        }
    }
    (abs.to_path_buf(), is_link)
}

/// Atomic write via a sibling temp file + rename, creating the parent dir if
/// needed. Mirrors `agent_docs::atomic_write`.
fn atomic_write(abs: &Path, content: &str) -> Result<(), String> {
    let parent = abs
        .parent()
        .ok_or_else(|| "No parent dir for write target".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Cannot create parent {}: {e}", parent.display()))?;
    let file_name = abs
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "doc".into());
    let tmp_path = parent.join(format!(".{file_name}.tmp"));
    {
        let mut f = fs::File::create(&tmp_path).map_err(|e| format!("Cannot stage write: {e}"))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("Cannot write content: {e}"))?;
        f.flush().ok();
    }
    fs::rename(&tmp_path, abs).map_err(|e| format!("Cannot finalize write: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn global_doc_read(harness_id: String) -> Result<GlobalDocReadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = GLOBAL_DOC_LOCK.lock().unwrap();
        global_doc_read_impl(harness_id)
    })
    .await
    .map_err(|e| format!("global_doc_read task failed: {e}"))?
}

fn global_doc_read_impl(harness_id: String) -> Result<GlobalDocReadResult, String> {
    let abs = resolve_global_doc_path(&harness_id)?;
    read_doc_at(&abs)
}

/// The read itself, split off `global_doc_read_impl` so tests can drive it
/// against a tempdir instead of the developer's real `~/.claude/CLAUDE.md`.
/// (`$HOME` is process-global; a test that moved it would race every other
/// test in this binary.)
fn read_doc_at(abs: &Path) -> Result<GlobalDocReadResult, String> {
    let path = abs.to_string_lossy().into_owned();
    let (target, is_link) = resolve_doc_target(abs);
    let resolved_path = target.to_string_lossy().into_owned();
    match fs::read(&target) {
        Ok(bytes) => {
            let content = String::from_utf8(bytes.clone())
                .map_err(|_| format!("{path} is not valid UTF-8"))?;
            Ok(GlobalDocReadResult {
                path,
                resolved_path,
                is_link,
                exists: true,
                sha256: Some(sha256_hex(&bytes)),
                content,
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(GlobalDocReadResult {
            path,
            resolved_path,
            is_link,
            exists: false,
            content: String::new(),
            sha256: None,
        }),
        Err(e) => Err(format!("Cannot read {path}: {e}")),
    }
}

#[tauri::command]
pub async fn global_doc_write(
    harness_id: String,
    content: String,
    expected_sha256: Option<String>,
) -> Result<GlobalDocWriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = GLOBAL_DOC_LOCK.lock().unwrap();
        global_doc_write_impl(harness_id, content, expected_sha256)
    })
    .await
    .map_err(|e| format!("global_doc_write task failed: {e}"))?
}

fn global_doc_write_impl(
    harness_id: String,
    content: String,
    expected_sha256: Option<String>,
) -> Result<GlobalDocWriteResult, String> {
    let abs = resolve_global_doc_path(&harness_id)?;
    write_doc_at(&abs, &content, expected_sha256)
}

/// The write itself, split off `global_doc_write_impl` for the same
/// tempdir-testability reason as `read_doc_at`.
fn write_doc_at(
    abs: &Path,
    content: &str,
    expected_sha256: Option<String>,
) -> Result<GlobalDocWriteResult, String> {
    let (target, _is_link) = resolve_doc_target(abs);

    // Drift guard: when the caller passes the sha it read, refuse to clobber a
    // file that changed on disk since. `None` = force/create (first save of a
    // missing file, or an explicit overwrite after a confirm).
    if let Some(expected) = expected_sha256 {
        let current = match fs::read(&target) {
            Ok(bytes) => Some(sha256_hex(&bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("Cannot re-read before write: {e}")),
        };
        if current.as_deref() != Some(expected.as_str()) {
            return Err(format!(
                "drift: {} changed on disk since it was loaded",
                abs.display()
            ));
        }
    }

    // Write through the RESOLVED target so a follower symlink survives the
    // save (see `resolve_doc_target`); `target == abs` when `abs` is not a
    // (resolvable) symlink, so this is a no-op change for every other case.
    atomic_write(&target, content)?;
    Ok(GlobalDocWriteResult {
        sha256: sha256_hex(content.as_bytes()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_or_mismatched_doc_projection_is_rejected() {
        let row = |id: &str, path: Option<&str>, error: Option<&str>| DocPathProjection {
            harness_id: id.into(),
            path: path.map(String::from),
            error: error.map(String::from),
        };
        assert!(
            projected_doc_path("unknown", row("unknown", None, Some("Unknown harness")))
                .unwrap_err()
                .contains("Unknown harness")
        );
        assert!(projected_doc_path("codex", row("claude-code", Some("/tmp/doc"), None)).is_err());
        assert!(projected_doc_path("codex", row("codex", Some("relative"), None)).is_err());
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("AGENTS.md");
        assert_eq!(
            projected_doc_path("codex", row("codex", Some(&path.to_string_lossy()), None)).unwrap(),
            path
        );
    }

    #[test]
    fn atomic_write_creates_parent_and_roundtrips() {
        let dir = std::env::temp_dir().join(format!("st-gdoc-{}", std::process::id()));
        let abs = dir.join("nested").join("CLAUDE.md");
        let _ = fs::remove_dir_all(&dir);
        atomic_write(&abs, "hello world\n").expect("write should create parents");
        let back = fs::read_to_string(&abs).unwrap();
        assert_eq!(back, "hello world\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sha256_hex_is_stable_and_lowercase() {
        let a = sha256_hex(b"abc");
        let b = sha256_hex(b"abc");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, sha256_hex(b"abcd"));
    }

    #[test]
    fn resolve_doc_target_passes_through_a_regular_file() {
        let dir = std::env::temp_dir().join(format!("st-gdoc-plain-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let abs = dir.join("CLAUDE.md");
        fs::write(&abs, "hi\n").unwrap();
        let (target, is_link) = resolve_doc_target(&abs);
        assert_eq!(target, abs);
        assert!(!is_link);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_doc_target_falls_back_to_the_link_itself_when_broken() {
        let dir = std::env::temp_dir().join(format!("st-gdoc-broken-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let abs = dir.join("AGENTS.md");
        std::os::unix::fs::symlink("does-not-exist.md", &abs).unwrap();
        let (target, is_link) = resolve_doc_target(&abs);
        assert_eq!(target, abs); // unresolved: a write here creates a real file
        assert!(is_link);
        let _ = fs::remove_dir_all(&dir);
    }

    /// The bug this whole module wave fixes: a write through a follower
    /// symlink must land on the REAL target and leave the symlink itself
    /// intact — not replace the follower's own dentry with a plain file.
    #[test]
    fn write_through_a_symlink_keeps_the_link_and_updates_the_target() {
        let dir = std::env::temp_dir().join(format!("st-gdoc-link-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("CLAUDE.md");
        fs::write(&source, "original\n").unwrap();
        let follower = dir.join("AGENTS.md");
        std::os::unix::fs::symlink("CLAUDE.md", &follower).unwrap();

        let (target, is_link) = resolve_doc_target(&follower);
        assert!(is_link);
        assert_eq!(
            fs::canonicalize(&target).unwrap(),
            fs::canonicalize(&source).unwrap()
        );

        atomic_write(&target, "updated\n").expect("write through the resolved target");

        // The follower's own dentry is still a symlink (rename never touched it).
        let meta = fs::symlink_metadata(&follower).unwrap();
        assert!(
            meta.file_type().is_symlink(),
            "follower stopped being a link"
        );
        // Reading through the link (fs::read follows symlinks) sees the update.
        assert_eq!(fs::read_to_string(&follower).unwrap(), "updated\n");
        // And the real file itself changed, not a copy.
        assert_eq!(fs::read_to_string(&source).unwrap(), "updated\n");

        let _ = fs::remove_dir_all(&dir);
    }

    /// Each test gets its own dir: `cargo test` runs them on parallel threads
    /// inside ONE process, so a shared pid-only name would collide.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("st-gdoc-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_reports_is_link_and_the_resolved_target_for_a_follower() {
        let dir = scratch("read-follower");
        let source = dir.join("CLAUDE.md");
        fs::write(&source, "shared\n").unwrap();
        let follower = dir.join("AGENTS.md");
        std::os::unix::fs::symlink("CLAUDE.md", &follower).unwrap();

        let plain = read_doc_at(&source).unwrap();
        assert!(!plain.is_link);
        assert_eq!(plain.resolved_path, plain.path);
        assert!(plain.exists);

        let followed = read_doc_at(&follower).unwrap();
        assert!(followed.is_link, "a follower must report is_link");
        assert_eq!(followed.path, follower.to_string_lossy());
        assert_eq!(
            fs::canonicalize(&followed.resolved_path).unwrap(),
            fs::canonicalize(&source).unwrap(),
            "resolved_path must name the SOURCE file, not the link"
        );
        assert!(followed.exists);
        assert_eq!(followed.content, "shared\n");
        // Both sides read the same bytes, so B2 can compare shas across cards.
        assert_eq!(followed.sha256, plain.sha256);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_through_a_dangling_link_is_not_found_but_still_a_link() {
        let dir = scratch("read-dangling");
        let follower = dir.join("AGENTS.md");
        std::os::unix::fs::symlink("CLAUDE.md", &follower).unwrap();

        let got = read_doc_at(&follower).unwrap();
        assert!(got.is_link, "a broken follower is still a link");
        assert!(!got.exists);
        assert_eq!(got.content, "");
        assert_eq!(got.sha256, None);
        // Unresolvable, so it falls back to the link's own path.
        assert_eq!(got.resolved_path, got.path);

        let _ = fs::remove_dir_all(&dir);
    }

    /// A dangling follower is the one case where a write DOES consume the
    /// link — deliberately, and only because nothing can be lost: the target
    /// does not exist. The read that precedes it reports `is_link: true` +
    /// `exists: false`, which is what B2's "Broken link" plaque renders, so
    /// the user is told before saving. Pinned here so the choice cannot be
    /// changed by accident.
    #[test]
    fn write_through_a_dangling_link_creates_a_real_file_and_never_the_target() {
        let dir = scratch("write-dangling");
        let follower = dir.join("AGENTS.md");
        std::os::unix::fs::symlink("CLAUDE.md", &follower).unwrap();

        write_doc_at(&follower, "fresh\n", None).expect("write should succeed");

        let meta = fs::symlink_metadata(&follower).unwrap();
        assert!(!meta.file_type().is_symlink(), "the dead link is consumed");
        assert_eq!(fs::read_to_string(&follower).unwrap(), "fresh\n");
        assert!(
            !dir.join("CLAUDE.md").exists(),
            "a write must never conjure the missing source it pointed at"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_drift_guard_reads_through_the_link_to_the_real_target() {
        let dir = scratch("drift");
        let source = dir.join("CLAUDE.md");
        fs::write(&source, "v1\n").unwrap();
        let follower = dir.join("AGENTS.md");
        std::os::unix::fs::symlink("CLAUDE.md", &follower).unwrap();

        let sha_v1 = sha256_hex(b"v1\n");
        // The sha of the TARGET is what a follower's read handed the UI, so
        // passing it back must be accepted.
        write_doc_at(&follower, "v2\n", Some(sha_v1.clone())).expect("matching sha writes");
        assert_eq!(fs::read_to_string(&source).unwrap(), "v2\n");
        assert!(fs::symlink_metadata(&follower)
            .unwrap()
            .file_type()
            .is_symlink());

        // Someone edits the SOURCE behind the follower's back → stale sha.
        fs::write(&source, "v3-from-elsewhere\n").unwrap();
        let err = write_doc_at(&follower, "v4\n", Some(sha256_hex(b"v2\n"))).unwrap_err();
        assert!(err.contains("drift"), "got: {err}");
        assert_eq!(
            fs::read_to_string(&source).unwrap(),
            "v3-from-elsewhere\n",
            "a drifting write must change nothing"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_link_to_a_directory_fails_cleanly_on_both_read_and_write() {
        let dir = scratch("dir-link");
        let real_dir = dir.join("a-directory");
        fs::create_dir_all(&real_dir).unwrap();
        let follower = dir.join("AGENTS.md");
        std::os::unix::fs::symlink("a-directory", &follower).unwrap();

        // No panic, no `exists: true` with empty content — an honest Err.
        let err = read_doc_at(&follower).unwrap_err();
        assert!(
            err.contains(&follower.to_string_lossy().to_string()),
            "got: {err}"
        );
        let err = write_doc_at(&follower, "x\n", None).unwrap_err();
        assert!(!err.is_empty());
        assert!(real_dir.is_dir(), "the directory must survive");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_utf8_bytes_are_an_error_not_a_lossy_read() {
        let dir = scratch("non-utf8");
        let abs = dir.join("CLAUDE.md");
        fs::write(&abs, [b'c', b'a', b'f', 0xE9, b'\n']).unwrap();

        let err = read_doc_at(&abs).unwrap_err();
        assert!(err.contains("not valid UTF-8"), "got: {err}");
        // The bytes are untouched: the editor refuses rather than mangling.
        assert_eq!(fs::read(&abs).unwrap(), vec![b'c', b'a', b'f', 0xE9, b'\n']);

        let _ = fs::remove_dir_all(&dir);
    }
}
