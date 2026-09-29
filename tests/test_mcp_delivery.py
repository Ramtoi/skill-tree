"""Tests for `mcp_delivery.py` — delivery rows for the sync report (plans/C.md
§5, cases 1-13).

`_patch_detect_all` mirrors `tests/test_global_mcp_dispatch.py`'s
`global_mcp_sync_env` recipe (every harness "installed"); each test then
selects which harnesses are EFFECTIVE for a project via the registry's
`harnesses_global`. `_patch_global_targets` additionally repoints
claude-code/codex's user-global MCP config at tmp files for the couple of
tests that also exercise the global-MCP pass (`_isolate_global_mcp` in
conftest.py nulls those out by default — a real per-repo safety net this
suite must not defeat).
"""

from __future__ import annotations

import argparse
import dataclasses
import json
from pathlib import Path

import yaml


def _patch_detect_all(monkeypatch):
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    patched = {
        h_id: dataclasses.replace(h, detect=(lambda: True))
        for h_id, h in _harnesses.HARNESSES.items()
    }
    monkeypatch.setattr(_harnesses, "HARNESSES", patched)


def _patch_global_targets(monkeypatch, tmp_path):
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    claude_global = tmp_path / "global" / "claude.json"
    codex_global = tmp_path / "global" / "codex-config.toml"
    claude_global.parent.mkdir(parents=True, exist_ok=True)
    patched = {}
    for h_id, h in _harnesses.HARNESSES.items():
        kwargs = {"detect": (lambda: True)}
        if h_id == "claude-code":
            kwargs["global_mcp_config"] = claude_global
        elif h_id == "codex":
            kwargs["global_mcp_config"] = codex_global
        patched[h_id] = dataclasses.replace(h, **kwargs)
    monkeypatch.setattr(_harnesses, "HARNESSES", patched)
    return claude_global, codex_global


def _write_registry(data_home: Path, registry: dict) -> None:
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _read_registry(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text())


def _project_registry(
    proj_path: Path,
    *,
    harnesses_global: list,
    mcp_cfg: dict,
    project_name: str = "alpha",
    server_name: str = "demo-server",
    server_harnesses=None,
) -> dict:
    server_cfg = {
        "version": "1.0.0",
        "description": "",
        "source": None,
        "type": "mcp-server",
        "scope": "project-specific",
        "upstream": None,
        "mcp": mcp_cfg,
    }
    if server_harnesses is not None:
        server_cfg["harnesses"] = server_harnesses
    return {
        "version": "1",
        "harnesses_global": harnesses_global,
        "skills": {server_name: server_cfg},
        "projects": {
            project_name: {
                "path": str(proj_path),
                "enabled": [server_name],
                "bundles": [],
                "harnesses": [],
            }
        },
        "bundles": {},
    }


def _sync_report(data_home: Path) -> dict:
    path = data_home / "state" / "sync-report.json"
    assert path.exists(), "sync report was not written"
    return json.loads(path.read_text())


def _run_sync(capsys) -> None:
    import hub

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()


def _assert_reasons_known(rows) -> None:
    """S-3: case 13 (`test_every_reason_word_is_in_the_interfaces_vocabulary`)
    is a tautology against the constant it polices — it cannot catch a row
    that escapes with a reason word outside the set. This is the real check,
    run against ROWS A SYNC ACTUALLY PRODUCED."""
    from skill_hub.infrastructure.mcp import mcp_delivery

    for row in rows:
        if row["reason"] is not None:
            assert row["reason"] in mcp_delivery.DELIVERY_REASONS, row


# ─────────────────────────────────────────────────────────────────────────────
# 1-2 — written / unchanged
# ─────────────────────────────────────────────────────────────────────────────


def test_written_row_for_a_new_project_server(tmp_data_home, monkeypatch, capsys):
    _patch_detect_all(monkeypatch)
    proj = tmp_data_home / "alpha"
    proj.mkdir()
    reg = _project_registry(
        proj,
        harnesses_global=["claude-code"],
        mcp_cfg={"command": "python3", "args": ["server.py"], "env": {}},
    )
    _write_registry(tmp_data_home, reg)

    _run_sync(capsys)
    rep = _sync_report(tmp_data_home)
    rows = rep["projects"]["alpha"]["mcp_delivery"]
    _assert_reasons_known(rows)
    matches = [r for r in rows if r["server"] == "demo-server" and r["harness"] == "claude-code"]
    assert any(r["state"] == "written" and r["reason"] is None for r in matches)
    assert (proj / ".mcp.json").exists()


