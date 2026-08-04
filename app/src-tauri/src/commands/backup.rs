//! Backup & restore bridge (design v2 §9).
//!
//! Every command here is a **thin async marshal** around one `hub.py backup …`
//! (or `hub.py restore …`) subprocess — no business logic lives on the Rust
//! side. Two properties are load-bearing and must not regress:
//!
//! 1. **Async.** `#[tauri::command] async fn` delegating to a `*_impl` via
//!    `spawn_blocking`, per the `command_async_conformance` gate — these all
//!    spawn Python, and a sync command would freeze the UI for the duration of
//!    a network round-trip (`backup now` pushes to GitHub).
//! 2. **Token scrubbing.** A GitHub credential can reach a child process's
//!    output through many paths we do not control (a `git` error echoing a
//!    remote URL, a `gh` diagnostic, a Python traceback holding the token). We
//!    therefore scrub credential-shaped substrings from the **combined stdout +
//!    stderr** of every invocation, on both the success and failure paths,
//!    before any byte crosses into JS. The frontend additionally never puts a
//!    PAT into React state, the Zustand store, or a toast — but that is a
//!    second line of defence, not the first.
//!
//! The PAT login path pipes the token through **stdin only** (the
//! `run_hub_json(args, stdin)` precedent in `registry.rs`) because
//! `hub_cmd_impl` cannot pipe stdin, and because a token in argv would be
//! visible in a process listing.

use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

use super::hub::resolved_python;
use super::{code_home, data_home, hub_py};

/// What a scrubbed credential is replaced with. Contains no `"` or `\`, so
/// substituting it inside a raw JSON document can never break the parse.
const REDACTED: &str = "***";

/// Recognised GitHub credential prefixes. Mirrors the Python-side scanner
/// (`backup.py` §4 secret gate) and the design's stated Rust obligation:
/// `gh[pousr]_[A-Za-z0-9_]+ | github_pat_[A-Za-z0-9_]+`.
///
/// `github_pat_` is listed FIRST so the longest prefix wins — `ghp_` would
/// otherwise never match it, but a naive shortest-first scan could split a
/// `github_pat_…` token and leave a tail behind.
const TOKEN_PREFIXES: &[&str] = &[
    "github_pat_",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
];

