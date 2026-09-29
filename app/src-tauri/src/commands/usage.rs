use super::{code_home, data_home, usage_enrich};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CCUSAGE_ARGS: [&str; 5] = [
    "--sections",
    "daily,weekly,monthly,session",
    "--by-agent",
    "--json",
    // Local-only: ccusage's default run makes a live outbound HTTPS call to fetch
    // LiteLLM pricing data (raw.githubusercontent.com/BerriAI/litellm/...). The app's
    // privacy copy promises this runs locally with nothing uploaded, so we force
    // ccusage's embedded pricing snapshot instead of hitting the network.
    "--offline",
];
const SCAN_TIMEOUT: Duration = Duration::from_secs(30);
/// Timeout for the post-scan `hub usage record --from-cache` hook. Sits well under
/// `SCAN_TIMEOUT` — the ledger merge is a small local write, and the user has already
/// waited out the scan itself by the time this runs.
const RECORD_TIMEOUT: Duration = Duration::from_secs(20);
/// Second, narrower ccusage invocation used ONLY to enrich claude sessions with a
/// project path — the unified `--sections ... --by-agent` scan never includes one for
/// claude (or codex; codex has no equivalent field at all). This is a claude-specific
/// subcommand, not part of the unified report. `--offline` for the same local-only
/// reason as CCUSAGE_ARGS. Enrichment failure of any kind must NEVER fail the overall
/// scan — see `fetch_claude_project_paths`.
const CLAUDE_PROJECT_ARGS: [&str; 4] = ["claude", "session", "--json", "--offline"];
const CLAUDE_PROJECT_TIMEOUT: Duration = Duration::from_secs(15);
const DIAGNOSTIC_LIMIT: usize = 4_000;
const CACHE_REL_PATH: [&str; 2] = ["usage", "latest-ccusage.json"];
/// Cap on captured ccusage stdout/stderr. A corrupted or pathologically large local
/// log must not be read into unbounded memory. A well-behaved ccusage `--json` run is
/// orders of magnitude under this.
const MAX_CAPTURE_BYTES: u64 = 25 * 1024 * 1024;
/// `code_home()`-relative name of the checked-in ccusage price-override config
/// (`ccusage-pricing.json` at the repo root, shipped into `Resources/hub/` by
/// `tauri.conf.json`'s `bundle.resources`). See `pricing_config_path`.
const PRICING_CONFIG_FILE: &str = "ccusage-pricing.json";
/// Timeout for the `ccusage --version` probe behind `usage_pricing_info`. Small
/// and local — never a network call.
const VERSION_TIMEOUT: Duration = Duration::from_secs(2);

static USAGE_SCAN_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageErrorKind {
    NoUsage,
    Access,
    ProcessFailure,
    Timeout,
    ParseFailure,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UsageDiagnostic {
    pub kind: UsageErrorKind,
    pub message: String,
    pub detail: Option<String>,
    pub source: Option<UsageSource>,
    pub exit_code: Option<i32>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UsageSource {
    pub command: String,
    pub args: Vec<String>,
    pub resolved_from: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageScan {
    pub scanned_at: u64,
    pub source: UsageSource,
    pub raw: String,
    pub parsed: Value,
    /// `Some(msg)` when `hub usage record --from-cache` (run after a successful cache
    /// write) did not update the durable usage ledger for this scan — never fatal to
    /// the scan itself. `redact_scan_for_cache` always sets this back to `None`: the
    /// note describes one live scan and must never land in the on-disk cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ledger_note: Option<String>,
}

/// One model's price-override row, USD per token. An absent field in the
/// source config is reported as `0.0`, never omitted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsagePriceOverride {
    pub model: String,
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
}

/// The transparency source behind the Usage screen's pricing panel: what
/// ccusage version ran, whether the last scan fetched live prices or used the
/// bundled offline snapshot, and the checked-in price overrides (if any).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsagePricingInfo {
    pub ccusage_version: Option<String>,
    pub offline: bool,
    pub overrides_path: Option<String>,
    pub overrides: Vec<UsagePriceOverride>,
}

#[derive(Debug)]
struct CommandOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[tauri::command]
pub async fn usage_scan_ccusage(
    online_pricing: Option<bool>,
) -> Result<UsageScan, UsageDiagnostic> {
    tauri::async_runtime::spawn_blocking(move || usage_scan_ccusage_impl(online_pricing))
        .await
        .map_err(|e| {
            diagnostic(
                UsageErrorKind::ProcessFailure,
                "The usage scan could not start.",
                Some(format!("usage_scan_ccusage task failed: {e}")),
                None,
                None,
                None,
                None,
            )
        })?
}

#[tauri::command]
pub async fn usage_pricing_info() -> Result<UsagePricingInfo, UsageDiagnostic> {
    tauri::async_runtime::spawn_blocking(usage_pricing_info_impl)
        .await
        .map_err(|e| {
            diagnostic(
                UsageErrorKind::ProcessFailure,
                "Skill Tree could not read the ccusage pricing configuration.",
                Some(format!("usage_pricing_info task failed: {e}")),
                None,
                None,
                None,
                None,
            )
        })?
}

#[tauri::command]
pub async fn usage_load_latest_ccusage() -> Result<Option<UsageScan>, UsageDiagnostic> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = data_home().map_err(|e| {
            diagnostic(
                UsageErrorKind::Access,
                "Skill Tree could not open its data folder.",
                Some(e),
                None,
                None,
                None,
                None,
            )
        })?;
        read_latest_cache_in(&home)
    })
    .await
    .map_err(|e| {
        diagnostic(
            UsageErrorKind::ProcessFailure,
            "The cached usage scan could not be loaded.",
            Some(format!("usage_load_latest_ccusage task failed: {e}")),
            None,
            None,
            None,
            None,
        )
    })?
}

