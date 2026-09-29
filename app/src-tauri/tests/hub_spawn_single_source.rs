//! Guard gate for the shared `hub.py` subprocess runner in `commands::mod`
//! (`hub_command`/`hub_run`/`hub_output`/`hub_stdin`/`hub_json`/`hub_json_value`)
//! and for the de-duplicated `hex_encode`/`sha256_hex` helpers.
//!
//! Modelled on `command_async_conformance.rs` / `no_bare_python_spawn.rs`: parses
//! `src/commands/*.rs` as text (no crate dependency — `commands` is a private
//! module) rather than linking against the crate.
//!
//! This file shipped in **slice 1** of the S3 refactor (the runner itself
//! landed in `mod.rs`); slice 2 routed the leaf command bridges through it;
//! slice 3 routed the agent-docs/subagents shared-runner cluster (plus
//! hooks.rs/snippets.rs/remotes.rs, which only imported those helpers) through
//! it too, emptying the migration window this file used to track. Every
//! remaining `Command::new(` occurrence outside `mod.rs` must now match a
//! `SPAWN_ALLOWED` entry — there is no more tolerated-but-pending file.

use std::fs;
use std::path::Path;

/// `(file, arg_text, justification)` — every `Command::new(<arg_text>)` occurrence
/// outside `mod.rs` and outside a `MIGRATION_PENDING` file must match one of these
/// verbatim. `arg_text` is the exact source text between `Command::new(` and its
/// matching close paren, trimmed.
const SPAWN_ALLOWED: &[(&str, &str, &str)] = &[
    (
        "usage.rs",
        "command",
        "ccusage binary, not the hub interpreter",
    ),
    (
        "usage/tests.rs",
        "\"true\"",
        "cfg(test) exit-status fixture",
    ),
    (
        "usage/tests.rs",
        "\"sh\"",
        "cfg(test) exit-code/stdout fixtures for wait_with_timeout + classify_record_outcome",
    ),
    (
        "usage/tests.rs",
        "\"sleep\"",
        "cfg(test) long-lived child for the wait_with_timeout timeout path",
    ),
    (
        "usage/tests.rs",
        "\"kill\"",
        "cfg(test) `kill -0` proves the timed-out child is dead",
    ),
    (
        "hub.rs",
        "path",
        "detect_python `--version` probe (probe_version_once)",
    ),
    (
        "hub.rs",
        "\"python3\"",
        "cfg(test) absolute_system_python fixture",
    ),
    (
        "subagents/tests.rs",
        "python_bin()",
        "cfg(test) live-codex fixtures",
    ),
];

struct Spawn {
    file: String,
    arg_text: String,
}

fn command_source_files() -> Vec<std::path::PathBuf> {
    let commands_dir = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/commands"));
    assert!(
        commands_dir.is_dir(),
        "expected {} to exist",
        commands_dir.display()
    );
    // One level deep: a module's out-of-file tests live in
    // `src/commands/<module>/tests.rs` (wave 20 of AUDIT.md) and their spawns
    // are gated exactly like the in-file ones used to be.
    let mut entries: Vec<_> = Vec::new();
    for entry in fs::read_dir(commands_dir)
        .expect("read src/commands")
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.is_dir() {
            entries.extend(
                fs::read_dir(&path)
                    .expect("read src/commands/<module>")
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("rs")),
            );
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            entries.push(path);
        }
    }
    entries.sort();
    entries
}

/// A file's name relative to `src/commands` (`usage.rs`, `usage/tests.rs`) —
/// the key `SPAWN_ALLOWED` entries use.
fn relative_name(path: &Path) -> String {
    let commands_dir = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/commands"));
    path.strip_prefix(commands_dir)
        .expect("path under src/commands")
        .to_string_lossy()
        .into_owned()
}

/// Extract every `Command::new(...)` call's exact argument text (the source text
/// up to the matching close paren, so a nested-paren argument like
/// `python_bin()` is captured whole rather than truncated at its own `)`).
fn extract_spawns(file_name: &str, content: &str) -> Vec<Spawn> {
    let mut out = Vec::new();
    let bytes = content.as_bytes();
    let needle = "Command::new(";
    let mut search_from = 0usize;

    while let Some(rel) = content[search_from..].find(needle) {
        let start = search_from + rel + needle.len();
        let mut depth = 1usize;
        let mut i = start;
        while i < bytes.len() && depth > 0 {
            match bytes[i] {
                b'(' => depth += 1,
                b')' => depth -= 1,
                _ => {}
            }
            i += 1;
        }
        assert!(
            depth == 0,
            "{file_name}: unbalanced parens after `Command::new(` starting at byte {start}"
        );
        let arg_text = content[start..i - 1].trim().to_string();
        out.push(Spawn {
            file: file_name.to_string(),
            arg_text,
        });
        search_from = i;
    }

    out
}