/// True for the `[A-Za-z0-9_]` token-body class.
fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Replace every credential-shaped run in `input` with [`REDACTED`].
///
/// Hand-rolled rather than pulling in `regex`: the grammar is a fixed prefix
/// followed by a `[A-Za-z0-9_]+` run, which is a two-line scan, and adding a
/// dependency to the bundle for it is not worth it.
///
/// A bare prefix with no body (e.g. the literal string `"ghp_"` in a help text)
/// is left alone — the pattern requires at least one body char, matching the
/// documented regex.
pub(crate) fn scrub_tokens(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;

    'outer: while i < bytes.len() {
        for prefix in TOKEN_PREFIXES {
            if bytes[i..].starts_with(prefix.as_bytes()) {
                let body_start = i + prefix.len();
                let mut end = body_start;
                while end < bytes.len() && is_token_char(bytes[end] as char) {
                    end += 1;
                }
                if end > body_start {
                    out.push_str(REDACTED);
                    i = end;
                    continue 'outer;
                }
            }
        }
        // Not a token start — copy one char (not one byte, so multi-byte UTF-8
        // in a Python traceback survives intact).
        let ch = input[i..].chars().next().unwrap_or('\u{fffd}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Spawn one `hub.py <args>` subprocess, optionally piping `stdin`, and return
/// its parsed JSON stdout.
///
/// Both exit paths are scrubbed: the success path scrubs stdout before parsing
/// (safe — [`REDACTED`] cannot alter JSON structure), and the failure path
/// scrubs the combined stdout+stderr blob that becomes the JS-visible error.
///
/// A non-zero exit whose stdout is still valid JSON is returned as `Ok` — the
/// backup verbs emit structured `{ok: false, error: …}` rejections and exit 1,
/// and the UI renders those far better than an opaque error string.
fn run_backup_json(args: &[String], stdin: Option<&str>) -> Result<Value, String> {
    let python = resolved_python().ok_or_else(|| {
        "Python not found. Install Python 3 and ensure it is in PATH.".to_string()
    })?;
    let code = code_home()?;
    let data = data_home()?;
    let hub = hub_py()?;

    let mut cmd = Command::new(&python);
    cmd.arg(&hub)
        .args(args)
        .current_dir(&code)
        .env("SKILL_HUB_HOME", data.as_os_str())
        .env("SKILL_HUB_CODE", code.as_os_str())
        .env_remove("SKILL_HUB_DIR")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = if let Some(payload) = stdin {
        cmd.stdin(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn hub.py: {e}"))?;
        if let Some(mut sin) = child.stdin.take() {
            if let Err(e) = sin.write_all(payload.as_bytes()) {
                // Reap before bailing so a failed pipe never leaks a zombie.
                drop(sin);
                let _ = child.kill();
                let _ = child.wait();
                // The error string is scrubbed too: an io::Error Display can in
                // principle carry the payload we were mid-write on.
                return Err(scrub_tokens(&format!("Failed to pipe stdin to hub.py: {e}")));
            }
        }
        child
            .wait_with_output()
            .map_err(|e| format!("Failed to read hub.py output: {e}"))?
    } else {
        cmd.output()
            .map_err(|e| format!("Failed to run hub.py: {e}"))?
    };

    let stdout = scrub_tokens(&String::from_utf8_lossy(&output.stdout));
    let stderr = scrub_tokens(&String::from_utf8_lossy(&output.stderr));

    match serde_json::from_str::<Value>(&stdout) {
        // Structured payload — the verb's own {ok:false} rejections included.
        Ok(v) => Ok(v),
        Err(e) => {
            if output.status.success() {
                Err(format!(
                    "Cannot parse hub.py JSON output: {e}\nRaw: {stdout}{stderr}"
                ))
            } else {
                Err(format!("{stdout}{stderr}").trim().to_string())
            }
        }
    }
}

fn s(v: &str) -> String {
    v.to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// Status / auth
// ─────────────────────────────────────────────────────────────────────────────

/// `hub backup status --json` — cheap, pollable. Shape (M2, `backup.py`):
/// `{enabled, initialized, configured, dir, remote, repo, branch,
///   auth: {configured, pat_available, pat_detail, gh_login, gh_active_login,
///          gh_account_mismatch},
///   push_failures, last_push_error, pending_reconcile, last_commit,
///   ahead, behind, drift, manifest, warnings}`.
#[tauri::command]
pub async fn backup_status() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        run_backup_json(&[s("backup"), s("status"), s("--json")], None)
    })
    .await
    .map_err(|e| format!("backup_status task failed: {e}"))?
}

/// `hub backup auth --json` — walks the full credential ladder (ssh → gh →
/// pat), so it dials the network and is deliberately NOT what the status card
/// polls. Shape: `{method, configured, ladder: [{method, available, detail,
/// user}], keyring_available, pat_available, pat_detail, gh_login,
/// create_method}`.
#[tauri::command]
pub async fn backup_auth_status() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        run_backup_json(&[s("backup"), s("auth"), s("--json")], None)
    })
    .await
    .map_err(|e| format!("backup_auth_status task failed: {e}"))?
}

/// Store a GitHub PAT in the OS keychain via `hub backup auth --login-pat`.
///
/// The token travels on **stdin only**. It is never an argv element (a process
/// listing would expose it), never an env var of this process, and never part
/// of any returned value — the reply is the re-probed auth ladder, and the
/// scrubber covers the error path.
#[tauri::command]
pub async fn backup_auth_login_pat(token: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_backup_json(
            &[s("backup"), s("auth"), s("--login-pat"), s("--json")],
            Some(&token),
        )
    })
    .await
    .map_err(|e| format!("backup_auth_login_pat task failed: {e}"))?
}

/// Delete the stored PAT — `hub backup auth --logout --json`.
#[tauri::command]
pub async fn backup_auth_logout() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        run_backup_json(
            &[s("backup"), s("auth"), s("--logout"), s("--json")],
            None,
        )
    })
    .await
    .map_err(|e| format!("backup_auth_logout task failed: {e}"))?
}

// ─────────────────────────────────────────────────────────────────────────────
// Configure / snapshot
// ─────────────────────────────────────────────────────────────────────────────

