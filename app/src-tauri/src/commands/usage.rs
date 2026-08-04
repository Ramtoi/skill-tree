use super::{code_home, data_home};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
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
}

#[derive(Debug)]
struct CommandOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[tauri::command]
pub async fn usage_scan_ccusage() -> Result<UsageScan, UsageDiagnostic> {
    tauri::async_runtime::spawn_blocking(usage_scan_ccusage_impl)
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

fn usage_scan_ccusage_impl() -> Result<UsageScan, UsageDiagnostic> {
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

    let output = run_ccusage(&resolved.command, &CCUSAGE_ARGS, SCAN_TIMEOUT, &resolved.source)?;
    parse_scan_output(output, resolved.source.clone(), now_unix_seconds()).and_then(|mut scan| {
        // Best-effort enrichment: attach claude project paths the unified scan omits.
        // Any failure returns None and leaves the scan exactly as it was — enrichment
        // must never turn a working scan into a failed one.
        if let Some(paths) = fetch_claude_project_paths(&resolved.command, &resolved.source) {
            enrich_claude_project_paths(&mut scan.parsed, &paths);
        }
        let home = data_home().map_err(|e| {
            diagnostic(
                UsageErrorKind::Access,
                "Skill Tree could not open its data folder to cache the scan.",
                Some(e),
                Some(resolved.source.clone()),
                None,
                None,
                None,
            )
        })?;
        write_latest_cache_in(&home, &scan)?;
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
    let output = run_ccusage(command, &CLAUDE_PROJECT_ARGS, CLAUDE_PROJECT_TIMEOUT, source).ok()?;
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
        let Some(period) = row.get("period").and_then(Value::as_str).map(str::to_string) else {
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
fn capture_bounded(reader: impl Read, cap: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    let _ = reader.take(cap).read_to_end(&mut buf);
    buf
}

fn run_ccusage(
    command: &Path,
    args: &[&str],
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
    let stdout_handle =
        std::thread::spawn(move || capture_bounded(stdout, MAX_CAPTURE_BYTES));
    let stderr_handle =
        std::thread::spawn(move || capture_bounded(stderr, MAX_CAPTURE_BYTES));

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
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
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => {
                let _ = child.kill();
                let stdout = stdout_handle.join().unwrap_or_default();
                let stderr = stderr_handle.join().unwrap_or_default();
                return Err(diagnostic(
                    UsageErrorKind::ProcessFailure,
                    "Skill Tree could not complete the usage scan.",
                    Some(e.to_string()),
                    Some(source.clone()),
                    None,
                    Some(&stdout),
                    Some(&stderr),
                ));
            }
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
fn redact_scan_for_cache(scan: &UsageScan) -> UsageScan {
    UsageScan {
        scanned_at: scan.scanned_at,
        source: scan.source.clone(),
        raw: String::new(),
        parsed: redact_value(&scan.parsed),
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
fn looks_like_local_path(value: &str) -> bool {
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
mod tests {
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
        let err = select_first_existing(ccusage_candidates(
            vec![empty.clone()],
            vec![empty.clone()],
        ))
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
        assert!(idx_exe < idx_cmd, "the native .exe must outrank the .cmd shim");
        assert!(idx_exe < idx_bare, "the native .exe must outrank the bare copy");
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
        let raw =
            r#"{"daily":[],"weekly":[],"monthly":[],"session":[],"totals":{"totalTokens":0}}"#;
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
        assert!(on_disk.contains("4242"), "token count was altered: {on_disk}");
        assert!(on_disk.contains("codex"), "harness id was altered: {on_disk}");

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
            loaded.parsed["daily"][0]["session"]["cwd"],
            loaded2.parsed["daily"][0]["session"]["cwd"],
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

        let err = run_ccusage(&script, &CCUSAGE_ARGS, Duration::from_millis(50), &test_source())
            .expect_err("slow command should time out");
        assert_eq!(err.kind, UsageErrorKind::Timeout);
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
}
