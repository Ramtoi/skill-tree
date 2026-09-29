use super::*;
use tempfile::TempDir;

fn write(root: &Path, rel: &str, content: &str) {
    let abs = root.join(rel);
    fs::create_dir_all(abs.parent().unwrap()).unwrap();
    fs::write(abs, content).unwrap();
}

fn canon(td: &TempDir) -> PathBuf {
    // macOS `/var` → `/private/var`: compare like for like everywhere.
    td.path().canonicalize().unwrap()
}

fn rels(list: &SkillFileList) -> Vec<&str> {
    list.files.iter().map(|f| f.rel.as_str()).collect()
}

fn find<'a>(list: &'a SkillFileList, rel: &str) -> &'a SkillFileEntry {
    list.files
        .iter()
        .find(|f| f.rel == rel)
        .unwrap_or_else(|| panic!("no entry for {rel} in {:?}", rels(list)))
}

fn registry_yaml(entries: &str) -> Value {
    serde_yaml::from_str(entries).unwrap()
}

// ── 1. Listing shape ────────────────────────────────────────────────────

#[test]
fn lists_skill_md_first_then_sorted_rels_with_junk_pruned() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "---\nname: probe\n---\n\nbody\n");
    write(&root, "references/a.md", "# a\n");
    write(&root, "references/b.md", "# b\n");
    write(&root, "scripts/run.py", "print('hi')\n");
    write(&root, "notes.txt", "plain\n");
    write(&root, "config.json", "{}\n");
    // Junk that must never appear.
    write(&root, ".git/config", "[core]\n");
    write(&root, "__pycache__/mod.cpython-311.pyc", "x");
    write(&root, "scripts/run.pyc", "x");
    write(&root, ".DS_Store", "x");
    write(&root, "references/.DS_Store", "x");
    write(&root, ".hub-bak-20260101/old.md", "old\n");
    write(&root, "node_modules/pkg/index.js", "1\n");

    let list = list_files_in_root(&root);

    assert_eq!(
        rels(&list),
        vec![
            "SKILL.md",
            "config.json",
            "notes.txt",
            "references/a.md",
            "references/b.md",
            "scripts/run.py",
        ],
        "SKILL.md must lead, the rest sorted by posix rel, junk pruned"
    );
    assert!(!list.truncated);
    assert_eq!(list.root, root.to_string_lossy());

    assert_eq!(find(&list, "references/a.md").kind, FileKind::Markdown);
    assert_eq!(find(&list, "scripts/run.py").kind, FileKind::Script);
    assert_eq!(find(&list, "notes.txt").kind, FileKind::Text);
    assert_eq!(find(&list, "config.json").kind, FileKind::Data);
    assert!(find(&list, "scripts/run.py").editable);
    assert!(find(&list, "scripts/run.py").reason.is_none());
    assert_eq!(find(&list, "references/a.md").size, 4);
}

// ── 2. Symlinks (amendment A1) ──────────────────────────────────────────

#[cfg(unix)]
#[test]
fn escaping_symlink_is_listed_as_non_editable_and_inside_symlink_is_a_normal_entry() {
    let outside = TempDir::new().unwrap();
    let outside_file = outside.path().join("elsewhere.md");
    fs::write(&outside_file, "not ours\n").unwrap();

    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "x\n");
    write(&root, "references/real.md", "# real\n");
    fs::create_dir_all(root.join("links")).unwrap();
    std::os::unix::fs::symlink(&outside_file, root.join("links/escape.md")).unwrap();
    std::os::unix::fs::symlink(
        root.join("references/real.md"),
        root.join("links/inside.md"),
    )
    .unwrap();
    // A link to an outside DIRECTORY must be listed, never descended into.
    std::os::unix::fs::symlink(outside.path(), root.join("links/outdir")).unwrap();

    let list = list_files_in_root(&root);

    let escape = find(&list, "links/escape.md");
    assert!(!escape.editable);
    assert_eq!(escape.reason.as_deref(), Some("symlink_outside"));
    assert_eq!(escape.kind, FileKind::Other);
    assert_eq!(escape.size, 0);

    let inside = find(&list, "links/inside.md");
    assert!(
        inside.editable,
        "a link that stays inside the root is a normal file"
    );
    assert_eq!(inside.kind, FileKind::Markdown);

    let outdir = find(&list, "links/outdir");
    assert_eq!(outdir.reason.as_deref(), Some("symlink_outside"));
    assert!(
        !rels(&list).iter().any(|r| r.starts_with("links/outdir/")),
        "an escaping directory link must not be descended into: {:?}",
        rels(&list)
    );

    // Reads/writes still refuse the escaping link (A1).
    let err = read_file_in_root(&root, "links/escape.md").unwrap_err();
    assert!(err.starts_with("outside:"), "{err}");
    let err = write_file_in_root(&root, "links/escape.md", "nope", None).unwrap_err();
    assert!(err.starts_with("outside:"), "{err}");
    assert_eq!(
        fs::read_to_string(&outside_file).unwrap(),
        "not ours\n",
        "the outside file must be untouched"
    );

    // …but the in-root link reads and writes fine.
    let read = read_file_in_root(&root, "links/inside.md").unwrap();
    assert_eq!(read.content, "# real\n");
}

