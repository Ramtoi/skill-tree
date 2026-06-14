use super::{code_home, data_home, hub_py};
use serde::{Deserialize, Serialize};
use std::process::{Child, Command, Output, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

static PYTHON_PATH: OnceLock<Option<String>> = OnceLock::new();

/// Minimum Python the bundled `hub.py` supports — mirrors `MIN_PYTHON` in hub.py.
const MIN_PYTHON: (u32, u32) = (3, 9);

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

/// Probe `<path> --version` with a timeout; `None` if it isn't a usable Python.
fn probe_version(path: &str) -> Option<(u32, u32, u32)> {
    let child = Command::new(path)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let out = wait_with_timeout(child, Duration::from_secs(3))?;
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

fn detect_python() -> Option<String> {
    // 1. Bare names on whatever `$PATH` we inherited.
    for candidate in ["python3", "python"] {
        if probe_version(candidate).is_some() {
            return Some(candidate.to_string());
        }
    }
    // 2. Known absolute locations the truncated GUI `$PATH` omits.
    for dir in KNOWN_PYTHON_DIRS {
        for name in ["python3", "python"] {
            let p = format!("{dir}/{name}");
            if std::path::Path::new(&p).exists() && probe_version(&p).is_some() {
                return Some(p);
            }
        }
    }
    None
}

pub fn resolved_python() -> Option<&'static str> {
    PYTHON_PATH.get_or_init(detect_python).as_deref()
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

#[tauri::command]
pub fn runtime_preflight() -> Preflight {
    // 1. Interpreter resolution (GUI-correct — searches known dirs too).
    let python = match resolved_python() {
        Some(p) => p.to_string(),
        None => return Preflight::fail("no-python", None, None),
    };

    // 2. Version gate against MIN_PYTHON.
    match probe_version(&python) {
        Some((maj, min, pat)) => {
            if (maj, min) < MIN_PYTHON {
                return Preflight::fail(
                    "python-too-old",
                    Some(format!("{maj}.{min}.{pat}")),
                    Some(python),
                );
            }
        }
        None => {
            // Resolved earlier but no longer probes cleanly — treat as missing.
            return Preflight::fail("no-python", None, Some(python));
        }
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

    let output = std::process::Command::new(python)
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
}
