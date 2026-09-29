use super::*;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Locate the repo root (where `hub.py` lives) by walking up from this file.
fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = app/src-tauri ; repo root is two levels up.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(Path::parent)
        .expect("repo root from app/src-tauri")
        .to_path_buf()
}

fn python_bin() -> String {
    std::env::var("PYTHON").unwrap_or_else(|_| "python3".to_string())
}

/// Spawn the REAL CLI against hermetic tmp dirs and deserialize stdout into
/// `SubagentListResult`. Proves the payload parses into the contract struct
/// and that the ten asserted fields carry the expected values; a field the
/// struct declares as non-optional now fails deserialization outright if
/// `hub.py` omits or renames it (see `SubagentListItem`'s fields without
/// `#[serde(default)]`). It does not prove every field round-trips, only
/// that the ones checked here do and that the required ones are present.
#[test]
fn list_json_deserializes_into_contract_struct() {
    let root = repo_root();
    let hub = root.join("hub.py");
    if !hub.exists() {
        panic!(
            "hub.py not found at {} - the repo-root walk is wrong",
            hub.display()
        );
    }

    // Hermetic homes: a tmp claude home with one synthetic agent, and a tmp
    // data home so we never touch the real ~/.claude or ~/.skill-hub.
    let base = std::env::temp_dir().join(format!(
        "subagent-contract-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let claude_home = base.join("claude");
    let agents_dir = claude_home.join("agents");
    let data_home = base.join("data");
    std::fs::create_dir_all(&agents_dir).expect("create agents dir");
    std::fs::create_dir_all(&data_home).expect("create data home");

    let agent_md = "---\nname: contract-probe\ndescription: A synthetic agent for the Rust contract test.\nmodel: sonnet\ntools: Read, Grep\nskills:\n  - some-skill\ncolor: blue\n---\nYou are a probe.\n";
    std::fs::write(agents_dir.join("contract-probe.md"), agent_md).expect("write synthetic agent");
    // Minimal data home so hub.py's optional registry read succeeds.
    std::fs::write(data_home.join("registry.yaml"), "projects: {}\n").expect("write registry");

    let output = Command::new(python_bin())
        .arg(&hub)
        .args(["subagent", "list", "--scope", "user", "--json"])
        .current_dir(&root)
        .env("HOME", &base)
        .env("CODEX_HOME", base.join(".codex"))
        .env("SKILL_HUB_CLAUDE_HOME", &claude_home)
        .env("SKILL_HUB_HOME", &data_home)
        .env_remove("SKILL_HUB_DIR")
        .env_remove("SKILL_HUB_CODE")
        .output()
        .expect("spawn hub.py subagent list");

    // Clean up tmp tree regardless of assertion outcome.
    let _ = std::fs::remove_dir_all(&base);

    assert!(
        output.status.success(),
        "hub.py subagent list failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let result: SubagentListResult = serde_json::from_slice(&output.stdout).unwrap_or_else(|e| {
        panic!(
            "SubagentListResult failed to deserialize CLI JSON (field drift?): {e}\n{}",
            String::from_utf8_lossy(&output.stdout)
        )
    });

    assert_eq!(result.scope, "user");
    let probe = result
        .agents
        .iter()
        .find(|a| a.name == "contract-probe")
        .expect("synthetic agent present in list");
    assert_eq!(probe.model, "sonnet");
    assert_eq!(probe.tools_mode, "allowlist");
    assert!(probe.tools.contains(&"Read".to_string()));
    assert!(probe.skills.contains(&"some-skill".to_string()));
    assert!(!probe.builtin);
    // Claude payloads never carry the codex-only extras.
    assert!(probe.sandbox_mode.is_none());
    assert!(probe.model_reasoning_effort.is_none());
    assert!(probe.nickname_candidates.is_none());
    // `harness` is additive and defaults on the shipped shape.
    assert_eq!(result.harness.as_deref(), Some("claude-code"));
}

// ─── Codex parity (task 2.3) ──────────────────────────────────────────

/// A hermetic env for the codex CLI: HOME (the `~/.agents/skills` root),
/// CODEX_HOME (the agents dir), a tmp claude home, and a tmp data home —
/// never the real `~/.codex`, `~/.agents`, or `~/.claude`.
struct CodexEnv {
    base: PathBuf,
    home: PathBuf,
    codex_home: PathBuf,
    claude_home: PathBuf,
    data_home: PathBuf,
    agents_dir: PathBuf,
}

fn make_codex_env() -> CodexEnv {
    let base = std::env::temp_dir().join(format!(
        "subagent-codex-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let home = base.join("home");
    let codex_home = base.join("codexhome");
    let claude_home = base.join("claude");
    let data_home = base.join("data");
    let agents_dir = codex_home.join("agents");
    std::fs::create_dir_all(&agents_dir).expect("create codex agents dir");
    std::fs::create_dir_all(home.join(".agents").join("skills")).expect("create codex skills root");
    std::fs::create_dir_all(claude_home.join("agents")).expect("create claude agents dir");
    std::fs::create_dir_all(&data_home).expect("create data home");
    std::fs::write(data_home.join("registry.yaml"), "projects: {}\n").expect("write registry");
    CodexEnv {
        base,
        home,
        codex_home,
        claude_home,
        data_home,
        agents_dir,
    }
}

/// Spawn the REAL CLI for a codex subcommand against the hermetic env,
/// piping optional stdin. Returns (stdout, stderr, success).
fn run_codex_cli(
    env: &CodexEnv,
    root: &Path,
    hub: &Path,
    args: &[&str],
    stdin: Option<&str>,
) -> (String, String, bool) {
    let mut cmd = Command::new(python_bin());
    cmd.arg(hub)
        .args(args)
        .current_dir(root)
        .env("HOME", &env.home)
        .env("CODEX_HOME", &env.codex_home)
        .env("SKILL_HUB_CLAUDE_HOME", &env.claude_home)
        .env("SKILL_HUB_HOME", &env.data_home)
        .env_remove("SKILL_HUB_DIR")
        .env_remove("SKILL_HUB_CODE");
    let out = if let Some(payload) = stdin {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().expect("spawn hub.py");
        child
            .stdin
            .as_mut()
            .expect("child stdin")
            .write_all(payload.as_bytes())
            .expect("write payload");
        child.wait_with_output().expect("wait hub.py")
    } else {
        cmd.output().expect("spawn hub.py")
    };
    (
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
        out.status.success(),
    )
}

/// list/show/save against `--harness codex` deserialize into the extended
/// structs with the codex-only fields populated — proving Rust matches the
/// live JSON contract for the codex path.
#[test]
fn codex_json_deserializes_into_contract_struct() {
    let root = repo_root();
    let hub = root.join("hub.py");
    if !hub.exists() {
        panic!(
            "hub.py not found at {} - the repo-root walk is wrong",
            hub.display()
        );
    }
    let env = make_codex_env();

    // A sample user-scope codex agent (TOML).
    let toml = "name = \"rust_parity\"\ndescription = \"d\"\ndeveloper_instructions = \"x\"\nsandbox_mode = \"read-only\"\n";
    std::fs::write(env.agents_dir.join("rust_parity.toml"), toml).expect("write codex agent");

    // ── list ──────────────────────────────────────────────────────────
    let (stdout, stderr, ok) = run_codex_cli(
        &env,
        &root,
        &hub,
        &["subagent", "list", "--harness", "codex", "--json"],
        None,
    );
    assert!(ok, "codex list failed: {stdout}{stderr}");
    let list: SubagentListResult = serde_json::from_str(&stdout).unwrap_or_else(|e| {
        let _ = std::fs::remove_dir_all(&env.base);
        panic!("SubagentListResult codex field drift: {e}\n{stdout}");
    });
    assert_eq!(list.harness.as_deref(), Some("codex"));
    assert_eq!(list.settings_path, "");
    let item = list
        .agents
        .iter()
        .find(|a| a.name == "rust_parity")
        .expect("codex agent present");
    assert_eq!(item.sandbox_mode.as_deref(), Some("read-only"));
    // Inert claude defaults + codex extras present.
    assert_eq!(item.tools_mode, "all");
    assert!(item.model_reasoning_effort.is_some());
    assert!(item.nickname_candidates.is_some());
    // Built-ins carry the codex trio.
    assert!(list.builtins.iter().any(|b| b.name == "worker"));

    // ── show ──────────────────────────────────────────────────────────
    let (stdout, stderr, ok) = run_codex_cli(
        &env,
        &root,
        &hub,
        &[
            "subagent",
            "show",
            "--harness",
            "codex",
            "--name",
            "rust_parity",
            "--json",
        ],
        None,
    );
    assert!(ok, "codex show failed: {stdout}{stderr}");
    let show: SubagentShow = serde_json::from_str(&stdout).unwrap_or_else(|e| {
        let _ = std::fs::remove_dir_all(&env.base);
        panic!("SubagentShow codex field drift: {e}\n{stdout}");
    });
    assert!(show.exists);
    assert_eq!(show.advanced_format, "toml");
    assert_eq!(show.safe.sandbox_mode.as_deref(), Some("read-only"));

    // ── save round-trip via stdin with harness=codex ───────────────────
    let payload = SubagentSavePayload {
        harness: Some("codex".to_string()),
        scope: "user".to_string(),
        project: None,
        original_name: None,
        safe: SubagentSafe {
            name: "rust_saved".to_string(),
            description: "saved by the rust parity test".to_string(),
            sandbox_mode: Some("workspace-write".to_string()),
            ..Default::default()
        },
        advanced_yaml: String::new(),
        body: "Do the parity thing.\n".to_string(),
    };
    let body = serde_json::to_string(&payload).expect("serialize save payload");
    let (stdout, stderr, ok) = run_codex_cli(
        &env,
        &root,
        &hub,
        &["subagent", "save", "--json"],
        Some(&body),
    );
    assert!(ok, "codex save failed: {stdout}{stderr}");
    let saved: SubagentSaveResult = serde_json::from_str(&stdout).unwrap_or_else(|e| {
        let _ = std::fs::remove_dir_all(&env.base);
        panic!("SubagentSaveResult drift: {e}\n{stdout}");
    });

    let _ = std::fs::remove_dir_all(&env.base);
    assert!(saved.ok, "codex save reported failure: {stdout}");
    assert_eq!(saved.name.as_deref(), Some("rust_saved"));
    assert!(saved.file.map(|f| f.ends_with(".toml")).unwrap_or(false));
}

// ─── Linked twins (D3) round-trip ──────────────────────────────────────

/// link → link-status → unlink against the live CLI: a matching
/// claude `.md` + codex `.toml` pair links, surfaces in status, then
/// unlinks. Proves the Wave-4 bridge commands drive the real link sidecar.
#[test]
fn link_status_unlink_round_trip() {
    let root = repo_root();
    let hub = root.join("hub.py");
    if !hub.exists() {
        panic!(
            "hub.py not found at {} - the repo-root walk is wrong",
            hub.display()
        );
    }
    let env = make_codex_env();

    // Two twins with the SAME name (valid for both slug rules).
    let md = "---\nname: twin\ndescription: A linked twin.\nmodel: sonnet\n---\nShared body.\n";
    std::fs::write(env.claude_home.join("agents").join("twin.md"), md).expect("write claude twin");
    let toml = "name = \"twin\"\ndescription = \"A linked twin.\"\ndeveloper_instructions = \"Shared body.\"\n";
    std::fs::write(env.agents_dir.join("twin.toml"), toml).expect("write codex twin");

    // ── link (no --copy-from: both files already present) ────────────────
    let (stdout, stderr, ok) = run_codex_cli(
        &env,
        &root,
        &hub,
        &["subagent", "link", "--name", "twin", "--json"],
        None,
    );
    assert!(ok, "link failed: {stdout}{stderr}");
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_else(|e| {
        let _ = std::fs::remove_dir_all(&env.base);
        panic!("link JSON parse: {e}\n{stdout}");
    });
    assert_eq!(v["ok"], serde_json::json!(true), "link not ok: {stdout}");

    // ── link-status: the pair is present ─────────────────────────────────
    let (stdout, stderr, ok) = run_codex_cli(
        &env,
        &root,
        &hub,
        &["subagent", "link-status", "--json"],
        None,
    );
    assert!(ok, "link-status failed: {stdout}{stderr}");
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_else(|e| {
        let _ = std::fs::remove_dir_all(&env.base);
        panic!("link-status JSON parse: {e}\n{stdout}");
    });
    let linked = v["links"]
        .as_array()
        .map(|a| a.iter().any(|l| l["name"] == "twin"))
        .unwrap_or(false);
    assert!(linked, "twin not in link-status: {stdout}");

    // ── unlink: durable removal (files untouched) ────────────────────────
    let (stdout, stderr, ok) = run_codex_cli(
        &env,
        &root,
        &hub,
        &["subagent", "unlink", "--name", "twin", "--json"],
        None,
    );
    assert!(ok, "unlink failed: {stdout}{stderr}");
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_else(|e| {
        let _ = std::fs::remove_dir_all(&env.base);
        panic!("unlink JSON parse: {e}\n{stdout}");
    });
    let _ = std::fs::remove_dir_all(&env.base);
    assert_eq!(v["ok"], serde_json::json!(true), "unlink not ok: {stdout}");
    assert_eq!(
        v["unlinked"],
        serde_json::json!(true),
        "not unlinked: {stdout}"
    );
}

// ─── Attach-skill provisioning (D5) round-trip ─────────────────────────

/// provision-skill --global against the live CLI: a non-global registry
/// skill is flipped to `scope: global`, the global-skills pass re-runs, and
/// the returned path exists on disk. Proves the Wave-5 bridge drives the real
/// two-phase provisioner.
#[test]
fn provision_skill_global_round_trip() {
    let root = repo_root();
    let hub = root.join("hub.py");
    if !hub.exists() {
        panic!(
            "hub.py not found at {} - the repo-root walk is wrong",
            hub.display()
        );
    }
    // Bespoke hermetic env: HOME carries BOTH harness detection markers +
    // their global skill dirs (claude → $HOME/.claude/skills via ~ expansion;
    // codex → $HOME/.agents/skills). SKILL_HUB_CLAUDE_HOME + CODEX_HOME point
    // at the SAME $HOME dirs so detection and resolution agree (mirrors the
    // pytest prov_env). Never touches the real homes.
    let base = std::env::temp_dir().join(format!(
        "subagent-prov-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let home = base.join("home");
    let claude = home.join(".claude");
    let codex = home.join(".codex");
    let data_home = base.join("data");
    std::fs::create_dir_all(claude.join("projects")).expect("claude detection marker");
    std::fs::create_dir_all(claude.join("skills")).expect("claude global skills dir");
    std::fs::create_dir_all(codex.join("agents")).expect("codex agents dir");
    std::fs::write(codex.join("config.toml"), "").expect("codex detection marker");
    std::fs::create_dir_all(home.join(".agents").join("skills")).expect("codex skills root");
    std::fs::create_dir_all(&data_home).expect("data home");

    // A real skill SOURCE dir the registry points at.
    let src = base.join("skillsrc").join("myskill");
    std::fs::create_dir_all(&src).expect("create skill source");
    std::fs::write(
        src.join("SKILL.md"),
        "---\nname: myskill\ndescription: my skill\n---\nBody\n",
    )
    .expect("write SKILL.md");

    // Registry: one non-global (portable) skill + both harnesses global.
    let reg = format!(
        "harnesses_global: [claude-code, codex]\nskills:\n  myskill:\n    source: {}\n    scope: portable\n    type: claude-skill\n    description: my skill\nprojects: {{}}\n",
        src.display()
    );
    std::fs::write(data_home.join("registry.yaml"), reg).expect("write registry");

    let mut cmd = Command::new(python_bin());
    cmd.arg(&hub)
        .args([
            "subagent",
            "provision-skill",
            "--skill",
            "myskill",
            "--global",
            "--harness",
            "claude-code",
            "--json",
        ])
        .current_dir(&root)
        .env("HOME", &home)
        .env("CODEX_HOME", &codex)
        .env("SKILL_HUB_CLAUDE_HOME", &claude)
        .env("SKILL_HUB_HOME", &data_home)
        .env_remove("SKILL_HUB_DIR")
        .env_remove("SKILL_HUB_CODE");
    let out = cmd.output().expect("spawn hub.py provision-skill");
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let ok = out.status.success();
    assert!(ok, "provision failed: {stdout}{stderr}");
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_else(|e| {
        let _ = std::fs::remove_dir_all(&base);
        panic!("provision JSON parse: {e}\n{stdout}");
    });
    let path = v["path"].as_str().unwrap_or_default().to_string();
    let path_exists = !path.is_empty() && std::path::Path::new(&path).exists();
    let ok_flag = v["ok"] == serde_json::json!(true);
    let mode = v["mode"].as_str().unwrap_or_default().to_string();
    let _ = std::fs::remove_dir_all(&base);
    assert!(ok_flag, "provision not ok: {stdout}");
    assert_eq!(mode, "make-global", "unexpected mode: {stdout}");
    assert!(
        path.replace('\\', "/").ends_with("myskill/SKILL.md"),
        "unexpected provisioned path: {path}"
    );
    assert!(path_exists, "provisioned path missing on disk: {path}");
}
