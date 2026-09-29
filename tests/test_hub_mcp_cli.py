"""`hub mcp add|set|show|list|remove` — the CLI slice (plans/B.md §5, cases 33-52).

Most cases run IN-PROCESS (`skill_hub.entrypoints.cli.mcp.cmd_mcp_*` with an `argparse.Namespace`)
so `monkeypatch.setattr(hub, "_auto_sync", ...)` and `capsys` both work — the
same pattern `tests/test_archive_undo.py` uses for its auto-sync-count
assertion. A couple of round-trip cases go through the real subprocess CLI
(`tests/test_archive_undo.py`'s `_run`/`_payload` style) to prove the actual
argparse wiring (`hub mcp` vs `hub mcp-control`, `--json-stdin` on real
stdin). Every in-process test disables `hub._auto_sync` (case 41's own
requirement) so no test ever runs a real sync pass.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from argparse import Namespace
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
PROBE_FIXTURES = REPO_ROOT / "tests" / "fixtures" / "mcp_probe"


# ─────────────────────────────────────────────────────────────────────────────
# helpers
# ─────────────────────────────────────────────────────────────────────────────


def _seed(tmp_path: Path, registry: dict) -> None:
    (tmp_path / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _empty_registry(**extra) -> dict:
    base = {
        "version": "1",
        "harnesses_global": [],
        "skills": {},
        "bundles": {},
        "projects": {},
    }
    base.update(extra)
    return base


def _ns(**kwargs) -> Namespace:
    """A minimal `hub mcp add|set` Namespace — every flag `_spec_from_flags`
    and the `cmd_mcp_*` bodies read via `getattr(args, x, default)` may be
    omitted; only `name` is a direct-attribute read for set/show/remove."""
    defaults = dict(
        json=False,
        transport=None,
        url=None,
        header=None,
        mcp_command=None,
        args=None,
        env=None,
        cwd=None,
        timeout_ms=None,
        json_stdin=False,
        scope=None,
        project=None,
        harnesses=None,
        description=None,
        allow_literal=False,
        probe=False,
        clear_headers=False,
        clear_env=False,
    )
    defaults.update(kwargs)
    return Namespace(**defaults)


def _load(tmp_path: Path) -> dict:
    return yaml.safe_load((tmp_path / "registry.yaml").read_text())


def _run(data_home: Path, home: Path, args: list[str], stdin: str | None = None):
    env = os.environ.copy()
    env["SKILL_HUB_HOME"] = str(data_home)
    env["HOME"] = str(home)
    env.pop("SKILL_HUB_DIR", None)
    env.pop("SKILL_HUB_CODE", None)
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / "hub.py"), *args],
        env=env,
        input=stdin,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def _payload(result: subprocess.CompletedProcess) -> dict:
    text = result.stdout
    start = text.find("{")
    if start < 0:
        raise AssertionError(f"no JSON payload in stdout:\n{text}\n{result.stderr}")
    obj, _end = json.JSONDecoder().raw_decode(text[start:])
    return obj


@pytest.fixture(autouse=True)
def no_auto_sync(monkeypatch):
    """No in-process test may run a real sync pass (case 41's own rule,
    applied everywhere for safety + speed)."""
    import hub

    calls = {"n": 0}
    monkeypatch.setattr(hub, "_auto_sync", lambda: calls.__setitem__("n", calls["n"] + 1))
    return calls


@pytest.fixture(autouse=True)
def _restore_json_mode():
    """N6 safety net: `skill_hub.entrypoints.cli.mcp._json_mode` is a module-level flag, not a
    per-call parameter — `cmd_mcp_add`/`cmd_mcp_reconcile` now reset it to
    `False` on every exit path themselves (via `finally`), but a test in
    this file that calls a helper BELOW those two entry points directly
    (`_parse_add_stdin`, `_reconcile_apply_mcp`, …) can still leave it set.
    Snapshot + restore around every test so leakage can never make a LATER
    test's non-JSON assertion silently read a JSON payload, or vice versa."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    before = mcp_cli._json_mode
    yield
    mcp_cli._json_mode = before


# ─────────────────────────────────────────────────────────────────────────────
# case 33-34: add by flags
# ─────────────────────────────────────────────────────────────────────────────


def test_add_http_by_flags_creates_folder_and_entry(tmp_data_home, capsys):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(
            name="ctx7",
            json=True,
            transport="http",
            url="https://h.example/mcp",
            header=["Accept: application/json"],
        )
    )
    out = capsys.readouterr().out
    payload = json.loads(out[out.find("{") :])

    assert payload["ok"] is True
    assert payload["name"] == "ctx7"
    assert payload["registered"] is True
    assert payload["equipped"] is None
    assert payload["probe"] is None
    assert payload["spec"]["transport"] == "http"
    assert payload["spec"]["url"] == "https://h.example/mcp"
    assert payload["spec"]["headers"] == {"Accept": "application/json"}

    skill_md = (tmp_data_home / "mcp-servers" / "ctx7" / "SKILL.md").read_text()
    assert "name: ctx7" in skill_md
    assert "type: mcp-server" in skill_md

    registry = _load(tmp_data_home)
    assert registry["skills"]["ctx7"]["mcp"] == payload["spec"]
    assert registry["skills"]["ctx7"]["type"] == "mcp-server"
    assert registry["skills"]["ctx7"]["scope"] == "global"


def test_codex_only_context_keeps_flag_add_but_rejects_native_stdin(
    tmp_data_home, capsys, monkeypatch
):
    import io

    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub import hub_core
    from skill_hub.application.harnesses import harness_operation_context as contexts

    _seed(tmp_data_home, _empty_registry())
    context = contexts.build_operation_context(
        tmp_data_home,
        ("codex",),
        requested_features=("mcp",),
        installed_harness_ids=("codex",),
    )
    mcp_cli.cmd_mcp_add(
        _ns(
            name="flag-server",
            json=True,
            transport="stdio",
            mcp_command="python3",
            _operation_context=context,
        )
    )
    capsys.readouterr()
    before_registry = (tmp_data_home / "registry.yaml").read_bytes()
    before_audit = hub_core.audit_log_path().read_bytes()
    monkeypatch.setattr(
        "sys.stdin", io.StringIO('{"command": "python3"}')
    )
    with pytest.raises(SystemExit) as excinfo:
        mcp_cli.cmd_mcp_add(
            _ns(
                name="stdin-server",
                json=True,
                json_stdin=True,
                _operation_context=context,
            )
        )
    assert excinfo.value.code == 2
    assert (tmp_data_home / "registry.yaml").read_bytes() == before_registry
    assert hub_core.audit_log_path().read_bytes() == before_audit
    assert not (tmp_data_home / "mcp-servers" / "stdin-server").exists()
    assert hub_core._LOCK_DEPTH == 0