/// 1a: a save through an in-root symlink must land on the LINK TARGET. A
/// bare `fs::rename` replaces the link instead, which turns the row into a
/// regular file and leaves the real file holding stale bytes.
#[cfg(unix)]
#[test]
fn write_follows_an_in_root_symlink_instead_of_replacing_it() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "x\n");
    write(&root, "references/real.md", "# real\n");
    fs::create_dir_all(root.join("links")).unwrap();
    std::os::unix::fs::symlink(
        root.join("references/real.md"),
        root.join("links/inside.md"),
    )
    .unwrap();

    let before = read_file_in_root(&root, "links/inside.md").unwrap();
    write_file_in_root(&root, "links/inside.md", "# edited\n", Some(&before.hash)).unwrap();

    assert_eq!(
        fs::read_to_string(root.join("references/real.md")).unwrap(),
        "# edited\n",
        "the write must reach the link target"
    );
    assert!(
        fs::symlink_metadata(root.join("links/inside.md"))
            .unwrap()
            .file_type()
            .is_symlink(),
        "the link itself must survive the write"
    );
    // And the two rows still read the same bytes — no divergence.
    assert_eq!(
        read_file_in_root(&root, "links/inside.md").unwrap().content,
        read_file_in_root(&root, "references/real.md")
            .unwrap()
            .content
    );
}

// ── 3. Binary detection ─────────────────────────────────────────────────

#[test]
fn nul_bytes_and_binary_extensions_are_non_editable() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "x\n");
    fs::write(root.join("data.bin"), [0x89u8, 0x00, 0x01, 0x02]).unwrap();
    // Binary by extension — no NUL needed, and the sniff is skipped.
    write(
        &root,
        "assets/logo.png",
        "not really a png, but no NUL either",
    );

    let list = list_files_in_root(&root);

    let bin = find(&list, "data.bin");
    assert_eq!(bin.kind, FileKind::Binary);
    assert!(!bin.editable);
    assert_eq!(bin.reason.as_deref(), Some("binary"));

    let png = find(&list, "assets/logo.png");
    assert_eq!(png.kind, FileKind::Binary);
    assert!(!png.editable);
    assert_eq!(png.reason.as_deref(), Some("binary"));

    // A text file with a NUL in it is binary too, extension notwithstanding.
    fs::write(root.join("weird.md"), b"# title\n\0trailer").unwrap();
    let list = list_files_in_root(&root);
    assert_eq!(find(&list, "weird.md").kind, FileKind::Binary);
}

// ── 4. Bounds ───────────────────────────────────────────────────────────

#[test]
fn truncates_at_max_files() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "x\n");
    for i in 0..(MAX_FILES + 40) {
        write(&root, &format!("many/f{i:04}.md"), "x\n");
    }
    let list = list_files_in_root(&root);
    assert!(list.truncated, "walk must report truncation");
    assert_eq!(list.files.len(), MAX_FILES);
}

