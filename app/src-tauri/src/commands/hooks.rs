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
use super::hub::{hub_cmd_impl, HubResult};
use super::hub_json_value;
use serde_json::Value;

// ─── Off-main-thread helpers (mirror remotes.rs) ──────────────────────────────

async fn json_off_thread(args: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        hub_json_value(&refs, None)
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

/// A read-only risk scan over every attached hook. Maps to
/// `hub hook doctor --json` → `{findings: [{hook, scope, harness, code,
/// severity, explanation, detail}], danger_count}`. `--json` mode always exits
/// 0 (a danger finding is data, not a CLI failure), so this never surfaces as
/// an `Err` on account of `danger_count > 0`.
#[tauri::command]
pub async fn hook_doctor() -> Result<Value, String> {
    json_off_thread(vec!["hook".into(), "doctor".into(), "--json".into()]).await
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
/// `hub hook new <name> --event E (--command C | --script-source … ) [--tools …]
///  [--matcher …] [--timeout n] [--harnesses …]`. `tools`/`harnesses` are
/// CSV-joined. `command` and the script group are mutually exclusive CLI-side;
/// the bridge forwards whichever the caller set and lets the CLI fail closed.
// NOTE: the `allow` sits ABOVE `#[tauri::command]` because the async-conformance
// test parses the line right after the command attribute as the fn signature.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn hook_new(
    name: String,
    event: String,
    command: Option<String>,
    description: Option<String>,
    tools: Option<Vec<String>>,
    matcher: Option<String>,
    timeout: Option<i64>,
    harnesses: Option<Vec<String>>,
    script_source: Option<String>,
    script_interpreter: Option<String>,
    script_path: Option<String>,
    script_args: Option<String>,
    script_body: Option<String>,
) -> Result<HubResult, String> {
    let mut args: Vec<String> = vec!["hook".into(), "new".into(), name, "--event".into(), event];
    if let Some(c) = command {
        args.push("--command".into());
        args.push(c);
    }
    if let Some(d) = description {
        args.push("--description".into());
        args.push(d);
    }
    if let Some(n) = timeout {
        args.push("--timeout".into());
        args.push(n.to_string());
    }
    push_common_def_args(&mut args, tools, matcher, harnesses);
    // A body has to travel as a FILE: a script is arbitrary multi-line text and
    // would not survive argv quoting intact. The temp file is removed after the
    // CLI has read it (in `run_with_body_file`).
    let body = push_script_args(
        &mut args,
        script_source,
        script_interpreter,
        script_path,
        script_args,
        script_body,
    );
    run_with_body_file(args, body).await
}

/// Edit a user hook definition (built-ins reject core edits CLI-side). Only the
/// fields the caller sets are forwarded, mirroring the CLI's per-field semantics.
/// Maps to `hub hook edit <name> [--event …] [--command …] …`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn hook_edit(
    name: String,
    event: Option<String>,
    command: Option<String>,
    description: Option<String>,
    tools: Option<Vec<String>>,
    matcher: Option<String>,
    // A raw string (not i64) so `Some("")` can express "clear the existing
    // timeout" distinctly from `None` ("field not touched") — an Option<i64>
    // collapses both into `None` and the CLI has no way to tell them apart
    // (hooks-surface review-panel finding: clearing a timeout was a no-op).
    timeout: Option<String>,
    harnesses: Option<Vec<String>>,
    script_source: Option<String>,
    script_interpreter: Option<String>,
    script_path: Option<String>,
    script_args: Option<String>,
    script_body: Option<String>,
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
    if let Some(d) = description {
        args.push("--description".into());
        args.push(d);
    }
    if let Some(t) = timeout {
        args.push("--timeout".into());
        args.push(t);
    }
    push_common_def_args(&mut args, tools, matcher, harnesses);
    let body = push_script_args(
        &mut args,
        script_source,
        script_interpreter,
        script_path,
        script_args,
        script_body,
    );
    run_with_body_file(args, body).await
}

/// Shared `--script-*` marshalling for new+edit. `script_source` is the switch:
/// `Some("")` is the CLI's explicit CLEAR sentinel (drop the script block),
/// `Some("managed"|"repo")` sets it, `None` leaves the field untouched.
///
/// Returns the script BODY (if any) rather than pushing it: the body cannot ride
/// on argv, so the caller writes it to a temp file and appends
/// `--script-body-file <tmp>`.
fn push_script_args(
    args: &mut Vec<String>,
    script_source: Option<String>,
    script_interpreter: Option<String>,
    script_path: Option<String>,
    script_args: Option<String>,
    script_body: Option<String>,
) -> Option<String> {
    let clearing = script_source.as_deref() == Some("");
    if let Some(s) = script_source {
        args.push("--script-source".into());
        args.push(s);
    }
    // Clearing the script means the rest of the group is meaningless; forwarding
    // an interpreter/path alongside `--script-source ""` invites the CLI to
    // reconstruct the very block we are dropping.
    if clearing {
        return None;
    }
    if let Some(i) = script_interpreter {
        args.push("--script-interpreter".into());
        args.push(i);
    }
    if let Some(p) = script_path {
        args.push("--script-path".into());
        args.push(p);
    }
    if let Some(a) = script_args {
        // Single `=` token: an args value usually starts with a dash (`--fix`),
        // which argparse would reject as a stray flag in the two-token form.
        args.push(format!("--script-args={a}"));
    }
    script_body
}

