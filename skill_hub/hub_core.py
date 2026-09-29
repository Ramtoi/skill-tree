#!/usr/bin/env python3
"""hub_core — leaf primitives shared by hub.py and every sibling module.

Carved out of `hub.py` (S5) so `backup.py`, `permissions.py`, `mcp_adapters.py`,
the connectors, … can reach `data_home()` / `code_home()` / `fail()` / the colour
helpers without importing the 19k-line monolith. This module imports the standard
library and `yaml` ONLY — never a first-party module at module scope — which is
what keeps it free of import cycles (`tests/test_hub_split_guard.py` pins that).

`hub.py` re-exports every name below (`from skill_hub.hub_core import *`) and installs a
module-class facade so `hub.<name>` and `hub_core.<name>` stay the SAME binding
in both directions. See the `_HubFacade` docstring in `hub.py`.

The four names in `_MUTABLE_STATE` are rebound at runtime (the `global`
statements in `data_home()`, `data_home_lock()` and the one-shot warners) and by
tests; they are deliberately kept OUT of `__all__` so `hub` never holds a stale
copy of them.
"""

import datetime as _dt
import functools
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

# Vendored pure-Python dependencies (PyYAML, tomlkit) ship inside the app bundle
# under vendor/ next to this file (generated at build time from requirements.txt).
# Prepend it so `import yaml` resolves against the bundled copy regardless of what
# the host interpreter has installed — a clean install needs no pip. Guarded on
# membership because hub.py runs the same shim: whichever of the two imports
# first wins, and the second must not push a duplicate entry onto sys.path.
_VENDOR_DIR = Path(__file__).resolve().parent.parent / "vendor"
if _VENDOR_DIR.is_dir() and str(_VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(_VENDOR_DIR))

try:
    import yaml
except ImportError:
    print("Error: pyyaml not installed. Run: pip install pyyaml", file=sys.stderr)
    sys.exit(1)

_TOMLKIT_MISSING_REASON = (
    "Codex tooling (tomlkit) is not installed in this Python environment"
)


def _tomlkit_missing() -> bool:
    """Cheap availability check (no import) — a Python env without the
    vendored/pip-installed ``tomlkit`` package must degrade a Codex TOML write
    to an honest skip, not crash the whole sync with an uncaught ImportError."""
    return importlib.util.find_spec("tomlkit") is None


# ─────────────────────────────────────────────────────────────────────────────
# Code home vs data home (see openspec change globalize-config-and-projects)
#
# code_home:  read-only assets — hub.py, curated starter skills, MCP templates.
#             In a packaged build this resolves to <App>.app/Contents/Resources/hub/.
#             In dev mode it's the repo checkout containing hub.py + skills/.
#
# data_home:  user-owned content — registry.yaml, user-added skills, mcp-servers,
#             _hub-backups, .lock. Defaults to ~/.skill-hub/. Overrides via
#             $SKILL_HUB_HOME (preferred) or $SKILL_HUB_DIR (legacy, deprecated).
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_DATA_HOME = Path.home() / ".skill-hub"
LEGACY_DATA_HOMES = [Path.home() / "Dev" / ".skill-hub"]

CLAUDE_SKILLS_DIR = Path.home() / ".claude" / "skills"
CODEX_SKILLS_DIR = Path.home() / ".codex" / "skills"  # legacy (still seen on machines)
AGENTS_SKILLS_DIR = Path.home() / ".agents" / "skills"  # documented Codex current dir
PI_AGENT_DIR = Path.home() / ".pi" / "agent"
PI_MCP_GLOBAL = PI_AGENT_DIR / "mcp.json"
PI_SETTINGS = PI_AGENT_DIR / "settings.json"
# Import scan roots: ordered so newer canonical locations (`~/.agents/skills/`)
# precede the legacy fallback (`~/.codex/skills/`). Dedup-by-name preserves the
# canonical when both exist.
IMPORT_SCAN_ROOTS = [
    ("claude", CLAUDE_SKILLS_DIR),
    ("agents", AGENTS_SKILLS_DIR),
    ("legacy-codex", CODEX_SKILLS_DIR),
    ("pi", PI_AGENT_DIR / "skills"),
]

_DEPRECATION_WARNED = False
_LEGACY_FALLBACK_WARNED = False
_DATA_HOME_CACHE: Optional[Path] = None


