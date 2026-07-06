//! Remotes — thin marshal layer over the `hub remote …` CLI. The ONLY logic
//! that lives in Rust is OS-keychain secret access (the `keyring` crate, against
//! the same macOS Keychain the Python `keyring` binding uses) — the single
//! sanctioned exception, because secret bytes must never transit the Python
//! argv/process table.
//!
//! No connector / SSH business logic lives here. Every command (including the
//! onboarding host-key fetch, the one-time key install, doc fetch/push, and the
//! health probe) forwards to a `hub remote …` subcommand; the Python transport
//! (`connectors/transport/ssh.py`) owns all ssh/ssh-keyscan/ssh-copy-id logic.
//! The TS layer owns the types. Secret bytes are NEVER round-tripped back to JS
//! except the single value the wizard just typed in (set), and are NEVER written
//! to the registry or any plaintext file (the registry stores only a `secret_ref`).

use super::agent_docs::{run_hub_json, run_hub_json_stdin};
use super::hub::{hub_cmd_impl, HubResult};
use serde_json::Value;

// ─── Off-main-thread helpers ───────────────────────────────────────────────────
// Every network-touching `remote_*` command does blocking ssh/scp I/O inside
// `hub.py`. Running it on Tauri's MAIN thread froze the whole UI (spinner cursor,
// no react-query loading state) for the op's duration. We hop the blocking call
// onto a worker thread via `tauri::async_runtime::spawn_blocking` so the command
// is `async` and the UI thread stays responsive (react-query `isLoading` shows a
// spinner). `JoinError` (e.g. a panicked worker) surfaces as a command error.

async fn json_off_thread(args: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_hub_json::<Value>(&refs)
    })
    .await
    .map_err(|e| format!("remote task failed: {e}"))?
}

async fn json_stdin_off_thread(
    args: Vec<String>,
    stdin_body: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_hub_json_stdin::<Value>(&refs, stdin_body.as_deref())
    })
    .await
    .map_err(|e| format!("remote task failed: {e}"))?
}

async fn hub_off_thread(args: Vec<String>) -> Result<HubResult, String> {
    tauri::async_runtime::spawn_blocking(move || hub_cmd_impl(args))
        .await
        .map_err(|e| format!("remote task failed: {e}"))?
}

/// Like `hub_off_thread`, but pipes `body` to hub.py's stdin. Used to hand over
/// secret material (the just-typed bearer token) without it ever appearing in
/// the process argument list.
async fn hub_off_thread_stdin(args: Vec<String>, body: String) -> Result<HubResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = super::subagents::run_hub_stdin(&refs, &body)?;
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        let combined = if stderr.is_empty() {
            stdout
        } else {
            format!("{stdout}{stderr}")
        };
        Ok(HubResult {
            success: out.status.success(),
            output: combined,
        })
    })
    .await
    .map_err(|e| format!("remote task failed: {e}"))?
}

// ─── Read-only / JSON-emitting `hub remote` commands ──────────────────────────
// These CLI subcommands support `--json` and return structured payloads. All
// of them spawn a `hub.py` subprocess, so all of them run off-thread.

#[tauri::command]
pub async fn remote_list() -> Result<Value, String> {
    json_off_thread(vec!["remote".into(), "list".into(), "--json".into()]).await
}

/// Registry-driven connector catalog: every registered connector with its
/// metadata (`key`, `label`, `description`, `transport_kind`, `publishable`,
/// `available`, `source`). Marshal-only — maps to `hub remote connectors
/// --json`; the discovery/registration logic lives entirely in Python
/// (`connectors/`). Drives the add-remote wizard's cards + transport branching.
#[tauri::command]
pub async fn remote_connectors() -> Result<Value, String> {
    json_off_thread(vec!["remote".into(), "connectors".into(), "--json".into()]).await
}

#[tauri::command]
pub async fn remote_show(id: String) -> Result<Value, String> {
    json_off_thread(vec!["remote".into(), "show".into(), id, "--json".into()]).await
}

/// Read-only plan: per-artifact drift status. Performs NO remote writes. When
/// the remote is unreachable/unpinned the CLI returns a `{reachable, ok, detail}`
/// health shape instead of an `actions` list — the UI handles both.
#[tauri::command]
pub async fn remote_diff(id: String) -> Result<Value, String> {
    json_off_thread(vec!["remote".into(), "diff".into(), id, "--json".into()]).await
}

