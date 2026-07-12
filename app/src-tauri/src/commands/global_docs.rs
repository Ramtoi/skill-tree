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

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{expand_tilde, harnesses};

/// Serializes all global-doc writes so a drift re-check + atomic rename never
/// races another write to the same (or a sibling) file.
static GLOBAL_DOC_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize)]
pub struct GlobalDocReadResult {
    /// Absolute, tilde-expanded path of the harness's global instruction file.
    pub path: String,
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

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for b in digest.iter() {
        out.push(HEX[(*b >> 4) as usize] as char);
        out.push(HEX[(*b & 0x0f) as usize] as char);
    }
    out
}

/// Resolve the absolute global-doc path for a harness id from the registry.
/// Unknown id (or a harness that declares no global doc) is an error — the path
/// is NEVER taken from a caller-supplied argument.
fn resolve_global_doc_path(harness_id: &str) -> Result<PathBuf, String> {
    let meta = harnesses::registry()
        .iter()
        .find(|h| h.id == harness_id)
        .ok_or_else(|| format!("Unknown harness id: {harness_id}"))?;
    let raw = meta.global_doc.as_deref().ok_or_else(|| {
        format!("Harness {harness_id} has no user-global instruction file")
    })?;
    Ok(expand_tilde(raw))
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
        let mut f = fs::File::create(&tmp_path)
            .map_err(|e| format!("Cannot stage write: {e}"))?;
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
    let path = abs.to_string_lossy().into_owned();
    match fs::read(&abs) {
        Ok(bytes) => {
            let content = String::from_utf8(bytes.clone())
                .map_err(|_| format!("{path} is not valid UTF-8"))?;
            Ok(GlobalDocReadResult {
                path,
                exists: true,
                sha256: Some(sha256_hex(&bytes)),
                content,
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(GlobalDocReadResult {
            path,
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

    // Drift guard: when the caller passes the sha it read, refuse to clobber a
    // file that changed on disk since. `None` = force/create (first save of a
    // missing file, or an explicit overwrite after a confirm).
    if let Some(expected) = expected_sha256 {
        let current = match fs::read(&abs) {
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

    atomic_write(&abs, &content)?;
    Ok(GlobalDocWriteResult {
        sha256: sha256_hex(content.as_bytes()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_harness_id_is_rejected() {
        let err = global_doc_read_impl("not-a-harness".into()).unwrap_err();
        assert!(err.contains("Unknown harness"), "got: {err}");
        let err = global_doc_write_impl("not-a-harness".into(), "x".into(), None).unwrap_err();
        assert!(err.contains("Unknown harness"), "got: {err}");
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
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, sha256_hex(b"abcd"));
    }
}
