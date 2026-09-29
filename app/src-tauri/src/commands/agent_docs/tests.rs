use super::*;
use std::fs;
use std::os::unix::fs::symlink;
use tempfile::TempDir;

fn setup_project() -> TempDir {
    TempDir::new().expect("tempdir")
}

fn project_str(td: &TempDir) -> String {
    td.path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

fn multi_policy(strategy: &str) -> CanonicalPolicy {
    CanonicalPolicy {
        requires_claude: true,
        requires_agent: true,
        strategy: strategy.into(),
        claude_harnesses: vec!["claude-code".into()],
        agent_harnesses: vec!["codex".into()],
    }
}

fn with_policy<R>(policy: CanonicalPolicy, f: impl FnOnce() -> R) -> R {
    TEST_POLICY.with(|t| *t.borrow_mut() = Some(policy));
    let out = f();
    TEST_POLICY.with(|t| *t.borrow_mut() = None);
    out
}

// ── Shared corpus: the one status model, pinned against agent_docs.py ──

#[test]
fn corpus_import_cases_match_shared_definition() {
    // The one thing standing between `hub sync` reporting a project `ok`
    // and the app showing an unresolved-import warning on the same file.
    let corpus_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/agent_docs_corpus.json"
    );
    let raw = fs::read_to_string(corpus_path).expect("read corpus");
    let doc: Value = serde_json::from_str(&raw).expect("parse corpus");
    let cases = doc["import_cases"].as_array().expect("import_cases");
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let content = case["content"].as_str().unwrap();
        let expect: Vec<String> = case["expect"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(parse_imports(content), expect, "import case `{name}`");
    }
}

#[test]
fn corpus_verdicts_match_shared_definition() {
    let corpus_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/agent_docs_corpus.json"
    );
    let raw = fs::read_to_string(corpus_path).expect("read corpus");
    let doc: Value = serde_json::from_str(&raw).expect("parse corpus");
    let cases = doc["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let td = TempDir::new().unwrap();
        let root = td.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        let outside = td.path().join("outside");
        for f in case["files"].as_array().unwrap() {
            let rel = f["path"].as_str().unwrap();
            let p = root.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            if f["kind"].as_str().unwrap() == "file" {
                fs::write(&p, f["content"].as_str().unwrap()).unwrap();
            } else {
                let mut target = f["target"].as_str().unwrap().to_string();
                if let Some(ext_rel) = target.strip_prefix("__outside__/") {
                    let ext = outside.join(ext_rel);
                    fs::create_dir_all(ext.parent().unwrap()).unwrap();
                    fs::write(&ext, "# outside\n").unwrap();
                    target = ext.to_string_lossy().into_owned();
                }
                symlink(&target, &p).unwrap();
            }
        }
        let policy = CanonicalPolicy {
            requires_claude: case["requires_claude"].as_bool().unwrap(),
            requires_agent: case["requires_agent"].as_bool().unwrap(),
            strategy: case["strategy"].as_str().unwrap().into(),
            claude_harnesses: Vec::new(),
            agent_harnesses: Vec::new(),
        };
        for (rel, expected) in case["expect"].as_object().unwrap() {
            let dir = if rel.is_empty() {
                root.clone()
            } else {
                root.join(rel)
            };
            let dv = classify_dir(&dir, &root, rel.is_empty(), &policy);
            assert_eq!(
                dv.verdict,
                expected["verdict"].as_str().unwrap(),
                "{name}:{} verdict",
                if rel.is_empty() { "root" } else { rel }
            );
            let mut got = dv.flags.clone();
            got.sort();
            let mut want: Vec<String> = expected["flags"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            want.sort();
            assert_eq!(
                got,
                want,
                "{name}:{} flags",
                if rel.is_empty() { "root" } else { rel }
            );
        }
    }
}

#[test]
fn pointer_plus_extracts_appendix() {
    let td = setup_project();
    let root = td.path().canonicalize().unwrap();
    fs::write(root.join("AGENTS.md"), "# A\n").unwrap();
    fs::write(
        root.join("CLAUDE.md"),
        "@AGENTS.md\n\n- remember: run tests first\n",
    )
    .unwrap();
    let dv = classify_dir(&root, &root, true, &multi_policy("import"));
    assert_eq!(dv.verdict, "pointer_plus_content");
    assert_eq!(
        dv.appendix.as_deref(),
        Some("- remember: run tests first\n")
    );
}

// ── Discovery + listing ──

#[test]
fn known_paths_always_included() {
    let td = setup_project();
    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    for rel in KNOWN_RELS {
        assert!(listing.all_rels.iter().any(|r| r == rel), "missing {rel}");
    }
}

#[test]
fn nested_discovery_finds_files() {
    let td = setup_project();
    let core = td.path().join("core").join("canvas");
    fs::create_dir_all(&core).unwrap();
    fs::write(core.join("CLAUDE.md"), "# nested").unwrap();
    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert!(listing
        .all_rels
        .iter()
        .any(|r| r == "core/canvas/CLAUDE.md"));
}

#[test]
fn all_markdown_mode_finds_project_markdown_files() {
    let td = setup_project();
    let nested = td.path().join("docs").join("guides");
    fs::create_dir_all(&nested).unwrap();
    fs::write(td.path().join("README.md"), "# Readme").unwrap();
    fs::write(td.path().join("AGENTS.md"), "# Agents").unwrap();
    fs::write(nested.join("setup.md"), "# Setup").unwrap();
    fs::write(nested.join("notes.txt"), "not markdown").unwrap();

    let default_listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert!(!default_listing.all_rels.iter().any(|r| r == "README.md"));
    assert!(!default_listing
        .all_rels
        .iter()
        .any(|r| r == "docs/guides/setup.md"));

    let markdown_listing =
        list_agent_docs_impl_with_options(project_str(&td), true, false).expect("list markdown");
    assert!(markdown_listing.all_rels.iter().any(|r| r == "README.md"));
    assert!(markdown_listing.all_rels.iter().any(|r| r == "AGENTS.md"));
    let agents_meta = markdown_listing
        .root
        .files
        .iter()
        .find(|f| f.rel == "AGENTS.md")
        .expect("AGENTS.md listed as a markdown file");
    assert!(!agents_meta.is_known);
    assert!(agents_meta.is_discovered);
    assert!(!markdown_listing.all_rels.iter().any(|r| r == "CLAUDE.md"));
    assert!(markdown_listing
        .all_rels
        .iter()
        .any(|r| r == "docs/guides/setup.md"));
    assert!(!markdown_listing
        .all_rels
        .iter()
        .any(|r| r == "docs/guides/notes.txt"));
}

#[test]
fn generic_markdown_read_write_uses_existing_editor_flow_guards() {
    let td = setup_project();
    let docs = td.path().join("docs");
    fs::create_dir_all(&docs).unwrap();
    fs::write(docs.join("guide.md"), "# Guide\nold").unwrap();

    let content = read_agent_doc_impl(project_str(&td), "docs/guide.md".into())
        .expect("read generic markdown");
    assert_eq!(content.content, "# Guide\nold");

    let res = write_agent_doc_impl(
        project_str(&td),
        "docs/guide.md".into(),
        "# Guide\nnew".into(),
        Some(content.hash),
        Some(false),
    )
    .expect("write generic markdown");
    assert_eq!(res.written[0].rel, "docs/guide.md");
    assert_eq!(
        fs::read_to_string(docs.join("guide.md")).unwrap(),
        "# Guide\nnew"
    );

    let err = read_agent_doc_impl(project_str(&td), "docs/guide.txt".into()).unwrap_err();
    assert!(err.contains("not_allowed_basename"));
}

#[test]
fn ignored_dirs_skipped() {
    let td = setup_project();
    for d in &["node_modules", "target", ".git"] {
        let sub = td.path().join(d);
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("CLAUDE.md"), "# hidden").unwrap();
        fs::write(sub.join("README.md"), "# hidden").unwrap();
    }
    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    let markdown_listing =
        list_agent_docs_impl_with_options(project_str(&td), true, false).expect("list markdown");
    for d in &["node_modules", "target", ".git"] {
        let rel = format!("{d}/CLAUDE.md");
        assert!(
            !listing.all_rels.contains(&rel),
            "should skip ignored dir {d}"
        );
        let readme_rel = format!("{d}/README.md");
        assert!(
            !markdown_listing.all_rels.contains(&readme_rel),
            "all-markdown mode should skip ignored dir {d}"
        );
    }
}

