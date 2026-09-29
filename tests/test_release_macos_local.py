"""Verify external release signatures before producing an updater manifest."""
from __future__ import annotations

import base64
import json
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/release-macos-local.sh"
pytestmark = pytest.mark.skipif(
    not SCRIPT.exists() or shutil.which("minisign") is None,
    reason="private release tooling and minisign are required",
)


def test_external_signature_gates_manifest(tmp_path):
    root = tmp_path / "checkout"
    (root / "scripts").mkdir(parents=True)
    (root / "app/src-tauri").mkdir(parents=True)
    shutil.copyfile(SCRIPT, root / "scripts/release-macos-local.sh")
    (root / "VERSION").write_text("1.0.0\n")
    out = root / "dist-macos"
    out.mkdir()
    payload = out / "Skill-Tree.app.tar.gz"
    payload.write_bytes(b"test release payload")
    (out / "SkillTree-macos.zip").write_bytes(b"test manual installer")
    # Disposable test keys never replace or read a release key.
    public, private = tmp_path / "test.pub", tmp_path / "test.key"
    subprocess.run(["minisign", "-G", "-W", "-p", str(public), "-s", str(private)], check=True, capture_output=True)
    subprocess.run(["minisign", "-S", "-s", str(private), "-m", str(payload)], check=True, capture_output=True)
    config = {"plugins": {"updater": {"pubkey": base64.b64encode(public.read_bytes()).decode()}}}
    (root / "app/src-tauri/tauri.conf.json").write_text(json.dumps(config))
    signature = tmp_path / "returned.sig"
    signature.write_bytes(base64.b64encode(Path(str(payload) + ".minisig").read_bytes()))
    command = ["bash", str(root / "scripts/release-macos-local.sh"), "--complete-signing", str(signature)]

    payload.write_bytes(b"changed after signing")
    bad = subprocess.run(command, capture_output=True, text=True)
    assert bad.returncode != 0
    assert not (out / "latest.json").exists()
    assert not (out / "Skill-Tree.app.tar.gz.sig").exists()

    payload.write_bytes(b"test release payload")
    good = subprocess.run(command, capture_output=True, text=True)
    assert good.returncode == 0, good.stdout + good.stderr
    manifest = json.loads((out / "latest.json").read_text())
    assert manifest["version"] == "1.0.0"
    assert set(manifest["platforms"]) == {"darwin-aarch64", "darwin-x86_64"}
    for platform in manifest["platforms"].values():
        assert platform["signature"] == signature.read_text()
        assert platform["url"] == "https://github.com/Ramtoi/skill-tree/releases/download/v1.0.0/Skill-Tree.app.tar.gz"
    assert payload.read_bytes() == b"test release payload"
