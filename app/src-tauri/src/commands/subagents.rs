//! Claude Code sub-agents — thin marshalling layer over the `hub subagent`
//! CLI. All business logic (parse / validate / serialize / disable) lives in
//! `subagents.py`; this module only shells out and deserializes the JSON
//! contract defined in `design.md` (D2). No file IO, no validation here.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

use super::hub::resolved_python;
use super::{code_home, data_home, hub_py};

// ─────────────────────────────────────────────────────────────────────────────
// JSON contract structs (mirror subagents.py / design.md D2)
// ─────────────────────────────────────────────────────────────────────────────

/// One real (file-based) sub-agent in a `list` result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentListItem {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub relpath: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub tools_mode: String,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub disallowed_tools: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub valid: bool,
    /// `[{field, level, message, value}]` — not introspected in Rust.
    #[serde(default)]
    pub warnings: Vec<Value>,
    // ── Codex-only fields (absent on the claude-code contract) ──────────────
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nickname_candidates: Option<Vec<String>>,
}

/// One built-in agent (read-only strip; disable-only).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentBuiltin {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentListResult {
    /// Harness this result belongs to (`claude-code` | `codex`). Additive to
    /// the shipped contract; defaults preserve older payloads.
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub agents_dir: String,
    #[serde(default)]
    pub settings_path: String,
    #[serde(default)]
    pub agents: Vec<SubagentListItem>,
    #[serde(default)]
    pub builtins: Vec<SubagentBuiltin>,
}

/// The "safe" (guided-form) fields of an agent — the contract subset.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SubagentSafe {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub tools_mode: String,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub disallowed_tools: Vec<String>,
    #[serde(default)]
    pub allow_skill_discovery: bool,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub color: String,
    // ── Codex-only fields — present only when harness == codex, absent (and
    // therefore round-trip-clean) for claude-code. ─────────────────────────
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nickname_candidates: Option<Vec<String>>,
}

/// One `skills.config` entry the Codex serializer preserves verbatim but does
/// not treat as a hub-managed skill (foreign path or `enabled = false`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignSkillEntry {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentValidation {
    #[serde(default)]
    pub valid: bool,
    /// `[{field, level, message, value}]` — not introspected in Rust.
    #[serde(default)]
    pub warnings: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentShow {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub exists: bool,
    #[serde(default)]
    pub safe: SubagentSafe,
    #[serde(default)]
    pub advanced_yaml: String,
    /// `"yaml"` (claude) | `"toml"` (codex). Additive; defaults to empty on
    /// older payloads that predate the multi-harness contract.
    #[serde(default)]
    pub advanced_format: String,
    #[serde(default)]
    pub body: String,
    /// Codex `skills.config` entries preserved read-only (foreign path or
    /// `enabled = false`). Always `[]` for claude-code.
    #[serde(default)]
    pub foreign_skill_entries: Vec<ForeignSkillEntry>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub validation: Option<SubagentValidation>,
}