#[test]
fn stops_descending_past_max_depth() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "x\n");
    // rel component counts 2..=11 (`d1/leaf.md` = 2 … `d1/…/d10/leaf.md` = 11).
    let mut dir = String::new();
    for level in 1..=10 {
        dir = if dir.is_empty() {
            format!("d{level}")
        } else {
            format!("{dir}/d{level}")
        };
        write(&root, &format!("{dir}/leaf.md"), "x\n");
    }

    let list = list_files_in_root(&root);
    for rel in rels(&list) {
        assert!(
            rel.split('/').count() <= MAX_DEPTH,
            "{rel} is deeper than MAX_DEPTH={MAX_DEPTH}"
        );
    }
    assert!(
        rels(&list).contains(&"d1/d2/d3/d4/d5/d6/d7/leaf.md"),
        "the deepest allowed file must still be listed: {:?}",
        rels(&list)
    );
    assert!(
        !rels(&list)
            .iter()
            .any(|r| r.starts_with("d1/d2/d3/d4/d5/d6/d7/d8/")),
        "nothing below MAX_DEPTH may be listed: {:?}",
        rels(&list)
    );
}

// ── 5. Registry resolution ──────────────────────────────────────────────

// (F2, plans/E1.md) The blanket `type == "mcp-server"` refusal is gone —
// `skill_files_list` now tells FILES truth for a real scaffolded server in
// the BUILT app, not only under the vitest mock. Case 29's two tests:

#[test]
fn mcp_server_with_a_real_folder_lists_like_a_skill() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "---\nname: fs-mcp\n---\n\nbody\n");
    write(&root, "server.py", "print('serve')\n");
    let reg = registry_yaml(&format!(
        "skills:\n  fs-mcp:\n    source: {}\n    type: mcp-server\n",
        root.display()
    ));

    let list = list_files_for(&reg, "fs-mcp").expect("a real folder must list, not error");

    assert_eq!(rels(&list), vec!["SKILL.md", "server.py"]);
    assert!(!list.truncated);
}

#[test]
fn mcp_server_with_no_source_or_skill_md_only_returns_empty_never_err() {
    // No `source` at all — the control-plane entry (Python writes `source:
    // null`).
    let reg = registry_yaml("skills:\n  skill-hub-mcp:\n    source: null\n    type: mcp-server\n");
    let list = list_files_for(&reg, "skill-hub-mcp").expect("must be Ok, never Err");
    assert!(list.files.is_empty());
    assert!(!list.truncated);

    // A real folder that holds nothing beyond SKILL.md — a registered-remote
    // server (`hub mcp add`), which scaffolds no server code.
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "---\nname: context7\n---\n\nbody\n");
    let reg = registry_yaml(&format!(
        "skills:\n  context7:\n    source: {}\n    type: mcp-server\n",
        root.display()
    ));
    let list = list_files_for(&reg, "context7").expect("must be Ok, never Err");
    assert!(list.files.is_empty(), "{:?}", rels(&list));
    assert!(!list.truncated);

    // A non-mcp skill's resolution failure is UNCHANGED — still a real error.
    let reg = registry_yaml("skills: {}\n");
    let err = list_files_for(&reg, "ghost").unwrap_err();
    assert_eq!(err, "Skill 'ghost' not found in registry");
}

#[test]
fn refuses_relative_source_missing_dir_and_unknown_skill() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);

    // A relative `source` (the live registry really has one: `source: .`)
    // must never resolve against the process CWD.
    let reg = registry_yaml("skills:\n  rel:\n    source: '.'\n    type: claude-skill\n");
    let err = skill_root_from_registry(&reg, "rel").unwrap_err();
    assert!(err.contains("no readable directory"), "{err}");

    let reg = registry_yaml(&format!(
        "skills:\n  gone:\n    source: {}/nope\n    type: claude-skill\n",
        root.display()
    ));
    let err = skill_root_from_registry(&reg, "gone").unwrap_err();
    assert!(err.contains("no readable directory"), "{err}");

    // `source` pointing at a FILE is not a skill dir either.
    let file = root.join("SKILL.md");
    fs::write(&file, "x").unwrap();
    let reg = registry_yaml(&format!(
        "skills:\n  afile:\n    source: {}\n    type: claude-skill\n",
        file.display()
    ));
    let err = skill_root_from_registry(&reg, "afile").unwrap_err();
    assert!(err.contains("not a directory"), "{err}");

    let reg = registry_yaml("skills: {}\n");
    let err = skill_root_from_registry(&reg, "ghost").unwrap_err();
    assert_eq!(err, "Skill 'ghost' not found in registry");
}

