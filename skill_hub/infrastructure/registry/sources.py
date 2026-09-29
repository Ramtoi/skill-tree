"""External skill sources: registry data model, ownership inference, status,
disabled-source filtering, linked-bundle reconciliation. Wave 18b added the
git-source discovery block (`parse_git_url` … `_git_clone`) from
`hub_cli/source.py`; `_candidate_for_dir` imports `import_scanner._parse_skill_md`
inside the function because a module-scope import would cycle through
`sync_links`.

Cut verbatim out of hub.py (wave 18a of AUDIT.md). A leaf: at module scope it
imports hub_core and skill_meta only, never hub or skill_hub.entrypoints.cli. hub.py re-imports
every name so `hub.<name>` keeps resolving.

Stub visibility: a call from one function here to another resolves through
this module, so `monkeypatch.setattr(hub, "<name>", …)` no longer reaches it;
a test that needs to stub such an inner call patches `sources.<name>`.
"""

import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional

from skill_hub import hub_core
from skill_hub.domain.skills.skill_meta import hub_skills_dir
from skill_hub.hub_core import SLUG_RE, YELLOW, _run_git, c

# ─────────────────────────────────────────────────────────────────────────────
# External skill sources (openspec change: add-external-skill-sources)
#
# A "source" is the origin of one or more skills:
#   - local:   user-authored skills under <data_home>/skills/        (built-in)
#   - starter: starter pack skills under <code_home>/skills/         (built-in, read-only)
#   - git:     skills imported from a Git repository, cached under
#              <data_home>/sources/<source-id>/worktree/
#   - litellm: reserved for future LiteLLM Skills Gateway connector
#
# §1 implements the registry data model, ownership inference, and the
# read-only `hub source list` / `hub source status` commands. Git add/sync/
# remove operations are added in later sections of the change.
# ─────────────────────────────────────────────────────────────────────────────

SOURCE_TYPES = {"local", "starter", "git", "litellm"}
BUILT_IN_SOURCE_IDS = {"local", "starter"}

SOURCE_STATUS_LOCAL = "local"
SOURCE_STATUS_BUNDLED = "bundled"
SOURCE_STATUS_UNKNOWN = "unknown"
SOURCE_STATUS_UP_TO_DATE = "up-to-date"
SOURCE_STATUS_UPDATE_AVAILABLE = "update-available"
SOURCE_STATUS_SYNCING = "syncing"
SOURCE_STATUS_ERROR = "error"

VALID_SOURCE_STATUSES = {
    SOURCE_STATUS_LOCAL,
    SOURCE_STATUS_BUNDLED,
    SOURCE_STATUS_UNKNOWN,
    SOURCE_STATUS_UP_TO_DATE,
    SOURCE_STATUS_UPDATE_AVAILABLE,
    SOURCE_STATUS_SYNCING,
    SOURCE_STATUS_ERROR,
}


def sources_dir() -> Path:
    """Where external source clones/checkouts live (under data home)."""
    return hub_core.data_home() / "sources"


def source_cache_dir(source_id: str) -> Path:
    """Per-source cache root: <data_home>/sources/<id>/."""
    return sources_dir() / source_id


def source_worktree_dir(source_id: str) -> Path:
    """Per-source Git worktree path used as the cache backing store."""
    return source_cache_dir(source_id) / "worktree"


def validate_source_id(source_id: str) -> None:
    """Validate a source id slug. Exit with a friendly error on failure."""
    if not isinstance(source_id, str) or not source_id:
        hub_core.fail("source id must be a non-empty string")
    if not SLUG_RE.match(source_id):
        hub_core.fail(
            f"Invalid source id '{source_id}'. "
            "Use lowercase letters, numbers, and hyphens only."
        )
    if source_id in BUILT_IN_SOURCE_IDS:
        hub_core.fail(
            f"Source id '{source_id}' is reserved for the built-in {source_id} source."
        )


