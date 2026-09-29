//! Claude Code sub-agents — thin marshalling layer over the `hub subagent`
//! CLI. All business logic (parse / validate / serialize / disable) lives in
//! `subagents.py`; this module only shells out and deserializes the JSON
//! contract defined in `design.md` (D2). No file IO, no validation here.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ─────────────────────────────────────────────────────────────────────────────
// JSON contract structs (mirror subagents.py / design.md D2)
// ─────────────────────────────────────────────────────────────────────────────

/// One real (file-based) sub-agent in a `list` result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentListItem {
    pub name: String,
    pub file: String,
    pub relpath: String,
    pub description: String,
    pub model: String,
    pub tools_mode: String,
    pub tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
    pub skills: Vec<String>,
    pub color: String,
    pub disabled: bool,
    pub builtin: bool,
    pub valid: bool,
    /// `[{field, level, message, value}]` — not introspected in Rust.
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
// Subprocess helpers
// ─────────────────────────────────────────────────────────────────────────────

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
    let out = super::hub_output(args)?;
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
    let out = super::hub_output(args)?;
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
        "subagent",
        "list",
        "--scope",
        &scope,
        "--harness",
        &harness,
        "--json",
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
    tauri::async_runtime::spawn_blocking(move || {
        subagent_show_impl(scope, name, project, harness_id)
    })
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
        "subagent",
        "show",
        "--scope",
        &scope,
        "--harness",
        &harness,
        "--name",
        &name,
        "--json",
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
    let out = super::hub_stdin(&["subagent", "save", "--json"], &body)?;
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
        "subagent",
        "delete",
        "--scope",
        &scope,
        "--harness",
        &harness,
        "--name",
        &name,
        "--json",
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
    let out = super::hub_output(&args)?;
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
    let out = super::hub_output(&args)?;
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
    let out = super::hub_output(&["subagent", "skill-usage", "--json"])?;
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
        "subagent",
        "attachable-skills",
        "--scope",
        &scope,
        "--harness",
        &harness,
        "--json",
    ];
    if let Some(p) = project.as_deref() {
        args.push("--project");
        args.push(p);
    }
    let out = super::hub_output(&args)?;
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
        "subagent",
        "provision-skill",
        "--skill",
        &skill,
        "--harness",
        &harness,
        "--json",
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
    let out = super::hub_stdin(
        &["subagent", "resolve-drift", "--name", &name, "--json"],
        &body,
    )?;
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
mod tests;
