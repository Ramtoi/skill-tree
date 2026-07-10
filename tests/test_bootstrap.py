"""Tests for `hub bootstrap` orchestration (task 3.6)."""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

import pytest
import yaml


def _plan_args(**overrides):
    """A cmd_bootstrap Namespace preset for the --plan-stdin (UI) path."""
    base = dict(
        force=False,
        yes=False,
        dry_run=False,
        json=False,
        skip_migrate=True,
        plan_stdin=True,
    )
    base.update(overrides)
    return argparse.Namespace(**base)


def _cand(name, path, category, origin="claude"):
    return {
        "name": name,
        "path": path,
        "category": category,
        "origin": origin,
        "version": "1.0.0",
        "description": "",
        "broken": False,
    }


def _stub_bootstrap_side_effects(monkeypatch):
    """Neutralize the post-apply sync + permissions adoption for hermetic tests."""
    import hub

    monkeypatch.setattr(hub, "cmd_sync", lambda *a, **k: None)
    monkeypatch.setattr(hub, "_bootstrap_global_permissions_adopt", lambda: None)


def _feed_stdin(monkeypatch, plan):
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(plan)))


def test_bootstrap_state_needs_bootstrap_when_block_absent(tmp_data_home):
    import hub

    state = hub.bootstrap_state({"skills": {}})
    assert state["needs_bootstrap"] is True
    assert state["completed_at"] is None


def test_bootstrap_state_complete_when_completed_at_present(tmp_data_home):
    import hub

    state = hub.bootstrap_state(
        {"bootstrap": {"completed_at": "2026-05-21T14:00:00Z", "version": 1}}
    )
    assert state["needs_bootstrap"] is False
    assert state["completed_at"] == "2026-05-21T14:00:00Z"


def test_bootstrap_idempotent_second_run_no_op(tmp_data_home, capsys):
    """After bootstrap completes, second run without --force is a no-op."""
    import hub

    args = argparse.Namespace(
        force=False, yes=True, dry_run=False, json=False, skip_migrate=True
    )
    hub.cmd_bootstrap(args)
    capsys.readouterr()  # discard first-run output

    # Capture the registry file mtime
    reg_file = tmp_data_home / "registry.yaml"
    mtime_before = reg_file.stat().st_mtime

    # Force re-read of registry on second call by ensuring no caching surprises
    hub.cmd_bootstrap(args)
    out = capsys.readouterr().out
    assert "Already bootstrapped" in out
    # Registry file must be unchanged (mtime tolerant since FS may have low resolution)
    assert reg_file.stat().st_mtime == mtime_before


def test_bootstrap_force_reruns(tmp_data_home, capsys):
    import hub

    args = argparse.Namespace(
        force=False, yes=True, dry_run=False, json=False, skip_migrate=True
    )
    hub.cmd_bootstrap(args)
    capsys.readouterr()
    first_completed = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())[
        "bootstrap"
    ]["completed_at"]

    import time
    time.sleep(1.05)  # ensure ISO second-resolution timestamp advances

    args_force = argparse.Namespace(
        force=True, yes=True, dry_run=False, json=False, skip_migrate=True
    )
    hub.cmd_bootstrap(args_force)
    capsys.readouterr()
    second_completed = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())[
        "bootstrap"
    ]["completed_at"]
    assert second_completed != first_completed


def test_bootstrap_dry_run_json_shape(tmp_data_home, capsys):
    """--dry-run --json emits stable keys without touching the registry."""
    import hub

    args = argparse.Namespace(
        force=False, yes=True, dry_run=True, json=True, skip_migrate=True
    )
    hub.cmd_bootstrap(args)
    out = capsys.readouterr().out
    payload = json.loads(out)
    for key in (
        "legacy_detected",
        "candidates",
        "conflicts",
        "blocked",
        "already_managed",
        "silent_skip",
    ):
        assert key in payload, f"missing key: {key}"

    # Registry must not have been created/written
    assert not (tmp_data_home / "registry.yaml").exists()


def test_bootstrap_precondition_python_version(monkeypatch, tmp_data_home, capsys):
    """Refusal on too-old Python.

    Tests by monkeypatching `MIN_PYTHON` since the actual interpreter version
    is fixed at runtime; the precondition logic still gets exercised.
    """
    import hub

    monkeypatch.setattr(hub, "MIN_PYTHON", (99, 0))  # unreachable
    args = argparse.Namespace(
        force=False, yes=True, dry_run=False, json=False, skip_migrate=True
    )
    with pytest.raises(SystemExit) as excinfo:
        hub.cmd_bootstrap(args)
    assert excinfo.value.code == 1
    err = capsys.readouterr().out
    assert "Python" in err and "required" in err


