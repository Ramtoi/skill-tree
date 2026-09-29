pub mod agent_docs;
pub mod backup;
pub mod bootstrap;
pub mod fs;
pub mod global_docs;
pub mod harnesses;
pub mod hooks;
pub mod hub;
pub mod mcp;
pub mod permissions;
pub mod projects;
pub mod registry;
pub mod remotes;
pub mod search;
pub mod skill_files;
pub mod snippets;
pub mod subagents;
pub mod usage;
pub mod usage_enrich;
pub mod usage_codex_metadata;

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
    // Last-ditch: the packaged resource dir, resolved from the binary's location.
    if let Ok(exe) = env::current_exe() {
        if let Some(found) = code_home_beside_exe(&exe) {
            return Ok(found);
        }
    }
    Err("Could not locate code_home (set SKILL_HUB_CODE).".into())
}

/// Packaged-bundle fallback: locate `hub/` from the executable's own path.
/// Pure over `exe` so both layouts are unit-testable against a fixture dir
/// without a real bundle (and without any `cfg(windows)` gating).
///
/// Two layouts, checked in this order:
///
/// 1. `<exe_dir>/hub/hub.py` — Tauri installs `bundle.resources` **flat beside
///    the executable** on Windows (NSIS/MSI) and Linux. `walk_up_for_code_home`
///    cannot find this: it wants `hub.py` directly in an ancestor dir alongside a
///    `skills/` dir, but the packaged layout nests it one level down as
///    `<install>/hub/hub.py` and ships no `skills/`. Without this candidate
///    `code_home()` fails on Windows and every `hub_cmd` is dead.
/// 2. `<exe_dir>/../Resources/hub/hub.py` — the macOS `.app` layout
///    (`Contents/MacOS/<exe>` → `Contents/Resources/hub`).
///
/// Checking (1) first is harmless on macOS: `Contents/MacOS/` holds no `hub/`
/// dir, so it falls straight through to (2).
fn code_home_beside_exe(exe: &Path) -> Option<PathBuf> {
    let exe_dir = exe.parent()?;

    let beside = exe_dir.join("hub");
    if beside.join("hub.py").exists() {
        return Some(beside);
    }

    let contents = exe_dir.parent()?;
    let resources = contents.join("Resources").join("hub");
    if resources.join("hub.py").exists() {
        return Some(resources);
    }

    None
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

// ── hub.py subprocess runner ────────────────────────────────────────────────
//
// The one place that spawns `python hub.py <args>`. Every command bridge in
// this crate is meant to route through these functions instead of
// re-deriving `resolved_python()` + `code_home()` + `data_home()` + `hub_py()`
// and repeating the env preamble itself. Free functions, not a struct — there
// is no state to carry, and a struct would tempt someone into adding a cache.
// No `static`/`OnceLock` here: `hub.rs`'s tests already set `SKILL_HUB_CODE`
// without restoring it, so any caching here would only make that worse.
use hub::resolved_python;
use std::ffi::OsStr;
use std::io::Write;
use std::process::{Command, Output, Stdio};

/// Build (but do not run) `python hub.py <args>` with the full env preamble.
/// Not cached: resolves the interpreter and both homes fresh on every call.
#[allow(dead_code)]
pub(crate) fn hub_command<I, S>(args: I) -> Result<Command, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let python = resolved_python().ok_or_else(|| {
        "Python not found. Install Python 3 and ensure it is in PATH.".to_string()
    })?;
    let code = code_home()?;
    let data = data_home()?;
    let hub = hub_py()?;

    let mut cmd = Command::new(python);
    cmd.arg(hub)
        .args(args)
        .current_dir(&code)
        .env("SKILL_HUB_HOME", data.as_os_str())
        .env("SKILL_HUB_CODE", code.as_os_str())
        .env_remove("SKILL_HUB_DIR");
    Ok(cmd)
}

/// Same as `hub_command`, minus `SKILL_HUB_HOME` — and it never calls
/// `data_home()` at all. Used ONLY by the registry-free `selfcheck` preflight,
/// which must stay runnable before a data home exists.
#[allow(dead_code)]
pub(crate) fn hub_command_code_only<I, S>(args: I) -> Result<Command, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let python = resolved_python().ok_or_else(|| {
        "Python not found. Install Python 3 and ensure it is in PATH.".to_string()
    })?;
    let code = code_home()?;
    let hub = hub_py()?;

    let mut cmd = Command::new(python);
    cmd.arg(hub)
        .args(args)
        .current_dir(&code)
        .env("SKILL_HUB_CODE", code.as_os_str())
        .env_remove("SKILL_HUB_DIR");
    Ok(cmd)
}

/// One spawn of `hub_command`. `stdin = Some(payload)` pipes the payload to
/// the child and reaps it (kill + wait) if the write fails, instead of
/// leaking a zombie.
#[allow(dead_code)]
pub(crate) fn hub_run<I, S>(args: I, stdin: Option<&str>) -> Result<Output, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut cmd = hub_command(args)?;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    if let Some(payload) = stdin {
        cmd.stdin(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn hub.py: {e}"))?;
        let write_result = child
            .stdin
            .take()
            .expect("stdin is piped")
            .write_all(payload.as_bytes());
        if let Err(e) = write_result {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Failed to pipe stdin to hub.py: {e}"));
        }
        child
            .wait_with_output()
            .map_err(|e| format!("Failed to read hub.py output: {e}"))
    } else {
        cmd.output().map_err(|e| format!("Failed to run hub.py: {e}"))
    }
}

