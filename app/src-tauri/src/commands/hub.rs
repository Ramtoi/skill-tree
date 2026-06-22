use super::{code_home, data_home, hub_py};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::{Child, Command, Output, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A resolved interpreter: its path plus the detected (major, minor, patch).
/// Cached as a unit so the preflight never spawns Python a *second* time merely
/// to re-derive the version — that redundant probe could flake on a slow spawn
/// and bounce a working app back to a false "no Python" screen.
#[derive(Clone, Debug)]
struct PyRuntime {
    path: String,
    version: (u32, u32, u32),
}

/// Caches ONLY a successful resolution. A failed detection is never stored, so a
/// later call re-probes — this is what makes "Recheck runtime" able to pick up a
/// Python the user installed *after* launch. (A `OnceLock` here was a bug: it
/// cached the initial `None` for the whole process.)
static PYTHON: Mutex<Option<PyRuntime>> = Mutex::new(None);

/// Minimum Python the bundled `hub.py` supports — mirrors `MIN_PYTHON` in hub.py.
const MIN_PYTHON: (u32, u32) = (3, 9);

/// Per-attempt probe timeout, with a short retry. Generous because the macOS
/// `/usr/bin/python3` stub resolves the real interpreter via `xcrun`, which can
/// take seconds on a cold, under-load first spawn (e.g. right after a build).
/// Too tight a bound was the root cause of intermittent false "Python not
/// detected" on machines whose only Python is the Command-Line-Tools stub.
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);
const PROBE_ATTEMPTS: usize = 2;

/// Interpreter locations searched *in addition to* `$PATH`. macOS apps launched
/// from Finder/Dock inherit a truncated `$PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`)
/// and do not source the user's shell profile, so a Homebrew-only Python is
/// invisible via a bare `python3` lookup. We probe these explicitly.
const KNOWN_PYTHON_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/// Run a child to completion but kill it if it outlives `timeout`. Guards against
/// the macOS `/usr/bin/python3` Command-Line-Tools stub, which can block on a
/// modal "install developer tools" dialog when invoked without CLT present.
/// `--version` output is tiny, so reading pipes only after exit can't deadlock.
fn wait_with_timeout(mut child: Child, timeout: Duration) -> Option<Output> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }
}

/// Parse `"Python 3.11.6"` → `(3, 11, 6)`. Tolerates a missing patch component.
fn parse_py_version(s: &str) -> Option<(u32, u32, u32)> {
    let v = s.split_whitespace().nth(1)?;
    let mut it = v.split('.');
    let maj = it.next()?.parse().ok()?;
    let min = it.next()?.parse().ok()?;
    let pat = it.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    Some((maj, min, pat))
}

/// One `<path> --version` probe with a timeout; `None` if not a usable Python.
fn probe_version_once(path: &str) -> Option<(u32, u32, u32)> {
    let child = Command::new(path)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let out = wait_with_timeout(child, PROBE_TIMEOUT)?;
    if !out.status.success() {
        return None;
    }
    // Python <3.4 printed the version to stderr; modern ones use stdout. Accept both.
    let text = if out.stdout.is_empty() {
        String::from_utf8_lossy(&out.stderr)
    } else {
        String::from_utf8_lossy(&out.stdout)
    };
    parse_py_version(text.trim())
}