def _warn_once_deprecated() -> None:
    global _DEPRECATION_WARNED
    if not _DEPRECATION_WARNED:
        print(
            "warning: SKILL_HUB_DIR is deprecated; use SKILL_HUB_HOME",
            file=sys.stderr,
        )
        _DEPRECATION_WARNED = True


def _warn_once_dir_ignored(value: str) -> None:
    global _DEPRECATION_WARNED
    if not _DEPRECATION_WARNED:
        print(
            f"warning: SKILL_HUB_DIR='{value}' ignored (SKILL_HUB_HOME is set)",
            file=sys.stderr,
        )
        _DEPRECATION_WARNED = True


def _warn_once_legacy_fallback(legacy: Path) -> None:
    global _LEGACY_FALLBACK_WARNED
    if not _LEGACY_FALLBACK_WARNED:
        print(
            f"warning: using legacy data home at {legacy}; "
            f"run `hub migrate-home` to move to {DEFAULT_DATA_HOME}",
            file=sys.stderr,
        )
        _LEGACY_FALLBACK_WARNED = True


def _resolve_data_home_path() -> Path:
    home_env = os.environ.get("SKILL_HUB_HOME", "").strip()
    legacy_env = os.environ.get("SKILL_HUB_DIR", "").strip()
    if home_env:
        if legacy_env:
            _warn_once_dir_ignored(legacy_env)
        return Path(home_env).expanduser().absolute()
    if legacy_env:
        _warn_once_deprecated()
        return Path(legacy_env).expanduser().absolute()
    default = DEFAULT_DATA_HOME.absolute()
    if not (default / "registry.yaml").exists():
        for legacy in LEGACY_DATA_HOMES:
            if (legacy / "registry.yaml").exists():
                _warn_once_legacy_fallback(legacy)
                return legacy.absolute()
    return default


def _resolve_code_home_path() -> Path:
    env = os.environ.get("SKILL_HUB_CODE", "").strip()
    if env:
        return Path(env).expanduser().absolute()
    here = Path(__file__).resolve().parent.parent
    for candidate in [here, *here.parents]:
        if (candidate / "hub.py").exists() and (candidate / "app").is_dir():
            return candidate
    return here


def code_home() -> Path:
    return _resolve_code_home_path()


def data_home() -> Path:
    global _DATA_HOME_CACHE
    if _DATA_HOME_CACHE is not None:
        return _DATA_HOME_CACHE
    path = _resolve_data_home_path()
    # Only reject explicit env-driven collision; legacy fallback (dev mode)
    # may legitimately co-locate with code_home until migration runs.
    home_env = os.environ.get("SKILL_HUB_HOME", "").strip()
    code_env = os.environ.get("SKILL_HUB_CODE", "").strip()
    if home_env and code_env:
        try:
            if (
                Path(home_env).expanduser().resolve()
                == Path(code_env).expanduser().resolve()
            ):
                print(
                    f"Error: SKILL_HUB_HOME and SKILL_HUB_CODE point to the same path: {path}",
                    file=sys.stderr,
                )
                sys.exit(1)
        except OSError:
            pass
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    for sub in ("skills", "mcp-servers", "_hub-backups"):
        (path / sub).mkdir(exist_ok=True)
    _DATA_HOME_CACHE = path
    return path


def registry_file() -> Path:
    return data_home() / "registry.yaml"


def legacy_data_home_candidates() -> list[Path]:
    current = _resolve_data_home_path()
    out: list[Path] = []
    for legacy in LEGACY_DATA_HOMES:
        if legacy.resolve() == current.resolve():
            continue
        if (legacy / "registry.yaml").exists():
            out.append(legacy.absolute())
    dir_env = os.environ.get("SKILL_HUB_DIR", "").strip()
    if dir_env:
        env_path = Path(dir_env).expanduser().absolute()
        if (
            env_path.resolve() != current.resolve()
            and (env_path / "registry.yaml").exists()
        ):
            out.append(env_path)
    return out


_LOCK_DEPTH = 0


