use super::*;
use tempfile::TempDir;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn test_source() -> UsageSource {
    UsageSource {
        command: "ccusage".to_string(),
        args: fixed_ccusage_args(),
        resolved_from: "test".to_string(),
    }
}

fn success_output(stdout: &str) -> CommandOutput {
    let status = Command::new("true").status().unwrap();
    CommandOutput {
        status,
        stdout: stdout.as_bytes().to_vec(),
        stderr: Vec::new(),
    }
}

#[test]
fn usage_fixed_args_match_safe_ccusage_contract() {
    assert_eq!(
        fixed_ccusage_args(),
        vec![
            "--sections".to_string(),
            "daily,weekly,monthly,session".to_string(),
            "--by-agent".to_string(),
            "--json".to_string(),
            // --offline keeps the scan local-only (no LiteLLM pricing fetch).
            "--offline".to_string(),
        ]
    );
}

#[test]
fn usage_resolve_fails_closed_when_no_candidate_exists() {
    // Point every search root at an empty scratch dir: nothing resolves.
    let td = TempDir::new().unwrap();
    let empty = td.path().to_path_buf();
    let err = select_first_existing(ccusage_candidates(vec![empty.clone()], vec![empty.clone()]))
        .expect_err("no ccusage anywhere must be an Err, never a bare-PATH fallback");
    assert!(
        err.contains("ccusage"),
        "error should name the missing runner: {err}"
    );

    // Guard the invariant directly: none of the assembled candidates is an
    // unqualified binary name (which would be a $PATH-planting risk). Check
    // BOTH platform name sets, not just the host's.
    for windows in [false, true] {
        for name in binary_names_for(windows) {
            let bare = PathBuf::from(name);
            assert!(
                ccusage_candidates_named(
                    vec![empty.clone()],
                    vec![empty.clone()],
                    binary_names_for(windows),
                )
                .into_iter()
                .all(|(path, _)| path != bare),
                "no candidate may be the bare PATH-relative binary name ({name})"
            );
        }
    }
}

#[test]
fn usage_windows_binary_names_probe_exe_then_cmd_then_bare() {
    // Regression guard for the Windows bundle: the CI job ships the real
    // `ccusage.exe` (plus an extension-less copy for the macOS-shaped
    // resource entry), so probing only `ccusage.cmd` would be dead on
    // arrival. Deliberately NOT cfg(windows)-gated — the ordering is pure
    // data and must hold when the suite runs on macOS/Linux.
    assert_eq!(
        binary_names_for(true),
        &["ccusage.exe", "ccusage.cmd", "ccusage"]
    );
    assert_eq!(binary_names_for(false), &["ccusage"]);
}

#[test]
fn usage_windows_candidates_reach_the_packaged_exe_first() {
    let root = PathBuf::from("C:/Program Files/Skill Tree");
    let candidates =
        ccusage_candidates_named(Vec::new(), vec![root.clone()], binary_names_for(true));
    let paths: Vec<PathBuf> = candidates.into_iter().map(|(path, _)| path).collect();

    // The path the Windows bundle actually installs must be probed…
    let packaged_exe = root.join("ccusage").join("bin").join("ccusage.exe");
    let idx_exe = paths
        .iter()
        .position(|p| *p == packaged_exe)
        .expect("packaged ccusage/bin/ccusage.exe must be a candidate");

    // …and it must win over the same-directory .cmd and extension-less copy.
    let idx_cmd = paths
        .iter()
        .position(|p| *p == root.join("ccusage").join("bin").join("ccusage.cmd"))
        .expect("ccusage.cmd must still be probed");
    let idx_bare = paths
        .iter()
        .position(|p| *p == root.join("ccusage").join("bin").join("ccusage"))
        .expect("extension-less ccusage must still be probed");
    assert!(
        idx_exe < idx_cmd,
        "the native .exe must outrank the .cmd shim"
    );
    assert!(
        idx_exe < idx_bare,
        "the native .exe must outrank the bare copy"
    );
}

