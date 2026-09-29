"""Symlink management for sync: create, own, and sweep hub-written links.

Cut verbatim out of hub.py (wave 23a of AUDIT.md). A leaf: at module scope it
imports hub_core and `sources._is_under` only, never hub or skill_hub.entrypoints.cli. hub.py
re-imports every name so `hub.<name>` keeps resolving.

`data_home`, `code_home` and `LEGACY_DATA_HOMES` are read as
`hub_core.<name>` at call time, never copied by value: tests rebind them
through `hub.<name>` (`tests/conftest.py`, `tests/test_migrate_home.py`) and
the `_HubFacade` forwards that write to hub_core — a by-value copy here would
freeze the import-time value.

Stub visibility: a call from one function here to another resolves through
this module, so `monkeypatch.setattr(hub, "<name>", …)` no longer reaches it
(`remove_symlink` / `remove_unmanaged_entries` → `is_hub_owned_link`,
`ensure_symlink` / `remove_unmanaged_entries` → `backup_path_for`,
`is_hub_owned_link` → `link_target_abs` / `hub_owned_link_roots`). No test
stubs any of these today; one that needs to patches `sync_links.<name>`.
"""

import os
from pathlib import Path
from typing import Optional

from skill_hub import hub_core
from skill_hub.hub_core import DIM, GREEN, RED, YELLOW, c
from skill_hub.infrastructure.registry.sources import _is_under

# ─────────────────────────────────────────────────────────────────────────────
# Symlink management
# ─────────────────────────────────────────────────────────────────────────────


def backup_path_for(link: Path) -> Path:
    backup_root = link.parent.parent / "_hub-backups" / link.parent.name
    backup_root.mkdir(parents=True, exist_ok=True)
    backup = backup_root / link.name
    if not backup.exists():
        return backup

    i = 1
    while True:
        candidate = backup_root / f"{link.name}.{i}"
        if not candidate.exists():
            return candidate
        i += 1


def _without_windows_extended_prefix(path: Path) -> Path:
    """Return the ordinary spelling of a recognized Windows extended path."""
    raw = os.fspath(path)
    if not isinstance(raw, str):
        return path
    folded = raw.lower()
    unc_prefix = "\\\\?\\unc\\"
    if folded.startswith(unc_prefix):
        return Path(r"\\" + raw[len(unc_prefix) :])
    dos_prefix = "\\\\?\\"
    if folded.startswith(dos_prefix):
        ordinary = raw[len(dos_prefix) :]
        if (
            len(ordinary) >= 3
            and ordinary[0].isalpha()
            and ordinary[1] == ":"
            and ordinary[2] in "\\/"
        ):
            return Path(ordinary)
    return path


def _is_under_owned_root(child: Path, parent: Path) -> bool:
    """Containment check that equates Windows extended and ordinary paths."""
    if os.name != "nt":
        return _is_under(child, parent)
    child_resolved = _without_windows_extended_prefix(child.resolve(strict=False))
    parent_resolved = _without_windows_extended_prefix(parent.resolve(strict=False))
    try:
        child_resolved.relative_to(parent_resolved)
    except ValueError:
        return False
    return True


def ensure_symlink(link: Path, target: Path) -> bool:
    """Create or update symlink at link pointing to target.

    Returns True when a link was created or changed, False when it was already
    correct (used by the sync-report writer to count real writes).
    """
    if link.is_symlink():
        if link.resolve() == target.resolve():
            return False  # already correct
        link.unlink()
    elif link.exists():
        # Real file/dir — don't silently overwrite; move outside scanned skill dirs
        backup = backup_path_for(link)
        link.rename(backup)
        print(f"  {c('→', YELLOW)} backed up {link.name} to {backup}")

    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(target)
    print(f"  {c('✓', GREEN)} {link} → {target}")
    return True


def link_target_abs(link: Path) -> Optional[str]:
    """The symlink's OWN target, absolutized against its parent.

    Read with `os.readlink`, so a chain of links is not collapsed at this step:
    ownership is about the target this link names, not the file the chain ends
    at. (`is_hub_owned_link` does resolve that target when comparing homes, so
    symlinked home paths — `/tmp` → `/private/tmp` — still compare equal.)
    """
    try:
        target = os.readlink(link)
    except OSError:
        return None
    if not os.path.isabs(target):
        target = str(link.parent / target)
    return os.path.normpath(target)


HUB_LINKED_SUBTREES = (
    "skills",  # the library
    "mcp-servers",
    "sources",  # external source checkouts (managed: external)
    os.path.join("state", "skill_variants"),  # generated rename/invocation variants
)


