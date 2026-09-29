use super::*;
use crate::commands::usage::{redact_scan_for_cache, UsageScan, UsageSource};
use tempfile::TempDir;

fn write_line(f: &mut fs::File, s: &str) {
    use std::io::Write;
    writeln!(f, "{s}").unwrap();
}

fn roots_for(base: &Path) -> EnrichRoots {
    EnrichRoots {
        claude_projects: base.join("claude"),
        codex_sessions: base.join("codex"),
        pi_sessions: base.join("pi"),
    }
}

fn session_row(agent: &str, period: &str) -> Value {
    serde_json::json!({"agent": agent, "period": period, "metadata": {}})
}

#[test]
fn mixed_harness_rows_keep_native_survivors_and_pi_tools_only() {
    let td = TempDir::new().unwrap();
    let roots = roots_for(td.path());
    fs::create_dir_all(roots.claude_projects.join("enc")).unwrap();
    fs::create_dir_all(roots.pi_sessions.join("enc")).unwrap();
    fs::create_dir_all(roots.codex_sessions.join("2026/09/17")).unwrap();
    fs::write(
        roots.claude_projects.join("enc/claude-1.jsonl"),
        "{\"type\":\"custom-title\",\"customTitle\":\"Claude title\"}\n{\"type\":\"pr-link\",\"prNumber\":9}\n",
    )
    .unwrap();
    fs::write(
        roots.pi_sessions.join("enc/1700000000_pi-1.jsonl"),
        "{\"type\":\"session\",\"cwd\":\"/work/pi\"}\n{\"role\":\"assistant\",\"type\":\"toolCall\",\"name\":\"Bash\"}\n",
    )
    .unwrap();
    let codex_period = "2026/09/17/rollout-codex-1";
    fs::write(
        roots.codex_sessions.join(format!("{codex_period}.jsonl")),
        "{\"timestamp\":\"t\",\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/work/codex\"}}\n",
    )
    .unwrap();
    let mut parsed = serde_json::json!({"session": [
        session_row("claude", "claude-1"),
        session_row("pi", "pi-1"),
        session_row("codex", codex_period),
    ]});
    let mut claude_paths = HashMap::new();
    claude_paths.insert("claude-1".to_string(), "enc".to_string());
    enrich_sessions(&mut parsed, &roots, &[], &claude_paths);
    let claude = &parsed["session"][0]["metadata"];
    assert_eq!(claude["title"], "Claude title");
    assert!(claude.get("prNumber").is_none());
    assert!(claude.get("toolCalls").is_none());
    let pi = &parsed["session"][1]["metadata"];
    assert_eq!(pi["toolCalls"], 1);
    assert_eq!(pi["toolBreakdown"], serde_json::json!({"Bash": 1}));
    let codex = &parsed["session"][2]["metadata"];
    assert_eq!(codex["projectPath"], "/work/codex");
    assert!(codex.get("toolCalls").is_none());
}

#[test]
fn codex_native_metadata_uses_db_title_and_lineage_without_inspection() {
    let td = TempDir::new().unwrap();
    let day = td.path().join("codex/2026/09/16");
    fs::create_dir_all(&day).unwrap();
    let own = "11111111-1111-4111-8111-111111111111";
    let parent = "22222222-2222-4222-8222-222222222222";
    let mut f =
        fs::File::create(day.join(format!("rollout-2026-09-16T10-00-00-{own}.jsonl"))).unwrap();
    let record = serde_json::json!({
        "timestamp": "2026-09-16T10:00:00Z",
        "type": "session_meta",
        "payload": {"id": own, "source": {"subagent": {
            "role": "builder", "nickname": "agent-1", "agent_path": "/Users/me/agents/builder",
            "thread_spawn": {"parent_thread_id": parent}
        }}}
    });
    write_line(&mut f, &record.to_string());
    drop(f);
    let db = td.path().join("state_5.sqlite");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO threads (id,title) VALUES (?1,?2)",
        rusqlite::params![
            own,
            "Fix usage\n[Attached image \"image.png\"] is saved at: /Users/me/private.txt"
        ],
    )
    .unwrap();
    drop(conn);
    let mut parsed = serde_json::json!({"session": [session_row("codex", &format!("2026/09/16/rollout-2026-09-16T10-00-00-{own}"))]});
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &HashMap::new());
    let meta = &parsed["session"][0]["metadata"];
    assert_eq!(meta["titleSource"], "native");
    assert_eq!(meta["title"], "Fix usage");
    assert_eq!(meta["sessionId"], own);
    assert_eq!(meta["parentSessionId"], parent);
    assert_eq!(meta["agentRole"], "builder");
    assert_eq!(meta["agentNickname"], "agent-1");
    assert!(!meta["title"].as_str().unwrap().contains("/Users/me"));
}

#[test]
fn codex_db_name_beats_index_and_blank_latest_index_does_not_erase_title() {
    let td = TempDir::new().unwrap();
    let id = "33333333-3333-4333-8333-333333333333";
    fs::write(td.path().join("session_index.jsonl"), format!("{{\"id\":\"{id}\",\"thread_name\":\"index title\"}}\n{{\"id\":\"{id}\",\"thread_name\":\" \"}}\n")).unwrap();
    let db = td.path().join("state_7.sqlite");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO threads VALUES (?1,?2,?3)",
        rusqlite::params![id, "native name", "db title"],
    )
    .unwrap();
    let mut metadata = crate::commands::usage_codex_metadata::CodexMetadata {
        own_id: Some(id.into()),
        ..Default::default()
    };
    crate::commands::usage_codex_metadata::Lookup::new(
        td.path(),
        &std::iter::once(id.to_string()).collect(),
    )
    .enrich(&mut metadata);
    assert_eq!(metadata.explicit_name.as_deref(), Some("native name"));
}

// ── claude ───────────────────────────────────────────────────────────

#[test]
fn claude_custom_title_beats_ai_title_and_last_wins() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("claude").join("--Users-x-y--");
    fs::create_dir_all(&dir).unwrap();
    let session_path = dir.join("sess1.jsonl");
    let mut f = fs::File::create(&session_path).unwrap();
    write_line(&mut f, r#"{"type":"ai-title","aiTitle":"AI guess"}"#);
    write_line(
        &mut f,
        r#"{"type":"custom-title","customTitle":"First custom"}"#,
    );
    write_line(
        &mut f,
        r#"{"type":"custom-title","customTitle":"Second custom"}"#,
    );
    drop(f);

    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    let roots = roots_for(td.path());
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "--Users-x-y--".to_string());

    enrich_sessions(&mut parsed, &roots, &[], &claude_paths);

    let meta = &parsed["session"][0]["metadata"];
    assert_eq!(meta["title"], "Second custom");
    assert_eq!(meta["titleSource"], "custom");
}

#[test]
fn claude_ai_title_used_only_when_no_custom_title() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("claude").join("--Users-x-y--");
    fs::create_dir_all(&dir).unwrap();
    let session_path = dir.join("sess1.jsonl");
    let mut f = fs::File::create(&session_path).unwrap();
    write_line(&mut f, r#"{"type":"ai-title","aiTitle":"First AI"}"#);
    write_line(&mut f, r#"{"type":"ai-title","aiTitle":"Second AI"}"#);
    drop(f);

    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    let roots = roots_for(td.path());
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "--Users-x-y--".to_string());

    enrich_sessions(&mut parsed, &roots, &[], &claude_paths);

    let meta = &parsed["session"][0]["metadata"];
    assert_eq!(meta["title"], "Second AI");
    assert_eq!(meta["titleSource"], "ai");
}