#[test]
fn usage_candidate_order_puts_repo_before_packaged() {
    // Dev-repo-first ordering survives the multi-name refactor.
    let repo = PathBuf::from("/repo/app");
    let packaged = PathBuf::from("/packaged");
    let candidates =
        ccusage_candidates_named(vec![repo.clone()], vec![packaged.clone()], &["ccusage"]);
    assert_eq!(
        candidates.first().map(|(p, from)| (p.clone(), *from)),
        Some((
            repo.join("node_modules").join(".bin").join("ccusage"),
            "repo_node_modules"
        ))
    );
    assert!(candidates
        .iter()
        .skip(1)
        .all(|(_, from)| *from == "packaged_resource"));
}

#[test]
fn usage_capture_bounded_truncates_beyond_cap() {
    // Beyond the cap: capture stops at exactly `cap` bytes.
    let big = vec![b'x'; 4096];
    assert_eq!(capture_bounded(&big[..], 100).len(), 100);
    // Under the cap: everything passes through untouched.
    let small = vec![b'y'; 42];
    assert_eq!(capture_bounded(&small[..], 100), small);
}

#[test]
fn usage_strict_parse_failure_is_classified() {
    let err = parse_scan_output(success_output("{\"daily\":[]} trailing"), test_source(), 1)
        .expect_err("trailing content must fail strict JSON parsing");
    assert_eq!(err.kind, UsageErrorKind::ParseFailure);
    assert!(err.stdout.unwrap().contains("trailing"));
}

#[test]
fn usage_no_usage_payload_is_classified() {
    let raw = r#"{"daily":[],"weekly":[],"monthly":[],"session":[],"totals":{"totalTokens":0}}"#;
    let err = parse_scan_output(success_output(raw), test_source(), 1)
        .expect_err("empty known report sections should be no_usage");
    assert_eq!(err.kind, UsageErrorKind::NoUsage);
}

#[test]
fn usage_cache_redacts_paths_and_drops_raw_before_write() {
    const SECRET_PATH: &str = "/Users/alice/secret-client-project";
    let td = TempDir::new().unwrap();
    let scan = UsageScan {
        scanned_at: 123,
        source: test_source(),
        raw: r#"{"daily":[{"agent":"codex","projectPath":"/Users/alice/secret-client-project"}]}"#
            .to_string(),
        // Path is nested inside an object inside an array to prove the walk recurses.
        parsed: serde_json::json!({
            "daily": [{
                "agent": "codex",
                "totalTokens": 4242,
                "session": {
                    "cwd": SECRET_PATH
                }
            }],
            "weekly": [],
            "monthly": [],
            "session": []
        }),
        ledger_note: None,
    };
    write_latest_cache_in(td.path(), &scan).expect("write cache");

    let cache_path = td.path().join("usage").join("latest-ccusage.json");
    assert!(cache_path.exists());

    // The literal secret path must never appear anywhere in the bytes on disk.
    let on_disk = fs::read_to_string(&cache_path).expect("read raw cache bytes");
    assert!(
        !on_disk.contains(SECRET_PATH),
        "raw path literal leaked into cache file: {on_disk}"
    );
    // Non-path data (a token count, a harness id) must survive verbatim.
    assert!(
        on_disk.contains("4242"),
        "token count was altered: {on_disk}"
    );
    assert!(
        on_disk.contains("codex"),
        "harness id was altered: {on_disk}"
    );

    let loaded = read_latest_cache_in(td.path())
        .expect("read cache")
        .expect("cache present");
    // raw is never persisted.
    assert!(loaded.raw.is_empty(), "raw should be dropped in the cache");
    // Placeholder is path-shaped so the frontend heuristic still recognizes it.
    let placeholder = loaded.parsed["daily"][0]["session"]["cwd"]
        .as_str()
        .expect("redacted path is still a string");
    assert!(placeholder.starts_with("~/redacted/"));
    assert_ne!(placeholder, SECRET_PATH);

    // Determinism: the same input path redacts to the same placeholder every time,
    // across independent writes into separate temp dirs.
    let td2 = TempDir::new().unwrap();
    write_latest_cache_in(td2.path(), &scan).expect("write cache 2");
    let loaded2 = read_latest_cache_in(td2.path())
        .expect("read cache 2")
        .expect("cache present 2");
    assert_eq!(
        loaded.parsed["daily"][0]["session"]["cwd"], loaded2.parsed["daily"][0]["session"]["cwd"],
        "redaction must be deterministic across writes"
    );
    // And directly at the helper level.
    assert_eq!(
        redacted_path_placeholder(SECRET_PATH),
        redacted_path_placeholder(SECRET_PATH)
    );

    #[cfg(unix)]
    {
        let mode = fs::metadata(&cache_path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "cache must be owner-only (0o600)");
    }
}