def normalize_subpath_within(base: Path, rel: str) -> Path:
    """Resolve `rel` against `base` and guarantee the result stays inside `base`.

    Used for: Git --path subdirectories, discovered candidate paths, copy
    destinations, and cache paths. Rejects absolute paths, `..` traversal, and
    any path whose resolved location escapes the intended root.

    Returns the absolute resolved path. Raises ValueError on rejection.
    """
    if rel is None:
        rel = ""
    if not isinstance(rel, str):
        raise ValueError("path must be a string")
    cleaned = rel.strip()
    if cleaned.startswith("/") or (len(cleaned) > 1 and cleaned[1] == ":"):
        # Absolute POSIX or Windows-style path: rejected unconditionally.
        raise ValueError(f"absolute path not allowed: '{rel}'")
    cleaned = cleaned.lstrip("/")
    if not cleaned or cleaned == ".":
        return base.resolve(strict=False)
    candidate = (base / cleaned).resolve(strict=False)
    base_resolved = base.resolve(strict=False)
    try:
        candidate.relative_to(base_resolved)
    except ValueError as exc:
        raise ValueError(f"path '{rel}' resolves outside {base_resolved}") from exc
    return candidate


def _starter_skills_root() -> Path:
    """Code-home starter skills root (read-only, bundled with the app)."""
    return hub_core.code_home() / "skills"


def _is_under(child: Path, parent: Path) -> bool:
    try:
        child.resolve(strict=False).relative_to(parent.resolve(strict=False))
    except ValueError:
        return False
    return True


def infer_skill_ownership(name: str, skill_cfg: dict) -> dict:
    """Resolve which source owns a skill.

    Precedence:
      1. Explicit `managed: external` + `origin.source` → external source id.
      2. Explicit `managed: starter`                     → starter.
      3. Explicit `managed: local`                       → local.
      4. Implicit: source path under data-home skills    → local.
      5. Implicit: source path under code-home skills    → starter.
      6. Anything else                                   → local (conservative + warning).

    Returns: ``{"source_id": str, "managed": str, "warning": Optional[str]}``.
    """
    managed = skill_cfg.get("managed") if isinstance(skill_cfg, dict) else None
    origin = skill_cfg.get("origin") if isinstance(skill_cfg, dict) else None
    if not isinstance(origin, dict):
        origin = {}

    if isinstance(managed, str):
        if managed == "external":
            sid = origin.get("source")
            if isinstance(sid, str) and sid:
                return {"source_id": sid, "managed": "external", "warning": None}
            return {
                "source_id": "unknown",
                "managed": "external",
                "warning": f"skill '{name}' is managed: external but has no origin.source",
            }
        if managed == "starter":
            return {"source_id": "starter", "managed": "starter", "warning": None}
        if managed == "local":
            return {"source_id": "local", "managed": "local", "warning": None}

    raw_source = skill_cfg.get("source") if isinstance(skill_cfg, dict) else None
    if not raw_source:
        return {
            "source_id": "local",
            "managed": "local",
            "warning": f"skill '{name}' has no source path; assuming local",
        }
    try:
        src_path = Path(str(raw_source)).expanduser()
    except (OSError, ValueError):
        return {
            "source_id": "local",
            "managed": "local",
            "warning": f"skill '{name}': unresolvable source path '{raw_source}'",
        }

    if _is_under(src_path, hub_skills_dir()):
        return {"source_id": "local", "managed": "local", "warning": None}
    if _is_under(src_path, _starter_skills_root()):
        return {"source_id": "starter", "managed": "starter", "warning": None}

    return {
        "source_id": "local",
        "managed": "local",
        "warning": (
            f"skill '{name}' source '{raw_source}' is outside data-home and code-home; "
            "classified as local (conservative)"
        ),
    }


# One-shot-per-source complaint about a malformed `enabled:` value (reset by the
# test fixtures), so a sync that walks N projects logs the warning once.
_SOURCE_ENABLED_WARNED: set[str] = set()


