"""Pluggable connector discovery + catalog (`pluggable-connector-distribution`).

Covers `connectors.discovery.ensure_discovered` (drop-in dir, entry points,
back-compat private package, per-plugin error isolation, non-shadowing, lazy
no-import-side-effect, metadata defaults) and the `hub remote connectors`
catalog command.

The `_restore_registry` autouse fixture snapshots + restores the global
connector registry so a test that resets/pollutes discovery state cannot leak
into the rest of the suite.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

import connectors
from connectors import discovery as disc
import hub


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures + helpers
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _restore_registry():
    """Snapshot + restore the global registry around each test."""
    snap = dict(connectors.REMOTE_CONNECTORS)
    snap_src = dict(disc._SOURCE)
    snap_flag = disc._discovered
    yield
    connectors.REMOTE_CONNECTORS.clear()
    connectors.REMOTE_CONNECTORS.update(snap)
    disc._SOURCE.clear()
    disc._SOURCE.update(snap_src)
    disc._discovered = snap_flag


def _connector_src(
    key: str,
    *,
    register: bool = True,
    label: str = "",
    description: str = "",
    transport_kind: str = "ssh",
) -> str:
    """Source for a minimal concrete `RemoteConnector` plugin module."""
    reg_line = "connectors.register_connector(PluginConnector())" if register else ""
    return f'''
import connectors
from connectors.base import RemoteConnector, Capability, HealthResult, RemotePlan


class PluginConnector(RemoteConnector):
    key = {key!r}
    publishable = False
    label = {label!r}
    description = {description!r}
    transport_kind = {transport_kind!r}

    def capabilities(self):
        return {{Capability.SKILLS}}

    def health_check(self, target):
        return HealthResult(reachable=True)

    def list_remote_artifacts(self, target, kind):
        return []

    def fetch_artifact(self, target, ref):
        return b""

    def plan(self, target, desired):
        return RemotePlan(target_id="x")

    def apply(self, target, plan, *, allow=None):
        raise NotImplementedError

    def pull_artifact(self, target, ref):
        return b""


{reg_line}
'''


def _write_dropin(data_home: Path, name: str, src: str) -> None:
    d = data_home / "connectors"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{name}.py").write_text(src)


# ─────────────────────────────────────────────────────────────────────────────
# Discovery
# ─────────────────────────────────────────────────────────────────────────────


def test_dropin_registration(tmp_data_home):
    _write_dropin(tmp_data_home, "mydrop", _connector_src("my-dropin", transport_kind="https"))
    disc._reset_for_tests()
    connectors.ensure_discovered()

    conn = connectors.get_connector("my-dropin")
    assert conn.key == "my-dropin"
    assert conn.transport_kind == "https"
    assert connectors.connector_source("my-dropin") == "drop-in"
    # Built-in survives alongside the drop-in.
    assert "hermes" in connectors.REMOTE_CONNECTORS


def test_dropin_package_registration(tmp_data_home):
    pkg = tmp_data_home / "connectors" / "pkgconn"
    pkg.mkdir(parents=True, exist_ok=True)
    (pkg / "__init__.py").write_text(_connector_src("pkg-conn"))
    disc._reset_for_tests()
    connectors.ensure_discovered()

    assert "pkg-conn" in connectors.REMOTE_CONNECTORS
    assert connectors.connector_source("pkg-conn") == "drop-in"


def test_broken_plugin_isolated(tmp_data_home, caplog):
    _write_dropin(tmp_data_home, "broken", "this is not valid python :::\n")
    _write_dropin(tmp_data_home, "good", _connector_src("good-one"))
    disc._reset_for_tests()

    with caplog.at_level(logging.WARNING, logger="skill_hub.connectors"):
        connectors.ensure_discovered()  # must never raise

    assert "good-one" in connectors.REMOTE_CONNECTORS
    assert "hermes" in connectors.REMOTE_CONNECTORS
    assert "drop-in:broken" in caplog.text


def test_duplicate_key_does_not_shadow_builtin(tmp_data_home, caplog):
    # A drop-in that tries to claim the built-in `hermes` key.
    _write_dropin(tmp_data_home, "evil", _connector_src("hermes", label="Evil"))
    disc._reset_for_tests()

    with caplog.at_level(logging.WARNING, logger="skill_hub.connectors"):
        connectors.ensure_discovered()

    assert connectors.connector_source("hermes") == "builtin"
    assert connectors.get_connector("hermes").label == "Hermes"
    assert "drop-in:evil" in caplog.text


def test_entry_point_registration(tmp_data_home, monkeypatch):
    import importlib.metadata as im

    ns: dict = {}
    exec(_connector_src("ep-conn", register=False), ns)
    ep_class = ns["PluginConnector"]

    class _FakeEP:
        name = "epconn"
        group = disc.ENTRY_POINT_GROUP

        def load(self):
            return ep_class

    class _FakeEPs:
        def select(self, group=None):
            return [_FakeEP()] if group == disc.ENTRY_POINT_GROUP else []

    monkeypatch.setattr(im, "entry_points", lambda: _FakeEPs())
    disc._reset_for_tests()
    connectors.ensure_discovered()

    assert "ep-conn" in connectors.REMOTE_CONNECTORS
    assert connectors.connector_source("ep-conn") == "entry-point"


def test_broken_entry_point_isolated(tmp_data_home, monkeypatch, caplog):
    import importlib.metadata as im

    class _FakeEP:
        name = "boom"
        group = disc.ENTRY_POINT_GROUP

        def load(self):
            raise RuntimeError("kaboom")

    class _FakeEPs:
        def select(self, group=None):
            return [_FakeEP()] if group == disc.ENTRY_POINT_GROUP else []

    monkeypatch.setattr(im, "entry_points", lambda: _FakeEPs())
    disc._reset_for_tests()

    with caplog.at_level(logging.WARNING, logger="skill_hub.connectors"):
        connectors.ensure_discovered()

    assert "hermes" in connectors.REMOTE_CONNECTORS
    assert "entry-point:boom" in caplog.text


def test_import_has_no_side_effects():
    """Importing `connectors` must not import a connector or run discovery."""
    code = (
        "import connectors, sys; "
        "assert 'connectors.hermes' not in sys.modules, list(sys.modules); "
        "assert not connectors.REMOTE_CONNECTORS, connectors.REMOTE_CONNECTORS; "
        "print('ok')"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "ok" in result.stdout


def test_lazy_then_resolve():
    """get_connector triggers discovery and resolves the built-in."""
    code = (
        "import connectors, sys; "
        "assert 'connectors.hermes' not in sys.modules; "
        "c = connectors.get_connector('hermes'); "
        "assert c.key == 'hermes'; "
        "print('ok')"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "ok" in result.stdout


def test_metadata_defaults_for_bare_connector():
    from connectors.base import RemoteConnector, Capability, HealthResult, RemotePlan

    class Bare(RemoteConnector):
        key = "bare-x"
        publishable = False

        def capabilities(self):
            return set()

        def health_check(self, target):
            return HealthResult(reachable=False)

        def list_remote_artifacts(self, target, kind):
            return []

        def fetch_artifact(self, target, ref):
            return b""

        def plan(self, target, desired):
            return RemotePlan(target_id="x")

        def apply(self, target, plan, *, allow=None):
            raise NotImplementedError

        def pull_artifact(self, target, ref):
            return b""

    bare = Bare()
    assert bare.label == ""
    assert bare.display_label == "Bare X"
    assert bare.description == ""
    assert bare.transport_kind == "ssh"
    # Default setup-key hook: no custom plan → generic path.
    assert bare.setup_key_transport(object()) is None


# ─────────────────────────────────────────────────────────────────────────────
# Catalog command
# ─────────────────────────────────────────────────────────────────────────────


def test_catalog_json_default_install(tmp_data_home, capsys):
    disc._reset_for_tests()
    hub.cmd_remote_connectors(types.SimpleNamespace(json=True))
    data = json.loads(capsys.readouterr().out)

    keys = {r["key"] for r in data}
    assert "hermes" in keys

    hermes = next(r for r in data if r["key"] == "hermes")
    assert hermes["label"] == "Hermes"
    assert hermes["transport_kind"] == "ssh"
    assert hermes["publishable"] is True
    assert hermes["available"] is True
    assert hermes["source"] == "builtin"
    assert hermes["description"]


def test_catalog_lists_dropin(tmp_data_home, capsys):
    _write_dropin(
        tmp_data_home,
        "catx",
        _connector_src("cat-x", label="Cat X", transport_kind="https"),
    )
    disc._reset_for_tests()
    hub.cmd_remote_connectors(types.SimpleNamespace(json=True))
    data = json.loads(capsys.readouterr().out)

    row = next(r for r in data if r["key"] == "cat-x")
    assert row["source"] == "drop-in"
    assert row["transport_kind"] == "https"
    assert row["label"] == "Cat X"
    assert row["available"] is True


def test_catalog_table_output(tmp_data_home, capsys):
    disc._reset_for_tests()
    hub.cmd_remote_connectors(types.SimpleNamespace(json=False))
    out = capsys.readouterr().out
    assert "hermes" in out
    assert "Connectors" in out


# ─────────────────────────────────────────────────────────────────────────────
# Setup-key hook — default (generic) path (Group 5.3, public tree)
# ─────────────────────────────────────────────────────────────────────────────


def test_setup_key_hook_default_generic_for_hermes(tmp_data_home, monkeypatch):
    """A hermes target has no custom hook → resolves through the generic branch."""
    from remotes import RemoteTarget

    monkeypatch.setattr(
        hub, "_read_default_ssh_pubkey", lambda: "ssh-ed25519 AAAAHERMESKEY me@laptop"
    )
    target = RemoteTarget(
        id="h",
        connector="hermes",
        transport={"ssh_host": "hermes@box"},
        host_key_sha256="SHA256:GOOD",
    )

    transport, ak_path, match, desc = hub._resolve_revoke_plan({}, target)

    assert ak_path == "~/.ssh/authorized_keys"
    assert match("ssh-ed25519 AAAAHERMESKEY me@laptop") is True
    assert match("ssh-ed25519 AAAAOTHER other@x") is False
    assert "hub pubkey" in desc