def test_unchanged_row_on_second_sync(tmp_data_home, monkeypatch, capsys):
    _patch_detect_all(monkeypatch)
    proj = tmp_data_home / "alpha"
    proj.mkdir()
    reg = _project_registry(
        proj,
        harnesses_global=["claude-code"],
        mcp_cfg={"command": "python3", "args": ["server.py"], "env": {}},
    )
    _write_registry(tmp_data_home, reg)

    _run_sync(capsys)
    _run_sync(capsys)
    rep = _sync_report(tmp_data_home)
    rows = rep["projects"]["alpha"]["mcp_delivery"]
    _assert_reasons_known(rows)
    matches = [r for r in rows if r["server"] == "demo-server" and r["harness"] == "claude-code"]
    assert matches, "expected at least one row for demo-server"
    assert all(r["state"] == "unchanged" for r in matches)
    assert rep["global"]["mcp"]["writes"] == 0


# ─────────────────────────────────────────────────────────────────────────────
# 3 — affinity
# ─────────────────────────────────────────────────────────────────────────────


def test_skipped_affinity_row(tmp_data_home, monkeypatch, capsys):
    _patch_detect_all(monkeypatch)
    proj = tmp_data_home / "alpha"
    proj.mkdir()
    reg = _project_registry(
        proj,
        harnesses_global=["claude-code", "codex"],
        mcp_cfg={"command": "python3", "args": ["server.py"], "env": {}},
        server_harnesses=["codex"],
    )
    _write_registry(tmp_data_home, reg)

    _run_sync(capsys)
    rep = _sync_report(tmp_data_home)
    rows = rep["projects"]["alpha"]["mcp_delivery"]
    _assert_reasons_known(rows)
    affinity_rows = [
        r for r in rows if r["server"] == "demo-server" and r["reason"] == "affinity"
    ]
    assert len(affinity_rows) == 1
    row = affinity_rows[0]
    assert row["harness"] == "claude-code"
    assert row["state"] == "skipped"


# ─────────────────────────────────────────────────────────────────────────────
# 4 — no_global_target (pi / opencode), and NOT opencode_no_global (m2)
# ─────────────────────────────────────────────────────────────────────────────


def test_skipped_no_global_target_rows_for_pi_and_opencode(tmp_data_home, monkeypatch, capsys):
    _patch_global_targets(monkeypatch, tmp_data_home)
    mcp_src = tmp_data_home / "mcp-servers" / "demo-global"
    mcp_src.mkdir(parents=True)
    (mcp_src / "server.py").write_text("# stub\n")

    registry = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": {
            "demo-global": {
                "version": "1.0.0",
                "description": "",
                "source": str(mcp_src),
                "type": "mcp-server",
                "scope": "global",
                "upstream": None,
                "mcp": {"command": "python3", "args": ["{source}/server.py"], "env": {}},
            }
        },
        "projects": {},
        "bundles": {},
    }
    _write_registry(tmp_data_home, registry)

    _run_sync(capsys)
    rep = _sync_report(tmp_data_home)
    rows = rep["global"]["mcp"]["delivery"]
    _assert_reasons_known(rows)

    by_harness = {
        r["harness"]: r for r in rows if r.get("reason") == "no_global_target"
    }
    assert set(by_harness) == {"pi", "opencode"}
    for row in by_harness.values():
        assert row["server"] == "demo-global"
        assert row["state"] == "skipped"

    assert not any(r.get("reason") == "opencode_no_global" for r in rows)


# ─────────────────────────────────────────────────────────────────────────────
# 5-6 — preserved (not_hub_owned) / adopted (unchanged)
# ─────────────────────────────────────────────────────────────────────────────


