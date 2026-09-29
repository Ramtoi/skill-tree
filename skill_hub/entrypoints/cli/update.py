"""`hub update` — app/CLI self-update check + a skill's upstream check.

`hub update` (bare) checks the app/CLI against the latest GitHub Release and,
for a standalone install, can apply it in place. `hub update <skill>` instead
reports a skill's configured upstream (a stub — no auto-check yet).

Carved out of `hub.py` (S5 slice E) — see `hub_cli/__init__.py` for the
module contract this file implements (`NAME`, `register`, `dispatch`).
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

# `code_home`/`hub_version`/`load_registry` are called through the `hub_core.`
# module attribute (`hub_core.code_home()`, not a value-imported name) because
# a value import snapshots the function object at module-load time: a test's
# `monkeypatch.setattr(hub, "code_home", ...)` forwards through the
# `_HubFacade` to rebind `hub_core.code_home` itself (see hub.py's
# `_HubFacade`), and a call site that already captured the original object
# would never see that rebind. Attribute access re-resolves on every call, so
# it always observes the current (possibly patched) binding. The colours and
# `c` imported below by value are names no test patches on `hub`.
from skill_hub import hub_core
from skill_hub.hub_core import (
    BOLD,
    DIM,
    GREEN,
    c,
)

NAME = "update"

p_update = None


def register(sub) -> None:
    global p_update

    # update
    p_update = sub.add_parser(
        "update", help="Check for app/CLI updates (or a skill's upstream)"
    )
    p_update.add_argument(
        "skill", nargs="?", help="Check a specific skill's upstream instead of the app/CLI"
    )
    p_update.add_argument(
        "--check", action="store_true", help="Report only (default behavior)"
    )
    p_update.add_argument(
        "--apply",
        action="store_true",
        help="Apply the update in place (standalone CLI installs only)",
    )
    p_update.add_argument("--json", action="store_true", help="Emit JSON")


def dispatch(args) -> None:
    cmd_update(args)


# ─────────────────────────────────────────────────────────────────────────────
# hub skill metadata / update checks
# ─────────────────────────────────────────────────────────────────────────────


def cmd_update(args):
    # `hub update <skill>` keeps the legacy per-skill upstream check; bare
    # `hub update` self-checks the app/CLI against the latest GitHub Release.
    if getattr(args, "skill", None):
        return _cmd_update_skill(args.skill)
    return _cmd_update_self(args)


def _cmd_update_skill(target: str):
    registry = hub_core.load_registry()
    cfg = registry.get("skills", {}).get(target)
    if cfg is None:
        print(f"No skill named '{target}'.")
        return
    upstream = cfg.get("upstream")
    if not upstream:
        print(f"'{target}' has no upstream configured.")
        return
    print(f"Checking {target} upstream: {upstream}")
    print(f"  upstream: {upstream}")
    print(f"  current:  v{cfg.get('version', '?')}")
    print("  (auto-check not yet implemented — visit upstream manually)")


def _fetch_latest_release() -> dict:
    """GET the latest GitHub Release on the public mirror. Raises on failure."""
    import urllib.request

    import hub

    req = urllib.request.Request(
        hub.GITHUB_API_LATEST,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "skill-hub-updater",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _code_home_kind() -> str:
    """Classify where the CLI source lives, to give honest update guidance:
      'bundle'     — inside Skill Tree.app (Contents/Resources/hub); app owns it
      'git'        — a git checkout; `git pull` updates it
      'standalone' — a plain writable dir; `hub update --apply` can swap it
    """
    home = hub_core.code_home().resolve()
    parts = home.parts
    if "Contents" in parts and "Resources" in parts:
        return "bundle"
    if (home / ".git").exists() or any((p / ".git").exists() for p in home.parents):
        return "git"
    return "standalone"


def _safe_extract(tar, dest: Path):
    """Path-traversal-safe extractall (uses the 'data' filter on 3.12+)."""
    dest = dest.resolve()
    try:
        tar.extractall(dest, filter="data")  # hardened on Python 3.12+
        return
    except TypeError:
        pass
    for member in tar.getmembers():
        target = (dest / member.name).resolve()
        if not str(target).startswith(str(dest) + os.sep) and target != dest:
            raise RuntimeError(f"Unsafe path in archive: {member.name}")
    tar.extractall(dest)


def _apply_self_update(release: dict, latest: str):
    """Standalone-only: download the release source tarball and swap code_home
    in place, after a timestamped backup."""
    import tarfile
    import urllib.request

    import hub

    tarball = release.get("tarball_url") or (
        f"https://github.com/{hub.GITHUB_REPO}/archive/refs/tags/v{latest}.tar.gz"
    )
    home = hub_core.code_home().resolve()
    print(f"Downloading {tarball} …")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        archive = tdp / "src.tar.gz"
        req = urllib.request.Request(
            tarball, headers={"User-Agent": "skill-hub-updater"}
        )
        with urllib.request.urlopen(req, timeout=60) as resp, open(archive, "wb") as f:
            shutil.copyfileobj(resp, f)
        extract_root = tdp / "extract"
        extract_root.mkdir()
        with tarfile.open(archive) as tar:
            _safe_extract(tar, extract_root)
        entries = list(extract_root.iterdir())
        srcdir = entries[0] if len(entries) == 1 and entries[0].is_dir() else extract_root

        stamp = _dt.datetime.now().strftime("%Y%m%d%H%M%S")
        backup = home.parent / f"{home.name}.bak-{stamp}"
        print(f"Backing up current install → {backup}")
        shutil.copytree(home, backup)
        for item in srcdir.iterdir():
            dest = home / item.name
            if item.is_dir():
                if dest.exists():
                    shutil.rmtree(dest)
                shutil.copytree(item, dest)
            else:
                shutil.copy2(item, dest)
    print(f"Updated to v{latest}. Backup at {backup}.")


def _cmd_update_self(args):
    import hub

    current = hub_core.hub_version()
    as_json = getattr(args, "json", False)
    do_apply = getattr(args, "apply", False)

    try:
        release = _fetch_latest_release()
    except Exception as e:
        if as_json:
            print(json.dumps({"error": str(e), "current": current}))
        else:
            print(f"Could not reach GitHub to check for updates: {e}")
        sys.exit(1)

    latest = str(release.get("tag_name", "")).lstrip("v") or "0.0.0"
    url = release.get("html_url") or hub.GITHUB_RELEASES_URL
    newer = hub._version_tuple(latest) > hub._version_tuple(current)
    kind = _code_home_kind()

    if as_json:
        print(
            json.dumps(
                {
                    "current": current,
                    "latest": latest,
                    "update_available": newer,
                    "release_url": url,
                    "install_kind": kind,
                    "code_home": str(hub_core.code_home()),
                }
            )
        )
    else:
        print(f"\n{c('Skill Tree', BOLD)} {c('v' + current, DIM)}")
        if not newer:
            print(f"You're on the latest version (latest release: v{latest}).")
            return
        print(f"{c('Update available:', BOLD)} v{current} → {c('v' + latest, GREEN)}")
        print(f"  {url}")

    if not newer:
        return

    # Guidance / apply, by install shape.
    if kind == "bundle":
        if not as_json:
            print("\nThis CLI is bundled inside Skill Tree.app.")
            print("Update the app — its built-in updater ships this CLI too.")
        return
    if kind == "git":
        if not as_json:
            print("\nThis is a git checkout. Update with:")
            print(f"  git -C {hub_core.code_home()} pull")
        return

    # standalone
    if not do_apply:
        if not as_json:
            print("\nStandalone install. Apply the update in place with:")
            print("  hub update --apply")
        return
    _apply_self_update(release, latest)