#[test]
fn usage_missing_cache_returns_none() {
    let td = TempDir::new().unwrap();
    assert!(read_latest_cache_in(td.path()).unwrap().is_none());
}

#[test]
fn usage_failure_text_classification_detects_no_usage_and_access() {
    assert_eq!(
        classify_failed_process(b"", b"No usage data found"),
        UsageErrorKind::NoUsage
    );
    assert_eq!(
        classify_failed_process(b"", b"EACCES: permission denied"),
        UsageErrorKind::Access
    );
    assert_eq!(
        classify_failed_process(b"", b"native binary exploded"),
        UsageErrorKind::ProcessFailure
    );
}

#[cfg(unix)]
#[test]
fn usage_timeout_is_classified() {
    // Some CI/sandbox environments mount the OS temp directory with noexec.
    // Place the helper under the crate working directory so this test
    // exercises the timeout path instead of a PermissionDenied spawn.
    let cwd = std::env::current_dir().unwrap();
    let td = tempfile::Builder::new()
        .prefix("slow-ccusage-")
        .tempdir_in(cwd)
        .unwrap();
    let script = td.path().join("slow-ccusage");
    fs::write(&script, b"#!/bin/sh\nsleep 2\nprintf '{}'\n").unwrap();
    let mut perms = fs::metadata(&script).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&script, perms).unwrap();

    let err = run_ccusage(
        &script,
        &fixed_ccusage_args(),
        Duration::from_millis(50),
        &test_source(),
    )
    .expect_err("slow command should time out");
    assert_eq!(err.kind, UsageErrorKind::Timeout);
}