#[test]
fn skills_subdirs_skipped() {
    let td = setup_project();
    let p = td.path().join(".claude").join("skills").join("foo");
    fs::create_dir_all(&p).unwrap();
    fs::write(p.join("CLAUDE.md"), "# in skills").unwrap();
    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert!(!listing
        .all_rels
        .iter()
        .any(|r| r == ".claude/skills/foo/CLAUDE.md"));
}

#[test]
fn missing_known_file_metadata() {
    let td = setup_project();
    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    let claude = listing
        .root
        .files
        .iter()
        .find(|f| f.rel == "CLAUDE.md")
        .expect("CLAUDE.md row");
    assert!(!claude.exists);
    assert!(claude.is_known);
    assert!(claude.size.is_none());
}

// ── Instruction sets: verdicts in the listing ──

#[test]
fn instruction_sets_group_same_directory_and_extract_title() {
    let td = setup_project();
    let dir = td.path().join("presentation").join("board");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("AGENTS.md"), "# Board Instructions\nbody").unwrap();
    symlink("AGENTS.md", dir.join("CLAUDE.md")).unwrap();

    let listing = with_policy(multi_policy("symlink"), || {
        list_agent_docs_impl(project_str(&td)).expect("list")
    });
    let set = listing
        .instruction_sets
        .iter()
        .find(|s| s.relative_dir == "presentation/board")
        .expect("set");
    assert_eq!(set.label, "Board Instructions");
    assert_eq!(set.label_source, "heading:AGENT");
    assert_eq!(set.verdict, "canonical");
    assert!(set.flags.is_empty());
}

#[test]
fn legacy_agent_md_never_satisfies_and_is_flagged() {
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.md"), "# C\n").unwrap();
    symlink("CLAUDE.md", td.path().join("AGENT.md")).unwrap();

    let listing = with_policy(multi_policy("symlink"), || {
        list_agent_docs_impl(project_str(&td)).expect("list")
    });
    let set = listing
        .instruction_sets
        .iter()
        .find(|s| s.relative_dir.is_empty())
        .expect("root set");
    assert_eq!(set.verdict, "claude_only");
    assert!(set.flags.iter().any(|f| f == "legacy"));
    // The AGENT format record is NOT satisfied by the legacy file.
    let agent = set.formats.get(&AgentDocFormatKind::AGENT).unwrap();
    assert!(!agent.exists);
    // The legacy artifact is exposed separately.
    assert_eq!(set.legacy.len(), 1);
    assert_eq!(set.legacy[0].name, "AGENT.md");
}

#[test]
fn legacy_composes_with_canonical_layout() {
    let td = setup_project();
    fs::write(td.path().join("AGENTS.md"), "# A\n").unwrap();
    symlink("AGENTS.md", td.path().join("CLAUDE.md")).unwrap();
    symlink("CLAUDE.md", td.path().join("AGENT.md")).unwrap();

    let listing = with_policy(multi_policy("symlink"), || {
        list_agent_docs_impl(project_str(&td)).expect("list")
    });
    let set = listing
        .instruction_sets
        .iter()
        .find(|s| s.relative_dir.is_empty())
        .expect("root set");
    assert_eq!(set.verdict, "canonical");
    assert!(set.flags.iter().any(|f| f == "legacy"));
}

#[test]
fn broken_and_external_links_are_flagged() {
    let td = setup_project();
    let broken = td.path().join("broken");
    fs::create_dir_all(&broken).unwrap();
    symlink("missing.md", broken.join("AGENT.md")).unwrap();

    let outside = TempDir::new().unwrap();
    fs::write(outside.path().join("AGENTS.md"), "# Outside\n").unwrap();
    let external = td.path().join("external");
    fs::create_dir_all(&external).unwrap();
    symlink(outside.path().join("AGENTS.md"), external.join("AGENTS.md")).unwrap();

    let listing = with_policy(multi_policy("symlink"), || {
        list_agent_docs_impl(project_str(&td)).expect("list")
    });
    let broken_set = listing
        .instruction_sets
        .iter()
        .find(|s| s.relative_dir == "broken")
        .expect("broken set");
    assert!(broken_set.flags.iter().any(|f| f == "broken_link"));
    assert!(broken_set.flags.iter().any(|f| f == "legacy"));
    let external_set = listing
        .instruction_sets
        .iter()
        .find(|s| s.relative_dir == "external")
        .expect("external set");
    assert!(external_set.flags.iter().any(|f| f == "external_link"));
    assert_eq!(external_set.verdict, "canonical");
}

#[test]
fn listing_carries_policy_summary() {
    let td = setup_project();
    let listing = with_policy(multi_policy("import"), || {
        list_agent_docs_impl(project_str(&td)).expect("list")
    });
    assert!(listing.policy.requires_claude);
    assert!(listing.policy.requires_agent);
    assert_eq!(listing.policy.strategy, "import");
    assert_eq!(listing.policy.canonical.as_deref(), Some("AGENTS.md"));
    assert_eq!(listing.policy.derived.as_deref(), Some("CLAUDE.md"));
}

// ── Path confinement ──

#[test]
fn rejects_traversal() {
    let td = setup_project();
    let err = read_agent_doc_impl(project_str(&td), "../CLAUDE.md".into())
        .err()
        .expect("should reject traversal");
    assert!(
        err.contains("invalid_path") || err.contains("Invalid path"),
        "{err}"
    );
}

#[test]
fn rejects_absolute() {
    let td = setup_project();
    let err = read_agent_doc_impl(project_str(&td), "/etc/passwd".into())
        .err()
        .expect("should reject absolute");
    assert!(
        err.contains("invalid_path") || err.contains("Absolute"),
        "{err}"
    );
}

#[test]
fn rejects_non_agent_doc_basename() {
    // A non-agent-doc, non-Markdown basename stays rejected even after the
    // all-Markdown mode widened reads/writes to `.md` files (see
    // `generic_markdown_read_write_uses_existing_editor_flow_guards` for the
    // `.md`-is-allowed side of the contract).
    let td = setup_project();
    fs::write(td.path().join("notes.txt"), "# notes").unwrap();
    let err = write_agent_doc_impl(
        project_str(&td),
        "notes/config.txt".into(),
        "hi".into(),
        None,
        None,
    )
    .err()
    .expect("should reject non-agent-doc basename");
    assert!(err.contains("not_allowed_basename"), "{err}");
}

// ── Read / write ──

#[test]
fn write_then_read_roundtrip() {
    let td = setup_project();
    let res = write_agent_doc_impl(
        project_str(&td),
        "CLAUDE.md".into(),
        "# hello\n".into(),
        None,
        None,
    )
    .expect("write");
    assert_eq!(res.written.len(), 1);
    assert!(!res.derived);

    let read = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into()).expect("read");
    assert_eq!(read.content, "# hello\n");
    assert_eq!(res.written[0].hash.as_deref(), Some(read.hash.as_str()));
}

#[test]
fn write_conflict_when_disk_changed() {
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.md"), "original").unwrap();
    let read = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into()).expect("read");
    fs::write(td.path().join("CLAUDE.md"), "external changed").unwrap();
    let err = write_agent_doc_impl(
        project_str(&td),
        "CLAUDE.md".into(),
        "user edits".into(),
        Some(read.hash.clone()),
        Some(false),
    )
    .err()
    .expect("should conflict");
    assert!(err.contains("conflict"), "{err}");
}

#[test]
fn write_overwrite_after_conflict() {
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.md"), "original").unwrap();
    let res = write_agent_doc_impl(
        project_str(&td),
        "CLAUDE.md".into(),
        "user edits".into(),
        None,
        Some(true),
    )
    .expect("overwrite");
    assert_eq!(res.written.len(), 1);
    let content = fs::read_to_string(td.path().join("CLAUDE.md")).unwrap();
    assert_eq!(content, "user edits");
}

// ── Canonical-by-construction root writes ──

