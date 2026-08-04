"""Risk detection: every v1 code, negative case, schema emission round-trip."""

from __future__ import annotations

import json

import pytest

import risks
from harness_probe import (
    FEATURE_OFF,
    NOT_INSTALLED,
    SUPPORTED,
    UNSUPPORTED,
    HookCapability,
)
from hooks_model import ResolvedHook
from permissions import Hook, NormalizedPermissions, Rule
from risks import RISK_PATTERNS, detect_hook_risks, detect_risks, emit_schema_json


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


# ─────────────────────────────────────────────────────────────────────────────
# detect_hook_risks — hook-library doctor findings (hooks-surface task 2.5)
# ─────────────────────────────────────────────────────────────────────────────


def _hook(**kw) -> ResolvedHook:
    base = dict(
        name="h",
        event="PostToolUse",
        command="",
        tools=[],
        matcher="",
        timeout=None,
        harnesses=None,
        settings={},
        provenance="user",
    )
    base.update(kw)
    return ResolvedHook(**base)


def _cap(verdict: str = SUPPORTED) -> HookCapability:
    return HookCapability(harness_id="claude-code", verdict=verdict, reason="")


def test_hook_sudo_command_flagged():
    hooks = [_hook(name="audit", command="sudo systemctl restart x")]
    findings = detect_hook_risks(hooks, _cap(), "claude-code")
    match = [f for f in findings if f.code == "HOOK_RUNS_SUDO"]
    assert match and match[0].severity == "danger"
    assert "audit" in match[0].detail


def test_hook_clean_command_not_flagged():
    hooks = [_hook(command="/usr/bin/env echo hi")]
    findings = detect_hook_risks(hooks, _cap(), "claude-code")
    assert not any(f.code == "HOOK_RUNS_SUDO" for f in findings)


def test_broken_script_path_flagged(tmp_path):
    missing = tmp_path / "gone.py"
    hooks = [
        _hook(
            name="lint",
            command=f"/usr/bin/python3 {missing} --config {tmp_path}/x.json",
        )
    ]
    findings = detect_hook_risks(hooks, _cap(), "claude-code")
    broken = [f for f in findings if f.code == "HOOK_BROKEN_SCRIPT"]
    assert broken and broken[0].severity == "warning"
    assert str(missing) in broken[0].detail
    # The interpreter and the (non-script) --config json are NOT flagged.
    assert len(broken) == 1


def test_existing_script_path_not_flagged(tmp_path):
    script = tmp_path / "check.sh"
    script.write_text("#!/bin/sh\necho ok\n")
    hooks = [_hook(command=f"bash {script}")]
    findings = detect_hook_risks(hooks, _cap(), "claude-code")
    assert not any(f.code == "HOOK_BROKEN_SCRIPT" for f in findings)


def test_dropped_hook_never_emitted_for_capable_codex():
    """A hook resolving to a hook-capable codex harness must never surface the
    retired DROPPED_HOOK finding (hooks-surface D3 — codex IS hook-capable)."""
    codex_cap = HookCapability(harness_id="codex", verdict=SUPPORTED, reason="")
    hooks = [_hook(event="PostToolUse", command="./do.sh")]
    findings = detect_hook_risks(hooks, codex_cap, "codex")
    assert not any(f.code == "DROPPED_HOOK" for f in findings)


def _lsp_hook(languages: dict) -> ResolvedHook:
    return _hook(
        name="lsp-report",
        provenance="builtin",
        command="/py /lsp_report.py --config /c.json",
        settings={"languages": languages},
    )


def test_lsp_checker_missing_flagged(monkeypatch):
    monkeypatch.setattr(risks.shutil, "which", lambda name: None)
    hook = _lsp_hook({"python": {"enabled": True, "mode": "advisory"}})
    findings = detect_hook_risks([hook], _cap(), "claude-code")
    lsp = [f for f in findings if f.code == "LSP_CHECKER_MISSING"]
    assert lsp and lsp[0].severity == "info"
    assert "ruff" in lsp[0].detail and "python" in lsp[0].detail


def test_lsp_checker_present_not_flagged(monkeypatch):
    monkeypatch.setattr(risks.shutil, "which", lambda name: f"/usr/bin/{name}")
    hook = _lsp_hook({"python": {"enabled": True, "mode": "advisory"}})
    findings = detect_hook_risks([hook], _cap(), "claude-code")
    assert not any(f.code == "LSP_CHECKER_MISSING" for f in findings)


def test_lsp_disabled_language_not_flagged(monkeypatch):
    monkeypatch.setattr(risks.shutil, "which", lambda name: None)
    hook = _lsp_hook({"typescript": {"enabled": False, "mode": "advisory"}})
    findings = detect_hook_risks([hook], _cap(), "claude-code")
    assert not any(f.code == "LSP_CHECKER_MISSING" for f in findings)


