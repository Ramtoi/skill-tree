use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use super::hub::resolved_python;
use super::{code_home, data_home, expand_tilde, hub_py};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct SaveSkillMeta {
    pub version: String,
    pub description: String,
    pub scope: String,
    pub upstream: String,
    /// Harness-affinity CSV (e.g. `"claude-code,codex"`). Empty string clears the
    /// affinity back to "all effective harnesses". Always forwarded (idempotent).
    pub harnesses: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct SkillDocument {
    pub name: String,
    pub description: String,
    pub body: String,
}

#[tauri::command]
pub async fn read_registry() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(read_registry_impl)
        .await
        .map_err(|e| format!("read_registry task failed: {e}"))?
}

fn read_registry_impl() -> Result<Value, String> {
    let registry_path = data_home()?.join("registry.yaml");
    let content = std::fs::read_to_string(&registry_path)
        .map_err(|e| format!("Cannot read registry.yaml: {e}"))?;
    serde_yaml::from_str(&content).map_err(|e| format!("Cannot parse registry.yaml: {e}"))
}

/// Live fingerprint of `registry.yaml`, computed at read time so the frontend
/// can compare it against the report's sync-time fingerprint (staleness).
/// `sha256` is authoritative; `mtime` is stored for cheap eyeballing only.
#[derive(Debug, Serialize)]
pub struct RegistryFingerprint {
    pub sha256: String,
    pub mtime: f64,
}

/// The report (opaque, passed through as raw JSON — schema evolution is guarded
/// by its own `schema_version`) plus the live registry fingerprint.
#[derive(Debug, Serialize)]
pub struct SyncReportEnvelope {
    pub report: Value,
    pub registry_current: RegistryFingerprint,
}

/// Read `<data_home>/state/sync-report.json`, returning `None` when it is absent,
/// alongside a freshly computed fingerprint of the live `registry.yaml`.
#[tauri::command]
pub async fn sync_report() -> Result<Option<SyncReportEnvelope>, String> {
    tauri::async_runtime::spawn_blocking(sync_report_impl)
        .await
        .map_err(|e| format!("sync_report task failed: {e}"))?
}

fn sync_report_impl() -> Result<Option<SyncReportEnvelope>, String> {
    let home = data_home()?;
    sync_report_in(&home)
}

fn sync_report_in(home: &Path) -> Result<Option<SyncReportEnvelope>, String> {
    let report_path = home.join("state").join("sync-report.json");
    let raw = match std::fs::read_to_string(&report_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Cannot read sync report: {e}")),
    };
    let report: Value =
        serde_json::from_str(&raw).map_err(|e| format!("Cannot parse sync report: {e}"))?;
    // Unknown schema ⇒ treat as absent: the UI degrades to its honest
    // "unknown — run sync" state instead of rendering mistyped fields.
    if report.get("schema_version").and_then(Value::as_i64) != Some(1) {
        return Ok(None);
    }
    let registry_current = registry_fingerprint(home);
    Ok(Some(SyncReportEnvelope {
        report,
        registry_current,
    }))
}

fn registry_fingerprint(home: &Path) -> RegistryFingerprint {
    let reg = home.join("registry.yaml");
    let sha256 = match std::fs::read(&reg) {
        Ok(bytes) => {
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            hex_encode(&hasher.finalize())
        }
        Err(_) => String::new(),
    };
    let mtime = std::fs::metadata(&reg)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    RegistryFingerprint { sha256, mtime }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(*b >> 4) as usize] as char);
        out.push(HEX[(*b & 0x0f) as usize] as char);
    }
    out
}

fn skill_md_path_for(name: &str) -> Result<std::path::PathBuf, String> {
    let registry_path = data_home()?.join("registry.yaml");
    let content = std::fs::read_to_string(&registry_path)
        .map_err(|e| format!("Cannot read registry.yaml: {e}"))?;
    let yaml: Value =
        serde_yaml::from_str(&content).map_err(|e| format!("Cannot parse registry.yaml: {e}"))?;

    let source = yaml["skills"][name]["source"]
        .as_str()
        .ok_or_else(|| format!("Skill '{name}' not found in registry"))?;

    Ok(expand_tilde(source).join("SKILL.md"))
}