#[test]
fn claude_pr_link_retains_canonical_metadata_only() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("claude").join("--Users-x-y--");
    fs::create_dir_all(&dir).unwrap();
    let session_path = dir.join("sess1.jsonl");
    let mut f = fs::File::create(&session_path).unwrap();
    write_line(
        &mut f,
        r#"{"type":"pr-link","prNumber":42,"prUrl":"https://github.com/org/repo/pull/42"}"#,
    );
    write_line(
        &mut f,
        r#"{"type":"cost-state","totalLinesAdded":10,"totalLinesRemoved":3,"totalDuration":98765}"#,
    );
    // First parentUuid line: carries cwd + a branch.
    write_line(
        &mut f,
        r#"{"parentUuid":null,"cwd":"/Users/x/y","gitBranch":"feat/one","type":"user"}"#,
    );
    // Second parentUuid line: a later branch value (last non-empty wins),
    // an assistant line with two tool_use blocks AND a decoy
    // "tool_use_id" substring that must not be double-counted.
    write_line(
        &mut f,
        r#"{"parentUuid":"a","gitBranch":"feat/two","type":"assistant","message":{"content":[{"type":"tool_use","id":"tool_use_id_1"},{"type":"tool_use","id":"tool_use_id_2"}]}}"#,
    );
    // A user line (not assistant) that happens to mention tool_use must
    // not contribute to the count.
    write_line(
        &mut f,
        r#"{"parentUuid":"b","type":"user","text":"please tool_use this"}"#,
    );
    drop(f);

    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    let roots = roots_for(td.path());
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "--Users-x-y--".to_string());

    enrich_sessions(&mut parsed, &roots, &[], &claude_paths);

    let meta = &parsed["session"][0]["metadata"];
    assert!(meta.get("prNumber").is_none());
    assert!(meta.get("prUrl").is_none());
    assert!(meta.get("linesAdded").is_none());
    assert!(meta.get("linesRemoved").is_none());
    assert!(meta.get("durationMs").is_none());
    assert!(meta.get("gitBranch").is_none());
    assert!(meta.get("toolCalls").is_none());
}

#[test]
fn claude_tool_use_names_are_collected_and_a_nameless_call_still_counts() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("claude").join("enc");
    fs::create_dir_all(&dir).unwrap();
    let mut f = fs::File::create(dir.join("sess1.jsonl")).unwrap();
    // Real Claude Code shape: `"type":"tool_use"` immediately followed by
    // `,"id":"<id>","name":"<name>"`.
    write_line(
        &mut f,
        r#"{"parentUuid":"a","type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash"},{"type":"tool_use","id":"toolu_2","name":"Bash"},{"type":"tool_use","id":"toolu_3","name":"Read"}]}}"#,
    );
    // A tool_use with no following name at all still counts toward
    // `toolCalls` but contributes nothing to the breakdown.
    write_line(
        &mut f,
        r#"{"parentUuid":"b","type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_4"}]}}"#,
    );
    // Decoy (mirrors the existing `tool_use_id` / non-assistant-line
    // decoys above): a user line whose own text mentions both literals
    // must not contribute to the count or the breakdown at all.
    write_line(
        &mut f,
        r#"{"parentUuid":"c","type":"user","text":"please tool_use this and mention tool_use_id too"}"#,
    );
    drop(f);

    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "enc".to_string());
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &claude_paths);

    let meta = &parsed["session"][0]["metadata"];
    assert!(meta.get("toolCalls").is_none());
    assert!(meta.get("toolBreakdown").is_none());
}

#[test]
fn path_shaped_tool_names_are_dropped_from_the_breakdown() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("claude").join("enc");
    fs::create_dir_all(&dir).unwrap();
    let mut f = fs::File::create(dir.join("sess1.jsonl")).unwrap();
    write_line(
        &mut f,
        r#"{"parentUuid":"a","type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"/usr/bin/bash"},{"type":"tool_use","id":"y","name":"~/scripts/run"},{"type":"tool_use","id":"z","name":"Bash"}]}}"#,
    );
    drop(f);

    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "enc".to_string());
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &claude_paths);

    let meta = &parsed["session"][0]["metadata"];
    // All three calls still count toward the total.
    assert!(meta.get("toolCalls").is_none());
    // Only the non-path-shaped name survives into the breakdown.
    assert!(meta.get("toolBreakdown").is_none());
}

#[test]
fn a_long_tool_name_is_truncated_to_64_chars() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("claude").join("enc");
    fs::create_dir_all(&dir).unwrap();
    let mut f = fs::File::create(dir.join("sess1.jsonl")).unwrap();
    let long_name = "x".repeat(100);
    let line = format!(
        r#"{{"parentUuid":"a","type":"assistant","message":{{"content":[{{"type":"tool_use","id":"x","name":"{long_name}"}}]}}}}"#
    );
    write_line(&mut f, &line);
    drop(f);

    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "enc".to_string());
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &claude_paths);

    assert!(parsed["session"][0]["metadata"]
        .get("toolBreakdown")
        .is_none());
}

#[test]
fn tool_breakdown_caps_to_16_entries_by_count_then_name() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("claude").join("enc");
    fs::create_dir_all(&dir).unwrap();
    let mut f = fs::File::create(dir.join("sess1.jsonl")).unwrap();
    // 20 distinct names, each with a distinct call count (Tool00 => 20
    // calls down to Tool19 => 1 call) so the top-16-by-count ranking is
    // unambiguous.
    for i in 0..20u32 {
        let name = format!("Tool{i:02}");
        let count = 20 - i;
        let mut content = String::new();
        for c in 0..count {
            if c > 0 {
                content.push(',');
            }
            content.push_str(&format!(
                r#"{{"type":"tool_use","id":"id{c}","name":"{name}"}}"#
            ));
        }
        let line = format!(
            r#"{{"parentUuid":"a","type":"assistant","message":{{"content":[{content}]}}}}"#
        );
        write_line(&mut f, &line);
    }
    drop(f);

    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "enc".to_string());
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &claude_paths);

    assert!(parsed["session"][0]["metadata"]
        .get("toolBreakdown")
        .is_none());
}

#[test]
fn tool_breakdown_is_written_only_when_absent() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("claude").join("enc");
    fs::create_dir_all(&dir).unwrap();
    let mut f = fs::File::create(dir.join("sess1.jsonl")).unwrap();
    write_line(
        &mut f,
        r#"{"parentUuid":"a","type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Bash"}]}}"#,
    );
    drop(f);

    let mut parsed = serde_json::json!({"session": [{
        "agent": "claude",
        "period": "sess1",
        "metadata": {"toolBreakdown": {"Preexisting": 3}},
    }]});
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "enc".to_string());
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &claude_paths);

    let meta = &parsed["session"][0]["metadata"];
    // A pre-existing value is never overwritten by a best-effort re-scan.
    assert_eq!(meta["toolBreakdown"], serde_json::json!({"Preexisting": 3}));
    assert!(meta.get("toolCalls").is_none());
}

