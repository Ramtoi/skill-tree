"""The private release signing dispatch must not publish or expose its key."""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
from pathlib import Path

import pytest
import yaml

WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/publish.yml"
CI_WORKFLOW = WORKFLOW.with_name("ci.yml")
PREFLIGHT = WORKFLOW.parents[2] / "scripts/preflight-publish.sh"


@pytest.fixture(scope="module")
def publish() -> dict:
    if not WORKFLOW.exists():
        pytest.skip("private publish workflow is absent from the public archive")
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def test_dispatch_routes_signing_away_from_publication(publish: dict) -> None:
    triggers = publish["on"] if "on" in publish else publish[True]
    dispatch = triggers["workflow_dispatch"]
    inputs = dispatch["inputs"]
    assert inputs["sign_asset_id"]["default"] == ""
    assert inputs["sign_asset_sha256"]["default"] == ""

    jobs = publish["jobs"]
    for name in ("source-mirror", "build-macos", "build-windows"):
        assert "(inputs.sign_asset_id == '' && inputs.sign_asset_sha256 == '')" in jobs[name]["if"]
    signing = jobs["sign-private-asset"]
    assert "(inputs.sign_asset_id != '' || inputs.sign_asset_sha256 != '')" in signing["if"]
    assert signing.get("needs") is None
    assert signing["runs-on"] == "ubicloud-standard-2"
    assert signing["environment"] == "Release to public"
    assert signing["permissions"] == {"contents": "write"}


def test_signing_secret_and_artifact_are_bounded(publish: dict) -> None:
    steps = publish["jobs"]["sign-private-asset"]["steps"]
    download, install, sign, upload = steps
    assert download["env"]["GH_TOKEN"] == "${{ github.token }}"
    assert "repos/${GITHUB_REPOSITORY}/releases/assets/${ASSET_ID}" in download["run"]
    assert "--ignore-scripts" in install["run"]
    assert "@tauri-apps/cli@2.11.2" in install["run"]
    assert "secrets." not in str(download) + str(install) + str(upload)
    assert sign["env"] == {
        "TAURI_SIGNING_PRIVATE_KEY": "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
        "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    }
    assert "signer sign" in sign["run"]
    assert "--private-key" not in sign["run"]
    assert "--password" not in sign["run"]
    assert upload["uses"] == "actions/upload-artifact@v4"
    assert upload["with"]["path"] == "${{ runner.temp }}/Skill-Tree.app.tar.gz.sig"
    assert upload["with"]["if-no-files-found"] == "error"


def test_mirror_and_preflight_install_ci_pinned_linters(publish: dict) -> None:
    ci = yaml.safe_load(CI_WORKFLOW.read_text(encoding="utf-8"))
    ci_install = next(
        step["run"] for step in ci["jobs"]["python"]["steps"]
        if step.get("name") == "Install dependencies"
    )
    pins = []
    for package in ("ruff", "mypy"):
        match = re.search(rf"\b{package}==\d+\.\d+\.\d+\b", ci_install)
        assert match is not None
        pins.append(match.group())
    expected = f"python3 -m pip install --quiet pytest {' '.join(pins)} -r requirements.txt"
    mirror = next(
        step["run"] for step in publish["jobs"]["source-mirror"]["steps"]
        if step.get("name", "").startswith("Mirror simulation")
    )
    assert expected in mirror
    assert expected in PREFLIGHT.read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("asset_id", "digest", "expected_calls", "expected_success"),
    [
        ("abc", "0" * 64, False, False),
        ("", "0" * 64, False, False),
        ("12/other", "0" * 64, False, False),
        ("12", "ABC" + "0" * 61, False, False),
        ("12", "0" * 63, False, False),
        ("12", "0" * 64, True, False),
        ("12", hashlib.sha256(b"payload").hexdigest(), True, True),
    ],
)
def test_download_fails_closed_before_signing(
    publish: dict,
    tmp_path: Path,
    asset_id: str,
    digest: str,
    expected_calls: bool,
    expected_success: bool,
) -> None:
    script = publish["jobs"]["sign-private-asset"]["steps"][0]["run"]
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    gh = bin_dir / "gh"
    gh.write_text(
        "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$RUNNER_TEMP/gh-called\"\n"
        "printf payload\n",
        encoding="utf-8",
    )
    gh.chmod(0o755)
    env = os.environ | {
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "RUNNER_TEMP": str(tmp_path),
        "GITHUB_REPOSITORY": "acme/app-private",
        "ASSET_ID": asset_id,
        "EXPECTED_SHA256": digest,
    }
    result = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True)
    assert (result.returncode == 0) is expected_success, result.stderr
    called = tmp_path / "gh-called"
    assert called.exists() is expected_calls
    if called.exists():
        assert f"repos/acme/app-private/releases/assets/{asset_id}" in called.read_text()
    assert (tmp_path / "Skill-Tree.app.tar.gz").exists() is expected_calls


def test_public_branch_triggers_ci(publish: dict) -> None:
    ci = yaml.safe_load(CI_WORKFLOW.read_text(encoding="utf-8"))
    triggers = ci.get("on", ci.get(True))
    assert {"main", "master"} <= set(triggers["push"]["branches"])


def test_snapshot_git_staging_preserves_registry_fixture(tmp_path) -> None:
    root = tmp_path / "snapshot"
    root.mkdir()
    (root / ".gitignore").write_text((WORKFLOW.parents[2] / ".gitignore").read_text())
    fixture = root / "app/src/test/fixtures/registry.yaml"
    fixture.parent.mkdir(parents=True)
    fixture.write_text("skills: {}\n")
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    tracked = subprocess.check_output(["git", "ls-files"], cwd=root, text=True)
    assert "app/src/test/fixtures/registry.yaml" in tracked.splitlines()