#[test]
fn every_hub_spawn_goes_through_mod_rs() {
    let files = command_source_files();
    assert!(
        files.len() > 10,
        "expected the full command surface, found {} files",
        files.len()
    );

    let mut all_spawns: Vec<Spawn> = Vec::new();
    for path in &files {
        let content =
            fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let file_name = relative_name(path);
        if file_name == "mod.rs" {
            // mod.rs occurrences are always allowed — it is the one shared runner.
            continue;
        }
        all_spawns.extend(extract_spawns(&file_name, &content));
    }

    assert!(
        !all_spawns.is_empty(),
        "expected at least one Command::new( occurrence outside mod.rs — the parser \
         likely broke on a source layout change"
    );

    let mut allowed_hits = vec![false; SPAWN_ALLOWED.len()];
    let mut violations: Vec<String> = Vec::new();

    for spawn in &all_spawns {
        let mut matched = false;
        for (i, (file, arg_text, _justification)) in SPAWN_ALLOWED.iter().enumerate() {
            if *file == spawn.file && *arg_text == spawn.arg_text {
                allowed_hits[i] = true;
                matched = true;
                break;
            }
        }
        if matched {
            continue;
        }

        violations.push(format!(
            "{}: `Command::new({})` is not in SPAWN_ALLOWED — route this spawn through \
             commands::hub_output / hub_stdin / hub_json / hub_json_value in mod.rs, or add \
             a justified SPAWN_ALLOWED entry if it genuinely is not a hub.py spawn.",
            spawn.file, spawn.arg_text
        ));
    }

    assert!(
        violations.is_empty(),
        "\n{} spawn site(s) outside mod.rs are not accounted for:\n\n{}\n",
        violations.len(),
        violations.join("\n\n")
    );

    // A SPAWN_ALLOWED entry that matches nothing is dead weight that silently
    // widens the gate — the same staleness check command_async_conformance.rs
    // runs on SYNC_ALLOWED.
    for (i, (file, arg_text, justification)) in SPAWN_ALLOWED.iter().enumerate() {
        assert!(
            allowed_hits[i],
            "SPAWN_ALLOWED entry ({file:?}, {arg_text:?}, {justification:?}) matches no \
             occurrence — remove the stale entry"
        );
    }

    // The runner cannot be deleted silently: something must still define it.
    let mod_rs_path = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/commands/mod.rs"));
    let mod_rs = fs::read_to_string(mod_rs_path).expect("read mod.rs");
    assert!(
        mod_rs.contains("fn hub_command"),
        "mod.rs must define hub_command — the shared runner cannot be deleted silently"
    );
    assert!(
        mod_rs.contains("fn hub_run"),
        "mod.rs must define hub_run — the shared runner cannot be deleted silently"
    );
}

#[test]
fn hex_and_sha_helpers_are_defined_once() {
    let files = command_source_files();
    let mut hex_defs: Vec<String> = Vec::new();
    let mut sha_defs: Vec<String> = Vec::new();

    for path in &files {
        let content =
            fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let file_name = relative_name(path);

        for line in content.lines() {
            let t = line.trim_start();
            let is_hex_def = t.starts_with("fn hex_encode(")
                || t.starts_with("pub fn hex_encode(")
                || t.starts_with("pub(crate) fn hex_encode(");
            let is_sha_def = t.starts_with("fn sha256_hex(")
                || t.starts_with("pub fn sha256_hex(")
                || t.starts_with("pub(crate) fn sha256_hex(");
            if is_hex_def {
                hex_defs.push(file_name.clone());
            }
            if is_sha_def {
                sha_defs.push(file_name.clone());
            }
        }
    }

    assert_eq!(
        hex_defs,
        vec!["mod.rs".to_string()],
        "fn hex_encode must be defined exactly once, in mod.rs; found in {hex_defs:?}"
    );
    assert_eq!(
        sha_defs,
        vec!["mod.rs".to_string()],
        "fn sha256_hex must be defined exactly once, in mod.rs; found in {sha_defs:?}"
    );
}