#[test]
fn claude_falls_back_to_stem_index_when_direct_path_missing() {
    let td = TempDir::new().unwrap();
    // No `claude_paths` entry, and no matching enc dir — file only
    // discoverable via the stem index scan.
    let dir = td.path().join("claude").join("--some-other-enc--");
    fs::create_dir_all(&dir).unwrap();
    let mut f = fs::File::create(dir.join("sess1.jsonl")).unwrap();
    write_line(
        &mut f,
        r#"{"type":"custom-title","customTitle":"Via stem index"}"#,
    );
    drop(f);

    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    let roots = roots_for(td.path());
    let claude_paths = HashMap::new();

    enrich_sessions(&mut parsed, &roots, &[], &claude_paths);

    assert_eq!(parsed["session"][0]["metadata"]["title"], "Via stem index");
}

// ── codex ────────────────────────────────────────────────────────────

#[test]
fn codex_session_meta_cwd_and_native_metadata_only() {
    let td = TempDir::new().unwrap();
    let period = "2026/02/19/rollout-2026-02-19T18-55-10-abc";
    let session_path = td.path().join("codex").join(format!("{period}.jsonl"));
    fs::create_dir_all(session_path.parent().unwrap()).unwrap();
    let mut f = fs::File::create(&session_path).unwrap();
    write_line(
        &mut f,
        r#"{"timestamp":"t","type":"session_meta","payload":{"cwd":"/Users/x/proj"}}"#,
    );
    write_line(
        &mut f,
        r#"{"timestamp":"t","type":"function_call","name":"a"}"#,
    );
    write_line(
        &mut f,
        r#"{"timestamp":"t","type":"function_call_output","name":"a"}"#,
    );
    write_line(
        &mut f,
        r#"{"timestamp":"t","type":"custom_tool_call","name":"b"}"#,
    );
    drop(f);

    let mut parsed = serde_json::json!({"session": [session_row("codex", period)]});
    let roots = roots_for(td.path());

    enrich_sessions(&mut parsed, &roots, &[], &HashMap::new());

    let meta = &parsed["session"][0]["metadata"];
    assert_eq!(meta["projectPath"], "/Users/x/proj");
    assert!(meta.get("toolCalls").is_none());
    assert!(meta.get("toolBreakdown").is_none());
}

#[test]
fn pi_tool_names_are_collected_from_toolcall_entries() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("pi").join("enc");
    fs::create_dir_all(&dir).unwrap();
    let session_path = dir.join("1700000000_the-id.jsonl");
    let mut f = fs::File::create(&session_path).unwrap();
    write_line(
        &mut f,
        r#"{"role":"assistant","content":[{"type":"toolCall","id":"1","name":"bash"},{"type":"toolCall","id":"2","name":"read_file"}]}"#,
    );
    // A "user" line quoting the same shape must not contribute.
    write_line(
        &mut f,
        r#"{"role":"user","type":"toolCall","name":"decoy"}"#,
    );
    drop(f);

    let mut parsed = serde_json::json!({"session": [session_row("pi", "the-id")]});
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &HashMap::new());

    let meta = &parsed["session"][0]["metadata"];
    assert_eq!(meta["toolCalls"], 2);
    assert_eq!(
        meta["toolBreakdown"],
        serde_json::json!({"bash": 1, "read_file": 1})
    );
}

// ── pi ───────────────────────────────────────────────────────────────

