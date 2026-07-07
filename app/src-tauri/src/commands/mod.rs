pub mod agent_docs;
pub mod bootstrap;
pub mod fs;
pub mod harnesses;
pub mod hub;
pub mod permissions;
pub mod projects;
pub mod registry;
pub mod remotes;
pub mod snippets;
pub mod subagents;

use std::env;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static DATA_HOME: OnceLock<PathBuf> = OnceLock::new();
static CODE_HOME: OnceLock<PathBuf> = OnceLock::new();

pub fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        let home = env::var("HOME")
            .or_else(|_| env::var("USERPROFILE"))
            .unwrap_or_default();
        PathBuf::from(home).join(rest)
    } else {
        PathBuf::from(path)
    }
}

fn home_dir() -> PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"))
}

fn legacy_data_home() -> PathBuf {
    home_dir().join("Dev").join(".skill-hub")
}

/// User-owned data home. Resolution: `$SKILL_HUB_HOME` → `$SKILL_HUB_DIR` →
/// `~/.skill-hub/`. If the default doesn't have `registry.yaml` yet but the
/// legacy in-repo location does, the legacy path is used (matches Python).
pub fn data_home() -> Result<PathBuf, String> {
    if let Some(p) = DATA_HOME.get() {
        return Ok(p.clone());
    }

    let resolved = resolve_data_home_path();
    let home_env = env::var("SKILL_HUB_HOME").ok().filter(|s| !s.is_empty());
    let code_env = env::var("SKILL_HUB_CODE").ok().filter(|s| !s.is_empty());
    if let (Some(h), Some(c)) = (&home_env, &code_env) {
        if *h == *c {
            return Err(format!(
                "SKILL_HUB_HOME and SKILL_HUB_CODE point to the same path: {}",
                h
            ));
        }
    }

    if let Err(e) = std::fs::create_dir_all(&resolved) {
        return Err(format!(
            "Cannot create data home {}: {}",
            resolved.display(),
            e
        ));
    }
    for sub in ["skills", "mcp-servers", "_hub-backups"] {
        let _ = std::fs::create_dir_all(resolved.join(sub));
    }
    let _ = DATA_HOME.set(resolved.clone());
    Ok(resolved)
}

fn resolve_data_home_path() -> PathBuf {
    if let Ok(p) = env::var("SKILL_HUB_HOME") {
        if !p.is_empty() {
            return expand_tilde(&p);
        }
    }
    if let Ok(p) = env::var("SKILL_HUB_DIR") {
        if !p.is_empty() {
            // Tauri prints deprecation via stderr (single shot)
            let _ = eprintln_once(
                "warning: SKILL_HUB_DIR is deprecated; use SKILL_HUB_HOME",
            );
            return expand_tilde(&p);
        }
    }
    let default = home_dir().join(".skill-hub");
    if !default.join("registry.yaml").exists() {
        let legacy = legacy_data_home();
        if legacy.join("registry.yaml").exists() {
            let _ = eprintln_once(&format!(
                "warning: using legacy data home at {}; run `hub migrate-home`",
                legacy.display()
            ));
            return legacy;
        }
    }
    default
}

/// Code home — read-only assets. In production: the bundle's `Resources/hub/`.
/// In dev: walk up from `CARGO_MANIFEST_DIR` (or the binary's dir) until a dir
/// with both `hub.py` and `skills/` is found.
pub fn code_home() -> Result<PathBuf, String> {
    if let Some(p) = CODE_HOME.get() {
        return Ok(p.clone());
    }
    let resolved = resolve_code_home_path()?;
    let _ = CODE_HOME.set(resolved.clone());
    Ok(resolved)
}

fn resolve_code_home_path() -> Result<PathBuf, String> {
    if let Ok(p) = env::var("SKILL_HUB_CODE") {
        if !p.is_empty() {
            return Ok(expand_tilde(&p));
        }
    }
    // In dev mode under `cargo run`/Tauri dev, CARGO_MANIFEST_DIR points at
    // app/src-tauri. Walk up from there to find the repo root.
    let mut search_roots: Vec<PathBuf> = Vec::new();
    if let Ok(manifest) = env::var("CARGO_MANIFEST_DIR") {
        search_roots.push(PathBuf::from(manifest));
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            search_roots.push(parent.to_path_buf());
        }
    }
    for root in &search_roots {
        if let Some(found) = walk_up_for_code_home(root) {
            return Ok(found);
        }
    }
    // Last-ditch: try the binary's bundle Resources path (macOS .app layout).
    if let Ok(exe) = env::current_exe() {
        if let Some(macos) = exe.parent() {
            if let Some(contents) = macos.parent() {
                let candidate = contents.join("Resources").join("hub");
                if candidate.join("hub.py").exists() {
                    return Ok(candidate);
                }
            }
        }
    }
    Err("Could not locate code_home (set SKILL_HUB_CODE).".into())
}

fn walk_up_for_code_home(start: &Path) -> Option<PathBuf> {
    let mut current: &Path = start;
    loop {
        if current.join("hub.py").exists() && current.join("skills").is_dir() {
            return Some(current.to_path_buf());
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent,
            _ => return None,
        }
    }
}

/// Path to the `hub.py` script for shelling out.
pub fn hub_py() -> Result<PathBuf, String> {
    Ok(code_home()?.join("hub.py"))
}

fn eprintln_once(msg: &str) -> std::io::Result<()> {
    static WARNED: OnceLock<()> = OnceLock::new();
    if WARNED.set(()).is_ok() {
        eprintln!("{msg}");
    }
    Ok(())
}

// Back-compat shim for any caller still using the old name. Resolves to data_home.
#[deprecated(note = "use data_home() instead")]
#[allow(dead_code)]
pub fn hub_dir() -> Result<PathBuf, String> {
    data_home()
}