/// `hub backup init [--repo owner/name | --remote URL] [--dir PATH] [--create]`.
///
/// `repo` and `remote` are mutually exclusive (hub.py rejects both); the UI only
/// ever sends one. `create` uses the `gh` rung — a fine-grained PAT cannot
/// create repositories, which is why the UI surfaces manual-create guidance
/// when `create_method` is null.
#[tauri::command]
pub async fn backup_init(
    repo: Option<String>,
    remote: Option<String>,
    dir: Option<String>,
    create: Option<bool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec![s("backup"), s("init"), s("--json")];
        if let Some(r) = repo.filter(|v| !v.trim().is_empty()) {
            args.push(s("--repo"));
            args.push(r);
        }
        if let Some(r) = remote.filter(|v| !v.trim().is_empty()) {
            args.push(s("--remote"));
            args.push(r);
        }
        if let Some(d) = dir.filter(|v| !v.trim().is_empty()) {
            args.push(s("--dir"));
            args.push(d);
        }
        if create.unwrap_or(false) {
            args.push(s("--create"));
        }
        run_backup_json(&args, None)
    })
    .await
    .map_err(|e| format!("backup_init task failed: {e}"))?
}

/// Argument assembly for `hub backup now`, in ONE place so it is testable
/// without spawning Python (the same pattern as [`restore_args`]).
///
/// Pinned against hub.py's `p_backup_now` parser: `--no-push`,
/// `--allow-secret SHA[,SHA…]`, and `--acknowledge-restore`.
fn backup_now_args(
    no_push: bool,
    allow_secret: &[String],
    acknowledge_restore: bool,
) -> Vec<String> {
    let mut args = vec![s("backup"), s("now"), s("--json")];
    if no_push {
        args.push(s("--no-push"));
    }
    let allow: Vec<String> = allow_secret
        .iter()
        .filter(|v| !v.trim().is_empty())
        .cloned()
        .collect();
    if !allow.is_empty() {
        args.push(s("--allow-secret"));
        args.push(allow.join(","));
    }
    // Without this flag a "backup now" after a restore commits but refuses to
    // push, and `pending_reconcile` stays set — so the screen's "Acknowledge &
    // back up" button would be indistinguishable from a plain backup that
    // silently changes nothing.
    if acknowledge_restore {
        args.push(s("--acknowledge-restore"));
    }
    args
}

/// `hub backup now [--no-push] [--allow-secret SHA…] [--acknowledge-restore]`.
///
/// One-way by construction — there is no undo for a pushed snapshot, so the UI
/// reports the result in a toast rather than routing it through the undo layer.
/// `allow_secret` acknowledges a specific secret-scanner finding by sha256 and
/// is persisted in the registry's `backup:` block by hub.py.
///
/// `acknowledge_restore` clears the `pending_reconcile` flag a restore sets; the
/// reply stamps `acknowledged_restore: true` when it actually cleared one.
#[tauri::command]
pub async fn backup_now(
    no_push: Option<bool>,
    allow_secret: Option<Vec<String>>,
    acknowledge_restore: Option<bool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_backup_json(
            &backup_now_args(
                no_push.unwrap_or(false),
                &allow_secret.unwrap_or_default(),
                acknowledge_restore.unwrap_or(false),
            ),
            None,
        )
    })
    .await
    .map_err(|e| format!("backup_now task failed: {e}"))?
}

/// `hub backup enable` — sets `backup.enabled = true`.
#[tauri::command]
pub async fn backup_enable() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        run_backup_json(&[s("backup"), s("enable"), s("--json")], None)
    })
    .await
    .map_err(|e| format!("backup_enable task failed: {e}"))?
}

/// `hub backup disable` — sets `backup.enabled = false`. The local repo and
/// remote are left untouched; this only stops the `hub sync` tail pass.
#[tauri::command]
pub async fn backup_disable() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        run_backup_json(&[s("backup"), s("disable"), s("--json")], None)
    })
    .await
    .map_err(|e| format!("backup_disable task failed: {e}"))?
}

// ─────────────────────────────────────────────────────────────────────────────
// Restore — the destructive verb (design §5)
// ─────────────────────────────────────────────────────────────────────────────