#[test]
fn create_root_doc_in_multi_harness_project_writes_canonical_pair() {
    let td = setup_project();
    let res = with_policy(multi_policy("symlink"), || {
        write_agent_doc_impl(
            project_str(&td),
            "CLAUDE.md".into(),
            "# Root doc\n".into(),
            None,
            None,
        )
        .expect("canonical create")
    });
    assert!(res.derived);
    assert_eq!(res.written.len(), 2);
    assert_eq!(
        fs::read_to_string(td.path().join("AGENTS.md")).unwrap(),
        "# Root doc\n"
    );
    let claude = td.path().join("CLAUDE.md");
    assert!(claude.is_symlink());
    assert_eq!(
        fs::read_link(&claude).unwrap().to_string_lossy(),
        "AGENTS.md"
    );
}

#[test]
fn create_root_doc_import_strategy_writes_pointer() {
    let td = setup_project();
    let res = with_policy(multi_policy("import"), || {
        write_agent_doc_impl(
            project_str(&td),
            "AGENTS.md".into(),
            "# Root doc\n".into(),
            None,
            None,
        )
        .expect("canonical create")
    });
    assert!(res.derived);
    assert_eq!(
        fs::read_to_string(td.path().join("CLAUDE.md")).unwrap(),
        "@AGENTS.md\n"
    );
}

#[test]
fn canonicalizing_create_still_conflicts_against_existing_agents_md() {
    let td = setup_project();
    fs::write(td.path().join("AGENTS.md"), "existing real root\n").unwrap();
    let err = with_policy(multi_policy("symlink"), || {
        write_agent_doc_impl(
            project_str(&td),
            "CLAUDE.md".into(),
            "draft\n".into(),
            None,
            None,
        )
        .err()
        .expect("must conflict, not clobber AGENTS.md")
    });
    assert!(err.contains("conflict"), "{err}");
    assert_eq!(
        fs::read_to_string(td.path().join("AGENTS.md")).unwrap(),
        "existing real root\n"
    );
}

#[test]
fn saving_agents_md_never_touches_existing_real_claude_md() {
    let td = setup_project();
    fs::write(td.path().join("AGENTS.md"), "a\n").unwrap();
    fs::write(td.path().join("CLAUDE.md"), "user prose\n").unwrap();
    let read = read_agent_doc_impl(project_str(&td), "AGENTS.md".into()).expect("read");
    let res = with_policy(multi_policy("symlink"), || {
        write_agent_doc_impl(
            project_str(&td),
            "AGENTS.md".into(),
            "a v2\n".into(),
            Some(read.hash),
            None,
        )
        .expect("save")
    });
    assert!(!res.derived);
    assert_eq!(
        fs::read_to_string(td.path().join("CLAUDE.md")).unwrap(),
        "user prose\n"
    );
}

// ── Derived-pointer handling ──

#[test]
fn read_marks_symlinked_claude_as_derived_pointer() {
    let td = setup_project();
    fs::write(td.path().join("AGENTS.md"), "shared\n").unwrap();
    symlink("AGENTS.md", td.path().join("CLAUDE.md")).unwrap();
    let res = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into()).expect("read");
    assert!(res.is_derived_pointer);
    assert!(res.is_symlink);
}

#[test]
fn read_marks_import_pointer_claude_as_derived_pointer() {
    let td = setup_project();
    fs::write(td.path().join("AGENTS.md"), "shared\n").unwrap();
    fs::write(td.path().join("CLAUDE.md"), "@AGENTS.md\n").unwrap();
    let res = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into()).expect("read");
    assert!(res.is_derived_pointer);
    assert!(!res.is_symlink);
}

#[test]
fn read_user_authored_claude_is_not_derived_pointer() {
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.md"), "# Project\nReal prose.\n").unwrap();
    let res = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into()).expect("read");
    assert!(!res.is_derived_pointer);
}

#[test]
fn nested_claude_with_pointer_body_is_not_treated_as_root_derived() {
    let td = setup_project();
    let dir = td.path().join("feature");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("CLAUDE.md"), "@AGENTS.md\n").unwrap();
    let res = read_agent_doc_impl(project_str(&td), "feature/CLAUDE.md".into()).expect("read");
    assert!(!res.is_derived_pointer);
}

#[test]
fn write_refuses_to_overwrite_derived_symlink_claude_with_prose() {
    let td = setup_project();
    fs::write(td.path().join("AGENTS.md"), "shared\n").unwrap();
    symlink("AGENTS.md", td.path().join("CLAUDE.md")).unwrap();
    let err = write_agent_doc_impl(
        project_str(&td),
        "CLAUDE.md".into(),
        "rogue edit\n".into(),
        None,
        Some(true),
    )
    .err()
    .expect("derived-pointer write should be rejected");
    assert!(err.contains("derived_pointer"), "{err}");
    assert_eq!(
        fs::read_to_string(td.path().join("AGENTS.md")).unwrap(),
        "shared\n"
    );
}

#[test]
fn write_refuses_to_overwrite_import_pointer_claude_with_prose() {
    let td = setup_project();
    fs::write(td.path().join("AGENTS.md"), "shared\n").unwrap();
    fs::write(td.path().join("CLAUDE.md"), "@AGENTS.md\n").unwrap();
    let err = write_agent_doc_impl(
        project_str(&td),
        "CLAUDE.md".into(),
        "real prose\n".into(),
        None,
        Some(true),
    )
    .err()
    .expect("derived-pointer write should be rejected");
    assert!(err.contains("derived_pointer"), "{err}");
    assert_eq!(
        fs::read_to_string(td.path().join("CLAUDE.md")).unwrap(),
        "@AGENTS.md\n"
    );
}

#[test]
fn write_idempotent_pointer_to_pointer_is_allowed() {
    let td = setup_project();
    fs::write(td.path().join("AGENTS.md"), "shared\n").unwrap();
    fs::write(td.path().join("CLAUDE.md"), "@AGENTS.md\n").unwrap();
    let prior = fs::read_to_string(td.path().join("CLAUDE.md")).unwrap();
    let res = write_agent_doc_impl(
        project_str(&td),
        "CLAUDE.md".into(),
        "@AGENTS.md\n".into(),
        None,
        Some(true),
    )
    .expect("pointer-to-pointer should be allowed");
    assert!(!res.written.is_empty());
    assert_eq!(
        fs::read_to_string(td.path().join("CLAUDE.md")).unwrap(),
        prior
    );
}

// ── Editor limits ──

#[test]
fn oversized_read_returns_error() {
    let td = setup_project();
    let big = vec![b'x'; (MAX_EDITOR_BYTES + 100) as usize];
    fs::write(td.path().join("CLAUDE.md"), &big).unwrap();
    let err = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into())
        .err()
        .expect("should reject oversized");
    assert!(err.contains("oversized"), "{err}");
}

#[test]
fn non_utf8_returns_error() {
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.md"), [0xFF, 0xFE, 0xFD]).unwrap();
    let err = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into())
        .err()
        .expect("should reject non-utf8");
    assert!(err.contains("not_utf8"), "{err}");
}

#[test]
fn external_symlink_marked_non_editable() {
    let td = setup_project();
    let outside = TempDir::new().unwrap();
    fs::write(outside.path().join("CLAUDE.md"), "# outside\n").unwrap();
    symlink(
        outside.path().join("CLAUDE.md"),
        td.path().join("CLAUDE.md"),
    )
    .unwrap();
    let err = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into())
        .err()
        .expect("external symlink read should error");
    assert!(err.contains("external_symlink"), "{err}");
}

#[test]
fn all_markdown_mode_skips_skills_and_ignored_subdirs() {
    let td = setup_project();
    for p in [".claude/skills/foo", ".agents/skills/bar"] {
        let dir = td.path().join(p);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("README.md"), "# skill readme").unwrap();
    }
    let markdown_listing =
        list_agent_docs_impl_with_options(project_str(&td), true, false).expect("list markdown");
    assert!(
        !markdown_listing
            .all_rels
            .iter()
            .any(|r| r == ".claude/skills/foo/README.md"),
        "all-markdown mode must skip .claude/skills"
    );
    assert!(
        !markdown_listing
            .all_rels
            .iter()
            .any(|r| r == ".agents/skills/bar/README.md"),
        "all-markdown mode must skip .agents/skills"
    );
}