// (S6) The `mcp-server` type guard removed from `skill_root_from_registry`
// widened the WRITE paths (`read_file_for`/`write_file_for`/`create_file_for`)
// to mcp-server entries too, not just the LIST path F2 asked for. A relative
// `source: "."` (the live registry shape the removed guard's own comment
// named) is still refused for these — the pre-existing relative-source
// rejection guards it regardless of skill type, so no CWD is ever walked.
#[test]
fn mcp_server_with_relative_source_is_refused_on_every_write_path() {
    let reg = registry_yaml("skills:\n  dotsrc:\n    source: '.'\n    type: mcp-server\n");

    let err = read_file_for(&reg, "dotsrc", "SKILL.md").unwrap_err();
    assert!(err.contains("no readable directory"), "{err}");

    let err = write_file_for(&reg, "dotsrc", "SKILL.md", "x", None).unwrap_err();
    assert!(err.contains("no readable directory"), "{err}");

    let err = create_file_for(&reg, "dotsrc", "new.md").unwrap_err();
    assert!(err.contains("no readable directory"), "{err}");
}

#[test]
fn resolves_a_plain_skill_dir_and_reads_managed_flags() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    let reg = registry_yaml(&format!(
        "skills:\n  local:\n    source: {r}\n    type: claude-skill\n    managed: local\n  \
         ext:\n    source: {r}\n    type: claude-skill\n    managed: external\n  \
         starter:\n    source: {r}\n    type: claude-skill\n    managed: starter\n",
        r = root.display()
    ));
    assert_eq!(skill_root_from_registry(&reg, "local").unwrap(), root);
    assert!(!is_read_only(&reg, "local"));
    assert!(is_read_only(&reg, "ext"));
    assert!(is_read_only(&reg, "starter"));
}

// ── 6. Read guards ──────────────────────────────────────────────────────

#[test]
fn read_refuses_traversal_absolute_and_backslash_rels() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "hello\n");
    write(&root, "references/a.md", "# a\n");
    // A sibling of the skill dir that traversal would otherwise reach.
    fs::write(td.path().join("secret.md"), "secret\n").ok();

    for bad in [
        "../secret.md",
        "/etc/passwd",
        "references/../../secret.md",
        "..\\secret.md",
        "references\\a.md",
        "",
        "   ",
        "./SKILL.md",
        // 1c: a NUL is refused HERE, with the prefix, instead of falling
        // through to an unprefixed OS `CString` error.
        "references/a\0b.md",
        "\0",
    ] {
        let err = read_file_in_root(&root, bad).unwrap_err();
        assert!(
            err.starts_with("outside:"),
            "rel {bad:?} should be refused with `outside:`, got {err}"
        );
    }

    // The happy path still works.
    assert_eq!(
        read_file_in_root(&root, "references/a.md").unwrap().content,
        "# a\n"
    );
}

#[test]
fn read_reports_not_found_binary_and_too_large() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "hello\n");
    fs::create_dir_all(root.join("references")).unwrap();
    fs::write(root.join("bin.dat"), [b'a', 0x00, b'b']).unwrap();
    fs::write(
        root.join("huge.md"),
        vec![b'x'; (MAX_EDITOR_BYTES + 1) as usize],
    )
    .unwrap();

    let err = read_file_in_root(&root, "missing.md").unwrap_err();
    assert!(err.starts_with("not_found:"), "{err}");

    // A directory is not a regular file.
    let err = read_file_in_root(&root, "references").unwrap_err();
    assert!(err.starts_with("not_found:"), "{err}");

    let err = read_file_in_root(&root, "bin.dat").unwrap_err();
    assert!(err.starts_with("binary:"), "{err}");

    let err = read_file_in_root(&root, "huge.md").unwrap_err();
    assert!(err.starts_with("too_large:"), "{err}");
}

#[test]
fn read_returns_the_hash_write_expects() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "references/a.md", "# a\n");
    let read = read_file_in_root(&root, "references/a.md").unwrap();
    assert_eq!(read.rel, "references/a.md");
    assert_eq!(read.size, 4);
    assert_eq!(read.hash, hash_bytes(b"# a\n"));
    // Round-trips through write's optimistic-concurrency check.
    write_file_in_root(&root, "references/a.md", "# b\n", Some(&read.hash)).unwrap();
}

// ── 7. Write guards ─────────────────────────────────────────────────────