def test_offline_claude_source_route_decodes_without_delivery_participant(
    tmp_data_home, monkeypatch
):
    import io
    from argparse import Namespace

    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.infrastructure.harnesses import harnesses

    monkeypatch.setattr(harnesses, "detect_installed", lambda: set())
    args = Namespace()
    context = mcp_cli._mcp_operation_context(args)
    assert context.route("claude-code", "mcp").status == "shadow"
    assert context.installed_harness_ids == ()
    monkeypatch.setattr("sys.stdin", io.StringIO('{"command": "python3"}'))
    name, spec, _warnings = mcp_cli._parse_add_stdin(
        "offline-server", operation_context=context
    )
    assert name == "offline-server"
    assert spec.command == "python3"


def test_json_stdin_captures_one_context_for_decode(
    tmp_data_home, capsys, monkeypatch
):
    import io
    from argparse import Namespace

    import hub
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.application.harnesses import harness_operation_context as contexts
    from skill_hub.infrastructure.harnesses import harnesses

    _seed(tmp_data_home, _empty_registry())
    context = contexts.build_operation_context(
        tmp_data_home,
        ("claude-code",),
        requested_features=("mcp",),
        installed_harness_ids=(),
    )
    captures = []
    decoder_contexts = []
    original_select_decoder = mcp_cli.mcp_adapters.select_mcp_decoder
    monkeypatch.setattr(harnesses, "detect_installed", lambda: set())
    monkeypatch.setattr(
        contexts,
        "build_operation_context",
        lambda *args, **kwargs: captures.append((args, kwargs)) or context,
    )
    monkeypatch.setattr(
        mcp_cli.mcp_adapters,
        "select_mcp_decoder",
        lambda operation_context, harness_id: decoder_contexts.append(
            (operation_context, harness_id)
        )
        or original_select_decoder(operation_context, harness_id),
    )
    monkeypatch.setattr(hub, "_auto_sync_tail", lambda: True)
    monkeypatch.setattr("sys.stdin", io.StringIO('{"command": "python3"}'))
    args = Namespace(**vars(_ns(name="captured-server", json=True, json_stdin=True)))

    mcp_cli.cmd_mcp_add(args)

    capsys.readouterr()
    assert len(captures) == 1
    assert args._operation_context is context
    assert decoder_contexts == [(context, "claude-code")]
    assert _load(tmp_data_home)["skills"]["captured-server"]["type"] == "mcp-server"


def test_public_cli_offline_json_stdin_registers_without_delivery_participant(
    tmp_path, monkeypatch
):
    data_home = tmp_path / "data"
    data_home.mkdir()
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.delenv("CODEX_HOME", raising=False)
    monkeypatch.delenv("SKILL_HUB_CLAUDE_HOME", raising=False)
    _seed(data_home, _empty_registry())

    result = _run(
        data_home,
        home,
        ["mcp", "add", "offline-server", "--json-stdin", "--json"],
        '{"command": "python3"}',
    )
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert payload["ok"] is True
    assert payload["registered"] is True
    assert payload["equipped"] is None
    assert _load(data_home)["skills"]["offline-server"]["type"] == "mcp-server"
    assert not (home / ".claude.json").exists()
    assert not (home / ".codex" / "config.toml").exists()
    claude_sidecar = (
        data_home / "state" / "claude-code" / "global-mcp.managed.json"
    )
    codex_sidecar = data_home / "state" / "codex" / "global-mcp.managed.json"
    assert not claude_sidecar.exists()
    assert not codex_sidecar.exists()
    assert not (home / ".claude").exists()


