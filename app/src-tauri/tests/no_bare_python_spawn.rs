//! Conformance gate: no production spawn site may hardcode the interpreter.
//!
//! A `.app` launched from Finder/Dock inherits a truncated `$PATH`
//! (`/usr/bin:/bin:/usr/sbin:/sbin`) and does not source the user's shell
//! profile, so a bare `Command::new("python3")` resolves to nothing on a
//! machine whose only Python is Homebrew's — and to the wrong interpreter on a
//! machine that ships the bundled runtime. Every production spawn must go
//! through `resolved_python()` (bundled runtime → known dirs → `$PATH`), which
//! is exactly why `hub.rs::resolved_python` exists.
//!
//! This test parses `src/commands/*.rs` as text (no crate dependency —
//! `commands` is a private module, same constraint as
//! `command_async_conformance.rs`), drops every `#[cfg(test)]` region, and
//! asserts no remaining line spawns a string-literal interpreter. Test code may
//! still hardcode a binary: a unit test runs from a shell with a real `$PATH`.

use std::fs;
use std::path::Path;

/// A source line that survived `#[cfg(test)]` stripping, with its 1-based
/// line number in the original file.
struct Line {
    number: usize,
    text: String,
}

/// Remove every `#[cfg(test)]`-annotated item from `content` by brace matching
/// from the attribute to the end of the item it annotates. Handles the three
/// shapes present in this crate: `mod tests { … }`, `thread_local! { … }`,
/// a bare `fn … { … }`, and an inline `#[cfg(test)] { … }` block inside a fn.
fn strip_cfg_test(content: &str) -> Vec<Line> {
    let lines: Vec<&str> = content.lines().collect();
    let mut out = Vec::new();
    let mut i = 0usize;

    while i < lines.len() {
        if lines[i].trim() != "#[cfg(test)]" {
            out.push(Line {
                number: i + 1,
                text: lines[i].to_string(),
            });
            i += 1;
            continue;
        }

        // Skip forward to the closing brace of the annotated item — or past a
        // brace-less declaration (`mod tests;`, the out-of-file test layout of
        // wave 20 in AUDIT.md; the test file itself is never scanned here).
        let mut j = i;
        let mut depth = 0usize;
        let mut opened = false;
        let mut declaration_only = false;
        while j < lines.len() {
            if j > i && !opened && !lines[j].contains('{') && lines[j].trim_end().ends_with(';') {
                declaration_only = true;
                break;
            }
            for ch in lines[j].chars() {
                match ch {
                    '{' => {
                        depth += 1;
                        opened = true;
                    }
                    '}' => depth = depth.saturating_sub(1),
                    _ => {}
                }
            }
            if opened && depth == 0 {
                break;
            }
            j += 1;
        }
        assert!(
            opened || declaration_only,
            "strip_cfg_test: #[cfg(test)] at line {} has no braced item",
            i + 1
        );
        i = j + 1;
    }

    out
}

fn command_source_files() -> Vec<std::path::PathBuf> {
    let commands_dir = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/commands"));
    assert!(
        commands_dir.is_dir(),
        "expected {} to exist",
        commands_dir.display()
    );
    // One level deep, skipping `<module>/tests.rs` (the out-of-file test layout
    // of wave 20 in AUDIT.md): those files are test-only and carry no
    // `#[cfg(test)]` marker, so they must not be read as production code —
    // while a production file under `src/commands/<module>/` stays gated.
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
                    .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("rs"))
                    .filter(|p| p.file_name().and_then(|n| n.to_str()) != Some("tests.rs")),
            );
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            entries.push(path);
        }
    }
    entries.sort();
    entries
}

#[test]
fn no_production_spawn_hardcodes_an_interpreter() {
    let files = command_source_files();
    assert!(
        files.len() > 10,
        "expected the full command surface, found {} files",
        files.len()
    );

    let mut violations: Vec<String> = Vec::new();
    // Positive/negative controls proving the stripper actually ran: see below.
    let mut kept_total = 0usize;
    let mut kept_resolved_python = 0usize;
    let mut kept_test_only_literal = 0usize;

    for path in &files {
        let content =
            fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let file_name = path.file_name().unwrap().to_string_lossy().into_owned();

        for line in strip_cfg_test(&content) {
            kept_total += 1;
            if line.text.contains("resolved_python") {
                kept_resolved_python += 1;
            }
            // `Command::new("python3")` lives only in hub.rs's in-file test
            // module — if it survives stripping, the stripper is broken and this
            // gate is blind. (usage.rs's `"true"` fixture moved out of file.)
            if line.text.contains("Command::new(\"python3\")") {
                kept_test_only_literal += 1;
            }

            let trimmed = line.text.trim_start();
            if trimmed.starts_with("//") || trimmed.starts_with("///") {
                continue;
            }
            // A string literal directly inside `Command::new(...)` means the
            // interpreter/binary path was hardcoded rather than resolved.
            if let Some(rest) = line.text.split("Command::new(").nth(1) {
                if rest.trim_start().starts_with('"') {
                    violations.push(format!(
                        "{file_name}:{} — {} spawns a hardcoded string-literal binary. \
                         Production spawns must resolve the interpreter via \
                         `resolved_python()` (see hub.rs), because a Finder-launched \
                         .app has no user `$PATH`.",
                        line.number,
                        trimmed.trim_end()
                    ));
                }
            }
        }
    }

    // Controls — a stripper that ate everything (or nothing) must not pass.
    assert!(
        kept_total > 2000,
        "stripper removed far too much: only {kept_total} production lines left"
    );
    assert!(
        kept_resolved_python > 0,
        "stripper removed production code: no `resolved_python` reference survived"
    );
    assert_eq!(
        kept_test_only_literal, 0,
        "stripper failed: a `Command::new(\"python3\")` line from a #[cfg(test)] module \
         survived, so #[cfg(test)] regions are NOT being excluded"
    );

    assert!(
        violations.is_empty(),
        "\n{} hardcoded-interpreter spawn site(s) in production code:\n\n{}\n",
        violations.len(),
        violations.join("\n\n")
    );
}