# ─────────────────────────────────────────────────────────────────────────────
# --plan-stdin (explicit UI apply-plan) — F2
# ─────────────────────────────────────────────────────────────────────────────


def test_bootstrap_plan_stdin_registers_selected_subset(
    monkeypatch, tmp_data_home, capsys
):
    """Only the register-listed paths are imported; unticked ones are skipped."""
    import hub

    _stub_bootstrap_side_effects(monkeypatch)
    cands = [
        _cand("alpha", "/src/alpha", "NEW"),
        _cand("beta", "/src/beta", "NEW"),
    ]
    monkeypatch.setattr(hub, "scan_import_candidates", lambda reg=None: cands)
    _feed_stdin(monkeypatch, {"register": ["/src/alpha"]})

    hub.cmd_bootstrap(_plan_args())
    capsys.readouterr()

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    skills = reg.get("skills", {})
    assert "alpha" in skills
    assert "beta" not in skills
    assert reg["bootstrap"]["completed_at"]


def test_bootstrap_plan_stdin_conflict_replace_honored(
    monkeypatch, tmp_data_home, capsys
):
    """A ticked CONFLICT with action=replace overwrites the existing source."""
    import hub

    _stub_bootstrap_side_effects(monkeypatch)
    # Pre-seed an existing skill that the candidate conflicts with.
    reg_file = tmp_data_home / "registry.yaml"
    reg_file.write_text(
        yaml.safe_dump(
            {"skills": {"brainstorm": {"version": "1.0.0", "source": "/old/brainstorm"}}}
        )
    )
    cands = [_cand("brainstorm", "/new/brainstorm", "CONFLICT", origin="codex")]
    monkeypatch.setattr(hub, "scan_import_candidates", lambda reg=None: cands)
    _feed_stdin(
        monkeypatch,
        {
            "register": ["/new/brainstorm"],
            "conflict_actions": {"/new/brainstorm": "replace"},
        },
    )

    hub.cmd_bootstrap(_plan_args())
    capsys.readouterr()

    reg = yaml.safe_load(reg_file.read_text())
    assert reg["skills"]["brainstorm"]["source"] == hub.collapse_home(
        Path("/new/brainstorm")
    )


def test_bootstrap_plan_stdin_conflict_skip_keeps_existing(
    monkeypatch, tmp_data_home, capsys
):
    """An unticked CONFLICT (not in register) leaves the existing skill untouched."""
    import hub

    _stub_bootstrap_side_effects(monkeypatch)
    reg_file = tmp_data_home / "registry.yaml"
    reg_file.write_text(
        yaml.safe_dump(
            {"skills": {"brainstorm": {"version": "1.0.0", "source": "/old/brainstorm"}}}
        )
    )
    cands = [_cand("brainstorm", "/new/brainstorm", "CONFLICT", origin="codex")]
    monkeypatch.setattr(hub, "scan_import_candidates", lambda reg=None: cands)
    _feed_stdin(monkeypatch, {"register": []})

    hub.cmd_bootstrap(_plan_args())
    capsys.readouterr()

    reg = yaml.safe_load(reg_file.read_text())
    assert reg["skills"]["brainstorm"]["source"] == "/old/brainstorm"


def test_bootstrap_plan_stdin_rejects_unknown_path(
    monkeypatch, tmp_data_home, capsys
):
    """FAIL-CLOSED: a register path not among candidates aborts, nothing applied."""
    import hub

    _stub_bootstrap_side_effects(monkeypatch)
    cands = [_cand("alpha", "/src/alpha", "NEW")]
    monkeypatch.setattr(hub, "scan_import_candidates", lambda reg=None: cands)
    _feed_stdin(monkeypatch, {"register": ["/src/does-not-exist"]})

    with pytest.raises(SystemExit) as excinfo:
        hub.cmd_bootstrap(_plan_args())
    assert excinfo.value.code == 1
    out = capsys.readouterr().out
    assert "rejected" in out and "does-not-exist" in out
    # Nothing applied: no bootstrap block / no alpha skill written.
    if (tmp_data_home / "registry.yaml").exists():
        reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text()) or {}
        assert "alpha" not in reg.get("skills", {})
        assert "bootstrap" not in reg