#[test]
fn all_markdown_write_rejects_external_symlink() {
    // The widened `.md` write surface must not let a `.md` symlink escape
    // the project — confinement is enforced the same as for agent docs.
    let td = setup_project();
    let outside = TempDir::new().unwrap();
    fs::write(outside.path().join("secret.md"), "# outside\n").unwrap();
    symlink(outside.path().join("secret.md"), td.path().join("guide.md")).unwrap();

    let err = write_agent_doc_impl(
        project_str(&td),
        "guide.md".into(),
        "# pwned\n".into(),
        None,
        Some(true),
    )
    .err()
    .expect("external .md symlink write should error");
    assert!(err.contains("external_symlink"), "{err}");
    // The file outside the project is left untouched.
    assert_eq!(
        fs::read_to_string(outside.path().join("secret.md")).unwrap(),
        "# outside\n"
    );
}

#[test]
fn markdown_read_write_reject_ignored_directory_paths() {
    // Even though `.md` is browsable, a caller must not name a path under an
    // ignored dir directly to reach a file discovery deliberately hides.
    let td = setup_project();
    for (dir, file) in [
        ("node_modules/pkg", "node_modules/pkg/README.md"),
        (".claude/skills/foo", ".claude/skills/foo/SKILL.md"),
        // Agent-doc basenames are just as hidden under an ignored dir — the
        // guard is not scoped to generic `.md` only.
        ("node_modules/pkg", "node_modules/pkg/CLAUDE.md"),
        (".claude/skills/foo", ".claude/skills/foo/AGENTS.md"),
    ] {
        fs::create_dir_all(td.path().join(dir)).unwrap();
        fs::write(td.path().join(file), "# hidden\n").unwrap();

        let read_err = read_agent_doc_impl(project_str(&td), file.into())
            .err()
            .unwrap_or_else(|| panic!("read of ignored path {file} should error"));
        assert!(read_err.contains("invalid_path"), "{read_err}");

        let write_err = write_agent_doc_impl(
            project_str(&td),
            file.into(),
            "# pwned\n".into(),
            None,
            Some(true),
        )
        .err()
        .unwrap_or_else(|| panic!("write of ignored path {file} should error"));
        assert!(write_err.contains("invalid_path"), "{write_err}");
        // The hidden file is untouched.
        assert_eq!(
            fs::read_to_string(td.path().join(file)).unwrap(),
            "# hidden\n"
        );
    }
}

#[test]
fn markdown_rejects_symlinked_ancestor_into_ignored_dir() {
    // A symlinked directory component must not become a back door into an
    // ignored subtree the string-only `is_ignored_rel` can't see.
    let td = setup_project();
    fs::create_dir_all(td.path().join("node_modules/pkg")).unwrap();
    fs::write(td.path().join("node_modules/pkg/README.md"), "# hidden\n").unwrap();
    fs::create_dir_all(td.path().join("docs")).unwrap();
    symlink(
        td.path().join("node_modules/pkg"),
        td.path().join("docs/alias"),
    )
    .unwrap();

    let read_err = read_agent_doc_impl(project_str(&td), "docs/alias/README.md".into())
        .err()
        .expect("read via symlinked ancestor should error");
    assert!(read_err.contains("invalid_path"), "{read_err}");

    let write_err = write_agent_doc_impl(
        project_str(&td),
        "docs/alias/README.md".into(),
        "# pwned\n".into(),
        None,
        Some(true),
    )
    .err()
    .expect("write via symlinked ancestor should error");
    assert!(write_err.contains("invalid_path"), "{write_err}");
    assert_eq!(
        fs::read_to_string(td.path().join("node_modules/pkg/README.md")).unwrap(),
        "# hidden\n"
    );
}

#[test]
fn markdown_rejects_symlinked_ancestor_to_normal_dir() {
    // A symlinked ancestor is refused even when it points at a normal,
    // non-ignored in-project directory: discovery never recurses symlinked
    // dirs, so the read/write surface must not either.
    let td = setup_project();
    fs::create_dir_all(td.path().join("real-docs")).unwrap();
    fs::write(td.path().join("real-docs/README.md"), "# real\n").unwrap();
    fs::create_dir_all(td.path().join("docs")).unwrap();
    symlink(td.path().join("real-docs"), td.path().join("docs/alias")).unwrap();

    let read_err = read_agent_doc_impl(project_str(&td), "docs/alias/README.md".into())
        .err()
        .expect("read via symlinked ancestor should error");
    assert!(read_err.contains("invalid_path"), "{read_err}");

    let write_err = write_agent_doc_impl(
        project_str(&td),
        "docs/alias/README.md".into(),
        "# pwned\n".into(),
        None,
        Some(true),
    )
    .err()
    .expect("write via symlinked ancestor should error");
    assert!(write_err.contains("invalid_path"), "{write_err}");
    assert_eq!(
        fs::read_to_string(td.path().join("real-docs/README.md")).unwrap(),
        "# real\n"
    );
}

#[test]
fn all_markdown_read_rejects_external_symlink() {
    let td = setup_project();
    let outside = TempDir::new().unwrap();
    fs::write(outside.path().join("secret.md"), "# outside\n").unwrap();
    symlink(outside.path().join("secret.md"), td.path().join("guide.md")).unwrap();
    let err = read_agent_doc_impl(project_str(&td), "guide.md".into())
        .err()
        .expect("external .md symlink read should error");
    assert!(err.contains("external_symlink"), "{err}");
}

#[test]
fn all_markdown_write_honors_conflict_guard() {
    // The widened `.md` write path still enforces optimistic concurrency: a
    // stale expected-hash aborts the write and leaves disk untouched.
    let td = setup_project();
    let docs = td.path().join("docs");
    fs::create_dir_all(&docs).unwrap();
    fs::write(docs.join("guide.md"), "# original\n").unwrap();

    let read = read_agent_doc_impl(project_str(&td), "docs/guide.md".into()).expect("read");
    fs::write(docs.join("guide.md"), "# external change\n").unwrap();

    let err = write_agent_doc_impl(
        project_str(&td),
        "docs/guide.md".into(),
        "# our edit\n".into(),
        Some(read.hash),
        Some(false),
    )
    .err()
    .expect("stale-hash write should conflict");
    assert!(err.contains("conflict"), "{err}");
    assert_eq!(
        fs::read_to_string(docs.join("guide.md")).unwrap(),
        "# external change\n"
    );
}

// ─── Import parsing: the documented rules, not a convenient subset ──────

#[test]
fn parses_a_mid_line_import() {
    // The docs' own example. Line-leading-only would miss it.
    assert_eq!(
        parse_imports("- git workflow @docs/git-instructions.md\n"),
        vec!["docs/git-instructions.md"]
    );
}

#[test]
fn parses_multiple_imports_on_one_line() {
    assert_eq!(
        parse_imports("See @README.md for overview and @package.json for commands.\n"),
        vec!["README.md", "package.json"]
    );
}

#[test]
fn a_backticked_path_is_literal_text() {
    assert!(parse_imports("Write `@README.md` to import it.\n").is_empty());
    // …and a real directive later on the same line still counts.
    assert_eq!(
        parse_imports("Like `@x.md`, e.g. @docs/real.md\n"),
        vec!["docs/real.md"]
    );
}

#[test]
fn fenced_and_indented_code_are_skipped() {
    // Written line by line on purpose: a `\`-continued string literal eats
    // the leading whitespace, which is the whole point of the indented case.
    let content = [
        "before",
        "```",
        "@docs/example.md",
        "```",
        "    @docs/other.md",
        "~~~md",
        "@docs/tilde.md",
        "~~~",
        "@docs/real.md",
    ]
    .join("\n");
    let content = content.as_str();
    assert_eq!(parse_imports(content), vec!["docs/real.md"]);
}

#[test]
fn a_non_ascii_path_does_not_swallow_the_next_import() {
    // `end` is a BYTE offset into the line and the scanner walks CHARS, so
    // counting `end` iterations overshoots by one per non-ASCII byte. With
    // a single space between the two directives that overshoot eats the
    // separator, and the second `@` is then rejected for sitting mid-word.
    assert_eq!(
        parse_imports("@docs/café.md @docs/b.md\n"),
        vec!["docs/café.md", "docs/b.md"]
    );
}

#[test]
fn an_email_address_is_not_an_import() {
    assert!(parse_imports("Mail someone@example.com for access.\n").is_empty());
}