/// Payload sent to `hub subagent save --json` on STDIN.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentSavePayload {
    /// Target harness (`claude-code` | `codex`). Rides in the stdin JSON like
    /// `scope`; the Python side reads `payload["harness"]` (default
    /// `claude-code`). Skipped when absent so claude payloads stay byte-clean.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    pub scope: String,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub original_name: Option<String>,
    pub safe: SubagentSafe,
    #[serde(default)]
    pub advanced_yaml: String,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentSaveResult {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub warnings: Vec<Value>,
    #[serde(default)]
    pub renamed_from: Option<String>,
    /// True when a linked-twin save co-wrote the shared core into the twin file
    /// (D3). `twin_harness` names the co-written harness. Additive — defaults on
    /// the shipped/standalone shape.
    #[serde(default)]
    pub cowrote_twin: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub twin_harness: Option<String>,
    /// Present only on `{ok:false}` — `[{field, level, message, value}]`.
    #[serde(default)]
    pub errors: Vec<Value>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Subprocess helpers (copied from harnesses.rs run_hub pattern)
// ─────────────────────────────────────────────────────────────────────────────

/// Build a `python3 hub.py …` Command with the resolved python/code/data home
/// env, matching the canonical `run_hub` pattern.
fn hub_command(args: &[&str]) -> Result<Command, String> {
    let python = resolved_python().ok_or_else(|| {
        "Python not found. Install Python 3 and ensure it is in PATH.".to_string()
    })?;
    let code = code_home()?;
    let data = data_home()?;
    let hub = hub_py()?;
    let mut cmd = Command::new(python);
    cmd.arg(&hub)
        .args(args)
        .current_dir(&code)
        .env("SKILL_HUB_HOME", data.as_os_str())
        .env("SKILL_HUB_CODE", code.as_os_str())
        .env_remove("SKILL_HUB_DIR");
    Ok(cmd)
}

/// Run `hub.py` with the given args, no stdin payload.
fn run_hub(args: &[&str]) -> Result<std::process::Output, String> {
    hub_command(args)?
        .output()
        .map_err(|e| format!("Failed to run hub.py: {e}"))
}

/// Run `hub.py` piping `payload` to the child's STDIN (for `save`).
pub(crate) fn run_hub_stdin(args: &[&str], payload: &str) -> Result<std::process::Output, String> {
    let mut child = hub_command(args)?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn hub.py: {e}"))?;
    {
        let stdin = match child.stdin.as_mut() {
            Some(s) => s,
            None => {
                // Reap the child before bailing so we don't leak a zombie.
                let _ = child.kill();
                let _ = child.wait();
                return Err("Failed to open hub.py stdin".to_string());
            }
        };
        if let Err(e) = stdin.write_all(payload.as_bytes()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Failed to write payload to hub.py stdin: {e}"));
        }
    }
    child
        .wait_with_output()
        .map_err(|e| format!("Failed to run hub.py: {e}"))
}

/// Combine stdout+stderr into an Err string when a process failed.
fn fail_message(out: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    format!("{stdout}{stderr}").trim().to_string()
}

/// Run + parse stdout JSON into a `Value`, tolerating a `{ok:false}` body on a
/// nonzero exit (structured rejections still deserialize). Only a genuinely
/// unparseable failure surfaces as a raw error string. Matches `subagent_delete`.
fn run_value_or_fail(args: &[&str]) -> Result<Value, String> {
    let out = run_hub(args)?;
    match serde_json::from_slice::<Value>(&out.stdout) {
        Ok(v) => Ok(v),
        Err(e) => {
            if out.status.success() {
                Err(format!(
                    "Failed to parse hub.py JSON output: {e}\n{}",
                    String::from_utf8_lossy(&out.stdout)
                ))
            } else {
                Err(fail_message(&out))
            }
        }
    }
}

/// Run + require success + parse stdout JSON into `T`.
fn run_parse<T: serde::de::DeserializeOwned>(args: &[&str]) -> Result<T, String> {
    let out = run_hub(args)?;
    if !out.status.success() {
        return Err(fail_message(&out));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| {
        format!(
            "Failed to parse hub.py JSON output: {e}\n{}",
            String::from_utf8_lossy(&out.stdout)
        )
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// Normalize an optional harness id to the CLI default. `None` and empty/blank
/// strings both collapse to `claude-code`, matching the Python CLI's
/// `--harness` default and keeping pre-Wave-3 TS callers working.
fn resolve_harness(harness_id: Option<String>) -> String {
    match harness_id {
        Some(h) if !h.trim().is_empty() => h,
        _ => "claude-code".to_string(),
    }
}

#[tauri::command]
pub async fn subagent_list(
    scope: String,
    project: Option<String>,
    harness_id: Option<String>,
) -> Result<SubagentListResult, String> {
    tauri::async_runtime::spawn_blocking(move || subagent_list_impl(scope, project, harness_id))
        .await
        .map_err(|e| format!("subagent_list task failed: {e}"))?
}

fn subagent_list_impl(
    scope: String,
    project: Option<String>,
    harness_id: Option<String>,
) -> Result<SubagentListResult, String> {
    let harness = resolve_harness(harness_id);
    let mut args: Vec<&str> = vec![
        "subagent", "list", "--scope", &scope, "--harness", &harness, "--json",
    ];
    if let Some(p) = project.as_deref() {
        args.push("--project");
        args.push(p);
    }
    run_parse(&args)
}

#[tauri::command]
pub async fn subagent_show(
    scope: String,
    name: String,
    project: Option<String>,
    harness_id: Option<String>,
) -> Result<SubagentShow, String> {
    tauri::async_runtime::spawn_blocking(move || subagent_show_impl(scope, name, project, harness_id))
        .await
        .map_err(|e| format!("subagent_show task failed: {e}"))?
}

fn subagent_show_impl(
    scope: String,
    name: String,
    project: Option<String>,
    harness_id: Option<String>,
) -> Result<SubagentShow, String> {
    let harness = resolve_harness(harness_id);
    let mut args: Vec<&str> = vec![
        "subagent", "show", "--scope", &scope, "--harness", &harness, "--name", &name, "--json",
    ];
    if let Some(p) = project.as_deref() {
        args.push("--project");
        args.push(p);
    }
    run_parse(&args)
}

#[tauri::command]
pub async fn subagent_save(payload: SubagentSavePayload) -> Result<SubagentSaveResult, String> {
    tauri::async_runtime::spawn_blocking(move || subagent_save_impl(payload))
        .await
        .map_err(|e| format!("subagent_save task failed: {e}"))?
}

fn subagent_save_impl(payload: SubagentSavePayload) -> Result<SubagentSaveResult, String> {
    let body = serde_json::to_string(&payload)
        .map_err(|e| format!("Failed to serialize save payload: {e}"))?;
    let out = run_hub_stdin(&["subagent", "save", "--json"], &body)?;
    // `save` exits non-zero on validation failure but still emits a structured
    // {ok:false, errors:[…]} body — parse stdout first so the UI can render the
    // errors; only fall back to a raw error string when there is no JSON.
    match serde_json::from_slice::<SubagentSaveResult>(&out.stdout) {
        Ok(result) => Ok(result),
        Err(e) => {
            if out.status.success() {
                Err(format!(
                    "Failed to parse hub.py JSON output: {e}\n{}",
                    String::from_utf8_lossy(&out.stdout)
                ))
            } else {
                Err(fail_message(&out))
            }
        }
    }
}

/// `link_action` (D3): `"this"` (default) unlinks + deletes only this harness's
/// file; `"both"` deletes every linked twin. Ignored (harmless) for standalone
/// agents.
#[tauri::command]
pub async fn subagent_delete(
    scope: String,
    name: String,
    project: Option<String>,
    harness_id: Option<String>,
    link_action: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        subagent_delete_impl(scope, name, project, harness_id, link_action)
    })
    .await
    .map_err(|e| format!("subagent_delete task failed: {e}"))?
}

fn subagent_delete_impl(
    scope: String,
    name: String,
    project: Option<String>,
    harness_id: Option<String>,
    link_action: Option<String>,
) -> Result<Value, String> {
    let harness = resolve_harness(harness_id);
    let mut args: Vec<&str> = vec![
        "subagent", "delete", "--scope", &scope, "--harness", &harness, "--name", &name, "--json",
    ];
    if let Some(la) = link_action.as_deref() {
        if !la.trim().is_empty() {
            args.push("--link-action");
            args.push(la);
        }
    }
    if let Some(p) = project.as_deref() {
        args.push("--project");
        args.push(p);
    }
    let out = run_hub(&args)?;
    match serde_json::from_slice::<Value>(&out.stdout) {
        Ok(v) => Ok(v),
        Err(e) => {
            if out.status.success() {
                Err(format!("Failed to parse hub.py JSON output: {e}"))
            } else {
                Err(fail_message(&out))
            }
        }
    }
}

#[tauri::command]
pub async fn subagent_set_disabled(
    scope: String,
    name: String,
    disabled: bool,
    project: Option<String>,
    harness_id: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        subagent_set_disabled_impl(scope, name, disabled, project, harness_id)
    })
    .await
    .map_err(|e| format!("subagent_set_disabled task failed: {e}"))?
}