fn parse_skill_document(content: &str) -> Result<SkillDocument, String> {
    let trimmed = content.trim_start_matches('\u{feff}');
    if !trimmed.starts_with("---\n") {
        return Ok(SkillDocument {
            name: String::new(),
            description: String::new(),
            body: trimmed.to_string(),
        });
    }

    let rest = &trimmed[4..];
    let Some(end_idx) = rest.find("\n---\n") else {
        return Err("Invalid SKILL.md frontmatter: missing closing ---".into());
    };

    let frontmatter = &rest[..end_idx];
    let body = rest[end_idx + 5..].trim_start_matches('\n').to_string();

    let meta: BTreeMap<String, serde_yaml::Value> = serde_yaml::from_str(frontmatter)
        .map_err(|e| format!("Invalid SKILL.md frontmatter: {e}"))?;

    let name = meta
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let description = meta
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    Ok(SkillDocument {
        name,
        description,
        body,
    })
}

fn indent_block(value: &str) -> String {
    if value.is_empty() {
        return "  ".to_string();
    }

    value
        .lines()
        .map(|line| {
            if line.is_empty() {
                "  ".to_string()
            } else {
                format!("  {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_skill_document(document: &SkillDocument) -> String {
    let mut output = String::new();
    output.push_str("---\n");
    output.push_str(&format!("name: {}\n", document.name.trim()));
    output.push_str("description: |\n");
    output.push_str(&indent_block(document.description.trim_end()));
    output.push_str("\n---\n\n");
    output.push_str(document.body.trim_end());
    output.push('\n');
    output
}

fn run_hub_command(args: &[String]) -> Result<(), String> {
    let code = code_home()?;
    let data = data_home()?;
    let output = Command::new("python3")
        .args(args)
        .current_dir(&code)
        .env("SKILL_HUB_HOME", data.as_os_str())
        .env("SKILL_HUB_CODE", code.as_os_str())
        .env_remove("SKILL_HUB_DIR")
        .output()
        .map_err(|e| format!("Failed to run hub.py command: {e}"))?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{}{}", stdout, stderr).trim().to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn read_skill_content(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_skill_content_impl(name))
        .await
        .map_err(|e| format!("read_skill_content task failed: {e}"))?
}

fn read_skill_content_impl(name: String) -> Result<String, String> {
    let skill_md = skill_md_path_for(&name)?;
    std::fs::read_to_string(&skill_md)
        .map_err(|e| format!("Cannot read SKILL.md at {}: {e}", skill_md.display()))
}

#[tauri::command]
pub async fn read_skill_document(name: String) -> Result<SkillDocument, String> {
    tauri::async_runtime::spawn_blocking(move || read_skill_document_impl(name))
        .await
        .map_err(|e| format!("read_skill_document task failed: {e}"))?
}

fn read_skill_document_impl(name: String) -> Result<SkillDocument, String> {
    let skill_md = skill_md_path_for(&name)?;
    let content = std::fs::read_to_string(&skill_md)
        .map_err(|e| format!("Cannot read SKILL.md at {}: {e}", skill_md.display()))?;
    parse_skill_document(&content)
}

#[tauri::command]
pub async fn write_skill_content(name: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_skill_content_impl(name, content))
        .await
        .map_err(|e| format!("write_skill_content task failed: {e}"))?
}

fn write_skill_content_impl(name: String, content: String) -> Result<(), String> {
    let skill_md = skill_md_path_for(&name)?;
    std::fs::write(&skill_md, content)
        .map_err(|e| format!("Cannot write SKILL.md at {}: {e}", skill_md.display()))
}

#[tauri::command]
pub async fn save_skill_full(
    name: String,
    document: SkillDocument,
    meta: SaveSkillMeta,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || save_skill_full_impl(name, document, meta))
        .await
        .map_err(|e| format!("save_skill_full task failed: {e}"))?
}

fn save_skill_full_impl(
    name: String,
    document: SkillDocument,
    meta: SaveSkillMeta,
) -> Result<String, String> {
    let current_name = name;
    let target_name = document.name.trim().to_string();

    if target_name.is_empty() {
        return Err("Skill name cannot be empty".into());
    }

    if current_name != target_name {
        run_hub_command(&[
            hub_py()?.to_string_lossy().to_string(),
            "rename".to_string(),
            current_name.clone(),
            target_name.clone(),
        ])?;
    }

    let skill_md = skill_md_path_for(&target_name)?;
    let previous_content = std::fs::read_to_string(&skill_md).unwrap_or_default();
    let rebuilt = build_skill_document(&document);

    let tmp_path = skill_md.with_extension("md.tmp");
    std::fs::write(&tmp_path, &rebuilt)
        .map_err(|e| format!("Cannot stage SKILL.md at {}: {e}", tmp_path.display()))?;
    std::fs::rename(&tmp_path, &skill_md)
        .map_err(|e| format!("Cannot replace SKILL.md at {}: {e}", skill_md.display()))?;

    let hub_py_path = hub_py()?.to_string_lossy().to_string();
    let args = vec![
        hub_py_path,
        "set-meta".to_string(),
        target_name.clone(),
        "--version".to_string(),
        meta.version,
        "--description".to_string(),
        meta.description,
        "--scope".to_string(),
        meta.scope,
        "--upstream".to_string(),
        meta.upstream,
        "--harnesses".to_string(),
        meta.harnesses,
    ];

    if let Err(err) = run_hub_command(&args) {
        let _ = std::fs::write(&skill_md, previous_content);
        return Err(err);
    }

    Ok(target_name)
}

/// Shared spawn for the JSON-returning bridge commands below. Marshals one
/// `hub.py <args>` subprocess (optionally piping `stdin`), returns parsed JSON on
/// success, and the combined stdout+stderr as an error string otherwise.
fn run_hub_json(args: &[String], stdin: Option<&str>) -> Result<Value, String> {
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
                // Reap the child before bailing so a failed pipe never leaks
                // a zombie hub.py process.
                drop(sin);
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Failed to pipe stdin to hub.py: {e}"));
            }
        }
        child
            .wait_with_output()
            .map_err(|e| format!("Failed to read hub.py output: {e}"))?
    } else {
        cmd.output()
            .map_err(|e| format!("Failed to run hub.py: {e}"))?
    };

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{stdout}{stderr}").trim().to_string());
    }
    let body = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&body)
        .map_err(|e| format!("Cannot parse hub.py JSON output: {e}\nRaw: {body}"))
}