#[test]
fn wait_with_timeout_returns_status_for_a_process_that_exits() {
    let mut child = Command::new("sh")
        .args(["-c", "exit 3"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let status = wait_with_timeout(&mut child, Duration::from_secs(5))
        .expect("try_wait must not error for a well-behaved child")
        .expect("a process that exits promptly must yield Some(status)");
    assert_eq!(status.code(), Some(3));
}

#[test]
fn wait_with_timeout_kills_and_returns_none_on_timeout() {
    let mut child = Command::new("sleep")
        .arg("5")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();
    assert!(
        wait_with_timeout(&mut child, Duration::from_millis(100))
            .expect("a timeout is Ok(None), not Err")
            .is_none(),
        "a process that outlives the timeout must yield None"
    );
    // The child must actually be dead afterward, not just abandoned. `kill -0`
    // (signal 0) fails once the pid no longer exists (or has been reaped as a
    // zombie an unrelated process can't signal).
    let still_alive = Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    assert!(!still_alive, "timed-out child must be dead, pid {pid}");
}

#[test]
fn classify_record_outcome_spawn_error_is_some() {
    let note = classify_record_outcome(None, false, Some("no such file".to_string()))
        .expect("a spawn error must produce a note");
    assert!(note.contains("could not start hub usage record"));
    assert!(note.contains("no such file"));
}

#[test]
fn classify_record_outcome_timeout_is_some() {
    let note = classify_record_outcome(None, true, None).expect("a timeout must produce a note");
    assert!(note.contains("timed out"));
    assert!(note.contains(&RECORD_TIMEOUT.as_secs().to_string()));
}

#[test]
fn classify_record_outcome_nonzero_exit_includes_stderr_line() {
    let output = Command::new("sh")
        .args(["-c", "echo boom-detail 1>&2; exit 1"])
        .output()
        .unwrap();
    let note = classify_record_outcome(Some(output), false, None)
        .expect("a non-zero exit must produce a note");
    assert!(
        note.contains("exit 1"),
        "note should name the exit code: {note}"
    );
    assert!(
        note.contains("boom-detail"),
        "note should include the stderr line: {note}"
    );
}

#[test]
fn classify_record_outcome_success_is_none() {
    let output = Command::new("true").output().unwrap();
    assert_eq!(classify_record_outcome(Some(output), false, None), None);
}

#[test]
fn classify_record_outcome_falls_back_to_stdout_json_error_when_stderr_is_empty() {
    // W1: `hub_cli/usage.py`'s `--json` failure path prints exactly this
    // shape on stdout with nothing on stderr — the classifier must
    // surface the `error` field, not "no output".
    let output = Command::new("sh")
        .args([
            "-c",
            "printf '{\"ok\":false,\"error\":\"scan contained no daily rows\"}'; exit 2",
        ])
        .output()
        .unwrap();
    let note = classify_record_outcome(Some(output), false, None)
        .expect("a non-zero exit must produce a note");
    assert!(
        note.contains("scan contained no daily rows"),
        "note should surface stdout's JSON error field: {note}"
    );
    assert!(
        note.contains("exit 2"),
        "note should name the exit code: {note}"
    );
}

#[test]
fn classify_record_outcome_falls_back_to_plain_stdout_line_when_not_json() {
    let output = Command::new("sh")
        .args(["-c", "printf 'not json at all'; exit 1"])
        .output()
        .unwrap();
    let note = classify_record_outcome(Some(output), false, None)
        .expect("a non-zero exit must produce a note");
    assert!(
        note.contains("not json at all"),
        "note should fall back to stdout's first line: {note}"
    );
}

#[test]
fn classify_record_outcome_reports_no_output_when_both_streams_are_empty() {
    let output = Command::new("sh").args(["-c", "exit 1"]).output().unwrap();
    let note = classify_record_outcome(Some(output), false, None)
        .expect("a non-zero exit must produce a note");
    assert!(
        note.contains("no output"),
        "note should be the fixed fallback: {note}"
    );
}

#[test]
fn wait_failure_diagnostic_reports_process_failure_kind_and_carries_the_error_string() {
    // W7: an OS-level `try_wait` error must classify as `ProcessFailure`,
    // exactly as `run_ccusage` did at 7deb8ad — not `Timeout`, which is
    // what collapsing `Err` into `wait_with_timeout`'s `None` used to
    // produce. Tested directly since a real `try_wait` failure is
    // impractical to force from a test.
    let e = std::io::Error::new(std::io::ErrorKind::Other, "boom");
    let diag = wait_failure_diagnostic(&e, &test_source(), b"out", b"err");
    assert_eq!(diag.kind, UsageErrorKind::ProcessFailure);
    assert_eq!(diag.detail.as_deref(), Some("boom"));
    assert_eq!(diag.stdout.as_deref(), Some("out"));
    assert_eq!(diag.stderr.as_deref(), Some("err"));
}

#[test]
fn usage_enrich_claude_joins_and_normalizes_to_pi_shape() {
    let mut parsed = serde_json::json!({
        "session": [{ "agent": "claude", "period": "abc-123", "totalTokens": 9 }]
    });
    let mut paths = HashMap::new();
    paths.insert("abc-123".to_string(), "-Users-x-y".to_string());
    enrich_claude_project_paths(&mut parsed, &paths);
    assert_eq!(
        parsed["session"][0]["metadata"]["projectPath"]
            .as_str()
            .unwrap(),
        "--Users-x-y--",
        "claude key must be re-wrapped to pi's double-dash shape"
    );
}

#[test]
fn usage_enrich_claude_no_match_leaves_row_untouched() {
    let mut parsed = serde_json::json!({
        "session": [{ "agent": "claude", "period": "no-such-id", "totalTokens": 9 }]
    });
    let mut paths = HashMap::new();
    paths.insert("abc-123".to_string(), "-Users-x-y".to_string());
    enrich_claude_project_paths(&mut parsed, &paths);
    assert!(
        parsed["session"][0].get("metadata").is_none(),
        "a row with no matching session id must not gain a metadata key"
    );
}

#[test]
fn usage_enrich_claude_leaves_non_claude_rows_untouched() {
    // A pi row whose period collides with a key in the paths map must NOT be
    // enriched — enrichment is claude-only (pi already has its own working path).
    let mut parsed = serde_json::json!({
        "session": [{ "agent": "pi", "period": "abc-123", "totalTokens": 9 }]
    });
    let mut paths = HashMap::new();
    paths.insert("abc-123".to_string(), "-Users-x-y".to_string());
    enrich_claude_project_paths(&mut parsed, &paths);
    assert!(
        parsed["session"][0].get("metadata").is_none(),
        "non-claude rows must never be touched by claude enrichment"
    );
}

#[test]
fn usage_enrich_claude_skips_mixed_dash_slash_projectpath() {
    // Verified against real local data: some claude sessions (nested/subagent
    // working directories) report a projectPath that mixes a dash-encoded prefix
    // with literal `/`-separated segments. This can't be losslessly re-wrapped
    // into the double-dash shape, and injecting it verbatim would leak a real
    // path + username past redaction (see the malformed-key redaction test
    // below). The row must be left unenriched, same as a join-miss.
    let mut parsed = serde_json::json!({
        "session": [{ "agent": "claude", "period": "abc-123", "totalTokens": 9 }]
    });
    let mut paths = HashMap::new();
    paths.insert(
        "abc-123".to_string(),
        "-Users-ramtoi-Dev--skill-hub/83de6d7b/subagents/workflows".to_string(),
    );
    enrich_claude_project_paths(&mut parsed, &paths);
    assert!(
        parsed["session"][0].get("metadata").is_none(),
        "a mixed dash+slash projectPath must never be injected"
    );
}

#[test]
fn usage_redact_catches_malformed_dash_slash_key_even_if_injected() {
    // Defense-in-depth: even if a dash-prefixed, slash-containing string reaches
    // the parsed tree by some other path, cache redaction must still catch it —
    // it's trivially reversible to a real path + username.
    let leaky = "-Users-ramtoi-Dev--skill-hub/83de6d7b/subagents/workflows";
    assert!(looks_like_malformed_encoded_key(leaky));
    assert!(!looks_like_local_path(leaky));
    assert!(!looks_like_encoded_project_key(leaky));
    let redacted = redact_value(&Value::String(leaky.to_string()));
    let redacted_str = redacted.as_str().unwrap();
    assert!(
        !redacted_str.contains("ramtoi") && !redacted_str.contains("skill-hub"),
        "malformed encoded key must be redacted before it could reach disk, got: {redacted_str}"
    );
    // Codex's date-shaped period/sessionId values must NOT be caught by the new
    // backstop (they never start with a dash, so this stays narrowly scoped).
    let codex_period = "2026/02/19/rollout-2026-02-19T18-55-10-019c770a";
    assert!(!looks_like_malformed_encoded_key(codex_period));
}

#[cfg(unix)]
#[test]
fn usage_fetch_claude_project_paths_failure_returns_none() {
    // A helper that exits non-zero / prints garbage for the claude-project args
    // must yield None (not a panic or Err) so enrichment never fails the scan.
    let cwd = std::env::current_dir().unwrap();
    let td = tempfile::Builder::new()
        .prefix("bad-ccusage-")
        .tempdir_in(cwd)
        .unwrap();
    let script = td.path().join("bad-ccusage");
    fs::write(&script, b"#!/bin/sh\nprintf 'not json at all'\nexit 3\n").unwrap();
    let mut perms = fs::metadata(&script).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&script, perms).unwrap();

    assert!(
        fetch_claude_project_paths(&script, &test_source()).is_none(),
        "any failure/garbage must yield None, never an error that fails the scan"
    );
}

#[test]
fn usage_cache_redacts_encoded_project_key_before_write() {
    const ENCODED_KEY: &str = "--Users-x-y--";
    let td = TempDir::new().unwrap();
    let scan = UsageScan {
        scanned_at: 7,
        source: test_source(),
        raw: String::new(),
        parsed: serde_json::json!({
            "session": [{
                "agent": "claude",
                "totalTokens": 4242,
                "metadata": { "projectPath": ENCODED_KEY }
            }],
            "daily": [],
            "weekly": [],
            "monthly": []
        }),
        ledger_note: None,
    };
    write_latest_cache_in(td.path(), &scan).expect("write cache");

    let cache_path = td.path().join("usage").join("latest-ccusage.json");
    let on_disk = fs::read_to_string(&cache_path).expect("read raw cache bytes");
    assert!(
        !on_disk.contains(ENCODED_KEY),
        "encoded project key leaked into cache file verbatim: {on_disk}"
    );

    let loaded = read_latest_cache_in(td.path())
        .expect("read cache")
        .expect("cache present");
    let placeholder = loaded.parsed["session"][0]["metadata"]["projectPath"]
        .as_str()
        .expect("redacted key is still a string");
    assert!(
        placeholder.starts_with("~/redacted/"),
        "encoded key must be redacted to a placeholder: {placeholder}"
    );
    assert_ne!(placeholder, ENCODED_KEY);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing overrides (ccusage-pricing.json / usage_pricing_info)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn usage_pricing_config_path_some_when_file_exists_else_none() {
    let td = TempDir::new().unwrap();
    assert_eq!(pricing_config_path(td.path()), None, "no file yet");

    let path = td.path().join(PRICING_CONFIG_FILE);
    fs::write(&path, b"{}").unwrap();
    assert_eq!(pricing_config_path(td.path()), Some(path));
}

#[test]
fn usage_scan_args_default_matches_the_historical_fixed_args() {
    assert_eq!(scan_args(None, false), fixed_ccusage_args());
}

#[test]
fn usage_scan_args_with_config_ends_with_config_flag_and_path() {
    let td = TempDir::new().unwrap();
    let config = td.path().join(PRICING_CONFIG_FILE);
    let args = scan_args(Some(&config), false);
    assert_eq!(args.len(), fixed_ccusage_args().len() + 2);
    assert_eq!(
        &args[args.len() - 2..],
        &[
            "--config".to_string(),
            config.to_string_lossy().into_owned()
        ]
    );
    // The offline flag is untouched by adding a config.
    assert!(args.contains(&"--offline".to_string()));
}

#[test]
fn usage_scan_args_online_omits_offline() {
    let args = scan_args(None, true);
    assert!(
        !args.contains(&"--offline".to_string()),
        "online_pricing=true must drop --offline: {args:?}"
    );
    // The report shape itself is unchanged.
    assert!(args.contains(&"--json".to_string()));
}

#[test]
fn usage_scan_args_online_with_config_still_appends_config() {
    let td = TempDir::new().unwrap();
    let config = td.path().join(PRICING_CONFIG_FILE);
    let args = scan_args(Some(&config), true);
    assert!(!args.contains(&"--offline".to_string()));
    assert_eq!(
        &args[args.len() - 2..],
        &[
            "--config".to_string(),
            config.to_string_lossy().into_owned()
        ]
    );
}

#[test]
fn usage_parse_pricing_overrides_reads_the_checked_in_shape_sorted_by_model() {
    let td = TempDir::new().unwrap();
    let path = td.path().join(PRICING_CONFIG_FILE);
    fs::write(
        &path,
        r#"{
            "$schema": "https://ccusage.com/config-schema.json",
            "defaults": {
                "pricingOverrides": {
                    "claude-sonnet-5": { "inputCostPerToken": 0.000002, "outputCostPerToken": 0.00001, "cacheCreationInputTokenCost": 0.0000025, "cacheReadInputTokenCost": 0.0000002 },
                    "claude-fable-5-1": { "inputCostPerToken": 0.00001, "outputCostPerToken": 0.00005, "cacheCreationInputTokenCost": 0.0000125, "cacheReadInputTokenCost": 0.00000025 },
                    "claude-opus-5": { "inputCostPerToken": 0.000005, "outputCostPerToken": 0.000025, "cacheCreationInputTokenCost": 0.00000625, "cacheReadInputTokenCost": 0.0000005 }
                }
            }
        }"#,
    )
    .unwrap();

    let rows = parse_pricing_overrides(&path);
    let models: Vec<&str> = rows.iter().map(|r| r.model.as_str()).collect();
    assert_eq!(
        models,
        vec!["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"],
        "must be sorted by model name"
    );
    let sonnet = rows.iter().find(|r| r.model == "claude-sonnet-5").unwrap();
    assert_eq!(sonnet.input, 0.000002);
    assert_eq!(sonnet.output, 0.00001);
    assert_eq!(sonnet.cache_write, 0.0000025);
    assert_eq!(sonnet.cache_read, 0.0000002);
}

#[test]
fn usage_parse_pricing_overrides_missing_field_defaults_to_zero() {
    let td = TempDir::new().unwrap();
    let path = td.path().join(PRICING_CONFIG_FILE);
    fs::write(
        &path,
        r#"{"defaults": {"pricingOverrides": {"m": {"inputCostPerToken": 1.5}}}}"#,
    )
    .unwrap();
    let rows = parse_pricing_overrides(&path);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].input, 1.5);
    assert_eq!(rows[0].output, 0.0);
    assert_eq!(rows[0].cache_write, 0.0);
    assert_eq!(rows[0].cache_read, 0.0);
}