/// Health probe → `{reachable, authenticated, host_key_match, ok, detail}` from
/// the connector's `health_check`, via the dedicated `hub remote health` CLI.
#[tauri::command]
pub async fn remote_health(id: String) -> Result<Value, String> {
    json_off_thread(vec!["remote".into(), "health".into(), id, "--json".into()]).await
}

/// List the LIVE agent docs present on the box (SOUL.md / MEMORY.md / USER.md),
/// independent of any pending diff plan, so the UI can show fetch→edit→push for
/// docs that exist on the box even when nothing is queued. Read-only; maps to
/// `hub remote list-docs <id> --json`.
#[tauri::command]
pub async fn remote_list_docs(id: String) -> Result<Value, String> {
    json_off_thread(vec!["remote".into(), "list-docs".into(), id, "--json".into()]).await
}

/// Fetch a remote agent-doc's content (SOUL.md / MEMORY.md / USER.md) so the app
/// editor loads real text. Read-only; maps to `hub remote fetch-doc`.
#[tauri::command]
pub async fn remote_fetch_doc(id: String, doc: String) -> Result<Value, String> {
    json_off_thread(vec![
        "remote".into(),
        "fetch-doc".into(),
        id,
        "--doc".into(),
        doc,
        "--json".into(),
    ])
    .await
}

/// Scan box-native skills as import candidates (read-only). Maps to
/// `hub remote import-skill --remote <id> --scan --json`.
#[tauri::command]
pub async fn remote_scan_imports(id: String) -> Result<Value, String> {
    json_off_thread(vec![
        "remote".into(),
        "import-skill".into(),
        "--remote".into(),
        id,
        "--scan".into(),
        "--json".into(),
    ])
    .await
}

// ─── Mutating `hub remote` commands (human-text output) ───────────────────────
// These print human-readable status, not JSON, so they return the raw HubResult
// `{success, output}`. The TS layer surfaces `output` in a toast and refetches.

#[tauri::command]
pub async fn remote_add(
    id: String,
    connector: Option<String>,
    ssh_host: Option<String>,
    host_key: Option<String>,
    secret_ref: Option<String>,
    // HTTPS (transport-aware onboarding): endpoint URL + bearer-token plumbing.
    // `--token-ref` names the keychain handle; the just-typed token VALUE is
    // piped to hub.py over STDIN (cmd_remote_add reads one stdin line when
    // `--token` is absent), so it never appears in the process argument list.
    // It is never persisted in UI state past submit.
    endpoint: Option<String>,
    token_ref: Option<String>,
    token: Option<String>,
    home: Option<String>,
    no_sync: bool,
    bundles: Option<Vec<String>>,
    enabled: Option<Vec<String>>,
) -> Result<HubResult, String> {
    let mut args: Vec<String> = vec!["remote".into(), "add".into(), id];
    args.push("--connector".into());
    args.push(connector.unwrap_or_else(|| "hermes".into()));
    if let Some(h) = ssh_host {
        args.push("--ssh-host".into());
        args.push(h);
    }
    if let Some(k) = host_key {
        args.push("--host-key".into());
        args.push(k);
    }
    if let Some(s) = secret_ref {
        args.push("--secret-ref".into());
        args.push(s);
    }
    if let Some(ep) = endpoint {
        args.push("--endpoint".into());
        args.push(ep);
    }
    if let Some(tr) = token_ref {
        args.push("--token-ref".into());
        args.push(tr);
    }
    // NB: the token value is intentionally NOT pushed as `--token` — it goes
    // over stdin (see hub_off_thread_stdin below) to stay out of the argv.
    if let Some(h) = home {
        args.push("--home".into());
        args.push(h);
    }
    if no_sync {
        args.push("--no-sync".into());
    }
    if let Some(b) = bundles {
        if !b.is_empty() {
            args.push("--bundles".into());
            args.push(b.join(","));
        }
    }
    if let Some(e) = enabled {
        if !e.is_empty() {
            args.push("--enabled".into());
            args.push(e.join(","));
        }
    }
    match token {
        // Token typed in the wizard: hand it over on stdin (one line), never argv.
        Some(t) => hub_off_thread_stdin(args, format!("{t}\n")).await,
        None => hub_off_thread(args).await,
    }
}