fn subagent_set_disabled_impl(
    scope: String,
    name: String,
    disabled: bool,
    project: Option<String>,
    harness_id: Option<String>,
) -> Result<Value, String> {
    let harness = resolve_harness(harness_id);
    let disabled_str = if disabled { "true" } else { "false" };
    let mut args: Vec<&str> = vec![
        "subagent",
        "set-disabled",
        "--scope",
        &scope,
        "--harness",
        &harness,
        "--name",
        &name,
        "--disabled",
        disabled_str,
        "--json",
    ];
    if let Some(p) = project.as_deref() {
        args.push("--project");
        args.push(p);
    }
    let out = run_hub(&args)?;
    if !out.status.success() {
        return Err(fail_message(&out));
    }
    serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("Failed to parse hub.py JSON output: {e}"))
}

#[tauri::command]
pub async fn subagent_skill_usage() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(subagent_skill_usage_impl)
        .await
        .map_err(|e| format!("subagent_skill_usage task failed: {e}"))?
}

fn subagent_skill_usage_impl() -> Result<Value, String> {
    let out = run_hub(&["subagent", "skill-usage", "--json"])?;
    if !out.status.success() {
        return Err(fail_message(&out));
    }
    serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("Failed to parse hub.py JSON output: {e}"))
}