def source_enabled(cfg: dict) -> bool:
    """A configured source is enabled unless it carries an explicit `enabled: false`.

    ONLY a literal `False` switches a source off. A malformed value (`enabled:
    "no"`) is read as enabled — being fail-open here means a typo can never
    silently unsync a whole library; `disabled_source_ids` warns about it and
    `validate_sources_registry` reports it.
    """
    return not (isinstance(cfg, dict) and cfg.get("enabled") is False)


def disabled_source_ids(registry: dict) -> set[str]:
    """Ids of configured sources switched off with `enabled: false`.

    Built-ins (local / starter) are not registry entries and can never be off.
    """
    sources = registry.get("sources") if isinstance(registry, dict) else None
    if not isinstance(sources, dict):
        return set()
    out: set[str] = set()
    for sid, cfg in sources.items():
        if sid in BUILT_IN_SOURCE_IDS:
            continue
        raw = cfg.get("enabled") if isinstance(cfg, dict) else None
        if raw is not None and not isinstance(raw, bool):
            if sid not in _SOURCE_ENABLED_WARNED:
                _SOURCE_ENABLED_WARNED.add(sid)
                # stderr: this runs inside `--json` paths (remote diff) too.
                print(
                    f"{c('!', YELLOW)} source '{sid}': enabled must be true or "
                    f"false (got {raw!r}) — treating the source as enabled",
                    file=sys.stderr,
                )
        if not source_enabled(cfg):
            out.add(sid)
    return out


def skills_from_disabled_sources(registry: dict) -> dict[str, str]:
    """Map `skill name -> disabled source id` for every skill a disabled source owns.

    A disabled source keeps its skills in the registry (and in every bundle /
    project that equips them); what changes is that each sync pass treats them as
    inactive. This one map is the shared filter for all of those passes, and its
    values double as the "source disabled: <skill> (<source>)" skip log.
    """
    disabled = disabled_source_ids(registry)
    if not disabled:
        return {}
    skills = registry.get("skills") if isinstance(registry, dict) else None
    if not isinstance(skills, dict):
        return {}
    out: dict[str, str] = {}
    for name, cfg in skills.items():
        if not isinstance(cfg, dict):
            continue
        sid = infer_skill_ownership(name, cfg)["source_id"]
        if sid in disabled:
            out[name] = sid
    return out


def source_include_names(cfg: dict) -> Optional[list[str]]:
    """The source's ``include:`` filter as a clean name list, or None.

    None means "follow upstream fully" — for an ABSENT field and for a
    malformed one, so a hand-edited registry degrades to the permissive
    (pre-filter) behavior instead of silently excluding everything.

    A present, well-formed EMPTY list is a real filter, not an absent one: it
    means "no new upstream skill follows this source". Collapsing it to None
    would re-import exactly the skills the user declined at add time.
    """
    raw = cfg.get("include") if isinstance(cfg, dict) else None
    if not isinstance(raw, list):
        return None
    names: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            return None
        cleaned = item.strip()
        if not cleaned:
            return None
        names.append(cleaned)
    return names


def _git_source_view(source_id: str, cfg: dict) -> dict:
    """Public-facing dict for a configured git source, filling sensible defaults."""
    return {
        "id": source_id,
        "type": "git",
        "name": cfg.get("name") or source_id,
        "url": cfg.get("url"),
        "branch": cfg.get("branch"),
        "path": cfg.get("path") or "",
        "include": source_include_names(cfg),
        "auth": cfg.get("auth") or "system-git",
        "cache": cfg.get("cache") or str(source_worktree_dir(source_id)),
        "current_ref": cfg.get("current_ref"),
        "remote_ref": cfg.get("remote_ref"),
        "status": cfg.get("status") or SOURCE_STATUS_UNKNOWN,
        "last_checked_at": cfg.get("last_checked_at"),
        "last_synced_at": cfg.get("last_synced_at"),
        "error": cfg.get("error"),
        "enabled": source_enabled(cfg),
        "builtin": False,
    }


