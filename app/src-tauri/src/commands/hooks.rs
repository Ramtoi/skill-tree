//! Hooks — thin marshal layer over the `hub hook …` CLI (hooks-surface D7/D8).
//!
//! Mirrors `remotes.rs`: NO business logic lives in Rust. Read/JSON verbs forward
//! to `hub hook … --json` and parse stdout; mutating verbs forward to `hub hook …`
//! and return the human `{success, output}` payload the UI surfaces in a toast.
//! Every call spawns a `hub.py` subprocess, so every command is `async` and hops
//! onto a worker thread via `spawn_blocking` (the repo's conformance test bans a
//! sync subprocess on the main thread).
//!
//! The one Rust-native read is `hook_capabilities`: a pure filesystem read of the
//! probe cache (`<data_home>/state/harness-capabilities.json`) — it NEVER probes
//! (the probe runs only at sync time, per harness_probe.py's render contract), so
//! it is the cheap reach-badge source. Same precedent as
//! `permissions_recent_imports` reading backup dirs directly.

use super::data_home;
use super::agent_docs::run_hub_json;
use super::hub::{hub_cmd_impl, HubResult};
use serde_json::Value;

// ─── Off-main-thread helpers (mirror remotes.rs) ──────────────────────────────

async fn json_off_thread(args: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_hub_json::<Value>(&refs)
    })
    .await
    .map_err(|e| format!("hook task failed: {e}"))?
}

async fn hub_off_thread(args: Vec<String>) -> Result<HubResult, String> {
    tauri::async_runtime::spawn_blocking(move || hub_cmd_impl(args))
        .await
        .map_err(|e| format!("hook task failed: {e}"))?
}

// ─── Read-only / JSON-emitting `hub hook` commands ────────────────────────────

/// Every hook definition (registry + built-in) with attach summary + reach
/// verdicts. Maps to `hub hook list --json` → `{hooks: [...], reach: {...}}`.
#[tauri::command]
pub async fn hook_list() -> Result<Value, String> {
    json_off_thread(vec!["hook".into(), "list".into(), "--json".into()]).await
}

/// One hook's definition + resolved per-project settings + reach. Maps to
/// `hub hook show <name> --json`.
#[tauri::command]
pub async fn hook_show(name: String) -> Result<Value, String> {
    json_off_thread(vec!["hook".into(), "show".into(), name, "--json".into()]).await
}

/// The cached per-harness hook-capability verdicts (verdict + reason + extra),
/// read straight from `<data_home>/state/harness-capabilities.json`. Returns the
/// whole cache payload (`{schema_version, probed_at, harnesses:{…}}`), or
/// `Value::Null` when the cache is missing/corrupt (never synced yet). This is
/// the reach-badge source and NEVER triggers a probe.
#[tauri::command]
pub async fn hook_capabilities() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(hook_capabilities_impl)
        .await
        .map_err(|e| format!("hook_capabilities task failed: {e}"))?
}

fn hook_capabilities_impl() -> Result<Value, String> {
    let path = data_home()?
        .join("state")
        .join("harness-capabilities.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        // Missing cache is not an error — the library renders "reach unknown"
        // until the first sync probes.
        Err(_) => return Ok(Value::Null),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => Ok(v),
        Err(_) => Ok(Value::Null),
    }
}

// ─── Mutating `hub hook` commands (human-text output) ─────────────────────────

/// Create a user hook definition. Maps to
/// `hub hook new <name> --event E --command C [--tools …] [--matcher …]
///  [--timeout n] [--harnesses …]`. `tools`/`harnesses` are CSV-joined.
#[tauri::command]
pub async fn hook_new(
    name: String,
    event: String,
    command: String,
    tools: Option<Vec<String>>,
    matcher: Option<String>,
    timeout: Option<i64>,
    harnesses: Option<Vec<String>>,
) -> Result<HubResult, String> {
    let mut args: Vec<String> = vec![
        "hook".into(),
        "new".into(),
        name,
        "--event".into(),
        event,
        "--command".into(),
        command,
    ];
    if let Some(n) = timeout {
        args.push("--timeout".into());
        args.push(n.to_string());
    }
    push_common_def_args(&mut args, tools, matcher, harnesses);
    hub_off_thread(args).await
}