def test_skipped_not_hub_owned_row(tmp_data_home, monkeypatch, capsys):
    _patch_detect_all(monkeypatch)
    proj = tmp_data_home / "alpha"
    proj.mkdir()
    (proj / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"demo-server": {"command": "user-owned"}}})
    )
    reg = _project_registry(
        proj,
        harnesses_global=["claude-code"],
        mcp_cfg={"command": "python3", "args": ["server.py"], "env": {}},
    )
    _write_registry(tmp_data_home, reg)

    _run_sync(capsys)
    rep = _sync_report(tmp_data_home)
    rows = rep["projects"]["alpha"]["mcp_delivery"]
    _assert_reasons_known(rows)
    matches = [
        r
        for r in rows
        if r["server"] == "demo-server" and r["harness"] == "claude-code"
    ]
    assert any(r["state"] == "skipped" and r["reason"] == "not_hub_owned" for r in matches)
    data = json.loads((proj / ".mcp.json").read_text())
    assert data["mcpServers"]["demo-server"] == {"command": "user-owned"}


def test_adopted_names_report_unchanged_not_skipped(tmp_data_home, monkeypatch, capsys):
    _patch_detect_all(monkeypatch)
    proj = tmp_data_home / "alpha"
    proj.mkdir()
    # Byte-identical to what hub would write — no sidecar yet, so this is the
    # "adopted" (claimed-on-first-sight) path (plans/A.md §2).
    (proj / ".mcp.json").write_text(
        json.dumps(
            {"mcpServers": {"demo-server": {"command": "python3", "args": ["server.py"], "env": {}}}}
        )
    )
    reg = _project_registry(
        proj,
        harnesses_global=["claude-code"],
        mcp_cfg={"command": "python3", "args": ["server.py"], "env": {}},
    )
    _write_registry(tmp_data_home, reg)

    _run_sync(capsys)
    rep = _sync_report(tmp_data_home)
    rows = rep["projects"]["alpha"]["mcp_delivery"]
    _assert_reasons_known(rows)
    matches = [
        r
        for r in rows
        if r["server"] == "demo-server" and r["harness"] == "claude-code"
    ]
    assert matches
    assert all(r["state"] == "unchanged" for r in matches)
    assert not any(r["state"] == "skipped" for r in matches)

    from skill_hub.infrastructure.mcp import mcp_delivery

    registry_after = _read_registry(tmp_data_home)
    findings = mcp_delivery.doctor_findings(rep, registry_after, {})
    assert not any(f.code == "MCP_UNCLAIMED_NATIVE_ENTRY" for f in findings)


# ─────────────────────────────────────────────────────────────────────────────
# 7 — codex_no_sse is `skipped`, never `blocked`, and no bytes land
# ─────────────────────────────────────────────────────────────────────────────


def test_codex_sse_row_is_skipped_not_blocked(tmp_data_home, monkeypatch, capsys):
    _patch_detect_all(monkeypatch)
    proj = tmp_data_home / "alpha"
    proj.mkdir()
    reg = _project_registry(
        proj,
        harnesses_global=["codex"],
        mcp_cfg={"transport": "sse", "url": "https://example.invalid/mcp"},
    )
    _write_registry(tmp_data_home, reg)

    _run_sync(capsys)
    rep = _sync_report(tmp_data_home)
    rows = rep["projects"]["alpha"]["mcp_delivery"]
    _assert_reasons_known(rows)
    matches = [r for r in rows if r["server"] == "demo-server" and r["harness"] == "codex"]
    assert len(matches) == 1
    row = matches[0]
    assert row["state"] == "skipped"
    assert row["reason"] == "codex_no_sse"

    toml_path = proj / ".codex" / "config.toml"
    if toml_path.exists():
        import tomlkit

        data = tomlkit.parse(toml_path.read_text())
        assert "demo-server" not in (data.get("mcp_servers") or {})


# ─────────────────────────────────────────────────────────────────────────────
# 8 — the <reason>:<detail> split
# ─────────────────────────────────────────────────────────────────────────────