def test_bootstrap_plan_stdin_rejects_unknown_action(
    monkeypatch, tmp_data_home, capsys
):
    """FAIL-CLOSED: an out-of-vocab conflict action aborts before any mutation."""
    import hub

    _stub_bootstrap_side_effects(monkeypatch)
    cands = [_cand("brainstorm", "/new/brainstorm", "CONFLICT")]
    monkeypatch.setattr(hub, "scan_import_candidates", lambda reg=None: cands)
    _feed_stdin(
        monkeypatch,
        {
            "register": ["/new/brainstorm"],
            "conflict_actions": {"/new/brainstorm": "obliterate"},
        },
    )

    with pytest.raises(SystemExit) as excinfo:
        hub.cmd_bootstrap(_plan_args())
    assert excinfo.value.code == 1
    out = capsys.readouterr().out
    assert "rejected" in out and "obliterate" in out


def test_bootstrap_plan_stdin_rejects_malformed_json(
    monkeypatch, tmp_data_home, capsys
):
    """FAIL-CLOSED: unparseable stdin aborts before scanning/mutation."""
    import hub

    _stub_bootstrap_side_effects(monkeypatch)
    monkeypatch.setattr(sys, "stdin", io.StringIO("{not json"))

    with pytest.raises(SystemExit) as excinfo:
        hub.cmd_bootstrap(_plan_args())
    assert excinfo.value.code == 1
    out = capsys.readouterr().out
    assert "apply-plan" in out


# ─────────────────────────────────────────────────────────────────────────────
# `offered` semantics — the plan-vs-migration reconciliation (finding 1)
# ─────────────────────────────────────────────────────────────────────────────


def test_bootstrap_offered_migration_flip_new_to_managed_tolerated(
    monkeypatch, tmp_data_home, capsys
):
    """MANDATORY: skip_migrate=FALSE + a legacy home whose migration flips a
    previously-NEW offered candidate to ALREADY_MANAGED → the plan TOLERATES it
    (warn + skip), NEVER aborts (case a)."""
    import hub

    _stub_bootstrap_side_effects(monkeypatch)
    monkeypatch.setattr(hub, "cmd_migrate_home", lambda *a, **k: None)
    # Legacy detected → migration path runs (auto_yes via plan_stdin).
    monkeypatch.setattr(
        hub, "bootstrap_state",
        lambda reg=None: {"completed_at": None, "legacy_detected": ["/legacy/home"]},
    )
    # Pre-migration scan: alpha is NEW; post-migration scan: alpha is now
    # ALREADY_MANAGED (its dir got symlinked into the moved data home).
    scans = [
        [_cand("alpha", "/src/alpha", "NEW")],
        [_cand("alpha", "/src/alpha", "ALREADY_MANAGED")],
    ]
    calls = {"n": 0}

    def _scan(reg=None):
        i = min(calls["n"], len(scans) - 1)
        calls["n"] += 1
        return scans[i]

    monkeypatch.setattr(hub, "scan_import_candidates", _scan)
    _feed_stdin(
        monkeypatch,
        {"register": ["/src/alpha"], "offered": ["/src/alpha"]},
    )

    hub.cmd_bootstrap(_plan_args(skip_migrate=False))
    out = capsys.readouterr().out
    # Completed without aborting; the flipped item was tolerated, not registered.
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert reg["bootstrap"]["completed_at"]
    assert "already managed after migration" in out
    assert "alpha" not in reg.get("skills", {})


def test_bootstrap_offered_absent_neither_candidate_nor_managed_fails(
    monkeypatch, tmp_data_home, capsys
):
    """Case (b): a register path that is neither a live candidate nor
    already-managed still fails closed, even with `offered` supplied."""
    import hub

    _stub_bootstrap_side_effects(monkeypatch)
    cands = [_cand("alpha", "/src/alpha", "NEW")]
    monkeypatch.setattr(hub, "scan_import_candidates", lambda reg=None: cands)
    _feed_stdin(
        monkeypatch,
        {"register": ["/src/ghost"], "offered": ["/src/ghost"]},
    )

    with pytest.raises(SystemExit) as excinfo:
        hub.cmd_bootstrap(_plan_args())
    assert excinfo.value.code == 1
    assert "rejected" in capsys.readouterr().out