#[test]
fn a_bare_mention_is_not_an_import() {
    assert!(parse_imports("Annotate with @Composable and @dataclass.\n").is_empty());
}

#[test]
fn trailing_sentence_punctuation_is_not_part_of_the_path() {
    assert_eq!(
        parse_imports("Read @docs/rules.md.\n"),
        vec!["docs/rules.md"]
    );
}

#[test]
fn the_derived_root_pointer_is_still_a_pointer() {
    // Recognition as an import must not disturb the whole-body check the
    // editor uses to render a read-only stub.
    assert!(is_import_pointer_body("@AGENTS.md\n"));
    assert_eq!(parse_imports("@AGENTS.md\n"), vec!["AGENTS.md"]);
}

// ─── Import resolution ──────────────────────────────────────────────────

fn import_rels(td: &TempDir) -> Vec<String> {
    list_agent_docs_impl(project_str(td))
        .expect("list")
        .all_rels
}

fn find_row(listing: &AgentDocsListing, rel: &str) -> AgentDocFileMeta {
    fn walk(node: &AgentDocFolder, rel: &str) -> Option<AgentDocFileMeta> {
        for f in &node.files {
            if f.rel == rel {
                return Some(f.clone());
            }
        }
        node.dirs.iter().find_map(|d| walk(d, rel))
    }
    walk(&listing.root, rel).unwrap_or_else(|| panic!("no row for {rel}"))
}

#[test]
fn an_imported_non_agent_basename_appears_in_the_default_map() {
    // The originating report: a project's `CLAUDE.md:11` imports
    // `@docs/agent/rules.md`, a file Claude Code loads every session that
    // the basename-only classifier never saw.
    let td = setup_project();
    fs::write(
        td.path().join("CLAUDE.md"),
        "# Root\n\nAction: read the rules.\n\n@docs/agent/rules.md\n",
    )
    .unwrap();
    let agent = td.path().join("docs/agent");
    fs::create_dir_all(&agent).unwrap();
    fs::write(agent.join("rules.md"), "# Rules\n").unwrap();

    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert!(listing.all_rels.iter().any(|r| r == "docs/agent/rules.md"));
    assert!(
        listing
            .instruction_rels
            .iter()
            .any(|r| r == "docs/agent/rules.md"),
        "an import is loaded context"
    );
    let row = find_row(&listing, "docs/agent/rules.md");
    assert!(row.is_import);
    assert_eq!(row.imported_by, vec!["CLAUDE.md".to_string()]);
    assert_eq!(row.import_class.as_deref(), Some("in_project"));
}

#[test]
fn a_relative_import_resolves_against_its_own_directory() {
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.md"), "@docs/agent/rules.md\n").unwrap();
    let agent = td.path().join("docs/agent");
    fs::create_dir_all(&agent).unwrap();
    fs::write(agent.join("rules.md"), "@findability.md\n").unwrap();
    fs::write(agent.join("findability.md"), "# F\n").unwrap();

    let rels = import_rels(&td);
    assert!(
        rels.iter().any(|r| r == "docs/agent/findability.md"),
        "relative to the IMPORTING file, not the project root: {rels:?}"
    );
}

#[test]
fn a_transitive_import_is_reached_and_a_cycle_terminates() {
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.md"), "@docs/a.md\n").unwrap();
    let docs = td.path().join("docs");
    fs::create_dir_all(&docs).unwrap();
    fs::write(docs.join("a.md"), "@../CLAUDE.md\n@b.md\n").unwrap();
    fs::write(docs.join("b.md"), "# B\n").unwrap();

    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert!(listing.all_rels.iter().any(|r| r == "docs/a.md"));
    assert!(listing.all_rels.iter().any(|r| r == "docs/b.md"));
    assert_eq!(
        listing
            .all_rels
            .iter()
            .filter(|r| *r == "CLAUDE.md")
            .count(),
        1,
        "each file appears once"
    );
}

#[test]
fn the_fifth_hop_is_marked_not_loaded() {
    let td = setup_project();
    let docs = td.path().join("docs");
    fs::create_dir_all(&docs).unwrap();
    fs::write(td.path().join("CLAUDE.md"), "@docs/h1.md\n").unwrap();
    for i in 1..=4 {
        fs::write(docs.join(format!("h{i}.md")), format!("@h{}.md\n", i + 1)).unwrap();
    }
    fs::write(docs.join("h5.md"), "# five\n").unwrap();

    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    // Four hops load; the fifth is listed but reported as beyond the limit.
    assert_eq!(
        find_row(&listing, "docs/h4.md").import_class.as_deref(),
        Some("in_project")
    );
    assert_eq!(
        find_row(&listing, "docs/h5.md").import_class.as_deref(),
        Some("beyond_depth")
    );
}

#[test]
fn an_external_import_is_present_not_broken() {
    let td = setup_project();
    let home = TempDir::new().unwrap();
    fs::write(home.path().join("prefs.md"), "# prefs\n").unwrap();
    let target = home.path().join("prefs.md");
    fs::write(
        td.path().join("CLAUDE.md"),
        format!("- @{}\n", target.display()),
    )
    .unwrap();

    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert_eq!(
        listing.external_imports.len(),
        1,
        "{:?}",
        listing.external_imports
    );
    let ext = &listing.external_imports[0];
    assert!(ext.exists);
    assert!(!ext.can_write, "an external target is not editable");
    assert_eq!(ext.import_class.as_deref(), Some("external"));
    assert_eq!(ext.imported_by, vec!["CLAUDE.md".to_string()]);
    // …and no unresolved-import warning is raised for it.
    assert!(
        find_row(&listing, "CLAUDE.md")
            .unresolved_imports
            .is_empty(),
        "a working configuration must not be reported as broken"
    );
}

#[test]
fn a_home_relative_import_is_accepted() {
    let home = TempDir::new().unwrap();
    let claude = home.path().join(".claude");
    fs::create_dir_all(&claude).unwrap();
    fs::write(claude.join("my-project-instructions.md"), "# mine\n").unwrap();
    let td = setup_project();
    fs::write(
        td.path().join("CLAUDE.md"),
        "- @~/.claude/my-project-instructions.md\n",
    )
    .unwrap();

    let prev = std::env::var_os("HOME");
    // SAFETY-adjacent: single-threaded test body, restored immediately.
    unsafe { std::env::set_var("HOME", home.path()) };
    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    match prev {
        Some(v) => unsafe { std::env::set_var("HOME", v) },
        None => unsafe { std::env::remove_var("HOME") },
    }

    assert_eq!(listing.external_imports.len(), 1);
    assert!(find_row(&listing, "CLAUDE.md")
        .unresolved_imports
        .is_empty());
}

#[test]
fn a_missing_target_is_reported_on_the_importer() {
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.md"), "@docs/agent/gone.md\n").unwrap();
    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert_eq!(
        find_row(&listing, "CLAUDE.md").unresolved_imports,
        vec!["docs/agent/gone.md".to_string()]
    );
    let root = listing
        .instruction_sets
        .iter()
        .find(|s| s.relative_dir.is_empty())
        .expect("root set");
    assert!(
        root.warnings
            .iter()
            .any(|w| w.contains("docs/agent/gone.md")),
        "{:?}",
        root.warnings
    );
}

#[test]
fn a_non_markdown_target_is_listed_marked_and_read_only() {
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.md"), "Commands: @package.json\n").unwrap();
    fs::write(td.path().join("package.json"), "{}\n").unwrap();

    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    let row = find_row(&listing, "package.json");
    assert!(row.is_import && row.is_non_markdown);
    assert!(!row.can_write);
    // It opens — `read_agent_doc` would otherwise error on click.
    let read = read_agent_doc_impl(project_str(&td), "package.json".into()).expect("read");
    assert_eq!(read.content, "{}\n");
    // …but only because the graph reaches it. An unimported one does not.
    fs::write(td.path().join("secrets.json"), "{}\n").unwrap();
    assert!(read_agent_doc_impl(project_str(&td), "secrets.json".into()).is_err());
    // …and it is still not writable.
    assert!(write_agent_doc_impl(
        project_str(&td),
        "package.json".into(),
        "{\"x\":1}".into(),
        None,
        Some(true),
    )
    .is_err());
}

