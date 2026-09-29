"""Receiver installer confines its archive and leaves unrelated user files alone."""

import hashlib
import importlib
import io
import shutil
import sys
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from skill_hub.application.loadout import loadout_install
from skill_hub.application.loadout.loadout_install import install_payload


@pytest.fixture
def receiver_code(tmp_data_home):
    """Build a bundle-shaped fixture without a checkout-local generated vendor."""
    source = Path(__file__).resolve().parents[1]
    code = tmp_data_home / "receiver-code"
    code.mkdir()
    for name in [
        *(name + ".py" for name in loadout_install.ROOT_MODULES),
        "VERSION",
        "requirements.txt",
        "ccusage-pricing.json",
    ]:
        shutil.copy2(source / name, code / name)
    for name in ("skill_hub", "connectors", "hooks"):
        shutil.copytree(source / name, code / name, ignore=shutil.ignore_patterns("__pycache__"))
    for name in ("yaml", "tomlkit", "ruamel.yaml"):
        module = importlib.import_module(name)
        shutil.copytree(
            Path(module.__file__).parent,
            code / "vendor" / Path(*name.split(".")),
            ignore=shutil.ignore_patterns("__pycache__", "*.so", "*.dylib"),
        )
    return code


def package(extra=None):
    files = {
        "hub.py": b"print('receiver')\n",
        "skill_hub/entrypoints/cli/receive.py": b"",
        "skill_hub/domain/loadout/loadout_profiles.py": b"",
        "vendor/yaml/__init__.py": b"",
    }
    files.update(extra or {})
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for name, data in files.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    payload = stream.getvalue()
    return payload, hashlib.sha256(payload).hexdigest()


def test_install_is_idempotent_user_scoped_and_preserves_other_hub(tmp_path, monkeypatch):
    monkeypatch.setattr(loadout_install.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0))
    home = tmp_path / "home"
    home.mkdir()
    other = home / ".skill-hub"
    other.mkdir()
    (other / "registry.yaml").write_text("untouched")
    payload, sha = package()
    first = install_payload(payload, sha, home=home, system="Linux")
    second = install_payload(payload, sha, home=home, system="Linux")
    assert first == second
    assert (other / "registry.yaml").read_text() == "untouched"
    assert first["command"].startswith(str(home))


@pytest.mark.parametrize("bad", ["../escape.py", "/escape.py", "a/../../escape.py", "a\\escape.py"])
def test_unsafe_package_never_creates_installation(tmp_path, bad):
    payload, sha = package({bad: b"bad"})
    with pytest.raises(ValueError):
        install_payload(payload, sha, home=tmp_path, system="Linux")
    assert not (tmp_path / ".local").exists()


def test_failed_startup_does_not_replace_prior_launcher(tmp_path, monkeypatch):
    monkeypatch.setattr(loadout_install.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0))
    payload, sha = package()
    first = install_payload(payload, sha, home=tmp_path, system="Linux")
    from pathlib import Path

    launcher = Path(first["command"])
    before = launcher.read_bytes()
    monkeypatch.setattr(loadout_install.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=1))
    other_payload, other_sha = package({"skill_hub/infrastructure/loadout/loadout_feed.py": b"x"})
    with pytest.raises(ValueError, match="startup"):
        install_payload(other_payload, other_sha, home=tmp_path, system="Linux")
    assert launcher.read_bytes() == before


def test_existing_modified_release_is_not_executed(tmp_path, monkeypatch):
    monkeypatch.setattr(loadout_install.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0))
    payload, sha = package()
    install_payload(payload, sha, home=tmp_path, system="Linux")
    (tmp_path / ".local/share/skill-tree/receiver/releases" / sha / "hub.py").write_text("changed")
    monkeypatch.setattr(
        loadout_install.subprocess, "run", lambda *a, **k: pytest.fail("modified code must not execute")
    )
    with pytest.raises(ValueError, match="modified"):
        install_payload(payload, sha, home=tmp_path, system="Linux")