def test_bootstrap_offered_new_candidate_not_offered_gets_defaults(
    monkeypatch, tmp_data_home, capsys
):
    """Case (c): a NEW candidate that the wizard never displayed (absent from
    `offered`) is registered by the --yes default; a CONFLICT default skips."""
    import hub

    _stub_bootstrap_side_effects(monkeypatch)
    cands = [
        _cand("alpha", "/src/alpha", "NEW"),
        _cand("gamma", "/src/gamma", "NEW"),
        _cand("delta", "/src/delta", "CONFLICT"),
    ]
    monkeypatch.setattr(hub, "scan_import_candidates", lambda reg=None: cands)
    # Wizard only ever showed alpha; gamma + delta appeared later.
    _feed_stdin(
        monkeypatch,
        {"register": ["/src/alpha"], "offered": ["/src/alpha"]},
    )

    hub.cmd_bootstrap(_plan_args())
    capsys.readouterr()

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    skills = reg.get("skills", {})
    assert "alpha" in skills  # ticked
    assert "gamma" in skills  # NEW default (not offered → auto-register)
    assert "delta" not in skills  # CONFLICT default is skip


def test_bootstrap_offered_but_unticked_is_skipped(
    monkeypatch, tmp_data_home, capsys
):
    """Case (d): a candidate the wizard DID display but the user unticked
    (offered, not in register) is skipped — never resurrected by the case-(c)
    default."""
    import hub

    _stub_bootstrap_side_effects(monkeypatch)
    cands = [
        _cand("alpha", "/src/alpha", "NEW"),
        _cand("beta", "/src/beta", "NEW"),
    ]
    monkeypatch.setattr(hub, "scan_import_candidates", lambda reg=None: cands)
    _feed_stdin(
        monkeypatch,
        {"register": ["/src/alpha"], "offered": ["/src/alpha", "/src/beta"]},
    )

    hub.cmd_bootstrap(_plan_args())
    capsys.readouterr()

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    skills = reg.get("skills", {})
    assert "alpha" in skills
    assert "beta" not in skills  # offered + unticked → skipped


def test_bootstrap_no_offered_keeps_strict_no_auto_defaults(
    monkeypatch, tmp_data_home, capsys
):
    """Back-compat: with `offered` OMITTED, a non-registered NEW candidate is NOT
    auto-registered (strict plan-only), and an unknown path still fails."""
    import hub

    _stub_bootstrap_side_effects(monkeypatch)
    cands = [
        _cand("alpha", "/src/alpha", "NEW"),
        _cand("gamma", "/src/gamma", "NEW"),
    ]
    monkeypatch.setattr(hub, "scan_import_candidates", lambda reg=None: cands)
    _feed_stdin(monkeypatch, {"register": ["/src/alpha"]})

    hub.cmd_bootstrap(_plan_args())
    capsys.readouterr()

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    skills = reg.get("skills", {})
    assert "alpha" in skills
    assert "gamma" not in skills  # no offered → no case-(c) default


def test_bootstrap_offered_rejects_non_list(monkeypatch, tmp_data_home, capsys):
    """FAIL-CLOSED: a malformed `offered` (not a list of strings) aborts."""
    import hub

    _stub_bootstrap_side_effects(monkeypatch)
    cands = [_cand("alpha", "/src/alpha", "NEW")]
    monkeypatch.setattr(hub, "scan_import_candidates", lambda reg=None: cands)
    _feed_stdin(
        monkeypatch,
        {"register": ["/src/alpha"], "offered": "not-a-list"},
    )

    with pytest.raises(SystemExit) as excinfo:
        hub.cmd_bootstrap(_plan_args())
    assert excinfo.value.code == 1
    assert "offered" in capsys.readouterr().out


def test_bootstrap_yes_default_unchanged(monkeypatch, tmp_data_home, capsys):
    """--yes still selects all NEW and skips conflicts (no plan-stdin regression)."""
    import hub

    _stub_bootstrap_side_effects(monkeypatch)
    cands = [
        _cand("alpha", "/src/alpha", "NEW"),
        _cand("beta", "/src/beta", "NEW"),
        _cand("gamma", "/src/gamma", "CONFLICT"),
    ]
    monkeypatch.setattr(hub, "scan_import_candidates", lambda reg=None: cands)

    args = argparse.Namespace(
        force=False, yes=True, dry_run=False, json=False, skip_migrate=True
    )
    hub.cmd_bootstrap(args)
    capsys.readouterr()

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    skills = reg.get("skills", {})
    assert "alpha" in skills and "beta" in skills
    # CONFLICT defaults to skip under --yes.
    assert "gamma" not in skills