fn usage_scan_ccusage_impl(online_pricing: Option<bool>) -> Result<UsageScan, UsageDiagnostic> {
    // Poison-safe: if a prior scan panicked mid-hold, recover the guard instead of
    // wedging the feature for the rest of the process lifetime.
    let _guard = USAGE_SCAN_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let resolved = resolve_ccusage_binary().map_err(|e| {
        diagnostic(
            UsageErrorKind::ProcessFailure,
            "Skill Tree could not find the bundled ccusage runner.",
            Some(e),
            None,
            None,
            None,
            None,
        )
    })?;

    // Never fail the scan over the pricing file — a missing/unreadable
    // `ccusage-pricing.json` just means new models keep pricing at $0, same
    // as before this file existed.
    let online = online_pricing.unwrap_or(false);
    let code_home_result = code_home();
    let config_path = code_home_result
        .as_ref()
        .ok()
        .and_then(|home| pricing_config_path(home));
    if config_path.is_none() {
        let where_ = match &code_home_result {
            Ok(home) => home.join(PRICING_CONFIG_FILE).display().to_string(),
            Err(e) => format!("<code_home unresolved: {e}>"),
        };
        eprintln!("usage: no {PRICING_CONFIG_FILE} at {where_}; new models may price at $0");
    }
    let args = scan_args(config_path.as_deref(), online);
    let mut source = resolved.source.clone();
    source.args = args.clone();

    let output = run_ccusage(&resolved.command, &args, SCAN_TIMEOUT, &source)?;
    parse_scan_output(output, source.clone(), now_unix_seconds()).and_then(|mut scan| {
        // Best-effort enrichment: attach claude project paths the unified scan omits.
        // Any failure returns None and leaves the scan exactly as it was — enrichment
        // must never turn a working scan into a failed one.
        let claude_paths =
            fetch_claude_project_paths(&resolved.command, &source).unwrap_or_default();
        if !claude_paths.is_empty() {
            enrich_claude_project_paths(&mut scan.parsed, &claude_paths);
        }

        // Best-effort session enrichment: title, branch, PR link, tool calls,
        // lines changed, hub project. Never fails the scan — any internal
        // failure just leaves a row's metadata exactly as it was (see
        // usage_enrich). Skipped entirely (not fatal) if data_home() itself
        // can't be resolved yet — the cache write right below will surface
        // that as a real error anyway.
        if let Ok(home_for_enrich) = data_home() {
            let projects = usage_enrich::registry_projects(&home_for_enrich);
            let roots = usage_enrich::default_roots();
            usage_enrich::enrich_sessions(&mut scan.parsed, &roots, &projects, &claude_paths);
        }

        let home = data_home().map_err(|e| {
            diagnostic(
                UsageErrorKind::Access,
                "Skill Tree could not open its data folder to cache the scan.",
                Some(e),
                Some(source.clone()),
                None,
                None,
                None,
            )
        })?;
        write_latest_cache_in(&home, &scan)?;
        // Best-effort: fold the scan into the durable usage ledger. Only reachable
        // once the cache write above has already succeeded, and a failure here is
        // reported on the scan (`ledger_note`), never turned into an error.
        scan.ledger_note = record_usage_history();
        Ok(scan)
    })
}

/// Best-effort: run `ccusage claude session --json --offline` and build a
/// sessionId -> projectPath map. Returns `None` on ANY failure (spawn error, timeout,
/// non-UTF8, invalid JSON, unexpected shape) — this is enrichment, not a required part
/// of the scan, and must never turn a working scan into a failed one.
fn fetch_claude_project_paths(
    command: &Path,
    source: &UsageSource,
) -> Option<HashMap<String, String>> {
    let claude_project_args: Vec<String> =
        CLAUDE_PROJECT_ARGS.iter().map(|s| s.to_string()).collect();
    let output = run_ccusage(
        command,
        &claude_project_args,
        CLAUDE_PROJECT_TIMEOUT,
        source,
    )
    .ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    let parsed: Value = serde_json::from_str(text.trim()).ok()?;
    let sessions = parsed.get("sessions")?.as_array()?;
    let mut map = HashMap::new();
    for row in sessions {
        let id = row.get("sessionId").and_then(Value::as_str);
        let path = row.get("projectPath").and_then(Value::as_str);
        if let (Some(id), Some(path)) = (id, path) {
            if !path.is_empty() {
                map.insert(id.to_string(), path.to_string());
            }
        }
    }
    Some(map)
}