#[test]
fn write_round_trips_and_changes_the_hash() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "scripts/run.py", "print(1)\n");

    let before = read_file_in_root(&root, "scripts/run.py").unwrap();
    let res =
        write_file_in_root(&root, "scripts/run.py", "print(2)\n", Some(&before.hash)).unwrap();
    assert_ne!(res.hash, before.hash);

    let after = read_file_in_root(&root, "scripts/run.py").unwrap();
    assert_eq!(after.content, "print(2)\n");
    assert_eq!(after.hash, res.hash);
    // No staging file survives the atomic rename.
    assert!(!root.join("scripts/.run.py.skill-files.tmp").exists());
}

#[test]
fn write_preserves_bytes_exactly_including_a_missing_trailing_newline() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "notes.txt", "seed\n");

    let body = "no trailing newline";
    write_file_in_root(&root, "notes.txt", body, None).unwrap();
    assert_eq!(fs::read(root.join("notes.txt")).unwrap(), body.as_bytes());

    let body2 = "\r\nCRLF and  trailing spaces   \n\n";
    write_file_in_root(&root, "notes.txt", body2, None).unwrap();
    assert_eq!(fs::read(root.join("notes.txt")).unwrap(), body2.as_bytes());
}

#[test]
fn write_rejects_a_stale_expected_hash() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "references/a.md", "# a\n");
    let stale = read_file_in_root(&root, "references/a.md").unwrap().hash;

    // Somebody else edits the file.
    write(&root, "references/a.md", "# edited elsewhere\n");

    let err = write_file_in_root(&root, "references/a.md", "# mine\n", Some(&stale)).unwrap_err();
    assert!(err.starts_with("conflict:"), "{err}");
    assert_eq!(
        fs::read_to_string(root.join("references/a.md")).unwrap(),
        "# edited elsewhere\n",
        "a conflict must not clobber the newer bytes"
    );

    // No expected hash = deliberate force; it goes through.
    write_file_in_root(&root, "references/a.md", "# mine\n", None).unwrap();
}

#[test]
fn write_refuses_a_missing_file_and_traversal() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "x\n");

    let err = write_file_in_root(&root, "references/new.md", "hi", None).unwrap_err();
    assert!(err.starts_with("not_found:"), "{err}");
    assert!(
        !root.join("references").exists(),
        "a write must never create directories"
    );

    for bad in [
        "../escape.md",
        "/tmp/escape.md",
        "a/../../escape.md",
        "x\\y.md",
    ] {
        let err = write_file_in_root(&root, bad, "hi", None).unwrap_err();
        assert!(err.starts_with("outside:"), "rel {bad:?} → {err}");
    }
}

#[test]
fn write_refuses_a_source_managed_skill_without_touching_disk() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "references/a.md", "upstream\n");
    let reg = registry_yaml(&format!(
        "skills:\n  \
           ext:\n    source: {r}\n    type: claude-skill\n    managed: external\n  \
           starter:\n    source: {r}\n    type: claude-skill\n    managed: starter\n  \
           mine:\n    source: {r}\n    type: claude-skill\n    managed: local\n",
        r = root.display()
    ));

    for name in ["ext", "starter"] {
        let err = write_file_for(&reg, name, "references/a.md", "mine\n", None).unwrap_err();
        assert!(err.starts_with("read_only:"), "{name} → {err}");
    }
    assert_eq!(
        fs::read_to_string(root.join("references/a.md")).unwrap(),
        "upstream\n",
        "a read-only refusal must not have written anything"
    );

    // A hub-owned skill at the very same path writes fine — the gate is the
    // `managed` flag, not the location.
    write_file_for(&reg, "mine", "references/a.md", "mine\n", None).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("references/a.md")).unwrap(),
        "mine\n"
    );

    // Reading a source-managed skill is always allowed.
    assert_eq!(
        read_file_for(&reg, "ext", "references/a.md")
            .unwrap()
            .content,
        "mine\n"
    );
    assert!(!list_files_for(&reg, "ext").unwrap().files.is_empty());
}

// ── A2. Create ──────────────────────────────────────────────────────────

