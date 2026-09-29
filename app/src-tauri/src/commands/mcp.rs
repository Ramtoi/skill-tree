//! MCP editor-panel bridge (plans/E1.md, M8): one command today —
//! `mcp_set_json`, the stdin-safe write path a header/env credential edit
//! must use so it never reaches argv (`backup.rs`'s argv-is-a-leak precedent).
//! E2 adds two more commands to this same file (reconcile candidates + apply).

use serde_json::Value;

use super::hub_stdin;

/// W5: `output`'s stdout/stderr is a `hub mcp set/show ... --json` process's
/// own bytes — the same payload that carries `spec`/`prior_spec`, whose
/// `headers`/`env` VALUES are credentials. This command exists specifically
/// so a credential never reaches argv (M8); returning the raw bytes on a
/// failure would undo that at the last checkpoint before they leave the
/// process. The full text still goes to the Rust process's own stderr (a
/// local log a user can inspect, never round-tripped to the frontend) —
/// only the byte counts cross the IPC boundary.
fn ok_stdout(output: std::process::Output) -> Result<String, String> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stdout_len = output.stdout.len();
        let stderr_len = output.stderr.len();
        eprintln!(
            "hub mcp set/show failed ({stdout_len} stdout bytes, {stderr_len} stderr bytes):\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        Err(format!(
            "hub exited non-zero ({stdout_len} stdout bytes, {stderr_len} stderr bytes) — see the app log"
        ))
    }
}

/// The byte offset (inclusive) of the `}` that closes the `{` at `start`,
/// tracking string literals and their escapes so a stray brace inside a
/// quoted value (a path, a dict-ish log line) never miscounts the depth.
/// `None` when the object never closes (an incomplete/truncated `{`, or one
/// that is not real JSON structure at all). Byte-indexed rather than
/// char-indexed, but every byte this loop branches on (`{`, `}`, `"`, `\`) is
/// plain ASCII, and a UTF-8 continuation byte can never equal one of those —
/// so every offset this function returns is guaranteed to land on a real
/// char boundary, and slicing `stdout[start..=end]` is always safe.
fn find_balanced_object_end(stdout: &str, start: usize) -> Option<usize> {
    let bytes = stdout.as_bytes();
    if bytes.get(start) != Some(&b'{') {
        return None;
    }
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Parses a `hub mcp …` `--json` payload out of raw stdout. Every one of
/// these verbs runs `hub._auto_sync_tail()` (a write-then-print-"✓ sync
/// complete" pass) AFTER printing its payload — and prints its OWN payload as
/// a pretty-printed, **multi-line** `json.dumps(payload, indent=2)`
/// (`hub_cli/mcp.py:746` for `add`, `:1860` for `reconcile --apply`;
/// INTERFACES §3 says so explicitly) — and `--apply` specifically prints its
/// payload AFTER a full sync's chatter (plans/INTERFACES.md's wave-D-review
/// amendment S5, matching `hub permissions reconcile --apply`). So in every
/// case there is real text on stdout besides the JSON itself, on either side
/// of it, and a bare `serde_json::from_str` on the whole string fails with a
/// "trailing characters" error the instant a real sync prints anything
/// (verified: `serde_json::from_str::<Value>("{\"ok\":true}\nSyncing…")` is
/// `Err`, not `Ok`) — and a line-oriented scan (W3's finding) is dead code
/// against a multi-line payload, since no single line of an `indent=2` object
/// other than its opening `{` ever starts with `{`.
///
/// This instead walks every top-level `{` in `stdout`, in order, and for each
/// one finds its brace-balanced close (`find_balanced_object_end`, which
/// tracks string literals so a stray brace inside quoted chatter — a path, a
/// Python dict repr — cannot miscount the depth), tries to parse that exact
/// slice, and returns the first one that succeeds. A candidate that fails to
/// parse (a dict-ish `{'note': '...'}` log line, single-quoted) is skipped in
/// favor of the next `{` — never falls through to a blind first-to-last
/// slice, which could span clean across real chatter and construct nonsense.
/// Never echoes the raw stdout into the error (W5's lesson: `spec`/
/// `decisions` values can carry a credential) — only its length.
fn parse_json(stdout: &str) -> Result<Value, String> {
    let mut from = 0usize;
    while let Some(rel) = stdout[from..].find('{') {
        let start = from + rel;
        match find_balanced_object_end(stdout, start) {
            Some(end) => {
                if let Ok(v) = serde_json::from_str::<Value>(&stdout[start..=end]) {
                    return Ok(v);
                }
                from = end + 1;
            }
            None => from = start + 1,
        }
    }
    Err(format!(
        "Cannot find a JSON payload in hub.py output ({} bytes)",
        stdout.len()
    ))
}

/// Runs `hub <args>` with `body` on **stdin** (`super::hub_stdin` —
/// `permissions.rs::run_hub_with_stdin`'s pattern) and parses the resulting
/// `--json` payload. `args` is the FULL argv the caller wants run (e.g.
/// `["mcp", "set", "context7", "--json-stdin", "--json"]`) — this command adds
/// nothing to it; the frontend decides the verb, this only keeps the payload
/// off the process's command line.
fn mcp_set_json_impl(args: Vec<String>, body: String) -> Result<Value, String> {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let stdout = ok_stdout(hub_stdin(&arg_refs, &body)?)?;
    parse_json(&stdout)
}

/// E3 rev 2 §2.5/§4: like `ok_stdout`, but for `mcp_add_json`/
/// `mcp_reconcile_apply` only — a non-zero exit whose stdout parses as
/// `{"ok": false, "error": <string>, ...}` is NOT swallowed into a
/// byte-count-only `Err`; it is returned as `Ok(value)` so the frontend can
/// read `code`/`reason`/`name` and pick copy accordingly. `error` (and the
/// whole payload) was already vetted server-side to name only slugs, keys,
/// and vocabulary words (grill finding 9) — never a native entry, a spec
/// value, or stdin bytes — so surfacing it here does not reopen the
/// credential-leak the plain byte-count path exists to prevent. Any other
/// non-zero exit (a crash, a bare-text `fail()`, unparseable stdout) still
/// keeps today's byte-count-only `Err`.
fn ok_stdout_or_structured_failure(output: std::process::Output) -> Result<Value, String> {
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        return parse_json(&stdout);
    }
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if let Ok(value) = parse_json(&stdout) {
        let is_structured_failure = value.get("ok") == Some(&Value::Bool(false))
            && value.get("error").and_then(Value::as_str).is_some();
        if is_structured_failure {
            return Ok(value);
        }
    }
    let stdout_len = output.stdout.len();
    let stderr_len = output.stderr.len();
    eprintln!(
        "hub mcp add/reconcile failed ({stdout_len} stdout bytes, {stderr_len} stderr bytes):\n{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Err(format!(
        "hub exited non-zero ({stdout_len} stdout bytes, {stderr_len} stderr bytes) — see the app log"
    ))
}

