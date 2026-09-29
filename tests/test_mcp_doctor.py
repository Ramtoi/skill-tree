"""Tests for the MCP doctor leg — `mcp_delivery.doctor_findings` and its
three-line guarded call from `hub._run_doctor_rollup` (plans/C.md §5, cases
40-44).
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


def _write_registry(data_home: Path, registry: dict) -> None:
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _sync_report(data_home: Path) -> dict:
    path = data_home / "state" / "sync-report.json"
    assert path.exists(), "sync report was not written"
    return json.loads(path.read_text())


def _run_sync(capsys):
    import hub

    hub.cmd_sync(argparse.Namespace())
    return capsys.readouterr()


# ─────────────────────────────────────────────────────────────────────────────
# 40 — one case per finding id; detail names server/harness, never a value
# ─────────────────────────────────────────────────────────────────────────────


def test_detect_mcp_risks_codes():
    from skill_hub.infrastructure.mcp import mcp_delivery

    literal_value = "sk-thisisaverylongsecretlookingvalue1234567890"
    report = {
        "global": {
            "mcp": {
                "delivery": [
                    mcp_delivery.delivery_row(
                        harness="pi",
                        adapter="claude",
                        scope="global",
                        server="g1",
                        target_file="",
                        state="skipped",
                        reason="no_global_target",
                    ),
                ]
            }
        },
        "projects": {
            "alpha": {
                "mcp_delivery": [
                    mcp_delivery.delivery_row(
                        harness="claude-code",
                        adapter="claude",
                        scope="project:alpha",
                        server="a",
                        target_file="/p/.mcp.json",
                        state="blocked",
                        reason="claude_project_not_approved",
                    ),
                    mcp_delivery.delivery_row(
                        harness="codex",
                        adapter="codex",
                        scope="project:alpha",
                        server="b",
                        target_file="/p/.codex/config.toml",
                        state="blocked",
                        reason="codex_untrusted_project",
                    ),
                    mcp_delivery.delivery_row(
                        harness="claude-code",
                        adapter="claude",
                        scope="project:alpha",
                        server="c",
                        target_file="/p/.mcp.json",
                        state="skipped",
                        reason="not_hub_owned",
                    ),
                    mcp_delivery.delivery_row(
                        harness="claude-code",
                        adapter="claude",
                        scope="project:alpha",
                        server="secretsrv",
                        target_file="/p/.mcp.json",
                        state="written",
                    ),
                    mcp_delivery.delivery_row(
                        harness="claude-code",
                        adapter="claude",
                        scope="project:alpha",
                        server="literalsrv",
                        target_file="/p/.mcp.json",
                        state="written",
                    ),
                ]
            }
        },
    }
    registry = {
        "skills": {
            "secretsrv": {
                "type": "mcp-server",
                "mcp": {"command": "python3", "env": {"TOKEN": "${MISSING_TOKEN}"}},
            },
            "literalsrv": {
                "type": "mcp-server",
                "mcp": {
                    "command": "python3",
                    "headers": {"Authorization": literal_value},
                    "allow_literal_secrets": True,
                },
            },
        }
    }

    findings = mcp_delivery.doctor_findings(report, registry, {})
    by_code = {f.code: f for f in findings}

    expected_severity = {
        "MCP_PROJECT_SERVER_NOT_APPROVED": "warning",
        "MCP_CODEX_PROJECT_UNTRUSTED": "warning",
        "MCP_NO_GLOBAL_TARGET": "info",
        "MCP_UNCLAIMED_NATIVE_ENTRY": "info",
        "MCP_UNRESOLVED_SECRET_REF": "info",
        "MCP_LITERAL_SECRET": "warning",
    }
    for code, severity in expected_severity.items():
        assert code in by_code, f"missing finding {code}"
        assert by_code[code].severity == severity

    assert "MISSING_TOKEN" in by_code["MCP_UNRESOLVED_SECRET_REF"].detail

    for f in findings:
        assert literal_value not in f.detail, f"{f.code} leaked the secret value"


# ─────────────────────────────────────────────────────────────────────────────
# 41 (F5) — a preserved/not_hub_owned row raises MCP_UNCLAIMED_NATIVE_ENTRY
# ─────────────────────────────────────────────────────────────────────────────


def test_unclaimed_native_entry_finding():
    from skill_hub.infrastructure.mcp import mcp_delivery

    report = {
        "global": {"mcp": {"delivery": []}},
        "projects": {
            "alpha": {
                "mcp_delivery": [
                    mcp_delivery.delivery_row(
                        harness="claude-code",
                        adapter="claude",
                        scope="project:alpha",
                        server="foreign",
                        target_file="/p/.mcp.json",
                        state="skipped",
                        reason="not_hub_owned",
                    ),
                ]
            }
        },
    }
    findings = mcp_delivery.doctor_findings(report, {"skills": {}}, {})
    matches = [f for f in findings if f.code == "MCP_UNCLAIMED_NATIVE_ENTRY"]
    assert len(matches) == 1
    assert matches[0].severity == "info"
    assert "foreign" in matches[0].detail
    assert "/p/.mcp.json" in matches[0].detail


# ─────────────────────────────────────────────────────────────────────────────
# 42 (m13) — MCP_PROBE_STALE reads the cache only, never probes
# ─────────────────────────────────────────────────────────────────────────────


def test_probe_stale_finding_reads_the_cache_only(monkeypatch):
    from skill_hub.infrastructure.mcp import mcp_delivery, mcp_probe

    def _forbidden_probe(*args, **kwargs):
        raise AssertionError("doctor_findings must never call mcp_probe.probe")

    # C1's `mcp_probe.py` is a stub (C2 adds the real `probe`) — `raising=False`
    # lets this monkeypatch apply either way; the proof still holds because
    # `doctor_findings` never references `mcp_probe.probe` at all.
    monkeypatch.setattr(mcp_probe, "probe", _forbidden_probe, raising=False)
    monkeypatch.setattr(
        mcp_probe,
        "read_probe_cache",
        lambda: {"never-checked": {}, "stale-one": {"checked_at": "2020-01-01T00:00:00Z"}},
    )

    def _fake_age(cache, *, stale_days=7):
        never = sum(1 for row in cache.values() if not row.get("checked_at"))
        stale = sum(1 for row in cache.values() if row.get("checked_at"))
        return (never, stale)

    monkeypatch.setattr(mcp_probe, "cache_age_summary", _fake_age)

    findings = mcp_delivery.doctor_findings(
        {"global": {"mcp": {"delivery": []}}, "projects": {}}, {"skills": {}}, {}
    )
    stale = [f for f in findings if f.code == "MCP_PROBE_STALE"]
    assert len(stale) == 1
    assert "1 MCP server never checked" in stale[0].detail
    assert "1 last checked more than 7 days ago" in stale[0].detail


# ─────────────────────────────────────────────────────────────────────────────
# C-1 — a corrupt (non-UTF-8) probe cache must not crash `hub sync`
# ─────────────────────────────────────────────────────────────────────────────


def test_corrupt_binary_probe_cache_does_not_crash_sync(tmp_data_home, monkeypatch, capsys):
    """`Path.read_text(encoding="utf-8")` raises `UnicodeDecodeError` on
    non-UTF-8 bytes — a shape `OSError`/`json.JSONDecodeError` alone do not
    catch. Both the cache reader AND the doctor leg's own guard must survive
    this: a full `hub sync` (through the real doctor rollup) must complete
    with no traceback."""
    _patch_detect_all(monkeypatch)
    registry = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": {},
        "projects": {},
        "bundles": {},
    }
    _write_registry(tmp_data_home, registry)

    cache_path = tmp_data_home / "state" / "mcp" / "probes.json"
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_bytes(b"\xff\xfe binary garbage, not utf-8 at all")

    _run_sync(capsys)  # must not raise

    rep = _sync_report(tmp_data_home)
    assert rep["ok"] is True
    assert rep["global"]["doctor"]["ok"] is True


# ─────────────────────────────────────────────────────────────────────────────
# W-1 — a registered, never-probed server IS counted as never-checked
# ─────────────────────────────────────────────────────────────────────────────


def test_probe_stale_counts_registered_but_never_checked_server():
    """`cache_age_summary` only iterates rows already IN the cache — a
    registered `mcp-server` skill that has never been probed has no row at
    all, so it used to be counted zero times. `doctor_findings` must close
    that gap itself by diffing the registry's known server names against the
    cache."""
    from skill_hub.infrastructure.mcp import mcp_delivery

    registry = {
        "skills": {
            "never-probed": {"type": "mcp-server", "mcp": {"command": "python3"}},
        }
    }
    report = {"global": {"mcp": {"delivery": []}}, "projects": {}}

    findings = mcp_delivery.doctor_findings(report, registry, {})
    stale = [f for f in findings if f.code == "MCP_PROBE_STALE"]

    assert len(stale) == 1
    assert "1 MCP server never checked" in stale[0].detail


# ─────────────────────────────────────────────────────────────────────────────
# 43 — the doctor rollup emits an mcp-prefixed line; no danger findings
# ─────────────────────────────────────────────────────────────────────────────


def test_doctor_rollup_emits_mcp_leg(tmp_data_home, monkeypatch, capsys):
    _patch_detect_all(monkeypatch)
    proj = tmp_data_home / "alpha"
    proj.mkdir()
    # A hand-authored .mcp.json entry that DIFFERS from what hub would write,
    # with no prior sidecar → "preserved" → skipped/not_hub_owned →
    # MCP_UNCLAIMED_NATIVE_ENTRY (info, non-blocking).
    (proj / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"demo-server": {"command": "user-owned"}}})
    )
    registry = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": {
            "demo-server": {
                "version": "1.0.0",
                "description": "",
                "source": None,
                "type": "mcp-server",
                "scope": "project-specific",
                "upstream": None,
                "mcp": {"command": "python3", "args": ["server.py"], "env": {}},
            }
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

    out = _run_sync(capsys).out
    assert "mcp MCP_UNCLAIMED_NATIVE_ENTRY" in out

    rep = _sync_report(tmp_data_home)
    assert rep["global"]["doctor"]["ok"] is True
    assert rep["ok"] is True


# ─────────────────────────────────────────────────────────────────────────────
# 44 (M2) — the doctor leg lives in mcp_delivery.py, not risks.py
# ─────────────────────────────────────────────────────────────────────────────


def test_doctor_findings_live_in_mcp_delivery():
    from skill_hub.domain.diagnostics import risks
    from skill_hub.infrastructure.mcp import mcp_delivery

    assert hasattr(mcp_delivery, "doctor_findings")
    assert not hasattr(risks, "detect_mcp_risks")