#[test]
fn create_makes_an_empty_file_and_its_missing_parents() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "x\n");

    let res = create_file_in_root(&root, "references/deep/new.md").unwrap();
    assert_eq!(res.hash, hash_bytes(b""));
    assert_eq!(
        fs::read_to_string(root.join("references/deep/new.md")).unwrap(),
        ""
    );

    // It is immediately listable and writable.
    let list = list_files_in_root(&root);
    let entry = find(&list, "references/deep/new.md");
    assert!(entry.editable);
    assert_eq!(entry.size, 0);
    write_file_in_root(&root, "references/deep/new.md", "# hi\n", Some(&res.hash)).unwrap();
}

/// 1b: a failed write must not leave the directory chain it just built
/// behind. Directories are never listed, so the clutter would be invisible.
/// The failure is forced with an over-long basename (ENAMETOOLONG): the
/// parents are creatable, the file is not.
#[test]
fn create_rolls_back_the_dirs_it_made_when_the_write_fails() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "x\n");
    write(&root, "references/keep.md", "# keep\n");

    let long = "x".repeat(300);
    let err = create_file_in_root(&root, &format!("references/deep/{long}.md")).unwrap_err();
    assert!(err.starts_with("Cannot stage write at"), "{err}");

    assert!(
        !root.join("references/deep").exists(),
        "the directory the failed create made must be removed again"
    );
    // Only what THIS call made is rolled back — pre-existing dirs stay.
    assert_eq!(
        fs::read_to_string(root.join("references/keep.md")).unwrap(),
        "# keep\n"
    );
}

#[test]
fn topmost_missing_dir_stops_at_the_root_and_at_the_first_existing_dir() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    fs::create_dir_all(root.join("references")).unwrap();

    // Nothing missing.
    assert_eq!(topmost_missing_dir(&root, &root.join("references")), None);
    // Missing chain under an existing dir → the shallowest missing one.
    assert_eq!(
        topmost_missing_dir(&root, &root.join("references/a/b")),
        Some(root.join("references/a"))
    );
    // The root itself is never a rollback candidate.
    assert_eq!(topmost_missing_dir(&root, &root), None);
}

#[test]
fn create_refuses_an_existing_path() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "keep me\n");
    fs::create_dir_all(root.join("references")).unwrap();

    let err = create_file_in_root(&root, "SKILL.md").unwrap_err();
    assert!(err.starts_with("exists:"), "{err}");
    assert_eq!(
        fs::read_to_string(root.join("SKILL.md")).unwrap(),
        "keep me\n",
        "create must never truncate an existing file"
    );

    // A directory occupies the name too.
    let err = create_file_in_root(&root, "references").unwrap_err();
    assert!(err.starts_with("exists:"), "{err}");
}

#[test]
fn create_refuses_traversal_and_never_builds_dirs_outside_the_root() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "x\n");

    for bad in [
        "../escape.md",
        "/tmp/skill-files-escape.md",
        "a/../../escape.md",
        "x\\y.md",
        "",
    ] {
        let err = create_file_in_root(&root, bad).unwrap_err();
        assert!(err.starts_with("outside:"), "rel {bad:?} → {err}");
    }
    assert!(!td.path().join("escape.md").exists());
}

#[cfg(unix)]
#[test]
fn create_refuses_a_path_under_an_escaping_symlinked_dir() {
    let outside = TempDir::new().unwrap();
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "x\n");
    std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();

    // The parent (`link/nested`) does not exist, so only an explicit
    // ancestor walk catches this — `resolve_in_project`'s fallback would
    // normalize it to `<root>/link/nested` and let it through.
    let err = create_file_in_root(&root, "link/nested/new.md").unwrap_err();
    assert!(err.starts_with("outside:"), "{err}");
    assert!(
        !outside.path().join("nested").exists(),
        "create_dir_all must not have escaped the skill root"
    );
}

#[test]
fn create_refuses_a_source_managed_skill_without_touching_disk() {
    let td = TempDir::new().unwrap();
    let root = canon(&td);
    write(&root, "SKILL.md", "x\n");
    let reg = registry_yaml(&format!(
        "skills:\n  \
           starter:\n    source: {r}\n    type: claude-skill\n    managed: starter\n  \
           ext:\n    source: {r}\n    type: claude-skill\n    managed: external\n",
        r = root.display()
    ));

    for name in ["starter", "ext"] {
        let err = create_file_for(&reg, name, "references/new.md").unwrap_err();
        assert!(err.starts_with("read_only:"), "{name} → {err}");
    }
    assert!(
        !root.join("references").exists(),
        "a read-only refusal must not have created directories"
    );
}