/// Edit a user hook definition (built-ins reject core edits CLI-side). Only the
/// fields the caller sets are forwarded, mirroring the CLI's per-field semantics.
/// Maps to `hub hook edit <name> [--event …] [--command …] …`.
#[tauri::command]
pub async fn hook_edit(
    name: String,
    event: Option<String>,
    command: Option<String>,
    tools: Option<Vec<String>>,
    matcher: Option<String>,
    // A raw string (not i64) so `Some("")` can express "clear the existing
    // timeout" distinctly from `None` ("field not touched") — an Option<i64>
    // collapses both into `None` and the CLI has no way to tell them apart
    // (hooks-surface review-panel finding: clearing a timeout was a no-op).
    timeout: Option<String>,
    harnesses: Option<Vec<String>>,
) -> Result<HubResult, String> {
    let mut args: Vec<String> = vec!["hook".into(), "edit".into(), name];
    if let Some(e) = event {
        args.push("--event".into());
        args.push(e);
    }
    if let Some(c) = command {
        args.push("--command".into());
        args.push(c);
    }
    if let Some(t) = timeout {
        args.push("--timeout".into());
        args.push(t);
    }
    push_common_def_args(&mut args, tools, matcher, harnesses);
    hub_off_thread(args).await
}

/// Shared `--tools/--matcher/--harnesses` marshalling for new+edit. A
/// `Some(vec![])` tools/harnesses still emits an empty `--tools ""` so the CLI's
/// clear-list semantics work on edit (empty CSV drops the key). `--timeout` is
/// marshalled separately by each command (new/edit disagree on whether an
/// empty value is meaningful — see `hook_edit`'s doc comment).
fn push_common_def_args(
    args: &mut Vec<String>,
    tools: Option<Vec<String>>,
    matcher: Option<String>,
    harnesses: Option<Vec<String>>,
) {
    if let Some(t) = tools {
        args.push("--tools".into());
        args.push(t.join(","));
    }
    if let Some(m) = matcher {
        args.push("--matcher".into());
        args.push(m);
    }
    if let Some(h) = harnesses {
        args.push("--harnesses".into());
        args.push(h.join(","));
    }
}

/// Delete a user hook + detach it everywhere. `confirm=false` returns the CLI's
/// dry-run blast-radius text; `confirm=true` passes `--yes` and deletes. Maps to
/// `hub hook delete <name> [--yes]`.
#[tauri::command]
pub async fn hook_delete(name: String, confirm: bool) -> Result<HubResult, String> {
    let mut args: Vec<String> = vec!["hook".into(), "delete".into(), name];
    if confirm {
        args.push("--yes".into());
    }
    hub_off_thread(args).await
}

/// Attach a hook at exactly one scope. Pass `global=true` for the machine-wide
/// scope, or `project=<name>` for a project attach. Maps to
/// `hub hook attach <name> --global|--project <p>`.
#[tauri::command]
pub async fn hook_attach(
    name: String,
    global: bool,
    project: Option<String>,
) -> Result<HubResult, String> {
    hub_off_thread(scope_args("attach", name, global, project)).await
}

/// Detach a hook from exactly one scope (see `hook_attach`).
#[tauri::command]
pub async fn hook_detach(
    name: String,
    global: bool,
    project: Option<String>,
) -> Result<HubResult, String> {
    hub_off_thread(scope_args("detach", name, global, project)).await
}

fn scope_args(sub: &str, name: String, global: bool, project: Option<String>) -> Vec<String> {
    let mut args: Vec<String> = vec!["hook".into(), sub.into(), name];
    if global {
        args.push("--global".into());
    } else if let Some(p) = project {
        args.push("--project".into());
        args.push(p);
    }
    args
}