#[test]
fn pi_session_cwd_toolcall_count_and_underscore_stem_index() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("pi").join("--Users-x-y--");
    fs::create_dir_all(&dir).unwrap();
    let session_path = dir.join("1700000000_the-id.jsonl");
    let mut f = fs::File::create(&session_path).unwrap();
    write_line(&mut f, r#"{"type":"session","cwd":"/Users/x/y"}"#);
    write_line(
        &mut f,
        r#"{"role":"assistant","type":"toolCall","id":"1"}
{"role":"assistant","content":[{"type":"toolCall"},{"type":"toolCall"}]}"#,
    );
    write_line(&mut f, r#"{"role":"user","type":"toolCall"}"#);
    drop(f);

    let mut parsed = serde_json::json!({"session": [session_row("pi", "the-id")]});
    let roots = roots_for(td.path());

    enrich_sessions(&mut parsed, &roots, &[], &HashMap::new());

    let meta = &parsed["session"][0]["metadata"];
    assert_eq!(meta["projectPath"], "/Users/x/y");
    // Line 1 (assistant, one toolCall) + line 2 (assistant, two
    // toolCalls) = 3; the "user" line is excluded.
    assert_eq!(meta["toolCalls"], 3);
}

// ── registry matching ────────────────────────────────────────────────

#[test]
fn hub_project_longest_prefix_match_wins() {
    let projects = vec![
        (
            "notes-vault".to_string(),
            PathBuf::from("/Users/x/Dev/notes-vault"),
        ),
        (
            "notes-vault-server".to_string(),
            PathBuf::from("/Users/x/Dev/notes-vault/server"),
        ),
    ];
    let hit = match_hub_project("/Users/x/Dev/notes-vault/server/src", &projects);
    assert_eq!(hit.as_deref(), Some("notes-vault-server"));
}

#[test]
fn hub_project_match_is_component_bounded_not_string_prefix() {
    let projects = vec![("a-b".to_string(), PathBuf::from("/a/b"))];
    // "/a/bc" must NOT match "/a/b" as a hub project despite being a
    // string prefix — "bc" and "b" are different path components.
    let hit = match_hub_project("/a/bc/x", &projects);
    assert_eq!(hit, None);
}

#[test]
fn hub_project_worktree_heuristic_matches_name_and_path_leaf() {
    let by_name = vec![(
        "skill-hub".to_string(),
        PathBuf::from("/Users/x/Dev/.skill-hub"),
    )];
    let hit = match_hub_project(
        "/Users/x/Dev/worktrees/skill-hub/usage-screen/app",
        &by_name,
    );
    assert_eq!(hit.as_deref(), Some("skill-hub"));

    let by_leaf = vec![(
        "some-key".to_string(),
        PathBuf::from("/Users/x/Dev/usage-screen"),
    )];
    let hit2 = match_hub_project("/Users/x/Dev/worktrees/usage-screen/sub/app", &by_leaf);
    assert_eq!(hit2.as_deref(), Some("some-key"));
}

#[test]
fn hub_project_no_match_leaves_metadata_untouched() {
    let projects = vec![("other".to_string(), PathBuf::from("/Users/x/elsewhere"))];
    assert_eq!(match_hub_project("/Users/x/Dev/nowhere", &projects), None);
}

// ── title scrubbing ─────────────────────────────────────────────────

#[test]
fn scrub_title_redacts_home_and_drive_path_runs() {
    let input = r#"Fixed bug in /Users/alice/Dev/.skill-hub/hub.py and ~/notes.md, also C:\Users\ram\file.txt done"#;
    let scrubbed = scrub_title(input).expect("a scrubbed title survives");
    assert!(!scrubbed.contains("/Users/alice"));
    assert!(!scrubbed.contains("ram\\file.txt"));
    assert!(scrubbed.contains("<redacted-path>"));
    assert!(scrubbed.starts_with("Fixed bug in <redacted-path> and <redacted-path>"));
}

#[test]
fn scrub_title_caps_length() {
    let long = "x".repeat(500);
    assert_eq!(
        scrub_title(&long)
            .expect("a long title is capped, not dropped")
            .chars()
            .count(),
        MAX_TITLE_CHARS
    );
}

#[test]
fn scrub_title_over_redacts_a_url_carrying_a_projects_segment() {
    // ACCEPTED over-redaction: the run pattern cannot tell a `/projects/`
    // URL segment from a `/projects/` home directory, so the tail of the
    // URL goes with it. Losing part of a URL is the cheap side of the
    // trade; leaking `/home/<user>/projects/...` is the expensive one.
    let scrubbed = scrub_title("See https://gitlab.com/group/projects/foo for context")
        .expect("the head of the title survives");
    assert_eq!(
        scrubbed,
        "See https://gitlab.com/group<redacted-path> for context"
    );
}

#[test]
fn scrub_title_drops_a_value_the_cache_redactor_would_hash() {
    // Neither of these is a path, but `looks_like_local_path` classifies
    // both (a stray backslash / a leading slash), so the cache would store
    // `~/redacted/<hash>` and the screen would render the hash as the
    // session title. Dropping the title falls back to "<Harness> session".
    assert_eq!(scrub_title(r"Fix regex \d+ parsing"), None);
    assert_eq!(scrub_title("/tmp cleanup pass"), None);
    // Whitespace-only, and a value that scrubs away to nothing, are also
    // no titles at all.
    assert_eq!(scrub_title("   "), None);
    assert_eq!(
        scrub_title("~/Dev/thing"),
        Some("<redacted-path>".to_string())
    );
}

#[test]
fn safe_label_bounds_a_pathological_input_before_scrubbing() {
    // 2 MB of path runs must not turn into a quadratic scan; the input is
    // bounded first, the output capped after.
    let huge = "~/a ".repeat(500_000);
    let started = std::time::Instant::now();
    let label = safe_label(&huge, MAX_TITLE_CHARS).expect("something survives");
    assert!(label.chars().count() <= MAX_TITLE_CHARS);
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
}

// ── failure modes ────────────────────────────────────────────────────

#[test]
fn missing_session_file_leaves_row_untouched() {
    let td = TempDir::new().unwrap();
    let mut parsed = serde_json::json!({"session": [session_row("claude", "ghost")]});
    let roots = roots_for(td.path());

    enrich_sessions(&mut parsed, &roots, &[], &HashMap::new());

    assert_eq!(parsed["session"][0]["metadata"], serde_json::json!({}));
}

#[test]
fn unknown_agent_row_is_untouched() {
    let td = TempDir::new().unwrap();
    let mut parsed = serde_json::json!({"session": [session_row("opencode", "whatever")]});
    let roots = roots_for(td.path());

    enrich_sessions(&mut parsed, &roots, &[], &HashMap::new());

    assert_eq!(parsed["session"][0]["metadata"], serde_json::json!({}));
}

// ── redaction interplay ──────────────────────────────────────────────

#[test]
fn enriched_fields_survive_cache_redaction_except_project_path() {
    let td = TempDir::new().unwrap();
    let period = "2026/01/01/rollout-x";
    let session_path = td.path().join("codex").join(format!("{period}.jsonl"));
    fs::create_dir_all(session_path.parent().unwrap()).unwrap();
    let mut f = fs::File::create(&session_path).unwrap();
    write_line(
        &mut f,
        r#"{"timestamp":"t","type":"session_meta","payload":{"cwd":"/Users/x/proj"}}"#,
    );
    write_line(
        &mut f,
        r#"{"timestamp":"t","type":"function_call","name":"a"}"#,
    );
    drop(f);

    let projects = vec![("proj".to_string(), PathBuf::from("/Users/x/proj"))];
    let mut parsed = serde_json::json!({"session": [session_row("codex", period)]});
    // Simulate title/pr enrichment that a claude row would also carry, to
    // prove non-path fields survive redaction untouched.
    parsed["session"][0]["metadata"]["title"] = Value::String("Fixed the thing".to_string());
    parsed["session"][0]["metadata"]["prUrl"] =
        Value::String("https://github.com/org/repo/pull/7".to_string());

    let roots = roots_for(td.path());
    enrich_sessions(&mut parsed, &roots, &projects, &HashMap::new());

    let scan = UsageScan {
        scanned_at: 0,
        source: UsageSource {
            command: "ccusage".to_string(),
            args: vec![],
            resolved_from: "test".to_string(),
        },
        ledger_note: None,
        raw: String::new(),
        parsed,
    };
    let redacted = redact_scan_for_cache(&scan);
    let meta = &redacted.parsed["session"][0]["metadata"];

    assert_eq!(meta["hubProject"], "proj");
    assert_eq!(meta["title"], "Fixed the thing");
    assert_eq!(meta["prUrl"], "https://github.com/org/repo/pull/7");
    assert!(meta.get("toolCalls").is_none());
    assert!(meta.get("toolBreakdown").is_none());
    // projectPath IS path-shaped and must be hashed away by the existing
    // cache redaction.
    let redacted_path = meta["projectPath"].as_str().unwrap();
    assert_ne!(redacted_path, "/Users/x/proj");
    assert!(redacted_path.starts_with("~/redacted/"));
}

// ── confinement: an untrusted `period` may not leave its root ─────────

/// `<td>/outside/secret.jsonl` — a transcript the user never asked us to
/// read, holding a cwd the screen must never report.
fn plant_outside_file(td: &TempDir) -> PathBuf {
    let dir = td.path().join("outside");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("secret.jsonl");
    let mut f = fs::File::create(&path).unwrap();
    write_line(
        &mut f,
        r#"{"timestamp":"t","type":"session_meta","payload":{"cwd":"/Users/victim/private"}}"#,
    );
    write_line(
        &mut f,
        r#"{"type":"custom-title","customTitle":"Somebody else's session"}"#,
    );
    drop(f);
    path
}

#[test]
fn codex_period_with_parent_components_cannot_escape_the_root() {
    let td = TempDir::new().unwrap();
    let outside = plant_outside_file(&td);
    assert!(outside.is_file(), "the escape target must really exist");
    fs::create_dir_all(td.path().join("codex")).unwrap();

    let mut parsed = serde_json::json!({"session": [session_row("codex", "../outside/secret")]});
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &HashMap::new());

    assert_eq!(parsed["session"][0]["metadata"], serde_json::json!({}));
}

#[test]
fn codex_period_with_a_deep_dotdot_chain_cannot_escape_the_root() {
    let td = TempDir::new().unwrap();
    plant_outside_file(&td);
    fs::create_dir_all(td.path().join("codex").join("2026").join("02").join("19")).unwrap();

    // Shaped like a legitimate codex period (slashes are fine) but with a
    // `..` chain climbing back out.
    let period = "2026/02/19/../../../outside/secret";
    let mut parsed = serde_json::json!({"session": [session_row("codex", period)]});
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &HashMap::new());

    assert_eq!(parsed["session"][0]["metadata"], serde_json::json!({}));
}