/// Argument assembly for both restore verbs, in ONE place.
///
/// Pinned against `hub.py`'s `p_restore` parser: the snapshot is a `--from`
/// **option**, not a positional (argparse rejects a bare positional outright),
/// and the two consent flags are `--accept-executable-state` / `--trust-new-key`.
/// This function is the single edit on the Rust side if a flag spelling moves
/// (`lib/backupContract.ts` is its counterpart on the TS side); everything
/// upstream is written against the normalized plan type, not the wire flags.
fn restore_args(
    source: &str,
    mode: Option<&str>,
    apply: bool,
    accept_executable_state: bool,
    trust_new_key: bool,
    force: bool,
) -> Vec<String> {
    let mut args = vec![s("restore"), s("--from"), source.to_string(), s("--json")];
    if let Some(m) = mode.filter(|v| !v.trim().is_empty()) {
        args.push(s("--mode"));
        args.push(m.to_string());
    }
    if apply {
        args.push(s("--apply"));
    }
    if accept_executable_state {
        args.push(s("--accept-executable-state"));
    }
    if trust_new_key {
        args.push(s("--trust-new-key"));
    }
    if force {
        args.push(s("--force"));
    }
    args
}

/// Dry-run restore plan. **Never writes** — dry-run is the CLI default and this
/// verb deliberately omits `--apply`, so the worst case of a UI bug here is a
/// stale preview, not a mutated data home.
///
/// `source` is a git URL or a local snapshot directory. Returns the machine
/// -readable plan the danger-zone dialog enumerates (§5): entries the target
/// loses, conflicts, executable state (hook commands verbatim, permission
/// rules, Codex trust grants), unresolved project paths, out-of-data-home write
/// targets, and warnings.
#[tauri::command]
pub async fn restore_preview(source: String, mode: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_backup_json(
            &restore_args(&source, mode.as_deref(), false, false, false, false),
            None,
        )
    })
    .await
    .map_err(|e| format!("restore_preview task failed: {e}"))?
}