def builtin_source_entries() -> dict:
    """Built-in source definitions surfaced alongside configured sources."""
    return {
        "local": {
            "id": "local",
            "type": "local",
            "name": "Local",
            "builtin": True,
            "enabled": True,
            "status": SOURCE_STATUS_LOCAL,
        },
        "starter": {
            "id": "starter",
            "type": "starter",
            "name": "Starter Pack",
            "builtin": True,
            "enabled": True,
            "status": SOURCE_STATUS_BUNDLED,
        },
    }


def list_sources(registry: dict) -> list[dict]:
    """Enumerate sources (built-ins + configured) with imported-skill counts."""
    skills = registry.get("skills") if isinstance(registry, dict) else None
    if not isinstance(skills, dict):
        skills = {}

    counts: dict[str, int] = {}
    for skill_name, cfg in skills.items():
        if not isinstance(cfg, dict):
            continue
        info = infer_skill_ownership(skill_name, cfg)
        counts[info["source_id"]] = counts.get(info["source_id"], 0) + 1

    out: list[dict] = []
    for sid, entry in builtin_source_entries().items():
        item = dict(entry)
        item["skill_count"] = counts.get(sid, 0)
        out.append(item)

    cfg_sources = registry.get("sources") if isinstance(registry, dict) else None
    if isinstance(cfg_sources, dict):
        for sid, scfg in cfg_sources.items():
            if not isinstance(scfg, dict):
                continue
            stype = scfg.get("type") or "git"
            if stype == "git":
                entry = _git_source_view(sid, scfg)
            elif stype == "litellm":
                entry = {
                    "id": sid,
                    "type": "litellm",
                    "name": scfg.get("name") or sid,
                    "status": SOURCE_STATUS_UNKNOWN,
                    "enabled": source_enabled(scfg),
                    "builtin": False,
                }
            else:
                entry = {
                    "id": sid,
                    "type": stype,
                    "name": scfg.get("name") or sid,
                    "status": scfg.get("status") or SOURCE_STATUS_UNKNOWN,
                    "enabled": source_enabled(scfg),
                    "builtin": False,
                }
            entry["skill_count"] = counts.get(sid, 0)
            out.append(entry)
    return out


def imported_skills_for_source(registry: dict, source_id: str) -> list[dict]:
    """Return skill metadata items owned by source_id."""
    skills = registry.get("skills") if isinstance(registry, dict) else None
    if not isinstance(skills, dict):
        return []
    out: list[dict] = []
    for name, cfg in skills.items():
        if not isinstance(cfg, dict):
            continue
        info = infer_skill_ownership(name, cfg)
        if info["source_id"] != source_id:
            continue
        out.append(
            {
                "name": name,
                "scope": cfg.get("scope"),
                "type": cfg.get("type"),
                "description": cfg.get("description"),
                "managed": info["managed"],
                "origin": cfg.get("origin"),
            }
        )
    return out


def validate_sources_registry(registry: dict) -> list[str]:
    """Validate top-level `sources:` block. Returns list of error messages.

    Backward-compatible: a missing or empty `sources:` block returns no errors.
    """
    sources = registry.get("sources") if isinstance(registry, dict) else None
    if sources is None:
        return []
    if not isinstance(sources, dict):
        return ["`sources:` must be a mapping of source_id -> source config"]

    errors: list[str] = []
    for sid, cfg in sources.items():
        if not isinstance(sid, str) or not SLUG_RE.match(sid):
            errors.append(f"invalid source id '{sid}': must match {SLUG_RE.pattern}")
            continue
        if sid in BUILT_IN_SOURCE_IDS:
            errors.append(
                f"source id '{sid}' is reserved for the built-in {sid} source"
            )
            continue
        if not isinstance(cfg, dict):
            errors.append(f"source '{sid}': config must be a mapping")
            continue
        raw_enabled = cfg.get("enabled")
        if raw_enabled is not None and not isinstance(raw_enabled, bool):
            errors.append(
                f"source '{sid}': enabled must be true or false (got {raw_enabled!r})"
            )
        stype = cfg.get("type") or "git"
        if stype not in SOURCE_TYPES:
            errors.append(f"source '{sid}': unknown type '{stype}'")
            continue
        if stype == "git":
            if not cfg.get("url"):
                errors.append(f"source '{sid}': git source requires a url")
            raw_path = cfg.get("path")
            if raw_path:
                raw_str = str(raw_path)
                if os.path.isabs(raw_str) or any(
                    seg == ".." for seg in raw_str.replace("\\", "/").split("/")
                ):
                    errors.append(
                        f"source '{sid}': path '{raw_path}' must be repo-relative without traversal"
                    )
        raw_include = cfg.get("include")
        if raw_include is not None:
            if not isinstance(raw_include, list) or any(
                not isinstance(n, str) or not n.strip() for n in raw_include
            ):
                errors.append(
                    f"source '{sid}': include must be a list of skill names"
                )
    return errors