/// Skills offered by the attach-skills picker, each marked with point-of-choice
/// attachability so the UI can prevent invalid preloads.
#[tauri::command]
pub async fn subagent_attachable_skills(
    scope: String,
    project: Option<String>,
    harness_id: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        subagent_attachable_skills_impl(scope, project, harness_id)
    })
    .await
    .map_err(|e| format!("subagent_attachable_skills task failed: {e}"))?
}

fn subagent_attachable_skills_impl(
    scope: String,
    project: Option<String>,
    harness_id: Option<String>,
) -> Result<Value, String> {
    let harness = resolve_harness(harness_id);
    let mut args: Vec<&str> = vec![
        "subagent", "attachable-skills", "--scope", &scope, "--harness", &harness, "--json",
    ];
    if let Some(p) = project.as_deref() {
        args.push("--project");
        args.push(p);
    }
    let out = run_hub(&args)?;
    if !out.status.success() {
        return Err(fail_message(&out));
    }
    serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("Failed to parse hub.py JSON output: {e}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Linked twins (D3) — user scope only in this release. Thin marshalling; all
// link/drift logic lives in `subagent_links.py`. Structured `{ok:false}` bodies
// on a nonzero exit still deserialize (see `run_value_or_fail`).
// ─────────────────────────────────────────────────────────────────────────────

/// Record a link between the same-named agent across harnesses. `copy_from`
/// projects the shared core into a harness where the agent is missing.
#[tauri::command]
pub async fn subagent_link(name: String, copy_from: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || subagent_link_impl(name, copy_from))
        .await
        .map_err(|e| format!("subagent_link task failed: {e}"))?
}

fn subagent_link_impl(name: String, copy_from: Option<String>) -> Result<Value, String> {
    let mut args: Vec<&str> = vec!["subagent", "link", "--name", &name, "--json"];
    if let Some(c) = copy_from.as_deref() {
        if !c.trim().is_empty() {
            args.push("--copy-from");
            args.push(c);
        }
    }
    run_value_or_fail(&args)
}

/// Remove the link sidecar entry; both native files are left in place.
#[tauri::command]
pub async fn subagent_unlink(name: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || subagent_unlink_impl(name))
        .await
        .map_err(|e| format!("subagent_unlink task failed: {e}"))?
}

fn subagent_unlink_impl(name: String) -> Result<Value, String> {
    run_value_or_fail(&["subagent", "unlink", "--name", &name, "--json"])
}

/// All recorded links (twin-lost + drift) + same-name suggestions for the scope.
#[tauri::command]
pub async fn subagent_link_status() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(subagent_link_status_impl)
        .await
        .map_err(|e| format!("subagent_link_status task failed: {e}"))?
}

fn subagent_link_status_impl() -> Result<Value, String> {
    run_value_or_fail(&["subagent", "link-status", "--json"])
}

/// Provision an attached skill so an agent's `skills:` reference resolves (D5
/// phase 2). `global` flips the skill to `scope: global` + re-runs the global
/// pass; `project` enables + resyncs it for that project. `widen_affinity`
/// clears a `harnesses:` restriction excluding the agent's harness. A structured
/// `{ok:false, error, …}` refusal rides a nonzero exit and still deserializes.
#[tauri::command]
pub async fn subagent_provision_skill(
    skill: String,
    global: bool,
    project: Option<String>,
    harness_id: Option<String>,
    widen_affinity: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        subagent_provision_skill_impl(skill, global, project, harness_id, widen_affinity)
    })
    .await
    .map_err(|e| format!("subagent_provision_skill task failed: {e}"))?
}

fn subagent_provision_skill_impl(
    skill: String,
    global: bool,
    project: Option<String>,
    harness_id: Option<String>,
    widen_affinity: bool,
) -> Result<Value, String> {
    let harness = resolve_harness(harness_id);
    let mut args: Vec<&str> = vec![
        "subagent", "provision-skill", "--skill", &skill, "--harness", &harness, "--json",
    ];
    if global {
        args.push("--global");
    }
    if let Some(p) = project.as_deref() {
        if !p.trim().is_empty() {
            args.push("--project");
            args.push(p);
        }
    }
    if widen_affinity {
        args.push("--widen-affinity");
    }
    run_value_or_fail(&args)
}

/// Resolve linked-twin drift per field. `decisions` maps a shared-core field to
/// the winner harness id; it rides the child's STDIN as `{"decisions": {…}}`.
#[tauri::command]
pub async fn subagent_resolve_drift(name: String, decisions: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || subagent_resolve_drift_impl(name, decisions))
        .await
        .map_err(|e| format!("subagent_resolve_drift task failed: {e}"))?
}