/// `hub_run(args, None)`.
#[allow(dead_code)]
pub(crate) fn hub_output<I, S>(args: I) -> Result<Output, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    hub_run(args, None)
}

/// `hub_run(args, Some(payload))`.
#[allow(dead_code)]
pub(crate) fn hub_stdin<I, S>(args: I, payload: &str) -> Result<Output, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    hub_run(args, Some(payload))
}

/// Run + parse stdout as JSON. A nonzero exit is an `Err` of
/// `combined_output(&out)` (stdout+stderr, trimmed) rather than a JSON parse
/// attempt on whatever partial output an error path produced.
#[allow(dead_code)]
pub(crate) fn hub_json<T, I, S>(args: I, stdin: Option<&str>) -> Result<T, String>
where
    T: serde::de::DeserializeOwned,
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let out = hub_run(args, stdin)?;
    if !out.status.success() {
        return Err(combined_output(&out));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(&stdout)
        .map_err(|e| format!("Cannot parse hub.py JSON output: {e}\nRaw: {stdout}"))
}

/// `hub_json::<serde_json::Value, _, _>` — the shape most call sites want.
#[allow(dead_code)]
pub(crate) fn hub_json_value<I, S>(
    args: I,
    stdin: Option<&str>,
) -> Result<serde_json::Value, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    hub_json::<serde_json::Value, _, _>(args, stdin)
}

/// `format!("{stdout}{stderr}").trim().to_string()` — the one error/blob shape
/// every non-JSON call site wants on a nonzero exit.
#[allow(dead_code)]
pub(crate) fn combined_output(out: &Output) -> String {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    format!("{stdout}{stderr}").trim().to_string()
}

/// Lowercase hex encoding. Moved verbatim from `registry.rs` (was duplicated
/// byte-identically in `agent_docs.rs`).
#[allow(dead_code)]
pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(*b >> 4) as usize] as char);
        out.push(HEX[(*b & 0x0f) as usize] as char);
    }
    out
}

/// `Sha256` digest of `bytes`, hex-encoded.
#[allow(dead_code)]
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_encode(&hasher.finalize())
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Build `<root>/<rel>/hub.py` and return the dir that holds it.
    fn plant_hub_py(root: &Path, rel: &str) -> PathBuf {
        let dir = root.join(rel);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("hub.py"), "# fixture\n").unwrap();
        dir
    }

    #[test]
    fn code_home_beside_exe_finds_packaged_windows_layout() {
        // NSIS/MSI (and Linux) layout: resources land flat beside the exe, so
        // hub.py is at <install>/hub/hub.py. This is the case walk_up_for_code_home
        // cannot reach — without it every hub_cmd is dead on Windows.
        let td = TempDir::new().unwrap();
        let install = td.path().join("Skill Tree");
        let hub = plant_hub_py(&install, "hub");
        let exe = install.join("Skill Tree.exe");

        assert_eq!(code_home_beside_exe(&exe), Some(hub));
    }

    #[test]
    fn code_home_beside_exe_finds_macos_bundle_layout() {
        // Contents/MacOS/<exe> → Contents/Resources/hub. Unchanged behaviour.
        let td = TempDir::new().unwrap();
        let contents = td.path().join("Skill Tree.app").join("Contents");
        let hub = plant_hub_py(&contents, "Resources/hub");
        std::fs::create_dir_all(contents.join("MacOS")).unwrap();
        let exe = contents.join("MacOS").join("Skill Tree");

        assert_eq!(code_home_beside_exe(&exe), Some(hub));
    }

    #[test]
    fn code_home_beside_exe_prefers_the_beside_exe_candidate() {
        // Both layouts present: the flat one wins, matching the documented order.
        let td = TempDir::new().unwrap();
        let contents = td.path().join("Contents");
        let beside = plant_hub_py(&contents.join("MacOS"), "hub");
        plant_hub_py(&contents, "Resources/hub");
        let exe = contents.join("MacOS").join("Skill Tree");

        assert_eq!(code_home_beside_exe(&exe), Some(beside));
    }

    #[test]
    fn code_home_beside_exe_is_none_without_hub_py() {
        // The directories exist but carry no hub.py: must NOT be claimed as a
        // code home, so resolve_code_home_path() still returns its explicit Err
        // instead of handing back a bogus path.
        let td = TempDir::new().unwrap();
        let install = td.path().join("Skill Tree");
        std::fs::create_dir_all(install.join("hub")).unwrap();
        std::fs::create_dir_all(td.path().join("Resources").join("hub")).unwrap();
        let exe = install.join("Skill Tree.exe");

        assert_eq!(code_home_beside_exe(&exe), None);
    }

    #[test]
    fn code_home_beside_exe_tolerates_a_parentless_path() {
        // A bare relative exe name has no parent — must be None, never a panic.
        assert_eq!(code_home_beside_exe(Path::new("skill-tree")), None);
    }

    #[test]
    fn hex_encode_matches_known_vector() {
        assert_eq!(hex_encode(&[0x00, 0x0f, 0xff]), "000fff");
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