def hub_owned_link_roots() -> list[Path]:
    """Every subtree a link hub wrote may point into, for this user's installs.

    Deliberately the MANAGED subtrees, not a whole home: a user's own link that
    happens to live inside the data home (`<data>/external/…`) is not hub's to
    delete. Covered here:

    * this install's data home — library, MCP servers, source checkouts, and the
      generated variant dirs a renamed / invocation-overridden skill links to,
    * its code home — starter assets shipped with the app,
    * legacy + `$SKILL_HUB_DIR` data homes — a link planted before
      `hub migrate-home` is still this user's hub and must stay SWEEPABLE,
      otherwise the ownership gate would strand it forever (F4).
    """
    homes: list[Path] = [hub_core.data_home()]
    for legacy in hub_core.LEGACY_DATA_HOMES:
        homes.append(legacy)
    dir_env = os.environ.get("SKILL_HUB_DIR", "").strip()
    if dir_env:
        try:
            homes.append(Path(dir_env).expanduser())
        except (OSError, ValueError):
            pass
    try:
        homes.append(hub_core.code_home())
    except Exception:  # code home is unresolvable in exotic layouts — skip it
        pass

    roots: list[Path] = []
    for home in homes:
        for sub in HUB_LINKED_SUBTREES:
            roots.append(home / sub)
    return roots


def is_hub_owned_link(link: Path) -> bool:
    """Ownership gate every symlink-cleanup path must pass before unlinking.

    A link hub wrote points inside one of `hub_owned_link_roots()`. A link into
    ANOTHER data home — the real `~/.skill-hub` while a test, a script, or a
    reviewer runs under a scratch `SKILL_HUB_HOME` — belongs to that other
    install, and a sweep that unlinks it silently destroys the user's real
    setup. That has happened three times; this is the guard, applied to every
    sweep that walks a shared skills dir.

    Not a symlink, unreadable, or pointing anywhere else ⇒ NOT ours ⇒ leave it.
    """
    if not link.is_symlink():
        return False
    target = link_target_abs(link)
    if target is None:
        return False
    tp = Path(target)
    for root in hub_owned_link_roots():
        try:
            if _is_under_owned_root(tp, root):
                return True
        except (OSError, ValueError):
            continue
    return False


def remove_symlink(link: Path) -> bool:
    """Unlink one hub-managed link. Returns False when it was left in place
    because another install owns it — callers report that as a partial result
    instead of claiming a clean removal."""
    if not link.is_symlink():
        return True
    if not is_hub_owned_link(link):
        print(
            f"  {c('·', DIM)} left in place (not this install's): {link} → "
            f"{link_target_abs(link)}"
        )
        return False
    link.unlink()
    print(f"  {c('✗', RED)} removed {link}")
    return True


def _warn_links_left_in_place(results: list) -> None:
    """Say so when a link survived because another install owns it — the verb
    succeeded, but not everywhere it claims to reach."""
    left = sum(1 for ok in results if not ok)
    if left:
        print(
            f"  {c('!', YELLOW)} {left} link(s) left in place: they point into "
            f"another Skill Hub data home, so this install must not remove them"
        )


def remove_unmanaged_entries(
    skills_dir: Path, expected_names: set[str], label: str
) -> tuple[int, int]:
    """Remove stale hub-owned links (and move aside foreign entries).

    Returns `(removed, skipped_unowned)` — the first feeds the sync report's
    `removed` counter, the second makes an orphan this install may NOT reclaim
    visible instead of leaving it as one dim log line (F4).

    Only links THIS install owns (`is_hub_owned_link`) are removed: a global
    skills dir is shared with every other hub install on the machine, so a link
    into a different data home is somebody else's and is left alone.
    """
    if not skills_dir.exists() or skills_dir.is_symlink():
        return 0, 0

    removed = 0
    skipped_unowned = 0
    for entry in skills_dir.iterdir():
        if entry.name in expected_names or entry.name == "_hub-backups":
            continue

        if entry.is_symlink():
            if not is_hub_owned_link(entry):
                skipped_unowned += 1
                print(
                    f"  {c('·', DIM)} skipped unowned {label}: {entry.name} → "
                    f"{link_target_abs(entry)}"
                )
                continue
            entry.unlink()
            removed += 1
            print(f"  {c('✗', RED)} removed stale {label}: {entry.name}")
        else:
            backup = backup_path_for(entry)
            entry.rename(backup)
            removed += 1
            print(
                f"  {c('→', YELLOW)} moved unmanaged {label}: {entry.name} → {backup}"
            )
    return removed, skipped_unowned
