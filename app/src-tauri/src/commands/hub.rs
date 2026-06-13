use super::{code_home, data_home, hub_py};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

static PYTHON_PATH: OnceLock<Option<String>> = OnceLock::new();

fn detect_python() -> Option<String> {
    for candidate in ["python3", "python"] {
        let found = std::process::Command::new(candidate)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if found {
            return Some(candidate.to_string());
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

#[tauri::command]
pub fn check_python() -> bool {
    resolved_python().is_some()
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