#[test]
fn symlinked_root_twins_attribute_the_import_once() {
    // The originating report exactly: AGENTS.md and AGENT.md are symlinks to CLAUDE.md,
    // all three enumerate, all three parse the same imports. Without
    // canonical-target dedup the winner is decided by walk order — plausibly
    // AGENT.md, which no harness reads.
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.md"), "@docs/agent/rules.md\n").unwrap();
    std::os::unix::fs::symlink("CLAUDE.md", td.path().join("AGENTS.md")).unwrap();
    std::os::unix::fs::symlink("CLAUDE.md", td.path().join("AGENT.md")).unwrap();
    let agent = td.path().join("docs/agent");
    fs::create_dir_all(&agent).unwrap();
    fs::write(agent.join("rules.md"), "# Rules\n").unwrap();

    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert_eq!(
        find_row(&listing, "docs/agent/rules.md").imported_by,
        vec!["CLAUDE.md".to_string()],
        "attributed once, to the real file"
    );
}

#[test]
fn two_importers_are_both_attributed() {
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.md"), "@docs/rules.md\n").unwrap();
    let sub = td.path().join("core");
    fs::create_dir_all(&sub).unwrap();
    fs::write(sub.join("CLAUDE.md"), "@../docs/rules.md\n").unwrap();
    let docs = td.path().join("docs");
    fs::create_dir_all(&docs).unwrap();
    fs::write(docs.join("rules.md"), "# Rules\n").unwrap();

    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert_eq!(
        find_row(&listing, "docs/rules.md").imported_by,
        vec!["CLAUDE.md".to_string(), "core/CLAUDE.md".to_string()]
    );
}

#[test]
fn the_documented_agents_bridge_keeps_its_canonical_root() {
    // `CLAUDE.md` = `@AGENTS.md` plus Claude-specific content, over a real
    // AGENTS.md. Treating AGENTS.md as "an import target, therefore not a
    // root" would report the canonical root missing for a layout Anthropic
    // publishes.
    let td = setup_project();
    fs::write(
        td.path().join("CLAUDE.md"),
        "@AGENTS.md\n\n## Claude Code\nUse plan mode.\n",
    )
    .unwrap();
    fs::write(td.path().join("AGENTS.md"), "# Shared\n").unwrap();

    let listing = with_policy(multi_policy("import"), || {
        list_agent_docs_impl(project_str(&td)).expect("list")
    });
    let root = listing
        .instruction_sets
        .iter()
        .find(|s| s.relative_dir.is_empty())
        .expect("root set");
    assert!(
        root.formats[&AgentDocFormatKind::AGENT].exists,
        "AGENTS.md still satisfies the AGENT root format"
    );
    // It appears once, as the instruction file, with the import as an edge.
    assert_eq!(
        listing
            .all_rels
            .iter()
            .filter(|r| *r == "AGENTS.md")
            .count(),
        1
    );
    assert!(find_row(&listing, "AGENTS.md").is_import);
}

#[test]
fn a_gitignored_import_target_is_still_followed() {
    let td = setup_project();
    fake_repo(td.path());
    fs::write(td.path().join(".gitignore"), "docs/local.md\n").unwrap();
    fs::write(td.path().join("CLAUDE.md"), "@docs/local.md\n").unwrap();
    let docs = td.path().join("docs");
    fs::create_dir_all(&docs).unwrap();
    fs::write(docs.join("local.md"), "# local\n").unwrap();

    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert!(listing.all_rels.iter().any(|r| r == "docs/local.md"));
    let browse = list_agent_docs_impl_with_options(project_str(&td), true, false).expect("list");
    assert!(
        browse.all_rels.iter().any(|r| r == "docs/local.md"),
        "an ignore rule may not hide an import target in either view"
    );
}

#[test]
fn an_import_is_marked_unreachable_for_a_non_claude_project() {
    let td = setup_project();
    fs::write(td.path().join("AGENTS.md"), "@docs/rules.md\n").unwrap();
    let docs = td.path().join("docs");
    fs::create_dir_all(&docs).unwrap();
    fs::write(docs.join("rules.md"), "# Rules\n").unwrap();

    let codex_only = CanonicalPolicy {
        requires_claude: false,
        requires_agent: true,
        strategy: "symlink".into(),
        claude_harnesses: Vec::new(),
        agent_harnesses: vec!["codex".into()],
    };
    let listing = with_policy(codex_only, || {
        list_agent_docs_impl(project_str(&td)).expect("list")
    });
    let row = find_row(&listing, "docs/rules.md");
    assert!(
        row.is_import,
        "the row is still shown — it explains the file"
    );
    assert!(
        row.import_unreachable,
        "…marked as not loaded by this project's harnesses"
    );
}

#[test]
fn unresolved_imports_are_not_reported_for_a_non_claude_project() {
    // `agent_docs.py` gates this on the harness that HAS imports, so
    // reporting it here would make the app warn about a project `hub sync`
    // calls fine — and contradict the row beside it, which already says
    // this project's harnesses do not load imports at all.
    let td = setup_project();
    fs::write(td.path().join("AGENTS.md"), "@docs/gone.md\n").unwrap();
    let codex_only = CanonicalPolicy {
        requires_claude: false,
        requires_agent: true,
        strategy: "symlink".into(),
        claude_harnesses: Vec::new(),
        agent_harnesses: vec!["codex".into()],
    };
    let listing = with_policy(codex_only, || {
        list_agent_docs_impl(project_str(&td)).expect("list")
    });
    assert!(find_row(&listing, "AGENTS.md")
        .unresolved_imports
        .is_empty());
    for set in &listing.instruction_sets {
        assert!(
            !set.warnings.iter().any(|w| w.contains("Unresolved import")),
            "{:?}",
            set.warnings
        );
    }
}

#[test]
fn a_missing_external_import_is_not_reported_as_broken() {
    // hub cannot see another machine's home directory, so a `@~/…` target
    // absent HERE is the documented cross-worktree pattern seen from the
    // other worktree — not evidence of a broken configuration.
    let td = setup_project();
    fs::write(
        td.path().join("CLAUDE.md"),
        "- @~/.claude/definitely-not-here-8f3a.md\n",
    )
    .unwrap();
    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert!(
        find_row(&listing, "CLAUDE.md")
            .unresolved_imports
            .is_empty(),
        "an unseeable path is not an absent one"
    );
    // …while an in-project miss still is.
    fs::write(td.path().join("CLAUDE.md"), "@docs/gone.md\n").unwrap();
    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert_eq!(
        find_row(&listing, "CLAUDE.md").unresolved_imports,
        vec!["docs/gone.md".to_string()]
    );
}

#[test]
fn the_withheld_count_comes_from_the_classification_walk() {
    // Counting it separately meant a third full traversal that descended
    // into exactly the gitignored subtrees the filter exists to skip.
    let td = setup_project();
    fake_repo(td.path());
    fs::write(td.path().join(".gitignore"), "runner/\n").unwrap();
    let runner = td.path().join("runner");
    fs::create_dir_all(&runner).unwrap();
    for i in 0..7 {
        fs::write(runner.join(format!("d{i}.md")), "# x").unwrap();
    }
    fs::write(td.path().join("README.md"), "# r").unwrap();

    let (rels, total) = classification_scan_counting(td.path());
    assert_eq!(total, 8, "the classification pass sees every .md: {rels:?}");
    let listing = list_agent_docs_impl_with_options(project_str(&td), true, false).expect("list");
    assert_eq!(listing.ignored_count, 7);
    assert_eq!(listing.all_rels, vec!["README.md".to_string()]);
}

// ─── Metadata: eager where it is read, lazy where it is only browsed ────

#[test]
fn listing_rows_carry_no_content_hash() {
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.md"), "# root\n").unwrap();
    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    let claude = listing
        .root
        .files
        .iter()
        .find(|f| f.rel == "CLAUDE.md")
        .expect("root row");
    assert!(
        claude.hash.is_none(),
        "the listing has no use for a fingerprint"
    );
    // Instruction files stay eagerly sized so the context estimate is fixed.
    assert_eq!(claude.size, Some(7));
}