/// Claude Code's on-disk project-dir naming is USUALLY a single leading dash, no
/// trailing dash (e.g. `-Users-x-y`). Some real sessions (verified: nested/subagent
/// working directories) instead report a MIXED value that keeps literal `/` segments
/// after the dash-encoded prefix (e.g. `-Users-x--y/uuid/subagents/z`). Only the
/// clean, dash-only shape can be losslessly re-wrapped into the double-dash shape the
/// frontend decoder expects — a mixed value would both (a) fail to decode on the
/// frontend anyway (the decoder's regex requires no embedded `/`) and, more
/// importantly, (b) risk carrying a literal, redaction-evading real path into the
/// disk cache (see `looks_like_malformed_encoded_key`). So: return `None` for
/// anything containing `/` or `\` and simply skip enrichment for that row — it falls
/// back to "Local project" in the UI, the same graceful degradation as a join-miss,
/// rather than injecting a value we can't safely encode or decode.
fn normalize_claude_project_key(raw: &str) -> Option<String> {
    if raw.contains('/') || raw.contains('\\') {
        return None;
    }
    let inner = raw.trim().trim_start_matches('-');
    if inner.is_empty() {
        return None;
    }
    Some(format!("--{inner}--"))
}

/// Mutates `parsed.session[]` in place: for every row with `agent == "claude"` whose
/// `period` (the claude session UUID in the unified report) has a match in `paths`,
/// set `row.metadata.projectPath` to the normalized encoded key. Rows with no match,
/// OR whose raw value can't be safely normalized (see `normalize_claude_project_key`),
/// are left untouched (they keep falling back to "Local project" in the UI, same as
/// before this fix — not a regression, just no enrichment for that row).
fn enrich_claude_project_paths(parsed: &mut Value, paths: &HashMap<String, String>) {
    let Some(sessions) = parsed.get_mut("session").and_then(Value::as_array_mut) else {
        return;
    };
    for row in sessions {
        let is_claude = row.get("agent").and_then(Value::as_str) == Some("claude");
        if !is_claude {
            continue;
        }
        let Some(period) = row
            .get("period")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        let Some(raw_path) = paths.get(&period) else {
            continue;
        };
        let Some(normalized) = normalize_claude_project_key(raw_path) else {
            continue;
        };
        let Some(obj) = row.as_object_mut() else {
            continue;
        };
        let metadata = obj
            .entry("metadata")
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if let Some(meta) = metadata.as_object_mut() {
            meta.insert("projectPath".to_string(), Value::String(normalized));
        }
    }
}

fn fixed_ccusage_args() -> Vec<String> {
    CCUSAGE_ARGS.iter().map(|arg| (*arg).to_string()).collect()
}

/// `<code_home>/ccusage-pricing.json` when it exists on disk, else `None`.
/// Pure over its argument so it is unit-testable against a tmp dir. Never
/// panics, never touches the filesystem beyond one `exists()` check.
fn pricing_config_path(code_home: &Path) -> Option<PathBuf> {
    let path = code_home.join(PRICING_CONFIG_FILE);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

/// The ccusage scan args for one invocation: the fixed report shape, `--offline`
/// unless `online` is true (Addendum A3 — a caller opting into a live LiteLLM
/// price refresh), and `--config <path>` when a pricing-override file was
/// found. `scan_args(None, false)` is byte-identical to the historical
/// `fixed_ccusage_args()`/`CCUSAGE_ARGS` shape.
fn scan_args(config: Option<&Path>, online: bool) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--sections".to_string(),
        "daily,weekly,monthly,session".to_string(),
        "--by-agent".to_string(),
        "--json".to_string(),
    ];
    if !online {
        // Local-only: ccusage's default run makes a live outbound HTTPS call to
        // fetch LiteLLM pricing data. The app's privacy copy promises this runs
        // locally with nothing uploaded, so --offline is the default and is
        // only omitted when the caller explicitly opts into online_pricing.
        //
        // TODO(track-B, REVIEW-A #7): no caller passes online_pricing: true
        // yet, but once the UI toggle lands, an `online == true` run makes
        // two shipped privacy statements conditionally false and BOTH must
        // become conditional on the toggle's state:
        //   - app/src/screens/usage/usageFormat.ts:4 ("never a network rate
        //     lookup (the app promises no network calls here)")
        //   - app/src/screens/LocalAgentUsage.tsx:194 (the "Runs locally ·
        //     No raw prompts uploaded" StatusBadge)
        args.push("--offline".to_string());
    }
    if let Some(path) = config {
        args.push("--config".to_string());
        args.push(path.to_string_lossy().into_owned());
    }
    args
}