/// Apply a restore. Destructive, irreversible from the UI's point of view (hub
/// takes its own pre-write backups; the app offers no undo).
///
/// `accept_executable_state` must be `true` whenever the plan enumerated any
/// hooks / permission rules / trust grants — the CLI refuses otherwise, and the
/// screen gates the confirm button on an explicit checkbox so the refusal is
/// never how the user first learns about it.
///
/// `trust_new_key` is the same deal for a signer this machine has never seen:
/// the CLI's interactive TOFU prompt is unreachable through a `--json` pipe, so
/// the app MUST carry the consent as a flag or the apply silently refuses.
#[tauri::command]
pub async fn restore_apply(
    source: String,
    mode: Option<String>,
    accept_executable_state: Option<bool>,
    trust_new_key: Option<bool>,
    force: Option<bool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_backup_json(
            &restore_args(
                &source,
                mode.as_deref(),
                true,
                accept_executable_state.unwrap_or(false),
                trust_new_key.unwrap_or(false),
                force.unwrap_or(false),
            ),
            None,
        )
    })
    .await
    .map_err(|e| format!("restore_apply task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrubs_every_documented_token_prefix() {
        for (raw, why) in [
            ("ghp_abc123DEF456", "classic PAT"),
            ("gho_oauthtoken00", "oauth"),
            ("ghu_usertoken000", "user-to-server"),
            ("ghs_servertoken0", "server-to-server"),
            ("ghr_refreshtoken", "refresh"),
            ("github_pat_11ABCDE_xyz789", "fine-grained PAT"),
        ] {
            let out = scrub_tokens(&format!("remote: rejected {raw} bad"));
            assert_eq!(out, "remote: rejected *** bad", "{why} not scrubbed");
            assert!(!out.contains(raw), "{why} leaked");
        }
    }

    #[test]
    fn scrubs_tokens_embedded_in_a_url_and_in_json() {
        let out = scrub_tokens("https://x:ghp_secretvalue1@github.com/o/r.git");
        assert_eq!(out, "https://x:***@github.com/o/r.git");

        // Scrubbing before parsing must leave the document parseable.
        let json = r#"{"ok":false,"error":"auth failed for ghp_deadbeefcafe"}"#;
        let scrubbed = scrub_tokens(json);
        let v: Value = serde_json::from_str(&scrubbed).expect("still valid JSON");
        assert_eq!(v["error"], "auth failed for ***");
    }

    #[test]
    fn longest_prefix_wins_so_no_token_tail_survives() {
        // `github_pat_` must not be matched as `gh` + leftovers, and no residue
        // of the body may remain in the output.
        let out = scrub_tokens("github_pat_11AAAA_bbbbbbbbbb");
        assert_eq!(out, "***");
    }

    #[test]
    fn leaves_ordinary_text_and_bare_prefixes_intact() {
        // A bare prefix with no body is documentation, not a credential.
        assert_eq!(
            scrub_tokens("use a token with the ghp_ prefix"),
            "use a token with the ghp_ prefix"
        );
        assert_eq!(scrub_tokens("no secrets here"), "no secrets here");
        // Multi-byte UTF-8 must survive the char-wise copy path.
        assert_eq!(scrub_tokens("café — ok"), "café — ok");
    }

    #[test]
    fn scrubs_multiple_occurrences_in_one_blob() {
        let out = scrub_tokens("a ghp_one11111111 b github_pat_two22222 c");
        assert_eq!(out, "a *** b *** c");
    }

    /// The acknowledge path is the ONLY thing that clears `pending_reconcile`.
    /// A `backup now` without the flag commits, refuses to push, and leaves the
    /// banner up — so the flag reaching argv is the whole feature.
    #[test]
    fn backup_now_args_carry_the_acknowledge_restore_flag() {
        let args = backup_now_args(false, &[], true);
        assert!(
            args.contains(&s("--acknowledge-restore")),
            "acknowledge must reach the CLI: {args:?}"
        );
        assert_eq!(args[0], "backup");
        assert_eq!(args[1], "now");
    }

    #[test]
    fn backup_now_args_omit_the_flag_by_default() {
        let args = backup_now_args(false, &[], false);
        assert!(!args.iter().any(|a| a == "--acknowledge-restore"));
        assert_eq!(args, vec!["backup", "now", "--json"]);
    }

    #[test]
    fn backup_now_args_still_carry_no_push_and_allow_secret() {
        let args = backup_now_args(
            true,
            &[s("aaa111"), s("   "), s("bbb222")],
            true,
        );
        assert!(args.contains(&s("--no-push")));
        let i = args.iter().position(|a| a == "--allow-secret").expect("--allow-secret");
        // Blank entries are dropped, the rest are comma-joined as one argv item.
        assert_eq!(args[i + 1], "aaa111,bbb222");
        assert!(args.contains(&s("--acknowledge-restore")));
    }

    #[test]
    fn restore_args_dry_run_omits_apply_and_consent_flags() {
        let args = restore_args(
            "https://example/repo.git",
            Some("merge"),
            false,
            false,
            false,
            false,
        );
        assert_eq!(
            args,
            vec![
                "restore",
                "--from",
                "https://example/repo.git",
                "--json",
                "--mode",
                "merge"
            ]
        );
        assert!(!args.iter().any(|a| a == "--apply"));
    }

    /// hub.py's `p_restore` takes the snapshot as `--from`, with NO positional.
    /// Passing it bare makes argparse exit 2 with "unrecognized arguments", so
    /// every restore from the app would fail — pin the option form.
    #[test]
    fn restore_args_passes_the_source_as_the_from_option_never_a_positional() {
        let args = restore_args("/snap", None, false, false, false, false);
        let from = args.iter().position(|a| a == "--from").expect("--from");
        assert_eq!(args[from + 1], "/snap");
        // The first arg is the subcommand; nothing else may be positional.
        assert_eq!(args[0], "restore");
        assert!(!args[1..].iter().any(|a| a == "/snap" && a != &args[from + 1]));
    }

    #[test]
    fn restore_args_apply_carries_consent_flags() {
        let args = restore_args("/snap", Some("replace"), true, true, true, true);
        assert!(args.contains(&s("--apply")));
        assert!(args.contains(&s("--accept-executable-state")));
        assert!(args.contains(&s("--trust-new-key")));
        assert!(args.contains(&s("--force")));
        assert!(args.contains(&s("replace")));
    }

    /// The TOFU consent is not optional plumbing: the CLI's interactive prompt
    /// is skipped for `--json`, so without the flag an apply of an unverified
    /// snapshot refuses no matter what the user ticked in the UI.
    #[test]
    fn restore_args_omits_trust_new_key_unless_consented() {
        let args = restore_args("/snap", None, true, true, false, false);
        assert!(!args.iter().any(|a| a == "--trust-new-key"));
    }

    #[test]
    fn restore_args_omits_blank_mode() {
        let args = restore_args("/snap", Some("   "), false, false, false, false);
        assert!(!args.iter().any(|a| a == "--mode"));
    }
}