#[tauri::command]
pub async fn remote_sync(id: String, force: bool) -> Result<HubResult, String> {
    let mut args: Vec<String> = vec!["remote".into(), "sync".into(), id];
    if force {
        args.push("--force".into());
    }
    hub_off_thread(args).await
}

#[tauri::command]
pub async fn remote_resolve(
    id: String,
    artifact: String,
    op: String,
    kind: Option<String>,
) -> Result<HubResult, String> {
    let mut args: Vec<String> = vec![
        "remote".into(),
        "resolve".into(),
        id,
        "--artifact".into(),
        artifact,
        "--op".into(),
        op,
    ];
    args.push("--kind".into());
    args.push(kind.unwrap_or_else(|| "skill".into()));
    hub_off_thread(args).await
}

#[tauri::command]
pub async fn remote_disable(id: String) -> Result<HubResult, String> {
    hub_off_thread(vec!["remote".into(), "disable".into(), id]).await
}

#[tauri::command]
pub async fn remote_enable(id: String) -> Result<HubResult, String> {
    hub_off_thread(vec!["remote".into(), "enable".into(), id]).await
}

/// Toggle a remote's `apply_global_bundles` flag (D15): opt the remote in/out of
/// inheriting global-scope bundle skills. Marshals to `hub remote set-global
/// <id> on|off`. Async/off-thread to match the other registry-touching commands.
#[tauri::command]
pub async fn remote_set_apply_global(id: String, enabled: bool) -> Result<HubResult, String> {
    let state = if enabled { "on" } else { "off" };
    hub_off_thread(vec![
        "remote".into(),
        "set-global".into(),
        id,
        state.into(),
    ])
    .await
}

/// Unregister a remote: drops the registry entry + its ownership sidecars.
/// Never touches the remote box.
#[tauri::command]
pub async fn remote_remove(id: String) -> Result<HubResult, String> {
    hub_off_thread(vec!["remote".into(), "remove".into(), id]).await
}

/// Forget hub ownership of a remote's artifacts (clears sidecars only). The
/// registry entry stays; the box is untouched.
#[tauri::command]
pub async fn remote_clear(id: String) -> Result<HubResult, String> {
    hub_off_thread(vec!["remote".into(), "clear".into(), id]).await
}

#[tauri::command]
pub async fn remote_import_skill(id: String, name: String) -> Result<HubResult, String> {
    hub_off_thread(vec![
        "remote".into(),
        "import-skill".into(),
        name,
        "--remote".into(),
        id,
    ])
    .await
}

// ─── Keychain (Rust-owned per the security model) ─────────────────────────────
// `registry.yaml` stores only a `secret_ref` of the form "service:account"
// (default service "skill-hub" when no colon). Bytes live ONLY in the keychain.

const DEFAULT_SERVICE: &str = "skill-hub";

fn split_ref(secret_ref: &str) -> (String, String) {
    match secret_ref.split_once(':') {
        Some((service, account)) => {
            let service = if service.is_empty() {
                DEFAULT_SERVICE.to_string()
            } else {
                service.to_string()
            };
            (service, account.to_string())
        }
        None => (DEFAULT_SERVICE.to_string(), secret_ref.to_string()),
    }
}

/// Store `secret` under `secret_ref` in the OS keychain. The value is the only
/// secret byte-stream that crosses the JS↔Rust boundary, and only inbound (the
/// wizard just typed it). It is never echoed back, logged, or written to disk.
/// Off-thread because a Keychain access can block on a Touch ID/password
/// prompt, which would otherwise freeze the main thread.
#[tauri::command]
pub async fn remote_set_secret(secret_ref: String, secret: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remote_set_secret_impl(secret_ref, secret))
        .await
        .map_err(|e| format!("remote_set_secret task failed: {e}"))?
}

fn remote_set_secret_impl(secret_ref: String, secret: String) -> Result<(), String> {
    let (service, account) = split_ref(&secret_ref);
    let entry = keyring::Entry::new(&service, &account)
        .map_err(|e| format!("keychain unavailable (fail-closed): {e}"))?;
    entry
        .set_password(&secret)
        .map_err(|e| format!("keychain write failed for {secret_ref:?}: {e}"))
}

/// Report whether a secret exists for `secret_ref` WITHOUT returning its bytes.
/// The UI only needs to know "is a credential set?", never the value, so the
/// plaintext never leaves Rust on the read path (fail-closed on keychain error).
#[tauri::command]
pub async fn remote_has_secret(secret_ref: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || remote_has_secret_impl(secret_ref))
        .await
        .map_err(|e| format!("remote_has_secret task failed: {e}"))?
}