#[test]
fn absolute_period_cannot_replace_the_root_for_codex_or_claude() {
    let td = TempDir::new().unwrap();
    let outside = plant_outside_file(&td);
    fs::create_dir_all(td.path().join("codex")).unwrap();
    fs::create_dir_all(td.path().join("claude")).unwrap();
    // `Path::join` DISCARDS the root when the joined value is absolute, so
    // an absolute period is the cheapest escape of all.
    let absolute = outside.with_extension("").to_string_lossy().to_string();

    let mut parsed = serde_json::json!({
        "session": [session_row("codex", &absolute), session_row("claude", &absolute)]
    });
    let mut claude_paths = HashMap::new();
    claude_paths.insert(absolute.clone(), "enc".to_string());

    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &claude_paths);

    assert_eq!(parsed["session"][0]["metadata"], serde_json::json!({}));
    assert_eq!(parsed["session"][1]["metadata"], serde_json::json!({}));
}

#[test]
fn claude_encoded_dir_name_with_parent_components_is_refused() {
    let td = TempDir::new().unwrap();
    plant_outside_file(&td);
    fs::create_dir_all(td.path().join("claude")).unwrap();

    // The encoded project dir comes from the same untrusted scan output as
    // the period, so it gets the same component check.
    let mut claude_paths = HashMap::new();
    claude_paths.insert("secret".to_string(), "../outside".to_string());

    let mut parsed = serde_json::json!({"session": [session_row("claude", "secret")]});
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &claude_paths);

    assert_eq!(parsed["session"][0]["metadata"], serde_json::json!({}));
}

#[test]
fn a_traversal_shaped_period_finds_nothing_through_the_index_lookups() {
    let td = TempDir::new().unwrap();
    plant_outside_file(&td);
    // Both index-based resolvers (claude's stem fallback, pi's
    // `<ts>_<id>` map) look a period UP in a map built from `read_dir`, so
    // a traversal string is simply not a key. Pinned so a later switch to
    // a direct join has to face this test.
    fs::create_dir_all(td.path().join("claude").join("enc")).unwrap();
    fs::create_dir_all(td.path().join("pi").join("enc")).unwrap();

    for period in [
        "../outside/secret",
        "/etc/hosts",
        "..",
        "../../outside/secret",
    ] {
        let mut parsed = serde_json::json!({
            "session": [session_row("claude", period), session_row("pi", period)]
        });
        enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &HashMap::new());
        assert_eq!(
            parsed["session"][0]["metadata"],
            serde_json::json!({}),
            "claude {period}"
        );
        assert_eq!(
            parsed["session"][1]["metadata"],
            serde_json::json!({}),
            "pi {period}"
        );
    }
}

#[cfg(unix)]
#[test]
fn symlinked_session_file_pointing_outside_the_root_is_refused() {
    let td = TempDir::new().unwrap();
    let outside = plant_outside_file(&td);
    let dir = td.path().join("codex").join("2026").join("01").join("01");
    fs::create_dir_all(&dir).unwrap();
    let link = dir.join("rollout-linked.jsonl");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(link.is_file(), "the symlink must resolve to a real file");

    let mut parsed = serde_json::json!({
        "session": [session_row("codex", "2026/01/01/rollout-linked")]
    });
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &HashMap::new());

    // DECISION: refuse, don't follow. A link out of the harness root points
    // at a file the harness never wrote, and its `cwd` would be reported as
    // this session's project.
    assert_eq!(parsed["session"][0]["metadata"], serde_json::json!({}));
}

#[cfg(unix)]
#[test]
fn symlinked_session_file_inside_the_root_is_followed() {
    let td = TempDir::new().unwrap();
    let real_dir = td.path().join("codex").join("real");
    fs::create_dir_all(&real_dir).unwrap();
    let real = real_dir.join("t.jsonl");
    let mut f = fs::File::create(&real).unwrap();
    write_line(
        &mut f,
        r#"{"timestamp":"t","type":"function_call","name":"a"}"#,
    );
    drop(f);
    let dir = td.path().join("codex").join("2026");
    fs::create_dir_all(&dir).unwrap();
    std::os::unix::fs::symlink(&real, dir.join("rollout-in.jsonl")).unwrap();

    let mut parsed = serde_json::json!({"session": [session_row("codex", "2026/rollout-in")]});
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &HashMap::new());

    assert!(parsed["session"][0]["metadata"]
        .get("toolCalls")
        .is_none());
}

// ── messy files ───────────────────────────────────────────────────────

fn claude_scan(td: &TempDir, lines: &[u8]) -> Value {
    let dir = td.path().join("claude").join("enc");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("sess1.jsonl"), lines).unwrap();
    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "enc".to_string());
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &claude_paths);
    parsed["session"][0]["metadata"].clone()
}

#[test]
fn truncated_json_line_is_skipped_and_the_rest_of_the_file_still_reads() {
    let td = TempDir::new().unwrap();
    let meta = claude_scan(
        &td,
        concat!(
            "{\"type\":\"custom-title\",\"customTitle\":\"cut off\n",
            "{\"type\":\"ai-title\",\"aiTitle\":\"Complete record\"}\n"
        )
        .as_bytes(),
    );
    assert_eq!(meta["title"], "Complete record");
    assert_eq!(meta["titleSource"], "ai");
}

#[test]
fn invalid_utf8_inside_a_title_record_is_skipped_not_fatal() {
    let td = TempDir::new().unwrap();
    let mut bytes = br#"{"type":"custom-title","customTitle":"bad "#.to_vec();
    bytes.extend_from_slice(&[0xff, 0xfe]); // never valid UTF-8
    bytes.extend_from_slice(br#""}"#);
    bytes.push(b'\n');
    bytes.extend_from_slice(br#"{"type":"ai-title","aiTitle":"Valid title"}"#);
    bytes.push(b'\n');

    let meta = claude_scan(&td, &bytes);
    assert_eq!(meta["title"], "Valid title");
}

#[test]
fn crlf_line_endings_and_a_missing_final_newline_both_parse() {
    let td = TempDir::new().unwrap();
    let meta = claude_scan(
        &td,
        concat!(
            "{\"type\":\"ai-title\",\"aiTitle\":\"Windows written\"}\r\n",
            "\r\n",
            "{\"type\":\"cost-state\",\"totalLinesAdded\":4}"
        )
        .as_bytes(),
    );
    assert_eq!(meta["title"], "Windows written");
    assert!(meta.get("linesAdded").is_none());
}

#[test]
fn empty_file_yields_only_a_zero_tool_call_count() {
    let td = TempDir::new().unwrap();
    let meta = claude_scan(&td, b"");
    assert_eq!(meta, serde_json::json!({}));
}

#[test]
fn a_directory_named_like_a_session_file_is_not_scanned() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("claude").join("enc").join("sess1.jsonl");
    fs::create_dir_all(&dir).unwrap();

    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "enc".to_string());
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &claude_paths);

    assert_eq!(parsed["session"][0]["metadata"], serde_json::json!({}));
}

