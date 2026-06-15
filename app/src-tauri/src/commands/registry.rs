use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::process::Command;

use super::{code_home, data_home, expand_tilde, hub_py};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct SaveSkillMeta {
    pub version: String,
    pub description: String,
    pub scope: String,
    pub upstream: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct SkillDocument {
    pub name: String,
    pub description: String,
    pub body: String,
}

#[tauri::command]
pub fn read_registry() -> Result<Value, String> {
    let registry_path = data_home()?.join("registry.yaml");
    let content = std::fs::read_to_string(&registry_path)
        .map_err(|e| format!("Cannot read registry.yaml: {e}"))?;
    serde_yaml::from_str(&content).map_err(|e| format!("Cannot parse registry.yaml: {e}"))
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
pub fn read_skill_content(name: String) -> Result<String, String> {
    let skill_md = skill_md_path_for(&name)?;
    std::fs::read_to_string(&skill_md)
        .map_err(|e| format!("Cannot read SKILL.md at {}: {e}", skill_md.display()))
}

#[tauri::command]
pub fn read_skill_document(name: String) -> Result<SkillDocument, String> {
    let skill_md = skill_md_path_for(&name)?;
    let content = std::fs::read_to_string(&skill_md)
        .map_err(|e| format!("Cannot read SKILL.md at {}: {e}", skill_md.display()))?;
    parse_skill_document(&content)
}

#[tauri::command]
pub fn write_skill_content(name: String, content: String) -> Result<(), String> {
    let skill_md = skill_md_path_for(&name)?;
    std::fs::write(&skill_md, content)
        .map_err(|e| format!("Cannot write SKILL.md at {}: {e}", skill_md.display()))
}

#[tauri::command]
pub fn save_skill_full(
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
    ];

    if let Err(err) = run_hub_command(&args) {
        let _ = std::fs::write(&skill_md, previous_content);
        return Err(err);
    }

    Ok(target_name)
}

#[cfg(test)]
mod tests {
    use super::{build_skill_document, parse_skill_document, SkillDocument};

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