@contextmanager
def data_home_lock():
    """Process-scoped advisory lock at <data_home>/.lock.

    fcntl.flock on POSIX / msvcrt.locking on Windows. Release is automatic
    on fd close, so a crashed holder does not leave a stale lock.

    **Re-entrant within a process.** A second `with data_home_lock()` while the
    lock is already held by this process is a no-op (depth-counted). This is
    required because some commands take the lock and then call inner helpers
    that also take it — acquiring `fcntl.flock(LOCK_EX)` on a second fd for the
    same file in the same process would otherwise deadlock.
    """
    global _LOCK_DEPTH
    if _LOCK_DEPTH > 0:
        _LOCK_DEPTH += 1
        try:
            yield
        finally:
            _LOCK_DEPTH -= 1
        return

    import platform as _platform

    lock_path = data_home() / ".lock"
    lock_path.touch(exist_ok=True)
    fp = open(lock_path, "w")
    locked = False
    try:
        if _platform.system() == "Windows":
            import msvcrt  # type: ignore[import-not-found]

            msvcrt.locking(fp.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(fp.fileno(), fcntl.LOCK_EX)
        locked = True
        _LOCK_DEPTH += 1
        yield
    finally:
        if locked:
            _LOCK_DEPTH -= 1
            try:
                if _platform.system() == "Windows":
                    import msvcrt  # type: ignore[import-not-found]

                    msvcrt.locking(fp.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(fp.fileno(), fcntl.LOCK_UN)
            except Exception:
                pass
        fp.close()




# ─────────────────────────────────────────────────────────────────────────────
# Registry helpers
# ─────────────────────────────────────────────────────────────────────────────


def migrate_harnesses_schema(registry: dict) -> bool:
    """Apply the harness-schema migration if not yet applied.

    Day-one semantics: preserve current behavior. Today every project
    receives writes to both `.claude/skills/` and `.agents/skills/`, so
    the migration sets `harnesses_global = ["claude-code"]` and gives
    every project `harnesses = ["pi"]` if missing. After migration each
    project resolves to `{claude-code, pi}` — identical to today.

    Idempotency marker: the presence of top-level `harnesses_global`
    itself. The second call is a no-op.

    Returns True if the registry was mutated.
    """
    if "harnesses_global" in registry:
        return False
    registry["harnesses_global"] = ["claude-code"]
    projects = registry.get("projects") or {}
    for proj_cfg in projects.values():
        if isinstance(proj_cfg, dict) and "harnesses" not in proj_cfg:
            proj_cfg["harnesses"] = ["pi"]
    return True


def _registry_migration_backup(tag: str) -> Path:
    """Snapshot the on-disk registry.yaml under `_hub-backups/registry/` before a
    breaking migration rewrites it. Called while the file still holds the
    pre-migration content (load_registry has not saved yet)."""
    src = registry_file()
    backup_root = data_home() / "_hub-backups" / "registry"
    backup_root.mkdir(parents=True, exist_ok=True)
    ts = _dt.datetime.now(tz=_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = backup_root / f"{tag}-{ts}.yaml"
    shutil.copy2(src, dest)
    return dest


def _next_imported_hook_name(existing: set) -> str:
    """Next free `imported-hook-<n>` name not already in `existing` (collision-safe)."""
    n = 1
    while f"imported-hook-{n}" in existing:
        n += 1
    return f"imported-hook-{n}"


def _collect_permissions_hook_rows(registry: dict) -> list:
    """Read-only scan of every legacy `permissions*.hooks` row across scopes.

    Deterministic order: global, then per project (sorted by name) the shared
    `permissions` block, then that project's personal `permissions_local` block.
    Each item is `(scope, project_name_or_None, block_dict, hook_row_dict)`.
    """
    rows: list = []
    g_block = registry.get("permissions_global")
    if isinstance(g_block, dict):
        for h in g_block.get("hooks") or []:
            if isinstance(h, dict):
                rows.append(("global", None, g_block, h))
    projects = registry.get("projects") or {}
    for pname in sorted(projects):
        pcfg = projects.get(pname)
        if not isinstance(pcfg, dict):
            continue
        for key, scope in (("permissions", "project"), ("permissions_local", "personal")):
            block = pcfg.get(key)
            if isinstance(block, dict):
                for h in block.get("hooks") or []:
                    if isinstance(h, dict):
                        rows.append((scope, pname, block, h))
    return rows


def migrate_hooks_to_library(registry: dict) -> bool:
    """Breaking migration (hooks-surface D6): move every `permissions*.hooks` row
    into the top-level `hooks:` library + the matching attach list.

    * global rows → `hooks_global`; project (`permissions`) AND personal-tier
      (`permissions_local`) rows → that project's `hooks` (per D2/D6 a project
      attach writes to the personal, uncommitted `settings.local.json`, preserving
      the personal file target).
    * each row becomes `hooks.imported-hook-<n>` (stable ordinal, collision-safe),
      copying event/matcher/command/timeout verbatim (matcher stays RAW — no
      reverse-translation to tools) and preserving harness affinity.
    * the source `hooks` entries are removed from the permissions blocks.
    * registry.yaml is backed up first; idempotent (no permissions hooks ⇒ no-op,
      no backup). Returns True iff the registry was mutated.
    """
    rows = _collect_permissions_hook_rows(registry)
    if not rows:
        return False

    from skill_hub.domain.hooks.hooks_model import HookDefinition

    _registry_migration_backup("pre-hooks-migration")

    hooks_map = registry.setdefault("hooks", {})
    if not isinstance(hooks_map, dict):
        hooks_map = {}
        registry["hooks"] = hooks_map
    existing_names = set(hooks_map.keys())
    hooks_global = registry.setdefault("hooks_global", [])
    if not isinstance(hooks_global, list):
        hooks_global = []
        registry["hooks_global"] = hooks_global

    for scope, pname, block, row in rows:
        name = _next_imported_hook_name(existing_names)
        existing_names.add(name)
        timeout_raw = row.get("timeout")
        try:
            timeout = int(timeout_raw) if timeout_raw is not None else None
        except (TypeError, ValueError):
            timeout = None
        harnesses = row.get("harnesses")
        definition = HookDefinition(
            name=name,
            event=str(row.get("event") or ""),
            command=str(row.get("command") or ""),
            description=f"Imported from {scope} permissions hooks",
            matcher=str(row.get("matcher") or ""),
            timeout=timeout,
            harnesses=list(harnesses) if isinstance(harnesses, list) else None,
        )
        hooks_map[name] = definition.to_block()
        if scope == "global":
            if name not in hooks_global:
                hooks_global.append(name)
        else:
            proj_cfg = registry["projects"][pname]
            attach = proj_cfg.setdefault("hooks", [])
            if not isinstance(attach, list):
                attach = []
                proj_cfg["hooks"] = attach
            if name not in attach:
                attach.append(name)
        where = "hooks_global" if scope == "global" else f"project '{pname}'"
        print(
            f"  {c('→', YELLOW)} migrated {scope} permissions hook "
            f"(event={definition.event or '?'}) → hooks.{name}, attached to {where}",
            file=sys.stderr,
        )
        # Excise the row from its source block (identity match on the dict object).
        block_hooks = block.get("hooks") or []
        block["hooks"] = [h for h in block_hooks if h is not row]

    return True


def load_registry() -> dict:
    reg_file = registry_file()
    if not reg_file.exists():
        print(
            f"Registry not found at {reg_file}. Run `hub bootstrap` to initialize.",
            file=sys.stderr,
        )
        sys.exit(1)
    with open(reg_file) as f:
        registry = yaml.safe_load(f) or {}
    mutated = False
    if migrate_harnesses_schema(registry):
        mutated = True
    from skill_hub.domain.permissions.permissions import migrate_permissions_schema as _migrate_perms

    if _migrate_perms(registry):
        mutated = True
    from skill_hub.infrastructure.remotes.remotes import migrate_remotes_schema as _migrate_remotes

    if _migrate_remotes(registry):
        mutated = True
    # Hooks migration runs LAST (it reads the permissions blocks the perms
    # migration just ensured exist) and backs up before its breaking rewrite.
    if migrate_hooks_to_library(registry):
        mutated = True
    if mutated:
        # Persist immediately so subsequent reads see the upgraded shape.
        save_registry(registry)
    return registry


def save_registry(registry: dict):
    reg_file = registry_file()
    tmp_file = reg_file.with_suffix(".yaml.tmp")
    with open(tmp_file, "w") as f:
        yaml.dump(
            registry, f, default_flow_style=False, allow_unicode=True, sort_keys=False
        )
    os.replace(tmp_file, reg_file)


def _registry_sha() -> str:
    """Short content hash of registry.yaml (empty string if absent)."""
    try:
        return hashlib.sha256(registry_file().read_bytes()).hexdigest()[:12]
    except OSError:
        return ""



def audit_log_path() -> Path:
    return data_home() / "state" / "audit.jsonl"


def append_audit(
    verb: str, args, sha_before: str, sha_after: str, extra: Optional[dict] = None
) -> None:
    """Best-effort append of a registry-mutation record to the audit log.

    Never raises — auditing must not break a command. `actor` comes from
    `$SKILL_HUB_ACTOR` (default "cli") so an agent can identify itself.
    `extra` merges additional low-cardinality fields into the target summary
    (e.g. reconcile's imported/dropped/kept counts).
    """
    try:
        # Generic, low-cardinality target summary from common arg names.
        target = {}
        for field in (
            "name",
            "project",
            "skill",
            "bundle",
            "bundle_name",
            "new_name",
            "id",
            "pattern",
            "kind",
        ):
            val = getattr(args, field, None)
            if val:
                target[field] = val
        if extra:
            target.update(extra)
        record = {
            "ts": _dt.datetime.now().isoformat(timespec="seconds"),
            "actor": os.environ.get("SKILL_HUB_ACTOR", "cli"),
            "verb": verb,
            "target": target,
            "changed": sha_before != sha_after,
            "sha_before": sha_before,
            "sha_after": sha_after,
        }
        path = audit_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass


def registry_mutation(verb: str):
    """Decorate a mutating `cmd_*` so it runs under the (re-entrant) data-home
    lock and appends a best-effort audit record of the registry change.

    Safe to stack on commands that already take the lock internally — the lock
    is re-entrant, so the outer acquisition is a no-op that only adds auditing.

    The lock is held for the WHOLE command, including the `_auto_sync()` tail
    (and therefore `backup.run_backup`, which re-takes it). That is intentional:
    a mutation and the sync it implies are one unit. It only stays deadlock-free
    because the re-entrancy depth is per-module — which is why script mode
    aliases itself into `sys.modules["hub"]` at the top of this file, so a
    sibling's `import hub` shares this module's depth counter.

    A `SystemExit` code 2 raised by `fn` (`hub enable`'s exit-2
    `needs_provisioning` gate, A4/S1) still gets an audit record: the record
    is appended before the exit propagates, rather than skipped, since the
    registry WAS mutated and saved before that exit — only the exit code
    differs from a plain success. An ordinary failure exit (1, or any other
    code) is NOT audited here — nothing was mutated on that path, and a
    generic catch would log a `changed: false` record for every plain
    `fail(...)` in every decorated command (S-1).
    """

    def deco(fn):
        @functools.wraps(fn)
        def wrapper(args):
            with data_home_lock():
                before = _registry_sha()
                try:
                    result = fn(args)
                except SystemExit as exc:
                    if exc.code == 2:
                        append_audit(verb, args, before, _registry_sha())
                    raise
                append_audit(verb, args, before, _registry_sha())
                return result

        return wrapper

    return deco


def expand(path_str: str) -> Path:
    return Path(path_str).expanduser().resolve()


def collapse_home(path: Path) -> str:
    """Collapse ~ for paths under $HOME, return absolute otherwise."""
    s = str(path.absolute())
    home = str(Path.home())
    if s == home or s.startswith(home + os.sep):
        return "~" + s[len(home) :]
    return s


# ─────────────────────────────────────────────────────────────────────────────
# Colour helpers (no deps)
# ─────────────────────────────────────────────────────────────────────────────

RESET = "\033[0m"
BOLD = "\033[1m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
DIM = "\033[2m"
RED = "\033[31m"
BLUE = "\033[34m"


def c(text, *codes):
    return "".join(codes) + str(text) + RESET


VALID_SCOPES = {"global", "portable", "project-specific"}
VALID_BUNDLE_SCOPES = {"global", "portable", "project-specific"}
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$")
SLUG_RE = re.compile(r"^[a-z0-9-]+$")


def fail(message: str):
    print(message)
    sys.exit(1)


def parse_scope(scope: Optional[str], default: str = "portable") -> str:
    value = scope or default
    if value not in VALID_SCOPES:
        fail(
            f"Invalid scope '{value}'. Expected one of: {', '.join(sorted(VALID_SCOPES))}."
        )
    return value


def parse_bundle_scope(scope: Optional[str], default: str = "project-specific") -> str:
    value = scope or default
    if value not in VALID_BUNDLE_SCOPES:
        fail(
            f"Invalid bundle scope '{value}'. Expected one of: {', '.join(sorted(VALID_BUNDLE_SCOPES))}."
        )
    return value


def bundle_scope(cfg: dict) -> str:
    return parse_bundle_scope(cfg.get("scope"), default="project-specific")


def parse_csv(value: Optional[str]) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def validate_slug(name: str, label: str = "name"):
    if not SLUG_RE.match(name):
        fail(
            f"Invalid {label} '{name}'. Use lowercase letters, numbers, and hyphens only."
        )


def validate_version(version: str):
    if version and not SEMVER_RE.match(version):
        fail(f"Invalid version '{version}'. Expected semver like 1.2.3.")


FALLBACK_VERSION = "0.1.0"


def hub_version() -> str:
    """Bundled version from code_home/VERSION, falling back to a baked constant
    if the file is missing (partial checkout / older bundle)."""
    try:
        raw = (code_home() / "VERSION").read_text(encoding="utf-8").strip()
        return raw or FALLBACK_VERSION
    except OSError:
        return FALLBACK_VERSION


MIN_PYTHON = (3, 9)


def _now_iso() -> str:
    return _dt.datetime.now(tz=_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sha256_file(path: Path) -> Optional[str]:
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


_GIT_NONINTERACTIVE_ENV = {
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_ASKPASS": "echo",
    "SSH_ASKPASS": "echo",
}


def _run_git(
    args: list[str], cwd: Optional[Path] = None, timeout: int = 120
) -> subprocess.CompletedProcess:
    """Run git non-interactively. Returns CompletedProcess (does not raise on non-zero)."""
    env = os.environ.copy()
    env.update(_GIT_NONINTERACTIVE_ENV)
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd) if cwd else None,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Public surface
#
# `_MUTABLE_STATE` names are REBOUND at runtime by the `global` statements
# above (and by tests). They are excluded from `__all__` on purpose: `hub.py`
# does `from skill_hub.hub_core import *`, which COPIES bindings, and a copy of a counter
# is a stale counter. `hub`'s module-class facade forwards reads/writes of these
# four to this module instead — see `_HubFacade` in `hub.py`.
# ─────────────────────────────────────────────────────────────────────────────

_MUTABLE_STATE = (
    "_DEPRECATION_WARNED",
    "_LEGACY_FALLBACK_WARNED",
    "_DATA_HOME_CACHE",
    "_LOCK_DEPTH",
)

__all__ = [
    # ── paths ────────────────────────────────────────────────────────────────
    "DEFAULT_DATA_HOME",
    "LEGACY_DATA_HOMES",
    "CLAUDE_SKILLS_DIR",
    "CODEX_SKILLS_DIR",
    "AGENTS_SKILLS_DIR",
    "PI_AGENT_DIR",
    "PI_MCP_GLOBAL",
    "PI_SETTINGS",
    "IMPORT_SCAN_ROOTS",
    "_warn_once_deprecated",
    "_warn_once_dir_ignored",
    "_warn_once_legacy_fallback",
    "_resolve_data_home_path",
    "_resolve_code_home_path",
    "code_home",
    "data_home",
    "registry_file",
    "legacy_data_home_candidates",
    "data_home_lock",
    # ── registry ─────────────────────────────────────────────────────────────
    "migrate_harnesses_schema",
    "_registry_migration_backup",
    "_next_imported_hook_name",
    "_collect_permissions_hook_rows",
    "migrate_hooks_to_library",
    "load_registry",
    "save_registry",
    "_registry_sha",
    # ── audit + path helpers ─────────────────────────────────────────────────
    "audit_log_path",
    "append_audit",
    "registry_mutation",
    "expand",
    "collapse_home",
    # ── colours + validation ─────────────────────────────────────────────────
    "RESET",
    "BOLD",
    "GREEN",
    "YELLOW",
    "CYAN",
    "DIM",
    "RED",
    "BLUE",
    "c",
    "VALID_SCOPES",
    "VALID_BUNDLE_SCOPES",
    "SEMVER_RE",
    "SLUG_RE",
    "fail",
    "parse_scope",
    "parse_bundle_scope",
    "bundle_scope",
    "parse_csv",
    "validate_slug",
    "validate_version",
    # ── misc leaf helpers ────────────────────────────────────────────────────
    "FALLBACK_VERSION",
    "hub_version",
    "MIN_PYTHON",
    "_now_iso",
    "_sha256_file",
    "_GIT_NONINTERACTIVE_ENV",
    "_run_git",
    # ── vendored deps ────────────────────────────────────────────────────────
    "_TOMLKIT_MISSING_REASON",
    "_tomlkit_missing",
]
