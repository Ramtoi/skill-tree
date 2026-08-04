"""Wave 1 — Hermes connector tests (OFFLINE; no real SSH).

A FAKE "remote box" is a real local temp dir; the injected SSH runner executes
the connector's POSIX remote-shell commands against that dir via `bash -c`, with
the remote `<home>` mapped onto the temp tree. This drives the connector's full
plan/apply/drift/import logic with zero network.

Covers (GATE 1a):
  * plan() classifies all drift states end-to-end + makes NO writes
  * apply() pushes skills to skill-hub/, registers external_dirs merge-preservingly,
    merges mcp_servers, writes docs; idempotent re-apply is byte-stable
  * non-destructive: box-native skills/ is never written/removed
  * upgrade-safety: a write into hermes-agent/ or skills/ raises
  * remote-drifted: apply does NOT clobber; resolve --op pull adopts
  * orphan cleanup is sidecar-scoped; missing sidecar → no-op
  * import: scan flags unmanaged box skills; import adopts with origin
  * _run_remote_dispatch: applied on sync, drift surfaced not applied,
    sync_enabled:false + --skip-remotes bypass, unreachable skipped
"""

from __future__ import annotations

import hashlib
import json
import os
import shlex
import subprocess
import sys
import types
from pathlib import Path

import pytest

import hub
from connectors import Action, DriftStatus
from connectors import sidecar as _sidecar
from connectors.hermes import (
    HermesConnector,
    UpgradeSafetyViolation,
    _Paths,
    _decode_skill_tree,
    _encode_skill_tree,
)
from connectors.layouts import agentskills, yaml_mcp
from connectors.transport.ssh import SshTransport
from remotes import RemoteTarget


def _has_yaml_backend():
    try:
        import yaml  # noqa: F401

        return True
    except Exception:
        try:
            import ruamel.yaml  # noqa: F401

            return True
        except Exception:
            return False


needs_yaml = pytest.mark.skipif(
    not _has_yaml_backend(), reason="no YAML backend (ruamel.yaml/PyYAML) available"
)


# ─────────────────────────────────────────────────────────────────────────────
# Fake box: a local temp dir + a runner that executes remote shell commands.
# ─────────────────────────────────────────────────────────────────────────────


class FakeBox:
    """A local temp dir standing in for a remote `<home>` reached over SSH.

    The connector always targets `<home>` = `/box` (a sentinel absolute remote
    path); the runner rewrites that prefix onto the real temp dir before running
    the POSIX command locally. host-key verification is disabled (no pin) so the
    Wave-0 transport issues the bare commands directly.
    """

    HOME = "/box"

    def __init__(self, root: Path, *, env_home: str | None = None,
                 reachable: bool = True):
        self.root = root
        self.env_home = env_home
        self.reachable = reachable
        self.calls: list[list[str]] = []

    def _local(self, remote_path: str) -> str:
        # Map /box/... onto the temp root.
        assert remote_path.startswith(self.HOME), remote_path
        rel = remote_path[len(self.HOME):].lstrip("/")
        return str(self.root / rel) if rel else str(self.root)

    def runner(self, argv, *, input=None):
        from connectors.transport.ssh import RunResult

        self.calls.append(list(argv))
        if not self.reachable:
            return RunResult(returncode=255, stderr="ssh: connect: timed out")

        # argv = ["ssh", *opts, host, remote_cmd]; ssh-keyscan/keygen not used (no pin).
        if argv[0] != "ssh":
            return RunResult(returncode=0, stdout="", stderr="")
        remote_cmd = argv[-1]

        # $HERMES_HOME probe.
        if remote_cmd == 'printf "%s" "$HERMES_HOME"':
            return RunResult(returncode=0, stdout=self.env_home or "")

        # Rewrite the /box prefix onto the temp root, then run via bash locally.
        rewritten = remote_cmd.replace(self.HOME, str(self.root))
        proc = subprocess.run(
            ["bash", "-c", rewritten],
            input=input,
            capture_output=True,
        )
        return RunResult(
            returncode=proc.returncode,
            stdout=proc.stdout.decode("utf-8", "replace"),
            stderr=proc.stderr.decode("utf-8", "replace"),
        )


def _connector_for(box: FakeBox) -> HermesConnector:
    def factory(target):
        return SshTransport(host="fake@box", host_key_sha256=None, runner=box.runner)

    return HermesConnector(transport_factory=factory)


def _target(rid="hermes-main") -> RemoteTarget:
    return RemoteTarget(id=rid, connector="hermes", transport={"ssh_host": "fake@box"},
                        home=FakeBox.HOME)


def _make_skill_tree(name: str, body: str = "body") -> agentskills.SkillTree:
    return agentskills.SkillTree(
        name=name,
        files={"SKILL.md": f"---\nname: {name}\nversion: 1.0.0\n---\n{body}\n".encode()},
    )


def _desired(skills=(), mcp=(), docs=()):
    from connectors import DesiredItem, DesiredState
    from connectors import hermes as _h

    skill_items = []
    for tree in skills:
        skill_items.append(DesiredItem(
            name=tree.name, kind="skill",
            sha256=agentskills.tree_sha256(tree),
            payload=_encode_skill_tree(tree),
        ))
    mcp_items = []
    for name, spec in mcp:
        blob = _h._encode_mcp_spec(spec)
        import hashlib
        mcp_items.append(DesiredItem(
            name=name, kind="mcp",
            sha256=hashlib.sha256(_h._canonical_mcp_bytes(spec)).hexdigest(),
            payload=blob,
        ))
    doc_items = []
    for name, content in docs:
        import hashlib
        doc_items.append(DesiredItem(
            name=name, kind="agent_doc",
            sha256=hashlib.sha256(content).hexdigest(),
            payload=content,
        ))
    return DesiredState(skills=tuple(skill_items), mcp=tuple(mcp_items),
                        agent_docs=tuple(doc_items))


def _box(tmp_path) -> FakeBox:
    root = tmp_path / "box"
    root.mkdir()
    (root / "skill-hub").mkdir()
    (root / "skills").mkdir()
    return FakeBox(root)


def _init_registry():
    """Write a minimal bootstrapped registry into the isolated data home."""
    reg = {"version": "1", "skills": {}, "projects": {}, "bundles": {},
           "remotes": {}, "bootstrap": {"completed_at": "2026-01-01T00:00:00Z"}}
    hub.save_registry(reg)
    return reg


# ─────────────────────────────────────────────────────────────────────────────
# health_check + home detection
# ─────────────────────────────────────────────────────────────────────────────