# ─────────────────────────────────────────────────────────────────────────────
# Source-linked bundles
#
# A bundle may carry an optional `source: <source_id>` key. Its membership is
# then MANAGED: every `hub source sync <id>` rewrites the bundle to exactly the
# skills that source currently owns (order-preserving for retained skills, new
# arrivals appended sorted). Manual `--skills` edits are refused until the
# bundle is detached (`hub bundle update <n> --detach-source`).
# ─────────────────────────────────────────────────────────────────────────────


def source_owned_skill_names(registry: dict, source_id: str) -> list[str]:
    """Registry skill names owned by ``source_id`` that still exist upstream.

    Entries flagged ``source_missing`` are excluded — they are kept in the
    registry for UI resolution but must not be pushed into a linked bundle.
    """
    skills = registry.get("skills") if isinstance(registry, dict) else None
    if not isinstance(skills, dict):
        return []
    out: list[str] = []
    for name, cfg in skills.items():
        if not isinstance(cfg, dict):
            continue
        origin = cfg.get("origin") if isinstance(cfg.get("origin"), dict) else {}
        if origin.get("source") != source_id:
            continue
        if cfg.get("source_missing"):
            continue
        out.append(name)
    return out


def linked_bundle_names(registry: dict, source_id: str) -> list[str]:
    """Names of bundles that follow ``source_id``."""
    bundles = registry.get("bundles") if isinstance(registry, dict) else None
    if not isinstance(bundles, dict):
        return []
    return [
        name
        for name, cfg in bundles.items()
        if isinstance(cfg, dict) and cfg.get("source") == source_id
    ]


def reconcile_bundle_membership(
    registry: dict, bundle_name: str, source_id: str
) -> Optional[dict]:
    """Rewrite one linked bundle's `skills` to the source's owned set.

    Order rule: retained skills keep the bundle's existing order (it drives the
    Bundle editor card order), then newly-owned names are appended sorted.
    Names the source no longer owns — including dangling entries left by an
    archive/rename — are dropped.

    Returns ``{"bundle", "added", "removed"}`` when the list changed, else None.
    """
    bundles = registry.get("bundles") if isinstance(registry, dict) else None
    if not isinstance(bundles, dict):
        return None
    bcfg = bundles.get(bundle_name)
    if not isinstance(bcfg, dict):
        return None

    owned = set(source_owned_skill_names(registry, source_id))
    current = [s for s in (bcfg.get("skills") or []) if isinstance(s, str)]

    retained: list[str] = []
    for name in current:
        if name in owned and name not in retained:
            retained.append(name)
    appended = sorted(owned - set(retained))
    new_list = retained + appended
    if new_list == current:
        return None

    bcfg["skills"] = new_list
    # Playbook layout is presentation only, but references to skills removed
    # by a source refresh must not survive to be revived when the source adds
    # that name again later. New members remain implicit in the reader's loose
    # section, so this only prunes refs that are no longer authoritative.
    playbook = bcfg.get("playbook")
    if isinstance(playbook, list):
        new_members = set(new_list)
        for section in playbook:
            if isinstance(section, dict) and isinstance(
                section.get("skills"), list
            ):
                section["skills"] = [
                    name for name in section["skills"] if name in new_members
                ]
    current_set = set(current)
    added = [s for s in new_list if s not in current_set]
    removed = [s for s in current if s not in owned]
    if not added and not removed:
        # Pure de-duplication (or re-ordering): the deduped list IS written, but
        # there is no membership delta worth reporting to the caller.
        return None
    return {"bundle": bundle_name, "added": added, "removed": removed}