/// Read-only: parse `defaults.pricingOverrides` out of `path`, sorted by model
/// name. Any read/parse/shape failure returns an empty list rather than
/// erroring — `usage_pricing_info` degrades to "no overrides known", it never
/// fails the whole command over a malformed config file.
fn parse_pricing_overrides(path: &Path) -> Vec<UsagePriceOverride> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return Vec::new();
    };
    let Some(overrides) = value
        .get("defaults")
        .and_then(|d| d.get("pricingOverrides"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let mut rows: Vec<UsagePriceOverride> = overrides
        .iter()
        .map(|(model, spec)| UsagePriceOverride {
            model: model.clone(),
            input: spec
                .get("inputCostPerToken")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            output: spec
                .get("outputCostPerToken")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            cache_write: spec
                .get("cacheCreationInputTokenCost")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            cache_read: spec
                .get("cacheReadInputTokenCost")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
        })
        .collect();
    rows.sort_by(|a, b| a.model.cmp(&b.model));
    rows
}

/// `true` unless the last cached scan's own `source.args` show it ran WITHOUT
/// `--offline` (an online-pricing scan). A missing cache, or any error reading
/// it, defaults to `true` — the safe assumption is "offline", since that is
/// what every scan runs unless a caller explicitly opts in.
fn offline_from_cache(home: &Path) -> bool {
    match read_latest_cache_in(home) {
        Ok(Some(scan)) => scan.source.args.iter().any(|a| a == "--offline"),
        _ => true,
    }
}

/// Best-effort `ccusage --version`, trimmed. `None` on any failure (spawn
/// error, timeout, non-zero exit, non-UTF8, empty output) — this is a
/// transparency nicety, never load-bearing.
fn ccusage_version_string(command: &Path) -> Option<String> {
    let mut child = Command::new(command)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let stderr = child.stderr.take()?;
    let stdout_handle = std::thread::spawn(move || capture_bounded(stdout, MAX_CAPTURE_BYTES));
    let stderr_handle = std::thread::spawn(move || capture_bounded(stderr, MAX_CAPTURE_BYTES));
    let status = match wait_with_timeout(&mut child, VERSION_TIMEOUT) {
        Ok(Some(status)) => status,
        _ => {
            let _ = stdout_handle.join();
            let _ = stderr_handle.join();
            return None;
        }
    };
    let stdout_bytes = stdout_handle.join().unwrap_or_default();
    let _ = stderr_handle.join();
    if !status.success() {
        return None;
    }
    let text = String::from_utf8(stdout_bytes).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn usage_pricing_info_impl() -> Result<UsagePricingInfo, UsageDiagnostic> {
    let ccusage_version = resolve_ccusage_binary()
        .ok()
        .and_then(|resolved| ccusage_version_string(&resolved.command));

    let offline = data_home()
        .ok()
        .map(|home| offline_from_cache(&home))
        .unwrap_or(true);

    let config_path = code_home().ok().and_then(|home| pricing_config_path(&home));
    let overrides = config_path
        .as_deref()
        .map(parse_pricing_overrides)
        .unwrap_or_default();
    let overrides_path = config_path.map(|p| p.to_string_lossy().into_owned());

    Ok(UsagePricingInfo {
        ccusage_version,
        offline,
        overrides_path,
        overrides,
    })
}

#[derive(Debug)]
struct ResolvedCcusage {
    command: PathBuf,
    source: UsageSource,
}

/// Resolve the ccusage runner, FAILING CLOSED. Dev repo locations
/// (`node_modules/.bin`) are tried first, then packaged Resources locations
/// (`Resources/ccusage/bin`). There is deliberately NO bare-`$PATH` fallback: an
/// unqualified `ccusage` lookup would let any binary of that name earlier on `$PATH`
/// be executed (a binary-planting risk), so when no known location exists we return
/// an Err that the caller maps to a `ProcessFailure` diagnostic.
fn resolve_ccusage_binary() -> Result<ResolvedCcusage, String> {
    select_first_existing(ccusage_candidates(repo_roots(), packaged_roots()))
}

/// Ordered `(path, source-label)` candidate list — dev repo first, then packaged.
/// Pure over its roots so the "nothing found" branch is unit-testable against a
/// scratch dir with no real interpreter/env dependencies.
fn ccusage_candidates(
    repo_roots: Vec<PathBuf>,
    packaged_roots: Vec<PathBuf>,
) -> Vec<(PathBuf, &'static str)> {
    ccusage_candidates_named(repo_roots, packaged_roots, path_binary_names())
}

/// `ccusage_candidates` with the executable-name set injected, so the Windows
/// name ordering is unit-testable from a macOS/Linux test run.
///
/// Location dominates extension: every name is probed inside one directory
/// before moving to the next directory.
fn ccusage_candidates_named(
    repo_roots: Vec<PathBuf>,
    packaged_roots: Vec<PathBuf>,
    names: &[&'static str],
) -> Vec<(PathBuf, &'static str)> {
    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();
    for app in repo_roots {
        let bin = app.join("node_modules").join(".bin");
        for name in names {
            candidates.push((bin.join(name), "repo_node_modules"));
        }
    }
    for root in packaged_roots {
        for dir in [
            root.join("ccusage").join("bin"),
            root.join("ccusage"),
            root.join("node_modules").join(".bin"),
            root.join("app").join("node_modules").join(".bin"),
        ] {
            for name in names {
                candidates.push((dir.join(name), "packaged_resource"));
            }
        }
    }
    candidates
}

/// Return the first candidate path that exists on disk, or an Err naming the two
/// location classes searched. Never falls back to a bare-`$PATH` name.
fn select_first_existing(
    candidates: Vec<(PathBuf, &'static str)>,
) -> Result<ResolvedCcusage, String> {
    for (path, from) in candidates {
        if path.exists() {
            return Ok(resolved(path, from));
        }
    }
    Err("Could not locate the bundled ccusage runner in any dev \
         (node_modules/.bin) or packaged (Resources/ccusage/bin) location. \
         Reinstall Skill Tree, or run `npm install` in app/ for a dev build."
        .to_string())
}

fn repo_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        if let Some(parent) = PathBuf::from(&manifest).parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(code) = code_home() {
        roots.push(code.join("app"));
    }
    roots
}

fn packaged_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        // macOS .app layout: Contents/MacOS/<exe> → Contents/Resources.
        if let Some(contents) = exe.parent().and_then(|macos| macos.parent()) {
            roots.push(contents.join("Resources"));
        }
    }
    if let Ok(code) = code_home() {
        if let Some(resources) = code.parent() {
            roots.push(resources.to_path_buf());
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        // Windows (NSIS/MSI) layout: resources are installed flat beside the
        // exe, so the exe's own directory IS the resource root. Appended last so
        // the macOS ordering above is untouched (the extra candidates simply
        // never exist there, and `select_first_existing` short-circuits).
        if let Some(exe_dir) = exe.parent() {
            roots.push(exe_dir.to_path_buf());
        }
    }
    roots
}

fn resolved(command: PathBuf, resolved_from: &str) -> ResolvedCcusage {
    ResolvedCcusage {
        source: UsageSource {
            command: command.to_string_lossy().into_owned(),
            args: fixed_ccusage_args(),
            resolved_from: resolved_from.to_string(),
        },
        command,
    }
}

/// Executable file names to probe, in priority order, for the host platform.
fn path_binary_names() -> &'static [&'static str] {
    binary_names_for(cfg!(windows))
}

/// Platform-parameterised so the Windows ordering is testable off Windows.
///
/// On Windows a `ccusage` runner can land under three different names and all
/// three must be probed:
///   * `ccusage.exe` — the native single-file binary `scripts/stage-ccusage.sh`
///     downloads; this is what the packaged Windows bundle actually ships.
///   * `ccusage.cmd` — the npm bin shim written into `node_modules/.bin` by a
///     dev-machine `npm install`.
///   * `ccusage`     — the extension-less copy the Windows CI build also stages
///     so `tauri.conf.json`'s non-glob macOS resource entry still resolves.
///
/// Ordered most-native first: an `.exe` is directly executable by
/// `std::process::Command`, whereas an extension-less shim is not.
fn binary_names_for(windows: bool) -> &'static [&'static str] {
    if windows {
        &["ccusage.exe", "ccusage.cmd", "ccusage"]
    } else {
        &["ccusage"]
    }
}