#[tauri::command]
pub async fn mcp_set_json(args: Vec<String>, body: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || mcp_set_json_impl(args, body))
        .await
        .map_err(|e| format!("mcp_set_json task failed: {e}"))?
}

/// Runs `hub mcp add … --json-stdin --json` with the pasted-or-assembled
/// server object on **stdin** — the New sheet's ONE submit path (M8), used by
/// both the paste and the details modes so a pasted credential never reaches
/// argv. Same shape as `mcp_set_json`; `body` is already a JSON string.
fn mcp_add_json_impl(args: Vec<String>, body: String) -> Result<Value, String> {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = hub_stdin(&arg_refs, &body)?;
    ok_stdout_or_structured_failure(output)
}

#[tauri::command]
pub async fn mcp_add_json(args: Vec<String>, body: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || mcp_add_json_impl(args, body))
        .await
        .map_err(|e| format!("mcp_add_json task failed: {e}"))?
}

/// Runs `hub mcp reconcile … --apply --decisions-stdin --json` with the
/// caller's decisions object on stdin. `decisions` arrives as a `Value`
/// (rather than a pre-stringified `body`) because the frontend builds one
/// decision object per action (Adopt / Adopt as ${VAR} / Adopt anyway / Keep
/// native / Adopt this one) and this command owns turning it into the exact
/// bytes `hub mcp reconcile` reads from stdin.
fn mcp_reconcile_apply_impl(args: Vec<String>, decisions: Value) -> Result<Value, String> {
    let body = serde_json::to_string(&decisions)
        .map_err(|e| format!("Cannot serialize decisions: {e}"))?;
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = hub_stdin(&arg_refs, &body)?;
    ok_stdout_or_structured_failure(output)
}

