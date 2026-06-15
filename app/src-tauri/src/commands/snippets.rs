//! Snippets — thin marshal layer over `hub snippet ... --json`.
//!
//! No business logic lives here: every command forwards to the Python CLI and
//! returns its JSON payload verbatim (the TS layer owns the types). File
//! targets are always `(project, relative_path)` — never raw absolute paths —
//! so confinement is enforced by the Python resolver for every caller.

use super::agent_docs::run_hub_json;
use serde_json::Value;

#[tauri::command]
pub fn snippets_list(tag: Option<String>, query: Option<String>) -> Result<Value, String> {
    let mut args: Vec<&str> = vec!["snippet", "list", "--json"];
    if let Some(ref t) = tag {
        args.push("--tag");
        args.push(t);
    }
    if let Some(ref q) = query {
        args.push("--query");
        args.push(q);
    }
    run_hub_json(&args)
}

#[tauri::command]
pub fn snippet_show(name: String) -> Result<Value, String> {
    run_hub_json(&["snippet", "show", &name, "--json"])
}

#[tauri::command]
pub fn snippet_new(
    name: String,
    description: Option<String>,
    tags: Option<Vec<String>>,
    body: Option<String>,
) -> Result<Value, String> {
    let tags_joined = tags.map(|t| t.join(","));
    let mut args: Vec<&str> = vec!["snippet", "new", &name, "--json"];
    if let Some(ref d) = description {
        args.push("--description");
        args.push(d);
    }
    if let Some(ref t) = tags_joined {
        args.push("--tags");
        args.push(t);
    }
    if let Some(ref b) = body {
        args.push("--body");
        args.push(b);
    }
    run_hub_json(&args)
}

#[tauri::command]
pub fn snippet_edit(
    name: String,
    description: Option<String>,
    tags: Option<Vec<String>>,
    body: Option<String>,
) -> Result<Value, String> {
    let tags_joined = tags.map(|t| t.join(","));
    let mut args: Vec<&str> = vec!["snippet", "edit", &name, "--json"];
    if let Some(ref d) = description {
        args.push("--description");
        args.push(d);
    }
    if let Some(ref t) = tags_joined {
        args.push("--tags");
        args.push(t);
    }
    if let Some(ref b) = body {
        args.push("--body");
        args.push(b);
    }
    run_hub_json(&args)
}

#[tauri::command]
pub fn snippet_delete(name: String, force: bool) -> Result<Value, String> {
    let mut args: Vec<&str> = vec!["snippet", "delete", &name, "--json"];
    if force {
        args.push("--force");
    }
    run_hub_json(&args)
}

#[tauri::command]
pub fn snippet_apply(
    name: String,
    project: String,
    relative_path: Option<String>,
) -> Result<Value, String> {
    let mut args: Vec<&str> = vec!["snippet", "apply", &name, "--project", &project, "--json"];
    if let Some(ref rel) = relative_path {
        args.push("--file");
        args.push(rel);
    }
    run_hub_json(&args)
}

#[tauri::command]
pub fn snippet_remove(
    name: String,
    project: String,
    relative_path: Option<String>,
    force: bool,
) -> Result<Value, String> {
    let mut args: Vec<&str> = vec!["snippet", "remove", &name, "--project", &project, "--json"];
    if let Some(ref rel) = relative_path {
        args.push("--file");
        args.push(rel);
    }
    if force {
        args.push("--force");
    }
    run_hub_json(&args)
}

#[tauri::command]
pub fn snippet_update(
    name: String,
    project: Option<String>,
    relative_path: Option<String>,
    all: bool,
    force: bool,
) -> Result<Value, String> {
    let mut args: Vec<&str> = vec!["snippet", "update", &name, "--json"];
    if all {
        args.push("--all");
    }
    if let Some(ref p) = project {
        args.push("--project");
        args.push(p);
    }
    if let Some(ref rel) = relative_path {
        args.push("--file");
        args.push(rel);
    }
    if force {
        args.push("--force");
    }
    run_hub_json(&args)
}

#[tauri::command]
pub fn snippet_status(name: Option<String>, project: Option<String>) -> Result<Value, String> {
    let mut args: Vec<&str> = vec!["snippet", "status", "--json"];
    if let Some(ref n) = name {
        args.push("--name");
        args.push(n);
    }
    if let Some(ref p) = project {
        args.push("--project");
        args.push(p);
    }
    run_hub_json(&args)
}