/// Read at most `cap` bytes from `reader` into a fresh buffer. Bounds capture so a
/// corrupted/huge local log can't drive unbounded memory growth; a normal ccusage
/// run stays far under the cap and is unaffected.
pub(crate) fn capture_bounded(reader: impl Read, cap: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    let _ = reader.take(cap).read_to_end(&mut buf);
    buf
}

/// Poll `child` with `try_wait` until it exits or `timeout` elapses.
/// `Ok(Some(status))` is a normal exit; `Ok(None)` means the timeout was hit;
/// `Err(e)` is the rare case `try_wait` itself errors — DISTINCT from a
/// timeout (W7: the two used to collapse into the same `None`, which made
/// `run_ccusage` misreport an OS-level wait failure as `UsageErrorKind::Timeout`
/// instead of `ProcessFailure`). Every branch kills and reaps the child
/// before returning, so a caller never has to worry about a still-running
/// process. Shared by `run_ccusage` and `record_usage_history` so both time
/// out and fail the same way.
pub(crate) fn wait_with_timeout(
    child: &mut Child,
    timeout: Duration,
) -> Result<Option<ExitStatus>, std::io::Error> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(Some(status)),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(None);
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        }
    }
}

/// Pure classification of a `wait_with_timeout` `Err` into the same
/// `ProcessFailure` diagnostic `run_ccusage` reported at 7deb8ad (W7) — split
/// out so the mapping is unit-testable without forcing a real OS-level
/// `try_wait` failure, which is impractical to simulate in a test.
fn wait_failure_diagnostic(
    e: &std::io::Error,
    source: &UsageSource,
    stdout: &[u8],
    stderr: &[u8],
) -> UsageDiagnostic {
    diagnostic(
        UsageErrorKind::ProcessFailure,
        "Skill Tree could not complete the usage scan.",
        Some(e.to_string()),
        Some(source.clone()),
        None,
        Some(stdout),
        Some(stderr),
    )
}

fn run_ccusage(
    command: &Path,
    args: &[String],
    timeout: Duration,
    source: &UsageSource,
) -> Result<CommandOutput, UsageDiagnostic> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            let kind = if e.kind() == std::io::ErrorKind::PermissionDenied {
                UsageErrorKind::Access
            } else {
                UsageErrorKind::ProcessFailure
            };
            diagnostic(
                kind,
                "Skill Tree could not run ccusage.",
                Some(e.to_string()),
                Some(source.clone()),
                None,
                None,
                None,
            )
        })?;

    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let stdout_handle = std::thread::spawn(move || capture_bounded(stdout, MAX_CAPTURE_BYTES));
    let stderr_handle = std::thread::spawn(move || capture_bounded(stderr, MAX_CAPTURE_BYTES));

    let status = match wait_with_timeout(&mut child, timeout) {
        Ok(Some(status)) => status,
        Ok(None) => {
            let stdout = stdout_handle.join().unwrap_or_default();
            let stderr = stderr_handle.join().unwrap_or_default();
            return Err(diagnostic(
                UsageErrorKind::Timeout,
                "The usage scan took too long and was stopped.",
                Some(format!("Timed out after {} seconds.", timeout.as_secs())),
                Some(source.clone()),
                None,
                Some(&stdout),
                Some(&stderr),
            ));
        }
        Err(e) => {
            // W7: an OS-level `try_wait` error is a process failure, not a
            // timeout — restores the exact classification `run_ccusage` gave
            // at 7deb8ad, now via the shared, unit-tested mapping.
            let stdout = stdout_handle.join().unwrap_or_default();
            let stderr = stderr_handle.join().unwrap_or_default();
            return Err(wait_failure_diagnostic(&e, source, &stdout, &stderr));
        }
    };

    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();
    if !status.success() {
        let kind = classify_failed_process(&stdout, &stderr);
        return Err(diagnostic(
            kind,
            "ccusage could not read local usage data.",
            None,
            Some(source.clone()),
            status.code(),
            Some(&stdout),
            Some(&stderr),
        ));
    }

    Ok(CommandOutput {
        status,
        stdout,
        stderr,
    })
}