def test_reason_detail_split():
    from skill_hub.infrastructure.mcp import mcp_delivery

    split = mcp_delivery.delivery_row(
        harness="codex",
        adapter="codex",
        scope="project:alpha",
        server="s",
        target_file="/x/.codex/config.toml",
        state="skipped",
        reason="codex_header_not_representable:X-Trace",
    )
    assert split["reason"] == "codex_header_not_representable"
    assert split["detail"] == "X-Trace"

    bare = mcp_delivery.delivery_row(
        harness="codex",
        adapter="codex",
        scope="project:alpha",
        server="s",
        target_file="/x/.codex/config.toml",
        state="skipped",
        reason="codex_no_sse",
    )
    assert bare["reason"] == "codex_no_sse"
    assert bare["detail"] is None


# ─────────────────────────────────────────────────────────────────────────────
# 9 — codex_env_not_representable / opencode_default_dropped carry a detail
# ─────────────────────────────────────────────────────────────────────────────


def test_codex_env_not_representable_row():
    from skill_hub.domain.mcp.mcp_spec import McpServerSpec, to_native
    from skill_hub.infrastructure.mcp import mcp_delivery
    from skill_hub.infrastructure.mcp.mcp_adapters import McpProjectWriteResult

    spec = McpServerSpec(name="s", command="python3", env={"OTHER": "${TOKEN}"})
    entry, skips = to_native(spec, "codex")
    assert skips == ["codex_env_not_representable:OTHER"]

    result = McpProjectWriteResult(
        managed=frozenset({"s"}),
        added=frozenset({"s"}),
        skips={"s": skips},
        target=Path("/x/.codex/config.toml"),
    )
    rows = mcp_delivery.rows_from_project_result(
        result, harness_ids=["codex"], adapter="codex", scope_label="project:alpha"
    )
    detail_rows = [r for r in rows if r["reason"] == "codex_env_not_representable"]
    assert len(detail_rows) == 1
    assert detail_rows[0]["detail"] == "OTHER"


def test_opencode_default_dropped_row():
    from skill_hub.domain.mcp.mcp_spec import McpServerSpec, to_native
    from skill_hub.infrastructure.mcp import mcp_delivery
    from skill_hub.infrastructure.mcp.mcp_adapters import McpProjectWriteResult

    spec = McpServerSpec(name="s", command="python3", env={"TOKEN": "${TOKEN:-fallback}"})
    entry, skips = to_native(spec, "opencode")
    assert skips == ["opencode_default_dropped:TOKEN"]

    result = McpProjectWriteResult(
        managed=frozenset({"s"}),
        added=frozenset({"s"}),
        skips={"s": skips},
        target=Path("/x/opencode.json"),
    )
    rows = mcp_delivery.rows_from_project_result(
        result, harness_ids=["opencode"], adapter="opencode", scope_label="project:alpha"
    )
    detail_rows = [r for r in rows if r["reason"] == "opencode_default_dropped"]
    assert len(detail_rows) == 1
    assert detail_rows[0]["detail"] == "TOKEN"


# ─────────────────────────────────────────────────────────────────────────────
# 10 — an unparseable native file aborts and reports the previously-known names
# ─────────────────────────────────────────────────────────────────────────────


def test_parse_aborted_row(tmp_data_home, monkeypatch, capsys):
    _patch_detect_all(monkeypatch)
    proj = tmp_data_home / "alpha"
    proj.mkdir()
    reg = _project_registry(
        proj,
        harnesses_global=["claude-code"],
        mcp_cfg={"command": "python3", "args": ["server.py"], "env": {}},
    )
    _write_registry(tmp_data_home, reg)

    _run_sync(capsys)
    assert (proj / ".mcp.json").exists()

    (proj / ".mcp.json").write_text("{not valid json")
    _run_sync(capsys)

    rep = _sync_report(tmp_data_home)
    rows = rep["projects"]["alpha"]["mcp_delivery"]
    _assert_reasons_known(rows)
    matches = [r for r in rows if r["server"] == "demo-server" and r["harness"] == "claude-code"]
    assert matches
    assert all(r["state"] == "skipped" and r["reason"] == "parse_aborted" for r in matches)
    assert (proj / ".mcp.json").read_text() == "{not valid json"


# ─────────────────────────────────────────────────────────────────────────────
# 11 — rows land on both report halves
# ─────────────────────────────────────────────────────────────────────────────


