"""Backup-side internal-reference materialization (D2 follow-up).

A safe internal symlink (its target resolves, hop by hop, to a regular file
inside an allowed data section) is now materialized as a REGULAR FILE inside
the snapshot at assembly time, before signing — so its placement and content
travel under the existing tree digest and SSHSIG, with no schema change. An
unsafe one is rejected with a warning, same as any other bad symlink shape
`_copy_dir` already refused. A symlink outside the reference sections (e.g.
under `hooks/`) is untouched: still copied AS a link, unresolved.

`tests/test_restore.py` covers the restore-side legacy case (a symlink that
survives into an already-signed snapshot) and the shared resolver's
adversarial parametrization (`test_reference_resolution_rejects_unsafe_targets`).
This file is the backup-time half of the same contract.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import hub
from skill_hub.application.backup import backup, references


def _write_skill(data_home: Path, name: str, body: str = "body\n") -> Path:
    d = data_home / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        "---\nname: {0}\ndescription: seeded\n---\n{1}".format(name, body)
    )
    return d


def test_backup_materializes_safe_internal_reference_before_signing(tmp_data_home, tmp_path):
    _write_skill(tmp_data_home, "alpha")
    beta = _write_skill(tmp_data_home, "beta")
    target_bytes = (beta / "SKILL.md").read_bytes()
    link = tmp_data_home / "skills" / "alpha" / "criteria.md"
    link.symlink_to("../beta/SKILL.md")
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})

    dest = tmp_path / "snap"
    summary = backup.assemble_snapshot(dest)

    written = dest / "skills" / "alpha" / "criteria.md"
    assert written.is_file()
    assert not written.is_symlink()
    assert written.read_bytes() == target_bytes

    # Placement AND content are now ordinary attested manifest entries — no
    # separate provenance list, no schema bump.
    assert "skills/alpha/criteria.md" in summary["manifest"]["files"]
    assert backup.verify_tree_digest(dest)["ok"] is True
    assert summary["signed"] is True
    assert backup.verify_snapshot_signature(dest)["state"] == backup.SIG_SIGNED
    assert not any("criteria.md" in w for w in summary["warnings"])


def test_backup_preserves_symlink_outside_reference_sections(tmp_data_home, tmp_path):
    """`hooks/` is backed up (`backup.DATA_HOME_PORTABLE`) but is not one of
    `references.REFERENCE_SECTIONS` — a symlink there keeps the OLD behavior:
    copied as a link, unresolved. Exercises `_copy_dir` directly so the test
    does not depend on `hooks/`'s real internal shape."""
    root = tmp_data_home / "hooks"
    root.mkdir(parents=True)
    (root / "real.sh").write_text("#!/bin/sh\necho hi\n")
    (root / "link.sh").symlink_to("real.sh")

    dest = tmp_path / "snap" / "hooks"
    warnings: list = []
    backup._copy_dir(
        root, dest, allowed_root=tmp_data_home, warnings=warnings, nested_git=[], rel="hooks"
    )

    assert (dest / "link.sh").is_symlink()
    assert not warnings


@pytest.mark.parametrize(
    "kind",
    ["absolute", "cycle", "dangling", "directory", "outside-section", "chain-escape"],
)
def test_backup_rejects_unsafe_reference_targets(tmp_data_home, tmp_path, kind):
    alpha = _write_skill(tmp_data_home, "alpha")
    (alpha / "valid.md").write_text("safe\n")
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})

    target = {
        "absolute": str(alpha / "valid.md"),
        "cycle": "reference.md",
        "dangling": "missing.md",
        "directory": ".",
        "outside-section": "../../registry.yaml",
        "chain-escape": "second.md",
    }[kind]
    (alpha / "reference.md").symlink_to(target)
    if kind == "chain-escape":
        (alpha / "second.md").symlink_to("../../registry.yaml")

    dest = tmp_path / "snap"
    summary = backup.assemble_snapshot(dest)

    assert not (dest / "skills" / "alpha" / "reference.md").exists()
    assert any(
        "reference.md" in w and ("internal reference" in w or "outside the data home" in w)
        for w in summary["warnings"]
    )
    # A rejected reference does not stop the snapshot from being built and
    # signed — it is reported, not fatal.
    assert summary["signed"] is True


def test_backup_reference_resolver_matches_restore_data_dirs():
    """`references.REFERENCE_SECTIONS` and `restore.DATA_DIRS` name the exact
    same four sections — divergence here would silently change what backup
    materializes versus what restore is willing to validate."""
    from skill_hub.application.backup import restore

    assert references.REFERENCE_SECTIONS == restore.DATA_DIRS