/// Best-effort post-scan hook: fold the just-cached scan into the durable usage
/// ledger via `hub usage record --from-cache --json`. Called only after
/// `write_latest_cache_in` has already succeeded, so the cache the CLI reads is
/// current. Reads the cache from disk (not stdin) — the redacted on-disk copy is
/// already privacy-safe, while the live in-memory scan still carries real project
/// paths. `Some(msg)` describes why the ledger was NOT updated; `None` means it was.
/// Must NEVER return `Err` or panic — a ledger failure must never fail the scan
/// the user is waiting on.
fn record_usage_history() -> Option<String> {
    let mut cmd = match super::hub_command(["usage", "record", "--from-cache", "--json"]) {
        Ok(cmd) => cmd,
        Err(e) => return classify_record_outcome(None, false, Some(e)),
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return classify_record_outcome(None, false, Some(e.to_string())),
    };

    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let stdout_handle = std::thread::spawn(move || capture_bounded(stdout, MAX_CAPTURE_BYTES));
    let stderr_handle = std::thread::spawn(move || capture_bounded(stderr, MAX_CAPTURE_BYTES));

    match wait_with_timeout(&mut child, RECORD_TIMEOUT) {
        Ok(None) => {
            let _ = stdout_handle.join();
            let _ = stderr_handle.join();
            classify_record_outcome(None, true, None)
        }
        Ok(Some(status)) => {
            let stdout = stdout_handle.join().unwrap_or_default();
            let stderr = stderr_handle.join().unwrap_or_default();
            classify_record_outcome(
                Some(Output {
                    status,
                    stdout,
                    stderr,
                }),
                false,
                None,
            )
        }
        Err(e) => {
            // W7: keep this distinct from both a spawn error ("could not
            // start …") and a timeout — an OS-level wait failure is neither.
            let _ = stdout_handle.join();
            let _ = stderr_handle.join();
            Some(format!("could not wait for hub usage record: {e}"))
        }
    }
}

/// Pure classification of one `hub usage record` attempt into an optional
/// `ledger_note`. `spawn_err` (the process never ran) wins over everything else;
/// then `timed_out` (the process was killed by `wait_with_timeout`); otherwise
/// `output`'s exit status decides. A no-arg/empty `output` with neither flag set is
/// treated as success (`None`) — that combination never occurs from
/// `record_usage_history` itself, but a total `None` is the safe default for a
/// classifier that must never fail closed into a false alarm.
fn classify_record_outcome(
    output: Option<Output>,
    timed_out: bool,
    spawn_err: Option<String>,
) -> Option<String> {
    if let Some(e) = spawn_err {
        return Some(format!("could not start hub usage record: {e}"));
    }
    if timed_out {
        return Some(format!(
            "hub usage record timed out after {}s",
            RECORD_TIMEOUT.as_secs()
        ));
    }
    let output = output?;
    if output.status.success() {
        return None;
    }
    // W1: `hub_cli/usage.py`'s `--json` error path prints its reason as
    // stdout's ONE `{"ok": false, "error": "..."}` object — `fail()`'s prose
    // (still the shape a non-`--json` failure takes) lands on stdout too, so
    // the fallback below also covers that case. Preference order: stderr's
    // first line, else stdout's JSON `error` field, else stdout's first
    // line, else a fixed "no output".
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr_line = stderr.lines().find(|line| !line.trim().is_empty());
    let reason: std::borrow::Cow<str> = match stderr_line {
        Some(line) => line.into(),
        None => match stdout_json_error(&stdout) {
            Some(err) => err.into(),
            None => match stdout.lines().find(|line| !line.trim().is_empty()) {
                Some(line) => line.into(),
                None => "no output".into(),
            },
        },
    };
    let code = output
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    Some(format!(
        "hub usage record failed (exit {code}): {}",
        truncate(&reason, 200)
    ))
}

/// `{"ok": false, "error": "..."}` on stdout, parsed leniently — `None` for
/// anything that is not that exact shape (not JSON, not an object, no
/// string `error` field). Used only as a fallback when stderr is empty.
fn stdout_json_error(stdout: &str) -> Option<String> {
    let value: Value = serde_json::from_str(stdout.trim()).ok()?;
    value.get("error")?.as_str().map(|s| s.to_string())
}

