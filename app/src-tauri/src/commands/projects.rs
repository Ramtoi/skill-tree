use super::{code_home, data_home, hub_py};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Command;

use super::hub::resolved_python;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Candidate {
    pub name: String,
    pub project: String,
    pub path: String,
    pub category: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RemovalPlan {
    pub project: String,
    pub project_path: String,
    pub removed_symlinks: Vec<String>,
    pub removed_mcp_entries: Vec<Value>,
    pub removed_empty_dirs: Vec<String>,
    pub warnings: Vec<String>,
}

fn run_hub(args: &[&str]) -> Result<std::process::Output, String> {
    let python = resolved_python()
        .ok_or_else(|| "Python not found. Install Python 3 and ensure it is in PATH.".to_string())?;
    let code = code_home()?;
    let data = data_home()?;
    let hub = hub_py()?;
    Command::new(python)
        .arg(&hub)
        .args(args)
        .current_dir(&code)
        .env("SKILL_HUB_HOME", data.as_os_str())
        .env("SKILL_HUB_CODE", code.as_os_str())
        .env_remove("SKILL_HUB_DIR")
        .output()
        .map_err(|e| format!("Failed to run hub.py: {e}"))
}

fn ok_or_combined(output: std::process::Output) -> Result<String, String> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
        .trim()
        .to_string())
    }
}

#[tauri::command]
pub fn project_add_with_path(name: String, path: String) -> Result<(), String> {
    ok_or_combined(run_hub(&["project", "add", &name, &path])?)?;
    Ok(())
}

#[tauri::command]
pub fn project_edit_path(name: String, new_path: String) -> Result<(), String> {
    ok_or_combined(run_hub(&["project", "edit-path", &name, &new_path])?)?;
    Ok(())
}

#[tauri::command]
pub fn project_remove_preview(name: String) -> Result<RemovalPlan, String> {
    let stdout = ok_or_combined(run_hub(&[
        "project", "remove", &name, "--dry-run", "--json",
    ])?)?;
    serde_json::from_str(&stdout)
        .map_err(|e| format!("Cannot parse removal plan: {e}\nRaw: {stdout}"))
}

#[tauri::command]
pub fn project_remove_clean(name: String) -> Result<(), String> {
    ok_or_combined(run_hub(&["project", "remove", &name])?)?;
    Ok(())
}

#[tauri::command]
pub fn project_scan_candidates(name: String) -> Result<Vec<Candidate>, String> {
    let stdout = ok_or_combined(run_hub(&[
        "project", "scan-skills", "--project", &name, "--json",
    ])?)?;
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(trimmed)
        .map_err(|e| format!("Cannot parse scan candidates: {e}\nRaw: {stdout}"))
}