def reconcile_linked_bundles(registry: dict, source_id: str) -> list[dict]:
    """Reconcile every bundle following ``source_id``. Returns changed bundles."""
    sources = registry.get("sources") if isinstance(registry, dict) else None
    if not isinstance(sources, dict) or source_id not in sources:
        linked = linked_bundle_names(registry, source_id)
        if linked:
            print(
                f"  {c('!', YELLOW)} bundles {linked} follow unknown source "
                f"'{source_id}'; skipping reconcile"
            )
        return []
    updates: list[dict] = []
    for bundle_name in linked_bundle_names(registry, source_id):
        update = reconcile_bundle_membership(registry, bundle_name, source_id)
        if update:
            updates.append(update)
    return updates


# ─────────────────────────────────────────────────────────────────────────────
# §2 Git source add and discovery
#
# `hub source add git <url>` clones a Git repository into the data-home cache,
# scans for skill candidates, and either:
#   - dry-run: returns preview candidates (no registry mutation, clone is
#     staged in a temp dir and removed on exit)
#   - apply:   registers the source and `NEW` candidates as managed:external
#     skills under the registry, leaving CONFLICT/INVALID/IMPORTED untouched
#     unless explicit conflict actions are supplied
#
# Auth: system Git is invoked with `GIT_TERMINAL_PROMPT=0` so private repos
# work through SSH keys / credential helpers but never block on a TTY. No
# credentials are persisted to `registry.yaml`.
# ─────────────────────────────────────────────────────────────────────────────

GIT_DEFAULT_DEPTH = 1


def strip_trailing_skill_md(path: str) -> str:
    """Drop a trailing ``SKILL.md`` filename from a repo-relative path.

    A pasted ``/blob/`` link (or a hand-typed path) points AT the file; the
    scan base is the directory that holds it. Matched case-INSENSITIVELY —
    the filename comes from a URL or a text field, and the JS mirror in
    ``app/src/lib/skillSource.ts`` lowercases before comparing.
    """
    trimmed = (path or "").rstrip("/")
    lowered = trimmed.lower()
    if lowered == "skill.md":
        return ""
    if lowered.endswith("/skill.md"):
        return trimmed[: -len("/skill.md")]
    return path


def normalize_scanned_path(path: Optional[str]) -> str:
    """Repo-relative scan base in the one shape every surface should show.

    POSIX separators, no ``./`` prefix, no trailing slash, no ``.`` segments —
    so ``--path .`` reads as the repository root ("") rather than "/.".
    """
    cleaned = (path or "").strip().replace("\\", "/")
    return "/".join(seg for seg in cleaned.split("/") if seg and seg != ".")


def parse_git_url(url: str) -> dict:
    """Parse a Git URL, honoring GitHub-style ``tree|blob/<branch>/<path>`` form.

    Returns ``{"clone_url": str, "branch": Optional[str], "path": Optional[str]}``.
    For SSH form (``git@host:owner/repo.git``) or plain HTTPS, branch/path are
    None.

    Both ``/tree/`` (directory) and ``/blob/`` (file) deep links are understood —
    a pasted ``.../blob/main/pack/skills/foo/SKILL.md`` file link resolves to the
    skill *directory* (``pack/skills/foo``) because that is what the scanner
    takes as its base.
    """
    if not isinstance(url, str) or not url.strip():
        raise ValueError("git url is required")
    url = url.strip()
    m = re.match(
        r"^(?P<base>https?://[^/]+/[^/]+/[^/]+?)(?:\.git)?"
        r"(?:/(?:tree|blob)/(?P<branch>[^/]+)(?:/(?P<path>.+?))?/?)?$",
        url,
    )
    if m and m.group("branch"):
        base = m.group("base")
        clone_url = base if base.endswith(".git") else base + ".git"
        path = m.group("path") or None
        if path:
            # A file link points AT the skill's SKILL.md: scan its directory.
            path = strip_trailing_skill_md(path) or None
        return {
            "clone_url": clone_url,
            "branch": m.group("branch"),
            "path": path,
        }
    return {"clone_url": url, "branch": None, "path": None}