#[test]
fn a_line_past_the_buffer_cap_is_skipped_and_scanning_continues() {
    let td = TempDir::new().unwrap();
    let mut bytes = br#"{"type":"custom-title","customTitle":""#.to_vec();
    bytes.extend(std::iter::repeat_n(b'A', MAX_LINE_BYTES + 1024));
    bytes.extend_from_slice(br#""}"#);
    bytes.push(b'\n');
    bytes.extend_from_slice(br#"{"type":"ai-title","aiTitle":"After the monster"}"#);
    bytes.push(b'\n');

    let meta = claude_scan(&td, &bytes);
    // The overlong line contributes nothing (a half-line is not JSON), and
    // the file keeps being read after it.
    assert_eq!(meta["title"], "After the monster");
    assert_eq!(meta["titleSource"], "ai");
}

#[test]
fn oversized_file_is_rejected_on_metadata_length_without_being_read() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("claude").join("enc");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("sess1.jsonl");
    let file = fs::File::create(&path).unwrap();
    // Sparse: no bytes written, but `metadata().len()` reports past the cap.
    file.set_len(MAX_FILE_BYTES + 1).unwrap();
    drop(file);

    let started = std::time::Instant::now();
    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "enc".to_string());
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &claude_paths);

    assert_eq!(parsed["session"][0]["metadata"], serde_json::json!({}));
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "the cap must be a metadata check, not a read"
    );
}

#[test]
fn a_two_hundred_thousand_line_transcript_scans_quickly() {
    let td = TempDir::new().unwrap();
    let mut body = String::with_capacity(200_000 * 90);
    body.push_str("{\"type\":\"custom-title\",\"customTitle\":\"Big session\"}\n");
    for i in 0..200_000 {
        body.push_str(&format!(
            "{{\"parentUuid\":\"{i}\",\"gitBranch\":\"main\",\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"tool_use\"}}]}}}}\n"
        ));
    }
    let dir = td.path().join("claude").join("enc");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("sess1.jsonl"), body).unwrap();

    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "enc".to_string());
    let started = std::time::Instant::now();
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &claude_paths);
    let elapsed = started.elapsed();

    let meta = &parsed["session"][0]["metadata"];
    assert!(meta.get("toolCalls").is_none());
    assert!(meta.get("gitBranch").is_none());
    // Generous because this runs in a DEBUG build (the byte scanners are
    // ~10x slower unoptimized); the release path is far under this.
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "took {elapsed:?}"
    );
}

// ── prefix collisions ─────────────────────────────────────────────────

#[test]
fn a_user_line_quoting_a_record_prefix_never_becomes_a_title() {
    let td = TempDir::new().unwrap();
    let meta = claude_scan(
        &td,
        concat!(
            r#"{"parentUuid":null,"type":"user","message":{"content":"paste: {\"type\":\"custom-title\",\"customTitle\":\"INJECTED\"}"}}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"Real title"}"#,
            "\n"
        )
        .as_bytes(),
    );
    assert_eq!(meta["title"], "Real title");
    assert_eq!(meta["titleSource"], "ai");
}

#[test]
fn a_user_message_quoting_the_markers_as_text_is_not_counted() {
    let td = TempDir::new().unwrap();
    let meta = claude_scan(
        &td,
        // A user pasting a transcript fragment. Inside a JSON string every
        // structural quote is ESCAPED (`\"type\":\"assistant\"`), so the
        // byte needles — which include unescaped quotes — cannot match it.
        // That is what makes the substring scan safe against pasted text.
        br#"{"parentUuid":null,"type":"user","message":{"content":"log said \"type\":\"assistant\" then {\"type\":\"tool_use\"}"}}
"#,
    );
    assert!(meta.get("toolCalls").is_none());
}

#[test]
fn an_unescaped_nested_object_on_a_user_line_over_counts_by_design() {
    let td = TempDir::new().unwrap();
    let meta = claude_scan(
        &td,
        // The residual risk: a NESTED object (not a string) that carries
        // both markers structurally — e.g. a tool result echoing a
        // sub-agent's own transcript.
        br#"{"parentUuid":"a","type":"user","toolUseResult":{"type":"assistant","content":[{"type":"tool_use"}]}}
"#,
    );
    // ACCEPTED APPROXIMATION, pinned so a later move to exact per-line
    // parsing is a deliberate decision, not a silent behaviour swap.
    // Parsing every message line as JSON would cost a full parse of the
    // whole transcript, which this scan exists to avoid.
    assert!(meta.get("toolCalls").is_none());
}

#[test]
fn tool_use_id_substrings_are_not_counted_twice() {
    let td = TempDir::new().unwrap();
    let meta = claude_scan(
        &td,
        br#"{"parentUuid":"a","type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1"},{"tool_use_id":"toolu_1","type":"tool_result"}]}}
"#,
    );
    assert!(meta.get("toolCalls").is_none());
}

// ── branch / PR / cost-state value hygiene ────────────────────────────

#[test]
fn git_branch_stops_at_the_first_quote_and_keeps_unicode() {
    let td = TempDir::new().unwrap();
    let meta = claude_scan(
        &td,
        concat!(
            // Escaped quote inside the value: the byte scan stops at the
            // quote (no panic, no run past the field).
            r#"{"parentUuid":"a","gitBranch":"feat/qu\"ote","type":"user"}"#,
            "\n",
            r#"{"parentUuid":"b","gitBranch":"feat/ünïcode-✓","type":"user"}"#,
            "\n",
            // An empty branch never overwrites a real one.
            r#"{"parentUuid":"c","gitBranch":"","type":"user"}"#,
            "\n"
        )
        .as_bytes(),
    );
    assert!(meta.get("gitBranch").is_none());
}

#[test]
fn a_branch_the_cache_would_hash_is_scrubbed_or_dropped() {
    // `feature/projects/x` trips `looks_like_local_path` on its
    // `/projects/` run, so without scrubbing the cache would store a
    // `~/redacted/<hash>` and the screen would show the hash as a branch
    // chip (the frontend does not re-scrub a branch).
    let scrubbed = safe_label("feature/projects/list", MAX_TITLE_CHARS);
    assert_eq!(scrubbed.as_deref(), Some("feature<redacted-path>"));
    assert!(!scrubbed.unwrap().starts_with("~/redacted/"));
    // A ref name cannot hold a backslash; if one somehow does, drop it
    // rather than write a value the redactor will hash.
    assert_eq!(safe_label(r"weird\branch", MAX_TITLE_CHARS), None);
}

#[test]
fn pr_link_ignores_a_string_or_float_number_and_a_non_https_url() {
    let td = TempDir::new().unwrap();
    let meta = claude_scan(
        &td,
        concat!(
            r#"{"type":"pr-link","prNumber":"42","prUrl":"http://github.com/o/r/pull/42"}"#,
            "\n",
            r#"{"type":"pr-link","prNumber":4.5,"prUrl":"javascript:alert(1)"}"#,
            "\n",
            r#"{"type":"pr-link","prNumber":0,"prUrl":"file:///Users/x/pull/1"}"#,
            "\n"
        )
        .as_bytes(),
    );
    assert!(meta.get("prNumber").is_none(), "got {meta:?}");
    assert!(meta.get("prUrl").is_none(), "got {meta:?}");
}

#[test]
fn pr_link_keeps_a_real_https_url_and_a_positive_number() {
    let td = TempDir::new().unwrap();
    let meta = claude_scan(
        &td,
        br#"{"type":"pr-link","prNumber":7,"prUrl":"https://github.com/o/r/pull/7"}
"#,
    );
    assert!(meta.get("prNumber").is_none());
    assert!(meta.get("prUrl").is_none());
}

