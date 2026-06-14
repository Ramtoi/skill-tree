//! Harness registry — Rust mirror of the Python `harnesses.py` module.
//!
//! The registry itself is generated at build time by `build.rs` invoking
//! `python3 hub.py harnesses emit-schema`. We embed the JSON via
//! `include_str!` so the Rust side never goes stale with the Python source.
//!
//! We only re-implement the trivial dotdir+marker detection here (two stat
//! calls per harness). Resolution semantics, schema migration, sync logic,
//! and MCP dispatch all live in Python — this module exists so the UI can
//! list installed harnesses without shelling out for each rescan.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use std::process::Command;

use super::hub::resolved_python;
use super::{code_home, data_home, expand_tilde, hub_py};

#[derive(Debug, Clone, Deserialize)]
pub struct DetectMeta {
    pub dir: Option<String>,
    pub marker: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HarnessMeta {
    pub id: String,
    pub label: String,
    pub project_skills_dir: String,
    pub global_skills_dir: String,
    pub mcp_adapter_key: Option<String>,
    pub detect: DetectMeta,
    #[serde(default)]
    pub legacy_global_skills_dirs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessStatus {
    pub id: String,
    pub label: String,
    pub installed: bool,
    pub on_globally: bool,
    pub used_by_projects: Vec<String>,
    /// Resolved binary path (best-effort PATH lookup), or the config dir when
    /// the binary cannot be located. `None` when neither is known.
    pub path: Option<String>,
    /// Version string parsed from `<bin> --version` (best-effort), or `None`.
    pub version: Option<String>,
}

/// Likely executable name(s) for a harness id, used for a `which`-style PATH
/// lookup. The harness schema does not carry a binary name, so this is a small
/// curated map; unknown ids fall back to the id itself.
fn binary_names(id: &str) -> Vec<&'static str> {
    match id {
        "claude-code" => vec!["claude"],
        "codex" => vec!["codex"],
        "pi" => vec!["pi"],
        "opencode" => vec!["opencode"],
        "copilot" => vec!["copilot", "gh"],
        _ => Vec::new(),
    }
}

/// Search `$PATH` for the first matching executable. Pure filesystem checks —
/// never spawns a process.
fn which(names: &[&str]) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for name in names {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Best-effort `<bin> --version`. Returns the first non-empty trimmed line.
/// Conventionally instant; failures collapse to `None`.
fn probe_version(bin: &Path) -> Option<String> {
    let out = Command::new(bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| !l.trim().is_empty())?.trim();
    // Strip a leading program name if present, keep a compact version token.
    let token = line
        .split_whitespace()
        .find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .unwrap_or(line);
    Some(token.trim_start_matches('v').to_string())
}

/// Resolve `(path, version)` display metadata for an installed harness.
fn resolve_meta(meta: &HarnessMeta) -> (Option<String>, Option<String>) {
    if let Some(bin) = which(&binary_names(&meta.id)) {
        let version = probe_version(&bin);
        (Some(bin.to_string_lossy().into_owned()), version)
    } else {
        // No binary on PATH — surface the detection dir so the card still has a
        // concrete pointer for the user.
        let dir = meta.detect.dir.clone();
        (dir, None)
    }
}

type ResolvedMeta = (Option<String>, Option<String>);

static META_CACHE: OnceLock<Mutex<HashMap<String, ResolvedMeta>>> = OnceLock::new();

/// `resolve_meta` for a batch of harnesses, probed in parallel and cached for
/// the app's lifetime. `<bin> --version` spawns whole CLI startups (the
/// Node-based harnesses take 0.5–1s each), so serial re-probing on every
/// `harness_list` call is what made the first project screen hang.
fn resolved_metas(metas: &[&'static HarnessMeta]) -> HashMap<String, ResolvedMeta> {
    let cache = META_CACHE.get_or_init(Default::default);
    let mut out: HashMap<String, ResolvedMeta> = HashMap::new();
    let mut missing: Vec<&'static HarnessMeta> = Vec::new();
    {
        let cached = cache.lock().unwrap();
        for meta in metas {
            match cached.get(&meta.id) {
                Some(v) => {
                    out.insert(meta.id.clone(), v.clone());
                }
                None => missing.push(meta),
            }
        }
    }
    if !missing.is_empty() {
        let handles: Vec<_> = missing
            .into_iter()
            .map(|meta| std::thread::spawn(move || (meta.id.clone(), resolve_meta(meta))))
            .collect();
        let mut cached = cache.lock().unwrap();
        for handle in handles {
            if let Ok((id, resolved)) = handle.join() {
                cached.insert(id.clone(), resolved.clone());
                out.insert(id, resolved);
            }
        }
    }
    out
}

const EMBEDDED_SCHEMA: &str = include_str!(concat!(env!("OUT_DIR"), "/harnesses.generated.json"));

static REGISTRY: OnceLock<Vec<HarnessMeta>> = OnceLock::new();

pub fn registry() -> &'static [HarnessMeta] {
    REGISTRY
        .get_or_init(|| {
            serde_json::from_str::<Vec<HarnessMeta>>(EMBEDDED_SCHEMA).unwrap_or_else(|e| {
                eprintln!(
                    "warning: failed to parse embedded harness schema ({e}); falling back to empty list"
                );
                Vec::new()
            })
        })
        .as_slice()
}

/// Detect installed harnesses by running each entry's dotdir+marker check.
/// Mirrors `DotDirWithMarker.__call__` in Python.
pub fn detected_installed() -> Vec<String> {
    registry()
        .iter()
        .filter(|h| {
            let Some(dir) = h.detect.dir.as_ref() else {
                return false;
            };
            let Some(marker) = h.detect.marker.as_ref() else {
                return false;
            };
            let base = expand_tilde(dir);
            let marker_path = base.join(marker);
            base.is_dir() && PathBuf::from(&marker_path).exists()
        })
        .map(|h| h.id.clone())
        .collect()
}

/// Tauri command: list harnesses with installed/on-globally/used-by-projects flags.
/// Async + spawn_blocking so the version probes never run on the main thread
/// (a sync command would freeze the UI while CLIs start up).
#[tauri::command]
pub async fn harness_list() -> Result<Vec<HarnessStatus>, String> {
    tauri::async_runtime::spawn_blocking(harness_list_impl)
        .await
        .map_err(|e| format!("harness_list task failed: {e}"))?
}

fn harness_list_impl() -> Result<Vec<HarnessStatus>, String> {
    let installed: std::collections::HashSet<String> =
        detected_installed().into_iter().collect();

    // Read registry to enrich with on_globally + used_by_projects
    let mut on_globally: std::collections::HashSet<String> = Default::default();
    let mut used_by_projects: std::collections::HashMap<String, Vec<String>> =
        Default::default();
    if let Ok(home) = data_home() {
        let reg_path = home.join("registry.yaml");
        if let Ok(content) = std::fs::read_to_string(&reg_path) {
            if let Ok(yaml) = serde_yaml::from_str::<Value>(&content) {
                if let Some(arr) = yaml.get("harnesses_global").and_then(|v| v.as_array()) {
                    for v in arr {
                        if let Some(s) = v.as_str() {
                            on_globally.insert(s.to_string());
                        }
                    }
                }
                if let Some(projects) = yaml.get("projects").and_then(|v| v.as_object()) {
                    for (proj_name, proj_cfg) in projects {
                        let Some(arr) = proj_cfg
                            .get("harnesses")
                            .and_then(|v| v.as_array())
                        else {
                            continue;
                        };
                        for v in arr {
                            if let Some(s) = v.as_str() {
                                used_by_projects
                                    .entry(s.to_string())
                                    .or_default()
                                    .push(proj_name.clone());
                            }
                        }
                    }
                }
            }
        }
    }

    // Only resolve path/version for installed harnesses — probing a binary
    // that isn't there is wasted work.
    let installed_metas: Vec<&'static HarnessMeta> = registry()
        .iter()
        .filter(|h| installed.contains(&h.id))
        .collect();
    let metas = resolved_metas(&installed_metas);

    Ok(registry()
        .iter()
        .map(|h| {
            let is_installed = installed.contains(&h.id);
            let (path, version) = metas.get(&h.id).cloned().unwrap_or((None, None));
            HarnessStatus {
                id: h.id.clone(),
                label: h.label.clone(),
                installed: is_installed,
                on_globally: on_globally.contains(&h.id),
                used_by_projects: used_by_projects
                    .get(&h.id)
                    .cloned()
                    .unwrap_or_default(),
                path,
                version,
            }
        })
        .collect())
}

fn run_hub(args: &[&str]) -> Result<std::process::Output, String> {
    let python = resolved_python().ok_or_else(|| {
        "Python not found. Install Python 3 and ensure it is in PATH.".to_string()
    })?;
    let code = code_home()?;
    let data = data_home()?;
    let hub = hub_py()?;
    Command::new(python)
        .arg(&hub)
        .args(args)
        .current_dir(&code)
        .env("SKILL_HUB_HOME", data.as_os_str())
        .env("SKILL_HUB_CODE", code.as_os_str())
        .env_remove("SKILL_HUB_DIR")
        .output()
        .map_err(|e| format!("Failed to run hub.py: {e}"))
}

#[tauri::command]
pub fn harness_set_global(id: String, enabled: bool) -> Result<(), String> {
    let action = if enabled { "enable" } else { "disable" };
    let out = run_hub(&["harness", action, &id])?;
    if !out.status.success() {
        return Err(format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn project_set_harnesses(project: String, harnesses: Vec<String>) -> Result<(), String> {
    // Read current list, compute add/remove, then mutate via CLI for lock safety.
    let current: Vec<String> = match data_home() {
        Ok(home) => {
            let content =
                std::fs::read_to_string(home.join("registry.yaml")).unwrap_or_default();
            serde_yaml::from_str::<Value>(&content)
                .ok()
                .and_then(|v| {
                    v.get("projects")
                        .and_then(|p| p.get(&project))
                        .and_then(|c| c.get("harnesses"))
                        .and_then(|h| h.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(String::from))
                                .collect()
                        })
                })
                .unwrap_or_default()
        }
        Err(_) => Vec::new(),
    };
    let target: std::collections::HashSet<String> = harnesses.iter().cloned().collect();
    let current_set: std::collections::HashSet<String> = current.iter().cloned().collect();

    let to_add: Vec<&str> = target
        .difference(&current_set)
        .map(String::as_str)
        .collect();
    let to_remove: Vec<&str> = current_set
        .difference(&target)
        .map(String::as_str)
        .collect();

    if !to_add.is_empty() {
        let joined = to_add.join(",");
        let out = run_hub(&[
            "project",
            "harnesses",
            &project,
            "--add",
            &joined,
        ])?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
    }
    if !to_remove.is_empty() {
        let joined = to_remove.join(",");
        let out = run_hub(&[
            "project",
            "harnesses",
            &project,
            "--remove",
            &joined,
        ])?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_schema_parses_to_vec() {
        let parsed: Vec<HarnessMeta> = serde_json::from_str(EMBEDDED_SCHEMA)
            .expect("embedded harness schema is valid JSON");
        // Either empty (build-time python3 unavailable) or contains known ids
        if !parsed.is_empty() {
            let ids: std::collections::HashSet<_> =
                parsed.iter().map(|h| h.id.as_str()).collect();
            assert!(
                ids.contains("claude-code")
                    && ids.contains("codex")
                    && ids.contains("pi"),
                "expected v1 registry to include claude-code, codex, pi (got {ids:?})"
            );
        }
    }

    fn leak_meta(id: &str, detect_dir: &str) -> &'static HarnessMeta {
        Box::leak(Box::new(
            serde_json::from_value(serde_json::json!({
                "id": id,
                "label": id,
                "project_skills_dir": ".agents/skills",
                "global_skills_dir": "~/.agents/skills",
                "detect": { "dir": detect_dir, "marker": "marker" },
            }))
            .expect("test HarnessMeta deserializes"),
        ))
    }

    #[test]
    fn resolved_metas_returns_cached_entry_without_reprobing() {
        // Unique id so parallel tests sharing the global cache can't collide.
        let meta = leak_meta("test-cache-hit", "/nonexistent/detect-dir");
        META_CACHE
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(
                meta.id.clone(),
                (Some("/sentinel/bin".into()), Some("9.9.9".into())),
            );

        let out = resolved_metas(&[meta]);
        // A re-probe would find no binary and fall back to the detect dir —
        // getting the sentinel back proves the cache was consulted.
        assert_eq!(
            out.get("test-cache-hit"),
            Some(&(Some("/sentinel/bin".to_string()), Some("9.9.9".to_string())))
        );
    }

    #[test]
    fn resolved_metas_probes_miss_and_populates_cache() {
        // Unknown id → binary_names() is empty → which() finds nothing →
        // resolve_meta deterministically falls back to the detect dir, never
        // spawning a process.
        let meta = leak_meta("test-cache-miss", "/test/detect-dir");

        let out = resolved_metas(&[meta]);
        let expected = (Some("/test/detect-dir".to_string()), None);
        assert_eq!(out.get("test-cache-miss"), Some(&expected));

        let cached = META_CACHE
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .get("test-cache-miss")
            .cloned();
        assert_eq!(cached, Some(expected), "probe result must be cached");
    }

    #[test]
    fn harness_status_shape_is_stable() {
        // Just ensure the type compiles and serializes
        let s = HarnessStatus {
            id: "claude-code".into(),
            label: "Claude Code".into(),
            installed: true,
            on_globally: false,
            used_by_projects: vec!["alpha".into()],
            path: Some("/usr/local/bin/claude".into()),
            version: Some("1.4.2".into()),
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"id\":\"claude-code\""));
        assert!(json.contains("\"installed\":true"));
    }
}
