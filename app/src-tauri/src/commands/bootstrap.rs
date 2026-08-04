use super::{code_home, data_home, hub_py};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Command;

use super::hub::resolved_python;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BootstrapState {
    pub needs_bootstrap: bool,
    pub completed_at: Option<String>,
    pub version: u32,
    pub legacy_detected: Vec<String>,
    pub data_home: String,
    pub code_home: String,
    pub candidates: Vec<Value>,
    pub conflicts: Vec<Value>,
    pub blocked: Vec<Value>,
    pub already_managed: Vec<String>,
    pub silent_skip: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BootstrapSelections {
    /// Names of candidates to register (NEW + BROKEN that the user confirmed).
    pub register: Vec<String>,
    /// {name: "skip" | "replace" | "suffix"} for conflicts.
    #[serde(default)]
    pub conflict_actions: std::collections::BTreeMap<String, String>,
    /// Names to adopt (copy into data home) instead of registering in place.
    #[serde(default)]
    pub adopt: Vec<String>,
    /// Candidate paths the wizard actually DISPLAYED as rows. Lets the Python
    /// side tolerate the post-migration NEW→ALREADY_MANAGED flip and apply the
    /// `--yes` defaults to candidates that only appeared after migration.
    /// Omitted → strict validation (older callers).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offered: Option<Vec<String>>,
}

fn run_python(args: &[&str]) -> Result<std::process::Output, String> {
    run_python_stdin(args, None)
}

/// Run `hub.py` with the given args, optionally piping `stdin_body` to its
/// stdin. Used to hand the wizard's explicit apply-plan to `bootstrap
/// --plan-stdin` (never on argv).
fn run_python_stdin(
    args: &[&str],
    stdin_body: Option<&str>,
) -> Result<std::process::Output, String> {
    use std::io::Write;
    let python = resolved_python()
        .ok_or_else(|| "Python not found. Install Python 3 and ensure it is in PATH.".to_string())?;
    let code = code_home()?;
    let data = data_home()?;
    let hub = hub_py()?;
    let mut cmd = Command::new(python);
    cmd.arg(&hub)
        .args(args)
        .current_dir(&code)
        .env("SKILL_HUB_HOME", data.as_os_str())
        .env("SKILL_HUB_CODE", code.as_os_str())
        .env_remove("SKILL_HUB_DIR");
    match stdin_body {
        None => cmd.output().map_err(|e| format!("Failed to run hub.py: {e}")),
        Some(body) => {
            use std::process::Stdio;
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut child = cmd
                .spawn()
                .map_err(|e| format!("Failed to run hub.py: {e}"))?;
            if let Some(mut stdin) = child.stdin.take() {
                stdin
                    .write_all(body.as_bytes())
                    .map_err(|e| format!("Failed to pipe plan to hub.py: {e}"))?;
            }
            child
                .wait_with_output()
                .map_err(|e| format!("Failed to run hub.py: {e}"))
        }
    }
}

#[tauri::command]
pub async fn bootstrap_check() -> Result<BootstrapState, String> {
    tauri::async_runtime::spawn_blocking(bootstrap_check_impl)
        .await
        .map_err(|e| format!("bootstrap_check task failed: {e}"))?
}

fn bootstrap_check_impl() -> Result<BootstrapState, String> {
    let output = run_python(&["bootstrap", "--dry-run", "--json"])?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!(
            "bootstrap --dry-run failed:\n{}{}",
            stdout, stderr
        ));
    }

    // The CLI dry-run prints the plan as JSON. Parse it loosely; missing
    // fields fall back to empty defaults so the wizard can still render.
    let plan: Value = serde_json::from_str(stdout.trim()).map_err(|e| {
        format!(
            "Cannot parse bootstrap dry-run JSON: {e}\nRaw output:\n{stdout}"
        )
    })?;

    // Read registry to fetch bootstrap.completed_at (if any)
    let mut completed_at: Option<String> = None;
    let mut version: u32 = 1;
    let registry_path = data_home()?.join("registry.yaml");
    if registry_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&registry_path) {
            if let Ok(yaml) = serde_yaml::from_str::<Value>(&content) {
                if let Some(b) = yaml.get("bootstrap") {
                    completed_at = b
                        .get("completed_at")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    version = b.get("version").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
                }
            }
        }
    }

    let candidates = plan
        .get("candidates")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let conflicts = plan
        .get("conflicts")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let blocked = plan
        .get("blocked")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let already_managed = plan
        .get("already_managed")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let silent_skip = plan
        .get("silent_skip")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let legacy_detected = plan
        .get("legacy_detected")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    Ok(BootstrapState {
        needs_bootstrap: completed_at.is_none(),
        completed_at,
        version,
        legacy_detected,
        data_home: data_home()?.to_string_lossy().into_owned(),
        code_home: code_home()?.to_string_lossy().into_owned(),
        candidates,
        conflicts,
        blocked,
        already_managed,
        silent_skip,
    })
}

#[tauri::command]
pub async fn bootstrap_run(selections: BootstrapSelections) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || bootstrap_run_impl(selections))
        .await
        .map_err(|e| format!("bootstrap_run task failed: {e}"))?
}

// The wizard's per-skill checkboxes / conflict choices / adopt set are handed
// to `hub.py bootstrap --plan-stdin` as an explicit apply-plan on stdin (the
// same convention `source add --decisions-stdin` uses). The Python side
// validates every path/action FAIL-CLOSED and applies nothing on a bad plan.
fn bootstrap_run_impl(selections: BootstrapSelections) -> Result<(), String> {
    let plan = serde_json::to_string(&selections)
        .map_err(|e| format!("Failed to serialize bootstrap plan: {e}"))?;
    let output = run_python_stdin(&["bootstrap", "--plan-stdin"], Some(&plan))?;
    if !output.status.success() {
        return Err(format!(
            "bootstrap failed:\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}
