"""Risk detection: every v1 code, negative case, schema emission round-trip."""

from __future__ import annotations

import json

import pytest

from permissions import Hook, NormalizedPermissions, Rule
from risks import RISK_PATTERNS, detect_risks, emit_schema_json


def _perms(**kwargs) -> NormalizedPermissions:
    return NormalizedPermissions(**kwargs)


def test_unbounded_bash_detected():
    perms = _perms(allow=[Rule(pattern="Bash(*)", kind="allow")])
    codes = {f.code for f in detect_risks(perms, set())}
    assert "UNBOUNDED_BASH" in codes


def test_unbounded_write_detected():
    perms = _perms(allow=[Rule(pattern="Write(*)", kind="allow")])
    codes = {f.code for f in detect_risks(perms, set())}
    assert "UNBOUNDED_WRITE" in codes


def test_unbounded_fetch_detected():
    perms = _perms(allow=[Rule(pattern="WebFetch(*)", kind="allow")])
    findings = detect_risks(perms, set())
    assert any(f.code == "UNBOUNDED_FETCH" and f.severity == "warning" for f in findings)


def test_unsafe_codex_combo_detected():
    perms = _perms(approval_policy="never", sandbox_mode="danger-full-access")
    codes = {f.code for f in detect_risks(perms, set())}
    assert "UNSAFE_CODEX_COMBO" in codes


def test_codex_combo_not_triggered_when_only_one_set():
    perms = _perms(approval_policy="never")
    codes = {f.code for f in detect_risks(perms, set())}
    assert "UNSAFE_CODEX_COMBO" not in codes


def test_hook_runs_sudo_detected():
    perms = _perms(hooks=[Hook(event="PreToolUse", matcher="Bash",
                                command="sudo rm -rf /tmp/foo")])
    findings = detect_risks(perms, set())
    assert any(f.code == "HOOK_RUNS_SUDO" for f in findings)


def test_clean_perms_produce_no_findings():
    perms = _perms(
        allow=[Rule(pattern="Bash(npm:*)", kind="allow")],
        approval_policy="on-failure",
        sandbox_mode="workspace-write",
        hooks=[Hook(event="PreToolUse", matcher="Bash",
                    command="/usr/local/bin/audit")],
    )
    findings = detect_risks(perms, set())
    assert findings == []


def test_codex_rule_capabilities_do_not_change_risk_findings():
    """Expanded Codex capabilities (tool_allowlist/denylist/ask) must not
    suppress or fabricate risk findings — predicates key off the rules, not caps."""
    import permission_adapters as pa

    codex_caps = pa.CodexPermissionAdapter().capabilities()
    # Unbounded Bash still flags danger even with rule caps advertised.
    danger = _perms(allow=[Rule(pattern="Bash(*)", kind="allow")])
    codes = {f.code for f in detect_risks(danger, codex_caps)}
    assert "UNBOUNDED_BASH" in codes
    # A bounded Bash rule produces no findings under the same caps.
    safe = _perms(allow=[Rule(pattern="Bash(npm:*)", kind="allow")])
    assert detect_risks(safe, codex_caps) == []


def test_emit_schema_json_round_trip():
    payload = json.loads(emit_schema_json())
    codes = {entry["code"] for entry in payload}
    for pat in RISK_PATTERNS:
        assert pat.code in codes
    # Required fields present
    for entry in payload:
        assert {"code", "severity", "explanation"} <= entry.keys()