def test_add_json_stdin_does_not_hold_mutation_lock_while_input_is_pending(
    tmp_data_home, monkeypatch
):
    import io
    import threading

    import hub
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    read_started = threading.Event()
    release_read = threading.Event()

    class PendingStdin(io.StringIO):
        def read(self, *args, **kwargs):
            read_started.set()
            if not release_read.wait(timeout=5):
                raise TimeoutError("test did not release pending stdin")
            return super().read(*args, **kwargs)

    monkeypatch.setattr("sys.stdin", PendingStdin('{"command": "python3"}'))
    monkeypatch.setattr(hub, "_auto_sync_tail", lambda **_kwargs: True)
    errors = []

    def run_add():
        try:
            mcp_cli.cmd_mcp_add(
                _ns(name="pending-server", json=True, json_stdin=True)
            )
        except BaseException as exc:
            errors.append(exc)

    worker = threading.Thread(target=run_add, daemon=True)
    worker.start()
    waiter = None
    try:
        assert read_started.wait(timeout=2), "add command did not begin reading stdin"
        lock_script = """
import os
import sys
sys.path.insert(0, sys.argv[1])
os.environ["SKILL_HUB_HOME"] = sys.argv[2]
import hub
hub._DATA_HOME_CACHE = None
with hub.data_home_lock():
    print("ACQUIRED", flush=True)
"""
        waiter = subprocess.Popen(
            [
                sys.executable,
                "-c",
                lock_script,
                str(REPO_ROOT),
                str(tmp_data_home),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        stdout, stderr = waiter.communicate(timeout=3)
        assert waiter.returncode == 0, stderr
        assert stdout.strip() == "ACQUIRED"
    finally:
        if waiter is not None and waiter.poll() is None:
            waiter.kill()
            waiter.wait(timeout=2)
        release_read.set()
        worker.join(timeout=5)

    assert not worker.is_alive()
    assert errors == []
    assert _load(tmp_data_home)["skills"]["pending-server"]["type"] == "mcp-server"


# ─────────────────────────────────────────────────────────────────────────────
# `--probe` on `add` (wave C, unit C2) — no longer inert
# ─────────────────────────────────────────────────────────────────────────────


def test_add_probe_flag_is_live(tmp_data_home, capsys, monkeypatch):
    """plans/C.md §7 step 8: `--probe` on `add` now actually probes (after the
    registry write) instead of printing the wave-B "lands later" line. Never
    touches a real login shell — `$SHELL` is stubbed and the per-process
    snapshot cache reset, same discipline as `tests/test_mcp_probe.py`."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.infrastructure.mcp import mcp_probe

    monkeypatch.setenv("SHELL", str(PROBE_FIXTURES / "fake_shell_empty.sh"))
    monkeypatch.setattr(mcp_probe, "_SHELL_ENV_CACHE", None)

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(
            name="demo",
            json=True,
            transport="stdio",
            mcp_command=sys.executable,
            args=[str(PROBE_FIXTURES / "stdio_ok.py")],
            probe=True,
        )
    )
    out = capsys.readouterr().out
    payload = json.loads(out[out.find("{") :])

    assert payload["probe"] is not None
    assert payload["probe"]["state"] == "ok"
    assert payload["probe"]["tool_count"] == 2

    cached = mcp_probe.read_probe_cache().get("demo")
    assert cached == payload["probe"]

    registry = _load(tmp_data_home)
    assert registry["skills"]["demo"]["mcp"] == payload["spec"]


def test_add_stdio_by_flags(tmp_data_home, capsys):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(
            name="demo",
            json=True,
            transport="stdio",
            mcp_command="python3",
            args=["server.py"],
            env=["FOO=bar"],
        )
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["spec"]["command"] == "python3"
    assert payload["spec"]["args"] == ["server.py"]
    assert payload["spec"]["env"] == {"FOO": "bar"}
    assert "transport" not in payload["spec"]  # stdio omits the default


def test_add_multiline_description_does_not_inject_frontmatter_keys(tmp_data_home, capsys):
    """review W6 — a hand-formatted `description: |` block scalar used to
    truncate a multi-line description after its first line and let the
    remainder inject an arbitrary frontmatter key; the frontmatter is now
    rendered via `yaml.safe_dump`, so it round-trips as one description
    string and no foreign key appears."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.domain.skills import skill_meta

    _seed(tmp_data_home, _empty_registry())
    description = "line one\nline two: oops"
    mcp_cli.cmd_mcp_add(
        _ns(
            name="demo",
            json=True,
            transport="stdio",
            mcp_command="python3",
            description=description,
        )
    )
    capsys.readouterr()

    skill_md = tmp_data_home / "mcp-servers" / "demo" / "SKILL.md"
    meta = skill_meta.parse_skill_frontmatter(skill_md)
    assert meta["description"] == description
    assert meta["name"] == "demo"
    assert meta["type"] == "mcp-server"
    assert "line two" not in meta


# ─────────────────────────────────────────────────────────────────────────────
# case 35-38: --json-stdin
# ─────────────────────────────────────────────────────────────────────────────


def test_add_json_stdin_bare_object(tmp_data_home, capsys, monkeypatch):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    monkeypatch.setattr(
        sys, "stdin", __import__("io").StringIO(json.dumps({"command": "npx", "args": ["weather-mcp"]}))
    )
    mcp_cli.cmd_mcp_add(_ns(name="weather", json=True, json_stdin=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["name"] == "weather"
    assert payload["spec"]["command"] == "npx"
    assert payload["spec"]["args"] == ["weather-mcp"]


def test_add_json_stdin_refuses_spec_flag_combination(tmp_data_home, monkeypatch):
    """review S7 — a spec flag alongside --json-stdin must error, not be
    silently discarded."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    monkeypatch.setattr(
        sys, "stdin", __import__("io").StringIO(json.dumps({"command": "npx"}))
    )
    with pytest.raises(SystemExit):
        mcp_cli.cmd_mcp_add(
            _ns(name="weather", json=True, json_stdin=True, transport="http")
        )


def test_set_json_stdin_refuses_clear_flag_combination(tmp_data_home, capsys, monkeypatch):
    """review S7 — --clear-headers alongside --json-stdin on `set` too."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(_ns(name="demo", json=True, transport="stdio", mcp_command="python3"))
    capsys.readouterr()

    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(json.dumps({"env": {"A": "1"}})))
    with pytest.raises(SystemExit):
        mcp_cli.cmd_mcp_set(_ns(name="demo", json=True, json_stdin=True, clear_headers=True))


def test_add_json_stdin_mcpservers_wrapper_single_key(tmp_data_home, capsys, monkeypatch):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    raw = json.dumps({"mcpServers": {"weather": {"command": "npx", "args": ["weather-mcp"]}}})
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(raw))
    mcp_cli.cmd_mcp_add(_ns(name=None, json=True, json_stdin=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["name"] == "weather"


def test_add_json_stdin_wrapper_name_mismatch_errors(tmp_data_home, monkeypatch):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    raw = json.dumps({"mcpServers": {"weather": {"command": "npx"}}})
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(raw))
    with pytest.raises(SystemExit) as exc:
        mcp_cli.cmd_mcp_add(_ns(name="not-weather", json=True, json_stdin=True))
    assert exc.value.code == 2


def test_add_json_stdin_ws_refused(tmp_data_home, monkeypatch):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    raw = json.dumps({"type": "ws", "url": "wss://x"})
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(raw))
    with pytest.raises(SystemExit) as exc:
        mcp_cli.cmd_mcp_add(_ns(name="wstest", json=True, json_stdin=True))
    assert exc.value.code == 2


def test_add_json_stdin_oauth_block_refused(tmp_data_home, capsys, monkeypatch):
    """review W7 — the CLI stdin path names the reason and exits 2."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    raw = json.dumps({"command": "npx", "args": ["x"], "oauth": {"client_id": "abc"}})
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(raw))
    with pytest.raises(SystemExit) as exc:
        mcp_cli.cmd_mcp_add(_ns(name="oauthy", json=True, json_stdin=True))
    assert exc.value.code == 2
    assert "oauth_block" in capsys.readouterr().out


# ─────────────────────────────────────────────────────────────────────────────
# case 39-40: the literal-secret gate
# ─────────────────────────────────────────────────────────────────────────────


def test_add_refuses_literal_secret(tmp_data_home, capsys):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    fake_token = "Bearer " + "faketesttoken12"  # not a real credential
    with pytest.raises(SystemExit) as exc:
        mcp_cli.cmd_mcp_add(
            _ns(
                name="ctx7",
                json=True,
                transport="http",
                url="https://h.example/mcp",
                header=[f"Authorization: {fake_token}"],
            )
        )
    assert exc.value.code == 2
    message = capsys.readouterr().out
    assert "Authorization" in message
    assert "${" in message  # the suggested ref form
    assert "excluded from backups" in message
    assert fake_token.split(" ", 1)[1] not in message  # never the raw value

    # --allow-literal succeeds and records the flag.
    mcp_cli.cmd_mcp_add(
        _ns(
            name="ctx7",
            json=True,
            transport="http",
            url="https://h.example/mcp",
            header=[f"Authorization: {fake_token}"],
            allow_literal=True,
        )
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["spec"]["allow_literal_secrets"] is True


def test_set_no_allow_literal_clears_the_flag(tmp_data_home, capsys):
    """review S8 — once the literal is actually replaced with a `${VAR}` ref,
    `--no-allow-literal` clears the flag rather than carrying it forever."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    fake_token = "Bearer " + "faketesttoken12"  # not a real credential
    mcp_cli.cmd_mcp_add(
        _ns(
            name="ctx7",
            json=True,
            transport="http",
            url="https://h.example/mcp",
            header=[f"Authorization: {fake_token}"],
            allow_literal=True,
        )
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["spec"]["allow_literal_secrets"] is True

    mcp_cli.cmd_mcp_set(
        _ns(
            name="ctx7",
            json=True,
            header=["Authorization: Bearer ${CTX7_TOKEN}"],
            no_allow_literal=True,
        )
    )
    payload = json.loads(capsys.readouterr().out)
    assert "allow_literal_secrets" not in payload["spec"]


def test_add_refuses_literal_secret_in_the_url_query(tmp_data_home):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    fake_key = "sk-" + "faketesttoken1234567"  # not a real credential
    with pytest.raises(SystemExit) as exc:
        mcp_cli.cmd_mcp_add(
            _ns(
                name="ctx7",
                json=True,
                transport="http",
                url=f"https://h.example/mcp?key={fake_key}",
            )
        )
    assert exc.value.code == 2


# ─────────────────────────────────────────────────────────────────────────────
# case 41-42: project equip + duplicate name
# ─────────────────────────────────────────────────────────────────────────────


def test_add_with_project_equips_and_syncs(tmp_data_home, capsys, no_auto_sync):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(
        tmp_data_home,
        _empty_registry(
            projects={"alpha": {"path": str(tmp_data_home / "alpha"), "enabled": [], "bundles": []}}
        ),
    )
    mcp_cli.cmd_mcp_add(
        _ns(name="demo", json=True, transport="stdio", mcp_command="python3", project="alpha")
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["equipped"] == {"project": "alpha"}

    registry = _load(tmp_data_home)
    assert "demo" in registry["projects"]["alpha"]["enabled"]
    assert no_auto_sync["n"] == 1


def test_add_unknown_project_leaves_no_orphan_folder_and_retry_succeeds(tmp_data_home, capsys):
    """review C1 — a `--project` typo must not create `mcp-servers/<name>/`
    and then dead-end every retry with 'already has a folder'."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())

    with pytest.raises(SystemExit) as exc:
        mcp_cli.cmd_mcp_add(
            _ns(name="demo", json=True, transport="stdio", mcp_command="python3", project="nope")
        )
    assert exc.value.code == 1
    assert not (tmp_data_home / "mcp-servers" / "demo").exists()
    assert "demo" not in _load(tmp_data_home).get("skills", {})
    capsys.readouterr()

    # The immediate correct retry (drop --project, or pass a real one) succeeds.
    mcp_cli.cmd_mcp_add(_ns(name="demo", json=True, transport="stdio", mcp_command="python3"))
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert (tmp_data_home / "mcp-servers" / "demo").exists()


def test_add_duplicate_name_errors_without_clobbering(tmp_data_home, capsys):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(_ns(name="demo", json=True, transport="stdio", mcp_command="python3"))
    capsys.readouterr()
    before = _load(tmp_data_home)

    with pytest.raises(SystemExit):
        mcp_cli.cmd_mcp_add(
            _ns(name="demo", json=True, transport="stdio", mcp_command="python3", args=["other.py"])
        )
    after = _load(tmp_data_home)
    assert after == before


def test_add_and_set_harnesses_warn_on_unknown_id(tmp_data_home, capsys):
    """review W3 — `--harnesses` now routes through
    `hub._validate_harness_affinity`, which WARNS on stderr for an unknown id
    but still accepts it (that helper's own documented contract: unknown ids
    are forward-compat, never rejected — see Deviations for the discrepancy
    with the review's "exits non-zero" phrasing)."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(
            name="ctx7",
            json=True,
            transport="stdio",
            mcp_command="python3",
            harnesses="claud-code",
        )
    )
    err = capsys.readouterr().err
    assert "unknown harness id 'claud-code'" in err
    assert _load(tmp_data_home)["skills"]["ctx7"]["harnesses"] == ["claud-code"]

    mcp_cli.cmd_mcp_set(_ns(name="ctx7", json=True, harnesses="codex,claud-code"))
    err = capsys.readouterr().err
    assert "unknown harness id 'claud-code'" in err
    assert _load(tmp_data_home)["skills"]["ctx7"]["harnesses"] == ["codex", "claud-code"]


# ─────────────────────────────────────────────────────────────────────────────
# case 43-46: hub mcp set
# ─────────────────────────────────────────────────────────────────────────────


def test_set_partial_update_preserves_untouched_keys_and_clear_headers(tmp_data_home, capsys):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(
            name="ctx7",
            json=True,
            transport="http",
            url="https://h.example/mcp",
            header=["Accept: application/json"],
        )
    )
    capsys.readouterr()

    mcp_cli.cmd_mcp_set(_ns(name="ctx7", json=True, header=["X-Trace: on"]))
    payload = json.loads(capsys.readouterr().out)
    assert payload["spec"]["url"] == "https://h.example/mcp"
    assert payload["spec"]["headers"] == {"Accept": "application/json", "X-Trace": "on"}

    mcp_cli.cmd_mcp_set(_ns(name="ctx7", json=True, clear_headers=True))
    payload = json.loads(capsys.readouterr().out)
    assert "headers" not in payload["spec"]
    assert payload["spec"]["url"] == "https://h.example/mcp"


def test_set_json_stdin_deep_merges(tmp_data_home, capsys, monkeypatch):
    """Case 44. S1: the server is seeded WITH a header so a deep-merge and a
    naive shallow/full-replace produce different results — a header the
    partial payload didn't mention must still survive alongside the new one."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(
            name="ctx7",
            json=True,
            transport="http",
            url="https://h.example/mcp",
            header=["Accept: application/json"],
        )
    )
    capsys.readouterr()

    monkeypatch.setattr(
        sys, "stdin", __import__("io").StringIO(json.dumps({"headers": {"X-Trace": "on"}}))
    )
    mcp_cli.cmd_mcp_set(_ns(name="ctx7", json=True, json_stdin=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["spec"]["url"] == "https://h.example/mcp"
    assert payload["spec"]["transport"] == "http"
    assert payload["spec"]["headers"] == {"Accept": "application/json", "X-Trace": "on"}


# ─────────────────────────────────────────────────────────────────────────────
# D3 — `hub mcp set --json-stdin`: null deletes, a list replaces
# ─────────────────────────────────────────────────────────────────────────────


def test_set_json_stdin_null_deletes_a_header(tmp_data_home, capsys, monkeypatch):
    """(a) a header deleted via `null` is absent from the registry, the
    rendered SKILL.md, and the returned payload — never merely set to
    `None`."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(
            name="ctx7",
            json=True,
            transport="http",
            url="https://h.example/mcp",
            header=["Accept: application/json", "X-Trace: on"],
        )
    )
    capsys.readouterr()

    monkeypatch.setattr(
        sys, "stdin", __import__("io").StringIO(json.dumps({"headers": {"X-Trace": None}}))
    )
    mcp_cli.cmd_mcp_set(_ns(name="ctx7", json=True, json_stdin=True))
    payload = json.loads(capsys.readouterr().out)

    assert payload["spec"]["headers"] == {"Accept": "application/json"}
    assert "X-Trace" not in payload["spec"]["headers"]
    # `prior_spec` is deliberately the WHOLE previous block (m14, for undo) —
    # it still names the header that was just deleted; only the NEW `spec`
    # must not.
    assert "X-Trace" not in json.dumps(payload["spec"])

    registry = _load(tmp_data_home)
    reg_headers = registry["skills"]["ctx7"]["mcp"]["headers"]
    assert reg_headers == {"Accept": "application/json"}

    from skill_hub.domain.skills.skill_meta import hub_mcp_servers_dir

    body = (hub_mcp_servers_dir() / "ctx7" / "SKILL.md").read_text()
    assert "X-Trace" not in body


