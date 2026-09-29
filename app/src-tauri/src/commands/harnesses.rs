//! Harness commands use the Python operation context for inventory and paths.
//! Rust retains the desktop opener and forwards registry mutations to the CLI.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::data_home;

/// Sub-agent capability for a harness, mirrored from `emit_schema()`'s
/// `"agents"` object (review M4). `#[serde(default)]` keeps older generated
/// JSON (which predates the field) parseable — an absent object becomes
/// `{supported: false, …}`. Re-serialized to the UI via `HarnessStatus`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentsCapability {
    #[serde(default)]
    pub supported: bool,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub agents_dir: Option<String>,
    #[serde(default)]
    pub project_agents_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarnessStatus {
    pub id: String,
    pub label: String,
    pub installed: bool,
    pub on_globally: bool,
    pub used_by_projects: Vec<String>,
    /// Executable from one unambiguous cached runtime identity, otherwise absent.
    pub path: Option<String>,
    /// Version from the same cached runtime identity, otherwise absent.
    pub version: Option<String>,
    /// Sub-agent capability surfaced to the UI (drives the Configure /
    /// Sub-Agents affordance gating in Wave 3).
    pub agents: AgentsCapability,
    /// Absolute (tilde-expanded) user-global instruction-doc path, or `None`
    /// when the harness declares none. Drives the "Instructions" affordance.
    pub global_doc: Option<String>,
    /// Whether that global-doc file currently exists on disk (so the card can
    /// render a subtle "missing" hint without an extra round-trip).
    pub global_doc_exists: bool,
    /// Absolute (tilde-expanded) config directory (`detect.dir` from the
    /// harness schema), or `None` when the schema declares none. Distinct
    /// from `path`, which prefers a resolved binary and only falls back to
    /// this same dir when no binary is on `PATH`. Drives the "Open in
    /// Finder" affordance, which must always target the config dir even
    /// when a binary WAS found.
    pub config_dir: Option<String>,
    /// Harness-relative project skill directory from the schema.
    pub project_skills_dir: String,
}

/// Read the Python operation snapshot. Only an explicit refresh may probe.
fn harness_list_with<F>(refresh: bool, run: F) -> Result<Vec<HarnessStatus>, String>
where
    F: FnOnce(&[&str]) -> Result<Vec<HarnessStatus>, String>,
{
    if refresh {
        run(&["harness", "list", "--probe", "--json"])
    } else {
        run(&["harness", "list", "--json"])
    }
}

#[tauri::command]
pub async fn harness_list(refresh: Option<bool>) -> Result<Vec<HarnessStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || harness_list_impl(refresh.unwrap_or(false)))
        .await
        .map_err(|e| format!("harness_list task failed: {e}"))?
}

fn harness_list_impl(refresh: bool) -> Result<Vec<HarnessStatus>, String> {
    harness_list_with(refresh, |args| super::hub_json(args, None))
}

fn config_dir_from_rows(harness_id: &str, rows: &[HarnessStatus]) -> Result<PathBuf, String> {
    let row = rows
        .iter()
        .find(|row| row.id == harness_id)
        .ok_or_else(|| format!("Unknown harness id: {harness_id}"))?;
    let path = row
        .config_dir
        .as_deref()
        .ok_or_else(|| format!("Harness {harness_id} has no config directory"))?;
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(format!(
            "Harness {harness_id} config directory is not absolute"
        ));
    }
    Ok(path)
}

fn resolve_harness_config_dir(harness_id: &str) -> Result<PathBuf, String> {
    config_dir_from_rows(harness_id, &harness_list_impl(false)?)
}

/// A harness can be listed before its config dir exists (installed later, or
/// never launched). Refuse to hand a non-directory to the OS opener, and name
/// the path so the toast says WHICH folder is missing.
fn require_existing_dir(dir: &Path) -> Result<(), String> {
    if dir.is_dir() {
        Ok(())
    } else {
        Err(format!("{} does not exist", dir.display()))
    }
}

/// Open a harness's config directory in the OS file manager (Finder on
/// macOS). Rust-side `open_path` is not gated by the webview capability
/// scope, so this stays a dedicated command rather than a frontend `opener`
/// call — the target is resolved server-side from the harness id only.
#[tauri::command]
pub async fn harness_open_dir(app: tauri::AppHandle, harness_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || harness_open_dir_impl(&app, &harness_id))
        .await
        .map_err(|e| format!("harness_open_dir task failed: {e}"))?
}

fn harness_open_dir_impl(app: &tauri::AppHandle, harness_id: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let dir = resolve_harness_config_dir(harness_id)?;
    require_existing_dir(&dir)?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| format!("Cannot open {}: {e}", harness_id))
}

fn run_hub(args: &[&str]) -> Result<std::process::Output, String> {
    super::hub_output(args)
}