#[test]
fn write_results_still_carry_a_hash() {
    // Not cosmetic: the frontend adopts this as the buffer's loadedHash and
    // sends it back as expected_hash. A None there against an existing file
    // is a hard conflict, so a hashless write result breaks the SECOND save
    // of every session.
    let td = setup_project();
    let res = write_agent_doc_impl(
        project_str(&td),
        "CLAUDE.md".into(),
        "# one\n".into(),
        None,
        Some(false),
    )
    .expect("write");
    let hash = res.written[0].hash.clone().expect("write result must hash");
    // …and the next save with that hash succeeds rather than conflicting.
    write_agent_doc_impl(
        project_str(&td),
        "CLAUDE.md".into(),
        "# two\n".into(),
        Some(hash),
        Some(false),
    )
    .expect("second save must not conflict");
    assert_eq!(
        fs::read_to_string(td.path().join("CLAUDE.md")).unwrap(),
        "# two\n"
    );
}

#[test]
fn browse_only_rows_exist_but_have_unresolved_size() {
    let td = setup_project();
    let docs = td.path().join("docs");
    fs::create_dir_all(&docs).unwrap();
    fs::write(docs.join("guide.md"), "# guide").unwrap();

    let listing = list_agent_docs_impl_with_options(project_str(&td), true, false).expect("list");
    let dir = listing.root.dirs.iter().find(|d| d.name == "docs").unwrap();
    let guide = dir.files.iter().find(|f| f.rel == "docs/guide.md").unwrap();
    // Pending, NOT absent: a row reporting exists=false would open the
    // create-new draft for a file that is already on disk.
    assert!(guide.exists);
    assert_eq!(guide.size, None);
    assert!(guide.can_read);
}

#[test]
fn resolve_dir_meta_returns_sizes_for_one_directory() {
    let td = setup_project();
    let docs = td.path().join("docs");
    fs::create_dir_all(docs.join("nested")).unwrap();
    fs::write(docs.join("guide.md"), "# guide").unwrap();
    fs::write(docs.join("nested/deep.md"), "# deep").unwrap();

    let metas = resolve_agent_doc_dir_meta_impl(project_str(&td), "docs".into()).expect("resolve");
    assert_eq!(
        metas.iter().map(|m| m.rel.as_str()).collect::<Vec<_>>(),
        vec!["docs/guide.md"],
        "one directory, not its subtree"
    );
    assert_eq!(metas[0].size, Some(7));
    assert!(metas[0].modified_at.is_some());
}

#[test]
fn resolve_dir_meta_refuses_a_directory_the_scan_skips() {
    let td = setup_project();
    let nm = td.path().join("node_modules/pkg");
    fs::create_dir_all(&nm).unwrap();
    fs::write(nm.join("README.md"), "# x").unwrap();
    let err = resolve_agent_doc_dir_meta_impl(project_str(&td), "node_modules/pkg".into())
        .expect_err("must refuse");
    assert!(err.contains("skipped"), "{err}");
}

#[test]
fn resolve_dir_meta_tolerates_a_directory_that_vanished() {
    let td = setup_project();
    let metas = resolve_agent_doc_dir_meta_impl(project_str(&td), "gone".into()).expect("resolve");
    assert!(metas.is_empty());
}

#[test]
fn ignore_rules_do_not_gate_read_or_write() {
    // The static skip list is the only access gate. Confinement is
    // unchanged by the new ignore filter in either direction.
    let td = setup_project();
    fake_repo(td.path());
    fs::write(td.path().join(".gitignore"), "docs/\n").unwrap();
    let docs = td.path().join("docs");
    fs::create_dir_all(&docs).unwrap();
    fs::write(docs.join("guide.md"), "# guide\n").unwrap();

    let read = read_agent_doc_impl(project_str(&td), "docs/guide.md".into()).expect("read");
    assert_eq!(read.content, "# guide\n");
    write_agent_doc_impl(
        project_str(&td),
        "docs/guide.md".into(),
        "# edited\n".into(),
        Some(read.hash),
        Some(false),
    )
    .expect("write");

    // …and a skip-listed path is still refused, ignore rules or not.
    let nm = td.path().join("node_modules/pkg");
    fs::create_dir_all(&nm).unwrap();
    fs::write(nm.join("README.md"), "# x").unwrap();
    assert!(read_agent_doc_impl(project_str(&td), "node_modules/pkg/README.md".into()).is_err());
}

#[test]
fn instruction_rels_are_the_loaded_set_in_both_modes() {
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.md"), "# root\n").unwrap();
    let docs = td.path().join("docs");
    fs::create_dir_all(&docs).unwrap();
    fs::write(docs.join("guide.md"), "# guide").unwrap();

    let browse = list_agent_docs_impl_with_options(project_str(&td), true, false).expect("list");
    assert!(browse.all_rels.iter().any(|r| r == "docs/guide.md"));
    assert!(
        !browse.instruction_rels.iter().any(|r| r == "docs/guide.md"),
        "an ordinary project doc is browsable, not loaded: {:?}",
        browse.instruction_rels
    );
    assert!(browse.instruction_rels.iter().any(|r| r == "CLAUDE.md"));
}

// ─── Walker: what the map may and may not drop ──────────────────────────

/// `git init` without the binary — the walker only reads `.gitignore` and
/// `.git/info/exclude`, so a `.git/` directory is all it takes to make a
/// root look like a work tree.
fn fake_repo(root: &Path) {
    fs::create_dir_all(root.join(".git/info")).unwrap();
}

fn all_md(td: &TempDir) -> Vec<String> {
    list_agent_docs_impl_with_options(project_str(td), true, false)
        .expect("list markdown")
        .all_rels
}

#[test]
fn walker_lists_docs_inside_dot_directories() {
    // The `ignore` crate defaults to hidden(true), which would delete every
    // `.claude/`, `.agents/`, and `.github/` doc from the map in silence.
    let td = setup_project();
    fake_repo(td.path());
    for rel in [
        ".claude/CLAUDE.md",
        ".agents/AGENTS.md",
        ".github/prompts/review.md",
    ] {
        let abs = td.path().join(rel);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(&abs, "# x").unwrap();
    }
    let rels = all_md(&td);
    for rel in [
        ".claude/CLAUDE.md",
        ".agents/AGENTS.md",
        ".github/prompts/review.md",
    ] {
        assert!(rels.iter().any(|r| r == rel), "missing {rel} in {rels:?}");
    }
}

#[test]
fn walker_lists_a_symlinked_agent_doc() {
    // Hub's own `symlink` root strategy writes `CLAUDE.md -> AGENTS.md`. A
    // walker filtering on `is_file()` drops every derived root, and with it
    // that directory's canonical verdict.
    let td = setup_project();
    let nested = td.path().join("core");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("AGENTS.md"), "# core\n").unwrap();
    std::os::unix::fs::symlink("AGENTS.md", nested.join("CLAUDE.md")).unwrap();

    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert!(
        listing.all_rels.iter().any(|r| r == "core/CLAUDE.md"),
        "symlinked derived root must be listed: {:?}",
        listing.all_rels
    );
    assert!(
        listing
            .instruction_sets
            .iter()
            .any(|s| s.relative_dir == "core"),
        "the symlinked root must still produce a verdict for its directory"
    );
}

#[test]
fn walker_lists_files_for_a_project_inside_an_ignored_ancestor() {
    // require_git(false) + parents(false). Without them a vendored subtree
    // an ancestor repository gitignores yields an empty index and no
    // explanation whatsoever.
    let td = setup_project();
    fake_repo(td.path());
    fs::write(td.path().join(".gitignore"), "").unwrap();
    let inner = td.path().join("vendored-project");
    fs::create_dir_all(&inner).unwrap();
    fs::write(td.path().join(".gitignore"), "vendored-project/\n").unwrap();
    fs::write(inner.join("README.md"), "# inner").unwrap();

    let rels = list_agent_docs_impl_with_options(inner.to_string_lossy().into_owned(), true, false)
        .expect("list markdown")
        .all_rels;
    assert_eq!(rels, vec!["README.md".to_string()]);
}

#[test]
fn walker_does_not_consult_machine_local_ignore_files() {
    // `ignore(false)` + `git_global(false)`: a `~/.gitignore` or a stray
    // `.ignore` must not make two people see different maps for one repo.
    let td = setup_project();
    fake_repo(td.path());
    fs::write(td.path().join(".ignore"), "docs/\n").unwrap();
    let docs = td.path().join("docs");
    fs::create_dir_all(&docs).unwrap();
    fs::write(docs.join("guide.md"), "# guide").unwrap();

    assert!(all_md(&td).iter().any(|r| r == "docs/guide.md"));
}