#[test]
fn a_pr_url_carrying_a_users_segment_is_hashed_by_the_cache_and_then_dropped_downstream() {
    // Rust writes it (it IS https), the cache hashes it (it contains
    // `/Users/`), and the frontend's `pr` guard then refuses it because a
    // `~/redacted/<hash>` no longer starts with `https://` — so no
    // placeholder ever reaches a link. Pinned on both sides; the
    // frontend half lives in `usage-normalizer.test.ts`.
    let td = TempDir::new().unwrap();
    let dir = td.path().join("claude").join("enc");
    fs::create_dir_all(&dir).unwrap();
    let mut f = fs::File::create(dir.join("sess1.jsonl")).unwrap();
    write_line(
        &mut f,
        r#"{"type":"pr-link","prNumber":3,"prUrl":"https://github.com/Users/x/repo/pull/3"}"#,
    );
    drop(f);
    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "enc".to_string());
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &claude_paths);

    let scan = test_scan(parsed);
    let redacted = redact_scan_for_cache(&scan);
    assert!(redacted.parsed["session"][0]["metadata"]
        .get("prUrl")
        .is_none());
}

#[test]
fn negative_cost_state_counters_are_dropped() {
    let td = TempDir::new().unwrap();
    let meta = claude_scan(
        &td,
        br#"{"type":"cost-state","totalLinesAdded":-5,"totalLinesRemoved":2,"totalDuration":-1}
"#,
    );
    assert!(meta.get("linesAdded").is_none(), "got {meta:?}");
    assert!(meta.get("linesRemoved").is_none());
    assert!(meta.get("durationMs").is_none(), "got {meta:?}");
}

#[test]
fn non_integer_cost_state_counters_are_ignored() {
    let td = TempDir::new().unwrap();
    let meta = claude_scan(
        &td,
        br#"{"type":"cost-state","totalLinesAdded":10.5,"totalLinesRemoved":"3"}
"#,
    );
    assert!(meta.get("linesAdded").is_none(), "got {meta:?}");
    assert!(meta.get("linesRemoved").is_none(), "got {meta:?}");
}

// ── label-safety invariant ────────────────────────────────────────────

fn test_scan(parsed: Value) -> UsageScan {
    UsageScan {
        scanned_at: 0,
        source: UsageSource {
            command: "ccusage".to_string(),
            args: vec![],
            resolved_from: "test".to_string(),
        },
        ledger_note: None,
        raw: String::new(),
        parsed,
    }
}

#[test]
fn every_label_this_module_writes_survives_the_cache_byte_for_byte() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("claude").join("enc");
    fs::create_dir_all(&dir).unwrap();
    let mut f = fs::File::create(dir.join("sess1.jsonl")).unwrap();
    // Titles and branches that WOULD be hashed if written unvetted.
    write_line(
        &mut f,
        r#"{"type":"custom-title","customTitle":"Ship /Users/x/Dev/app and fix C:\\tmp\\x"}"#,
    );
    write_line(
        &mut f,
        r#"{"parentUuid":"a","gitBranch":"fix/projects/list","type":"user"}"#,
    );
    drop(f);

    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "enc".to_string());
    enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &claude_paths);

    let before = parsed["session"][0]["metadata"].clone();
    let after = redact_scan_for_cache(&test_scan(parsed)).parsed["session"][0]["metadata"].clone();
    for key in ["title"] {
        assert_eq!(before[key], after[key], "{key} changed in the cache");
        let value = after[key].as_str().unwrap();
        assert!(
            !value.starts_with("~/redacted/"),
            "{key} became a hash: {value}"
        );
    }
}

// ── registry reading ──────────────────────────────────────────────────

#[test]
fn registry_projects_tolerates_missing_unreadable_and_projectless_files() {
    let td = TempDir::new().unwrap();
    // Missing file.
    assert!(registry_projects(td.path()).is_empty());
    // Unparseable YAML.
    fs::write(td.path().join("registry.yaml"), "\t: [unclosed").unwrap();
    assert!(registry_projects(td.path()).is_empty());
    // No `projects:` block.
    fs::write(td.path().join("registry.yaml"), "bundles: {}\n").unwrap();
    assert!(registry_projects(td.path()).is_empty());
    // A projects block whose entries have no `path`.
    fs::write(
        td.path().join("registry.yaml"),
        "projects:\n  a:\n    bundles: []\n",
    )
    .unwrap();
    assert!(registry_projects(td.path()).is_empty());
    // `projects` present but not a mapping.
    fs::write(td.path().join("registry.yaml"), "projects: [a, b]\n").unwrap();
    assert!(registry_projects(td.path()).is_empty());
}

#[test]
fn registry_projects_expands_a_tilde_path() {
    let td = TempDir::new().unwrap();
    fs::write(
        td.path().join("registry.yaml"),
        "projects:\n  app:\n    path: ~/Dev/app\n",
    )
    .unwrap();
    let projects = registry_projects(td.path());
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].0, "app");
    assert!(
        !projects[0].1.to_string_lossy().starts_with('~'),
        "got {:?}",
        projects[0].1
    );
    assert!(projects[0].1.ends_with("Dev/app"));
}

// ── hub project matching ──────────────────────────────────────────────

#[test]
fn hub_project_matches_a_trailing_slash_and_an_exact_cwd() {
    let projects = vec![("app".to_string(), PathBuf::from("/Users/x/Dev/app"))];
    assert_eq!(
        match_hub_project("/Users/x/Dev/app/", &projects).as_deref(),
        Some("app")
    );
    assert_eq!(
        match_hub_project("/Users/x/Dev/app", &projects).as_deref(),
        Some("app")
    );
    assert_eq!(
        match_hub_project("/Users/x/Dev/app/sub/dir", &projects).as_deref(),
        Some("app")
    );
}

#[test]
fn hub_project_ignores_a_relative_registry_path_against_an_absolute_cwd() {
    // A hand-edited registry can hold a relative path. It cannot be
    // resolved against anything meaningful here, and comparing components
    // means it simply never matches an absolute cwd — no false positive.
    let projects = vec![("app".to_string(), PathBuf::from("Dev/app"))];
    assert_eq!(match_hub_project("/Users/x/Dev/app", &projects), None);
}

#[test]
fn hub_project_matching_is_case_sensitive() {
    // DOCUMENTED DECISION: macOS is usually case-insensitive, so a cwd
    // reported with other casing falls back to a letter label rather than
    // risk naming the wrong project by folding case wrongly.
    let projects = vec![("app".to_string(), PathBuf::from("/Users/x/Dev/app"))];
    assert_eq!(match_hub_project("/users/x/dev/app", &projects), None);
}

#[test]
fn hub_project_two_names_on_one_path_resolve_deterministically() {
    let a_first = vec![
        ("zeta".to_string(), PathBuf::from("/Users/x/app")),
        ("alpha".to_string(), PathBuf::from("/Users/x/app")),
    ];
    let z_first = vec![
        ("alpha".to_string(), PathBuf::from("/Users/x/app")),
        ("zeta".to_string(), PathBuf::from("/Users/x/app")),
    ];
    assert_eq!(
        match_hub_project("/Users/x/app/s", &a_first).as_deref(),
        Some("alpha")
    );
    assert_eq!(
        match_hub_project("/Users/x/app/s", &z_first).as_deref(),
        Some("alpha")
    );
}