/// Run a `hub hook …` command, first materialising `body` into a temp file and
/// appending `--script-body-file <tmp>`. The temp file is always removed, even
/// when the CLI fails — a leaked script body in `/tmp` is a small but real
/// disclosure of whatever the user typed.
async fn run_with_body_file(
    mut args: Vec<String>,
    body: Option<String>,
) -> Result<HubResult, String> {
    let Some(body) = body else {
        return hub_off_thread(args).await;
    };
    tauri::async_runtime::spawn_blocking(move || {
        let path = write_temp_body("script", &body)?;
        args.push("--script-body-file".into());
        args.push(path.to_string_lossy().into_owned());
        let out = hub_cmd_impl(args);
        let _ = std::fs::remove_file(&path);
        out
    })
    .await
    .map_err(|e| format!("hook task failed: {e}"))?
}

/// A collision-free temp path for one body hand-off (pid + nanos, same recipe as
/// the other subprocess bridges).
fn temp_body_path(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "st-hook-{}-{}-{}.txt",
        tag,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ))
}

/// Stage a script body in the system temp dir and return its path.
///
/// The temp dir is world-writable and shared, so the file is created with
/// `create_new` (which fails on an EXISTING path — including a symlink another
/// user planted there, whose target `fs::write` would otherwise truncate and
/// overwrite) and, on unix, mode `0o600` (`fs::write` leaves 0644, i.e. every
/// local account can read whatever the user typed into the script editor).
/// One retry covers the practically-impossible pid+nanos collision.
fn write_temp_body(tag: &str, body: &str) -> Result<std::path::PathBuf, String> {
    let mut last_err = String::new();
    for _ in 0..2 {
        let path = temp_body_path(tag);
        match stage_body_at(&path, body) {
            Ok(()) => return Ok(path),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(format!("could not stage script body: {last_err}"))
}

/// Create `path` fresh (owner-only on unix) and write `body` into it. Fails with
/// `AlreadyExists` when anything is already at `path` — the symlink guard.
fn stage_body_at(path: &std::path::Path, body: &str) -> std::io::Result<()> {
    use std::io::Write;

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    if let Err(e) = f.write_all(body.as_bytes()) {
        // A half-written body would be handed to the CLI as the user's script.
        let _ = std::fs::remove_file(path);
        return Err(e);
    }
    Ok(())
}

/// The managed script body for `name`. Maps to
/// `hub hook script show <name> --json` → `{source, interpreter, path, body}`.
/// Errors (non-managed hook, unknown name) propagate as the CLI's message.
#[tauri::command]
pub async fn hook_script_show(name: String) -> Result<Value, String> {
    json_off_thread(vec![
        "hook".into(),
        "script".into(),
        "show".into(),
        name,
        "--json".into(),
    ])
    .await
}

/// Overwrite a managed script body. Maps to
/// `hub hook script save <name> --body-file <tmp>` (the body never rides on
/// argv — see `run_with_body_file`).
#[tauri::command]
pub async fn hook_script_save(name: String, body: String) -> Result<HubResult, String> {
    let args: Vec<String> = vec!["hook".into(), "script".into(), "save".into(), name];
    tauri::async_runtime::spawn_blocking(move || {
        let path = write_temp_body("save", &body)?;
        let mut args = args;
        args.push("--body-file".into());
        args.push(path.to_string_lossy().into_owned());
        let out = hub_cmd_impl(args);
        let _ = std::fs::remove_file(&path);
        out
    })
    .await
    .map_err(|e| format!("hook task failed: {e}"))?
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
    use super::{
        push_common_def_args, push_script_args, scope_args, stage_body_at, temp_body_path,
        write_temp_body,
    };

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

    // ─── Script-action marshalling (hook-editor-redesign D3) ─────────────────

    #[test]
    fn no_script_source_emits_no_script_flags_at_all() {
        let mut args = v(&["hook", "edit", "lint-x"]);
        let body = push_script_args(&mut args, None, None, None, None, None);
        // `None` = "the caller never mentioned the action shape". Emitting any
        // --script-* flag here would rewrite a command hook into a broken script
        // hook on an unrelated save (e.g. a timeout-only edit).
        assert_eq!(args, v(&["hook", "edit", "lint-x"]));
        assert!(body.is_none());
    }

    #[test]
    fn managed_source_forwards_interpreter_and_args_but_no_path() {
        let mut args = v(&["hook", "new", "lint-x"]);
        let body = push_script_args(
            &mut args,
            Some("managed".into()),
            Some("python3".into()),
            None,
            Some("--fix".into()),
            Some("print('hi')\n".into()),
        );
        assert_eq!(flag(&args, "--script-source"), Some("managed"));
        assert_eq!(flag(&args, "--script-interpreter"), Some("python3"));
        assert!(args.iter().any(|a| a == "--script-args=--fix"));
        // A managed script has no relative path — the CLI rejects one.
        assert!(!args.iter().any(|a| a == "--script-path"));
        // The body is handed back for the temp-file hand-off, never pushed onto
        // argv (a multi-line script would not survive argument quoting).
        assert_eq!(body.as_deref(), Some("print('hi')\n"));
        assert!(!args.iter().any(|a| a.contains("print(")));
    }

    #[test]
    fn repo_source_forwards_the_relative_path() {
        let mut args = v(&["hook", "edit", "lint-x"]);
        let body = push_script_args(
            &mut args,
            Some("repo".into()),
            Some("bash".into()),
            Some("scripts/lint.sh".into()),
            None,
            None,
        );
        assert_eq!(flag(&args, "--script-source"), Some("repo"));
        assert_eq!(flag(&args, "--script-path"), Some("scripts/lint.sh"));
        assert!(body.is_none());
    }

    #[test]
    fn empty_source_is_the_clear_sentinel_and_drops_the_rest_of_the_group() {
        let mut args = v(&["hook", "edit", "lint-x"]);
        let body = push_script_args(
            &mut args,
            Some(String::new()),
            Some("bash".into()),
            Some("scripts/lint.sh".into()),
            Some("--fix".into()),
            Some("echo hi".into()),
        );
        // `--script-source ""` tells the CLI to DROP the script block. Sending an
        // interpreter/path/body alongside it would hand the CLI everything it
        // needs to rebuild the block we just asked it to delete.
        assert_eq!(flag(&args, "--script-source"), Some(""));
        assert!(!args.iter().any(|a| a == "--script-interpreter"));
        assert!(!args.iter().any(|a| a == "--script-path"));
        assert!(!args.iter().any(|a| a.starts_with("--script-args")));
        assert!(body.is_none());
    }

    #[test]
    fn script_args_pass_through_unescaped() {
        let mut args = v(&["hook", "new", "lint-x"]);
        push_script_args(
            &mut args,
            Some("repo".into()),
            Some("bash".into()),
            Some("scripts/lint.sh".into()),
            Some("--fix --max-warnings 0".into()),
            None,
        );
        // Args are documented as "appended verbatim"; mangling them here changes
        // what the hook actually runs.
        assert!(args
            .iter()
            .any(|a| a == "--script-args=--fix --max-warnings 0"));
    }

    #[test]
    fn temp_body_paths_are_unique_per_call() {
        // Two saves racing in one process must not stomp on each other's body
        // file — that would silently write one hook's script into another.
        let a = temp_body_path("script");
        let b = temp_body_path("script");
        assert_ne!(a, b);
        assert!(a.to_string_lossy().contains("st-hook-script-"));
    }

    #[test]
    fn staged_body_round_trips_and_is_not_world_readable() {
        let path = write_temp_body("unit", "#!/usr/bin/env bash\necho hi\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "#!/usr/bin/env bash\necho hi\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // The temp dir is shared. 0644 (what `fs::write` leaves) hands every
            // local account whatever the user typed into the script editor.
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "staged body must be owner-only");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn staging_refuses_to_write_through_a_pre_existing_path() {
        // `create_new` is the whole point: a planted path (e.g. a symlink at a
        // guessable name pointing somewhere precious) must make staging FAIL,
        // never truncate-and-overwrite the target the way `fs::write` would.
        let path = temp_body_path("collide");
        std::fs::write(&path, "occupied").unwrap();

        let err = stage_body_at(&path, "attacker body").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "occupied");
        let _ = std::fs::remove_file(&path);
    }

    #[cfg(unix)]
    #[test]
    fn staging_refuses_to_follow_a_symlink_planted_at_the_path() {
        // The concrete attack: the temp name is predictable enough to squat, and
        // the victim file is outside the temp dir entirely.
        let victim = temp_body_path("victim");
        std::fs::write(&victim, "precious").unwrap();
        let link = temp_body_path("link");
        std::os::unix::fs::symlink(&victim, &link).unwrap();

        let err = stage_body_at(&link, "attacker body").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "precious");
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_file(&victim);
    }
}