/// Aggregate array of hand-authored project-local skills not yet adopted, across
/// all registered projects. Wraps `hub project scan-skills --json` (read-only).
#[tauri::command]
pub async fn local_skill_candidates() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(local_skill_candidates_impl)
        .await
        .map_err(|e| format!("local_skill_candidates task failed: {e}"))?
}

fn local_skill_candidates_impl() -> Result<Value, String> {
    run_hub_json(
        &[
            "project".to_string(),
            "scan-skills".to_string(),
            "--json".to_string(),
        ],
        None,
    )
}

/// Registry-only toggle of a bundle or skill on a configured remote (no box
/// push). Wraps `hub remote equip <id> --kind {bundle|skill} --name <name>
/// --state {on|off} --json`; returns `{ ok, bundles, enabled }`.
#[tauri::command]
pub async fn remote_equip(id: String, kind: String, name: String, on: bool) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || remote_equip_impl(id, kind, name, on))
        .await
        .map_err(|e| format!("remote_equip task failed: {e}"))?
}

fn remote_equip_impl(id: String, kind: String, name: String, on: bool) -> Result<Value, String> {
    let state = if on { "on" } else { "off" };
    run_hub_json(
        &[
            "remote".to_string(),
            "equip".to_string(),
            id,
            "--kind".to_string(),
            kind,
            "--name".to_string(),
            name,
            "--state".to_string(),
            state.to_string(),
            "--json".to_string(),
        ],
        None,
    )
}

/// Shape the argv for a decisions-driven source apply: the caller's
/// `["source","add","git",url,…]` vector (WITHOUT `--dry-run`) with
/// `--decisions-stdin --json` appended. Extracted so the flag contract is
/// unit-testable without spawning Python.
fn source_apply_args(args: Vec<String>) -> Vec<String> {
    let mut full = args;
    full.push("--decisions-stdin".to_string());
    full.push("--json".to_string());
    full
}

/// Apply a source add with per-conflict decisions. Appends `--decisions-stdin
/// --json` to the caller's `["source","add","git",url,…]` vector (which must NOT
/// include `--dry-run`) and pipes `{ "decisions": <decisions> }` on stdin.
#[tauri::command]
pub async fn source_add_apply(args: Vec<String>, decisions: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || source_add_apply_impl(args, decisions))
        .await
        .map_err(|e| format!("source_add_apply task failed: {e}"))?
}