def test_rows_land_on_both_report_halves(tmp_data_home, monkeypatch, capsys):
    _patch_global_targets(monkeypatch, tmp_data_home)
    mcp_src = tmp_data_home / "mcp-servers" / "demo-global"
    mcp_src.mkdir(parents=True)
    (mcp_src / "server.py").write_text("# stub\n")
    proj = tmp_data_home / "alpha"
    proj.mkdir()

    registry = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": {
            "demo-global": {
                "version": "1.0.0",
                "description": "",
                "source": str(mcp_src),
                "type": "mcp-server",
                "scope": "global",
                "upstream": None,
                "mcp": {"command": "python3", "args": ["{source}/server.py"], "env": {}},
            },
            "demo-server": {
                "version": "1.0.0",
                "description": "",
                "source": None,
                "type": "mcp-server",
                "scope": "project-specific",
                "upstream": None,
                "mcp": {"command": "python3", "args": ["server.py"], "env": {}},
            },
        },
        "projects": {
            "alpha": {
                "path": str(proj),
                "enabled": ["demo-server"],
                "bundles": [],
                "harnesses": [],
            }
        },
        "bundles": {},
    }
    _write_registry(tmp_data_home, registry)

    _run_sync(capsys)
    rep = _sync_report(tmp_data_home)
    _assert_reasons_known(rep["global"]["mcp"]["delivery"])
    _assert_reasons_known(rep["projects"]["alpha"]["mcp_delivery"])

    assert any(r["server"] == "demo-global" for r in rep["global"]["mcp"]["delivery"])
    assert any(r["server"] == "demo-server" for r in rep["projects"]["alpha"]["mcp_delivery"])


# ─────────────────────────────────────────────────────────────────────────────
# 12 — a report full of `blocked` rows still exits 0
# ─────────────────────────────────────────────────────────────────────────────


def test_delivery_rows_never_fail_sync(tmp_data_home, monkeypatch, capsys):
    _patch_detect_all(monkeypatch)
    proj = tmp_data_home / "alpha"
    proj.mkdir()
    reg = _project_registry(
        proj,
        harnesses_global=["codex"],  # untrusted by default → blocked rows
        mcp_cfg={"command": "python3", "args": ["server.py"], "env": {}},
    )
    _write_registry(tmp_data_home, reg)

    import hub

    hub.cmd_sync(argparse.Namespace())  # must not raise
    capsys.readouterr()

    rep = _sync_report(tmp_data_home)
    rows = rep["projects"]["alpha"]["mcp_delivery"]
    _assert_reasons_known(rows)
    assert any(r["state"] == "blocked" and r["reason"] == "codex_untrusted_project" for r in rows)
    assert rep["global"]["doctor"]["ok"] is True
    assert rep["ok"] is True


# ─────────────────────────────────────────────────────────────────────────────
# W-5 — an in-place edit to a global server reports `written`, not
# `unchanged`; the adapter's own `GlobalMcpWriteResult.updated` carries the
# name on the run that changed it.
# ─────────────────────────────────────────────────────────────────────────────