def test_health_check_ok(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    conn = _connector_for(box)
    res = conn.health_check(_target())
    assert res.ok
    assert res.reachable and res.authenticated and res.host_key_match


def test_health_check_unreachable(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    box.reachable = False
    conn = _connector_for(box)
    res = conn.health_check(_target())
    assert not res.ok
    assert res.reachable is False


def test_home_auto_detected_from_env(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    box.env_home = FakeBox.HOME  # $HERMES_HOME on the box
    conn = _connector_for(box)
    # target.home unset → connector probes $HERMES_HOME.
    target = RemoteTarget(id="r", connector="hermes",
                          transport={"ssh_host": "fake@box"}, home=None)
    res = conn.health_check(target)
    assert res.ok
    assert res.detail == FakeBox.HOME


# ─────────────────────────────────────────────────────────────────────────────
# plan() classifies drift + makes NO writes
# ─────────────────────────────────────────────────────────────────────────────


@needs_yaml
def test_plan_makes_no_writes(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()
    desired = _desired(skills=[_make_skill_tree("alpha")])
    plan = conn.plan(target, desired)
    # CREATE planned, but nothing written to the box.
    assert any(a.action == Action.CREATE and a.name == "alpha" for a in plan.actions)
    assert list((box.root / "skill-hub").iterdir()) == []
    # No write/mv commands were issued.
    assert not any("mv -f" in c[-1] for c in box.calls if c[0] == "ssh")


@needs_yaml
def test_plan_drift_states_end_to_end(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()

    # Push three skills to establish a base in the sidecar.
    t_sync = _make_skill_tree("in-sync-skill", "v1")
    t_local = _make_skill_tree("local-ahead-skill", "v1")
    t_remote = _make_skill_tree("remote-drift-skill", "v1")
    t_conf = _make_skill_tree("conflict-skill", "v1")
    desired0 = _desired(skills=[t_sync, t_local, t_remote, t_conf])
    conn.apply(target, conn.plan(target, desired0))

    # Mutate state:
    #  - in-sync: leave as-is
    #  - local-ahead: change local content only
    #  - remote-drift: change remote content only
    #  - conflict: change BOTH to different content
    t_local2 = _make_skill_tree("local-ahead-skill", "v2-local")
    t_conf_local = _make_skill_tree("conflict-skill", "v2-local")
    # Remote edits (simulate the curator editing on the box):
    (box.root / "skill-hub" / "remote-drift-skill" / "SKILL.md").write_text(
        "---\nname: remote-drift-skill\n---\nv2-remote\n"
    )
    (box.root / "skill-hub" / "conflict-skill" / "SKILL.md").write_text(
        "---\nname: conflict-skill\n---\nv2-remote\n"
    )

    desired1 = _desired(skills=[t_sync, t_local2, t_remote, t_conf_local])
    plan = conn.plan(target, desired1)
    by_name = {a.name: a for a in plan.actions}
    assert by_name["in-sync-skill"].action == Action.NOOP
    assert by_name["local-ahead-skill"].action == Action.FAST_FORWARD
    assert by_name["remote-drift-skill"].action == Action.SKIP_REMOTE_DRIFTED
    assert by_name["remote-drift-skill"].drift_status == DriftStatus.REMOTE_DRIFTED
    assert by_name["conflict-skill"].action == Action.SKIP_CONFLICT
    assert by_name["conflict-skill"].drift_status == DriftStatus.CONFLICT


# ─────────────────────────────────────────────────────────────────────────────
# apply() — push skills, register external_dirs, merge mcp, write docs
# ─────────────────────────────────────────────────────────────────────────────


@needs_yaml
def test_apply_pushes_skill_and_registers_external_dir(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()
    # Pre-existing config.yaml with an unrelated key + a user mcp server.
    cfg = box.root / "config.yaml"
    cfg.write_text("version: 1\nmodel: gpt-5\nmcp_servers:\n  user-srv:\n    command: foo\n")
    orig_model_line = "model: gpt-5"

    desired = _desired(
        skills=[_make_skill_tree("alpha")],
        mcp=[("hub-srv", {"command": "bar", "args": [], "env": {}})],
    )
    result = conn.apply(target, conn.plan(target, desired))
    assert "alpha" in result.created
    # Skill written under skill-hub/, NOT skills/.
    assert (box.root / "skill-hub" / "alpha" / "SKILL.md").exists()
    # external_dirs registered with the skill-hub path.
    cfg_text = cfg.read_text()
    ext = __import__("connectors.hermes", fromlist=["read_external_dirs"]).read_external_dirs(cfg_text)
    assert f"{FakeBox.HOME}/skill-hub" in ext
    # mcp_servers merged: hub-srv added, user-srv preserved, sibling key intact.
    servers = yaml_mcp.read_mcp_servers(cfg_text)
    assert servers["hub-srv"] == {"command": "bar", "args": [], "env": {}}
    assert servers["user-srv"] == {"command": "foo"}
    assert orig_model_line in cfg_text
    # Sidecar records ownership.
    sc = _sidecar.read_sidecar(target.id, "skills")
    assert sc.is_managed("alpha")


@needs_yaml
def test_apply_idempotent_byte_stable(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()
    cfg = box.root / "config.yaml"
    cfg.write_text("version: 1\n")
    desired = _desired(
        skills=[_make_skill_tree("alpha")],
        mcp=[("hub-srv", {"command": "bar", "args": [], "env": {}})],
    )
    conn.apply(target, conn.plan(target, desired))
    cfg_after_first = cfg.read_text()
    skill_after_first = (box.root / "skill-hub" / "alpha" / "SKILL.md").read_bytes()

    # Second apply with identical desired state → no changes.
    result2 = conn.apply(target, conn.plan(target, desired))
    assert not result2.changed
    assert cfg.read_text() == cfg_after_first
    assert (box.root / "skill-hub" / "alpha" / "SKILL.md").read_bytes() == skill_after_first


@needs_yaml
def test_apply_writes_doc_atomically(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()
    desired = _desired(docs=[("MEMORY.md", b"# memory\nentry 1\n")])
    result = conn.apply(target, conn.plan(target, desired))
    assert "MEMORY.md" in result.created
    assert (box.root / "memories" / "MEMORY.md").read_bytes() == b"# memory\nentry 1\n"


# ─────────────────────────────────────────────────────────────────────────────
# Non-destructive: box-native skills/ never written or removed
# ─────────────────────────────────────────────────────────────────────────────


@needs_yaml
def test_box_native_skills_never_touched(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    # A pre-existing box-native skill.
    native = box.root / "skills" / "curator-skill"
    native.mkdir(parents=True)
    (native / "SKILL.md").write_text("---\nname: curator-skill\n---\nagent-authored\n")
    native_sha_before = agentskills.dir_sha256(native)

    conn = _connector_for(box)
    target = _target()
    desired = _desired(skills=[_make_skill_tree("alpha")])
    conn.apply(target, conn.plan(target, desired))

    # The box-native skill is byte-identical and still present.
    assert native.exists()
    assert agentskills.dir_sha256(native) == native_sha_before


# ─────────────────────────────────────────────────────────────────────────────
# Upgrade-safety (1.9 / D14)
# ─────────────────────────────────────────────────────────────────────────────


def test_upgrade_safety_refuses_skills_subtree(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    conn = _connector_for(box)
    paths = _Paths(FakeBox.HOME)
    with pytest.raises(UpgradeSafetyViolation):
        conn._guard_write_path(paths, f"{FakeBox.HOME}/skills/x/SKILL.md")


def test_upgrade_safety_refuses_hermes_agent_subtree(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    conn = _connector_for(box)
    paths = _Paths(FakeBox.HOME)
    with pytest.raises(UpgradeSafetyViolation):
        conn._guard_write_path(paths, f"{FakeBox.HOME}/hermes-agent/main.py")
    # The legitimate skill-hub path is allowed.
    conn._guard_write_path(paths, f"{FakeBox.HOME}/skill-hub/x/SKILL.md")


# ─────────────────────────────────────────────────────────────────────────────
# remote-drifted: apply does NOT clobber; resolve --op pull adopts
# ─────────────────────────────────────────────────────────────────────────────


@needs_yaml
def test_remote_drift_not_clobbered_then_pull_adopts(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()

    # Push, then the curator edits the skill on the box.
    t = _make_skill_tree("widget", "v1")
    conn.apply(target, conn.plan(target, _desired(skills=[t])))
    remote_md = box.root / "skill-hub" / "widget" / "SKILL.md"
    remote_md.write_text("---\nname: widget\n---\nAGENT IMPROVED\n")
    remote_bytes = remote_md.read_bytes()

    # Re-sync with the SAME local content → remote-drifted, NOT applied.
    plan = conn.plan(target, _desired(skills=[t]))
    a = next(x for x in plan.actions if x.name == "widget")
    assert a.action == Action.SKIP_REMOTE_DRIFTED
    result = conn.apply(target, plan)
    assert "widget" in result.skipped
    assert remote_md.read_bytes() == remote_bytes  # not clobbered

    # Pull adopts the agent's edit into the hub registry with provenance.
    blob = conn.pull_artifact(target, f"{FakeBox.HOME}/skill-hub/widget")
    tree = _decode_skill_tree("widget", blob)
    assert b"AGENT IMPROVED" in tree.files["SKILL.md"]


# ─────────────────────────────────────────────────────────────────────────────
# Orphan cleanup is sidecar-scoped; missing sidecar → no-op
# ─────────────────────────────────────────────────────────────────────────────


@needs_yaml
def test_orphan_removal_is_sidecar_scoped(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()

    # Push two skills.
    conn.apply(target, conn.plan(target, _desired(
        skills=[_make_skill_tree("keep"), _make_skill_tree("drop")])))
    assert (box.root / "skill-hub" / "drop").exists()

    # Re-sync with only "keep" → "drop" becomes orphaned → removed.
    plan = conn.plan(target, _desired(skills=[_make_skill_tree("keep")]))
    drop_action = next(a for a in plan.actions if a.name == "drop")
    assert drop_action.action == Action.REMOVE
    result = conn.apply(target, plan)
    assert "drop" in result.removed
    assert not (box.root / "skill-hub" / "drop").exists()
    assert (box.root / "skill-hub" / "keep").exists()


@needs_yaml
def test_missing_sidecar_no_deletes(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()

    # A box skill-hub dir with content but NO sidecar (ownership unknown).
    orphan = box.root / "skill-hub" / "mystery"
    orphan.mkdir(parents=True)
    (orphan / "SKILL.md").write_text("---\nname: mystery\n---\nx\n")

    # Sync with empty desired state → with no sidecar, nothing is removed.
    plan = conn.plan(target, _desired(skills=[]))
    assert not any(a.action == Action.REMOVE for a in plan.actions)
    conn.apply(target, plan)
    assert orphan.exists()  # never deleted on a guess


# ─────────────────────────────────────────────────────────────────────────────
# Import: scan flags unmanaged box skills; import adopts with origin
# ─────────────────────────────────────────────────────────────────────────────


@needs_yaml
def test_list_artifacts_flags_unmanaged_box_skills(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()

    # A managed hub skill + a box-native skill.
    conn.apply(target, conn.plan(target, _desired(skills=[_make_skill_tree("managed-one")])))
    native = box.root / "skills" / "box-native"
    native.mkdir(parents=True)
    (native / "SKILL.md").write_text("---\nname: box-native\n---\ny\n")

    arts = conn.list_remote_artifacts(target, "skill")
    by_name = {a.name: a for a in arts}
    assert by_name["managed-one"].managed is True
    assert by_name["box-native"].managed is False  # import candidate


@needs_yaml
def test_list_artifacts_reads_category_nested_native_tree(tmp_data_home, tmp_path):
    """Defect 1: the Hermes box stores skills CATEGORY-NESTED — the listing must
    return the LEAF skill names (not categories), discover them at any depth, and
    never surface dotdirs. Mirrors the real box: ~/.hermes/skills/<cat>/<skill>/.
    """
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()

    # Category-nested native skills: skills/<category>/<skill>/SKILL.md.
    for cat, skill in [
        ("coding", "refactor-helper"),
        ("coding", "debug-assistant"),
        ("memory", "recall-tool"),
    ]:
        d = box.root / "skills" / cat / skill
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text(f"---\nname: {skill}\n---\nbody\n")
    # A dotdir that must NEVER be listed as a candidate.
    junk = box.root / "skills" / ".git" / "hooks"
    junk.mkdir(parents=True)
    (junk / "SKILL.md").write_text("not a skill\n")

    arts = conn.list_remote_artifacts(target, "skill")
    native = {a.name: a for a in arts if not a.managed}

    # Leaf skill names — NOT the category dirs.
    assert set(native) == {"refactor-helper", "debug-assistant", "recall-tool"}
    assert "coding" not in native and "memory" not in native
    # Dotdirs are never surfaced.
    assert "hooks" not in native and ".git" not in native
    # Each ref is the FULL nested dir path (so import reads the right place).
    assert native["refactor-helper"].ref.endswith("/skills/coding/refactor-helper")
    # Names only — no eager sha hashing.
    assert all(a.sha256 is None for a in native.values())

    # ONE SSH `find` call against the native tree (no per-dir round-trips).
    native_finds = [
        c for c in box.calls
        if c[0] == "ssh" and "find" in c[-1] and "/skills" in c[-1]
        and "skill-hub" not in c[-1]
    ]
    assert len(native_finds) == 1, f"expected 1 native find, got {native_finds}"


@needs_yaml
def test_import_skill_reads_nested_ref(tmp_data_home, tmp_path):
    """Defect 1: adopting a nested box-native skill reads it at its full ref path."""
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()
    d = box.root / "skills" / "category-x" / "deep-skill"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text("---\nname: deep-skill\n---\nnested body\n")
    (d / "extra.md").write_text("more\n")

    arts = conn.list_remote_artifacts(target, "skill")
    match = next(a for a in arts if a.name == "deep-skill")
    blob = conn.pull_artifact(target, match.ref)
    tree = _decode_skill_tree("deep-skill", blob)
    assert b"nested body" in tree.files["SKILL.md"]
    assert tree.files["extra.md"] == b"more\n"
    # Box copy untouched.
    assert (d / "SKILL.md").read_text().endswith("nested body\n")


def test_remote_import_skill_adopts_with_provenance(tmp_data_home, tmp_path, monkeypatch):
    box = _box(tmp_path)
    # A box-native skill to import.
    native = box.root / "skills" / "imported-skill"
    native.mkdir(parents=True)
    (native / "SKILL.md").write_text(
        "---\nname: imported-skill\nversion: 2.0.0\ndescription: from the box\n---\nhi\n"
    )

    # Register the remote in a real registry and patch the connector factory.
    _init_registry()
    reg = hub.load_registry()
    reg.setdefault("remotes", {})["hermes-main"] = {
        "connector": "hermes",
        "transport": {"ssh_host": "fake@box"},
        "home": FakeBox.HOME,
        "sync_enabled": True,
    }
    hub.save_registry(reg)

    from connectors import REMOTE_CONNECTORS
    REMOTE_CONNECTORS["hermes"]._transport_factory = (
        lambda target: SshTransport(host="fake@box", runner=box.runner)
    )
    try:
        args = types.SimpleNamespace(
            name="imported-skill", remote="hermes-main", scan=False, json=False
        )
        hub.cmd_remote_import_skill(args)
    finally:
        from connectors.hermes import _default_transport_factory
        REMOTE_CONNECTORS["hermes"]._transport_factory = _default_transport_factory

    reg2 = hub.load_registry()
    entry = reg2["skills"]["imported-skill"]
    assert entry["origin"] == "remote:hermes-main"
    assert entry["scope"] == "project-specific"
    # The box copy was read, NOT modified.
    assert native.exists()
    assert (native / "SKILL.md").exists()


# ─────────────────────────────────────────────────────────────────────────────
# _run_remote_dispatch via cmd_sync-style invocation
# ─────────────────────────────────────────────────────────────────────────────


def _register_remote(rid="hermes-main", sync_enabled=True):
    _init_registry()
    reg = hub.load_registry()
    reg.setdefault("remotes", {})[rid] = {
        "connector": "hermes",
        "transport": {"ssh_host": "fake@box"},
        "home": FakeBox.HOME,
        "sync_enabled": sync_enabled,
    }
    # A simple equipped skill living in the hub skills dir.
    skill_dir = hub.hub_skills_dir() / "alpha"
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text("---\nname: alpha\nversion: 1.0.0\n---\nbody\n")
    reg.setdefault("skills", {})["alpha"] = {
        "version": "1.0.0", "description": "", "source": hub.collapse_home(skill_dir),
        "type": "claude-skill", "scope": "project-specific", "upstream": None,
    }
    reg.setdefault("remotes", {})[rid]["enabled"] = ["alpha"]
    hub.save_registry(reg)
    return reg


@needs_yaml
def test_dispatch_applies_enabled_remote(tmp_data_home, tmp_path, capsys):
    box = _box(tmp_path)
    (box.root / "config.yaml").write_text("version: 1\n")
    reg = _register_remote()
    from connectors import REMOTE_CONNECTORS
    REMOTE_CONNECTORS["hermes"]._transport_factory = (
        lambda target: SshTransport(host="fake@box", runner=box.runner)
    )
    try:
        hub._run_remote_dispatch(reg, installed=set())
    finally:
        from connectors.hermes import _default_transport_factory
        REMOTE_CONNECTORS["hermes"]._transport_factory = _default_transport_factory
    assert (box.root / "skill-hub" / "alpha" / "SKILL.md").exists()


@needs_yaml
def test_dispatch_reports_drift_without_applying(tmp_data_home, tmp_path, capsys):
    box = _box(tmp_path)
    (box.root / "config.yaml").write_text("version: 1\n")
    reg = _register_remote()
    from connectors import REMOTE_CONNECTORS
    REMOTE_CONNECTORS["hermes"]._transport_factory = (
        lambda target: SshTransport(host="fake@box", runner=box.runner)
    )
    try:
        # First dispatch pushes alpha.
        hub._run_remote_dispatch(reg, installed=set())
        # Curator edits alpha on the box → next dispatch must NOT clobber.
        remote_md = box.root / "skill-hub" / "alpha" / "SKILL.md"
        remote_md.write_text("---\nname: alpha\n---\nAGENT EDIT\n")
        edited = remote_md.read_bytes()
        hub._run_remote_dispatch(reg, installed=set())
        assert remote_md.read_bytes() == edited  # not clobbered
    finally:
        from connectors.hermes import _default_transport_factory
        REMOTE_CONNECTORS["hermes"]._transport_factory = _default_transport_factory
    out = capsys.readouterr().out
    assert "remote-drifted" in out


@needs_yaml
def test_dispatch_skips_sync_disabled(tmp_data_home, tmp_path, capsys):
    box = _box(tmp_path)
    (box.root / "config.yaml").write_text("version: 1\n")
    reg = _register_remote(sync_enabled=False)
    from connectors import REMOTE_CONNECTORS
    called = {"n": 0}

    def factory(target):
        called["n"] += 1
        return SshTransport(host="fake@box", runner=box.runner)

    REMOTE_CONNECTORS["hermes"]._transport_factory = factory
    try:
        hub._run_remote_dispatch(reg, installed=set())
    finally:
        from connectors.hermes import _default_transport_factory
        REMOTE_CONNECTORS["hermes"]._transport_factory = _default_transport_factory
    assert called["n"] == 0  # never contacted
    assert not (box.root / "skill-hub" / "alpha").exists()
    assert "sync disabled" in capsys.readouterr().out


@needs_yaml
def test_dispatch_unreachable_is_non_fatal(tmp_data_home, tmp_path, capsys):
    box = _box(tmp_path)
    box.reachable = False
    reg = _register_remote()
    from connectors import REMOTE_CONNECTORS
    REMOTE_CONNECTORS["hermes"]._transport_factory = (
        lambda target: SshTransport(host="fake@box", runner=box.runner)
    )
    try:
        # Must not raise.
        hub._run_remote_dispatch(reg, installed=set())
    finally:
        from connectors.hermes import _default_transport_factory
        REMOTE_CONNECTORS["hermes"]._transport_factory = _default_transport_factory
    out = capsys.readouterr().out
    assert "skipped" in out or "not ready" in out


# ─────────────────────────────────────────────────────────────────────────────
# Wave 3 — CLI gap subcommands (keyscan / fetch-doc / push-doc / health / doctor)
# All OFFLINE via the FakeBox runner.
# ─────────────────────────────────────────────────────────────────────────────


import contextlib


@contextlib.contextmanager
def _patched_factory(box: FakeBox):
    """Point the registered hermes connector at the FakeBox for one block."""
    from connectors import REMOTE_CONNECTORS

    REMOTE_CONNECTORS["hermes"]._transport_factory = (
        lambda target: SshTransport(host="fake@box", runner=box.runner)
    )
    try:
        yield
    finally:
        from connectors.hermes import _default_transport_factory

        REMOTE_CONNECTORS["hermes"]._transport_factory = _default_transport_factory


def _register_bare_remote(rid="hermes-main", host_key=None, sync_enabled=True):
    """Register a remote with no equipped skills (for doc/health/doctor tests)."""
    _init_registry()
    reg = hub.load_registry()
    entry = {
        "connector": "hermes",
        "transport": {"ssh_host": "fake@box"},
        "home": FakeBox.HOME,
        "sync_enabled": sync_enabled,
    }
    if host_key:
        entry["host_key_sha256"] = host_key
    reg.setdefault("remotes", {})[rid] = entry
    hub.save_registry(reg)
    return reg


# --- keyscan ----------------------------------------------------------------


def test_cmd_remote_keyscan_json(tmp_data_home, tmp_path, monkeypatch, capsys):
    """keyscan delegates to fetch_host_key_fingerprint; accepts a raw ssh-host."""
    monkeypatch.setattr(
        SshTransport, "fetch_host_key_fingerprint", lambda self: "SHA256:LIVEFPR"
    )
    args = types.SimpleNamespace(ssh_host="hermes@moon-base", json=True)
    hub.cmd_remote_keyscan(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload == {
        "ssh_host": "hermes@moon-base",
        "fingerprint": "SHA256:LIVEFPR",
        "detail": "host key fetched",
    }


def test_cmd_remote_keyscan_no_key(tmp_data_home, monkeypatch, capsys):
    monkeypatch.setattr(
        SshTransport, "fetch_host_key_fingerprint", lambda self: None
    )
    args = types.SimpleNamespace(ssh_host="nope@host", json=True)
    hub.cmd_remote_keyscan(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["fingerprint"] is None


# --- health -----------------------------------------------------------------


def test_cmd_remote_health_ok(tmp_data_home, tmp_path, capsys):
    box = _box(tmp_path)
    reg = _register_bare_remote()
    with _patched_factory(box):
        args = types.SimpleNamespace(id="hermes-main", json=True)
        hub.cmd_remote_health(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["reachable"] and payload["authenticated"] and payload["host_key_match"]


def test_cmd_remote_health_unreachable(tmp_data_home, tmp_path, capsys):
    box = _box(tmp_path)
    box.reachable = False
    reg = _register_bare_remote()
    with _patched_factory(box):
        args = types.SimpleNamespace(id="hermes-main", json=True)
        hub.cmd_remote_health(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["reachable"] is False


# --- fetch-doc --------------------------------------------------------------


def _seed_doc(box: FakeBox, doc_name: str, content: str):
    from connectors.hermes import DOC_PATHS

    rel = DOC_PATHS[doc_name]
    p = box.root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    return p


def test_cmd_remote_fetch_doc(tmp_data_home, tmp_path, capsys):
    box = _box(tmp_path)
    _seed_doc(box, "MEMORY.md", "remote memory body\n")
    reg = _register_bare_remote()
    with _patched_factory(box):
        args = types.SimpleNamespace(id="hermes-main", doc="MEMORY.md", json=True)
        hub.cmd_remote_fetch_doc(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["content"] == "remote memory body\n"
    assert payload["doc"] == "MEMORY.md"


def test_cmd_remote_list_docs_surfaces_live_docs(tmp_data_home, tmp_path, capsys):
    """Defect 2: list the LIVE docs present on the box, independent of any diff."""
    box = _box(tmp_path)
    _seed_doc(box, "SOUL.md", "persona\n")
    _seed_doc(box, "MEMORY.md", "memory\n")
    # USER.md intentionally absent.
    reg = _register_bare_remote()
    with _patched_factory(box):
        args = types.SimpleNamespace(id="hermes-main", json=True)
        hub.cmd_remote_list_docs(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    by = {d["name"]: d for d in payload["docs"]}
    assert by["SOUL.md"]["present"] is True and by["SOUL.md"]["sha256"]
    assert by["MEMORY.md"]["present"] is True
    assert by["USER.md"]["present"] is False and by["USER.md"]["sha256"] is None


def test_cmd_remote_fetch_doc_unknown_name(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    reg = _register_bare_remote()
    with _patched_factory(box):
        args = types.SimpleNamespace(id="hermes-main", doc="BOGUS.md", json=True)
        with pytest.raises(SystemExit):
            hub.cmd_remote_fetch_doc(args)


# --- push-doc + drift refusal -----------------------------------------------


def test_cmd_remote_push_doc_writes_and_rebases(tmp_data_home, tmp_path, capsys):
    box = _box(tmp_path)
    _seed_doc(box, "MEMORY.md", "old body\n")
    reg = _register_bare_remote()
    new_content = "edited body\n"
    with _patched_factory(box):
        args = types.SimpleNamespace(id="hermes-main", doc="MEMORY.md", force=False, json=False)
        import io
        old_stdin = sys.stdin
        sys.stdin = io.TextIOWrapper(io.BytesIO(new_content.encode()))
        try:
            hub.cmd_remote_push_doc(args)
        finally:
            sys.stdin = old_stdin
    from connectors.hermes import DOC_PATHS
    assert (box.root / DOC_PATHS["MEMORY.md"]).read_text() == new_content
    # Backup-on-change left a sibling .hub-bak with the prior content.
    bak = box.root / (DOC_PATHS["MEMORY.md"] + ".hub-bak")
    assert bak.read_text() == "old body\n"
    # Sidecar re-based to the pushed content.
    from connectors import sidecar as _sidecar
    sc = _sidecar.read_sidecar("hermes-main", "docs")
    assert sc.base_sha("MEMORY.md") == hashlib.sha256(new_content.encode()).hexdigest()


def test_cmd_remote_push_doc_refuses_on_drift(tmp_data_home, tmp_path):
    """If the remote drifted since the hub last touched it, push is refused."""
    box = _box(tmp_path)
    _seed_doc(box, "MEMORY.md", "base body\n")
    reg = _register_bare_remote()
    # Seed the sidecar base to a DIFFERENT sha than the live remote → drift.
    from connectors import sidecar as _sidecar
    sc = _sidecar.read_sidecar("hermes-main", "docs")
    sc.record("MEMORY.md", "agent_doc", "0" * 64)  # base != live remote sha
    _sidecar.write_sidecar(sc)

    with _patched_factory(box):
        args = types.SimpleNamespace(id="hermes-main", doc="MEMORY.md", force=False, json=False)
        import io
        old_stdin = sys.stdin
        sys.stdin = io.TextIOWrapper(io.BytesIO(b"my edit\n"))
        try:
            with pytest.raises(SystemExit):
                hub.cmd_remote_push_doc(args)
        finally:
            sys.stdin = old_stdin
    # Remote was NOT clobbered.
    from connectors.hermes import DOC_PATHS
    assert (box.root / DOC_PATHS["MEMORY.md"]).read_text() == "base body\n"


def test_cmd_remote_push_doc_force_overrides_drift(tmp_data_home, tmp_path, capsys):
    box = _box(tmp_path)
    _seed_doc(box, "MEMORY.md", "base body\n")
    reg = _register_bare_remote()
    from connectors import sidecar as _sidecar
    sc = _sidecar.read_sidecar("hermes-main", "docs")
    sc.record("MEMORY.md", "agent_doc", "0" * 64)
    _sidecar.write_sidecar(sc)

    with _patched_factory(box):
        args = types.SimpleNamespace(id="hermes-main", doc="MEMORY.md", force=True, json=False)
        import io
        old_stdin = sys.stdin
        sys.stdin = io.TextIOWrapper(io.BytesIO(b"forced edit\n"))
        try:
            hub.cmd_remote_push_doc(args)
        finally:
            sys.stdin = old_stdin
    from connectors.hermes import DOC_PATHS
    assert (box.root / DOC_PATHS["MEMORY.md"]).read_text() == "forced edit\n"


# --- setup-key fallback -----------------------------------------------------


def test_cmd_remote_setup_key_prints_root_fallback_on_failure(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """When ssh-copy-id fails, the exact root-side fallback is printed (not run)."""
    box = _box(tmp_path)
    reg = _register_bare_remote()
    # Provide a fake pubkey + force copy_id to fail.
    monkeypatch.setattr(hub, "_read_default_ssh_pubkey", lambda: "ssh-ed25519 AAAATESTKEY me@host")

    def _boom(self, pubkey):
        raise hub_ssh_error()

    def hub_ssh_error():
        from connectors.transport.ssh import SshCommandError
        return SshCommandError(["ssh"], 255, "Permission denied (publickey)")

    monkeypatch.setattr(SshTransport, "copy_id", _boom)
    with _patched_factory(box):
        args = types.SimpleNamespace(id="hermes-main", ssh_host=None, json=True)
        with pytest.raises(SystemExit):
            hub.cmd_remote_setup_key(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert "ssh root@box" in payload["fallback"]
    assert "authorized_keys" in payload["fallback"]


def test_cmd_remote_setup_key_raw_host_succeeds(tmp_data_home, tmp_path, monkeypatch, capsys):
    """--ssh-host installs without a registry entry (pre-registration onboarding)."""
    monkeypatch.setattr(hub, "_read_default_ssh_pubkey", lambda: "ssh-ed25519 AAAATESTKEY me@host")
    calls = {"n": 0}
    monkeypatch.setattr(SshTransport, "copy_id", lambda self, pubkey: calls.__setitem__("n", calls["n"] + 1))
    args = types.SimpleNamespace(id=None, ssh_host="hermes@moon-base", json=True)
    hub.cmd_remote_setup_key(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert calls["n"] == 1


# --- doctor -----------------------------------------------------------------


def test_cmd_remote_doctor_clean(tmp_data_home, tmp_path, monkeypatch, capsys):
    box = _box(tmp_path)
    (box.root / "config.yaml").write_text("version: 1\n")
    reg = _register_bare_remote(host_key="SHA256:PINNED")
    # Live fpr matches the pin → no danger.
    monkeypatch.setattr(SshTransport, "fetch_host_key_fingerprint", lambda self: "SHA256:PINNED")
    monkeypatch.setattr(SshTransport, "verify_host_key", lambda self: None)
    with _patched_factory(box):
        args = types.SimpleNamespace(json=True)
        hub.cmd_remote_doctor(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["danger_count"] == 0


def test_cmd_remote_doctor_host_key_mismatch_is_danger(tmp_data_home, tmp_path, monkeypatch):
    box = _box(tmp_path)
    reg = _register_bare_remote(host_key="SHA256:PINNED")
    # Live fingerprint differs from the pin → DANGER + non-zero exit.
    monkeypatch.setattr(SshTransport, "fetch_host_key_fingerprint", lambda self: "SHA256:DIFFERENT")
    with _patched_factory(box):
        args = types.SimpleNamespace(json=False)
        with pytest.raises(SystemExit) as exc:
            hub.cmd_remote_doctor(args)
        assert exc.value.code == 2


def test_cmd_remote_doctor_json_finding_shape(tmp_data_home, tmp_path, monkeypatch, capsys):
    """Pin the per-finding JSON contract the app consumes (`useRemoteDoctor`):
    every finding carries `remote`, `code`, `severity`, `detail`; the envelope
    carries `findings` + `danger_count`."""
    box = _box(tmp_path)
    reg = _register_bare_remote(host_key="SHA256:PINNED")
    # Live fingerprint differs → a host-key-mismatch DANGER finding.
    monkeypatch.setattr(SshTransport, "fetch_host_key_fingerprint", lambda self: "SHA256:DIFFERENT")
    with _patched_factory(box):
        args = types.SimpleNamespace(json=True)
        with pytest.raises(SystemExit):
            hub.cmd_remote_doctor(args)
    payload = json.loads(capsys.readouterr().out)
    assert set(payload.keys()) >= {"findings", "danger_count"}
    assert payload["danger_count"] >= 1
    mismatch = next(f for f in payload["findings"] if f["code"] == "host-key-mismatch")
    assert set(mismatch.keys()) == {"remote", "code", "severity", "detail"}
    assert mismatch["severity"] == "danger"
    assert isinstance(mismatch["remote"], str) and mismatch["remote"]
    assert isinstance(mismatch["detail"], str) and mismatch["detail"]


def test_cmd_remote_doctor_unreachable_warns(tmp_data_home, tmp_path, monkeypatch, capsys):
    box = _box(tmp_path)
    box.reachable = False
    reg = _register_bare_remote(host_key="SHA256:PINNED")
    monkeypatch.setattr(SshTransport, "fetch_host_key_fingerprint", lambda self: "SHA256:PINNED")
    monkeypatch.setattr(SshTransport, "verify_host_key", lambda self: None)
    with _patched_factory(box):
        args = types.SimpleNamespace(json=True)
        hub.cmd_remote_doctor(args)  # warning only → no exit
    payload = json.loads(capsys.readouterr().out)
    assert payload["danger_count"] == 0
    codes = {f["code"] for f in payload["findings"]}
    assert "unreachable" in codes


# ═════════════════════════════════════════════════════════════════════════════
# Wave 3 — Adversarial security review regressions (SECURITY-REVIEW.md F1–F6).
# Each test feeds the EXACT malicious input the review used and asserts the
# attack is now BLOCKED. All OFFLINE.
# ═════════════════════════════════════════════════════════════════════════════


# --- F1: _guard_write_path traversal bypass → allowlist ----------------------


def test_F1_guard_rejects_traversal_out_of_home(tmp_data_home):
    """A `..`-relative path that escapes <home> must be refused (was a bypass)."""
    paths = _Paths("/home/user/.hermes")
    conn = HermesConnector(transport_factory=lambda t: None)
    # relpath "../../../etc/x" → first component ".." slipped past the old check.
    with pytest.raises(UpgradeSafetyViolation):
        conn._guard_write_path(paths, "/home/user/.hermes/skill-hub/../../../etc/x")


def test_F1_guard_rejects_absolute_outside_home(tmp_data_home):
    paths = _Paths("/home/user/.hermes")
    conn = HermesConnector(transport_factory=lambda t: None)
    with pytest.raises(UpgradeSafetyViolation):
        conn._guard_write_path(paths, "/etc/passwd")


def test_F1_guard_rejects_dotdot_into_home_sibling(tmp_data_home):
    paths = _Paths("/home/user/.hermes")
    conn = HermesConnector(transport_factory=lambda t: None)
    # `<home>/../.bashrc` → escapes the managed subtree.
    with pytest.raises(UpgradeSafetyViolation):
        conn._guard_write_path(paths, "/home/user/.hermes/../.bashrc")


def test_F1_guard_allows_legit_paths(tmp_data_home):
    """The allowlist must still permit every documented extension point."""
    paths = _Paths("/home/user/.hermes")
    conn = HermesConnector(transport_factory=lambda t: None)
    # skill-hub tree (and the dir itself), config.yaml, every doc path.
    conn._guard_write_path(paths, "/home/user/.hermes/skill-hub")
    conn._guard_write_path(paths, "/home/user/.hermes/skill-hub/alpha/SKILL.md")
    conn._guard_write_path(paths, "/home/user/.hermes/config.yaml")
    conn._guard_write_path(paths, "/home/user/.hermes/SOUL.md")
    conn._guard_write_path(paths, "/home/user/.hermes/memories/MEMORY.md")
    conn._guard_write_path(paths, "/home/user/.hermes/memories/USER.md")
    # And the still-forbidden Hermes code tree / own-skills tree.
    with pytest.raises(UpgradeSafetyViolation):
        conn._guard_write_path(paths, "/home/user/.hermes/hermes-agent/main.py")
    with pytest.raises(UpgradeSafetyViolation):
        conn._guard_write_path(paths, "/home/user/.hermes/skills/x/SKILL.md")


# --- F2: remote resolve --artifact not slug-validated ------------------------


def test_F2_resolve_rejects_traversal_artifact(tmp_data_home, tmp_path):
    """`--op pull --artifact '../../tmp/x'` is rejected before any write."""
    _register_bare_remote()
    args = types.SimpleNamespace(
        id="hermes-main", artifact="../../tmp/x", op="pull", kind="skill"
    )
    with pytest.raises(SystemExit):
        hub.cmd_remote_resolve(args)
    # No local dir created outside the skills dir, no skill registry entry.
    assert not (hub.hub_skills_dir() / "x").exists()
    assert "x" not in (hub.load_registry().get("skills") or {})
    # The sidecar was never poisoned with a traversal name.
    sc = _sidecar.read_sidecar("hermes-main", "skills")
    assert not sc.managed_names()


def test_F2_resolve_allows_valid_slug_doc(tmp_data_home, tmp_path):
    """A legitimate agent_doc name (MEMORY.md) is NOT a slug yet must be allowed."""
    box = _box(tmp_path)
    _seed_doc(box, "MEMORY.md", "body\n")
    _register_bare_remote()
    with _patched_factory(box):
        args = types.SimpleNamespace(
            id="hermes-main", artifact="MEMORY.md", op="keep-remote", kind="agent_doc"
        )
        hub.cmd_remote_resolve(args)  # must not raise
    # An unknown doc name IS rejected.
    args2 = types.SimpleNamespace(
        id="hermes-main", artifact="../../etc/x", op="pull", kind="agent_doc"
    )
    with pytest.raises(SystemExit):
        hub.cmd_remote_resolve(args2)


# --- F3: remote skill-tree relpath escape on write ---------------------------


def test_F3_write_skill_dir_rejects_escaping_relpath(tmp_path):
    """A remote tree with rel `../../ESCAPED` writes NOTHING outside root."""
    root = tmp_path / "dest"
    root.mkdir()
    sentinel = tmp_path / "ESCAPED"
    tree = agentskills.SkillTree(
        name="evil",
        files={
            "SKILL.md": b"ok\n",
            "../../ESCAPED": b"pwned\n",
        },
    )
    with pytest.raises(agentskills.UnsafeRelpath):
        agentskills.write_skill_dir(root, tree)
    # The escape target was never created.
    assert not sentinel.exists()


def test_F3_write_skill_dir_rejects_absolute_relpath(tmp_path):
    root = tmp_path / "dest"
    root.mkdir()
    tree = agentskills.SkillTree(name="evil", files={"/etc/cron.d/x": b"pwned\n"})
    with pytest.raises(agentskills.UnsafeRelpath):
        agentskills.write_skill_dir(root, tree)


def test_F3_list_files_rejects_escaping_remote_relpath(tmp_data_home, tmp_path):
    """A compromised box returning `../../x` from find is refused at the transport."""
    from connectors.transport.ssh import RunResult, SshCommandError

    def evil_runner(argv, *, input=None):
        if argv[0] == "ssh" and "find" in argv[-1]:
            return RunResult(returncode=0, stdout="./SKILL.md\n../../ESCAPED\n")
        return RunResult(returncode=0, stdout="")

    t = SshTransport(host="fake@box", host_key_sha256=None, runner=evil_runner)
    with pytest.raises(SshCommandError):
        t.list_files("/box/skill-hub/evil")


def test_find_skill_dirs_nested_one_call_and_rejects_escape(tmp_data_home):
    """Defect 1 (transport): `find_skill_dirs` derives leaf names from a single
    `find … -name SKILL.md`, returns (leaf, full_ref), never lists `.`/dotdirs,
    and refuses an escaping relpath from a compromised box."""
    from connectors.transport.ssh import RunResult, SshCommandError

    calls = []

    def runner(argv, *, input=None):
        calls.append(argv)
        if argv[0] == "ssh" and "find" in argv[-1]:
            return RunResult(
                returncode=0,
                stdout="./coding/refactor/SKILL.md\n./memory/recall/SKILL.md\n",
            )
        return RunResult(returncode=0, stdout="")

    t = SshTransport(host="fake@box", host_key_sha256=None, runner=runner)
    found = t.find_skill_dirs("/box/skills")
    assert found == [
        ("recall", "/box/skills/memory/recall"),
        ("refactor", "/box/skills/coding/refactor"),
    ]
    finds = [a for a in calls if a[0] == "ssh" and "find" in a[-1]]
    assert len(finds) == 1  # ONE SSH call

    def evil(argv, *, input=None):
        if argv[0] == "ssh" and "find" in argv[-1]:
            return RunResult(returncode=0, stdout="../../etc/SKILL.md\n")
        return RunResult(returncode=0, stdout="")

    t2 = SshTransport(host="fake@box", host_key_sha256=None, runner=evil)
    with pytest.raises(SshCommandError):
        t2.find_skill_dirs("/box/skills")


# --- F4: drift TOCTOU between plan and apply ---------------------------------


@needs_yaml
def test_F4_apply_aborts_on_remote_drift_after_plan(tmp_data_home, tmp_path):
    """local-ahead at plan time, remote sha changes before apply → write ABORTS."""
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()

    # Establish a base in the sidecar (v1 pushed).
    t1 = _make_skill_tree("widget", "v1")
    conn.apply(target, conn.plan(target, _desired(skills=[t1])))

    # Local edits to v2 → plan classifies LOCAL_AHEAD → FAST_FORWARD.
    t2 = _make_skill_tree("widget", "v2-local")
    plan = conn.plan(target, _desired(skills=[t2]))
    a = next(x for x in plan.actions if x.name == "widget")
    assert a.action == Action.FAST_FORWARD

    # Between plan and apply, the curator edits the remote (TOCTOU).
    remote_md = box.root / "skill-hub" / "widget" / "SKILL.md"
    remote_md.write_text("---\nname: widget\n---\nAGENT EDIT AFTER PLAN\n")
    agent_bytes = remote_md.read_bytes()

    result = conn.apply(target, plan)
    # Write was aborted, not clobbered; the agent's edit survives.
    assert "widget" in result.skipped
    assert "widget" not in result.fast_forwarded
    assert remote_md.read_bytes() == agent_bytes


# --- F5: known_hosts seeds only the pinned key -------------------------------


def test_F5_seed_known_hosts_only_pinned_line(tmp_data_home, tmp_path):
    """keyscan returns ed25519(pinned)+rsa(not pinned) → only the pinned line seeded."""
    kh = tmp_path / "known_hosts"
    ed_line = "box ssh-ed25519 AAAAED25519KEY"
    rsa_line = "box ssh-rsa AAAARSAKEY"
    t = SshTransport(
        host="box",
        host_key_sha256="SHA256:PINNEDED",
        known_hosts=kh,
    )
    t._seed_known_hosts([
        (ed_line, "SHA256:PINNEDED"),
        (rsa_line, "SHA256:OTHERRSA"),
    ])
    content = kh.read_text()
    assert ed_line in content
    assert rsa_line not in content


# --- F6: home with a `..` component ------------------------------------------


def test_F6_normalize_home_rejects_dotdot(tmp_data_home):
    from connectors.hermes import _normalize_home

    with pytest.raises(UpgradeSafetyViolation):
        _normalize_home("~/.hermes/../../etc")


def test_F6_normalize_home_allows_plain(tmp_data_home):
    from connectors.hermes import _normalize_home

    assert _normalize_home("~/.hermes") == "~/.hermes"
    assert _normalize_home("/opt/hermes/") == "/opt/hermes"


# --- minor: non-predictable atomic_write temp suffix -------------------------


def test_minor_atomic_write_temp_suffix_unpredictable(tmp_data_home):
    """Two atomic writes use distinct temp paths (not the fixed `.hub-tmp`)."""
    from connectors.transport.ssh import RunResult

    seen_tmp: list[str] = []

    def capture_runner(argv, *, input=None):
        cmd = argv[-1] if argv and argv[0] == "ssh" else ""
        if "mv -f" in cmd:
            # "... && cat > <tmp> && mv -f <tmp> <dst>"
            seen_tmp.append(cmd.split("cat > ", 1)[1].split(" &&", 1)[0])
        return RunResult(returncode=0, stdout="")

    t = SshTransport(host="box", host_key_sha256=None, runner=capture_runner)
    t.atomic_write("/box/skill-hub/a/SKILL.md", b"x")
    t.atomic_write("/box/skill-hub/a/SKILL.md", b"y")
    assert len(seen_tmp) == 2
    # Distinct per call and not the old predictable suffix.
    assert seen_tmp[0] != seen_tmp[1]
    assert all(".hub-tmp" in s and not s.endswith(".hub-tmp'") for s in seen_tmp)


# ═════════════════════════════════════════════════════════════════════════════
# Force-push resolution: `apply(force_names=…)` clobbers a drifted/conflict
# artifact + re-bases its sidecar so the drift actually clears (bug: `hub remote
# resolve --op push` was a NO-OP on a REMOTE_DRIFTED skill — success banner lied).
# ═════════════════════════════════════════════════════════════════════════════


@needs_yaml
def test_force_push_clobbers_remote_drift_and_clears(tmp_data_home, tmp_path):
    """A REMOTE_DRIFTED skill, force-pushed, actually writes local content, re-bases
    the sidecar, and a fresh plan classifies it as NOOP (in-sync)."""
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()

    # Push v1 → establishes the sidecar base.
    t = _make_skill_tree("grill-me", "v1-local")
    local_sha = agentskills.tree_sha256(t)
    conn.apply(target, conn.plan(target, _desired(skills=[t])))

    # Curator edits the skill on the box → REMOTE_DRIFTED (local == base, remote changed).
    remote_md = box.root / "skill-hub" / "grill-me" / "SKILL.md"
    remote_md.write_text("---\nname: grill-me\n---\nAGENT DRIFTED\n")
    plan = conn.plan(target, _desired(skills=[t]))
    a = next(x for x in plan.actions if x.name == "grill-me")
    assert a.action == Action.SKIP_REMOTE_DRIFTED  # normal sync would skip

    # Force-push THIS artifact.
    plan2 = conn.plan(target, _desired(skills=[t]))
    result = conn.apply(
        target, plan2,
        allow=frozenset({Action.CREATE, Action.FAST_FORWARD}),
        force_names=frozenset({"grill-me"}),
    )
    # (a) forced write recorded, not skipped.
    assert "grill-me" in result.forced
    assert "grill-me" not in result.skipped
    # (b) remote now holds the LOCAL content (clobbered the agent edit).
    assert b"v1-local" in remote_md.read_bytes()
    assert b"AGENT DRIFTED" not in remote_md.read_bytes()
    # (c) sidecar re-based to the local sha.
    sc = _sidecar.read_sidecar(target.id, "skills")
    assert sc.base_sha("grill-me") == local_sha
    # (d) a fresh plan now classifies the artifact as in-sync (NOOP) — drift cleared.
    plan3 = conn.plan(target, _desired(skills=[t]))
    a3 = next(x for x in plan3.actions if x.name == "grill-me")
    assert a3.action == Action.NOOP


@needs_yaml
def test_force_push_clobbers_conflict(tmp_data_home, tmp_path):
    """A CONFLICT skill (both local + remote edited) is also force-pushable."""
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()

    conn.apply(target, conn.plan(target, _desired(skills=[_make_skill_tree("dual", "v1")])))
    # Remote edited AND local edited to a DIFFERENT value → CONFLICT.
    (box.root / "skill-hub" / "dual" / "SKILL.md").write_text("---\nname: dual\n---\nremote-edit\n")
    t_local = _make_skill_tree("dual", "v2-local")
    local_sha = agentskills.tree_sha256(t_local)
    plan = conn.plan(target, _desired(skills=[t_local]))
    a = next(x for x in plan.actions if x.name == "dual")
    assert a.action == Action.SKIP_CONFLICT

    result = conn.apply(
        target, conn.plan(target, _desired(skills=[t_local])),
        allow=frozenset({Action.CREATE, Action.FAST_FORWARD}),
        force_names=frozenset({"dual"}),
    )
    assert "dual" in result.forced
    assert b"v2-local" in (box.root / "skill-hub" / "dual" / "SKILL.md").read_bytes()
    sc = _sidecar.read_sidecar(target.id, "skills")
    assert sc.base_sha("dual") == local_sha


@needs_yaml
def test_force_push_is_strictly_scoped(tmp_data_home, tmp_path):
    """Force-pushing A must NOT touch a co-drifted sibling B (remote + sidecar)."""
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()

    ta = _make_skill_tree("skill-a", "a-v1")
    tb = _make_skill_tree("skill-b", "b-v1")
    conn.apply(target, conn.plan(target, _desired(skills=[ta, tb])))

    # Curator drifts BOTH on the box.
    a_md = box.root / "skill-hub" / "skill-a" / "SKILL.md"
    b_md = box.root / "skill-hub" / "skill-b" / "SKILL.md"
    a_md.write_text("---\nname: skill-a\n---\nAGENT A\n")
    b_md.write_text("---\nname: skill-b\n---\nAGENT B\n")
    b_bytes_before = b_md.read_bytes()
    sc0 = _sidecar.read_sidecar(target.id, "skills")
    b_base_before = sc0.base_sha("skill-b")

    plan = conn.plan(target, _desired(skills=[ta, tb]))
    # Force ONLY skill-a.
    result = conn.apply(
        target, plan,
        allow=frozenset({Action.CREATE, Action.FAST_FORWARD}),
        force_names=frozenset({"skill-a"}),
    )
    # A written, B skipped (not forced).
    assert "skill-a" in result.forced
    assert "skill-b" not in result.forced
    assert "skill-b" in result.skipped
    # A clobbered to local content.
    assert b"a-v1" in a_md.read_bytes()
    # B untouched — remote bytes AND sidecar base unchanged.
    assert b_md.read_bytes() == b_bytes_before
    sc1 = _sidecar.read_sidecar(target.id, "skills")
    assert sc1.base_sha("skill-b") == b_base_before


@needs_yaml
def test_empty_force_names_leaves_normal_apply_unchanged(tmp_data_home, tmp_path):
    """With no force_names, a REMOTE_DRIFTED artifact is still SKIPPED (never clobbered)."""
    box = _box(tmp_path)
    conn = _connector_for(box)
    target = _target()

    t = _make_skill_tree("widget", "v1")
    conn.apply(target, conn.plan(target, _desired(skills=[t])))
    remote_md = box.root / "skill-hub" / "widget" / "SKILL.md"
    remote_md.write_text("---\nname: widget\n---\nAGENT EDIT\n")
    edited = remote_md.read_bytes()

    plan = conn.plan(target, _desired(skills=[t]))
    # Default force_names (empty) → identical to today.
    result = conn.apply(target, plan)  # no force_names
    assert "widget" in result.skipped
    assert not result.forced
    assert remote_md.read_bytes() == edited  # not clobbered


@needs_yaml
def test_cmd_remote_resolve_push_writes_and_reports_honestly(tmp_data_home, tmp_path, capsys):
    """End-to-end: `hub remote resolve --op push` on a drifted skill writes local
    content, re-bases the sidecar, and a re-plan is NOOP (the success banner is honest)."""
    box = _box(tmp_path)
    (box.root / "config.yaml").write_text("version: 1\n")
    reg = _register_remote()  # registers skill "alpha", remote enabled=[alpha]

    with _patched_factory(box):
        # First dispatch pushes alpha → seeds the sidecar base.
        hub._run_remote_dispatch(reg, installed=set())
        remote_md = box.root / "skill-hub" / "alpha" / "SKILL.md"
        assert remote_md.exists()
        # Curator drifts alpha on the box → REMOTE_DRIFTED.
        remote_md.write_text("---\nname: alpha\n---\nAGENT DRIFTED\n")

        args = types.SimpleNamespace(
            id="hermes-main", artifact="alpha", op="push", kind="skill"
        )
        hub.cmd_remote_resolve(args)  # must not raise

    out = capsys.readouterr().out
    assert "push resolved" in out
    # Remote now holds the hub's local content (drift clobbered).
    assert b"AGENT DRIFTED" not in remote_md.read_bytes()
    assert b"body" in remote_md.read_bytes()
    # Sidecar re-based to the local sha → a re-plan is NOOP.
    from connectors import get_connector
    from remotes import RemoteTarget as _RT
    target = _RT(id="hermes-main", connector="hermes",
                 transport={"ssh_host": "fake@box"}, home=FakeBox.HOME)
    with _patched_factory(box):
        desired = hub.build_remote_desired_state(
            (hub.load_registry().get("remotes") or {})["hermes-main"], hub.load_registry()
        )
        plan = get_connector("hermes").plan(target, desired)
    a = next(x for x in plan.actions if x.name == "alpha")
    assert a.action == Action.NOOP


# ─────────────────────────────────────────────────────────────────────────────
# R3/R4 — split probe: home-missing vs auth-failed classification
# ─────────────────────────────────────────────────────────────────────────────


def _home_missing_target(rid="hermes-main"):
    """A target whose configured home points at a dir that does NOT exist on the box
    (Hermes not installed) — authenticated, but `probe(home)` returns False."""
    return RemoteTarget(id=rid, connector="hermes",
                        transport={"ssh_host": "fake@box"}, home="/box/not-installed")


def test_health_check_home_missing(tmp_data_home, tmp_path):
    box = _box(tmp_path)
    conn = _connector_for(box)
    res = conn.health_check(_home_missing_target())
    assert res.reachable and res.authenticated and res.host_key_match
    assert res.ready is False
    assert res.ok is False
    assert res.detail_kind == "home_missing"
    assert "Hermes" in res.detail


def test_health_check_auth_failed(tmp_data_home, tmp_path):
    from connectors.transport.ssh import RunResult

    box = _box(tmp_path)

    def runner(argv, *, input=None):
        # The trivial auth command is rejected: box does not accept our key.
        if argv[0] == "ssh" and argv[-1] == "true":
            return RunResult(returncode=255, stderr="Permission denied (publickey).")
        return box.runner(argv, input=input)

    def factory(target):
        return SshTransport(host="fake@box", host_key_sha256=None, runner=runner)

    conn = HermesConnector(transport_factory=factory)
    res = conn.health_check(_target())
    assert res.reachable is True
    assert res.authenticated is False
    assert res.ready is False
    assert res.ok is False
    assert res.detail_kind == "auth_failed"


def test_cmd_remote_health_home_missing(tmp_data_home, tmp_path, capsys):
    box = _box(tmp_path)
    _init_registry()
    reg = hub.load_registry()
    reg.setdefault("remotes", {})["hermes-main"] = {
        "connector": "hermes", "transport": {"ssh_host": "fake@box"},
        "home": "/box/not-installed", "sync_enabled": True,
    }
    hub.save_registry(reg)
    with _patched_factory(box):
        args = types.SimpleNamespace(id="hermes-main", json=True)
        hub.cmd_remote_health(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["authenticated"] is True
    assert payload["ready"] is False
    assert payload["detail_kind"] == "home_missing"


@needs_yaml
def test_dispatch_home_missing_is_quiet_not_alarming(tmp_data_home, tmp_path, capsys):
    box = _box(tmp_path)
    reg = _register_remote()
    # Point the remote home at a non-existent dir → Hermes not installed on box.
    reg["remotes"]["hermes-main"]["home"] = "/box/not-installed"
    hub.save_registry(reg)
    with _patched_factory(box):
        alarming = hub._run_remote_dispatch(reg, installed=set(), strict=True)
    assert alarming == 0
    out = capsys.readouterr().out
    assert "not set up" in out
    assert "ALARMING" not in out
    # Nothing was pushed (home dir absent).
    assert not (box.root / "not-installed" / "skill-hub" / "alpha").exists()


@needs_yaml
def test_dispatch_home_missing_with_ownership_is_alarming(tmp_data_home, tmp_path, capsys):
    """A box we HAVE pushed to (ownership sidecar records artifacts) whose home is
    now gone is ALARMING (wiped/reset), not a quiet skip — fails --strict-remotes."""
    from connectors import sidecar as _sidecar

    box = _box(tmp_path)
    reg = _register_remote()
    reg["remotes"]["hermes-main"]["home"] = "/box/not-installed"
    hub.save_registry(reg)
    # Seed the ownership sidecar: we previously pushed skill "alpha" here.
    sc = _sidecar.read_sidecar("hermes-main", _sidecar_surface_skills())
    sc.record("alpha", "skill", "deadbeef")
    _sidecar.write_sidecar(sc)

    with _patched_factory(box):
        alarming = hub._run_remote_dispatch(reg, installed=set(), strict=True)
    assert alarming == 1
    out = capsys.readouterr().out
    assert "ALARMING" in out
    assert "provisioned but the remote home is gone" in out


def _sidecar_surface_skills():
    from connectors.hermes import SURFACE_SKILLS
    return SURFACE_SKILLS


# ─────────────────────────────────────────────────────────────────────────────
# R1 — setup-key: no-pubkey actionable message includes ssh-keygen -t ed25519
# ─────────────────────────────────────────────────────────────────────────────


def test_cmd_remote_setup_key_no_pubkey_message(tmp_data_home, monkeypatch, capsys):
    _register_bare_remote()
    monkeypatch.setattr(hub, "_read_default_ssh_pubkey", lambda: None)
    args = types.SimpleNamespace(id="hermes-main", ssh_host=None, json=True)
    with pytest.raises(SystemExit):
        hub.cmd_remote_setup_key(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["no_pubkey"] is True
    assert payload["generate_cmd"] == "ssh-keygen -t ed25519"


# ─────────────────────────────────────────────────────────────────────────────
# R5/R8 — `hub remote pin`: first pin, differing-pin refusal, replace-with-yes
# ─────────────────────────────────────────────────────────────────────────────


def test_cmd_remote_pin_first_pin(tmp_data_home, monkeypatch, capsys):
    _register_bare_remote(host_key=None)
    monkeypatch.setattr(SshTransport, "fetch_host_key_fingerprint", lambda self: "SHA256:NEWLIVE")
    monkeypatch.setattr(hub, "_reseed_known_hosts_after_repin", lambda *a, **k: False)
    args = types.SimpleNamespace(id="hermes-main", accept=None, yes=False, json=True)
    hub.cmd_remote_pin(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["pinned"] is True
    reg = hub.load_registry()
    assert reg["remotes"]["hermes-main"]["host_key_sha256"] == "SHA256:NEWLIVE"


def test_cmd_remote_pin_refuses_differing_pin_without_yes(tmp_data_home, monkeypatch, capsys):
    _register_bare_remote(host_key="SHA256:OLDPIN")
    monkeypatch.setattr(SshTransport, "fetch_host_key_fingerprint", lambda self: "SHA256:DIFFERENT")
    args = types.SimpleNamespace(id="hermes-main", accept=None, yes=False, json=True)
    hub.cmd_remote_pin(args)  # json mode: prints refusal payload, exits 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["refused"] is True
    assert payload["reason"] == "differing-pin"
    assert payload["old_pins"] == ["SHA256:OLDPIN"]
    assert payload["new_pin"] == "SHA256:DIFFERENT"
    # Registry pin unchanged — the MITM case is never silently replaced.
    reg = hub.load_registry()
    assert reg["remotes"]["hermes-main"]["host_key_sha256"] == "SHA256:OLDPIN"


def test_cmd_remote_pin_replaces_with_yes(tmp_data_home, monkeypatch, capsys):
    _register_bare_remote(host_key="SHA256:OLDPIN")
    monkeypatch.setattr(SshTransport, "fetch_host_key_fingerprint", lambda self: "SHA256:DIFFERENT")
    monkeypatch.setattr(hub, "_reseed_known_hosts_after_repin", lambda *a, **k: True)
    args = types.SimpleNamespace(id="hermes-main", accept=None, yes=True, json=True)
    hub.cmd_remote_pin(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["pinned"] is True
    reg = hub.load_registry()
    assert reg["remotes"]["hermes-main"]["host_key_sha256"] == "SHA256:DIFFERENT"


def test_cmd_remote_pin_idempotent_same_key(tmp_data_home, monkeypatch, capsys):
    _register_bare_remote(host_key="SHA256:SAME")
    monkeypatch.setattr(SshTransport, "fetch_host_key_fingerprint", lambda self: "SHA256:SAME")
    args = types.SimpleNamespace(id="hermes-main", accept=None, yes=False, json=True)
    hub.cmd_remote_pin(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["pinned"] is False
    assert payload["changed"] is False


# ─────────────────────────────────────────────────────────────────────────────
# R10 — `hub remote probe`: pre-registration auth probe classification
# ─────────────────────────────────────────────────────────────────────────────


def test_cmd_remote_probe_authenticated(tmp_data_home, monkeypatch, capsys):
    monkeypatch.setattr(SshTransport, "authenticate", lambda self: None)
    args = types.SimpleNamespace(ssh_host="hermes@moon-base", host_key=None, json=True)
    hub.cmd_remote_probe(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["authenticated"] is True
    # Unified success kind: probe emits "ready" (same as health_check), not the
    # old probe-only "authenticated".
    assert payload["detail_kind"] == "ready"


def test_cmd_remote_probe_host_key_blip_is_unreachable(tmp_data_home, monkeypatch, capsys):
    """A keyscan 'could not read host key' HostKeyMismatch is a benign reachability
    blip → unreachable, NOT a false MITM host_key_mismatch."""
    from connectors.transport.ssh import HostKeyMismatch

    def boom(self):
        raise HostKeyMismatch("could not read host key for 'box' to verify the pin")

    monkeypatch.setattr(SshTransport, "authenticate", boom)
    args = types.SimpleNamespace(ssh_host="hermes@moon-base", host_key="SHA256:PIN", json=True)
    hub.cmd_remote_probe(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["reachable"] is False
    assert payload["detail_kind"] == "unreachable"


def test_cmd_remote_probe_real_host_key_mismatch(tmp_data_home, monkeypatch, capsys):
    """A genuine fingerprint mismatch stays host_key_mismatch (reachable, MITM-worthy)."""
    from connectors.transport.ssh import HostKeyMismatch

    def boom(self):
        raise HostKeyMismatch("host key for 'box' does not match the pinned fingerprint(s) (SHA256:PIN)")

    monkeypatch.setattr(SshTransport, "authenticate", boom)
    args = types.SimpleNamespace(ssh_host="hermes@moon-base", host_key="SHA256:PIN", json=True)
    hub.cmd_remote_probe(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["reachable"] is True
    assert payload["detail_kind"] == "host_key_mismatch"


def test_cmd_remote_probe_auth_failed(tmp_data_home, monkeypatch, capsys):
    from connectors.transport.ssh import SshCommandError

    def boom(self):
        raise SshCommandError(["ssh"], 255, "Permission denied (publickey).")

    monkeypatch.setattr(SshTransport, "authenticate", boom)
    args = types.SimpleNamespace(ssh_host="hermes@moon-base", host_key=None, json=True)
    hub.cmd_remote_probe(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["authenticated"] is False
    assert payload["detail_kind"] == "auth_failed"


def test_cmd_remote_probe_unreachable(tmp_data_home, monkeypatch, capsys):
    from connectors.transport.ssh import SshCommandError

    def boom(self):
        raise SshCommandError(["ssh"], 255, "ssh: connect to host: Operation timed out")

    monkeypatch.setattr(SshTransport, "authenticate", boom)
    args = types.SimpleNamespace(ssh_host="hermes@moon-base", host_key=None, json=True)
    hub.cmd_remote_probe(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["reachable"] is False
    assert payload["detail_kind"] == "unreachable"