fn source_add_apply_impl(args: Vec<String>, decisions: Value) -> Result<Value, String> {
    let full = source_apply_args(args);
    let payload = serde_json::json!({ "decisions": decisions });
    let serialized = serde_json::to_string(&payload)
        .map_err(|e| format!("Cannot serialize decisions: {e}"))?;
    run_hub_json(&full, Some(&serialized))
}

#[cfg(test)]
mod sync_report_tests {
    use super::{hex_encode, sync_report_in};
    use sha2::{Digest, Sha256};
    use tempfile::TempDir;

    #[test]
    fn sync_report_absent_returns_none() {
        let td = TempDir::new().unwrap();
        // No state/sync-report.json under this home.
        let out = sync_report_in(td.path()).expect("should not error");
        assert!(out.is_none());
    }

    #[test]
    fn sync_report_present_returns_envelope_with_fingerprint() {
        let td = TempDir::new().unwrap();
        let registry_bytes = b"version: '1'\nprojects: {}\n";
        std::fs::write(td.path().join("registry.yaml"), registry_bytes).unwrap();
        std::fs::create_dir_all(td.path().join("state")).unwrap();
        std::fs::write(
            td.path().join("state").join("sync-report.json"),
            r#"{"schema_version":1,"ok":true,"projects":{"alpha":{"ok":true}}}"#,
        )
        .unwrap();

        let out = sync_report_in(td.path())
            .expect("should not error")
            .expect("report present");
        assert_eq!(out.report["schema_version"], 1);
        assert_eq!(out.report["projects"]["alpha"]["ok"], true);

        let mut hasher = Sha256::new();
        hasher.update(registry_bytes);
        let expected = hex_encode(&hasher.finalize());
        assert_eq!(out.registry_current.sha256, expected);
        assert_eq!(expected.len(), 64, "full sha-256, not truncated");
        assert!(out.registry_current.mtime > 0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::{build_skill_document, parse_skill_document, source_apply_args, SaveSkillMeta, SkillDocument};

    #[test]
    fn source_apply_args_appends_decisions_flags() {
        let base = vec![
            "source".to_string(),
            "add".to_string(),
            "git".to_string(),
            "https://example/x.git".to_string(),
            "--id".to_string(),
            "x".to_string(),
        ];
        let full = source_apply_args(base.clone());
        // Contract: the caller's argv must pass through untouched (hub.py parses
        // positionally), and apply mode must never inherit a stray --dry-run.
        assert_eq!(&full[..base.len()], &base[..]);
        assert_eq!(full[base.len()], "--decisions-stdin");
        assert_eq!(full[base.len() + 1], "--json");
        assert!(!full.iter().any(|a| a == "--dry-run"));
    }

    #[test]
    fn save_skill_meta_carries_harnesses_field() {
        // The forwarding contract: SaveSkillMeta round-trips a harnesses CSV so
        // save_skill_full can append `--harnesses <csv>` (empty clears).
        let json = r#"{"version":"1.0.0","description":"d","scope":"portable","upstream":"","harnesses":"claude-code,codex"}"#;
        let meta: SaveSkillMeta = serde_json::from_str(json).expect("deserialize");
        assert_eq!(meta.harnesses, "claude-code,codex");
        let empty = r#"{"version":"1.0.0","description":"d","scope":"portable","upstream":"","harnesses":""}"#;
        let meta: SaveSkillMeta = serde_json::from_str(empty).expect("deserialize empty");
        assert_eq!(meta.harnesses, "");
    }

    #[test]
    fn parses_frontmatter_and_body() {
        let content = "---\nname: brainstorm\ndescription: |\n  First line\n  Second line\n---\n\n# Heading\nBody\n";
        let parsed = parse_skill_document(content).expect("parse should succeed");
        assert_eq!(
            parsed,
            SkillDocument {
                name: "brainstorm".into(),
                description: "First line\nSecond line".into(),
                body: "# Heading\nBody\n".into(),
            }
        );
    }

    #[test]
    fn rebuilds_structured_skill_markdown() {
        let doc = SkillDocument {
            name: "brainstorm".into(),
            description: "Use this skill when...\nTrigger on X.".into(),
            body: "# Brainstorm\n\nBody text".into(),
        };

        let rebuilt = build_skill_document(&doc);
        assert!(rebuilt.contains("name: brainstorm"));
        assert!(rebuilt.contains("description: |\n  Use this skill when...\n  Trigger on X."));
        assert!(rebuilt.ends_with("# Brainstorm\n\nBody text\n"));
    }
}