/// Probe with a short retry: a cold first spawn (e.g. `/usr/bin/python3` → xcrun
/// resolving the CLT toolchain under load) can miss a single timeout even when
/// the interpreter is perfectly healthy.
fn probe_version(path: &str) -> Option<(u32, u32, u32)> {
    for attempt in 0..PROBE_ATTEMPTS {
        if let Some(v) = probe_version_once(path) {
            return Some(v);
        }
        if attempt + 1 < PROBE_ATTEMPTS {
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    None
}

fn detect_python() -> Option<PyRuntime> {
    // 1. Bare names on whatever `$PATH` we inherited.
    for candidate in ["python3", "python"] {
        if let Some(version) = probe_version(candidate) {
            return Some(PyRuntime { path: candidate.to_string(), version });
        }
    }
    // 2. Known absolute locations the truncated GUI `$PATH` omits.
    for dir in KNOWN_PYTHON_DIRS {
        for name in ["python3", "python"] {
            let p = format!("{dir}/{name}");
            if std::path::Path::new(&p).exists() {
                if let Some(version) = probe_version(&p) {
                    return Some(PyRuntime { path: p, version });
                }
            }
        }
    }
    None
}

fn resolved_runtime() -> Option<PyRuntime> {
    let mut guard = PYTHON.lock().unwrap();
    if let Some(rt) = guard.as_ref() {
        return Some(rt.clone());
    }
    // Not yet found — re-probe every call until one succeeds, then cache it.
    let found = detect_python();
    if let Some(ref rt) = found {
        *guard = Some(rt.clone());
    }
    found
}

pub fn resolved_python() -> Option<String> {
    resolved_runtime().map(|rt| rt.path)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HubResult {
    pub success: bool,
    pub output: String,
}

/// Structured runtime status consumed by the app's onboarding gate. `reason` is
/// one of `none` / `no-python` / `python-too-old` / `hub-unrunnable`. `detail`
/// carries the detected version (`python-too-old`) or the self-check stderr
/// (`hub-unrunnable`). `python` is the resolved interpreter path, when one was
/// found, so error messaging can name exactly what is in use.
#[derive(Debug, Serialize)]
pub struct Preflight {
    pub ok: bool,
    pub reason: String,
    pub detail: Option<String>,
    pub python: Option<String>,
}

impl Preflight {
    fn fail(reason: &str, detail: Option<String>, python: Option<String>) -> Self {
        Preflight {
            ok: false,
            reason: reason.into(),
            detail,
            python,
        }
    }
}

/// Append one line per preflight to `<data_home>/state/preflight.log` so a GUI
/// launch's outcome is observable without the UI (this class of bug — false
/// "no Python" in the packaged app — is otherwise hard to diagnose). Best-effort.
fn log_preflight(pf: &Preflight) {
    let Ok(home) = data_home() else { return };
    let dir = home.join("state");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("preflight.log"))
    {
        let detail = pf.detail.as_deref().unwrap_or("");
        let detail = &detail[..detail.len().min(120)];
        let _ = writeln!(
            f,
            "ok={} reason={} python={:?} detail={:?}",
            pf.ok, pf.reason, pf.python, detail
        );
    }
}

#[tauri::command]
pub fn runtime_preflight() -> Preflight {
    let pf = runtime_preflight_inner();
    log_preflight(&pf);
    pf
}

fn runtime_preflight_inner() -> Preflight {
    // 1. Interpreter resolution (GUI-correct — searches known dirs too) with the
    //    version captured at detection time, so we DON'T re-probe Python here.
    let rt = match resolved_runtime() {
        Some(rt) => rt,
        None => return Preflight::fail("no-python", None, None),
    };
    let python = rt.path;

    // 2. Version gate against MIN_PYTHON (using the cached version — no spawn).
    let (maj, min, pat) = rt.version;
    if (maj, min) < MIN_PYTHON {
        return Preflight::fail(
            "python-too-old",
            Some(format!("{maj}.{min}.{pat}")),
            Some(python),
        );
    }

    // 3. Registry-free self-check: proves hub.py + the vendor import chain run.
    let code = match code_home() {
        Ok(c) => c,
        Err(e) => return Preflight::fail("hub-unrunnable", Some(e), Some(python)),
    };
    let hub = match hub_py() {
        Ok(h) => h,
        Err(e) => return Preflight::fail("hub-unrunnable", Some(e), Some(python)),
    };
    let output = Command::new(&python)
        .arg(&hub)
        .args(["selfcheck", "--json"])
        .current_dir(&code)
        .env("SKILL_HUB_CODE", code.as_os_str())
        .env_remove("SKILL_HUB_DIR")
        .output();
    match output {
        Ok(out) if out.status.success() => Preflight {
            ok: true,
            reason: "none".into(),
            detail: None,
            python: Some(python),
        },
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
            let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
            let detail = if stderr.trim().is_empty() { stdout } else { stderr };
            Preflight::fail("hub-unrunnable", Some(detail), Some(python))
        }
        Err(e) => {
            Preflight::fail("hub-unrunnable", Some(format!("Failed to run hub.py: {e}")), Some(python))
        }
    }
}

/// Back-compat shim: the boolean gate is just the structured preflight's `ok`.
#[tauri::command]
pub fn check_python() -> bool {
    runtime_preflight().ok
}

#[tauri::command]
pub fn hub_cmd(args: Vec<String>) -> Result<HubResult, String> {
    let python = resolved_python().ok_or_else(|| {
        "Python not found. Install Python 3 and ensure it is in PATH.".to_string()
    })?;
    let code = code_home()?;
    let data = data_home()?;
    let hub = hub_py()?;

    let output = std::process::Command::new(&python)
        .arg(&hub)
        .args(&args)
        .current_dir(&code)
        .env("SKILL_HUB_HOME", data.as_os_str())
        .env("SKILL_HUB_CODE", code.as_os_str())
        .env_remove("SKILL_HUB_DIR")
        .output()
        .map_err(|e| format!("Failed to run hub.py: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let combined = if stderr.is_empty() {
        stdout
    } else {
        format!("{stdout}{stderr}")
    };

    Ok(HubResult {
        success: output.status.success(),
        output: combined,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_handles_stdout_form() {
        assert_eq!(parse_py_version("Python 3.11.6"), Some((3, 11, 6)));
        assert_eq!(parse_py_version("Python 3.9.6"), Some((3, 9, 6)));
        // Missing patch tolerated.
        assert_eq!(parse_py_version("Python 3.12"), Some((3, 12, 0)));
        // Garbage rejected.
        assert_eq!(parse_py_version("not python"), None);
        assert_eq!(parse_py_version(""), None);
    }

    #[test]
    fn version_gate_matches_min_python() {
        // The preflight gates on (major, minor) < MIN_PYTHON.
        assert!((3u32, 8u32) < MIN_PYTHON, "3.8 must be too old");
        assert!(!((3u32, 9u32) < MIN_PYTHON), "3.9 is the floor, allowed");
        assert!(!((3u32, 12u32) < MIN_PYTHON), "3.12 allowed");
    }

    #[test]
    fn detect_python_finds_an_interpreter_on_dev_machine() {
        // CI/dev always has a python3; this also exercises the timeout probe path.
        assert!(detect_python().is_some());
    }

    #[test]
    fn failed_detection_is_not_cached() {
        // Regression: a OnceLock cached the initial `None` for the whole process,
        // so "Recheck runtime" and post-install both did nothing until restart.
        // The cache must hold only successful results, so resolution re-probes.
        *PYTHON.lock().unwrap() = None;
        assert!(resolved_python().is_some());
        // A cached success is reused on the next call.
        assert!(resolved_python().is_some());
    }

    #[test]
    fn runtime_preflight_is_ok_on_dev_machine() {
        // Point code_home at the repo root (CARGO_MANIFEST_DIR = app/src-tauri).
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .unwrap()
            .to_path_buf();
        std::env::set_var("SKILL_HUB_CODE", &repo_root);
        // hub.py + vendored deps resolve from the repo checkout → ok/none.
        let pf = runtime_preflight();
        assert!(pf.ok, "expected healthy preflight, got {pf:?}");
        assert_eq!(pf.reason, "none");
        assert!(pf.python.is_some());
    }

    #[test]
    fn runtime_preflight_is_stable_across_calls() {
        // Regression: the preflight re-probed Python for the version gate on every
        // call, so a flaky/slow spawn could bounce a working app back to a false
        // "no Python" screen. With the version cached at detection, repeated calls
        // must agree.
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .unwrap()
            .to_path_buf();
        std::env::set_var("SKILL_HUB_CODE", &repo_root);
        let a = runtime_preflight();
        let b = runtime_preflight();
        let c = runtime_preflight();
        assert!(
            a.ok && b.ok && c.ok,
            "preflight must be stable across calls: {a:?} / {b:?} / {c:?}"
        );
    }
}