#[tauri::command]
pub async fn harness_set_global(id: String, enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || harness_set_global_impl(id, enabled))
        .await
        .map_err(|e| format!("harness_set_global task failed: {e}"))?
}

fn harness_set_global_impl(id: String, enabled: bool) -> Result<(), String> {
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
pub async fn project_set_harnesses(project: String, harnesses: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || project_set_harnesses_impl(project, harnesses))
        .await
        .map_err(|e| format!("project_set_harnesses task failed: {e}"))?
}

fn project_set_harnesses_impl(project: String, harnesses: Vec<String>) -> Result<(), String> {
    // Read current list, compute add/remove, then mutate via CLI for lock safety.
    let current: Vec<String> = match data_home() {
        Ok(home) => {
            let content = std::fs::read_to_string(home.join("registry.yaml")).unwrap_or_default();
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
        let out = run_hub(&["project", "harnesses", &project, "--add", &joined])?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
    }
    if !to_remove.is_empty() {
        let joined = to_remove.join(",");
        let out = run_hub(&["project", "harnesses", &project, "--remove", &joined])?;
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
    fn default_inventory_read_never_requests_a_probe() {
        harness_list_with(false, |args| {
            assert_eq!(args, &["harness", "list", "--json"]);
            Ok(Vec::new())
        })
        .unwrap();
        harness_list_with(true, |args| {
            assert_eq!(args, &["harness", "list", "--probe", "--json"]);
            Ok(Vec::new())
        })
        .unwrap();
    }

    #[test]
    fn projection_errors_are_not_replaced_with_guessed_inventory() {
        assert_eq!(
            harness_list_with(false, |_| Err("unavailable".into())).unwrap_err(),
            "unavailable"
        );
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
            agents: AgentsCapability {
                supported: true,
                format: Some("md".into()),
                agents_dir: Some("~/.claude/agents".into()),
                project_agents_dir: Some(".claude/agents".into()),
            },
            global_doc: Some("/home/test/.claude/CLAUDE.md".into()),
            global_doc_exists: true,
            config_dir: Some("/home/test/.claude".into()),
            project_skills_dir: ".claude/skills".into(),
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"id\":\"claude-code\""));
        assert!(json.contains("\"installed\":true"));
        assert!(json.contains("\"agents\":{"));
        assert!(json.contains("\"supported\":true"));
        assert!(json.contains("\"config_dir\":\"/home/test/.claude\""));
    }

    #[test]
    fn config_directory_requires_a_matching_absolute_projection() {
        let mut row: HarnessStatus = serde_json::from_value(serde_json::json!({
            "id": "claude-code", "label": "Claude Code", "installed": false,
            "on_globally": false, "used_by_projects": [], "path": null,
            "version": null, "agents": {}, "global_doc": null,
            "global_doc_exists": false, "config_dir": null,
            "project_skills_dir": ".claude/skills"
        }))
        .unwrap();
        assert!(config_dir_from_rows("claude-code", &[row.clone()])
            .unwrap_err()
            .contains("no config directory"));
        row.config_dir = Some("relative".into());
        assert!(config_dir_from_rows("claude-code", &[row.clone()]).is_err());
        let tmp = tempfile::tempdir().unwrap();
        row.config_dir = Some(tmp.path().to_string_lossy().into_owned());
        assert_eq!(
            config_dir_from_rows("claude-code", &[row.clone()]).unwrap(),
            tmp.path()
        );
        for hostile in [
            "/Users/dev/.ssh",
            "../../../etc",
            "~/.claude",
            "claude-code/../../etc",
            "",
        ] {
            assert!(config_dir_from_rows(hostile, &[row.clone()])
                .unwrap_err()
                .contains("Unknown harness id"));
        }
    }

    #[test]
    fn require_existing_dir_names_the_missing_path() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("not-created-yet");
        let err = require_existing_dir(&missing).unwrap_err();
        assert!(
            err.contains(&missing.display().to_string()),
            "the error must name the path so the toast is actionable, got: {err}"
        );
        assert!(err.contains("does not exist"), "got: {err}");

        // An existing dir passes; a FILE at that path does not (the opener
        // must never be handed a regular file).
        require_existing_dir(tmp.path()).expect("an existing dir is fine");
        let file = tmp.path().join("a-file");
        std::fs::write(&file, b"x").unwrap();
        assert!(require_existing_dir(&file).is_err(), "a file is not a dir");
    }

    #[cfg(unix)]
    #[test]
    fn a_non_utf8_config_dir_does_not_panic() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        // `harness_open_dir_impl` hands the path to the opener through
        // `to_string_lossy()`; the same conversion on invalid UTF-8 must
        // replace bytes rather than panic.
        let raw = PathBuf::from(OsStr::from_bytes(b"/tmp/\xff\xfeharness"));
        let shown = raw.to_string_lossy().into_owned();
        assert!(shown.starts_with("/tmp/"), "got {shown}");
        assert!(require_existing_dir(&raw).is_err());
    }
}