fn parse_scan_output(
    output: CommandOutput,
    source: UsageSource,
    scanned_at: u64,
) -> Result<UsageScan, UsageDiagnostic> {
    let raw = String::from_utf8(output.stdout.clone()).map_err(|e| {
        diagnostic(
            UsageErrorKind::ParseFailure,
            "ccusage returned output that was not valid UTF-8.",
            Some(e.to_string()),
            Some(source.clone()),
            output.status.code(),
            Some(&output.stdout),
            Some(&output.stderr),
        )
    })?;
    let parsed: Value = serde_json::from_str(raw.trim()).map_err(|e| {
        diagnostic(
            UsageErrorKind::ParseFailure,
            "ccusage returned output Skill Tree could not parse.",
            Some(e.to_string()),
            Some(source.clone()),
            output.status.code(),
            Some(&output.stdout),
            Some(&output.stderr),
        )
    })?;
    if is_no_usage_payload(&parsed) {
        return Err(diagnostic(
            UsageErrorKind::NoUsage,
            "No local coding-agent usage data was found.",
            Some("ccusage completed successfully but reported no usage rows.".to_string()),
            Some(source.clone()),
            output.status.code(),
            Some(&output.stdout),
            Some(&output.stderr),
        ));
    }
    Ok(UsageScan {
        scanned_at,
        source,
        raw,
        parsed,
        ledger_note: None,
    })
}

fn classify_failed_process(stdout: &[u8], stderr: &[u8]) -> UsageErrorKind {
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout).to_lowercase(),
        String::from_utf8_lossy(stderr).to_lowercase()
    );
    if contains_no_usage_text(&text) {
        UsageErrorKind::NoUsage
    } else if contains_access_text(&text) {
        UsageErrorKind::Access
    } else {
        UsageErrorKind::ProcessFailure
    }
}

fn contains_no_usage_text(text: &str) -> bool {
    text.contains("no usage")
        || text.contains("usage data not found")
        || text.contains("no claude usage")
        || text.contains("no local usage")
}

fn contains_access_text(text: &str) -> bool {
    text.contains("permission denied")
        || text.contains("access denied")
        || text.contains("eacces")
        || text.contains("eperm")
        || text.contains("operation not permitted")
}

fn is_no_usage_payload(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    let known_sections = ["daily", "weekly", "monthly", "session"];
    let all_known_sections_empty = known_sections.iter().all(|key| {
        obj.get(*key)
            .and_then(Value::as_array)
            .map(|items| items.is_empty())
            .unwrap_or(false)
    });
    all_known_sections_empty && !has_positive_number(obj.get("totals"))
}

fn has_positive_number(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Number(n)) => n.as_f64().map(|v| v > 0.0).unwrap_or(false),
        Some(Value::Array(items)) => items.iter().any(|item| has_positive_number(Some(item))),
        Some(Value::Object(map)) => map.values().any(|item| has_positive_number(Some(item))),
        _ => false,
    }
}

fn write_latest_cache_in(home: &Path, scan: &UsageScan) -> Result<(), UsageDiagnostic> {
    let path = latest_cache_path(home);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            diagnostic(
                UsageErrorKind::Access,
                "Skill Tree could not create the usage cache folder.",
                Some(e.to_string()),
                Some(scan.source.clone()),
                None,
                None,
                None,
            )
        })?;
    }
    // Redact BEFORE serializing so no real local filesystem paths (from ccusage's
    // session/project data) ever touch disk. The live in-memory scan returned to the
    // Tauri caller is untouched — only this cache copy is sanitized.
    let redacted = redact_scan_for_cache(scan);
    let bytes = serde_json::to_vec_pretty(&redacted).map_err(|e| {
        diagnostic(
            UsageErrorKind::ParseFailure,
            "Skill Tree could not serialize the usage scan cache.",
            Some(e.to_string()),
            Some(scan.source.clone()),
            None,
            None,
            None,
        )
    })?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| {
        diagnostic(
            UsageErrorKind::Access,
            "Skill Tree could not write the usage scan cache.",
            Some(e.to_string()),
            Some(scan.source.clone()),
            None,
            None,
            None,
        )
    })?;
    fs::rename(&tmp, &path).map_err(|e| {
        diagnostic(
            UsageErrorKind::Access,
            "Skill Tree could not replace the usage scan cache.",
            Some(e.to_string()),
            Some(scan.source.clone()),
            None,
            None,
            None,
        )
    })?;
    // Lock the cache down to owner read/write only — it can hold usage data that
    // no other local account or backup sweep should read. No-op on non-unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Produce a cache-only copy of `scan`: the unused verbatim `raw` stdout is dropped
/// and every path-like string inside `parsed` is replaced with a stable, one-way
/// pseudonym. The original `scan` is never mutated.
///
/// `pub(crate)`: `usage_enrich`'s tests exercise this directly to prove the
/// fields it writes (title, hubProject, prUrl, toolCalls) survive redaction
/// while a written `projectPath` gets hashed away like any other path.
pub(crate) fn redact_scan_for_cache(scan: &UsageScan) -> UsageScan {
    UsageScan {
        scanned_at: scan.scanned_at,
        source: scan.source.clone(),
        raw: String::new(),
        parsed: redact_value(&scan.parsed),
        // The note describes one live scan (and is only ever set AFTER the cache
        // write anyway) — it must never persist to disk.
        ledger_note: None,
    }
}

