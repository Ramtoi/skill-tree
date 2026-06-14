//! Permissions command bridge.
//!
//! Every command marshals one `hub.py permissions <verb>` subprocess
//! invocation, parses the JSON response, and returns it typed. The only
//! Rust-side composition is `permissions_disable` with target
//! `DisableTarget::AllProjects`, which loops one `--project <n>` call per
//! registered project and concatenates the returned `entries` arrays. All
//! business logic stays in Python.
//!
//! See `docs/permissions.md` ("UI-facing JSON verbs") for the engine contract.

use super::hub::resolved_python;
use super::{code_home, data_home, hub_py};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase", tag = "kind")]
pub enum Scope {
    Global,
    Project { name: String },
}

impl Scope {
    fn flags(&self) -> Vec<String> {
        match self {
            Scope::Global => vec!["--global".into()],
            Scope::Project { name } => vec!["--project".into(), name.clone()],
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum DisableTarget {
    /// `--global` (from Global view) or `--project <n>` (from a project tab).
    JustScope { scope: Scope },
    /// Loops `--project <n>` per registered project, composed Rust-side.
    AllProjects,
    /// Single engine invocation: `--all`.
    Everything,
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

fn run_hub_with_stdin(args: &[&str], stdin_data: &str) -> Result<std::process::Output, String> {
    let python = resolved_python().ok_or_else(|| {
        "Python not found. Install Python 3 and ensure it is in PATH.".to_string()
    })?;
    let code = code_home()?;
    let data = data_home()?;
    let hub = hub_py()?;
    let mut child = Command::new(python)
        .arg(&hub)
        .args(args)
        .current_dir(&code)
        .env("SKILL_HUB_HOME", data.as_os_str())
        .env("SKILL_HUB_CODE", code.as_os_str())
        .env_remove("SKILL_HUB_DIR")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn hub.py: {e}"))?;
    if let Some(mut sin) = child.stdin.take() {
        sin.write_all(stdin_data.as_bytes())
            .map_err(|e| format!("Failed to pipe stdin to hub.py: {e}"))?;
    }
    child
        .wait_with_output()
        .map_err(|e| format!("Failed to read hub.py output: {e}"))
}

fn ok_stdout(output: std::process::Output) -> Result<String, String> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
        .trim()
        .to_string())
    }
}

fn parse_json(body: &str) -> Result<Value, String> {
    serde_json::from_str(body)
        .map_err(|e| format!("Cannot parse hub.py JSON output: {e}\nRaw: {body}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedded risks schema (build-emitted by build.rs from risks.emit_schema_json)
// ─────────────────────────────────────────────────────────────────────────────

const EMBEDDED_RISKS: &str = include_str!(concat!(env!("OUT_DIR"), "/risks.generated.json"));

#[tauri::command]
pub fn permissions_risks_schema() -> Result<Value, String> {
    serde_json::from_str(EMBEDDED_RISKS)
        .map_err(|e| format!("Cannot parse embedded risks schema: {e}"))
}

#[derive(Debug, Serialize)]
pub struct RecentImport {
    pub harness_id: String,
    pub timestamp: String,
    pub backup_path: String,
    pub source_file: String,
}

/// List the most recent backup file per harness for a given scope. Used by
/// the project Permissions tab's "Imported N rules from <file>" banner.
/// Walks `~/.skill-hub/_hub-backups/permissions/<harness>/<scope>/` and
/// returns the lexicographically-greatest filename (timestamps sort
/// chronologically). No engine roundtrip — pure filesystem read.
#[tauri::command]
pub fn permissions_recent_imports(scope: Scope) -> Result<Vec<RecentImport>, String> {
    let data = data_home()?;
    let backups_root = data.join("_hub-backups").join("permissions");
    if !backups_root.is_dir() {
        return Ok(Vec::new());
    }
    let scope_dir_name = match &scope {
        Scope::Global => "global".to_string(),
        Scope::Project { name } => format!("project-{name}"),
    };

    let mut out: Vec<RecentImport> = Vec::new();
    let read_harness_dir = std::fs::read_dir(&backups_root)
        .map_err(|e| format!("Cannot read {}: {e}", backups_root.display()))?;
    for entry in read_harness_dir.flatten() {
        let harness_path = entry.path();
        if !harness_path.is_dir() {
            continue;
        }
        let harness_id = entry.file_name().to_string_lossy().into_owned();
        let scope_dir = harness_path.join(&scope_dir_name);
        if !scope_dir.is_dir() {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&scope_dir) else {
            continue;
        };
        let mut files: Vec<std::path::PathBuf> = rd
            .flatten()
            .filter(|e| e.path().is_file())
            .map(|e| e.path())
            .collect();
        if files.is_empty() {
            continue;
        }
        files.sort();
        let latest = files.last().unwrap().clone();
        let timestamp = latest
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        // Best-effort source file inference — backups carry the original
        // filename in their suffix-stripped name. Adapters write
        // `.claude/settings.json` etc.; the actual source path is harness-
        // specific. We surface the backup path verbatim and let the UI
        // present it.
        out.push(RecentImport {
            harness_id,
            timestamp,
            backup_path: latest.to_string_lossy().into_owned(),
            source_file: String::new(),
        });
    }
    Ok(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// show / set / validate / capabilities / doctor / adopt / disable
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn permissions_show(scope: Scope) -> Result<Value, String> {
    let mut args: Vec<String> = vec!["permissions".into(), "show".into()];
    args.extend(scope.flags());
    args.push("--json".into());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let body = ok_stdout(run_hub(&arg_refs)?)?;
    parse_json(&body)
}

#[tauri::command]
pub fn permissions_set(scope: Scope, payload: Value) -> Result<Value, String> {
    let mut args: Vec<String> = vec!["permissions".into(), "set".into()];
    args.extend(scope.flags());
    args.push("--stdin-json".into());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let serialized = serde_json::to_string(&payload)
        .map_err(|e| format!("Cannot serialize payload: {e}"))?;
    let body = ok_stdout(run_hub_with_stdin(&arg_refs, &serialized)?)?;
    parse_json(&body)
}

#[tauri::command]
pub fn permissions_validate(kind: String, pattern: String) -> Result<Value, String> {
    let args = [
        "permissions",
        "validate",
        "--kind",
        &kind,
        "--pattern",
        &pattern,
        "--json",
    ];
    let body = ok_stdout(run_hub(&args)?)?;
    parse_json(&body)
}

#[tauri::command]
pub fn permissions_capabilities() -> Result<Value, String> {
    let body = ok_stdout(run_hub(&["permissions", "capabilities", "--json"])?)?;
    parse_json(&body)
}

/// De-duplicate global-sourced rules out of project native files (D2).
/// Dry-run by default; pass `apply = true` to commit. Returns the structured
/// plan `{apply, entries:[{scope_label, harness_id, target_file, removed[],
/// kept[], ambiguous[], backup_path, applied}]}` for the preview table.
#[tauri::command]
pub fn permissions_migrate_scope(apply: bool) -> Result<Value, String> {
    let mut args: Vec<&str> = vec!["permissions", "migrate-scope", "--json"];
    if apply {
        args.push("--apply");
    }
    let body = ok_stdout(run_hub(&args)?)?;
    parse_json(&body)
}

#[tauri::command]
pub fn permissions_doctor(scope: Option<Scope>) -> Result<Value, String> {
    // v1 doctor returns the full report; scope is reserved for forward-compat.
    let _ = scope;
    let body = ok_stdout(run_hub(&["permissions", "doctor", "--json"])?)?;
    parse_json(&body)
}

#[tauri::command]
pub fn permissions_adopt(
    scope: Scope,
    action: String,
    harness: Option<String>,
) -> Result<Value, String> {
    let mut args: Vec<String> = vec!["permissions".into(), "adopt".into()];
    args.extend(scope.flags());
    args.push("--action".into());
    args.push(action);
    if let Some(h) = harness {
        args.push("--harness".into());
        args.push(h);
    }
    args.push("--json".into());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let body = ok_stdout(run_hub(&arg_refs)?)?;
    parse_json(&body)
}

/// Discover + reconcile pre-existing native rules across harnesses for a scope.
/// Returns `{merged, conflicts, un_importable}` for the import/merge dialog.
#[tauri::command]
pub fn permissions_import_candidates(
    scope: Scope,
    harness: Option<String>,
) -> Result<Value, String> {
    let mut args: Vec<String> = vec!["permissions".into(), "import".into()];
    args.extend(scope.flags());
    if let Some(h) = harness {
        args.push("--harness".into());
        args.push(h);
    }
    args.push("--json".into());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let body = ok_stdout(run_hub(&arg_refs)?)?;
    parse_json(&body)
}

/// Apply per-rule import/keep/drop decisions (MOVE semantics). `decisions` is a
/// JSON array of `{pattern, action, kind?, harnesses?}`.
#[tauri::command]
pub fn permissions_import_apply(scope: Scope, decisions: Value) -> Result<Value, String> {
    let mut args: Vec<String> = vec!["permissions".into(), "import".into()];
    args.extend(scope.flags());
    args.push("--apply".into());
    args.push("--decisions-stdin".into());
    args.push("--json".into());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let payload = serde_json::json!({ "decisions": decisions });
    let serialized = serde_json::to_string(&payload)
        .map_err(|e| format!("Cannot serialize decisions: {e}"))?;
    let body = ok_stdout(run_hub_with_stdin(&arg_refs, &serialized)?)?;
    parse_json(&body)
}

/// Unified reconcile (D3): subsumes adopt+import. Discovery (no `decisions`)
/// returns `{merged, conflicts, un_importable}`; apply (with `decisions`) runs
/// the transactional + auto-syncing path and returns
/// `{imported, dropped, kept, conflicts_resolved, synced_files}`.
#[tauri::command]
pub fn permissions_reconcile_candidates(
    scope: Scope,
    harness: Option<String>,
) -> Result<Value, String> {
    let mut args: Vec<String> = vec!["permissions".into(), "reconcile".into()];
    args.extend(scope.flags());
    if let Some(h) = harness {
        args.push("--harness".into());
        args.push(h);
    }
    args.push("--json".into());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let body = ok_stdout(run_hub(&arg_refs)?)?;
    parse_json(&body)
}

#[tauri::command]
pub fn permissions_reconcile_apply(scope: Scope, decisions: Value) -> Result<Value, String> {
    let mut args: Vec<String> = vec!["permissions".into(), "reconcile".into()];
    args.extend(scope.flags());
    args.push("--apply".into());
    args.push("--decisions-stdin".into());
    args.push("--json".into());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let payload = serde_json::json!({ "decisions": decisions });
    let serialized = serde_json::to_string(&payload)
        .map_err(|e| format!("Cannot serialize decisions: {e}"))?;
    let body = ok_stdout(run_hub_with_stdin(&arg_refs, &serialized)?)?;
    parse_json(&body)
}

#[tauri::command]
pub fn permissions_disable(
    target: DisableTarget,
    mode: String,
    apply: bool,
) -> Result<Value, String> {
    if mode != "restore" && mode != "detach" {
        return Err(format!("invalid mode: {mode}"));
    }

    let invoke = |scope_flags: &[String]| -> Result<Value, String> {
        let mut args: Vec<String> = vec!["permissions".into(), "disable".into()];
        args.extend(scope_flags.iter().cloned());
        args.push("--mode".into());
        args.push(mode.clone());
        if apply {
            args.push("--apply".into());
        }
        args.push("--json".into());
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let body = ok_stdout(run_hub(&arg_refs)?)?;
        parse_json(&body)
    };

    let result = match target {
        DisableTarget::JustScope { scope } => invoke(&scope.flags())?,
        DisableTarget::Everything => invoke(&["--all".into()])?,
        DisableTarget::AllProjects => {
            // Read registry.yaml directly to learn the project list, then loop one
            // `--project <n>` invocation each and concatenate the returned entries.
            let data = data_home()?;
            let registry_path = data.join("registry.yaml");
            let registry_yaml = std::fs::read_to_string(&registry_path)
                .map_err(|e| format!("Cannot read {}: {e}", registry_path.display()))?;
            let registry: Value = serde_yaml::from_str(&registry_yaml)
                .map_err(|e| format!("Cannot parse registry.yaml: {e}"))?;

            let projects = registry
                .get("projects")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();

            let mut all_entries: Vec<Value> = Vec::new();
            for name in projects.keys() {
                let scope = Scope::Project { name: name.clone() };
                let body = invoke(&scope.flags())?;
                if let Some(entries) = body.get("entries").and_then(Value::as_array) {
                    all_entries.extend(entries.clone());
                }
            }
            json!({
                "mode": mode,
                "apply": apply,
                "entries": all_entries,
            })
        }
    };

    // Identify every scope touched so the frontend can invalidate each one
    // (a cross-scope `--all` / AllProjects disable touches many queries).
    Ok(attach_scopes_touched(result))
}

/// Add a `scopes_touched` array of `{kind[, name]}` derived from the result's
/// `entries`, so the frontend knows which `permissions(scope)` queries to
/// invalidate after a (possibly cross-scope) disable.
fn attach_scopes_touched(mut result: Value) -> Value {
    let mut seen: Vec<Value> = Vec::new();
    if let Some(entries) = result.get("entries").and_then(Value::as_array) {
        for e in entries {
            let kind = e.get("scope_kind").and_then(Value::as_str).unwrap_or("");
            let label = e.get("scope_label").and_then(Value::as_str).unwrap_or("");
            let scope = if kind == "global" {
                json!({ "kind": "global" })
            } else {
                json!({ "kind": "project", "name": label })
            };
            if !seen.contains(&scope) {
                seen.push(scope);
            }
        }
    }
    if let Some(obj) = result.as_object_mut() {
        obj.insert("scopes_touched".into(), Value::Array(seen));
    }
    result
}

// ─────────────────────────────────────────────────────────────────────────────
// Smoke tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_flags_serialise_correctly() {
        assert_eq!(Scope::Global.flags(), vec!["--global".to_string()]);
        assert_eq!(
            Scope::Project { name: "alpha".into() }.flags(),
            vec!["--project".to_string(), "alpha".to_string()]
        );
    }

    #[test]
    fn parse_json_round_trips_a_stub_response() {
        let stub = r#"{"changed": false, "normalized": {"allow": []}}"#;
        let v = parse_json(stub).expect("parse stub");
        assert_eq!(v["changed"], serde_json::Value::Bool(false));
    }

    #[test]
    fn parse_json_rejects_invalid() {
        assert!(parse_json("not json").is_err());
    }

    #[test]
    fn disable_target_round_trips_through_serde() {
        let everything = DisableTarget::Everything;
        let s = serde_json::to_string(&everything).unwrap();
        let back: DisableTarget = serde_json::from_str(&s).unwrap();
        assert!(matches!(back, DisableTarget::Everything));

        let scope = DisableTarget::JustScope {
            scope: Scope::Global,
        };
        let s = serde_json::to_string(&scope).unwrap();
        let back: DisableTarget = serde_json::from_str(&s).unwrap();
        assert!(matches!(back, DisableTarget::JustScope { .. }));
    }
}