def test_unexpected_release_module_blocks_before_startup(tmp_path, monkeypatch):
    monkeypatch.setattr(loadout_install.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0))
    payload, sha = package()
    install_payload(payload, sha, home=tmp_path, system="Linux")
    (tmp_path / ".local/share/skill-tree/receiver/releases" / sha / "yaml.py").write_text("malicious")
    monkeypatch.setattr(loadout_install.subprocess, "run", lambda *a, **k: pytest.fail("unverified code must not run"))
    with pytest.raises(ValueError, match="unexpected"):
        install_payload(payload, sha, home=tmp_path, system="Linux")


def test_prepared_bundle_starts_in_isolated_receiver_home(tmp_data_home, receiver_code):
    payload, digest = loadout_install.package_receiver(receiver_code)
    home = tmp_data_home / "isolated-receiver-home"
    home.mkdir()
    receipt = install_payload(payload, digest, home=home, system="Linux")
    assert receipt["protocol"] == 1
    result = loadout_install.subprocess.run(
        [receipt["command"], "receive", "init", "--receiver-id", "fixture-box", "--json"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    import json

    inspected = loadout_install.subprocess.run(
        [receipt["command"], "receive", "inspect", "--json"], capture_output=True, text=True, timeout=30
    )
    assert inspected.returncode == 0, inspected.stderr
    assert json.loads(inspected.stdout)["result"]["native"]["schema"] == 2
    assert json.loads(result.stdout)["result"]["receiver_id"] == "fixture-box"
    release = home / ".local/share/skill-tree/receiver/releases" / digest
    render_check = """
from pathlib import Path
import sys

import hub
import tomlkit
import yaml
from skill_hub.infrastructure.harnesses import harness_native_executor as executor
from skill_hub.domain.loadout import loadout_native_codec

release = Path(hub.__file__).resolve().parent
vendor = release / "vendor"
assert sys.path[0] == str(vendor)
for module in (executor, loadout_native_codec):
    assert Path(module.__file__).resolve().parent.is_relative_to(release / "skill_hub")
for module in (tomlkit, yaml):
    assert Path(module.__file__).resolve().is_relative_to(vendor)

assert not executor.NATIVE_RECIPES
operations, files = loadout_native_codec.render_unit(
    {"scope": "project", "harness": "codex", "area": "permissions", "key": "project", "asset": "x"},
    {
        "version": 1,
        "allow": ["Bash(git status:*)"],
        "deny": [],
        "ask": [],
        "sandbox_mode": None,
        "approval_policy": None,
        "project_trust": None,
    },
    Path("/receiver/project"),
    Path("/receiver/home"),
    "main",
    {},
    context=loadout_native_codec.capture_loadout_codec_context(),
)
assert len(files) == 1
assert next(iter(files)).name == "skill-tree-project.rules"
assert operations[0].selector[-1] == "trust_level"
for name in (
    "skill_hub.domain.harnesses.harness_adapter_api",
    "skill_hub.infrastructure.harnesses.harness_bundled_hooks",
    "skill_hub.infrastructure.harnesses.harness_bundled_mcp",
    "skill_hub.infrastructure.harnesses.harness_bundled_permissions",
    "skill_hub.infrastructure.harnesses.harness_bundled_subagents",
    "skill_hub.domain.harnesses.harness_catalog",
    "skill_hub.infrastructure.loadout.loadout_native",
    "skill_hub.domain.loadout.loadout_profiles",
    "skill_hub.domain.permissions.permission_adapter_base",
):
    assert Path(sys.modules[name].__file__).resolve().parent.is_relative_to(release / "skill_hub")
"""
    render_script = release / "_fixture_render_check.py"
    render_script.write_text(render_check, encoding="utf-8")
    native = loadout_install.subprocess.run(
        [sys.executable, "-B", str(render_script)],
        cwd=release, capture_output=True, text=True, timeout=30,
    )
    assert native.returncode == 0, native.stderr
    assert not (home / ".skill-hub").exists()
    assert not list(home.rglob("registry.yaml"))


def test_package_generation_is_independent_of_wall_clock(receiver_code, monkeypatch):
    import gzip
    import time

    monkeypatch.setattr(time, "time", lambda: 1000000000)
    first, first_digest = loadout_install.package_receiver(receiver_code)
    monkeypatch.setattr(time, "time", lambda: 2000000000)
    second, second_digest = loadout_install.package_receiver(receiver_code)
    assert first == second and first_digest == second_digest
    assert first[4:8] == b"\0" * 4 and gzip.decompress(first)