def test_global_server_edit_reports_written_and_populates_updated(
    tmp_data_home, monkeypatch, capsys
):
    _patch_global_targets(monkeypatch, tmp_data_home)
    mcp_src = tmp_data_home / "mcp-servers" / "demo-global"
    mcp_src.mkdir(parents=True)
    (mcp_src / "server.py").write_text("# stub\n")

    def _registry(args):
        return {
            "version": "1",
            "harnesses_global": ["claude-code"],
            "skills": {
                "demo-global": {
                    "version": "1.0.0",
                    "description": "",
                    "source": str(mcp_src),
                    "type": "mcp-server",
                    "scope": "global",
                    "upstream": None,
                    "mcp": {"command": "python3", "args": args, "env": {}},
                }
            },
            "projects": {},
            "bundles": {},
        }

    from skill_hub.infrastructure.mcp import mcp_adapters

    captured: list = []
    orig_claude = mcp_adapters.ClaudeMcpAdapter.write_global
    orig_codex = mcp_adapters.CodexMcpAdapter.write_global

    def _spy_claude(self, *a, **k):
        result = orig_claude(self, *a, **k)
        captured.append(("claude", result))
        return result

    def _spy_codex(self, *a, **k):
        result = orig_codex(self, *a, **k)
        captured.append(("codex", result))
        return result

    monkeypatch.setattr(mcp_adapters.ClaudeMcpAdapter, "write_global", _spy_claude)
    monkeypatch.setattr(mcp_adapters.CodexMcpAdapter, "write_global", _spy_codex)

    def _claude_result():
        return next(r for adapter, r in captured if adapter == "claude")

    def _codex_result():
        return next(r for adapter, r in captured if adapter == "codex")

    # 1) first sync: a brand-new global entry — `written`.
    _write_registry(tmp_data_home, _registry(["{source}/server.py"]))
    _run_sync(capsys)
    rep = _sync_report(tmp_data_home)
    claude_rows = [r for r in rep["global"]["mcp"]["delivery"] if r["harness"] == "claude-code"]
    _assert_reasons_known(claude_rows)
    assert any(
        r["server"] == "demo-global" and r["state"] == "written" for r in claude_rows
    ), claude_rows

    # 2) second sync, registry unchanged — byte-stable re-sync, `unchanged`,
    # and the adapter's own result carries nothing in `updated`.
    captured.clear()
    _run_sync(capsys)
    rep = _sync_report(tmp_data_home)
    claude_rows = [r for r in rep["global"]["mcp"]["delivery"] if r["harness"] == "claude-code"]
    assert any(
        r["server"] == "demo-global" and r["state"] == "unchanged" for r in claude_rows
    ), claude_rows
    assert "demo-global" not in _claude_result().updated

    # 3) third sync: the SAME name, edited in place (new arg) — `written`
    # again, and `GlobalMcpWriteResult.updated` names it for both writers.
    captured.clear()
    _write_registry(tmp_data_home, _registry(["{source}/server.py", "--verbose"]))
    _run_sync(capsys)
    rep = _sync_report(tmp_data_home)
    claude_rows = [r for r in rep["global"]["mcp"]["delivery"] if r["harness"] == "claude-code"]
    _assert_reasons_known(claude_rows)
    assert any(
        r["server"] == "demo-global" and r["state"] == "written" for r in claude_rows
    ), claude_rows

    assert "demo-global" in _claude_result().updated
    assert "demo-global" in _codex_result().updated


# ─────────────────────────────────────────────────────────────────────────────
# 13 — the reason vocabulary is exactly the INTERFACES.md list
# ─────────────────────────────────────────────────────────────────────────────


def test_every_reason_word_is_in_the_interfaces_vocabulary():
    from skill_hub.infrastructure.mcp import mcp_delivery

    vocabulary = {
        "affinity",
        "no_global_target",
        "not_hub_owned",
        "adapter_missing",
        "parse_aborted",
        "claude_project_not_approved",
        "codex_untrusted_project",
        "codex_no_sse",
        "codex_header_not_representable",
        "codex_env_not_representable",
        "opencode_default_dropped",
    }
    assert mcp_delivery.DELIVERY_REASONS == vocabulary


# ─────────────────────────────────────────────────────────────────────────────
# W6 (wave E1b review) — the vocabulary lives in ONE shared fixture, read by
# both runtimes, instead of being hand-copied into a TS test array a future
# wave could silently let drift.
# ─────────────────────────────────────────────────────────────────────────────


def _vocabulary_fixture() -> dict:
    path = Path(__file__).resolve().parent / "fixtures" / "mcp_vocabulary.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_delivery_and_probe_vocabularies_match_the_shared_fixture():
    from skill_hub.infrastructure.mcp import mcp_delivery, mcp_probe

    fixture = _vocabulary_fixture()
    assert mcp_delivery.DELIVERY_STATES == set(fixture["delivery_states"])
    # `delivery_reasons` is the one vocabulary both runtimes read; the TS copy
    # table (mcpContract.ts) is asserted equal to it in mcpContract.test.ts.
    assert mcp_delivery.DELIVERY_REASONS == set(fixture["delivery_reasons"])
    assert mcp_probe.PROBE_STATES == set(fixture["probe_states"])