/// Deep-walk a JSON value, replacing every path-like leaf string with a
/// deterministic pseudonym. Objects and arrays recurse; numbers, booleans, null,
/// and non-path-like strings pass through unchanged.
fn redact_value(value: &Value) -> Value {
    match value {
        Value::String(s) => {
            if looks_like_local_path(s)
                || looks_like_encoded_project_key(s)
                || looks_like_malformed_encoded_key(s)
            {
                Value::String(redacted_path_placeholder(s))
            } else {
                Value::String(s.clone())
            }
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_value).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), redact_value(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Mirror of the frontend `isLikelyProjectPath` heuristic
/// (`app/src/features/usage/normalizeUsage.ts`) so redacted placeholders keep the
/// same path shape the anonymizer recognizes on the next cache load.
///
/// `pub(crate)`: `usage_enrich::safe_label` vets every label it writes against
/// this same predicate, so a title or branch is never written in a shape this
/// function would later hash into a `~/redacted/<hash>` placeholder.
pub(crate) fn looks_like_local_path(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.len() < 2 {
        return false;
    }
    trimmed.starts_with('/')
        || trimmed.starts_with("~/")
        || is_windows_drive_prefixed(trimmed)
        || trimmed.contains('\\')
        || trimmed.contains("/Users/")
        || trimmed.contains("/home/")
        || trimmed.contains("/workspace/")
        || trimmed.contains("/projects/")
}

/// Mirror of the frontend `isCcusageEncodedProjectKey` regex
/// (`^--[A-Za-z0-9_.-]+--$`) — ccusage's own dash-encoded project-path shape (used by
/// both pi's native `metadata.projectPath` and this file's claude-project-path
/// enrichment). Trivially reversible to a real path, so it must be redacted before
/// the cache write exactly like a real path is.
fn looks_like_encoded_project_key(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.len() > 4
        && trimmed.starts_with("--")
        && trimmed.ends_with("--")
        && trimmed[2..trimmed.len() - 2]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// Defense-in-depth backstop for a malformed dash-encoded project key: some real
/// ccusage-reported values (verified: nested/subagent working directories) mix a
/// dash-encoded prefix with literal `/`-separated segments, e.g.
/// `-Users-ramtoi-Dev--skill-hub/uuid/subagents/workflows`. This shape matches
/// neither `looks_like_local_path` (no `/Users/`-style substring — the leading
/// segment is dash-, not slash-, encoded) nor `looks_like_encoded_project_key` (its
/// charset check rejects the embedded `/`), so without this check it would reach the
/// disk cache unredacted despite being trivially reversible to a real local path plus
/// username. `enrich_claude_project_paths` is designed to never inject such a value
/// (see `normalize_claude_project_key`), but this check stays as a backstop against
/// any other current or future source of a dash-prefixed, slash-containing string
/// landing in the parsed tree — narrowly scoped to "starts with a dash AND contains a
/// slash" so it does not catch unrelated fields like Codex's date-shaped
/// `period`/`sessionId` values (e.g. `2026/02/19/rollout-...`), which never start
/// with a dash.
fn looks_like_malformed_encoded_key(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with('-') && trimmed.contains('/')
}

/// Matches `^[A-Za-z]:[\\/]` — a Windows drive letter followed by `:` and a slash.
fn is_windows_drive_prefixed(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// One-way, deterministic placeholder for a real path. Shaped like a path
/// (`~/redacted/<hash>`) so the frontend heuristic still groups it, but the literal
/// original path never reaches disk. Same input always yields the same placeholder.
fn redacted_path_placeholder(path: &str) -> String {
    format!("~/redacted/{:016x}", fnv1a_64(path.as_bytes()))
}

/// Inline FNV-1a 64-bit hash. Deterministic across processes (unlike std's
/// seed-randomized DefaultHasher) so redaction is stable across cache writes.
fn fnv1a_64(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    let mut hash = OFFSET_BASIS;
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

fn read_latest_cache_in(home: &Path) -> Result<Option<UsageScan>, UsageDiagnostic> {
    let path = latest_cache_path(home);
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|e| {
        diagnostic(
            UsageErrorKind::Access,
            "Skill Tree could not read the cached usage scan.",
            Some(e.to_string()),
            None,
            None,
            None,
            None,
        )
    })?;
    serde_json::from_str(&content).map(Some).map_err(|e| {
        diagnostic(
            UsageErrorKind::ParseFailure,
            "The cached usage scan is not valid JSON.",
            Some(e.to_string()),
            None,
            None,
            Some(content.as_bytes()),
            None,
        )
    })
}

fn latest_cache_path(home: &Path) -> PathBuf {
    CACHE_REL_PATH
        .iter()
        .fold(home.to_path_buf(), |path, part| path.join(part))
}

fn diagnostic(
    kind: UsageErrorKind,
    message: &str,
    detail: Option<String>,
    source: Option<UsageSource>,
    exit_code: Option<i32>,
    stdout: Option<&[u8]>,
    stderr: Option<&[u8]>,
) -> UsageDiagnostic {
    UsageDiagnostic {
        kind,
        message: message.to_string(),
        detail: detail.map(|s| truncate(&s, DIAGNOSTIC_LIMIT)),
        source,
        exit_code,
        stdout: stdout.map(|b| truncate(&String::from_utf8_lossy(b), DIAGNOSTIC_LIMIT)),
        stderr: stderr.map(|b| truncate(&String::from_utf8_lossy(b), DIAGNOSTIC_LIMIT)),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests;
