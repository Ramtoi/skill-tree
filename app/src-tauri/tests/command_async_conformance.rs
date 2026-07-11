//! Conformance gate for the ui-responsiveness M1 sweep.
//!
//! Every `#[tauri::command]` fn runs on Tauri's main thread when it is a plain
//! `pub fn`. A sync command that shells out to `python3 hub.py` (directly, via
//! `Command::new`, or via any of the `run_hub*`/`hub_cmd` helpers) or walks the
//! filesystem freezes the whole UI for the duration of that subprocess/scan —
//! this was the root cause of the "beachball on every click" bug fixed in
//! `ui-responsiveness` M1. The fix pattern is: keep the existing logic in a
//! `*_impl` fn, and make the `#[tauri::command]` boundary an `async fn` that
//! delegates to it via `tauri::async_runtime::spawn_blocking`.
//!
//! This test parses the command source files as text (no crate dependency —
//! `commands` is a private module) and asserts every `#[tauri::command]` fn is
//! `async fn`, unless its name is explicitly allowlisted below with a
//! justification. Add a new sync command to `SYNC_ALLOWED` ONLY if it
//! provably does no subprocess/scan work; otherwise this test must fail so a
//! future sync subprocess command can never sneak back in.

use std::fs;
use std::path::Path;

/// Commands that may stay `pub fn` (sync) because they provably do no
/// subprocess spawn and no non-trivial filesystem scan — each with its own
/// one-line justification. Everything else must be `async fn`.
const SYNC_ALLOWED: &[(&str, &str)] = &[
    (
        "path_exists",
        "a single std::path::Path::exists() stat call — no subprocess, no scan",
    ),
    (
        "create_empty_file",
        "one OpenOptions::create_new() call — no subprocess, no scan",
    ),
    (
        "permissions_risks_schema",
        "parses a build-embedded JSON string already resident in the binary — no subprocess, no filesystem access at all",
    ),
];

struct CommandSig {
    file: String,
    name: String,
    is_async: bool,
}

/// Extract every `#[tauri::command]`-annotated fn signature from a source
/// file's text. Tolerates blank lines between the attribute and the fn
/// signature but assumes no other attributes are interposed (true today).
fn extract_commands(file_name: &str, content: &str) -> Vec<CommandSig> {
    let lines: Vec<&str> = content.lines().collect();
    let mut out = Vec::new();

    for (i, line) in lines.iter().enumerate() {
        if line.trim() != "#[tauri::command]" {
            continue;
        }
        // Find the next non-blank line, which must be the fn signature
        // (possibly spanning multiple lines for the args list — we only need
        // the first line to detect `async` and the fn name).
        let sig_line = lines[i + 1..]
            .iter()
            .find(|l| !l.trim().is_empty())
            .unwrap_or_else(|| {
                panic!("{file_name}: #[tauri::command] at line {} has no following fn", i + 1)
            });
        let trimmed = sig_line.trim();
        assert!(
            trimmed.contains("fn "),
            "{file_name}: expected a fn signature after #[tauri::command] at line {}, got: {trimmed:?}",
            i + 1
        );
        let is_async = trimmed.contains("async fn");
        let name = trimmed
            .split("fn ")
            .nth(1)
            .and_then(|rest| rest.split(['(', '<', ' ']).next())
            .unwrap_or("")
            .to_string();
        assert!(
            !name.is_empty(),
            "{file_name}: could not extract fn name from: {trimmed:?}"
        );
        out.push(CommandSig {
            file: file_name.to_string(),
            name,
            is_async,
        });
    }

    out
}

#[test]
fn every_tauri_command_is_async_unless_explicitly_allowlisted() {
    let commands_dir = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/commands"));
    assert!(
        commands_dir.is_dir(),
        "expected {} to exist",
        commands_dir.display()
    );

    let mut all_commands: Vec<CommandSig> = Vec::new();
    let mut entries: Vec<_> = fs::read_dir(commands_dir)
        .expect("read src/commands")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("rs"))
        .collect();
    entries.sort();

    for path in entries {
        let content = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let file_name = path.file_name().unwrap().to_string_lossy().into_owned();
        all_commands.extend(extract_commands(&file_name, &content));
    }

    assert!(
        all_commands.len() > 50,
        "expected to find the full command surface (~90 fns), only found {}; \
         the parser likely broke on a source layout change",
        all_commands.len()
    );

    let allowed_names: Vec<&str> = SYNC_ALLOWED.iter().map(|(n, _)| *n).collect();

    let mut violations: Vec<String> = Vec::new();
    for cmd in &all_commands {
        if cmd.is_async {
            continue;
        }
        if allowed_names.contains(&cmd.name.as_str()) {
            continue;
        }
        violations.push(format!(
            "{} :: {} is a sync #[tauri::command] not in SYNC_ALLOWED — it runs on \
             Tauri's main thread and will freeze the UI if it spawns a subprocess or \
             scans the filesystem. Either make it `async fn` delegating to a `*_impl` \
             via tauri::async_runtime::spawn_blocking, or add it to SYNC_ALLOWED with a \
             justification proving it does neither.",
            cmd.file, cmd.name
        ));
    }

    assert!(
        violations.is_empty(),
        "\n{} sync #[tauri::command] fn(s) found outside SYNC_ALLOWED:\n\n{}\n",
        violations.len(),
        violations.join("\n\n")
    );

    // Every allowlisted name must actually exist and actually be sync — an
    // allowlist entry for a renamed/removed/now-async command is dead weight
    // that silently widens the gate.
    for (name, _) in SYNC_ALLOWED {
        let found = all_commands.iter().find(|c| &c.name == name);
        match found {
            None => panic!(
                "SYNC_ALLOWED entry {name:?} does not match any #[tauri::command] fn — \
                 remove the stale entry"
            ),
            Some(cmd) => assert!(
                !cmd.is_async,
                "SYNC_ALLOWED entry {name:?} is now `async fn` in {} — remove it from \
                 the allowlist",
                cmd.file
            ),
        }
    }
}