def resolve_source_scan_path(
    parsed_path: Optional[str], cli_path: Optional[str]
) -> str:
    """Effective repo-relative scan base for ``hub source add git``.

    An explicit ``--path`` is repo-relative and always WINS (including an
    explicit empty string, meaning "scan the repo root"); when the flag is
    absent (``None``) the subpath carried by a deep URL is used. There is no
    composition of the two — what you pass is what gets scanned.

    Either side may name a ``SKILL.md`` file rather than its directory (copied
    out of a file link, or typed); the filename is dropped so both spellings
    resolve to the same scan base.
    """
    if cli_path is not None:
        return strip_trailing_skill_md(cli_path)
    return strip_trailing_skill_md(parsed_path or "")


def derive_source_id_from_url(url: str) -> str:
    """Guess a default source-id slug from a repo URL."""
    parsed = parse_git_url(url)
    base = parsed["clone_url"].rstrip("/")
    if base.endswith(".git"):
        base = base[:-4]
    # Drop scheme/host portion; take the last segment.
    name = base.rsplit("/", 1)[-1]
    name = name.rsplit(":", 1)[-1]  # SSH form: git@host:owner/repo
    slug = re.sub(r"[^a-z0-9-]+", "-", name.lower()).strip("-")
    return slug or "external-source"


def _candidate_for_dir(skill_dir: Path) -> Optional[dict]:
    """If ``skill_dir`` has a valid SKILL.md, return a candidate base dict."""
    from skill_hub.application.skills.import_scanner import _parse_skill_md
    meta = _parse_skill_md(skill_dir / "SKILL.md")
    if meta is None:
        return None
    return {
        "name": meta["name"],
        "version": meta["version"],
        "description": meta["description"],
    }


MAX_SCAN_DEPTH = 4  # how far below the scan base discover_candidates recurses


def discover_candidates(checkout_root: Path, subdir: str) -> list[dict]:
    """Scan a Git checkout for skill candidates via a bounded recursive walk.

    Starting at the scan base (``subdir`` or the checkout root), walk the
    directory tree: any directory that contains a valid ``SKILL.md`` is recorded
    as a candidate and **not** descended into (a skill's own subfolders are not
    nested skills) — except the scan base itself, which is always descended into
    so a collection repo carrying a root ``SKILL.md`` alongside sibling skill
    dirs yields all of them. Other directories are recursed into up to ``MAX_SCAN_DEPTH``
    levels below the base — enough for ``skills/<category>/<skill>/`` layouts
    while bounding work on large repos. Hidden directories (names starting with
    ``.``) are pruned.

    Path-safety: ``subdir`` is normalized via ``normalize_subpath_within`` so
    absolute paths and ``..`` are rejected. Each discovered candidate path is
    re-checked to remain inside ``checkout_root`` after symlink resolution.

    Returns a list of candidate dicts with: name, version, description,
    origin_path (repo-relative).
    """
    try:
        base = normalize_subpath_within(checkout_root, subdir or "")
    except ValueError:
        return []
    if not base.is_dir():
        return []

    found: dict[str, dict] = {}
    checkout_resolved = checkout_root.resolve(strict=False)

    def add_candidate(p: Path, cand: dict) -> None:
        try:
            resolved = p.resolve(strict=False)
            rel = resolved.relative_to(checkout_resolved)
        except ValueError:
            # Symlink escape — skip silently.
            return
        cand["origin_path"] = str(rel) if str(rel) != "." else ""
        found.setdefault(cand["name"], cand)

    def walk(d: Path, depth: int) -> None:
        if not d.is_dir():
            return
        cand = _candidate_for_dir(d)
        if cand is not None:
            # This dir is itself a skill — record it and stop, unless it is the
            # scan base (a collection repo may be a skill AND hold siblings).
            add_candidate(d, cand)
            if depth > 0:
                return
        if depth >= MAX_SCAN_DEPTH:
            return
        for child in sorted(d.iterdir()):
            if child.name.startswith(".") or not child.is_dir():
                continue
            walk(child, depth + 1)

    walk(base, 0)
    return list(found.values())