def test_set_json_stdin_null_deletes_an_env_key(tmp_data_home, capsys, monkeypatch):
    """(b) an env key deleted via `null`."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(
            name="demo",
            json=True,
            transport="stdio",
            mcp_command="node",
            env=["FOO=bar", "KEEP=1"],
        )
    )
    capsys.readouterr()

    monkeypatch.setattr(
        sys, "stdin", __import__("io").StringIO(json.dumps({"env": {"FOO": None}}))
    )
    mcp_cli.cmd_mcp_set(_ns(name="demo", json=True, json_stdin=True))
    payload = json.loads(capsys.readouterr().out)

    assert payload["spec"]["env"] == {"KEEP": "1"}
    assert "FOO" not in payload["spec"]["env"]

    registry = _load(tmp_data_home)
    assert registry["skills"]["demo"]["mcp"]["env"] == {"KEEP": "1"}


def test_set_json_stdin_args_list_replaces_wholesale(tmp_data_home, capsys, monkeypatch):
    """(c) a passed `args` list REPLACES the stored list, never merges
    element-by-element — including replacement by an empty list."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(name="demo", json=True, transport="stdio", mcp_command="node", args=["a.js", "--flag"])
    )
    capsys.readouterr()

    monkeypatch.setattr(
        sys, "stdin", __import__("io").StringIO(json.dumps({"args": ["b.js"]}))
    )
    mcp_cli.cmd_mcp_set(_ns(name="demo", json=True, json_stdin=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["spec"]["args"] == ["b.js"]

    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(json.dumps({"args": []})))
    mcp_cli.cmd_mcp_set(_ns(name="demo", json=True, json_stdin=True))
    payload2 = json.loads(capsys.readouterr().out)
    assert "args" not in payload2["spec"]  # an empty list is omitted from the written block

    registry = _load(tmp_data_home)
    assert "args" not in registry["skills"]["demo"]["mcp"]


def test_set_json_stdin_null_on_top_level_key_deletes_when_still_valid(
    tmp_data_home, capsys, monkeypatch
):
    """(d), success half: `"cwd": null` deletes a top-level scalar key whose
    absence still leaves a valid spec."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(name="demo", json=True, transport="stdio", mcp_command="node", cwd="/tmp/x")
    )
    capsys.readouterr()

    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(json.dumps({"cwd": None})))
    mcp_cli.cmd_mcp_set(_ns(name="demo", json=True, json_stdin=True))
    payload = json.loads(capsys.readouterr().out)
    assert "cwd" not in payload["spec"]

    registry = _load(tmp_data_home)
    assert "cwd" not in registry["skills"]["demo"]["mcp"]


def test_set_json_stdin_null_on_top_level_key_fails_closed_when_invalid(
    tmp_data_home, capsys, monkeypatch
):
    """(d), refusal half: `"url": null` on an http server leaves the spec
    invalid (transport 'http' requires 'url') — D3's pick is FAIL CLOSED,
    exit 2, naming the deleted key, rather than silently downgrading the
    server or leaving it broken."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(name="ctx7", json=True, transport="http", url="https://h.example/mcp")
    )
    capsys.readouterr()
    before = _load(tmp_data_home)

    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(json.dumps({"url": None})))
    with pytest.raises(SystemExit) as excinfo:
        mcp_cli.cmd_mcp_set(_ns(name="ctx7", json=True, json_stdin=True))
    assert excinfo.value.code == 2
    out = capsys.readouterr().out
    assert "url" in out

    after = _load(tmp_data_home)
    assert after == before  # nothing was written