#[tauri::command]
pub async fn mcp_reconcile_apply(args: Vec<String>, decisions: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || mcp_reconcile_apply_impl(args, decisions))
        .await
        .map_err(|e| format!("mcp_reconcile_apply task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{ok_stdout_or_structured_failure, parse_json};
    use serde_json::json;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{ExitStatus, Output};

    /// A synthetic `Output` with the given (POSIX) exit code and stdout
    /// bytes, no real process spawned — `ExitStatus::from_raw` encodes a
    /// normal exit in the same `code << 8` shape `waitpid` would report.
    fn fake_output(code: i32, stdout: &str) -> Output {
        Output {
            status: ExitStatus::from_raw(code << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
        }
    }

    #[test]
    fn structured_failure_on_nonzero_exit_returns_ok() {
        // E3 rev 2 §2.5/§4, §5 case 15: a `{"ok": false, "error", "code"}`
        // object on stdout at exit 2 is returned as `Ok(value)`, not
        // swallowed into the byte-count `Err` — the frontend needs `code`.
        let stdout = serde_json::to_string_pretty(
            &json!({"ok": false, "error": "boom", "code": "invalid_name"}),
        )
        .unwrap();
        let out = fake_output(2, &stdout);
        let value = ok_stdout_or_structured_failure(out).expect("structured failure is Ok");
        assert_eq!(value["ok"], false);
        assert_eq!(value["code"], "invalid_name");
        assert_eq!(value["error"], "boom");
    }

    #[test]
    fn unparseable_nonzero_exit_stays_a_byte_count_err() {
        // Anything else non-zero (a crash, bare text) keeps today's
        // byte-count-only `Err` — never echoes the raw stdout (W5).
        let out = fake_output(1, "garbage");
        let err = ok_stdout_or_structured_failure(out).unwrap_err();
        assert!(err.contains("hub exited non-zero"));
        assert!(!err.contains("garbage"));
    }

    #[test]
    fn success_payload_still_parses_through_the_structured_path() {
        let payload =
            serde_json::to_string_pretty(&json!({"ok": true, "name": "context7"})).unwrap();
        let out = fake_output(0, &payload);
        let value = ok_stdout_or_structured_failure(out).unwrap();
        assert_eq!(value["name"], "context7");
    }

    #[test]
    fn parses_a_pretty_printed_payload_with_no_chatter() {
        // The REAL shape: `json.dumps(payload, indent=2)`, multi-line — not
        // the compact single-line JSON the old test fixtures used, which
        // made the line-first scan look like it worked when it was actually
        // dead code (W3).
        let payload =
            serde_json::to_string_pretty(&json!({"ok": true, "name": "context7"})).unwrap();
        let v = parse_json(&payload).unwrap();
        assert_eq!(v["name"], "context7");
    }

    #[test]
    fn tolerates_auto_sync_chatter_after_a_pretty_payload() {
        // `hub mcp set/add --json` prints its (pretty, multi-line) payload
        // FIRST, then `_auto_sync_tail()` prints sync progress ending in
        // "✓ sync complete".
        let payload =
            serde_json::to_string_pretty(&json!({"ok": true, "name": "context7"})).unwrap();
        let stdout = format!("{payload}\n\n\u{2713} sync complete\n\n");
        let v = parse_json(&stdout).unwrap();
        assert_eq!(v["name"], "context7");
    }

    #[test]
    fn tolerates_chatter_before_a_pretty_payload_the_apply_shape() {
        // `hub mcp reconcile --apply`'s payload prints AFTER sync chatter
        // (S5) — the opposite order from every other `hub mcp` verb — and
        // one of the chatter lines itself carries a stray, unbalanced `{`
        // (a path-like fragment), which must not derail the scan.
        let payload =
            serde_json::to_string_pretty(&json!({"ok": true, "imported": ["weather-api"]}))
                .unwrap();
        let stdout = format!(
            "Syncing {{example-app}} \u{2192} /Users/dev/{{proj\nsync complete {{ok}}\n{payload}\n"
        );
        let v = parse_json(&stdout).unwrap();
        assert_eq!(v["imported"][0], "weather-api");
    }

    #[test]
    fn a_dictish_log_line_never_wins_over_the_real_pretty_payload() {
        // A Python dict repr (`{'key': 'value'}`, single-quoted) starts with
        // `{` and closes with a balanced `}`, so the brace-scan finds it as a
        // candidate — but it is not valid JSON, so the scan must move on to
        // the next `{` rather than reporting "no payload found".
        let payload = serde_json::to_string_pretty(&json!({"ok": true, "name": "x"})).unwrap();
        let stdout = format!("{{'note': 'not json'}}\n{payload}\n");
        let v = parse_json(&stdout).unwrap();
        assert_eq!(v["name"], "x");
    }

    #[test]
    fn no_json_payload_anywhere_is_a_named_error_not_a_panic() {
        let err = parse_json("no json here at all").unwrap_err();
        assert!(err.contains("Cannot find a JSON payload"));
        // The raw text is never echoed (W5) — only a byte count.
        assert!(!err.contains("no json here"));
    }
}
