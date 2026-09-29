"""Engine CLI extensions for the Permissions UI bridge.

Covers the verbs added in change `add-permissions-ui` section 1:
- `permissions set --stdin-json|--json-file`
- `permissions validate --kind --pattern [--json]`
- `permissions capabilities [--json]`
- `permissions disable --json` (refactored structured payload)
- `permissions adopt --json`
- `permissions show --global --json` (adoption_required field)

Subprocess-driven so we exercise the actual argparse tree and lock semantics.
HOME is pointed at the tmp data home so harness detection (which inspects
`~/.claude/`, `~/.pi/`, etc.) and ClaudePermissionAdapter's global target path
(`~/.claude/settings.json`) are both isolated per test.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
HUB_PY = REPO_ROOT / "hub.py"


def _env(data_home: Path) -> dict[str, str]:
    env = {
        **os.environ,
        "SKILL_HUB_HOME": str(data_home),
        "SKILL_HUB_CODE": str(REPO_ROOT),
        "HOME": str(data_home),
    }
    env.pop("SKILL_HUB_DIR", None)
    # The repository-wide safety fixture supplies separate agent roots for
    # in-process tests.  This subprocess suite deliberately models HOME as
    # the data home, so make the captured native roots agree with that model.
    env["SKILL_HUB_CLAUDE_HOME"] = str(data_home / ".claude")
    env["CODEX_HOME"] = str(data_home / ".codex")
    # When HOME is rewritten the subprocess loses its user-site (pyyaml lives
    # under the real ~/.local). Pin PYTHONUSERBASE to the original user base so
    # imports still resolve.
    import site

    user_base = os.environ.get("PYTHONUSERBASE") or os.path.dirname(
        os.path.dirname(os.path.dirname(site.getusersitepackages()))
    )
    env["PYTHONUSERBASE"] = user_base
    return env


def _run(
    args: list[str], data_home: Path, stdin: str | None = None, expect_zero: bool = True
) -> subprocess.CompletedProcess:
    result = subprocess.run(
        [sys.executable, str(HUB_PY), *args],
        capture_output=True,
        text=True,
        env=_env(data_home),
        cwd=str(data_home),
        input=stdin,
    )
    if expect_zero and result.returncode != 0:
        raise AssertionError(
            f"hub {args} failed (rc={result.returncode}): "
            f"stderr={result.stderr!r}\nstdout={result.stdout!r}"
        )
    return result


def _seed(data_home: Path, registry: dict) -> None:
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _install_claude_only(data_home: Path) -> None:
    """Make harness detection see ONLY claude-code by creating its marker dir.

    Uses `harnesses.HARNESSES["claude-code"].detect = DotDirWithMarker(dir="~/.claude",
    marker="projects")`; with HOME=data_home, `~/.claude/projects/` makes it detected.
    """
    (data_home / ".claude" / "projects").mkdir(parents=True, exist_ok=True)


def _install_claude_and_pi(data_home: Path) -> None:
    (data_home / ".claude" / "projects").mkdir(parents=True, exist_ok=True)
    (data_home / ".pi" / "agent").mkdir(parents=True, exist_ok=True)


# ─────────────────────────────────────────────────────────────────────────────
# Section 1.1 — `permissions set`
# ─────────────────────────────────────────────────────────────────────────────


def test_set_atomic_no_op(tmp_data_home):
    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {
                "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
            },
            "projects": {},
            "skills": {},
            "remotes": {},
        },
    )
    reg_file = tmp_data_home / "registry.yaml"
    mtime_before = reg_file.stat().st_mtime_ns

    payload = {"allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]}
    # Tiny sleep so mtime would visibly change if a write happened
    time.sleep(0.02)
    r = _run(
        ["permissions", "set", "--global", "--stdin-json"],
        tmp_data_home,
        stdin=json.dumps(payload),
    )

    body = json.loads(r.stdout)
    assert body["changed"] is False
    assert "normalized" in body
    assert reg_file.stat().st_mtime_ns == mtime_before, (
        "registry mtime changed on no-op"
    )


def test_set_replaces_block(tmp_data_home):
    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {
                "allow": [
                    {"pattern": "Bash(npm:*)", "kind": "allow"},
                    {"pattern": "Read(*)", "kind": "allow"},
                    {"pattern": "Edit(*)", "kind": "allow"},
                ]
            },
            "projects": {},
            "skills": {},
        },
    )
    payload = {
        "allow": [
            {"pattern": "Bash(git:*)", "kind": "allow"},
            {"pattern": "Bash(yarn:*)", "kind": "allow"},
        ],
        "deny": [{"pattern": "Bash(rm)", "kind": "deny"}],
    }
    r = _run(
        ["permissions", "set", "--global", "--stdin-json"],
        tmp_data_home,
        stdin=json.dumps(payload),
    )
    body = json.loads(r.stdout)
    assert body["changed"] is True

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    g = reg["permissions_global"]
    assert {r["pattern"] for r in g["allow"]} == {"Bash(git:*)", "Bash(yarn:*)"}
    assert g["deny"][0]["pattern"] == "Bash(rm)"


def test_set_collapses_duplicate_global_rules(tmp_data_home):
    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {
                "allow": [
                    {"pattern": "Bash(*)", "kind": "allow"},
                    {"pattern": "Bash(*)", "kind": "allow"},
                    {"pattern": "Bash(npm:*)", "kind": "allow"},
                ],
                "hooks": [
                    {"event": "PreToolUse", "matcher": "Bash", "command": "echo ok"},
                    {"event": "PreToolUse", "matcher": "Bash", "command": "echo ok"},
                ],
            },
            "projects": {},
            "skills": {},
        },
    )
    payload = {
        "allow": [
            {"pattern": "Bash(*)", "kind": "allow"},
            {"pattern": "Bash(npm:*)", "kind": "allow"},
        ]
    }
    r = _run(
        ["permissions", "set", "--global", "--stdin-json"],
        tmp_data_home,
        stdin=json.dumps(payload),
    )
    body = json.loads(r.stdout)
    assert body["changed"] is True

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert [r["pattern"] for r in reg["permissions_global"]["allow"]] == [
        "Bash(*)",
        "Bash(npm:*)",
    ]
    assert len(reg["permissions_global"].get("hooks") or []) == 0


def test_show_reports_duplicate_collapse_count(tmp_data_home):
    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {
                "allow": [
                    {"pattern": "Bash(*)", "kind": "allow"},
                    {"pattern": "Bash(*)", "kind": "allow"},
                ]
            },
            "projects": {},
            "skills": {},
        },
    )
    r = _run(["permissions", "show", "--global", "--json"], tmp_data_home)
    body = json.loads(r.stdout)
    assert body["duplicate_collapsed"] == 1
    assert len(body["allow"]) == 1


def test_set_concurrent_lock_serialises(tmp_data_home):
    """Two concurrent `set` invocations must serialise via the data-home lock."""
    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {},
            "projects": {},
            "skills": {},
        },
    )

    def spawn(pattern: str):
        return subprocess.Popen(
            [
                sys.executable,
                str(HUB_PY),
                "permissions",
                "set",
                "--global",
                "--stdin-json",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=_env(tmp_data_home),
            cwd=str(tmp_data_home),
            text=True,
        )

    payload_a = json.dumps({"allow": [{"pattern": "A", "kind": "allow"}]})
    payload_b = json.dumps({"allow": [{"pattern": "B", "kind": "allow"}]})
    p1 = spawn("A")
    p2 = spawn("B")
    out1, err1 = p1.communicate(payload_a, timeout=10)
    out2, err2 = p2.communicate(payload_b, timeout=10)
    assert p1.returncode == 0, err1
    assert p2.returncode == 0, err2

    # Both succeeded; final state matches one of them (the later writer wins).
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    patterns = {r["pattern"] for r in (reg["permissions_global"].get("allow") or [])}
    assert patterns in ({"A"}, {"B"}), patterns


def test_set_json_file_input(tmp_data_home):
    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {},
            "projects": {},
            "skills": {},
        },
    )
    payload_path = tmp_data_home / "payload.json"
    payload_path.write_text(
        json.dumps({"deny": [{"pattern": "Bash(rm)", "kind": "deny"}]})
    )
    r = _run(
        ["permissions", "set", "--global", "--json-file", str(payload_path)],
        tmp_data_home,
    )
    body = json.loads(r.stdout)
    assert body["changed"] is True
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert reg["permissions_global"]["deny"][0]["pattern"] == "Bash(rm)"


def test_set_requires_exactly_one_input_source(tmp_data_home):
    reg = {"harnesses_global": [], "projects": {}, "skills": {}}
    _seed(tmp_data_home, reg)
    # Argparse mutually-exclusive group rejects neither: a usage error (exit 2),
    # not the application's own `fail()` (exit 1).
    r = _run(["permissions", "set", "--global"], tmp_data_home, expect_zero=False)
    assert r.returncode == 2
    assert "one of the arguments --stdin-json --json-file is required" in r.stderr
    reg_after = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert reg_after == reg


# ─────────────────────────────────────────────────────────────────────────────
# Section 1.2 — `permissions validate`
# ─────────────────────────────────────────────────────────────────────────────


def test_validate_ok(tmp_data_home):
    _seed(tmp_data_home, {"harnesses_global": [], "projects": {}, "skills": {}})
    r = _run(
        [
            "permissions",
            "validate",
            "--kind",
            "allow",
            "--pattern",
            "Bash(npm:*)",
            "--json",
        ],
        tmp_data_home,
    )
    body = json.loads(r.stdout)
    assert body == {"ok": True, "error": None}


def test_validate_empty_pattern_fails(tmp_data_home):
    _seed(tmp_data_home, {"harnesses_global": [], "projects": {}, "skills": {}})
    # Pass a single space which the ClaudePermissionAdapter.validate accepts —
    # but the empty string is what fails. Use a value argparse will accept but
    # the validator rejects.
    r = _run(
        ["permissions", "validate", "--kind", "allow", "--pattern", "", "--json"],
        tmp_data_home,
    )
    body = json.loads(r.stdout)
    assert body["ok"] is False
    assert body["error"]


# ─────────────────────────────────────────────────────────────────────────────
# Section 1.3 — `permissions capabilities`
# ─────────────────────────────────────────────────────────────────────────────


def test_capabilities_per_installed_harness(tmp_data_home):
    _install_claude_only(tmp_data_home)
    _seed(tmp_data_home, {"harnesses_global": [], "projects": {}, "skills": {}})
    r = _run(["permissions", "capabilities", "--json"], tmp_data_home)
    body = json.loads(r.stdout)
    assert "claude-code" in body
    assert "codex" not in body  # not installed in this env
    assert "tool_allowlist" in body["claude-code"]
    assert "tool_denylist" in body["claude-code"]
    assert "tool_ask" in body["claude-code"]
    assert "hooks" in body["claude-code"]


def test_capabilities_omits_uninstalled(tmp_data_home):
    # No marker dirs created → no harness is "installed".
    _seed(tmp_data_home, {"harnesses_global": [], "projects": {}, "skills": {}})
    r = _run(["permissions", "capabilities", "--json"], tmp_data_home)
    body = json.loads(r.stdout)
    assert body == {}


# ─────────────────────────────────────────────────────────────────────────────
# Section 1.4 — `permissions disable --json`
# ─────────────────────────────────────────────────────────────────────────────


def test_disable_json_dry_run(tmp_data_home):
    _install_claude_only(tmp_data_home)
    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {},
            "projects": {
                "alpha": {
                    "path": str(tmp_data_home / "alpha"),
                    "permissions": {
                        "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
                    },
                },
            },
            "skills": {},
        },
    )
    (tmp_data_home / "alpha").mkdir(exist_ok=True)
    r = _run(
        ["permissions", "disable", "--project", "alpha", "--mode", "restore", "--json"],
        tmp_data_home,
    )
    body = json.loads(r.stdout)
    assert body["mode"] == "restore"
    assert body["apply"] is False
    assert isinstance(body["entries"], list)
    if body["entries"]:
        e = body["entries"][0]
        assert e["scope_kind"] == "project"
        assert e["scope_label"] == "alpha"
        assert e["harness_id"] == "claude-code"
        assert e["action"] == "restore"
        assert e["applied"] is False
        assert "target_file" in e
        assert "sidecar_path" in e
    # No mutation on dry-run
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert (
        reg["projects"]["alpha"]["permissions"]["allow"][0]["pattern"] == "Bash(npm:*)"
    )


def test_disable_json_apply_detach(tmp_data_home):
    _install_claude_only(tmp_data_home)
    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {},
            "projects": {
                "alpha": {
                    "path": str(tmp_data_home / "alpha"),
                    "permissions": {
                        "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
                    },
                },
            },
            "skills": {},
        },
    )
    (tmp_data_home / "alpha").mkdir(exist_ok=True)
    r = _run(
        [
            "permissions",
            "disable",
            "--project",
            "alpha",
            "--mode",
            "detach",
            "--apply",
            "--json",
        ],
        tmp_data_home,
    )
    body = json.loads(r.stdout)
    assert body["mode"] == "detach"
    assert body["apply"] is True
    for e in body["entries"]:
        assert e["action"] == "detach"
        assert e["applied"] is True

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    perms = reg["projects"]["alpha"]["permissions"]
    assert "allow" not in perms or not perms["allow"]
    assert "claude-code" in (perms.get("_unmanaged") or [])


# ─────────────────────────────────────────────────────────────────────────────
# Section 1.5 — `permissions adopt --json`
# ─────────────────────────────────────────────────────────────────────────────


def test_adopt_skip_json(tmp_data_home):
    _install_claude_only(tmp_data_home)
    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {},
            "projects": {},
            "skills": {},
        },
    )
    r = _run(
        [
            "permissions",
            "adopt",
            "--global",
            "--action",
            "skip",
            "--harness",
            "claude-code",
            "--json",
        ],
        tmp_data_home,
    )
    body = json.loads(r.stdout)
    assert body == {
        "scope_kind": "global",
        "harness_id": "claude-code",
        "action": "skip",
        "imported": 0,
        "backup_path": None,
        "unmanaged_after": ["claude-code"],
    }

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert "claude-code" in reg["permissions_global"]["_unmanaged"]


def test_adopt_import_json_nothing_to_adopt(tmp_data_home):
    """No native files → nothing to adopt; payload should still be JSON-shaped."""
    _install_claude_only(tmp_data_home)
    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {},
            "projects": {},
            "skills": {},
        },
    )
    r = _run(
        [
            "permissions",
            "adopt",
            "--global",
            "--action",
            "import",
            "--harness",
            "claude-code",
            "--json",
        ],
        tmp_data_home,
    )
    body = json.loads(r.stdout)
    assert body["action"] == "import"
    assert body["imported"] == 0


# ─────────────────────────────────────────────────────────────────────────────
# Section 1.6 — `permissions show --global --json` adoption_required
# ─────────────────────────────────────────────────────────────────────────────


def test_show_global_adoption_required_present(tmp_data_home):
    """When ~/.claude/settings.json has rules and permissions_global doesn't
    manage claude-code, show --global --json must include adoption_required."""
    _install_claude_only(tmp_data_home)
    # Seed a native config with rules.
    settings = tmp_data_home / ".claude" / "settings.json"
    settings.write_text(
        json.dumps(
            {
                "permissions": {
                    "allow": ["Bash(npm:*)"],
                    "deny": ["Bash(rm)"],
                }
            }
        )
    )
    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {},
            "projects": {},
            "skills": {},
        },
    )
    r = _run(["permissions", "show", "--global", "--json"], tmp_data_home)
    body = json.loads(r.stdout)
    assert body.get("adoption_required") is not None
    assert "claude-code" in body["adoption_required"]
    patterns = {e["pattern"] for e in body["adoption_required"]["claude-code"]}
    assert "Bash(npm:*)" in patterns
    assert "Bash(rm)" in patterns


def test_show_global_adoption_required_absent_when_managed(tmp_data_home):
    """If permissions_global already manages claude-code, no adoption_required."""
    _install_claude_only(tmp_data_home)
    settings = tmp_data_home / ".claude" / "settings.json"
    settings.write_text(json.dumps({"permissions": {"allow": ["Bash(npm:*)"]}}))
    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {
                "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
            },
            "projects": {},
            "skills": {},
        },
    )
    r = _run(["permissions", "show", "--global", "--json"], tmp_data_home)
    body = json.loads(r.stdout)
    assert body.get("adoption_required") in (None, {})


def test_show_global_adoption_required_absent_when_no_native(tmp_data_home):
    """No native config → no discoveries → field is null/absent."""
    _install_claude_only(tmp_data_home)
    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {},
            "projects": {},
            "skills": {},
        },
    )
    r = _run(["permissions", "show", "--global", "--json"], tmp_data_home)
    body = json.loads(r.stdout)
    assert body.get("adoption_required") in (None, {})


def test_show_project_no_adoption_required(tmp_data_home):
    """Per-project show --json must NEVER populate adoption_required."""
    _install_claude_only(tmp_data_home)
    # Even with a project-level native config containing rules, the per-project
    # payload should not surface adoption_required (auto-import handles that on
    # sync, then the UI surfaces an inline banner).
    proj_dir = tmp_data_home / "alpha"
    (proj_dir / ".claude").mkdir(parents=True, exist_ok=True)
    (proj_dir / ".claude" / "settings.json").write_text(
        json.dumps({"permissions": {"allow": ["Bash(yarn:*)"]}})
    )
    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {},
            "projects": {"alpha": {"path": str(proj_dir), "permissions": {}}},
            "skills": {},
        },
    )
    r = _run(["permissions", "show", "--project", "alpha", "--json"], tmp_data_home)
    body = json.loads(r.stdout)
    assert "adoption_required" not in body


# ─────────────────────────────────────────────────────────────────────────────
# Save & apply — `permissions set` auto-syncs like every other mutation
# ─────────────────────────────────────────────────────────────────────────────


def test_set_changed_auto_syncs_native_files(tmp_data_home):
    _install_claude_only(tmp_data_home)
    _seed(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code"],
            "permissions_global": {},
            "projects": {},
            "skills": {},
            "remotes": {},
        },
    )
    payload = {"allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]}
    r = _run(
        ["permissions", "set", "--global", "--stdin-json"],
        tmp_data_home,
        stdin=json.dumps(payload),
    )
    # stdout carries ONLY the JSON payload — sync chatter is on stderr, so a
    # strict parser (the Tauri bridge) must succeed on the whole body.
    body = json.loads(r.stdout)
    assert body["changed"] is True
    assert body["sync_rc"] == 0
    # The auto-sync pushed the rule into the harness's user-level file …
    settings = json.loads(
        (tmp_data_home / ".claude" / "settings.json").read_text()
    )
    assert "Bash(npm:*)" in settings["permissions"]["allow"]
    # … and recorded a sync report.
    assert (tmp_data_home / "state" / "sync-report.json").exists()


def test_set_noop_skips_auto_sync(tmp_data_home):
    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {
                "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
            },
            "projects": {},
            "skills": {},
            "remotes": {},
        },
    )
    payload = {"allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]}
    r = _run(
        ["permissions", "set", "--global", "--stdin-json"],
        tmp_data_home,
        stdin=json.dumps(payload),
    )
    body = json.loads(r.stdout)
    assert body["changed"] is False
    assert body["sync_rc"] is None
    assert not (tmp_data_home / "state" / "sync-report.json").exists()


def test_set_sync_exit_never_fails_the_save(tmp_data_home, capsys, monkeypatch):
    """cmd_sync exits 2 on doctor danger findings even though every write
    succeeded — the save must exit 0 and carry the rc in the payload."""
    import argparse

    import hub

    _seed(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {},
            "projects": {},
            "skills": {},
            "remotes": {},
        },
    )
    payload_file = tmp_data_home / "payload.json"
    payload_file.write_text(
        json.dumps({"deny": [{"pattern": "Bash(rm -rf:*)", "kind": "deny"}]})
    )

    def _danger_exit():
        raise SystemExit(2)

    monkeypatch.setattr(hub, "_auto_sync", _danger_exit)
    hub.cmd_permissions_set(
        argparse.Namespace(
            global_=True,
            project=None,
            personal=False,
            stdin_json=False,
            json_file=str(payload_file),
        )
    )
    body = json.loads(capsys.readouterr().out)
    assert body["changed"] is True
    assert body["sync_rc"] == 2