def test_set_json_returns_the_whole_prior_spec(tmp_data_home, capsys):
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub import hub_core

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(
            name="ctx7",
            json=True,
            transport="http",
            url="https://h.example/mcp",
            header=["Accept: application/json"],
        )
    )
    capsys.readouterr()

    mcp_cli.cmd_mcp_set(_ns(name="ctx7", json=True, url="https://h2.example/mcp"))
    payload = json.loads(capsys.readouterr().out)
    prior = payload["prior_spec"]
    assert prior["transport"] == "http"
    assert prior["url"] == "https://h.example/mcp"
    assert prior["headers"] == {"Accept": "application/json"}

    audit_lines = (hub_core.audit_log_path()).read_text().strip().splitlines()
    last = json.loads(audit_lines[-1])
    assert last["verb"] == "mcp-set"
    assert last["changed"] is True


def test_set_transport_change_validates(tmp_data_home):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(_ns(name="demo", json=True, transport="stdio", mcp_command="python3"))

    with pytest.raises(SystemExit) as exc:
        mcp_cli.cmd_mcp_set(_ns(name="demo", json=True, transport="http"))
    assert exc.value.code == 1


def test_set_transport_change_drops_incompatible_fields_both_directions(tmp_data_home, capsys):
    """review W4 — a `set --transport` that differs from the base spec must
    drop the fields the new shape cannot carry, in BOTH directions."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    # http -> stdio: url/headers must not survive.
    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(
            name="ctx7",
            json=True,
            transport="http",
            url="https://h.example/mcp",
            header=["Accept: application/json"],
        )
    )
    capsys.readouterr()
    mcp_cli.cmd_mcp_set(_ns(name="ctx7", json=True, transport="stdio", mcp_command="python3"))
    payload = json.loads(capsys.readouterr().out)
    assert payload["spec"]["command"] == "python3"
    assert "url" not in payload["spec"]
    assert "headers" not in payload["spec"]

    # stdio -> http: command/args/env must not survive.
    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(
            name="demo",
            json=True,
            transport="stdio",
            mcp_command="python3",
            args=["server.py"],
            env=["A=1"],
        )
    )
    capsys.readouterr()
    mcp_cli.cmd_mcp_set(_ns(name="demo", json=True, transport="http", url="https://h2.example/mcp"))
    payload = json.loads(capsys.readouterr().out)
    assert payload["spec"]["url"] == "https://h2.example/mcp"
    assert "command" not in payload["spec"]
    assert "args" not in payload["spec"]
    assert "env" not in payload["spec"]


# ─────────────────────────────────────────────────────────────────────────────
# case 47-48: show / list
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def installed_harnesses(monkeypatch, tmp_path):
    """claude-code + codex get tmp global-MCP config paths (non-None); pi and
    opencode keep the `_isolate_global_mcp` autouse default of `None` — the
    exact shape case 47 checks (`no_global_target` for pi)."""
    import dataclasses

    from skill_hub.infrastructure.harnesses import harnesses

    patched = {}
    for h_id, h in harnesses.HARNESSES.items():
        kwargs = {"detect": (lambda: True)}
        if h_id == "claude-code":
            kwargs["global_mcp_config"] = tmp_path / "claude.json"
        elif h_id == "codex":
            kwargs["global_mcp_config"] = tmp_path / "codex-config.toml"
        patched[h_id] = dataclasses.replace(h, **kwargs)
    monkeypatch.setattr(harnesses, "HARNESSES", patched)
    return patched


def test_show_json_resolved_rows(tmp_data_home, capsys, installed_harnesses):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(_ns(name="demo", json=True, transport="stdio", mcp_command="python3"))
    capsys.readouterr()

    mcp_cli.cmd_mcp_show(_ns(name="demo", json=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["last_probe"] is None
    rows = {row["harness"]: row for row in payload["resolved"]}
    assert rows["pi"]["supported"] is False
    assert rows["pi"]["reason"] == "no_global_target"
    assert rows["pi"]["target_file"] == ""  # S5: "" not null, INTERFACES §3 types it str
    assert rows["pi"]["adapter"] == "claude"
    assert rows["claude-code"]["supported"] is True
    assert rows["claude-code"]["target_file"] is not None
    assert rows["claude-code"]["native"] is not None


def test_show_json_last_probe_reflects_the_cache(tmp_data_home, capsys, installed_harnesses):
    """`show`'s `last_probe` (wave C) reads whatever `hub mcp check` last
    wrote to the probe cache — `None` until a check has run."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.infrastructure.mcp import mcp_probe

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(_ns(name="demo", json=True, transport="stdio", mcp_command="python3"))
    capsys.readouterr()

    row = {
        "name": "demo",
        "transport": "stdio",
        "state": "ok",
        "tool_count": 1,
        "tools": ["x"],
        "latency_ms": 5,
        "protocol_version": "2024-11-05",
        "unresolved_refs": [],
        "env_from_shell": True,
        "error": None,
        "checked_at": "2026-01-01T00:00:00Z",
    }
    mcp_probe.write_probe_cache("demo", row)

    mcp_cli.cmd_mcp_show(_ns(name="demo", json=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["last_probe"] == row


def test_show_resolved_native_uses_the_expanded_source(tmp_data_home, capsys, installed_harnesses):
    """review W5 — a `{source}`-scaffolded entry's resolved `native` must show
    the ABSOLUTE expanded path (what a harness actually receives), never the
    literal `{source}` placeholder; the raw registry `spec` field is
    unaffected (it is the literal `mcp:` block, not derived from either spec
    object)."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    src_dir = tmp_data_home / "mcp-servers" / "scaffolded"
    src_dir.mkdir(parents=True)
    (src_dir / "server.py").write_text("# stub\n")

    registry = _empty_registry(
        skills={
            "scaffolded": {
                "version": "1.0.0",
                "description": "d",
                "source": str(src_dir),
                "type": "mcp-server",
                "scope": "global",
                "upstream": None,
                "mcp": {"command": "python3", "args": ["{source}/server.py"], "env": {}},
            }
        }
    )
    _seed(tmp_data_home, registry)

    mcp_cli.cmd_mcp_show(_ns(name="scaffolded", json=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["spec"]["args"] == ["{source}/server.py"]

    claude_row = next(r for r in payload["resolved"] if r["harness"] == "claude-code")
    assert claude_row["native"]["args"] == [str(src_dir.resolve() / "server.py")]
    assert "{source}" not in claude_row["native"]["args"][0]


def test_show_counts_a_bundle_equipped_project(tmp_data_home, capsys, installed_harnesses):
    """review S6: a server reachable only VIA an applied bundle (never in
    `enabled` directly) must still show up in `equipped.projects` and get a
    `resolved` row for that project."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(
        tmp_data_home,
        _empty_registry(
            harnesses_global=["claude-code"],
            projects={
                "alpha": {
                    "path": str(tmp_data_home / "alpha"),
                    "enabled": [],
                    "bundles": ["toolkit"],
                }
            },
            bundles={
                "toolkit": {
                    "description": "d",
                    "scope": "project-specific",
                    "skills": ["demo"],
                }
            },
        ),
    )
    mcp_cli.cmd_mcp_add(
        _ns(
            name="demo",
            json=True,
            transport="stdio",
            mcp_command="python3",
            scope="project-specific",
        )
    )
    capsys.readouterr()

    mcp_cli.cmd_mcp_show(_ns(name="demo", json=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["equipped"]["projects"] == ["alpha"]
    assert any(row["scope"] == "project:alpha" for row in payload["resolved"])


def test_list_json_shape(tmp_data_home, capsys):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(_ns(name="demo", json=True, transport="stdio", mcp_command="python3"))
    capsys.readouterr()

    mcp_cli.cmd_mcp_list(_ns(json=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert len(payload["servers"]) == 1
    row = payload["servers"][0]
    assert row["name"] == "demo"
    assert row["transport"] == "stdio"
    assert row["has_literal_secret"] is False


# ─────────────────────────────────────────────────────────────────────────────
# case 49: remove delegates to archive
# ─────────────────────────────────────────────────────────────────────────────


def test_remove_delegates_to_archive(tmp_data_home, capsys):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(_ns(name="demo", json=True, transport="stdio", mcp_command="python3"))
    capsys.readouterr()

    mcp_cli.cmd_mcp_remove(_ns(name="demo", json=True, yes=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["undo"] == ["unarchive", "demo"]

    registry = _load(tmp_data_home)
    assert "demo" not in registry["skills"]
    assert (tmp_data_home / "state" / "archive" / "demo.json").exists()


# ─────────────────────────────────────────────────────────────────────────────
# case 50-51: subprocess-level CLI contract
# ─────────────────────────────────────────────────────────────────────────────


def test_json_payload_is_parseable_despite_autosync_chatter(tmp_path):
    data_home = tmp_path / "data"
    home = tmp_path / "home"
    data_home.mkdir()
    home.mkdir()
    _seed(data_home, _empty_registry())

    result = _run(
        data_home,
        home,
        ["mcp", "add", "demo", "--transport", "stdio", "--command", "python3", "--json"],
    )
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert payload["ok"] is True
    assert payload["name"] == "demo"

    # S2: the property this test names is that auto-sync chatter FOLLOWS the
    # payload — assert there really is trailing text, not just that the
    # leading JSON happens to parse (which would pass even with no chatter).
    text = result.stdout
    start = text.find("{")
    _obj, end = json.JSONDecoder().raw_decode(text[start:])
    assert text[start + end :].strip(), "expected auto-sync chatter after the JSON payload"


def test_hub_mcp_and_hub_mcp_control_both_resolve(tmp_path):
    data_home = tmp_path / "data"
    home = tmp_path / "home"
    data_home.mkdir()
    home.mkdir()
    _seed(data_home, _empty_registry())

    r1 = _run(data_home, home, ["mcp", "--help"])
    r2 = _run(data_home, home, ["mcp-control", "--help"])
    assert r1.returncode == 0, r1.stderr
    assert r2.returncode == 0, r2.stderr


# ─────────────────────────────────────────────────────────────────────────────
# case 52: _register_mcp_skill is the shared path
# ─────────────────────────────────────────────────────────────────────────────


def test_register_mcp_skill_is_shared(tmp_data_home, capsys):
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.domain.mcp import mcp_spec

    _seed(tmp_data_home, _empty_registry())

    spec = mcp_spec.McpServerSpec(name="direct", command="python3", args=["server.py"])
    direct_registry: dict = _empty_registry()
    entry = mcp_cli._register_mcp_skill(
        direct_registry, "direct", spec, description="Direct call", scope="global"
    )
    assert entry["mcp"]["command"] == "python3"
    assert (tmp_data_home / "mcp-servers" / "direct" / "SKILL.md").exists()

    mcp_cli.cmd_mcp_add(
        _ns(name="viacli", json=True, transport="stdio", mcp_command="python3", args=["server.py"])
    )
    capsys.readouterr()
    via_cli = _load(tmp_data_home)["skills"]["viacli"]

    assert entry["mcp"] == via_cli["mcp"]
    assert entry["type"] == via_cli["type"] == "mcp-server"


def test_register_mcp_skill_refuses_a_traversal_name(tmp_data_home):
    """review W2 — `_register_mcp_skill` is wave D's `reconcile --apply import`
    path, where names come from third-party native config files; it must
    refuse a path-traversal name itself, not rely solely on the caller."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.domain.mcp import mcp_spec

    _seed(tmp_data_home, _empty_registry())
    spec = mcp_spec.McpServerSpec(name="../escaped", command="python3")
    registry: dict = _empty_registry()

    with pytest.raises(SystemExit):
        mcp_cli._register_mcp_skill(registry, "../escaped", spec, description="d", scope="global")

    assert not (tmp_data_home / "mcp-servers").exists() or not any(
        (tmp_data_home / "mcp-servers").iterdir()
    )
    assert not (tmp_data_home.parent / "escaped").exists()


# ─────────────────────────────────────────────────────────────────────────────
# E3 rev 2 (`plans/E3.md` §5 case 12) — slugify on the add door, streamable
# -http alias, --arg=--flag.
# ─────────────────────────────────────────────────────────────────────────────


def test_add_json_stdin_wrapper_sanity_registers_lowercase_and_warns(tmp_data_home, capsys, monkeypatch):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    raw = json.dumps({"mcpServers": {"Sanity": {"command": "npx"}}})
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(raw))
    mcp_cli.cmd_mcp_add(_ns(name=None, json=True, json_stdin=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["name"] == "sanity"
    assert "renamed_from:Sanity" in payload["warnings"]
    assert "sanity" in _load(tmp_data_home)["skills"]
    assert "Sanity" not in _load(tmp_data_home)["skills"]


def test_add_flag_path_refuses_non_slug_name_naming_the_slug(tmp_data_home, capsys):
    """D-C / catalogue N01: the flag path (P3) still refuses a typed
    non-slug name — the user typed it — but the message names the slug it
    would become, and under `--json` the refusal is one structured object."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    with pytest.raises(SystemExit) as excinfo:
        mcp_cli.cmd_mcp_add(_ns(name="Sanity", json=True, mcp_command="npx"))
    assert excinfo.value.code == 1
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is False
    assert out["code"] == "invalid_name"
    assert "sanity" in out["error"]
    assert "sanity" not in _load(tmp_data_home)["skills"]


def test_add_transport_streamable_http_flag_is_accepted_as_http_alias(tmp_data_home, capsys):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(name="remote", json=True, transport="streamable-http", url="https://h/mcp")
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["spec"].get("transport") in (None, "http")
    assert "transport" not in payload["spec"] or payload["spec"]["transport"] == "http"
    assert _load(tmp_data_home)["skills"]["remote"]["mcp"].get("transport", "http") == "http"


def test_add_arg_equals_flag_shaped_value_is_stored_verbatim(tmp_data_home, capsys):
    """catalogue C06: `--arg --flag` is an argparse error (looks like
    another option); `--arg=--flag` (documented in the flag help) is not."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(
        _ns(name="withflag", json=True, mcp_command="npx", args=["--flag", "value"])
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["spec"]["args"] == ["--flag", "value"]


# ─────────────────────────────────────────────────────────────────────────────
# W1 — every fail-closed site on the add door goes through `_die`; a planted
# token-looking value never reaches stdout, in ANY refusal branch.
# ─────────────────────────────────────────────────────────────────────────────

_PLANTED = "sk-plantedtoken1234567890abcdef"


def test_add_bad_header_flag_is_structured_and_never_echoes_the_value(tmp_data_home, capsys):
    """W1: `--header "Bearer <token>"` (no ':'/'=' — the exact real-world
    shape a bearer token pasted without a key gets typed as) used to reach
    `hub_core.fail`, which prints bare text under `--json` and interpolates
    the WHOLE raw flag value into it."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    with pytest.raises(SystemExit) as excinfo:
        mcp_cli.cmd_mcp_add(
            _ns(
                name="ctx7", json=True, transport="http", url="https://h/mcp",
                header=[f"Bearer {_PLANTED}"],
            )
        )
    assert excinfo.value.code == 1
    out = capsys.readouterr().out
    assert _PLANTED not in out
    payload = json.loads(out)
    assert payload["ok"] is False
    assert payload["code"] == "other"


def test_add_bad_env_flag_is_structured_and_never_echoes_the_value(tmp_data_home, capsys):
    """W1: `--env` with no '=' (a bare planted value) — same `_die` routing
    as `--header`."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    with pytest.raises(SystemExit) as excinfo:
        mcp_cli.cmd_mcp_add(_ns(name="ctx7", json=True, mcp_command="npx", env=[_PLANTED]))
    assert excinfo.value.code == 1
    out = capsys.readouterr().out
    assert _PLANTED not in out
    payload = json.loads(out)
    assert payload["ok"] is False
    assert payload["code"] == "other"


def test_add_json_stdin_with_spec_flags_is_structured_and_never_echoes_the_value(
    tmp_data_home, capsys, monkeypatch
):
    """W1: `--json-stdin` combined with a spec flag used to reach
    `hub_core.fail` via `_refuse_json_stdin_with_spec_flags`."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(json.dumps({"command": _PLANTED})))
    with pytest.raises(SystemExit) as excinfo:
        mcp_cli.cmd_mcp_add(
            _ns(name="ctx7", json=True, json_stdin=True, mcp_command=_PLANTED)
        )
    assert excinfo.value.code == 1
    out = capsys.readouterr().out
    assert _PLANTED not in out
    payload = json.loads(out)
    assert payload["ok"] is False
    assert payload["code"] == "other"


def test_add_json_stdin_invalid_json_is_structured_and_never_echoes_the_value(
    tmp_data_home, capsys, monkeypatch
):
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub import hub_core

    _seed(tmp_data_home, _empty_registry())
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO("{not json " + _PLANTED))
    with pytest.raises(SystemExit) as excinfo:
        mcp_cli.cmd_mcp_add(_ns(name=None, json=True, json_stdin=True))
    assert excinfo.value.code == 2
    out = capsys.readouterr().out
    assert _PLANTED not in out
    payload = json.loads(out)
    assert payload["ok"] is False
    assert payload["code"] == "invalid_json"
    assert hub_core._LOCK_DEPTH == 0


def test_add_json_stdin_empty_wrapper_is_structured(tmp_data_home, capsys, monkeypatch):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(json.dumps({"mcpServers": {}})))
    with pytest.raises(SystemExit) as excinfo:
        mcp_cli.cmd_mcp_add(_ns(name=None, json=True, json_stdin=True))
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().out)
    assert payload == {"ok": False, "error": payload["error"], "code": "invalid_json", "reason": "empty_wrapper"}


def test_add_json_stdin_nested_wrapper_is_structured(tmp_data_home, capsys, monkeypatch):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    monkeypatch.setattr(
        sys, "stdin", __import__("io").StringIO(json.dumps({"mcpServers": {"mcpServers": {}}}))
    )
    with pytest.raises(SystemExit) as excinfo:
        mcp_cli.cmd_mcp_add(_ns(name=None, json=True, json_stdin=True))
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().out)
    assert payload["code"] == "invalid_json"
    assert payload["reason"] == "nested_wrapper"


def test_add_json_stdin_malformed_field_is_structured_and_never_echoes_the_value(
    tmp_data_home, capsys, monkeypatch
):
    """A malformed native shape (`args` a non-list) never leaks the planted
    value through the `invalid_spec` refusal."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    monkeypatch.setattr(
        sys, "stdin", __import__("io").StringIO(json.dumps({"command": "npx", "args": _PLANTED}))
    )
    with pytest.raises(SystemExit) as excinfo:
        mcp_cli.cmd_mcp_add(_ns(name="ctx7", json=True, json_stdin=True))
    assert excinfo.value.code == 2
    out = capsys.readouterr().out
    assert _PLANTED not in out
    payload = json.loads(out)
    assert payload["code"] == "invalid_spec"
    assert payload["reason"] == "malformed_field:args"


def test_add_json_stdin_literal_secret_is_structured_and_never_echoes_the_value(
    tmp_data_home, capsys, monkeypatch
):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    monkeypatch.setattr(
        sys, "stdin",
        __import__("io").StringIO(json.dumps({"transport": "http", "url": f"https://{_PLANTED}@h/mcp"})),
    )
    with pytest.raises(SystemExit) as excinfo:
        mcp_cli.cmd_mcp_add(_ns(name="ctx7", json=True, json_stdin=True))
    assert excinfo.value.code == 2
    out = capsys.readouterr().out
    assert _PLANTED not in out
    payload = json.loads(out)
    assert payload["ok"] is False
    assert payload["code"] == "literal_secret"


# ─────────────────────────────────────────────────────────────────────────────
# N6 — `_json_mode` is reset on the success path too, not left set for the
# next call in this process.
# ─────────────────────────────────────────────────────────────────────────────


def test_add_resets_json_mode_after_a_successful_json_call(tmp_data_home, capsys):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    mcp_cli.cmd_mcp_add(_ns(name="ctx7", json=True, mcp_command="npx"))
    capsys.readouterr()
    assert mcp_cli._json_mode is False


def test_add_resets_json_mode_even_when_the_command_fails_mid_body(tmp_data_home, capsys):
    """A `--json` call that dies partway through must still leave
    `_json_mode` however the CALLER left it before this invocation — here,
    the module default of `False` — not stuck `True` for whatever runs
    next in this process."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed(tmp_data_home, _empty_registry())
    with pytest.raises(SystemExit):
        mcp_cli.cmd_mcp_add(_ns(name="ctx7", json=True, mcp_command="npx", header=[_PLANTED]))
    capsys.readouterr()
    assert mcp_cli._json_mode is False


def test_reconcile_resets_json_mode_after_a_successful_json_call(tmp_path, tmp_data_home, capsys):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    proj_cfg = {"path": str(proj), "enabled": [], "bundles": [], "harnesses": []}
    _seed(tmp_data_home, _empty_registry(projects={"demo": proj_cfg}))
    mcp_cli.cmd_mcp_reconcile(_ns(project="demo", global_=False, json=True, apply=False))
    capsys.readouterr()
    assert mcp_cli._json_mode is False