def classify_candidates(
    candidates: list[dict], registry: dict, source_id: str
) -> list[dict]:
    """Tag each candidate with ``category`` ∈ {NEW, CONFLICT, IMPORTED, INVALID}."""
    skills = registry.get("skills") if isinstance(registry, dict) else None
    if not isinstance(skills, dict):
        skills = {}
    out: list[dict] = []
    for cand in candidates:
        base = dict(cand)
        name = cand.get("name")
        if not isinstance(name, str) or not SLUG_RE.match(name):
            base["category"] = "INVALID"
            base["reason"] = "name must match ^[a-z0-9-]+$"
            out.append(base)
            continue
        existing = skills.get(name)
        if isinstance(existing, dict):
            origin = (
                existing.get("origin")
                if isinstance(existing.get("origin"), dict)
                else {}
            )
            if origin.get("source") == source_id:
                base["category"] = "IMPORTED"
                out.append(base)
                continue
            base["category"] = "CONFLICT"
            base["existing_source"] = origin.get("source") or "local"
            base["existing_managed"] = existing.get("managed") or "local"
            out.append(base)
            continue
        base["category"] = "NEW"
        out.append(base)
    return out


def build_source_skill_entry(
    cand: dict,
    *,
    source_id: str,
    checkout: Path,
    ref: Optional[str],
    upstream: Optional[str],
) -> dict:
    """Registry entry for a skill adopted from a git source.

    The single shape used by BOTH `hub source add` (first import) and
    `hub source sync` (later arrivals), so an upstream skill registered by a
    sync is indistinguishable from one registered by the original add.
    """
    origin_path = cand["origin_path"]
    skill_source_dir = checkout / origin_path if origin_path else checkout
    return {
        "version": cand.get("version") or "1.0.0",
        "description": cand.get("description") or "",
        "source": str(skill_source_dir),
        "type": "claude-skill",
        "scope": "portable",
        "upstream": upstream,
        "managed": "external",
        "origin": {
            "source": source_id,
            "source_type": "git",
            "path": origin_path,
            "ref": ref,
        },
    }


def candidate_counts(classified: list[dict]) -> dict:
    counts = {"new": 0, "conflicts": 0, "imported": 0, "invalid": 0}
    for cand in classified:
        cat = cand.get("category")
        if cat == "NEW":
            counts["new"] += 1
        elif cat == "CONFLICT":
            counts["conflicts"] += 1
        elif cat == "IMPORTED":
            counts["imported"] += 1
        elif cat == "INVALID":
            counts["invalid"] += 1
    return counts


def _git_clone(
    url: str, branch: Optional[str], dest: Path, depth: int = GIT_DEFAULT_DEPTH
) -> dict:
    """Clone ``url`` into ``dest``. Returns ``{ok, ref, error}``."""
    args = ["clone", "--quiet"]
    if depth and depth > 0:
        args.extend(["--depth", str(depth)])
    if branch:
        args.extend(["--branch", branch])
    args.extend([url, str(dest)])
    try:
        res = _run_git(args)
    except FileNotFoundError:
        return {"ok": False, "ref": None, "error": "git executable not found on PATH"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "ref": None, "error": "git clone timed out"}
    if res.returncode != 0:
        msg = (res.stderr or res.stdout or "git clone failed").strip()
        return {"ok": False, "ref": None, "error": msg}
    ref_res = _run_git(["rev-parse", "HEAD"], cwd=dest)
    ref = ref_res.stdout.strip() if ref_res.returncode == 0 else None
    return {"ok": True, "ref": ref, "error": None}