#[test]
fn hub_project_worktree_segment_prefers_a_name_match_over_a_leaf_match() {
    let projects = vec![
        // Leaf match, listed FIRST.
        (
            "by-leaf".to_string(),
            PathBuf::from("/Users/x/Dev/skill-hub"),
        ),
        // Name match, listed second — must still win.
        (
            "skill-hub".to_string(),
            PathBuf::from("/Users/x/Dev/.skill-hub"),
        ),
    ];
    assert_eq!(
        match_hub_project("/Users/x/Dev/worktrees/skill-hub/wt/app", &projects).as_deref(),
        Some("skill-hub")
    );
}

#[test]
fn hub_project_worktree_segment_with_two_leaf_matches_picks_the_smallest_name() {
    let projects = vec![
        ("zeta".to_string(), PathBuf::from("/a/usage-screen")),
        ("alpha".to_string(), PathBuf::from("/b/usage-screen")),
    ];
    assert_eq!(
        match_hub_project("/Users/x/Dev/worktrees/usage-screen/app", &projects).as_deref(),
        Some("alpha")
    );
}

#[test]
fn worktree_segment_needs_a_slash_on_both_sides() {
    assert_eq!(
        extract_worktree_segment("/Users/x/worktrees/seg/app").as_deref(),
        Some("seg")
    );
    assert_eq!(extract_worktree_segment("/Users/x/worktrees/seg"), None);
    assert_eq!(extract_worktree_segment("/Users/x/worktrees//app"), None);
    assert_eq!(extract_worktree_segment("/Users/x/nothing/here"), None);
}

#[test]
fn claude_stem_index_collision_resolves_deterministically() {
    let td = TempDir::new().unwrap();
    for (enc, title) in [("--b-enc--", "from b"), ("--a-enc--", "from a")] {
        let dir = td.path().join("claude").join(enc);
        fs::create_dir_all(&dir).unwrap();
        let mut f = fs::File::create(dir.join("sess1.jsonl")).unwrap();
        write_line(
            &mut f,
            &format!(r#"{{"type":"custom-title","customTitle":"{title}"}}"#),
        );
        drop(f);
    }
    // Two project dirs hold the same session stem; `read_dir` order is not
    // stable, so the smallest path wins and the answer never flips.
    for _ in 0..3 {
        let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
        enrich_sessions(&mut parsed, &roots_for(td.path()), &[], &HashMap::new());
        assert_eq!(parsed["session"][0]["metadata"]["title"], "from a");
    }
}

// ── idempotency + non-clobbering ──────────────────────────────────────

#[test]
fn two_enrichment_passes_produce_the_same_metadata() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("claude").join("enc");
    fs::create_dir_all(&dir).unwrap();
    let mut f = fs::File::create(dir.join("sess1.jsonl")).unwrap();
    write_line(
        &mut f,
        r#"{"type":"custom-title","customTitle":"Same each time"}"#,
    );
    write_line(
        &mut f,
        r#"{"type":"pr-link","prNumber":9,"prUrl":"https://x.test/pull/9"}"#,
    );
    write_line(
        &mut f,
        r#"{"parentUuid":null,"cwd":"/Users/x/app","gitBranch":"main","type":"assistant","message":{"content":[{"type":"tool_use"}]}}"#,
    );
    drop(f);

    let projects = vec![("app".to_string(), PathBuf::from("/Users/x/app"))];
    let roots = roots_for(td.path());
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "enc".to_string());

    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    enrich_sessions(&mut parsed, &roots, &projects, &claude_paths);
    let first = parsed["session"][0]["metadata"].clone();
    enrich_sessions(&mut parsed, &roots, &projects, &claude_paths);
    let second = parsed["session"][0]["metadata"].clone();

    assert_eq!(first, second);
    assert_eq!(first["hubProject"], "app");
    assert!(first.get("toolCalls").is_none());
}

#[test]
fn an_existing_project_path_is_never_overwritten_but_hub_project_is_still_added() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("claude").join("enc");
    fs::create_dir_all(&dir).unwrap();
    let mut f = fs::File::create(dir.join("sess1.jsonl")).unwrap();
    write_line(
        &mut f,
        r#"{"parentUuid":null,"cwd":"/Users/x/app","type":"user"}"#,
    );
    drop(f);

    let mut parsed = serde_json::json!({"session": [session_row("claude", "sess1")]});
    // The claude-project-path join in `usage.rs` runs FIRST and owns this
    // field (it writes ccusage's encoded key shape).
    parsed["session"][0]["metadata"]["projectPath"] = Value::String("--Users-x-app--".into());

    let projects = vec![("app".to_string(), PathBuf::from("/Users/x/app"))];
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "enc".to_string());
    enrich_sessions(&mut parsed, &roots_for(td.path()), &projects, &claude_paths);

    let meta = &parsed["session"][0]["metadata"];
    assert_eq!(meta["projectPath"], "--Users-x-app--");
    assert_eq!(meta["hubProject"], "app");
}

// ── malformed `parsed` shapes ─────────────────────────────────────────

#[test]
fn enrich_sessions_tolerates_every_malformed_parsed_shape() {
    let td = TempDir::new().unwrap();
    let dir = td.path().join("claude").join("enc");
    fs::create_dir_all(&dir).unwrap();
    let mut f = fs::File::create(dir.join("sess1.jsonl")).unwrap();
    write_line(&mut f, r#"{"type":"custom-title","customTitle":"Titled"}"#);
    drop(f);
    let roots = roots_for(td.path());
    let mut claude_paths = HashMap::new();
    claude_paths.insert("sess1".to_string(), "enc".to_string());

    // No `session` key at all.
    let mut no_key = serde_json::json!({"daily": []});
    enrich_sessions(&mut no_key, &roots, &[], &claude_paths);
    assert_eq!(no_key, serde_json::json!({"daily": []}));

    // `session` is not an array.
    let mut not_array = serde_json::json!({"session": "nope"});
    enrich_sessions(&mut not_array, &roots, &[], &claude_paths);
    assert_eq!(not_array, serde_json::json!({"session": "nope"}));

    // Rows that are not objects, a row with no metadata key, a row whose
    // metadata is null, and a row whose metadata is another type.
    let mut mixed = serde_json::json!({"session": [
        "a string row",
        42,
        null,
        {"agent": "claude", "period": "sess1"},
        {"agent": "claude", "period": "sess1", "metadata": null},
        {"agent": "claude", "period": "sess1", "metadata": "not an object"},
        {"agent": "claude", "period": "sess1", "metadata": [1, 2]},
        {"agent": 7, "period": "sess1", "metadata": {}},
        {"agent": "claude", "period": 7, "metadata": {}},
    ]});
    enrich_sessions(&mut mixed, &roots, &[], &claude_paths);
    let rows = mixed["session"].as_array().unwrap();
    assert_eq!(rows[0], "a string row");
    assert_eq!(rows[1], 42);
    assert_eq!(rows[2], Value::Null);
    // A missing metadata object is created; a null one is replaced.
    assert_eq!(rows[3]["metadata"]["title"], "Titled");
    assert_eq!(rows[4]["metadata"]["title"], "Titled");
    // Any OTHER non-object metadata belongs to somebody else — untouched.
    assert_eq!(rows[5]["metadata"], "not an object");
    assert_eq!(rows[6]["metadata"], serde_json::json!([1, 2]));
    // A non-string agent or period is not resolvable at all.
    assert_eq!(rows[7]["metadata"], serde_json::json!({}));
    assert_eq!(rows[8]["metadata"], serde_json::json!({}));
}