/// Deep-merge a JSON settings object for a hook at global or project scope. The
/// `settings` object is serialized and passed as `--json`. Maps to
/// `hub hook set-settings <name> [--global|--project <p>] --json '{…}'`.
#[tauri::command]
pub async fn hook_set_settings(
    name: String,
    settings: Value,
    global: bool,
    project: Option<String>,
) -> Result<HubResult, String> {
    let mut args: Vec<String> = vec!["hook".into(), "set-settings".into(), name];
    if global {
        args.push("--global".into());
    } else if let Some(p) = project {
        args.push("--project".into());
        args.push(p);
    }
    args.push("--json".into());
    args.push(settings.to_string());
    hub_off_thread(args).await
}

#[cfg(test)]
mod tests {
    use super::{push_common_def_args, scope_args};

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    /// A `--flag value` pair lookup so assertions read as intent, not indices.
    fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .map(String::as_str)
    }

    #[test]
    fn omitted_fields_emit_no_flags() {
        let mut args = v(&["hook", "edit", "lint-x"]);
        push_common_def_args(&mut args, None, None, None);
        // `None` means "the caller never mentioned this field" — emitting the
        // flag anyway would clear a list the user never touched.
        assert_eq!(args, v(&["hook", "edit", "lint-x"]));
    }

    #[test]
    fn tools_and_harnesses_are_csv_joined() {
        let mut args = v(&["hook", "new", "lint-x"]);
        push_common_def_args(
            &mut args,
            Some(v(&["Edit", "Write", "MultiEdit"])),
            None,
            Some(v(&["claude-code", "codex"])),
        );
        assert_eq!(flag(&args, "--tools"), Some("Edit,Write,MultiEdit"));
        assert_eq!(flag(&args, "--harnesses"), Some("claude-code,codex"));
    }

    #[test]
    fn empty_vec_still_emits_the_clear_sentinel() {
        let mut args = v(&["hook", "edit", "lint-x"]);
        push_common_def_args(&mut args, Some(vec![]), Some(String::new()), Some(vec![]));
        // An empty CSV is how the CLI is told to DROP the key. Skipping the push
        // would silently turn "clear the tools list" into a no-op the UI still
        // reports as saved.
        assert_eq!(flag(&args, "--tools"), Some(""));
        assert_eq!(flag(&args, "--matcher"), Some(""));
        assert_eq!(flag(&args, "--harnesses"), Some(""));
    }

    #[test]
    fn matcher_is_passed_through_unescaped() {
        let mut args = v(&["hook", "edit", "lint-x"]);
        push_common_def_args(&mut args, None, Some("Notebook.*|mcp__.*".into()), None);
        // The matcher is a regex escape hatch — any mangling here changes which
        // tool invocations fire the hook.
        assert_eq!(flag(&args, "--matcher"), Some("Notebook.*|mcp__.*"));
    }

    #[test]
    fn scope_args_prefers_global_over_a_stray_project() {
        let args = scope_args("attach", "lint-x".into(), true, Some("alpha".into()));
        assert_eq!(args, v(&["hook", "attach", "lint-x", "--global"]));
        assert!(!args.iter().any(|a| a == "--project"));
    }

    #[test]
    fn scope_args_emits_project_when_not_global() {
        let args = scope_args("detach", "lint-x".into(), false, Some("alpha".into()));
        assert_eq!(
            args,
            v(&["hook", "detach", "lint-x", "--project", "alpha"])
        );
    }

    #[test]
    fn scope_args_with_no_scope_emits_no_flag_and_relies_on_the_cli_to_fail_closed() {
        // global=false + project=None is reachable from the UI; the bridge emits
        // a bare `hub hook attach <name>` and the CLI rejects it ("specify
        // exactly one of --global or --project"). Pinned so a future "helpful"
        // default (e.g. silently attaching globally) can't slip in.
        let args = scope_args("attach", "lint-x".into(), false, None);
        assert_eq!(args, v(&["hook", "attach", "lint-x"]));
        assert!(!args.iter().any(|a| a == "--global"));
        assert!(!args.iter().any(|a| a == "--project"));
    }
}