def test_lsp_multiple_missing_checkers(monkeypatch):
    monkeypatch.setattr(risks.shutil, "which", lambda name: None)
    hook = _lsp_hook(
        {
            "python": {"enabled": True, "mode": "advisory"},
            "go": {"enabled": True, "mode": "advisory"},
        }
    )
    findings = detect_hook_risks([hook], _cap(), "claude-code")
    langs = {f.detail.split(":")[1].strip().split()[0] for f in findings
             if f.code == "LSP_CHECKER_MISSING"}
    assert langs == {"python", "go"}


def test_lsp_interpreter_missing_flagged(tmp_path):
    """builtin-lsp-hook spec: 'Missing baked interpreter is flagged by doctor'."""
    hook = _hook(
        name="lsp-report",
        provenance="builtin",
        command="/no/such/interpreter /lsp_report.py --config /c.json",
        settings={"languages": {}},
    )
    findings = detect_hook_risks([hook], _cap(), "claude-code")
    found = [f for f in findings if f.code == "LSP_INTERPRETER_MISSING"]
    assert found and found[0].severity == "warning"
    assert "/no/such/interpreter" in found[0].detail


def test_lsp_interpreter_present_not_flagged(tmp_path):
    interp = tmp_path / "python3"
    interp.write_text("#!/bin/sh\n")
    hook = _hook(
        name="lsp-report",
        provenance="builtin",
        command=f"{interp} /lsp_report.py --config /c.json",
        settings={"languages": {}},
    )
    findings = detect_hook_risks([hook], _cap(), "claude-code")
    assert not any(f.code == "LSP_INTERPRETER_MISSING" for f in findings)


def test_lsp_interpreter_missing_ignores_shell_quoted_paths_with_spaces(tmp_path):
    """A quoted interpreter path containing a space (e.g. the packaged app's
    default code_home) must be parsed with shlex, not split on whitespace."""
    interp_dir = tmp_path / "Skill Tree.app" / "Contents" / "Resources" / "python" / "bin"
    interp_dir.mkdir(parents=True)
    interp = interp_dir / "python3"
    interp.write_text("#!/bin/sh\n")
    import shlex as _shlex
    command = f"{_shlex.quote(str(interp))} /script.py --config /c.json"
    hook = _hook(
        name="lsp-report", provenance="builtin", command=command,
        settings={"languages": {}},
    )
    findings = detect_hook_risks([hook], _cap(), "claude-code")
    assert not any(f.code == "LSP_INTERPRETER_MISSING" for f in findings)


def test_lsp_findings_only_for_the_builtin_lsp_report_hook(monkeypatch):
    monkeypatch.setattr(risks.shutil, "which", lambda name: None)
    # A user hook that happens to carry a `languages` setting is NOT lsp-report.
    hook = _hook(
        name="my-hook",
        settings={"languages": {"python": {"enabled": True}}},
    )
    findings = detect_hook_risks([hook], _cap(), "claude-code")
    assert not any(f.code == "LSP_CHECKER_MISSING" for f in findings)


def test_unreached_harness_suppresses_findings():
    """A hook whose harness is not installed/unsupported gets no write, so no
    per-hook findings are produced for it."""
    hooks = [_hook(command="sudo rm -rf /tmp/x")]
    for verdict in (NOT_INSTALLED, UNSUPPORTED):
        assert detect_hook_risks(hooks, _cap(verdict), "codex") == []


def test_feature_off_harness_still_surfaces_definition_findings():
    hooks = [_hook(name="audit", command="sudo do")]
    findings = detect_hook_risks(hooks, _cap(FEATURE_OFF), "codex")
    assert any(f.code == "HOOK_RUNS_SUDO" for f in findings)


def test_none_capability_still_surfaces_findings():
    hooks = [_hook(name="audit", command="sudo do")]
    findings = detect_hook_risks(hooks, None, "codex")  # type: ignore[arg-type]
    assert any(f.code == "HOOK_RUNS_SUDO" for f in findings)


def test_hook_schema_includes_new_codes_and_excludes_dropped_hook():
    payload = json.loads(emit_schema_json())
    codes = {entry["code"] for entry in payload}
    assert "HOOK_BROKEN_SCRIPT" in codes
    assert "LSP_CHECKER_MISSING" in codes
    assert "LSP_INTERPRETER_MISSING" in codes
    assert "HOOK_RUNS_SUDO" in codes
    assert "DROPPED_HOOK" not in codes
    by_code = {e["code"]: e for e in payload}
    assert by_code["LSP_CHECKER_MISSING"]["severity"] == "info"
    assert by_code["HOOK_BROKEN_SCRIPT"]["severity"] == "warning"
    assert by_code["LSP_INTERPRETER_MISSING"]["severity"] == "warning"