fn remote_has_secret_impl(secret_ref: String) -> Result<bool, String> {
    let (service, account) = split_ref(&secret_ref);
    let entry = keyring::Entry::new(&service, &account)
        .map_err(|e| format!("keychain unavailable (fail-closed): {e}"))?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("keychain read failed for {secret_ref:?}: {e}")),
    }
}

/// Delete a stored secret (used by remove/clear flows). No-op if absent.
#[tauri::command]
pub async fn remote_delete_secret(secret_ref: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remote_delete_secret_impl(secret_ref))
        .await
        .map_err(|e| format!("remote_delete_secret task failed: {e}"))?
}

fn remote_delete_secret_impl(secret_ref: String) -> Result<(), String> {
    let (service, account) = split_ref(&secret_ref);
    let entry = keyring::Entry::new(&service, &account)
        .map_err(|e| format!("keychain unavailable (fail-closed): {e}"))?;
    match entry.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed for {secret_ref:?}: {e}")),
    }
}

/// Push an edited agent-doc back to the box. Content goes over stdin (never
/// argv) to `hub remote push-doc`, which writes atomically + backup-on-change
/// and refuses on remote drift unless `force`. Drift-checking + the ssh write
/// are entirely Python-side.
#[tauri::command]
pub async fn remote_push_doc(
    id: String,
    doc: String,
    content: String,
    force: bool,
) -> Result<Value, String> {
    let mut args: Vec<String> =
        vec!["remote".into(), "push-doc".into(), id, "--doc".into(), doc, "--json".into()];
    if force {
        args.push("--force".into());
    }
    json_stdin_off_thread(args, Some(content)).await
}

// ─── SSH onboarding — marshalled to `hub remote …` (NO OS-tool spawns) ────────
// The wizard's host-key fetch + one-time key install now route through dedicated
// CLI subcommands so the canonical ssh/ssh-keyscan/ssh-copy-id logic lives ONLY
// in connectors/transport/ssh.py (CLAUDE.md: Rust marshals, no business logic).

/// Fetch the live SHA256 host-key fingerprint for an ssh-host (TOFU confirm).
/// Accepts a raw host (no registry entry yet) → `hub remote keyscan`. Returns
/// `{ssh_host, fingerprint, detail}`.
#[tauri::command]
pub async fn remote_fetch_host_key(host: String) -> Result<Value, String> {
    json_off_thread(vec!["remote".into(), "keyscan".into(), host, "--json".into()]).await
}

/// One-time key install → `hub remote setup-key`, which runs `ssh-copy-id` and,
/// on failure, prints the exact root-side fallback. Pass a registered remote
/// `id` OR a raw `ssh_host` (the wizard installs the key before registration).
/// Driven ONLY from the wizard credentials step AFTER an explicit user confirm
/// (D3 — the single intentional box write).
#[tauri::command]
pub async fn remote_setup_key(
    id: Option<String>,
    ssh_host: Option<String>,
) -> Result<HubResult, String> {
    let mut args: Vec<String> = vec!["remote".into(), "setup-key".into()];
    if let Some(host) = ssh_host {
        args.push("--ssh-host".into());
        args.push(host);
    } else if let Some(rid) = id {
        args.push(rid);
    } else {
        return Err("remote_setup_key requires an id or ssh_host".into());
    }
    hub_off_thread(args).await
}

/// Remote doctor: host-key drift, stale sidecars, unreachable sync_enabled
/// remotes, unresolved drift/conflict. Maps to `hub remote doctor --json`.
#[tauri::command]
pub async fn remote_doctor() -> Result<Value, String> {
    json_off_thread(vec!["remote".into(), "doctor".into(), "--json".into()]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_ref_parses_service_and_account() {
        assert_eq!(
            split_ref("skill-hub:hermes-main"),
            ("skill-hub".into(), "hermes-main".into())
        );
    }

    #[test]
    fn split_ref_defaults_service_without_colon() {
        assert_eq!(
            split_ref("hermes-main"),
            ("skill-hub".into(), "hermes-main".into())
        );
    }

    #[test]
    fn split_ref_empty_service_falls_back_to_default() {
        assert_eq!(
            split_ref(":hermes-main"),
            ("skill-hub".into(), "hermes-main".into())
        );
    }
}