#[test]
fn usage_parse_pricing_overrides_missing_or_malformed_file_is_empty_not_a_panic() {
    let td = TempDir::new().unwrap();
    assert_eq!(
        parse_pricing_overrides(&td.path().join("nope.json")),
        Vec::new()
    );

    let bad = td.path().join("bad.json");
    fs::write(&bad, b"not json").unwrap();
    assert_eq!(parse_pricing_overrides(&bad), Vec::new());

    let wrong_shape = td.path().join("wrong-shape.json");
    fs::write(&wrong_shape, b"{\"defaults\": {}}").unwrap();
    assert_eq!(parse_pricing_overrides(&wrong_shape), Vec::new());
}

#[test]
fn usage_offline_from_cache_defaults_true_with_no_cache() {
    let td = TempDir::new().unwrap();
    assert!(offline_from_cache(td.path()));
}

#[test]
fn usage_offline_from_cache_reads_the_last_scans_own_args() {
    let td = TempDir::new().unwrap();

    let mut offline_source = test_source();
    offline_source.args = scan_args(None, false);
    let offline_scan = UsageScan {
        scanned_at: 1,
        source: offline_source,
        raw: String::new(),
        parsed: serde_json::json!({}),
        ledger_note: None,
    };
    write_latest_cache_in(td.path(), &offline_scan).expect("write offline cache");
    assert!(offline_from_cache(td.path()));

    let mut online_source = test_source();
    online_source.args = scan_args(None, true);
    let online_scan = UsageScan {
        scanned_at: 2,
        source: online_source,
        raw: String::new(),
        parsed: serde_json::json!({}),
        ledger_note: None,
    };
    write_latest_cache_in(td.path(), &online_scan).expect("write online cache");
    assert!(
        !offline_from_cache(td.path()),
        "a scan whose args lack --offline must report offline: false"
    );
}
