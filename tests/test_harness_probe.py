"""Tests for harness_probe.py — per-harness hook-capability probe (task 1.1).

Codex probing uses FAKE `codex` binaries: a stub shell script placed on a temp
dir prepended to PATH that emits a canned `features list` table (or sleeps to
force a timeout, or exits nonzero). No real codex is invoked. Every verdict path,
the cache write/read round-trip, opencode lsp-state probing, and atomicity are
covered.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

import harness_probe as hp


# ─────────────────────────────────────────────────────────────────────────────
# Fake codex binary helpers
# ─────────────────────────────────────────────────────────────────────────────


FEATURES_HOOKS_ENABLED = """\
apps                                 stable             true
auto_compaction                      stable             true
hooks                                stable             true
goals                                stable             true
"""

FEATURES_HOOKS_DISABLED = """\
apps                                 stable             true
hooks                                stable             false
goals                                stable             true
"""

FEATURES_NO_HOOKS = """\
apps                                 stable             true
goals                                stable             true
"""


def _make_fake_codex(dir_path: Path, *, stdout: str = "", rc: int = 0, sleep: float = 0.0) -> str:
    """Write an executable stub `codex` into dir_path; return its path."""
    dir_path.mkdir(parents=True, exist_ok=True)
    script = dir_path / "codex"
    body = "#!/bin/sh\n"
    if sleep:
        body += f"sleep {sleep}\n"
    if stdout:
        # printf keeps the canned table intact.
        escaped = stdout.replace("\\", "\\\\").replace("'", "'\\''")
        body += f"printf '%s' '{escaped}'\n"
    body += f"exit {rc}\n"
    script.write_text(body)
    script.chmod(script.stat().st_mode | stat.S_IEXEC | stat.S_IRUSR)
    return str(script)


# ─────────────────────────────────────────────────────────────────────────────
# claude-code
# ─────────────────────────────────────────────────────────────────────────────


def test_claude_code_installed_is_supported():
    cap = hp.probe_harness("claude-code", installed={"claude-code"})
    assert cap.verdict == hp.SUPPORTED
    assert "Claude Code" in cap.reason


# ─────────────────────────────────────────────────────────────────────────────
# codex — every verdict path via fake binaries
# ─────────────────────────────────────────────────────────────────────────────


def test_codex_features_hooks_enabled(tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    _make_fake_codex(bindir, stdout=FEATURES_HOOKS_ENABLED)
    monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.environ["PATH"])
    cap = hp.probe_harness("codex", installed={"codex"}, codex_home=tmp_path / "codex-home")
    assert cap.verdict == hp.SUPPORTED
    assert not cap.extra.get("probe_failed")


def test_codex_features_hooks_false_is_feature_off(tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    _make_fake_codex(bindir, stdout=FEATURES_HOOKS_DISABLED)
    monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.environ["PATH"])
    cap = hp.probe_harness("codex", installed={"codex"}, codex_home=tmp_path / "codex-home")
    assert cap.verdict == hp.FEATURE_OFF
    assert "hooks" in cap.reason.lower()


def test_codex_features_no_hooks_row_defaults_enabled(tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    _make_fake_codex(bindir, stdout=FEATURES_NO_HOOKS)
    monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.environ["PATH"])
    cap = hp.probe_harness("codex", installed={"codex"}, codex_home=tmp_path / "codex-home")
    # Absent key = enabled (default-on).
    assert cap.verdict == hp.SUPPORTED


def test_codex_config_toml_explicit_off_is_feature_off(tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    # Even with the CLI reporting enabled, an explicit config disable wins.
    _make_fake_codex(bindir, stdout=FEATURES_HOOKS_ENABLED)
    monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.environ["PATH"])
    codex_home = tmp_path / "codex-home"
    codex_home.mkdir()
    (codex_home / "config.toml").write_text("[features]\nhooks = false\n")
    cap = hp.probe_harness("codex", installed={"codex"}, codex_home=codex_home)
    assert cap.verdict == hp.FEATURE_OFF
    assert "config.toml" in cap.reason


def test_codex_config_toml_hooks_true_stays_supported(tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    _make_fake_codex(bindir, stdout=FEATURES_HOOKS_ENABLED)
    monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.environ["PATH"])
    codex_home = tmp_path / "codex-home"
    codex_home.mkdir()
    (codex_home / "config.toml").write_text("[features]\nhooks = true\nother = 1\n")
    cap = hp.probe_harness("codex", installed={"codex"}, codex_home=codex_home)
    assert cap.verdict == hp.SUPPORTED


def test_codex_config_toml_absent_key_stays_supported(tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    _make_fake_codex(bindir, stdout=FEATURES_HOOKS_ENABLED)
    monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.environ["PATH"])
    codex_home = tmp_path / "codex-home"
    codex_home.mkdir()
    (codex_home / "config.toml").write_text("[features]\njs_repl = false\n")
    cap = hp.probe_harness("codex", installed={"codex"}, codex_home=codex_home)
    assert cap.verdict == hp.SUPPORTED


def test_codex_binary_missing_is_not_installed(tmp_path, monkeypatch):
    # Empty PATH → shutil.which("codex") is None even though we say installed.
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    cap = hp.probe_harness("codex", installed={"codex"}, codex_home=tmp_path / "codex-home")
    assert cap.verdict == hp.NOT_INSTALLED


def test_codex_probe_timeout_fails_safe_supported(tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    _make_fake_codex(bindir, stdout=FEATURES_HOOKS_ENABLED, sleep=30)
    monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.environ["PATH"])
    monkeypatch.setattr(hp, "PROBE_TIMEOUT", 1)
    cap = hp.probe_harness("codex", installed={"codex"}, codex_home=tmp_path / "codex-home")
    # Never brick writes on a flaky probe: fail SAFE to supported.
    assert cap.verdict == hp.SUPPORTED
    assert cap.extra.get("probe_failed") is True
    assert "timed out" in cap.reason.lower()


def test_codex_probe_nonzero_exit_fails_safe_supported(tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    _make_fake_codex(bindir, stdout="", rc=3)
    monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.environ["PATH"])
    cap = hp.probe_harness("codex", installed={"codex"}, codex_home=tmp_path / "codex-home")
    assert cap.verdict == hp.SUPPORTED
    assert cap.extra.get("probe_failed") is True


def test_codex_uninstalled_no_subprocess(tmp_path, monkeypatch):
    # If it isn't in `installed`, no probe/subprocess runs, even if a fake exists.
    bindir = tmp_path / "bin"
    _make_fake_codex(bindir, stdout=FEATURES_HOOKS_ENABLED)
    monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.environ["PATH"])

    def _boom(*a, **k):  # pragma: no cover - must not be called
        raise AssertionError("subprocess must not run for an uninstalled harness")

    monkeypatch.setattr(hp.subprocess, "run", _boom)
    cap = hp.probe_harness("codex", installed=set())
    assert cap.verdict == hp.NOT_INSTALLED


# ─────────────────────────────────────────────────────────────────────────────
# opencode — always unsupported + lsp badge state
# ─────────────────────────────────────────────────────────────────────────────


def test_opencode_unsupported_lsp_disabled_when_no_config(tmp_path):
    cfg = tmp_path / "opencode.json"  # does not exist
    cap = hp.probe_harness("opencode", installed={"opencode"}, opencode_config=cfg)
    assert cap.verdict == hp.UNSUPPORTED
    assert cap.extra["lsp_state"] == "disabled"
    assert "off by default" in cap.reason


def test_opencode_lsp_absent_key_is_disabled(tmp_path):
    cfg = tmp_path / "opencode.json"
    cfg.write_text(json.dumps({"permission": {"bash": {}}}))
    cap = hp.probe_harness("opencode", installed={"opencode"}, opencode_config=cfg)
    assert cap.extra["lsp_state"] == "disabled"


def test_opencode_lsp_object_is_enabled(tmp_path):
    cfg = tmp_path / "opencode.json"
    cfg.write_text(json.dumps({"lsp": {"typescript": {"command": ["tsc"]}}}))
    cap = hp.probe_harness("opencode", installed={"opencode"}, opencode_config=cfg)
    assert cap.verdict == hp.UNSUPPORTED
    assert cap.extra["lsp_state"] == "enabled"


def test_opencode_lsp_false_is_disabled(tmp_path):
    cfg = tmp_path / "opencode.json"
    cfg.write_text(json.dumps({"lsp": False}))
    cap = hp.probe_harness("opencode", installed={"opencode"}, opencode_config=cfg)
    assert cap.extra["lsp_state"] == "disabled"


def test_opencode_lsp_all_servers_disabled_is_disabled(tmp_path):
    cfg = tmp_path / "opencode.json"
    cfg.write_text(json.dumps({"lsp": {"ts": {"enabled": False}}}))
    cap = hp.probe_harness("opencode", installed={"opencode"}, opencode_config=cfg)
    assert cap.extra["lsp_state"] == "disabled"


def test_opencode_lsp_malformed_config_is_unknown(tmp_path):
    cfg = tmp_path / "opencode.json"
    cfg.write_text("{ not valid json")
    cap = hp.probe_harness("opencode", installed={"opencode"}, opencode_config=cfg)
    assert cap.extra["lsp_state"] == "unknown"


# ─────────────────────────────────────────────────────────────────────────────
# pi — unsupported + shim badge
# ─────────────────────────────────────────────────────────────────────────────


def test_pi_unsupported_shim_not_detected(tmp_path):
    cap = hp.probe_harness("pi", installed={"pi"}, pi_home=tmp_path / "pi")
    assert cap.verdict == hp.UNSUPPORTED
    assert cap.extra["shim"] == "shim_not_detected"


def test_pi_shim_detected_when_marker_present(tmp_path):
    pi_home = tmp_path / "pi"
    (pi_home / "hooks").mkdir(parents=True)
    cap = hp.probe_harness("pi", installed={"pi"}, pi_home=pi_home)
    assert cap.verdict == hp.UNSUPPORTED
    assert cap.extra["shim"] == "detected"


# ─────────────────────────────────────────────────────────────────────────────
# probe_all — only installed harnesses probed
# ─────────────────────────────────────────────────────────────────────────────


def test_probe_all_marks_uninstalled_not_installed(tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    _make_fake_codex(bindir, stdout=FEATURES_HOOKS_ENABLED)
    monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.environ["PATH"])
    results = hp.probe_all(
        installed={"claude-code", "codex"},
        codex_home=tmp_path / "codex-home",
        opencode_config=tmp_path / "nope.json",
        pi_home=tmp_path / "pi",
    )
    assert set(results) == {"claude-code", "codex", "pi", "opencode"}
    assert results["claude-code"].verdict == hp.SUPPORTED
    assert results["codex"].verdict == hp.SUPPORTED
    assert results["pi"].verdict == hp.NOT_INSTALLED
    assert results["opencode"].verdict == hp.NOT_INSTALLED


# ─────────────────────────────────────────────────────────────────────────────
# Cache round-trip + atomicity
# ─────────────────────────────────────────────────────────────────────────────


def test_cache_write_read_round_trip(tmp_data_home):
    results = {
        "claude-code": hp.HookCapability("claude-code", hp.SUPPORTED, "ok"),
        "opencode": hp.HookCapability(
            "opencode", hp.UNSUPPORTED, "off", extra={"lsp_state": "disabled"}
        ),
    }
    path = hp.save_cache(results, data_home=tmp_data_home)
    assert path == hp.capabilities_cache_path(tmp_data_home)
    assert path.parent.name == "state"

    loaded = hp.load_cached(data_home=tmp_data_home)
    assert loaded is not None
    assert loaded["schema_version"] == hp.CACHE_SCHEMA_VERSION
    assert "probed_at" in loaded and loaded["probed_at"].endswith("Z")
    assert loaded["harnesses"]["claude-code"]["verdict"] == hp.SUPPORTED
    assert loaded["harnesses"]["opencode"]["extra"]["lsp_state"] == "disabled"

    # Round-trips back through the dataclass.
    cap = hp.HookCapability.from_dict(loaded["harnesses"]["opencode"])
    assert cap.harness_id == "opencode"
    assert cap.verdict == hp.UNSUPPORTED
    assert cap.extra["lsp_state"] == "disabled"


def test_cache_uses_data_home_default(tmp_data_home):
    # No explicit data_home → resolves via hub.data_home() (== tmp_data_home).
    results = {"pi": hp.HookCapability("pi", hp.UNSUPPORTED, "v1")}
    path = hp.save_cache(results)
    assert path == tmp_data_home / "state" / "harness-capabilities.json"
    assert hp.load_cached() is not None


def test_cache_file_is_valid_json_after_write(tmp_data_home):
    results = {"codex": hp.HookCapability("codex", hp.FEATURE_OFF, "off")}
    path = hp.save_cache(results, data_home=tmp_data_home)
    # Parses cleanly (atomic write leaves no partial file) + no leftover temp.
    json.loads(path.read_text())
    assert not path.with_suffix(".json.tmp").exists()


def test_load_cached_missing_returns_none(tmp_data_home):
    assert hp.load_cached(data_home=tmp_data_home) is None


def test_load_cached_corrupt_returns_none(tmp_data_home):
    path = hp.capabilities_cache_path(tmp_data_home)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ garbage")
    assert hp.load_cached(data_home=tmp_data_home) is None


def test_probe_and_cache_persists(tmp_data_home, tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    _make_fake_codex(bindir, stdout=FEATURES_HOOKS_ENABLED)
    monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.environ["PATH"])
    results = hp.probe_and_cache(
        data_home=tmp_data_home,
        installed={"claude-code", "codex"},
        codex_home=tmp_path / "codex-home",
    )
    assert results["codex"].verdict == hp.SUPPORTED
    loaded = hp.load_cached(data_home=tmp_data_home)
    assert loaded["harnesses"]["codex"]["verdict"] == hp.SUPPORTED