#[test]
fn walker_handles_a_non_repository_project() {
    let td = setup_project();
    fs::write(td.path().join("README.md"), "# r").unwrap();
    let listing = list_agent_docs_impl_with_options(project_str(&td), true, false).expect("list");
    assert!(listing.all_rels.iter().any(|r| r == "README.md"));
    assert_eq!(listing.ignored_count, 0);
}

#[test]
fn walker_still_enforces_the_static_skip_list() {
    let td = setup_project();
    for rel in [
        "node_modules/pkg/README.md",
        "target/doc/x.md",
        ".claude/skills/foo/SKILL.md",
    ] {
        let abs = td.path().join(rel);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(&abs, "# x").unwrap();
    }
    fs::write(td.path().join("keep.md"), "# k").unwrap();
    let rels = all_md(&td);
    assert_eq!(rels, vec!["keep.md".to_string()], "got {rels:?}");
}

#[test]
fn walker_reaches_a_doc_more_than_eight_directories_deep() {
    let td = setup_project();
    let mut deep = td.path().to_path_buf();
    for name in ["a", "b", "c", "d", "e", "f", "g", "h", "i"] {
        deep = deep.join(name);
    }
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("CLAUDE.md"), "# deep\n").unwrap();
    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert!(
        listing
            .all_rels
            .iter()
            .any(|r| r == "a/b/c/d/e/f/g/h/i/CLAUDE.md"),
        "no depth limit may hide an agent doc: {:?}",
        listing.all_rels
    );
}

// ─── Ignore rules bound the browse index and NOTHING else ───────────────

#[test]
fn gitignored_directory_is_excluded_from_browse_and_the_count_reported() {
    let td = setup_project();
    fake_repo(td.path());
    fs::write(td.path().join(".gitignore"), "actions-runner/\n").unwrap();
    let runner = td.path().join("actions-runner/_work");
    fs::create_dir_all(&runner).unwrap();
    for i in 0..5 {
        fs::write(runner.join(format!("d{i}.md")), "# x").unwrap();
    }
    fs::write(td.path().join("README.md"), "# r").unwrap();

    let listing = list_agent_docs_impl_with_options(project_str(&td), true, false).expect("list");
    assert!(
        !listing
            .all_rels
            .iter()
            .any(|r| r.starts_with("actions-runner/")),
        "{:?}",
        listing.all_rels
    );
    assert_eq!(listing.ignored_count, 5);
    assert!(!listing.include_ignored);
}

#[test]
fn include_ignored_returns_the_withheld_files() {
    let td = setup_project();
    fake_repo(td.path());
    fs::write(td.path().join(".gitignore"), "actions-runner/\n").unwrap();
    let runner = td.path().join("actions-runner");
    fs::create_dir_all(&runner).unwrap();
    fs::write(runner.join("d0.md"), "# x").unwrap();

    let listing = list_agent_docs_impl_with_options(project_str(&td), true, true).expect("list");
    assert!(listing.all_rels.iter().any(|r| r == "actions-runner/d0.md"));
    assert!(listing.include_ignored);
}

#[test]
fn gitignored_agent_doc_is_still_classified_and_writable() {
    // Gitignoring `CLAUDE.md` is normal. Classification is deliberately not
    // ignore-filtered, and only the static skip list gates access.
    let td = setup_project();
    fake_repo(td.path());
    fs::write(td.path().join(".gitignore"), "CLAUDE.md\nCLAUDE.local.md\n").unwrap();
    fs::write(td.path().join("CLAUDE.md"), "# root\n").unwrap();
    fs::write(td.path().join("CLAUDE.local.md"), "# local\n").unwrap();

    let listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert!(listing.all_rels.iter().any(|r| r == "CLAUDE.md"));
    assert!(listing.all_rels.iter().any(|r| r == "CLAUDE.local.md"));
    // …and it survives into the browse view too, which is a union of both
    // passes: an ignore rule may not hide an instruction file anywhere.
    let browse = list_agent_docs_impl_with_options(project_str(&td), true, false).expect("list");
    assert!(browse.all_rels.iter().any(|r| r == "CLAUDE.md"));

    let read = read_agent_doc_impl(project_str(&td), "CLAUDE.local.md".into()).expect("read");
    assert_eq!(read.content, "# local\n");
    write_agent_doc_impl(
        project_str(&td),
        "CLAUDE.local.md".into(),
        "# edited\n".into(),
        Some(read.hash),
        Some(false),
    )
    .expect("write");
    assert_eq!(
        fs::read_to_string(td.path().join("CLAUDE.local.md")).unwrap(),
        "# edited\n"
    );
}

#[test]
fn claude_local_md_satisfies_no_root_format() {
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.local.md"), "# local\n").unwrap();
    let listing = with_policy(multi_policy("symlink"), || {
        list_agent_docs_impl(project_str(&td)).expect("list")
    });
    // It is listed as an instruction file…
    assert!(listing.all_rels.iter().any(|r| r == "CLAUDE.local.md"));
    // …but it is not a CLAUDE root, so the root stays unsatisfied.
    let root = listing
        .instruction_sets
        .iter()
        .find(|s| s.relative_dir.is_empty());
    assert!(
        root.is_none() || !root.unwrap().formats[&AgentDocFormatKind::CLAUDE].exists,
        "CLAUDE.local.md must not satisfy the CLAUDE root format"
    );
}

#[test]
fn browse_union_yields_one_row_per_rel() {
    // `insert_file_into_tree` does no dedup — the union has to.
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.md"), "# root\n").unwrap();
    let listing = list_agent_docs_impl_with_options(project_str(&td), true, false).expect("list");
    assert_eq!(
        listing
            .all_rels
            .iter()
            .filter(|r| *r == "CLAUDE.md")
            .count(),
        1
    );
    assert_eq!(
        listing
            .root
            .files
            .iter()
            .filter(|f| f.rel == "CLAUDE.md")
            .count(),
        1
    );
}

#[test]
fn is_known_stays_per_view() {
    let td = setup_project();
    fs::write(td.path().join("CLAUDE.md"), "# root\n").unwrap();
    let default_listing = list_agent_docs_impl(project_str(&td)).expect("list");
    assert!(default_listing
        .root
        .files
        .iter()
        .any(|f| f.rel == "CLAUDE.md" && f.is_known));
    let browse = list_agent_docs_impl_with_options(project_str(&td), true, false).expect("list");
    assert!(browse
        .root
        .files
        .iter()
        .any(|f| f.rel == "CLAUDE.md" && !f.is_known));
}

#[test]
fn all_markdown_mode_represents_a_narrow_deep_branch_alongside_a_wide_shallow_one() {
    // The budget this was written against is gone, but the property it
    // protects is not: every branch must be represented regardless of its
    // shape. A wide-and-shallow sibling (a spec-heavy `openspec/`) used to
    // exhaust the whole global allocation before a narrow-and-deep one (an
    // Android `app/` module six package levels down) contributed a single
    // file. Re-pointed at the complete walker, which owes no fairness
    // reasoning at all — there is nothing to be unfair with.
    let td = setup_project();

    // Wide + shallow: 300 files two levels down.
    let wide = td.path().join("wide");
    fs::create_dir_all(wide.join("sub")).unwrap();
    for i in 0..300 {
        fs::write(wide.join("sub").join(format!("f{i}.md")), "# x").unwrap();
    }

    // Narrow + deep: one file six levels down.
    let mut deep = td.path().join("deep");
    for name in ["a", "b", "c", "d", "e"] {
        deep = deep.join(name);
    }
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("CLAUDE.md"), "# deep\n").unwrap();

    let markdown_listing =
        list_agent_docs_impl_with_options(project_str(&td), true, false).expect("list markdown");
    assert!(
        markdown_listing
            .all_rels
            .iter()
            .any(|r| r == "deep/a/b/c/d/e/CLAUDE.md"),
        "a narrow, deeply-nested branch must not be starved by a wide, \
         shallow sibling: {:?}",
        markdown_listing.all_rels
    );
}