fn subagent_resolve_drift_impl(name: String, decisions: Value) -> Result<Value, String> {
    let payload = serde_json::json!({ "decisions": decisions });
    let body = serde_json::to_string(&payload)
        .map_err(|e| format!("Failed to serialize decisions payload: {e}"))?;
    let out = run_hub_stdin(&["subagent", "resolve-drift", "--name", &name, "--json"], &body)?;
    // Like `save`: a `{ok:false, error}` body rides a nonzero exit — parse first.
    match serde_json::from_slice::<Value>(&out.stdout) {
        Ok(v) => Ok(v),
        Err(e) => {
            if out.status.success() {
                Err(format!(
                    "Failed to parse hub.py JSON output: {e}\n{}",
                    String::from_utf8_lossy(&out.stdout)
                ))
            } else {
                Err(fail_message(&out))
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract-parity test (task 2.3)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// Locate the repo root (where `hub.py` lives) by walking up from this file.
    fn repo_root() -> PathBuf {
        // CARGO_MANIFEST_DIR = app/src-tauri ; repo root is two levels up.
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest
            .parent()
            .and_then(Path::parent)
            .expect("repo root from app/src-tauri")
            .to_path_buf()
    }

    fn python_bin() -> String {
        std::env::var("PYTHON").unwrap_or_else(|_| "python3".to_string())
    }

    /// Spawn the REAL CLI against hermetic tmp dirs and deserialize stdout into
    /// `SubagentListResult` — proving the Rust structs match the live JSON.
    /// Fails loudly on any field drift.
    #[test]
    fn list_json_deserializes_into_contract_struct() {
        let root = repo_root();
        let hub = root.join("hub.py");
        if !hub.exists() {
            eprintln!("skipping: hub.py not found at {}", hub.display());
            return;
        }

        // Hermetic homes: a tmp claude home with one synthetic agent, and a tmp
        // data home so we never touch the real ~/.claude or ~/.skill-hub.
        let base = std::env::temp_dir().join(format!(
            "subagent-contract-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let claude_home = base.join("claude");
        let agents_dir = claude_home.join("agents");
        let data_home = base.join("data");
        std::fs::create_dir_all(&agents_dir).expect("create agents dir");
        std::fs::create_dir_all(&data_home).expect("create data home");

        let agent_md = "---\nname: contract-probe\ndescription: A synthetic agent for the Rust contract test.\nmodel: sonnet\ntools: Read, Grep\nskills:\n  - some-skill\ncolor: blue\n---\nYou are a probe.\n";
        std::fs::write(agents_dir.join("contract-probe.md"), agent_md)
            .expect("write synthetic agent");
        // Minimal data home so hub.py's optional registry read succeeds.
        std::fs::write(data_home.join("registry.yaml"), "projects: {}\n")
            .expect("write registry");

        let output = Command::new(python_bin())
            .arg(&hub)
            .args(["subagent", "list", "--scope", "user", "--json"])
            .current_dir(&root)
            .env("SKILL_HUB_CLAUDE_HOME", &claude_home)
            .env("SKILL_HUB_HOME", &data_home)
            .env_remove("SKILL_HUB_DIR")
            .env_remove("SKILL_HUB_CODE")
            .output()
            .expect("spawn hub.py subagent list");

        // Clean up tmp tree regardless of assertion outcome.
        let _ = std::fs::remove_dir_all(&base);

        assert!(
            output.status.success(),
            "hub.py subagent list failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );

        let result: SubagentListResult = serde_json::from_slice(&output.stdout).unwrap_or_else(|e| {
            panic!(
                "SubagentListResult failed to deserialize CLI JSON (field drift?): {e}\n{}",
                String::from_utf8_lossy(&output.stdout)
            )
        });

        assert_eq!(result.scope, "user");
        let probe = result
            .agents
            .iter()
            .find(|a| a.name == "contract-probe")
            .expect("synthetic agent present in list");
        assert_eq!(probe.model, "sonnet");
        assert_eq!(probe.tools_mode, "allowlist");
        assert!(probe.tools.contains(&"Read".to_string()));
        assert!(probe.skills.contains(&"some-skill".to_string()));
        assert!(!probe.builtin);
        // Claude payloads never carry the codex-only extras.
        assert!(probe.sandbox_mode.is_none());
        assert!(probe.model_reasoning_effort.is_none());
        assert!(probe.nickname_candidates.is_none());
        // `harness` is additive and defaults on the shipped shape.
        assert_eq!(result.harness.as_deref(), Some("claude-code"));
    }

    // ─── Codex parity (task 2.3) ──────────────────────────────────────────

    /// A hermetic env for the codex CLI: HOME (the `~/.agents/skills` root),
    /// CODEX_HOME (the agents dir), a tmp claude home, and a tmp data home —
    /// never the real `~/.codex`, `~/.agents`, or `~/.claude`.
    struct CodexEnv {
        base: PathBuf,
        home: PathBuf,
        codex_home: PathBuf,
        claude_home: PathBuf,
        data_home: PathBuf,
        agents_dir: PathBuf,
    }

    fn make_codex_env() -> CodexEnv {
        let base = std::env::temp_dir().join(format!(
            "subagent-codex-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let home = base.join("home");
        let codex_home = base.join("codexhome");
        let claude_home = base.join("claude");
        let data_home = base.join("data");
        let agents_dir = codex_home.join("agents");
        std::fs::create_dir_all(&agents_dir).expect("create codex agents dir");
        std::fs::create_dir_all(home.join(".agents").join("skills"))
            .expect("create codex skills root");
        std::fs::create_dir_all(claude_home.join("agents")).expect("create claude agents dir");
        std::fs::create_dir_all(&data_home).expect("create data home");
        std::fs::write(data_home.join("registry.yaml"), "projects: {}\n")
            .expect("write registry");
        CodexEnv {
            base,
            home,
            codex_home,
            claude_home,
            data_home,
            agents_dir,
        }
    }

    /// Spawn the REAL CLI for a codex subcommand against the hermetic env,
    /// piping optional stdin. Returns (stdout, stderr, success).
    fn run_codex_cli(
        env: &CodexEnv,
        root: &Path,
        hub: &Path,
        args: &[&str],
        stdin: Option<&str>,
    ) -> (String, String, bool) {
        let mut cmd = Command::new(python_bin());
        cmd.arg(hub)
            .args(args)
            .current_dir(root)
            .env("HOME", &env.home)
            .env("CODEX_HOME", &env.codex_home)
            .env("SKILL_HUB_CLAUDE_HOME", &env.claude_home)
            .env("SKILL_HUB_HOME", &env.data_home)
            .env_remove("SKILL_HUB_DIR")
            .env_remove("SKILL_HUB_CODE");
        let out = if let Some(payload) = stdin {
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut child = cmd.spawn().expect("spawn hub.py");
            child
                .stdin
                .as_mut()
                .expect("child stdin")
                .write_all(payload.as_bytes())
                .expect("write payload");
            child.wait_with_output().expect("wait hub.py")
        } else {
            cmd.output().expect("spawn hub.py")
        };
        (
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
            out.status.success(),
        )
    }

    /// list/show/save against `--harness codex` deserialize into the extended
    /// structs with the codex-only fields populated — proving Rust matches the
    /// live JSON contract for the codex path.
    #[test]
    fn codex_json_deserializes_into_contract_struct() {
        let root = repo_root();
        let hub = root.join("hub.py");
        if !hub.exists() {
            eprintln!("skipping: hub.py not found at {}", hub.display());
            return;
        }
        let env = make_codex_env();

        // A sample user-scope codex agent (TOML).
        let toml = "name = \"rust_parity\"\ndescription = \"d\"\ndeveloper_instructions = \"x\"\nsandbox_mode = \"read-only\"\n";
        std::fs::write(env.agents_dir.join("rust_parity.toml"), toml)
            .expect("write codex agent");

        // ── list ──────────────────────────────────────────────────────────
        let (stdout, stderr, ok) =
            run_codex_cli(&env, &root, &hub, &["subagent", "list", "--harness", "codex", "--json"], None);
        assert!(ok, "codex list failed: {stdout}{stderr}");
        let list: SubagentListResult = serde_json::from_str(&stdout).unwrap_or_else(|e| {
            let _ = std::fs::remove_dir_all(&env.base);
            panic!("SubagentListResult codex field drift: {e}\n{stdout}");
        });
        assert_eq!(list.harness.as_deref(), Some("codex"));
        assert_eq!(list.settings_path, "");
        let item = list
            .agents
            .iter()
            .find(|a| a.name == "rust_parity")
            .expect("codex agent present");
        assert_eq!(item.sandbox_mode.as_deref(), Some("read-only"));
        // Inert claude defaults + codex extras present.
        assert_eq!(item.tools_mode, "all");
        assert!(item.model_reasoning_effort.is_some());
        assert!(item.nickname_candidates.is_some());
        // Built-ins carry the codex trio.
        assert!(list.builtins.iter().any(|b| b.name == "worker"));

        // ── show ──────────────────────────────────────────────────────────
        let (stdout, stderr, ok) = run_codex_cli(
            &env,
            &root,
            &hub,
            &["subagent", "show", "--harness", "codex", "--name", "rust_parity", "--json"],
            None,
        );
        assert!(ok, "codex show failed: {stdout}{stderr}");
        let show: SubagentShow = serde_json::from_str(&stdout).unwrap_or_else(|e| {
            let _ = std::fs::remove_dir_all(&env.base);
            panic!("SubagentShow codex field drift: {e}\n{stdout}");
        });
        assert!(show.exists);
        assert_eq!(show.advanced_format, "toml");
        assert_eq!(show.safe.sandbox_mode.as_deref(), Some("read-only"));

        // ── save round-trip via stdin with harness=codex ───────────────────
        let payload = SubagentSavePayload {
            harness: Some("codex".to_string()),
            scope: "user".to_string(),
            project: None,
            original_name: None,
            safe: SubagentSafe {
                name: "rust_saved".to_string(),
                description: "saved by the rust parity test".to_string(),
                sandbox_mode: Some("workspace-write".to_string()),
                ..Default::default()
            },
            advanced_yaml: String::new(),
            body: "Do the parity thing.\n".to_string(),
        };
        let body = serde_json::to_string(&payload).expect("serialize save payload");
        let (stdout, stderr, ok) =
            run_codex_cli(&env, &root, &hub, &["subagent", "save", "--json"], Some(&body));
        assert!(ok, "codex save failed: {stdout}{stderr}");
        let saved: SubagentSaveResult = serde_json::from_str(&stdout).unwrap_or_else(|e| {
            let _ = std::fs::remove_dir_all(&env.base);
            panic!("SubagentSaveResult drift: {e}\n{stdout}");
        });

        let _ = std::fs::remove_dir_all(&env.base);
        assert!(saved.ok, "codex save reported failure: {stdout}");
        assert_eq!(saved.name.as_deref(), Some("rust_saved"));
        assert!(saved.file.map(|f| f.ends_with(".toml")).unwrap_or(false));
    }

    // ─── Linked twins (D3) round-trip ──────────────────────────────────────

    /// link → link-status → unlink against the live CLI: a matching
    /// claude `.md` + codex `.toml` pair links, surfaces in status, then
    /// unlinks. Proves the Wave-4 bridge commands drive the real link sidecar.
    #[test]
    fn link_status_unlink_round_trip() {
        let root = repo_root();
        let hub = root.join("hub.py");
        if !hub.exists() {
            eprintln!("skipping: hub.py not found at {}", hub.display());
            return;
        }
        let env = make_codex_env();

        // Two twins with the SAME name (valid for both slug rules).
        let md = "---\nname: twin\ndescription: A linked twin.\nmodel: sonnet\n---\nShared body.\n";
        std::fs::write(env.claude_home.join("agents").join("twin.md"), md)
            .expect("write claude twin");
        let toml = "name = \"twin\"\ndescription = \"A linked twin.\"\ndeveloper_instructions = \"Shared body.\"\n";
        std::fs::write(env.agents_dir.join("twin.toml"), toml).expect("write codex twin");

        // ── link (no --copy-from: both files already present) ────────────────
        let (stdout, stderr, ok) =
            run_codex_cli(&env, &root, &hub, &["subagent", "link", "--name", "twin", "--json"], None);
        assert!(ok, "link failed: {stdout}{stderr}");
        let v: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_else(|e| {
            let _ = std::fs::remove_dir_all(&env.base);
            panic!("link JSON parse: {e}\n{stdout}");
        });
        assert_eq!(v["ok"], serde_json::json!(true), "link not ok: {stdout}");

        // ── link-status: the pair is present ─────────────────────────────────
        let (stdout, stderr, ok) =
            run_codex_cli(&env, &root, &hub, &["subagent", "link-status", "--json"], None);
        assert!(ok, "link-status failed: {stdout}{stderr}");
        let v: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_else(|e| {
            let _ = std::fs::remove_dir_all(&env.base);
            panic!("link-status JSON parse: {e}\n{stdout}");
        });
        let linked = v["links"]
            .as_array()
            .map(|a| a.iter().any(|l| l["name"] == "twin"))
            .unwrap_or(false);
        assert!(linked, "twin not in link-status: {stdout}");

        // ── unlink: durable removal (files untouched) ────────────────────────
        let (stdout, stderr, ok) =
            run_codex_cli(&env, &root, &hub, &["subagent", "unlink", "--name", "twin", "--json"], None);
        assert!(ok, "unlink failed: {stdout}{stderr}");
        let v: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_else(|e| {
            let _ = std::fs::remove_dir_all(&env.base);
            panic!("unlink JSON parse: {e}\n{stdout}");
        });
        let _ = std::fs::remove_dir_all(&env.base);
        assert_eq!(v["ok"], serde_json::json!(true), "unlink not ok: {stdout}");
        assert_eq!(v["unlinked"], serde_json::json!(true), "not unlinked: {stdout}");
    }

    // ─── Attach-skill provisioning (D5) round-trip ─────────────────────────

    /// provision-skill --global against the live CLI: a non-global registry
    /// skill is flipped to `scope: global`, the global-skills pass re-runs, and
    /// the returned path exists on disk. Proves the Wave-5 bridge drives the real
    /// two-phase provisioner.
    #[test]
    fn provision_skill_global_round_trip() {
        let root = repo_root();
        let hub = root.join("hub.py");
        if !hub.exists() {
            eprintln!("skipping: hub.py not found at {}", hub.display());
            return;
        }
        // Bespoke hermetic env: HOME carries BOTH harness detection markers +
        // their global skill dirs (claude → $HOME/.claude/skills via ~ expansion;
        // codex → $HOME/.agents/skills). SKILL_HUB_CLAUDE_HOME + CODEX_HOME point
        // at the SAME $HOME dirs so detection and resolution agree (mirrors the
        // pytest prov_env). Never touches the real homes.
        let base = std::env::temp_dir().join(format!(
            "subagent-prov-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let home = base.join("home");
        let claude = home.join(".claude");
        let codex = home.join(".codex");
        let data_home = base.join("data");
        std::fs::create_dir_all(claude.join("projects")).expect("claude detection marker");
        std::fs::create_dir_all(claude.join("skills")).expect("claude global skills dir");
        std::fs::create_dir_all(codex.join("agents")).expect("codex agents dir");
        std::fs::write(codex.join("config.toml"), "").expect("codex detection marker");
        std::fs::create_dir_all(home.join(".agents").join("skills")).expect("codex skills root");
        std::fs::create_dir_all(&data_home).expect("data home");

        // A real skill SOURCE dir the registry points at.
        let src = base.join("skillsrc").join("myskill");
        std::fs::create_dir_all(&src).expect("create skill source");
        std::fs::write(
            src.join("SKILL.md"),
            "---\nname: myskill\ndescription: my skill\n---\nBody\n",
        )
        .expect("write SKILL.md");

        // Registry: one non-global (portable) skill + both harnesses global.
        let reg = format!(
            "harnesses_global: [claude-code, codex]\nskills:\n  myskill:\n    source: {}\n    scope: portable\n    type: claude-skill\n    description: my skill\nprojects: {{}}\n",
            src.display()
        );
        std::fs::write(data_home.join("registry.yaml"), reg).expect("write registry");

        let mut cmd = Command::new(python_bin());
        cmd.arg(&hub)
            .args([
                "subagent", "provision-skill", "--skill", "myskill", "--global",
                "--harness", "claude-code", "--json",
            ])
            .current_dir(&root)
            .env("HOME", &home)
            .env("CODEX_HOME", &codex)
            .env("SKILL_HUB_CLAUDE_HOME", &claude)
            .env("SKILL_HUB_HOME", &data_home)
            .env_remove("SKILL_HUB_DIR")
            .env_remove("SKILL_HUB_CODE");
        let out = cmd.output().expect("spawn hub.py provision-skill");
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        let ok = out.status.success();
        assert!(ok, "provision failed: {stdout}{stderr}");
        let v: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_else(|e| {
            let _ = std::fs::remove_dir_all(&base);
            panic!("provision JSON parse: {e}\n{stdout}");
        });
        let path = v["path"].as_str().unwrap_or_default().to_string();
        let path_exists = !path.is_empty() && std::path::Path::new(&path).exists();
        let ok_flag = v["ok"] == serde_json::json!(true);
        let mode = v["mode"].as_str().unwrap_or_default().to_string();
        let _ = std::fs::remove_dir_all(&base);
        assert!(ok_flag, "provision not ok: {stdout}");
        assert_eq!(mode, "make-global", "unexpected mode: {stdout}");
        assert!(
            path.replace('\\', "/").ends_with("myskill/SKILL.md"),
            "unexpected provisioned path: {path}"
        );
        assert!(path_exists, "provisioned path missing on disk: {path}");
    }
}
