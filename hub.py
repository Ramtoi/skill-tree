#!/usr/bin/env python3
"""
hub — central skill registry CLI
"""

import argparse
import datetime as _dt
import errno
import functools
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Optional, Any

# Vendored pure-Python dependencies (PyYAML, tomlkit) ship inside the app bundle
# under vendor/ next to this file (generated at build time from requirements.txt).
# Prepend it so `import yaml` resolves against the bundled copy regardless of what
# the host interpreter has installed — a clean install needs no pip. The guard
# below still reports cleanly if even the vendored copy is missing. See the
# `harden-onboarding` change.
_VENDOR_DIR = Path(__file__).resolve().parent / "vendor"
if _VENDOR_DIR.is_dir():
    sys.path.insert(0, str(_VENDOR_DIR))

try:
    import yaml
except ImportError:
    print("Error: pyyaml not installed. Run: pip install pyyaml", file=sys.stderr)
    sys.exit(1)

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
    here = Path(__file__).resolve().parent
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
    from permissions import migrate_permissions_schema as _migrate_perms

    if _migrate_perms(registry):
        mutated = True
    from remotes import migrate_remotes_schema as _migrate_remotes

    if _migrate_remotes(registry):
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


# ─────────────────────────────────────────────────────────────────────────────
# Sync report (derived per-run state under <data_home>/state/)
# ─────────────────────────────────────────────────────────────────────────────


def sync_report_path() -> Path:
    return data_home() / "state" / "sync-report.json"


def _registry_fingerprint() -> tuple[str, float]:
    """Full SHA-256 hex + st_mtime of registry.yaml (('' , 0.0) if absent).

    Reading the bytes at call time is what makes an idle re-open of a clean sync
    read `fresh` — the fingerprint always reflects the registry after the run's
    final `save_registry`.
    """
    reg = registry_file()
    try:
        data = reg.read_bytes()
        mtime = reg.stat().st_mtime
    except OSError:
        return "", 0.0
    return hashlib.sha256(data).hexdigest(), mtime


def new_sync_report() -> dict:
    """A mutable schema_version:1 accumulator, threaded through the sync passes."""
    return {
        "schema_version": 1,
        "generated_at": None,
        "registry_sha256": "",
        "registry_mtime": 0.0,
        "ok": True,
        "global": {
            "skipped": [],
            "skills": {"writes": 0, "removed": 0},
            "mcp": {"writes": 0, "removed": 0},
            "permissions": {"ok": True, "errors": []},
            "remotes": {"attempted": 0, "alarming": 0},
        },
        "projects": {},
    }


def new_project_report() -> dict:
    return {
        "ts": _now_iso(),
        "ok": True,
        "errors": [],
        "writes": 0,
        "removed": 0,
        "affinity_skips": [],
    }


def _sync_report_ok(report: dict) -> bool:
    projects_ok = all(
        p.get("ok", True) for p in report.get("projects", {}).values()
    )
    perms_ok = bool(report.get("global", {}).get("permissions", {}).get("ok", True))
    return projects_ok and perms_ok


def write_sync_report(report: dict) -> None:
    """Serialize the sync report atomically to <data_home>/state/sync-report.json.

    Stamped here (not by each pass) so EVERY exit path records the registry bytes
    as they stand after the run's final `save_registry`. No backup — the report is
    100% derived state, regenerated by the next sync.
    """
    report["generated_at"] = _now_iso()
    sha, mtime = _registry_fingerprint()
    report["registry_sha256"] = sha
    report["registry_mtime"] = mtime
    report["ok"] = _sync_report_ok(report)
    path = sync_report_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(report, indent=2) + "\n")
    os.replace(tmp, path)


def audit_log_path() -> Path:
    return data_home() / "state" / "audit.jsonl"


def append_audit(verb: str, args, sha_before: str, sha_after: str) -> None:
    """Best-effort append of a registry-mutation record to the audit log.

    Never raises — auditing must not break a command. `actor` comes from
    `$SKILL_HUB_ACTOR` (default "cli") so an agent can identify itself.
    """
    try:
        # Generic, low-cardinality target summary from common arg names.
        target = {}
        for field in ("name", "project", "skill", "bundle", "bundle_name", "new_name"):
            val = getattr(args, field, None)
            if val:
                target[field] = val
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
    """

    def deco(fn):
        @functools.wraps(fn)
        def wrapper(args):
            with data_home_lock():
                before = _registry_sha()
                result = fn(args)
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


def skill_source(skill_cfg: dict) -> Path:
    raw = skill_cfg["source"]
    p = expand(raw)
    # for mcp-server, source may point to a dir without SKILL.md — that's fine
    return p


def hub_skills_dir() -> Path:
    """Where user-owned skills live (data home)."""
    return data_home() / "skills"


def hub_mcp_servers_dir() -> Path:
    return data_home() / "mcp-servers"


def parse_skill_frontmatter_name(skill_md: Path) -> Optional[str]:
    meta = parse_skill_frontmatter(skill_md)
    if not meta:
        return None
    name = meta.get("name")
    return str(name).strip() if name else None


def parse_skill_frontmatter(skill_md: Path) -> Optional[dict]:
    """Return the parsed frontmatter dict, or None if missing/invalid."""
    if not skill_md.exists():
        return None
    try:
        text = skill_md.read_text()
    except OSError:
        return None
    if not text.lstrip().startswith("---"):
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None
    try:
        meta = yaml.safe_load(parts[1]) or {}
    except yaml.YAMLError:
        return None
    if not isinstance(meta, dict):
        return None
    return meta


def _validate_harness_affinity(values: list[str], context: str) -> list[str]:
    """Filter a `harnesses:` list to known ids; warn (don't reject) on unknown.

    Per spec, unknown ids are forward-compat: log a warning, accept the field,
    but treat the unknown id as inert at resolution time.
    """
    import harnesses as _harnesses

    known = set(_harnesses.HARNESSES.keys())
    cleaned: list[str] = []
    for v in values:
        if not isinstance(v, str):
            continue
        v = v.strip()
        if not v:
            continue
        if v not in known:
            print(
                f"  {c('!', YELLOW)} {context}: unknown harness id '{v}' — "
                f"accepted but inert at sync time",
                file=sys.stderr,
            )
        cleaned.append(v)
    return cleaned


# ─────────────────────────────────────────────────────────────────────────────
# Invocation axis (who may invoke a skill: the user, the model, or both)
#
# Claude Code reads two SKILL.md frontmatter flags:
#   (neither)                       → user + model can invoke ("auto")
#   disable-model-invocation: true  → user-only (/name; description NOT in context)
#   user-invocable: false           → model-only (hidden from the / menu)
# The frontmatter is the harness-consumed source of truth; the registry holds a
# sync-time mirror (`skills.<n>.invocation`) exactly like `harnesses:` affinity.
# ─────────────────────────────────────────────────────────────────────────────

VALID_INVOCATIONS = ("auto", "user-only", "model-only")

# CLI vocabulary for `hub project invocation --mode` (inherit clears the override).
PROJECT_INVOCATION_MODES = (*VALID_INVOCATIONS, "inherit")

_INVOCATION_FM_RE = re.compile(r"^(disable-model-invocation|user-invocable)\s*:")

VARIANT_MARKER_COMMENT = (
    "# invocation managed by Skill Tree (project override) — "
    "edit the library copy, not this file"
)


def invocation_from_frontmatter(meta: dict) -> str:
    """Map parsed SKILL.md frontmatter to `auto|user-only|model-only|conflicted`.

    `conflicted` = both flags present and restrictive (a hand-authored
    contradiction: the model can't see it AND it's hidden from the / menu).
    """
    # Strict booleans only: a quoted "false"/"true" or other junk value must
    # not silently flip the mode (Claude Code reads real YAML booleans).
    model_off = meta.get("disable-model-invocation") is True
    user_off = meta.get("user-invocable") is False
    if model_off and user_off:
        return "conflicted"
    if model_off:
        return "user-only"
    if user_off:
        return "model-only"
    return "auto"


def render_invocation_frontmatter(
    text: str, mode: str, generated_marker: bool = False
) -> Optional[str]:
    """Return SKILL.md text with the invocation flags rewritten to `mode`.

    Textual, minimal edit: strips any top-level `disable-model-invocation:` /
    `user-invocable:` lines (and a stale variant marker), then inserts the one
    line `mode` requires before the closing fence. Every other byte is kept.
    Returns None when the frontmatter is missing/unparseable or the rewrite
    fails post-verification — callers must refuse rather than corrupt.
    """
    if mode not in VALID_INVOCATIONS:
        return None
    if not text.lstrip().startswith("---"):
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None

    lines = parts[1].split("\n")
    kept = [
        ln
        for ln in lines
        if not _INVOCATION_FM_RE.match(ln) and ln.strip() != VARIANT_MARKER_COMMENT
    ]
    # The fence segment ends with a newline → trailing "" element; insert before it.
    trailing = ""
    if kept and kept[-1] == "":
        kept = kept[:-1]
        trailing = "\n"

    insert: list[str] = []
    if mode == "user-only":
        insert = ["disable-model-invocation: true"]
    elif mode == "model-only":
        insert = ["user-invocable: false"]
    if generated_marker:
        insert = [VARIANT_MARKER_COMMENT] + insert

    new_fm = "\n".join(kept + insert) + trailing
    new_text = parts[0] + "---" + new_fm + "---" + parts[2]

    # Verify: the rewritten frontmatter must parse and encode exactly `mode`.
    verify_parts = new_text.split("---", 2)
    try:
        verify_meta = yaml.safe_load(verify_parts[1]) or {}
    except yaml.YAMLError:
        return None
    if not isinstance(verify_meta, dict):
        return None
    if invocation_from_frontmatter(verify_meta) != mode:
        return None
    return new_text


def skill_invocation(skill_cfg: dict) -> str:
    """Registry accessor: the mirrored invocation mode (absent = auto)."""
    return skill_cfg.get("invocation") or "auto"


def sync_skill_frontmatter_metadata(registry: dict) -> bool:
    """Pull optional `harnesses:` + invocation flags from each skill's SKILL.md
    into the registry.

    Returns True if registry was mutated. Called during `cmd_sync` after
    `validate_registry_skills`. Frontmatter is authoritative when present —
    deleting it from the registry on next sync requires editing the file.
    """
    skills = registry.get("skills") or {}
    changed = False
    for name, cfg in skills.items():
        if cfg.get("type") != "claude-skill":
            continue
        skill_md = skill_source(cfg) / "SKILL.md"
        meta = parse_skill_frontmatter(skill_md)
        if not meta:
            continue

        fm_harnesses = meta.get("harnesses")
        if fm_harnesses is not None:
            if not isinstance(fm_harnesses, list):
                print(
                    f"  {c('!', YELLOW)} skill '{name}': `harnesses:` frontmatter must be a list",
                    file=sys.stderr,
                )
            else:
                cleaned = _validate_harness_affinity(fm_harnesses, f"skill '{name}'")
                if cfg.get("harnesses") != cleaned:
                    cfg["harnesses"] = cleaned
                    changed = True

        mode = invocation_from_frontmatter(meta)
        if mode == "conflicted":
            print(
                f"  {c('!', YELLOW)} skill '{name}': SKILL.md sets BOTH "
                f"disable-model-invocation and user-invocable: false — nobody can "
                f"invoke it; repair with `hub set-meta {name} --invocation <mode>`",
                file=sys.stderr,
            )
        if mode == "auto":
            if "invocation" in cfg:
                del cfg["invocation"]
                changed = True
        elif cfg.get("invocation") != mode:
            cfg["invocation"] = mode
            changed = True
    return changed


def validate_registry_skills(registry: dict):
    skills = registry.get("skills", {})
    seen_names: dict[str, str] = {}
    errors: list[str] = []
    warnings: list[str] = []

    for registry_name, cfg in skills.items():
        if cfg.get("type") != "claude-skill":
            continue

        src = skill_source(cfg)
        skill_md = src / "SKILL.md"
        if not skill_md.exists():
            warnings.append(f"{registry_name}: missing SKILL.md at {skill_md}")
            continue

        frontmatter_name = parse_skill_frontmatter_name(skill_md)
        if not frontmatter_name:
            errors.append(f"{registry_name}: missing 'name:' in {skill_md}")
            continue

        if frontmatter_name != registry_name:
            errors.append(
                f"{registry_name}: frontmatter name is '{frontmatter_name}' in {skill_md}; "
                f"must match registry key to avoid collisions"
            )

        owner = seen_names.get(frontmatter_name)
        if owner and owner != registry_name:
            errors.append(
                f"duplicate skill name '{frontmatter_name}' declared by both '{owner}' and '{registry_name}'"
            )
        else:
            seen_names[frontmatter_name] = registry_name

    for warning in warnings:
        print(f"{c('!', YELLOW)} {warning}")

    if errors:
        print(c("Skill registry validation failed:", BOLD, RED), file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        print(
            "\nFix the duplicate/mismatched skill definitions in ~/.skill-hub before running sync.",
            file=sys.stderr,
        )
        sys.exit(1)


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


def c(text, *codes):
    return "".join(codes) + str(text) + RESET


VALID_SCOPES = {"global", "portable", "project-specific"}
VALID_BUNDLE_SCOPES = {"global", "project-specific"}
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


# ─────────────────────────────────────────────────────────────────────────────
# Self-version + release coordinates
#
# The single source of truth is the root VERSION file, shipped into code_home as
# hub/VERSION (see tauri.conf.json bundle.resources). `hub update` compares it
# against the latest GitHub Release on the public mirror.
# ─────────────────────────────────────────────────────────────────────────────

GITHUB_REPO = "Ramtoi/skill-tree"
GITHUB_API_LATEST = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
GITHUB_RELEASES_URL = f"https://github.com/{GITHUB_REPO}/releases"
FALLBACK_VERSION = "0.1.0"


def hub_version() -> str:
    """Bundled version from code_home/VERSION, falling back to a baked constant
    if the file is missing (partial checkout / older bundle)."""
    try:
        raw = (code_home() / "VERSION").read_text(encoding="utf-8").strip()
        return raw or FALLBACK_VERSION
    except OSError:
        return FALLBACK_VERSION


def _version_tuple(v: str) -> tuple:
    """Comparable (major, minor, patch) — pre-release/build suffixes ignored."""
    core = re.split(r"[-+]", v.strip().lstrip("v"), maxsplit=1)[0]
    parts = core.split(".")
    out = []
    for i in range(3):
        try:
            out.append(int(parts[i]))
        except (IndexError, ValueError):
            out.append(0)
    return tuple(out)


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


def remove_symlink(link: Path):
    if link.is_symlink():
        link.unlink()
        print(f"  {c('✗', RED)} removed {link}")


def remove_unmanaged_entries(
    skills_dir: Path, expected_names: set[str], label: str
) -> int:
    """Remove stale hub-owned links (and move aside foreign entries). Returns the
    number of entries removed/moved (used by the sync-report writer)."""
    if not skills_dir.exists() or skills_dir.is_symlink():
        return 0

    removed = 0
    for entry in skills_dir.iterdir():
        if entry.name in expected_names or entry.name == "_hub-backups":
            continue

        if entry.is_symlink():
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
    return removed


# ─────────────────────────────────────────────────────────────────────────────
# MCP config management
# ─────────────────────────────────────────────────────────────────────────────


def load_json_or_empty(path: Path) -> dict:
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return {}


def save_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def build_mcp_entry(name: str, skill_cfg: dict) -> dict:
    mcp = skill_cfg.get("mcp", {})
    source = skill_source(skill_cfg)
    args = [a.replace("{source}", str(source)) for a in mcp.get("args", [])]
    return {
        "command": mcp.get("command", "python3"),
        "args": args,
        "env": mcp.get("env", {}),
    }


def _spec_from_skill(name: str, skill_cfg: dict):
    """Build an McpServerSpec from a registry skill entry.

    `source` is only needed to substitute the `{source}` placeholder in args
    (an MCP server whose command lives inside the skill dir). An mcp-server with
    an explicit absolute command + args — e.g. the skill-hub control plane — has
    no source dir (`source: null`); resolving it unconditionally crashes sync.
    """
    import mcp_adapters

    mcp = skill_cfg.get("mcp", {})
    raw_args = mcp.get("args", [])
    if skill_cfg.get("source") and any("{source}" in a for a in raw_args):
        source = str(skill_source(skill_cfg))
        args = [a.replace("{source}", source) for a in raw_args]
    else:
        args = list(raw_args)
    return mcp_adapters.McpServerSpec(
        name=name,
        command=mcp.get("command", "python3"),
        args=args,
        env=mcp.get("env", {}),
    )


def sync_mcp_for_project(project_path: Path, enabled_mcps: list, registry: dict):
    """Dispatch MCP writes via per-harness adapters.

    Resolves the project's effective harnesses, intersects each skill's
    optional `harnesses:` affinity, collects (adapter -> [specs]) groups,
    then runs one write per unique adapter. ClaudeMcpAdapter is shared by
    claude-code and pi → effective = {claude-code, pi} produces exactly one
    .mcp.json write.

    Warns once per project if `.pi/mcp.json` exists (user override precedence).
    """
    import harnesses as _harnesses
    import mcp_adapters

    skills = registry.get("skills", {})

    # Effective harnesses for this project (find by path match).
    proj_cfg: dict = {}
    for p in registry.get("projects", {}).values():
        try:
            if expand(p["path"]) == project_path.resolve():
                proj_cfg = p
                break
        except OSError:
            continue
    effective = _harnesses.resolve_effective(proj_cfg, registry)

    # Build (adapter_key -> [specs]) groups, applying per-skill affinity.
    by_adapter: dict[str, list] = {}
    for mcp_name in enabled_mcps:
        if mcp_name not in skills:
            continue
        cfg = skills[mcp_name]
        if cfg.get("type") != "mcp-server":
            continue
        affinity = _skill_affinity(cfg)
        target_harnesses = effective & affinity if affinity is not None else effective
        adapter_keys: set[str] = set()
        for h_id in target_harnesses:
            h = _harnesses.HARNESSES.get(h_id)
            if h is None or h.mcp_adapter_key is None:
                continue
            adapter_keys.add(h.mcp_adapter_key)
        for key in adapter_keys:
            by_adapter.setdefault(key, []).append(_spec_from_skill(mcp_name, cfg))

    # Dispatch one write per unique adapter
    for key, specs in by_adapter.items():
        adapter = mcp_adapters.get_adapter(key)
        if adapter is None:
            continue
        try:
            wrote = adapter.write(project_path, specs)
        except Exception as e:
            print(f"  {c('!', RED)} MCP adapter '{key}' failed: {e}")
            continue
        if wrote:
            print(f"  {c('✓', GREEN)} MCP({key}) → {project_path}")

    # Override-precedence warning: Pi's optional .pi/mcp.json takes precedence
    # over the .mcp.json we manage. Warn once per project per sync run.
    pi_override = project_path / ".pi" / "mcp.json"
    if pi_override.exists():
        print(
            f"  {c('!', YELLOW)} {pi_override} overrides .mcp.json — "
            f"Skill Hub's MCP servers will be invisible to Pi until that "
            f"file is removed"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Global MCP dispatch (scope:global mcp-servers → each harness's user-global config)
# ─────────────────────────────────────────────────────────────────────────────


def _global_mcp_sidecar_path(harness_id: str) -> Path:
    """Sidecar recording the global MCP server names hub manages per harness."""
    return data_home() / "state" / harness_id / "global-mcp.managed.json"


def _read_global_mcp_sidecar(harness_id: str) -> Optional[set[str]]:
    """Return the recorded hub-managed names, or None if missing/corrupt.

    None signals "no prior ownership knowledge" — cleanup MUST be a no-op so a
    user-authored server is never deleted on a guess.
    """
    path = _global_mcp_sidecar_path(harness_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        print(
            f"  {c('!', YELLOW)} corrupt global-MCP sidecar {path} — "
            f"skipping cleanup for {harness_id} (no server will be removed)",
            file=sys.stderr,
        )
        return None
    if not isinstance(data, list):
        return None
    return {str(x) for x in data}


def _write_global_mcp_sidecar(harness_id: str, names: set[str]) -> None:
    path = _global_mcp_sidecar_path(harness_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(sorted(names), indent=2) + "\n")


def _run_global_mcp_dispatch(
    registry: dict, installed: set[str], report: Optional[dict] = None
) -> None:
    """Write every scope:global mcp-server to each installed harness's
    user-global MCP config. Merge-preserving, backup-first, atomic,
    sidecar-tracked cleanup. Parallel to the global-skills pass.
    """
    import harnesses as _harnesses
    import mcp_adapters

    print(f"\n{c('Global MCP servers (managed only from hub):', BOLD)}")

    skills = registry.get("skills", {})
    # Collect scope:global mcp-server specs (and their affinity).
    global_mcps: list[tuple[str, dict]] = [
        (name, cfg)
        for name, cfg in skills.items()
        if cfg.get("type") == "mcp-server" and cfg.get("scope") == "global"
    ]

    any_written = False
    for h_id, h in _harnesses.HARNESSES.items():
        if h_id not in installed:
            continue
        if h.global_mcp_config is None:
            reason = (
                "reads project-local .mcp.json only"
                if h_id == "pi"
                else "project-only MCP adapter (no user-global config)"
            )
            print(f"  {c('·', DIM)} {h.label} skipped: {reason}")
            continue
        adapter = mcp_adapters.get_adapter(h.mcp_adapter_key)
        if adapter is None or not hasattr(adapter, "write_global"):
            print(
                f"  {c('·', DIM)} {h.label} skipped: adapter has no global-write support"
            )
            continue

        # Apply each server's harnesses: affinity.
        specs = []
        for name, cfg in global_mcps:
            affinity = _skill_affinity(cfg)
            if affinity is not None and h_id not in affinity:
                continue
            specs.append(_spec_from_skill(name, cfg))

        global_path = Path(str(h.global_mcp_config)).expanduser()
        prior = _read_global_mcp_sidecar(h_id)
        try:
            result = adapter.write_global(global_path, specs, prior, harness_id=h_id)
        except Exception as e:
            print(f"  {c('!', RED)} {h.label} global MCP write failed: {e}")
            continue

        if result.aborted:
            # File untouched; do NOT rewrite the sidecar (preserve prior claim).
            continue

        # Record the new ownership set (even on a no-op, to (re)establish the
        # sidecar so future cleanups are scoped).
        _write_global_mcp_sidecar(h_id, result.managed)

        if report is not None:
            report["global"]["mcp"]["writes"] += len(result.added)
            report["global"]["mcp"]["removed"] += len(result.removed)

        if result.changed:
            any_written = True
            parts = []
            if result.added:
                parts.append(f"+{len(result.added)}")
            if result.removed:
                parts.append(f"-{len(result.removed)}")
            detail = f" ({', '.join(parts)})" if parts else ""
            print(f"  {c('✓', GREEN)} {h.label} → {global_path}{detail}")
        else:
            print(f"  {c('·', DIM)} {h.label} unchanged ({len(result.managed)} managed)")

    if not global_mcps and not any_written:
        print(f"  {c('·', DIM)} no scope:global MCP servers registered")


# ─────────────────────────────────────────────────────────────────────────────
# Remote dispatch (publishable remote connectors) — runs after the global-MCP
# pass, mirroring its structure. Non-blocking: an unreachable remote, drift, or
# conflict NEVER fails sync (spec: remote-sync-dispatch).
# ─────────────────────────────────────────────────────────────────────────────


def build_remote_desired_state(remote_cfg: dict, registry: dict):
    """Resolve a remote's `DesiredState` (skills + mcp specs) from the registry.

    Reuses `resolve_remote_skills` (project equip semantics) and the local skill
    source dirs the hub already manages. Each skill becomes a `DesiredItem` whose
    payload is the connector-internal skill-tree blob; each scope-agnostic
    mcp-server skill becomes an mcp `DesiredItem`. Agent docs are resolved by the
    connector itself (it owns the SOUL/MEMORY/USER round-trip), so the dispatch
    leaves `agent_docs` empty here.
    """
    from connectors import DesiredItem, DesiredState
    from connectors import hermes as _hermes
    from connectors.layouts import agentskills
    from remotes import resolve_remote_skills

    skills = registry.get("skills", {})
    resolved = resolve_remote_skills(remote_cfg, registry)

    skill_items: list = []
    mcp_items: list = []
    for name in resolved:
        cfg = skills.get(name)
        if not cfg:
            continue
        if cfg.get("type") == "mcp-server":
            spec = {
                "command": cfg.get("mcp", {}).get("command", "python3"),
                "args": list(cfg.get("mcp", {}).get("args", [])),
                "env": dict(cfg.get("mcp", {}).get("env", {})),
            }
            blob = _hermes._encode_mcp_spec(spec)
            mcp_items.append(
                DesiredItem(
                    name=name,
                    kind="mcp",
                    sha256=hashlib.sha256(_hermes._canonical_mcp_bytes(spec)).hexdigest(),
                    payload=blob,
                )
            )
            continue
        src = skill_source(cfg)
        if not src.exists():
            continue
        tree = agentskills.read_skill_dir(src)
        skill_items.append(
            DesiredItem(
                name=name,
                kind="skill",
                sha256=agentskills.tree_sha256(tree),
                payload=_hermes._encode_skill_tree(tree),
            )
        )

    return DesiredState(skills=tuple(skill_items), mcp=tuple(mcp_items), agent_docs=())


def _is_alarming_remote_failure(exc: Exception) -> bool:
    """L1: classify a dispatch failure as ALARMING (auth / host-key / integrity).

    An "unreachable" failure (connection refused, DNS, timeout, ssh exit 255) is
    EXPECTED and quiet. A host-key mismatch (possible MITM), an auth failure, or
    an integrity/confinement violation is ALARMING and surfaced prominently — and
    in `--strict` mode it exits non-zero (mirrors the permissions doctor).
    """
    from connectors.transport.ssh import HostKeyMismatch
    from connectors.hermes import UpgradeSafetyViolation

    # Host-key mismatch is the headline alarming case.
    if isinstance(exc, HostKeyMismatch):
        return True
    if isinstance(exc, UpgradeSafetyViolation):
        return True
    # Write-confinement / helper-protocol violations from the private connector.
    name = type(exc).__name__
    if name in ("WriteConfinementViolation", "HelperProtocolError", "SigningError"):
        return True
    # An ssh exit-255 (transport/auth) surfaces as SshCommandError; treat a
    # connection-level failure as unreachable (quiet) but an auth refusal as
    # alarming. We distinguish on the message: a "Permission denied" / auth string
    # is alarming, a "timed out" / "connect" / "refused" is unreachable.
    from connectors.transport.ssh import SshCommandError
    if isinstance(exc, SshCommandError):
        msg = (exc.stderr or str(exc)).lower()
        if "permission denied" in msg or "authentication" in msg or "publickey" in msg:
            return True
        return False
    return False


def _run_remote_dispatch(
    registry: dict,
    installed: set[str],
    *,
    only: Optional[str] = None,
    strict: bool = False,
    report: Optional[dict] = None,
) -> int:
    """Auto-sync each `sync_enabled` remote (after the global-MCP pass).

    For each remote: resolve desired state → `get_connector` → `health_check`
    (unreachable → log + skip, NON-FATAL) → `plan` → `apply` with the default
    allow set. Drift/conflict artifacts are reported, NEVER applied. The sidecar
    is rebased only for artifacts actually applied (handled inside `apply`).
    `only` restricts the pass to one remote id (used by `remote sync --force`,
    which also runs even when `sync_enabled` is False).

    L1: returns the count of ALARMING failures (auth / host-key-mismatch /
    integrity) — distinct from quiet "unreachable" skips. In `strict` mode the
    caller exits non-zero when this is > 0 (mirrors the permissions doctor).
    """
    from remotes import load_remotes
    from connectors import get_connector

    alarming = 0
    attempted = 0

    def _record():
        if report is not None:
            report["global"]["remotes"]["attempted"] = attempted
            report["global"]["remotes"]["alarming"] = alarming

    remotes_map = load_remotes(registry)
    if not remotes_map:
        if only is None:
            print(f"\n{c('Remotes:', BOLD)} none configured")
        _record()
        return alarming

    print(f"\n{c('Remotes:', BOLD)}")
    for remote_id, target in remotes_map.items():
        if only is not None and remote_id != only:
            continue
        if only is None and not target.sync_enabled:
            print(f"  {c('·', DIM)} {remote_id} skipped: sync disabled")
            continue

        try:
            connector = get_connector(target.connector)
        except KeyError as e:
            print(f"  {c('!', YELLOW)} {remote_id}: {e}")
            continue

        attempted += 1
        try:
            health = connector.health_check(target)
        except Exception as e:
            if _is_alarming_remote_failure(e):
                alarming += 1
                print(f"  {c('✗', RED)} {remote_id} ALARMING failure (auth/host-key): {e}")
            else:
                print(f"  {c('!', YELLOW)} {remote_id} unreachable: {e} — skipped")
            continue
        if not health.ok:
            # A host-key mismatch surfaces here as host_key_match=False while the
            # box IS reachable — that is ALARMING (possible MITM), not a quiet
            # skip. But a "could not read the host key" detail is really a
            # reachability problem (ssh-keyscan couldn't reach the box), NOT a
            # mismatch, so it stays quiet. A merely-unreachable box stays quiet.
            detail_l = (health.detail or "").lower()
            unreadable = "could not read" in detail_l or "to verify" in detail_l
            if health.reachable and not health.host_key_match and not unreadable:
                alarming += 1
                print(
                    f"  {c('✗', RED)} {remote_id} ALARMING: host-key mismatch "
                    f"(possible MITM): {health.detail}"
                )
            elif health.reachable and not health.authenticated and not unreadable:
                alarming += 1
                print(
                    f"  {c('✗', RED)} {remote_id} ALARMING: authentication failed: "
                    f"{health.detail}"
                )
            else:
                print(
                    f"  {c('!', YELLOW)} {remote_id} not ready "
                    f"(reachable={health.reachable} auth={health.authenticated} "
                    f"host_key={health.host_key_match}): {health.detail} — skipped"
                )
            continue

        remote_cfg = (registry.get("remotes") or {}).get(remote_id) or {}
        desired = build_remote_desired_state(remote_cfg, registry)
        try:
            plan = connector.plan(target, desired)
            result = connector.apply(target, plan)
        except Exception as e:
            if _is_alarming_remote_failure(e):
                alarming += 1
                print(f"  {c('✗', RED)} {remote_id} ALARMING dispatch failure: {e}")
            else:
                print(f"  {c('!', YELLOW)} {remote_id} dispatch error: {e} — skipped")
            continue

        # Report drift/conflict (skipped) — surfaced, never applied.
        from connectors import Action

        drifted = [a.name for a in plan.actions if a.action == Action.SKIP_REMOTE_DRIFTED]
        conflicts = [a.name for a in plan.actions if a.action == Action.SKIP_CONFLICT]

        parts = []
        if result.created:
            parts.append(f"+{len(result.created)}")
        if result.fast_forwarded:
            parts.append(f"~{len(result.fast_forwarded)}")
        if result.removed:
            parts.append(f"-{len(result.removed)}")
        detail = f" ({', '.join(parts)})" if parts else " (no changes)"
        print(f"  {c('✓', GREEN)} {remote_id}{detail}")
        if drifted:
            print(
                f"      {c('•', YELLOW)} remote-drifted (not applied): "
                f"{', '.join(sorted(drifted))} — resolve with "
                f"`hub remote resolve {remote_id} --artifact <name> --op pull`"
            )
        if conflicts:
            print(
                f"      {c('!', RED)} conflict (not applied): "
                f"{', '.join(sorted(conflicts))} — resolve with "
                f"`hub remote resolve {remote_id} --artifact <name> --op ...`"
            )
        if result.errors:
            for err in result.errors:
                # L1: an integrity/signing failure (the manifest attestation) is
                # ALARMING; a generic per-artifact error stays a warning.
                lowered = err.lower()
                if "manifest" in lowered or "sign" in lowered or "integrity" in lowered:
                    alarming += 1
                    print(f"      {c('✗', RED)} ALARMING (integrity): {err}")
                else:
                    print(f"      {c('!', RED)} {err}")

    _record()
    if strict and alarming:
        print(
            f"\n  {c('✗', RED)} {alarming} alarming remote failure(s) "
            f"(auth/host-key/integrity) — strict mode"
        )
    return alarming


# ─────────────────────────────────────────────────────────────────────────────
# Bootstrap, migration, import
# ─────────────────────────────────────────────────────────────────────────────

MIN_PYTHON = (3, 9)


def _now_iso() -> str:
    return _dt.datetime.now(tz=_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _empty_registry() -> dict:
    return {"version": "1", "skills": {}, "projects": {}, "bundles": {}}


def _read_registry_optional() -> dict:
    reg_file = registry_file()
    if not reg_file.exists():
        return _empty_registry()
    with open(reg_file) as f:
        data = yaml.safe_load(f) or {}
    return data


def bootstrap_state(registry: Optional[dict] = None) -> dict:
    """Return current bootstrap status without side effects."""
    reg = registry if registry is not None else _read_registry_optional()
    info = reg.get("bootstrap") or {}
    completed_at = info.get("completed_at")
    return {
        "needs_bootstrap": not completed_at,
        "completed_at": completed_at,
        "version": info.get("version", 1),
        "legacy_detected": [str(p) for p in legacy_data_home_candidates()],
    }


def _sha256_file(path: Path) -> Optional[str]:
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _parse_skill_md(skill_md: Path) -> Optional[dict]:
    """Return {name, description, version} or None."""
    if not skill_md.exists():
        return None
    try:
        text = skill_md.read_text()
    except OSError:
        return None
    if not text.startswith("---"):
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None
    try:
        meta = yaml.safe_load(parts[1]) or {}
    except yaml.YAMLError:
        return None
    if not isinstance(meta, dict):
        return None
    name = meta.get("name")
    if not name:
        return None
    return {
        "name": str(name).strip(),
        "description": str(meta.get("description") or "").strip(),
        "version": str(meta.get("version") or "1.0.0").strip(),
    }


def scan_import_candidates(registry: Optional[dict] = None) -> list[dict]:
    """Enumerate global skill dirs; classify each candidate.

    Categories:
      NEW                 — valid slug, not in registry, no symlink to hub
      CONFLICT            — name collides with existing, SKILL.md SHA differs
      SILENT_SKIP         — name collides, SHA matches (already imported equivalent)
      ALREADY_MANAGED     — symlink target lies under data_home/skills/
      INVALID_NAME        — name fails slug pattern
      BROKEN              — dangling symlink
    """
    reg = registry if registry is not None else _read_registry_optional()
    existing = reg.get("skills") or {}
    data_skills = str(data_home() / "skills") + os.sep

    candidates: list[dict] = []
    for origin, root in IMPORT_SCAN_ROOTS:
        if not root.exists():
            continue
        for entry in sorted(root.iterdir()):
            if entry.name.startswith("."):
                continue

            is_symlink = entry.is_symlink()
            link_target_str: Optional[str] = None
            if is_symlink:
                try:
                    link_target_str = os.readlink(entry)
                    if not os.path.isabs(link_target_str):
                        link_target_str = str(
                            (entry.parent / link_target_str).resolve()
                        )
                except OSError:
                    link_target_str = None

            # Dangling symlink check
            target_exists = entry.exists()  # follows symlink
            broken = is_symlink and not target_exists

            # Hub-managed check via literal target string
            hub_managed = bool(
                link_target_str and link_target_str.startswith(data_skills)
            )

            skill_md = entry / "SKILL.md"
            meta = _parse_skill_md(skill_md)

            base = {
                "origin": origin,
                "path": str(entry),
                "name": meta.get("name") if meta else None,
                "version": meta.get("version") if meta else None,
                "description": meta.get("description") if meta else None,
                "broken": broken,
            }

            if hub_managed:
                base["category"] = "ALREADY_MANAGED"
                candidates.append(base)
                continue

            if meta is None:
                # Skip silently — no SKILL.md / no frontmatter / no name
                continue

            if not SLUG_RE.match(meta["name"]):
                base["category"] = "INVALID_NAME"
                base["reason"] = "must match ^[a-z0-9-]+$"
                candidates.append(base)
                continue

            if meta["name"] in existing:
                cand_hash = _sha256_file(skill_md)
                existing_src = expand(existing[meta["name"]]["source"])
                existing_hash = _sha256_file(existing_src / "SKILL.md")
                if cand_hash and existing_hash and cand_hash == existing_hash:
                    base["category"] = "SILENT_SKIP"
                else:
                    base["category"] = "CONFLICT"
                    base["candidate_sha"] = (cand_hash or "")[:12]
                    base["existing_sha"] = (existing_hash or "")[:12]
                    base["existing_source"] = str(existing_src)
                candidates.append(base)
                continue

            base["category"] = "BROKEN" if broken else "NEW"
            candidates.append(base)

    # Dedupe by name across origins. Order priority follows IMPORT_SCAN_ROOTS
    # iteration order: earlier origins win. So `~/.agents/skills/` (codex
    # documented current) precedes `~/.codex/skills/` (legacy-codex); when both
    # carry the same skill name, the legacy candidate is dropped.
    deduped: list[dict] = []
    seen_names: set[str] = set()
    for cand in candidates:
        name = cand.get("name")
        if not name:
            deduped.append(cand)
            continue
        if name in seen_names:
            continue
        seen_names.add(name)
        deduped.append(cand)
    return deduped


def apply_import(
    registry: dict,
    selections: list[dict],
    conflict_actions: Optional[dict] = None,
    adopt_set: Optional[set] = None,
) -> dict:
    """Mutate registry in-place with the user's selections.

    selections: list of candidate dicts (each must have name, path, origin, category).
    conflict_actions: {name: "skip"|"replace"|"suffix"} for CONFLICT candidates.
    adopt_set: set of names to adopt (copy into data home).
    """
    conflict_actions = conflict_actions or {}
    adopt_set = adopt_set or set()
    skills = registry.setdefault("skills", {})
    result = {
        "registered": [],
        "replaced": [],
        "suffixed": [],
        "skipped": [],
        "adopted": [],
    }

    for cand in selections:
        category = cand.get("category")
        name = cand.get("name")
        if not name or category in ("ALREADY_MANAGED", "SILENT_SKIP", "INVALID_NAME"):
            result["skipped"].append({"name": name, "reason": category})
            continue

        # Determine source path (in-place vs adopted)
        source_path = Path(cand["path"])
        if name in adopt_set:
            dest = hub_skills_dir() / name
            if dest.exists():
                result["skipped"].append({"name": name, "reason": "adopt_collision"})
                # Fall back to register-in-place
            else:
                shutil.copytree(source_path, dest, symlinks=True, dirs_exist_ok=False)
                source_path = dest
                result["adopted"].append(name)

        source_str = collapse_home(source_path)
        new_entry = {
            "version": cand.get("version") or "1.0.0",
            "description": cand.get("description") or "",
            "source": source_str,
            "type": "claude-skill",
            "scope": "global",
            "upstream": None,
        }

        if category == "CONFLICT":
            action = conflict_actions.get(name, "skip")
            if action == "skip":
                result["skipped"].append({"name": name, "reason": "conflict_skip"})
                continue
            elif action == "replace":
                if name in skills:
                    skills[name]["source"] = source_str
                    result["replaced"].append(name)
                else:
                    skills[name] = new_entry
                    result["registered"].append(name)
                continue
            elif action == "suffix":
                suffixed = f"{name}-{cand['origin']}"
                if suffixed in skills:
                    result["skipped"].append(
                        {"name": suffixed, "reason": "suffix_collision"}
                    )
                    continue
                new_entry_copy = dict(new_entry)
                skills[suffixed] = new_entry_copy
                result["suffixed"].append(suffixed)
                continue
            else:
                result["skipped"].append(
                    {"name": name, "reason": f"unknown_action:{action}"}
                )
                continue

        # NEW or BROKEN
        if name in skills:
            # Race: another selection already handled it
            result["skipped"].append({"name": name, "reason": "already_present"})
            continue
        skills[name] = new_entry
        result["registered"].append(name)

    return result


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
    return data_home() / "sources"


def source_cache_dir(source_id: str) -> Path:
    """Per-source cache root: <data_home>/sources/<id>/."""
    return sources_dir() / source_id


def source_worktree_dir(source_id: str) -> Path:
    """Per-source Git worktree path used as the cache backing store."""
    return source_cache_dir(source_id) / "worktree"


def validate_source_id(source_id: str) -> None:
    """Validate a source id slug. Exit with a friendly error on failure."""
    if not isinstance(source_id, str) or not source_id:
        fail("source id must be a non-empty string")
    if not SLUG_RE.match(source_id):
        fail(
            f"Invalid source id '{source_id}'. "
            "Use lowercase letters, numbers, and hyphens only."
        )
    if source_id in BUILT_IN_SOURCE_IDS:
        fail(
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
    return code_home() / "skills"


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


def _git_source_view(source_id: str, cfg: dict) -> dict:
    """Public-facing dict for a configured git source, filling sensible defaults."""
    return {
        "id": source_id,
        "type": "git",
        "name": cfg.get("name") or source_id,
        "url": cfg.get("url"),
        "branch": cfg.get("branch"),
        "path": cfg.get("path") or "",
        "auth": cfg.get("auth") or "system-git",
        "cache": cfg.get("cache") or str(source_worktree_dir(source_id)),
        "current_ref": cfg.get("current_ref"),
        "remote_ref": cfg.get("remote_ref"),
        "status": cfg.get("status") or SOURCE_STATUS_UNKNOWN,
        "last_checked_at": cfg.get("last_checked_at"),
        "last_synced_at": cfg.get("last_synced_at"),
        "error": cfg.get("error"),
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
            "status": SOURCE_STATUS_LOCAL,
        },
        "starter": {
            "id": "starter",
            "type": "starter",
            "name": "Starter Pack",
            "builtin": True,
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
                    "builtin": False,
                }
            else:
                entry = {
                    "id": sid,
                    "type": stype,
                    "name": scfg.get("name") or sid,
                    "status": scfg.get("status") or SOURCE_STATUS_UNKNOWN,
                    "builtin": False,
                }
            entry["skill_count"] = counts.get(sid, 0)
            out.append(entry)
    return out


def get_source(registry: dict, source_id: str) -> Optional[dict]:
    """Return a single source view (built-in or configured), or None."""
    for entry in list_sources(registry):
        if entry["id"] == source_id:
            return entry
    return None


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
    return errors


# ─────────────────────────────────────────────────────────────────────────────
# `hub source` commands (read-only inspection — write commands land in §2/§3)
# ─────────────────────────────────────────────────────────────────────────────


def _fmt_iso_display(value: Optional[str]) -> str:
    return value if value else "—"


def cmd_source_list(args):
    registry = load_registry()
    errors = validate_sources_registry(registry)
    sources = list_sources(registry)
    payload = {"sources": sources, "errors": errors}
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2, sort_keys=False))
        return

    for err in errors:
        print(f"{c('!', YELLOW)} {err}", file=sys.stderr)
    if not sources:
        print("No sources configured.")
        return
    header = f"{'ID':24} {'TYPE':10} {'NAME':24} {'STATUS':18} SKILLS"
    print(c(header, BOLD))
    for s in sources:
        sid = s["id"]
        stype = s["type"]
        name = s.get("name") or sid
        status = s.get("status") or "—"
        count = s.get("skill_count", 0)
        print(f"{sid:24} {stype:10} {name:24} {status:18} {count}")


def cmd_source_status(args):
    registry = load_registry()
    errors = validate_sources_registry(registry)
    sid = args.id
    entry = get_source(registry, sid)
    payload = {"source": entry, "skills": [], "errors": errors}
    if entry is None:
        payload["error"] = f"source '{sid}' not found"
        if getattr(args, "json", False):
            print(json.dumps(payload, indent=2, sort_keys=False))
            return
        print(payload["error"], file=sys.stderr)
        sys.exit(1)
    payload["skills"] = imported_skills_for_source(registry, sid)
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2, sort_keys=False))
        return

    name = entry.get("name") or sid
    print(
        f"{c(name, BOLD)} ({sid})  type={entry['type']}  status={entry.get('status') or '—'}"
    )
    if entry["type"] == "git":
        print(f"  url:           {entry.get('url') or '—'}")
        print(f"  branch:        {entry.get('branch') or '—'}")
        print(f"  path:          {entry.get('path') or '/'}")
        print(f"  current_ref:   {entry.get('current_ref') or '—'}")
        print(f"  remote_ref:    {entry.get('remote_ref') or '—'}")
        print(f"  last_checked:  {_fmt_iso_display(entry.get('last_checked_at'))}")
        print(f"  last_synced:   {_fmt_iso_display(entry.get('last_synced_at'))}")
        if entry.get("error"):
            print(f"  {c('error', RED)}:         {entry['error']}")
    print(f"  managed skills: {len(payload['skills'])}")
    for s in payload["skills"]:
        print(f"    - {s['name']}  ({s.get('scope') or '—'})")


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


def parse_git_url(url: str) -> dict:
    """Parse a Git URL, honoring GitHub-style ``tree/<branch>/<path>`` form.

    Returns ``{"clone_url": str, "branch": Optional[str], "path": Optional[str]}``.
    For SSH form (``git@host:owner/repo.git``) or plain HTTPS, branch/path are
    None.
    """
    if not isinstance(url, str) or not url.strip():
        raise ValueError("git url is required")
    url = url.strip()
    m = re.match(
        r"^(?P<base>https?://[^/]+/[^/]+/[^/]+?)(?:\.git)?(?:/tree/(?P<branch>[^/]+)(?:/(?P<path>.+?))?/?)?$",
        url,
    )
    if m and m.group("branch"):
        base = m.group("base")
        clone_url = base if base.endswith(".git") else base + ".git"
        return {
            "clone_url": clone_url,
            "branch": m.group("branch"),
            "path": (m.group("path") or None),
        }
    return {"clone_url": url, "branch": None, "path": None}


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
    nested skills). Other directories are recursed into up to ``MAX_SCAN_DEPTH``
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
            # This dir is itself a skill — record it and don't descend further.
            add_candidate(d, cand)
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


def _emit_or_print(payload: dict, args, fallback_line: str) -> None:
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2, sort_keys=False))
    else:
        print(fallback_line)


FIRST_DEDUP_SUFFIX = 2  # "-2" is the first generated suffix: base, base-2, base-3, …
# The source-import conflict-decision vocabulary (CLI --decisions-stdin contract).
CONFLICT_DECISION_ACTIONS = ("skip", "replace", "suffix")


def _dedup_suffix_name(base: str, skills_block: dict) -> str:
    """Return the first free ``<base>-N`` not present in ``skills_block``."""
    i = FIRST_DEDUP_SUFFIX
    while f"{base}-{i}" in skills_block:
        i += 1
    return f"{base}-{i}"


def _fail_source_apply(args, message: str, clone_dest: Path):
    """Abort a source-add apply cleanly (no partial write): drop the clone cache,
    emit the error via the caller's JSON/plain channel, and exit non-zero."""
    payload = {"ok": False, "error": message}
    try:
        if clone_dest.exists():
            shutil.rmtree(clone_dest, ignore_errors=True)
    except OSError:
        pass
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
    else:
        print(f"{c('error', RED)}: {message}", file=sys.stderr)
    sys.exit(1)


def cmd_source_add_git(args):
    """``hub source add git <url> [...]`` — clone, scan, optionally register."""
    parsed_url = parse_git_url(args.url)
    clone_url = parsed_url["clone_url"]
    branch = args.branch or parsed_url["branch"]
    raw_path = args.path if args.path is not None else (parsed_url["path"] or "")
    source_id = args.id or derive_source_id_from_url(clone_url)
    validate_source_id(source_id)

    # Subpath safety: validate the configured subdir is repo-relative before clone.
    if raw_path:
        try:
            normalize_subpath_within(Path("/__placeholder_root__"), raw_path)
        except ValueError as exc:
            payload = {"ok": False, "error": str(exc)}
            if getattr(args, "json", False):
                print(json.dumps(payload, indent=2))
            else:
                print(f"{c('error', RED)}: {exc}", file=sys.stderr)
            sys.exit(1)

    if args.dry_run:
        stage_root = Path(tempfile.mkdtemp(prefix=f"skill-hub-src-{source_id}-"))
        clone_dest = stage_root / "worktree"
        registry = _read_registry_optional()
        try:
            _do_source_add_clone_and_report(
                args=args,
                source_id=source_id,
                clone_url=clone_url,
                branch=branch,
                raw_path=raw_path,
                clone_dest=clone_dest,
                registry=registry,
                apply=False,
            )
        finally:
            shutil.rmtree(stage_root, ignore_errors=True)
        return

    with data_home_lock():
        registry = load_registry()
        existing_sources = registry.get("sources")
        if isinstance(existing_sources, dict) and source_id in existing_sources:
            payload = {"ok": False, "error": f"source '{source_id}' already exists"}
            if getattr(args, "json", False):
                print(json.dumps(payload, indent=2))
            else:
                print(payload["error"], file=sys.stderr)
            sys.exit(1)
        cache_root = source_cache_dir(source_id)
        cache_root.mkdir(parents=True, exist_ok=True)
        clone_dest = cache_root / "worktree"
        if clone_dest.exists():
            shutil.rmtree(clone_dest)
        _do_source_add_clone_and_report(
            args=args,
            source_id=source_id,
            clone_url=clone_url,
            branch=branch,
            raw_path=raw_path,
            clone_dest=clone_dest,
            registry=registry,
            apply=True,
        )


def _do_source_add_clone_and_report(
    *,
    args,
    source_id: str,
    clone_url: str,
    branch: Optional[str],
    raw_path: str,
    clone_dest: Path,
    registry: dict,
    apply: bool,
) -> None:
    """Shared body for dry-run preview and apply. Caller owns lock + cleanup."""
    clone = _git_clone(clone_url, branch, clone_dest)
    if not clone["ok"]:
        payload = {"ok": False, "error": clone["error"]}
        if apply and clone_dest.exists():
            shutil.rmtree(clone_dest, ignore_errors=True)
        if getattr(args, "json", False):
            print(json.dumps(payload, indent=2))
        else:
            print(f"{c('error', RED)}: {clone['error']}", file=sys.stderr)
        sys.exit(1)

    candidates = discover_candidates(clone_dest, raw_path or "")
    classified = classify_candidates(candidates, registry, source_id)
    counts = candidate_counts(classified)

    source_meta = {
        "type": "git",
        "name": args.name or source_id,
        "url": clone_url,
        "branch": branch,
        "path": raw_path or "",
        "auth": "system-git",
        "cache": str(clone_dest),
        "current_ref": clone["ref"],
        "remote_ref": None,
        "status": SOURCE_STATUS_UP_TO_DATE,
        "last_checked_at": _now_iso(),
        "last_synced_at": _now_iso() if apply else None,
        "error": None,
    }

    if not apply:
        payload = {
            "ok": True,
            "preview": True,
            "source": {"id": source_id, **source_meta},
            "candidates": classified,
            "counts": counts,
        }
        if getattr(args, "json", False):
            print(json.dumps(payload, indent=2))
        else:
            print(
                f"preview '{source_id}': new={counts['new']} conflicts={counts['conflicts']} "
                f"imported={counts['imported']} invalid={counts['invalid']}"
            )
            for cand in classified:
                print(
                    f"  [{cand['category']:8}] {cand['name']}  ({cand.get('origin_path', '')})"
                )
        return

    sources_block = registry.setdefault("sources", {})
    sources_block[source_id] = source_meta
    skills_block = registry.setdefault("skills", {})

    # Per-conflict decisions channel (D7). Only read stdin when the flag is set;
    # absent ⇒ empty map ⇒ every CONFLICT candidate defaults to skip (the legacy
    # behavior). Unknown actions are rejected up front, BEFORE any staging, so a
    # malformed decision can never produce a partial `save_registry`.
    decisions: dict = {}
    if getattr(args, "decisions_stdin", False):
        try:
            raw_stdin = sys.stdin.read()
            stdin_payload = json.loads(raw_stdin) if raw_stdin.strip() else {}
        except json.JSONDecodeError as exc:
            _fail_source_apply(args, f"invalid decisions JSON: {exc}", clone_dest)
        decisions = (stdin_payload or {}).get("decisions") or {}
        if not isinstance(decisions, dict):
            _fail_source_apply(args, "decisions must be an object", clone_dest)
        for cand_name, action in decisions.items():
            if action not in CONFLICT_DECISION_ACTIONS:
                _fail_source_apply(
                    args,
                    f"unknown decision '{action}' for candidate '{cand_name}' "
                    f"(expected skip|replace|suffix)",
                    clone_dest,
                )

    def _build_source_entry(cand: dict) -> dict:
        origin_path = cand["origin_path"]
        skill_source_dir = clone_dest / origin_path if origin_path else clone_dest
        return {
            "version": cand.get("version") or "1.0.0",
            "description": cand.get("description") or "",
            "source": str(skill_source_dir),
            "type": "claude-skill",
            "scope": "portable",
            "upstream": clone_url,
            "managed": "external",
            "origin": {
                "source": source_id,
                "source_type": "git",
                "path": origin_path,
                "ref": clone["ref"],
            },
        }

    registered: list[str] = []
    skipped: list[dict] = []
    resolved: list[dict] = []
    for cand in classified:
        category = cand["category"]
        name = cand["name"]
        if category == "NEW":
            skills_block[name] = _build_source_entry(cand)
            registered.append(name)
            continue
        if category == "CONFLICT":
            action = decisions.get(name, "skip")
            if action == "skip":
                skipped.append({"name": name, "reason": "CONFLICT"})
                resolved.append({"name": name, "action": "skip", "final_name": None})
                continue
            if action == "replace":
                skills_block[name] = _build_source_entry(cand)
                registered.append(name)
                resolved.append(
                    {"name": name, "action": "replace", "final_name": name}
                )
                continue
            # suffix — register the source candidate under a de-duplicated name,
            # leaving the existing skill intact.
            final_name = _dedup_suffix_name(name, skills_block)
            skills_block[final_name] = _build_source_entry(cand)
            registered.append(final_name)
            resolved.append(
                {"name": name, "action": "suffix", "final_name": final_name}
            )
            continue
        # IMPORTED / INVALID — never touched.
        skipped.append({"name": name, "reason": category})

    save_registry(registry)

    payload = {
        "ok": True,
        "preview": False,
        "source": {"id": source_id, **source_meta},
        "candidates": classified,
        "counts": counts,
        "registered": registered,
        "skipped": skipped,
        "resolved": resolved,
    }
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
    else:
        print(f"Registered source '{source_id}' with {len(registered)} skills.")
        for name in registered:
            print(f"  + {name}")
        for s in skipped:
            print(f"  - {s['name']} ({s['reason']})")


# ─────────────────────────────────────────────────────────────────────────────
# §3 Source check / sync / remove
#
# Lifecycle commands:
#   hub source check <id>   git fetch + compare refs; mutate status only.
#   hub source sync  <id>   pull configured branch, rescan candidates, update
#                           metadata; classify added/changed/removed; flag
#                           removed-upstream skills as source-missing without
#                           silently deleting them.
#   hub source remove <id>  --dry-run preview blast radius; --mode unequip
#                           tears down everything owned by the source; --mode
#                           keep-local converts owned skills into data-home
#                           local skills before removing the source entry.
#
# Mutation order across all three (design D7): stage filesystem first, acquire
# data-home lock, write registry, then run/prompt sync, then clean caches.
# ─────────────────────────────────────────────────────────────────────────────


def _require_configured_git_source(registry: dict, source_id: str) -> dict:
    """Return the raw registry source dict, or exit with a friendly error."""
    sources = registry.get("sources") if isinstance(registry, dict) else None
    if not isinstance(sources, dict) or source_id not in sources:
        fail(f"source '{source_id}' not found")
    cfg = sources[source_id]
    if not isinstance(cfg, dict):
        fail(f"source '{source_id}' has invalid configuration")
    if (cfg.get("type") or "git") != "git":
        fail(f"source '{source_id}' is not a git source")
    return cfg


def _git_fetch(checkout_dir: Path, branch: Optional[str]) -> dict:
    """Run ``git fetch origin <branch>``. Returns ``{ok, remote_ref, error}``."""
    args = ["fetch", "--quiet", "origin"]
    if branch:
        args.append(branch)
    try:
        res = _run_git(args, cwd=checkout_dir)
    except FileNotFoundError:
        return {"ok": False, "remote_ref": None, "error": "git executable not found"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "remote_ref": None, "error": "git fetch timed out"}
    if res.returncode != 0:
        msg = (res.stderr or res.stdout or "git fetch failed").strip()
        return {"ok": False, "remote_ref": None, "error": msg}
    ref_res = _run_git(["rev-parse", "FETCH_HEAD"], cwd=checkout_dir)
    remote_ref = ref_res.stdout.strip() if ref_res.returncode == 0 else None
    return {"ok": True, "remote_ref": remote_ref, "error": None}


def _git_checkout_fetched(checkout_dir: Path) -> dict:
    """Hard-reset the checkout to ``FETCH_HEAD``. Returns ``{ok, ref, error}``."""
    res = _run_git(["reset", "--hard", "FETCH_HEAD"], cwd=checkout_dir)
    if res.returncode != 0:
        msg = (res.stderr or res.stdout or "git reset failed").strip()
        return {"ok": False, "ref": None, "error": msg}
    ref_res = _run_git(["rev-parse", "HEAD"], cwd=checkout_dir)
    return {
        "ok": True,
        "ref": ref_res.stdout.strip() if ref_res.returncode == 0 else None,
        "error": None,
    }


def cmd_source_check(args):
    """`hub source check <id>` — fetch remote refs, compare, do not mutate skill files."""
    source_id = args.id
    with data_home_lock():
        registry = load_registry()
        cfg = _require_configured_git_source(registry, source_id)
        checkout = Path(cfg.get("cache") or str(source_worktree_dir(source_id)))
        if not checkout.exists():
            fail(
                f"source '{source_id}' cache missing at {checkout}; run sync to recreate"
            )

        fetch = _git_fetch(checkout, cfg.get("branch"))
        cfg["last_checked_at"] = _now_iso()
        if not fetch["ok"]:
            cfg["status"] = SOURCE_STATUS_ERROR
            cfg["error"] = fetch["error"]
            save_registry(registry)
            payload = {"ok": False, "source_id": source_id, "error": fetch["error"]}
            if getattr(args, "json", False):
                print(json.dumps(payload, indent=2))
            else:
                print(f"{c('error', RED)}: {fetch['error']}", file=sys.stderr)
            sys.exit(1)

        current_ref = cfg.get("current_ref")
        remote_ref = fetch["remote_ref"]
        cfg["remote_ref"] = remote_ref
        cfg["error"] = None
        if current_ref and remote_ref and current_ref == remote_ref:
            status = SOURCE_STATUS_UP_TO_DATE
        else:
            status = SOURCE_STATUS_UPDATE_AVAILABLE
        cfg["status"] = status
        save_registry(registry)

        payload = {
            "ok": True,
            "source_id": source_id,
            "status": status,
            "current_ref": current_ref,
            "remote_ref": remote_ref,
            "last_checked_at": cfg["last_checked_at"],
        }
        if getattr(args, "json", False):
            print(json.dumps(payload, indent=2))
        else:
            print(
                f"{source_id}: {status} (current {current_ref} → remote {remote_ref})"
            )


def cmd_source_sync(args):
    """`hub source sync <id>` — pull, rescan, update metadata, classify deltas."""
    source_id = args.id
    with data_home_lock():
        registry = load_registry()
        cfg = _require_configured_git_source(registry, source_id)
        checkout = Path(cfg.get("cache") or str(source_worktree_dir(source_id)))
        if not checkout.exists():
            fail(f"source '{source_id}' cache missing at {checkout}; remove and re-add")

        fetch = _git_fetch(checkout, cfg.get("branch"))
        if not fetch["ok"]:
            cfg["status"] = SOURCE_STATUS_ERROR
            cfg["error"] = fetch["error"]
            cfg["last_checked_at"] = _now_iso()
            save_registry(registry)
            payload = {"ok": False, "source_id": source_id, "error": fetch["error"]}
            if getattr(args, "json", False):
                print(json.dumps(payload, indent=2))
            else:
                print(f"{c('error', RED)}: {fetch['error']}", file=sys.stderr)
            sys.exit(1)

        co = _git_checkout_fetched(checkout)
        if not co["ok"]:
            cfg["status"] = SOURCE_STATUS_ERROR
            cfg["error"] = co["error"]
            save_registry(registry)
            payload = {"ok": False, "source_id": source_id, "error": co["error"]}
            if getattr(args, "json", False):
                print(json.dumps(payload, indent=2))
            else:
                print(f"{c('error', RED)}: {co['error']}", file=sys.stderr)
            sys.exit(1)

        new_ref = co["ref"]
        raw_path = cfg.get("path") or ""
        upstream_candidates = discover_candidates(checkout, raw_path)
        upstream_by_name = {c["name"]: c for c in upstream_candidates}

        skills_block = registry.setdefault("skills", {})
        owned_now = {
            name: scfg
            for name, scfg in skills_block.items()
            if isinstance(scfg, dict)
            and isinstance(scfg.get("origin"), dict)
            and scfg["origin"].get("source") == source_id
        }

        added: list[str] = []
        changed: list[str] = []
        removed: list[str] = []
        unchanged: list[str] = []

        # Update / classify still-present and removed skills.
        for name, scfg in owned_now.items():
            if name in upstream_by_name:
                cand = upstream_by_name[name]
                old_desc = scfg.get("description")
                old_version = scfg.get("version")
                old_path = (scfg.get("origin") or {}).get("path")
                if (
                    old_desc != cand.get("description")
                    or old_version != cand.get("version")
                    or old_path != cand["origin_path"]
                ):
                    scfg["description"] = cand.get("description") or ""
                    scfg["version"] = cand.get("version") or "1.0.0"
                    origin = scfg.setdefault("origin", {})
                    origin["source"] = source_id
                    origin["source_type"] = "git"
                    origin["path"] = cand["origin_path"]
                    origin["ref"] = new_ref
                    scfg["source"] = (
                        str(checkout / cand["origin_path"])
                        if cand["origin_path"]
                        else str(checkout)
                    )
                    scfg.pop("source_missing", None)
                    changed.append(name)
                else:
                    origin = scfg.setdefault("origin", {})
                    origin["ref"] = new_ref
                    scfg.pop("source_missing", None)
                    unchanged.append(name)
            else:
                # Removed upstream — do NOT delete. Mark as source-missing for UI resolution.
                scfg["source_missing"] = True
                removed.append(name)

        # Classify upstream-new candidates: do not auto-register; surface for UI.
        new_pending: list[dict] = []
        for cand in upstream_candidates:
            if cand["name"] in owned_now:
                continue
            # Reuse classification against current registry (might collide with local skills).
            classified = classify_candidates([cand], registry, source_id)[0]
            if classified["category"] == "NEW":
                added.append(cand["name"])
            new_pending.append(classified)

        cfg["current_ref"] = new_ref
        cfg["remote_ref"] = fetch["remote_ref"]
        cfg["status"] = SOURCE_STATUS_UP_TO_DATE
        cfg["error"] = None
        cfg["last_checked_at"] = _now_iso()
        cfg["last_synced_at"] = _now_iso()
        save_registry(registry)

        payload = {
            "ok": True,
            "source_id": source_id,
            "ref": new_ref,
            "added": added,
            "changed": changed,
            "removed_upstream": removed,
            "unchanged": unchanged,
            "new_pending": new_pending,
            "needs_hub_sync": bool(changed or removed),
        }
        if getattr(args, "json", False):
            print(json.dumps(payload, indent=2))
        else:
            print(f"synced '{source_id}' → {new_ref}")
            print(f"  +new      {added}")
            print(f"  ~changed  {changed}")
            print(f"  -removed  {removed}")


def _source_remove_impact(registry: dict, source_id: str) -> dict:
    """Compute blast-radius preview for a source removal."""
    skills_block = registry.get("skills") or {}
    owned = []
    if isinstance(skills_block, dict):
        for name, scfg in skills_block.items():
            if not isinstance(scfg, dict):
                continue
            origin = scfg.get("origin") if isinstance(scfg.get("origin"), dict) else {}
            if origin.get("source") == source_id:
                owned.append(name)

    owned_set = set(owned)
    bundles_block = registry.get("bundles") if isinstance(registry, dict) else None
    affected_bundles: list[dict] = []
    if isinstance(bundles_block, dict):
        for bname, bcfg in bundles_block.items():
            if not isinstance(bcfg, dict):
                continue
            bskills = bcfg.get("skills") or []
            hit = [s for s in bskills if s in owned_set]
            if hit:
                affected_bundles.append({"name": bname, "skills": hit})

    projects_block = registry.get("projects") if isinstance(registry, dict) else None
    affected_projects: list[dict] = []
    if isinstance(projects_block, dict):
        bundles_for_lookup = bundles_block or {}
        for pname, pcfg in projects_block.items():
            if not isinstance(pcfg, dict):
                continue
            enabled = [s for s in (pcfg.get("enabled") or []) if s in owned_set]
            via_bundles: list[dict] = []
            for bname in pcfg.get("bundles") or []:
                bdef = (
                    bundles_for_lookup.get(bname)
                    if isinstance(bundles_for_lookup, dict)
                    else None
                )
                if isinstance(bdef, dict):
                    bhit = [s for s in (bdef.get("skills") or []) if s in owned_set]
                    if bhit:
                        via_bundles.append({"bundle": bname, "skills": bhit})
            if enabled or via_bundles:
                affected_projects.append(
                    {
                        "name": pname,
                        "enabled": enabled,
                        "via_bundles": via_bundles,
                    }
                )

    return {
        "source_id": source_id,
        "owned_skills": owned,
        "affected_bundles": affected_bundles,
        "affected_projects": affected_projects,
        "generated_links_refresh": [p["name"] for p in affected_projects],
    }


def _apply_source_remove_unequip(
    registry: dict, source_id: str, owned: list[str]
) -> None:
    """In-place mutation: drop owned skills + scrub bundles/projects + drop source."""
    skills_block = registry.get("skills") or {}
    for name in owned:
        skills_block.pop(name, None)
    bundles_block = registry.get("bundles") or {}
    if isinstance(bundles_block, dict):
        for bcfg in bundles_block.values():
            if not isinstance(bcfg, dict):
                continue
            bskills = bcfg.get("skills") or []
            bcfg["skills"] = [s for s in bskills if s not in owned]
    projects_block = registry.get("projects") or {}
    if isinstance(projects_block, dict):
        for pcfg in projects_block.values():
            if not isinstance(pcfg, dict):
                continue
            enabled = pcfg.get("enabled") or []
            pcfg["enabled"] = [s for s in enabled if s not in owned]
    sources_block = registry.get("sources") or {}
    if isinstance(sources_block, dict):
        sources_block.pop(source_id, None)


def _apply_source_remove_keep_local(
    registry: dict, source_id: str, owned: list[str], checkout: Path
) -> list[dict]:
    """Copy owned skills into data-home/skills/ and repoint registry entries.

    Returns a list of {"name", "new_path"} actions that were performed.
    """
    skills_block = registry.get("skills") or {}
    moves: list[dict] = []
    data_skills = hub_skills_dir()
    data_skills.mkdir(parents=True, exist_ok=True)
    for name in owned:
        scfg = skills_block.get(name)
        if not isinstance(scfg, dict):
            continue
        origin = scfg.get("origin") if isinstance(scfg.get("origin"), dict) else {}
        rel = origin.get("path") or ""
        src = checkout / rel if rel else checkout
        if not src.exists():
            # Source missing — leave the entry alone but clear origin and mark local.
            scfg["managed"] = "local"
            scfg.pop("origin", None)
            moves.append(
                {
                    "name": name,
                    "new_path": str(scfg.get("source")),
                    "warning": "source missing; metadata preserved but no copy",
                }
            )
            continue
        dest = data_skills / name
        if dest.exists():
            # Collision: skip the copy, but still clear origin so the entry no
            # longer claims external ownership. Caller can resolve manually.
            scfg["managed"] = "local"
            scfg.pop("origin", None)
            scfg.pop("source_missing", None)
            moves.append(
                {
                    "name": name,
                    "new_path": str(dest),
                    "warning": "destination already exists; kept existing",
                }
            )
            continue
        shutil.copytree(src, dest, symlinks=True)
        scfg["source"] = str(dest)
        scfg["managed"] = "local"
        scfg.pop("origin", None)
        scfg.pop("source_missing", None)
        moves.append({"name": name, "new_path": str(dest)})
    sources_block = registry.get("sources") or {}
    if isinstance(sources_block, dict):
        sources_block.pop(source_id, None)
    return moves


def cmd_source_remove(args):
    """`hub source remove <id>` — dry-run preview, or apply unequip / keep-local."""
    source_id = args.id
    with data_home_lock():
        registry = load_registry()
        _require_configured_git_source(registry, source_id)
        impact = _source_remove_impact(registry, source_id)

        if args.dry_run:
            payload = {"ok": True, "preview": True, "impact": impact}
            if getattr(args, "json", False):
                print(json.dumps(payload, indent=2))
            else:
                print(f"would remove source '{source_id}':")
                print(f"  owned skills:    {impact['owned_skills']}")
                print(
                    f"  bundles:         {[b['name'] for b in impact['affected_bundles']]}"
                )
                print(
                    f"  projects:        {[p['name'] for p in impact['affected_projects']]}"
                )
            return

        mode = args.mode or "unequip"
        if mode not in {"unequip", "keep-local"}:
            fail(f"unknown remove mode '{mode}'. Use 'unequip' or 'keep-local'.")

        cfg = registry["sources"][source_id]
        checkout = Path(cfg.get("cache") or str(source_worktree_dir(source_id)))
        owned = impact["owned_skills"]

        moves: list[dict] = []
        if mode == "keep-local":
            moves = _apply_source_remove_keep_local(
                registry, source_id, owned, checkout
            )
        else:
            _apply_source_remove_unequip(registry, source_id, owned)

        # Atomic mutation order: registry write first; cache deletion only if
        # the registry write succeeded.
        save_registry(registry)

        cache_root = source_cache_dir(source_id)
        if cache_root.exists():
            shutil.rmtree(cache_root, ignore_errors=True)

        payload = {
            "ok": True,
            "preview": False,
            "mode": mode,
            "impact": impact,
            "moves": moves,
            "needs_hub_sync": True,
        }
        if getattr(args, "json", False):
            print(json.dumps(payload, indent=2))
        else:
            print(f"removed source '{source_id}' (mode={mode})")
            for m in moves:
                print(f"  → {m['name']}: {m['new_path']}")


def cmd_source_duplicate(args):
    """`hub source duplicate <skill-name> [--as <new-name>]` — copy an external
    or starter skill into the data-home local skills/ directory and re-register
    it as ``managed: local`` with no origin.

    The original external entry is left intact unless ``--replace`` is passed
    (not implemented in V1; users keep both side-by-side).
    """
    source_skill_name = args.name
    new_name = args.new_name or f"{source_skill_name}-local"
    validate_slug(new_name, "new skill name")

    with data_home_lock():
        registry = load_registry()
        skills_block = registry.get("skills") or {}
        if source_skill_name not in skills_block:
            fail(f"skill '{source_skill_name}' not found")
        original = skills_block[source_skill_name]
        if not isinstance(original, dict):
            fail(f"skill '{source_skill_name}' has invalid configuration")

        # Only duplicate things that are actually read-only.
        info = infer_skill_ownership(source_skill_name, original)
        if info["managed"] not in {"external", "starter"}:
            fail(
                f"skill '{source_skill_name}' is already managed: {info['managed']}; "
                "duplicate is only valid for external/starter skills"
            )

        if new_name in skills_block:
            fail(f"skill '{new_name}' already exists; pass --as <unique-slug>")

        src = Path(str(original.get("source", ""))).expanduser()
        if not src.exists():
            fail(f"source files missing at {src}; cannot duplicate")

        dest = hub_skills_dir() / new_name
        if dest.exists():
            fail(f"destination already exists: {dest}")
        hub_skills_dir().mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dest, symlinks=True)

        # Rewrite the SKILL.md frontmatter name so it matches the new registry key.
        skill_md = dest / "SKILL.md"
        if skill_md.exists():
            try:
                text = skill_md.read_text()
                if text.lstrip().startswith("---"):
                    parts = text.split("---", 2)
                    if len(parts) >= 3:
                        meta = yaml.safe_load(parts[1]) or {}
                        if isinstance(meta, dict):
                            meta["name"] = new_name
                            new_front = (
                                yaml.safe_dump(
                                    meta, default_flow_style=False, sort_keys=False
                                ).rstrip()
                                + "\n"
                            )
                            skill_md.write_text(
                                f"---\n{new_front}---\n{parts[2].lstrip(chr(10))}"
                            )
            except (OSError, yaml.YAMLError):
                pass

        skills_block[new_name] = {
            "version": original.get("version") or "1.0.0",
            "description": original.get("description") or "",
            "source": collapse_home(dest),
            "type": original.get("type") or "claude-skill",
            "scope": original.get("scope") or "portable",
            "upstream": None,
            "managed": "local",
        }
        save_registry(registry)

        payload = {
            "ok": True,
            "original": source_skill_name,
            "duplicated_as": new_name,
            "new_source_path": str(dest),
        }
        if getattr(args, "json", False):
            print(json.dumps(payload, indent=2))
        else:
            print(f"duplicated '{source_skill_name}' → '{new_name}' at {dest}")


def _migration_target_home() -> Path:
    """Target for migrate-home, ignoring legacy fallback.

    data_home() intentionally falls back to ~/Dev/.skill-hub when the new
    default has no registry yet. migrate-home is the command that should end
    that fallback, so its target must be the explicit/new home instead.
    """
    home_env = os.environ.get("SKILL_HUB_HOME", "").strip()
    if home_env:
        return Path(home_env).expanduser().absolute()
    return DEFAULT_DATA_HOME.absolute()


def _migration_legacy_candidates(target: Path) -> list[Path]:
    """Legacy homes eligible to migrate into target."""
    out: list[Path] = []
    seen: set[Path] = set()
    candidates = [*LEGACY_DATA_HOMES]
    dir_env = os.environ.get("SKILL_HUB_DIR", "").strip()
    if dir_env:
        candidates.append(Path(dir_env).expanduser())
    for legacy in candidates:
        legacy = legacy.absolute()
        try:
            if legacy.resolve() == target.resolve():
                continue
            key = legacy.resolve()
        except OSError:
            key = legacy
        if key in seen:
            continue
        seen.add(key)
        if (legacy / "registry.yaml").exists():
            out.append(legacy)
    return out


def cmd_migrate_home(args):
    """Move legacy data home into the explicit/default data home."""
    target = _migration_target_home()
    legacies = _migration_legacy_candidates(target)
    if not legacies:
        print(f"{c('No legacy data home detected.', DIM)}")
        return
    print(f"\n{c('hub migrate-home', BOLD, CYAN)}")
    print(f"  Target: {target}")
    for legacy in legacies:
        print(f"  Legacy: {legacy}")

    if not getattr(args, "yes", False):
        try:
            response = input("Proceed with migration? [y/N] ").strip().lower()
        except EOFError:
            response = "n"
        if response != "y":
            print("Aborted.")
            return

    with data_home_lock():
        for legacy in legacies:
            _migrate_one_legacy(legacy, target)

    # Refresh cache so subsequent calls see the migrated state
    global _DATA_HOME_CACHE
    _DATA_HOME_CACHE = None

    print(f"\n{c('Running sync against new data home...', DIM)}")

    # Explicit user-invoked flow (migrate-home): run the FULL sync incl. remote dispatch —
    # NOT the mutation-path _auto_sync() which skips remotes.
    class _A:
        pass

    cmd_sync(_A())


def _migrate_one_legacy(legacy: Path, target: Path) -> None:
    moved_any = False
    entries = ["registry.yaml", "skills", "mcp-servers", "_hub-backups"]
    for entry_name in entries:
        src = legacy / entry_name
        if not src.exists() and not src.is_symlink():
            continue
        dst = target / entry_name
        # data_home() auto-creates empty skills/, mcp-servers/, _hub-backups/
        # at the target. Those empty placeholders aren't real collisions —
        # only treat dst as occupied if it's a file, or a non-empty directory.
        if dst.exists():
            if dst.is_dir() and not any(dst.iterdir()):
                # Empty placeholder dir — remove so the legacy dir can take its place.
                try:
                    dst.rmdir()
                except OSError:
                    print(f"  {c('!', YELLOW)} {entry_name} exists at target; skipping")
                    continue
            else:
                print(f"  {c('!', YELLOW)} {entry_name} exists at target; skipping")
                continue
        try:
            os.replace(str(src), str(dst))
            print(f"  {c('→', CYAN)} moved {entry_name}")
            moved_any = True
        except OSError as e:
            if e.errno == errno.EXDEV:
                print(
                    f"  {c('→', YELLOW)} cross-filesystem move (non-atomic): {entry_name}"
                )
                shutil.move(str(src), str(dst))
                moved_any = True
            else:
                print(f"  {c('!', RED)} failed to move {entry_name}: {e}")

    # Rewrite source paths in the migrated registry.yaml
    reg_path = target / "registry.yaml"
    if reg_path.exists() and moved_any:
        with open(reg_path) as f:
            reg = yaml.safe_load(f) or {}
        skills = reg.get("skills") or {}
        legacy_prefixes = [
            str(legacy / "skills") + os.sep,
            str(legacy / "mcp-servers") + os.sep,
            collapse_home(legacy / "skills") + "/",
            collapse_home(legacy / "mcp-servers") + "/",
        ]
        target_skills = collapse_home(target / "skills")
        target_mcp = collapse_home(target / "mcp-servers")
        changed = False
        for cfg in skills.values():
            src = cfg.get("source", "")
            for prefix in legacy_prefixes:
                if src.startswith(prefix):
                    suffix = src[len(prefix) :]
                    new_prefix = target_skills if "skills" in prefix else target_mcp
                    cfg["source"] = f"{new_prefix}/{suffix}"
                    changed = True
                    break
        if changed:
            with open(reg_path, "w") as f:
                yaml.dump(
                    reg,
                    f,
                    default_flow_style=False,
                    allow_unicode=True,
                    sort_keys=False,
                )
            print(f"  {c('✓', GREEN)} rewrote source paths in registry.yaml")

    # Leave a forwarding pointer
    pointer = legacy / "LEGACY-MOVED.txt"
    try:
        pointer.write_text(
            f"Skill Hub data moved to {target} on {_now_iso()}\n"
            f"This directory may still hold app source code; only data was moved.\n"
        )
    except OSError:
        pass


def cmd_bootstrap(args):
    """Initialize data home, optionally migrate legacy, run import wizard."""
    # Precondition
    if sys.version_info < MIN_PYTHON:
        msg = (
            f"Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+ required "
            f"(running {sys.version_info.major}.{sys.version_info.minor})"
        )
        if getattr(args, "json", False):
            print(json.dumps({"ok": False, "error": msg}))
        else:
            print(f"{c('!', RED)} {msg}")
        sys.exit(1)

    force = getattr(args, "force", False)
    dry_run = getattr(args, "dry_run", False)
    json_out = getattr(args, "json", False)
    yes = getattr(args, "yes", False)
    skip_migrate = getattr(args, "skip_migrate", False)

    # Read registry without sys.exit on missing
    reg = _read_registry_optional()
    state = bootstrap_state(reg)

    if state["completed_at"] and not force and not dry_run:
        if json_out:
            print(json.dumps({"ok": True, "already_bootstrapped": True, **state}))
        else:
            print(f"{c('✓', GREEN)} Already bootstrapped at {state['completed_at']}")
        return

    legacy_candidates = state["legacy_detected"]
    candidates = scan_import_candidates(reg)
    blocked = [c for c in candidates if c["category"] == "INVALID_NAME"]
    conflicts = [c for c in candidates if c["category"] == "CONFLICT"]
    new_candidates = [c for c in candidates if c["category"] in ("NEW", "BROKEN")]
    already = [c for c in candidates if c["category"] == "ALREADY_MANAGED"]
    silent_skip = [c for c in candidates if c["category"] == "SILENT_SKIP"]

    if dry_run:
        payload = {
            "legacy_detected": legacy_candidates,
            "candidates": new_candidates,
            "conflicts": conflicts,
            "blocked": blocked,
            "already_managed": [c["name"] for c in already],
            "silent_skip": [c["name"] for c in silent_skip],
        }
        if json_out:
            print(json.dumps(payload, indent=2))
        else:
            print(json.dumps(payload, indent=2))
        return

    # Migration
    if legacy_candidates and not skip_migrate:
        if yes or _confirm(f"Migrate legacy data home(s) {legacy_candidates}?"):
            args_obj = argparse.Namespace(yes=True)
            cmd_migrate_home(args_obj)
            reg = _read_registry_optional()
            candidates = scan_import_candidates(reg)
            blocked = [c for c in candidates if c["category"] == "INVALID_NAME"]
            conflicts = [c for c in candidates if c["category"] == "CONFLICT"]
            new_candidates = [
                c for c in candidates if c["category"] in ("NEW", "BROKEN")
            ]

    # Apply imports (CLI: default-select all NEW; conflicts default to skip)
    with data_home_lock():
        registry_now = _read_registry_optional()
        selections = new_candidates + conflicts
        actions = {c["name"]: "skip" for c in conflicts}
        result = apply_import(registry_now, selections, conflict_actions=actions)
        if blocked:
            print(f"\n{c('Blocked candidates (invalid names):', YELLOW)}")
            for b in blocked:
                print(f"  · {b['path']} — {b.get('reason', '')}")
        registry_now.setdefault("bootstrap", {})
        registry_now["bootstrap"] = {
            "completed_at": _now_iso(),
            "version": 1,
        }
        # Write registry directly (we're holding the lock)
        reg_file = registry_file()
        tmp = reg_file.with_suffix(".yaml.tmp")
        with open(tmp, "w") as f:
            yaml.dump(
                registry_now,
                f,
                default_flow_style=False,
                allow_unicode=True,
                sort_keys=False,
            )
        os.replace(tmp, reg_file)
        print(
            f"\n{c('✓', GREEN)} bootstrap complete — registered {len(result['registered'])}, "
            f"skipped {len(result['skipped'])}, blocked {len(blocked)}"
        )

    # Global permissions adoption (idempotent — only prompts when discovery finds
    # pre-existing rules AND permissions_global has no managed entries for that harness).
    _bootstrap_global_permissions_adopt()

    # Sync — first-run wizard: run the FULL sync incl. remote dispatch (user asked for a
    # complete setup here), NOT the mutation-path _auto_sync() which skips remotes.
    class _A:
        pass

    cmd_sync(_A())


def _bootstrap_global_permissions_adopt() -> None:
    """Bootstrap-time global-scope adoption decision per installed harness.

    Idempotent: re-running with an already-populated `permissions_global` is a
    no-op. Prompts the user for `import | replace | skip` per harness whose
    global config has pre-existing permissions.
    """
    import harnesses as _harnesses
    import permission_adapters as pa
    from permissions import GlobalScope

    registry = load_registry()
    global_block = registry.get("permissions_global") or {}
    if _has_any_managed_perms(global_block):
        return
    installed = _harnesses.detect_installed()
    print(f"\n{c('Global permissions adoption', BOLD)}")
    decided = False
    for h_id in sorted(installed):
        harness = _harnesses.HARNESSES.get(h_id)
        if harness is None or harness.permission_adapter_key is None:
            continue
        adapter = pa.get_adapter(harness.permission_adapter_key)
        if adapter is None:
            continue
        if _scope_managed_before(h_id, GlobalScope()):
            # Hub already manages this scope; an empty registry block is a
            # deliberate delete, not a cue to re-adopt native rules.
            continue
        discovered = adapter.discover_existing(GlobalScope(), h_id)
        if not _discovered_has_anything(discovered):
            continue
        decided = True
        if getattr(sys, "stdin", None) is None or not sys.stdin.isatty():
            print(
                f"  {c('·', DIM)} {harness.label}: pre-existing permissions detected "
                f"(non-interactive — skipped; run `hub permissions adopt --global "
                f"--harness {h_id}` to resolve)"
            )
            continue
        choice = ""
        while choice not in {"i", "r", "s"}:
            choice = (
                input(
                    f"  {harness.label}: pre-existing permissions found. "
                    f"[i]mport / [r]eplace / [s]kip? "
                )
                .strip()
                .lower()[:1]
            )
        action = {"i": "import", "r": "replace", "s": "skip"}[choice]

        class _N:
            pass

        ns = _N()
        ns.global_ = True
        ns.project = None
        ns.action = action
        ns.harness = h_id
        cmd_permissions_adopt(ns)
    if not decided:
        print(f"  {c('·', DIM)} nothing to adopt")


def _confirm(prompt: str) -> bool:
    try:
        response = input(f"{prompt} [y/N] ").strip().lower()
    except EOFError:
        return False
    return response == "y"


# ─────────────────────────────────────────────────────────────────────────────
# hub sync
# ─────────────────────────────────────────────────────────────────────────────


def resolve_project_skills(proj_cfg: dict, registry: dict) -> list:
    """Return the full ordered list of active skills for a project."""
    bundles_cfg = registry.get("bundles", {})
    global_bundle_skills = []
    for cfg in bundles_cfg.values():
        if bundle_scope(cfg) == "global":
            global_bundle_skills.extend(cfg.get("skills", []))

    proj_bundles = proj_cfg.get("bundles", [])
    project_bundle_skills = []
    for b in proj_bundles:
        project_bundle_skills.extend(bundles_cfg.get(b, {}).get("skills", []))

    all_skills = (
        global_bundle_skills + project_bundle_skills + proj_cfg.get("enabled", [])
    )
    return list(dict.fromkeys(all_skills))  # deduplicate, preserve order


def scan_project_skill_candidates(registry: Optional[dict] = None) -> list[dict]:
    """Discover hand-authored, untracked skills living inside registered projects.

    The hub is otherwise push-only (registry → harness symlinks) and its import
    scanner (`scan_import_candidates`) only walks USER-GLOBAL skill dirs. A skill
    created directly inside a *project's* `.claude/skills/` (e.g. authored by
    Claude Code) is therefore invisible to the hub: not in the registry, never
    proposed for import, and left untouched by sync cleanup (it is a real dir,
    not a hub-owned symlink). This pass closes that blind spot.

    For each registered project, walk every known harness's `project_skills_dir`
    (deduped, mirroring the sync cleanup walk) and flag entries that are:
      * a real directory (symlinks are hub-managed or external — skipped),
      * containing a parseable SKILL.md,
      * whose name is NOT already a registry skill and NOT active for the project.

    Categories:
      NEW           — valid slug, unknown to the hub → importable
      INVALID_NAME  — has a SKILL.md but the name fails the slug pattern
    """
    import harnesses as _harnesses

    reg = registry if registry is not None else _read_registry_optional()
    existing = reg.get("skills") or {}
    projects = reg.get("projects") or {}

    candidates: list[dict] = []
    for proj_name, proj_cfg in projects.items():
        proj_path = expand(proj_cfg["path"])
        active = set(resolve_project_skills(proj_cfg, reg))
        # Deduped skill dirs across all known harnesses (codex+pi share
        # .agents/skills/ → one dir, walked once).
        skill_dirs = {
            proj_path / Path(str(h.project_skills_dir))
            for h in _harnesses.HARNESSES.values()
        }
        seen_names: set[str] = set()
        for skills_dir in sorted(skill_dirs):
            if not skills_dir.exists() or skills_dir.is_symlink():
                continue
            for entry in sorted(skills_dir.iterdir()):
                if entry.name.startswith("."):
                    continue
                # Symlinks are hub-managed or external; only real dirs are
                # hand-authored project-local skills.
                if entry.is_symlink() or not entry.is_dir():
                    continue
                meta = _parse_skill_md(entry / "SKILL.md")
                if meta is None:
                    continue
                name = meta.get("name")
                if not name:
                    continue
                # Already known to the hub (globally or active here) → not a find.
                if name in existing or name in active:
                    continue
                if name in seen_names:
                    continue
                seen_names.add(name)
                base = {
                    "project": proj_name,
                    "name": name,
                    "path": str(entry),
                    "rel": str(entry.relative_to(proj_path)),
                    "description": meta.get("description") or "",
                    "version": meta.get("version"),
                    "category": "NEW" if SLUG_RE.match(name) else "INVALID_NAME",
                }
                if base["category"] == "INVALID_NAME":
                    base["reason"] = "must match ^[a-z0-9-]+$"
                candidates.append(base)
    return candidates


def _skill_affinity(skill_cfg: dict) -> Optional[set[str]]:
    """Return the skill's harness affinity set, or None if absent (= all)."""
    h = skill_cfg.get("harnesses")
    if not h:
        return None
    return set(h)


def _sync_global_skills(
    registry: dict, installed: set[str], report: Optional[dict] = None
) -> set[str]:
    """Global-skills pass: symlink every `scope: global` claude-skill into each
    installed harness's global_skills_dir (honoring per-skill `harnesses:`
    affinity), then clean stale global links across EVERY harness dir.

    Extracted verbatim from cmd_sync so `hub subagent provision-skill --global`
    can re-run ONLY this pass without invoking the full sync (which runs remotes
    + permissions and can sys.exit on unrelated failures). cmd_sync's output +
    behavior are unchanged — this is the single owner of the global-skills pass.
    Returns the set of provisioned global skill names.
    """
    import harnesses as _harnesses

    skills = registry.get("skills", {})
    print(c("Global skills (managed only from hub):", BOLD))
    global_skill_names: set[str] = set()
    writes = 0
    removed = 0
    global_targets: dict[Path, set[str]] = {}  # global_skills_dir -> names
    for h_id, h in _harnesses.HARNESSES.items():
        global_targets[Path(str(h.global_skills_dir)).expanduser()] = set()

    for name, cfg in skills.items():
        if cfg.get("scope") != "global" or cfg.get("type") != "claude-skill":
            continue
        src = skill_source(cfg)
        if not src.exists():
            print(f"  {c('!', YELLOW)} source missing: {src}")
            continue
        global_skill_names.add(name)
        affinity = _skill_affinity(cfg)
        for h_id, h in _harnesses.HARNESSES.items():
            if h_id not in installed:
                continue
            if affinity is not None and h_id not in affinity:
                continue
            target_dir = Path(str(h.global_skills_dir)).expanduser()
            link = target_dir / name
            if ensure_symlink(link, src):
                writes += 1
            global_targets[target_dir].add(name)

    # Clean stale global links — walk EVERY harness's global dir (even uninstalled)
    for h_id, h in _harnesses.HARNESSES.items():
        target_dir = Path(str(h.global_skills_dir)).expanduser()
        if not target_dir.exists():
            continue
        expected = global_targets.get(target_dir, set())
        # If multiple harnesses share the dir (codex+pi), union their expected sets
        for other_id, other in _harnesses.HARNESSES.items():
            if (
                other_id != h_id
                and Path(str(other.global_skills_dir)).expanduser() == target_dir
            ):
                expected = expected | global_targets.get(target_dir, set())
        removed += remove_unmanaged_entries(
            target_dir, expected, f"global {h.label} skill"
        )

    if report is not None:
        report["global"]["skills"]["writes"] += writes
        report["global"]["skills"]["removed"] += removed

    return global_skill_names


def _auto_sync():
    """Post-mutation sync used by registry mutations (enable/disable/bundle/etc.).

    Runs the full LOCAL sync — skills, MCP, permissions stream, and doctor all stay
    enabled — but SKIPS the remote-SSH dispatch (`skip_remotes=True`). Remote push is
    framed as eventual (the UI says "Reconciled on next sync"); it happens only on an
    explicit `hub sync` / `hub remote sync <id>`, not on every mutation click. This is
    what keeps a mutation from blocking on a ~30s live-remote plan.
    """

    class _AutoSyncArgs:
        skip_remotes = True

    cmd_sync(_AutoSyncArgs())


def cmd_sync(args):
    import harnesses as _harnesses

    registry = load_registry()
    skills = registry.get("skills", {})
    projects = registry.get("projects", {})
    skip_permissions = bool(getattr(args, "skip_permissions", False))
    skip_remotes = bool(getattr(args, "skip_remotes", False))
    strict_remotes = bool(getattr(args, "strict_remotes", False))

    validate_registry_skills(registry)

    # Pull `harnesses:` frontmatter from SKILL.md files into the registry.
    if sync_skill_frontmatter_metadata(registry):
        save_registry(registry)

    installed = _harnesses.detect_installed()
    known_ids = set(_harnesses.HARNESSES.keys())

    # Warn once about unknown harness ids referenced anywhere in the registry
    referenced: set[str] = set(registry.get("harnesses_global") or [])
    for p in projects.values():
        referenced.update(p.get("harnesses") or [])
    for unknown in sorted(referenced - known_ids):
        print(
            f"  {c('!', YELLOW)} unknown harness id '{unknown}' in registry — ignored",
            file=sys.stderr,
        )

    print(f"\n{c('hub sync', BOLD, CYAN)}\n")

    # Sync report accumulator — threaded through every pass, written on EVERY
    # exit path (skip flags, permission-error exit, strict-remotes exit, tail).
    report = new_sync_report()

    # 1. Global skills → each installed harness's global_skills_dir
    _sync_global_skills(registry, installed, report=report)

    # 1b. Global MCP servers → each installed harness's user-global MCP config.
    # Part of the MCP stream (NOT gated by --skip-permissions).
    _run_global_mcp_dispatch(registry, installed, report=report)

    # 1c. Remote connectors → push each sync_enabled remote's desired state.
    # Mirrors the global-MCP pass; non-blocking on drift/conflict/unreachable.
    remote_alarming = 0
    if skip_remotes:
        print(f"\n{c('Remotes:', BOLD)} skipped (--skip-remotes)")
        report["global"]["skipped"].append("remotes")
    else:
        remote_alarming = _run_remote_dispatch(
            registry, installed, strict=strict_remotes, report=report
        )

    # 2. Per-project skills (resolved from bundles + individually enabled)
    print(f"\n{c('Project skills:', BOLD)}")
    for proj_name, proj_cfg in projects.items():
        proj_path = expand(proj_cfg["path"])
        effective = _harnesses.resolve_effective(
            proj_cfg, registry, installed=installed
        )
        _sync_project_skills(
            proj_name, proj_path, proj_cfg, registry, effective, installed, report=report
        )

    # Invocation-override variants no longer demanded by any (project, skill)
    # pair are orphans — the whole tree is regenerable, so removal is safe.
    _cleanup_variant_orphans(registry)

    # 2b. Agent-docs canonical-root detection (read-only; migration is explicit).
    _run_agent_docs_detection(registry, projects, installed)

    # 2c. Project-local skill detection (read-only; import is explicit). Surfaces
    # hand-authored skills the hub doesn't track yet so sync no longer ignores them.
    _run_project_skill_detection(registry)

    # 3. Permissions stream (after skills + MCP). Doctor runs at the tail.
    permissions_exit_code = 0
    if skip_permissions:
        print(f"\n{c('Permissions:', BOLD)} skipped (--skip-permissions)")
        report["global"]["skipped"].append("permissions")
    else:
        permissions_exit_code = _run_permissions_stream(
            registry, projects, installed, _harnesses, report=report
        )
        if permissions_exit_code != 0:
            save_registry(registry)
            write_sync_report(report)
            print(f"\n{c('✗ sync completed with permission errors', RED, BOLD)}\n")
            sys.exit(permissions_exit_code)
        # Persist any registry mutations from auto-import.
        save_registry(registry)

    # L1: in --strict-remotes mode, an alarming remote failure (auth / host-key
    # mismatch / integrity) exits non-zero, mirroring the permissions doctor.
    if strict_remotes and remote_alarming:
        write_sync_report(report)
        print(
            f"\n{c('✗ sync completed with alarming remote failures', RED, BOLD)} "
            f"({remote_alarming})\n"
        )
        sys.exit(2)

    write_sync_report(report)
    print(f"\n{c('✓ sync complete', GREEN, BOLD)}\n")


def _run_agent_docs_detection(registry: dict, projects: dict, installed: set[str]) -> None:
    """Read-only pass: flag projects whose root docs differ from canonical.

    Never mutates any root instruction file — the fix is explicit via
    `hub agent-docs fix`. Divergent conflicts are non-blocking. The rollup is
    root-only plus a nested-deviation count to keep sync output small.
    """
    import agent_docs

    print(f"\n{c('Agent docs (detection only):', BOLD)}")
    flagged = 0
    for name, proj in projects.items():
        status = agent_docs.detect_status(proj, registry, installed=installed)
        st = status["state"]
        nested = status.get("nested_deviations", 0)
        nested_note = f" (+{nested} nested)" if nested else ""
        if st == "needs_canonicalization":
            flagged += 1
            print(
                f"  {c('•', YELLOW)} {name}: needs canonicalization — {status['reason']}{nested_note} "
                f"(run `hub agent-docs fix --project {name} --apply`)"
            )
        elif st == "conflict":
            flagged += 1
            print(
                f"  {c('!', RED)} {name}: divergent CLAUDE.md vs AGENTS.md{nested_note} — "
                f"resolve via `hub agent-docs resolve`"
            )
        elif nested:
            flagged += 1
            print(
                f"  {c('•', YELLOW)} {name}: root canonical, {nested} nested deviation(s) "
                f"(run `hub agent-docs fix --project {name}`)"
            )
    if flagged == 0:
        print(f"  {c('✓', GREEN)} all projects canonical")


def _run_project_skill_detection(registry: dict) -> None:
    """Read-only pass: surface hand-authored skills inside projects that the hub
    doesn't track yet, so a sync no longer silently ignores them.

    Import is explicit via `hub project import-skill`. Non-blocking.
    """
    print(f"\n{c('Project-local skills (detection only):', BOLD)}")
    candidates = scan_project_skill_candidates(registry)
    if not candidates:
        print(f"  {c('✓', GREEN)} no untracked project-local skills")
        return

    by_proj: dict[str, list[dict]] = {}
    for cand in candidates:
        by_proj.setdefault(cand["project"], []).append(cand)

    for proj_name in sorted(by_proj):
        cands = by_proj[proj_name]
        print(
            f"  {c('⚠', YELLOW)} {proj_name}: {len(cands)} untracked "
            f"project-local skill(s)"
        )
        for cand in cands:
            if cand["category"] == "INVALID_NAME":
                print(
                    f"      {c('✗', RED)} {cand['name']} ({cand['rel']}) — "
                    f"invalid name; rename to ^[a-z0-9-]+$ before import"
                )
            else:
                print(f"      {cand['name']}  ({cand['rel']})")
        first_valid = next((x for x in cands if x["category"] == "NEW"), None)
        if first_valid:
            print(
                f"      → run `hub project import-skill {first_valid['name']} "
                f"--project {proj_name}` to register"
            )


# ─────────────────────────────────────────────────────────────────────────────
# Invocation-override variants
#
# A per-project invocation override can't ride the shared library symlink (one
# SKILL.md, one frontmatter). Instead the project's symlink is pointed at a
# generated VARIANT dir in data_home: a real SKILL.md with patched frontmatter
# plus per-entry symlinks back to the library dir. The project-side entry stays
# a symlink whose readlink target is under data_home, so every ownership /
# cleanup / scanner path keeps working unchanged. Variants are keyed by
# (skill, mode) and shared across projects; the whole tree is regenerable.
# ─────────────────────────────────────────────────────────────────────────────


def skill_variants_root() -> Path:
    return data_home() / "state" / "skill_variants"


def _variant_dir_name(skill_name: str, mode: str) -> str:
    return f"{skill_name}@{mode}"


def ensure_skill_variant(
    skill_name: str, src: Path, mode: str
) -> Optional[tuple[Path, int]]:
    """Create/refresh the variant dir for (skill, mode). Deterministic and
    byte-stable: derives desired content from the current library copy and
    writes only what differs. Returns (variant_dir, writes) or None when the
    library SKILL.md is unreadable/unparseable (caller falls back to the
    direct, unpatched symlink)."""
    try:
        text = (src / "SKILL.md").read_text()
    except OSError:
        return None
    patched = render_invocation_frontmatter(text, mode, generated_marker=True)
    if patched is None:
        return None

    try:
        return _write_skill_variant(skill_name, src, mode, patched)
    except OSError as exc:
        # Contract: any filesystem failure degrades to the unpatched library
        # symlink instead of aborting the whole sync.
        print(
            f"  {c('!', YELLOW)} variant write failed for '{skill_name}' ({exc}) — "
            f"falling back to the library copy",
            file=sys.stderr,
        )
        return None


def _write_skill_variant(
    skill_name: str, src: Path, mode: str, patched: str
) -> tuple[Path, int]:
    vdir = skill_variants_root() / _variant_dir_name(skill_name, mode)
    writes = 0
    if not vdir.is_dir():
        if vdir.is_symlink() or vdir.exists():
            vdir.unlink()
        vdir.mkdir(parents=True)
        writes += 1

    # One real, patched SKILL.md.
    dst_md = vdir / "SKILL.md"
    current = None
    if dst_md.is_file() and not dst_md.is_symlink():
        try:
            current = dst_md.read_text()
        except OSError:
            current = None
    if current != patched:
        if dst_md.is_symlink() or dst_md.is_file():
            dst_md.unlink()
        elif dst_md.is_dir():
            shutil.rmtree(dst_md)
        dst_md.write_text(patched)
        writes += 1

    # Every other library entry: an absolute symlink back into the library dir.
    expected: dict[str, Path] = {
        entry.name: entry for entry in src.iterdir() if entry.name != "SKILL.md"
    }
    for entry_name, target in sorted(expected.items()):
        link = vdir / entry_name
        if link.is_symlink():
            if os.readlink(link) == str(target):
                continue
            link.unlink()
        elif link.exists():
            shutil.rmtree(link) if link.is_dir() else link.unlink()
        link.symlink_to(target)
        writes += 1

    # Reconcile: drop variant entries the library no longer has.
    for entry in list(vdir.iterdir()):
        if entry.name == "SKILL.md" or entry.name in expected:
            continue
        if entry.is_symlink() or entry.is_file():
            entry.unlink()
        else:
            shutil.rmtree(entry)
        writes += 1

    return vdir, writes


def _apply_invocation_override(
    skill_name: str, cfg: dict, src: Path, mode: str, rec: Optional[dict]
) -> Path:
    """Resolve the symlink source for an overridden (project, skill): a patched
    variant dir, or `src` unchanged when the override is inert/elided/broken."""
    if mode not in VALID_INVOCATIONS:
        print(
            f"    {c('!', YELLOW)} invocation override for '{skill_name}' has "
            f"unknown mode '{mode}' — ignored"
        )
        return src
    if cfg.get("scope", "portable") == "global":
        print(
            f"    {c('!', YELLOW)} invocation override for '{skill_name}' is inert: "
            f"scope is global (user-level skills take precedence in Claude Code)"
        )
        return src
    if skill_invocation(cfg) == mode:
        return src  # override equals the library mode — link straight through
    result = ensure_skill_variant(skill_name, src, mode)
    if result is None:
        print(
            f"    {c('!', YELLOW)} cannot patch '{skill_name}' frontmatter for the "
            f"invocation override — syncing the library copy unpatched"
        )
        return src
    vdir, writes = result
    if rec is not None:
        rec["writes"] += writes
    print(f"    {c('·', CYAN)} invocation override: {skill_name} → {mode}")
    return vdir


def _demanded_variant_names(registry: dict) -> set[str]:
    """Variant dir names demanded by the current registry (same gates as
    `_apply_invocation_override`, recomputed for cleanup)."""
    skills = registry.get("skills") or {}
    demanded: set[str] = set()
    for proj_cfg in (registry.get("projects") or {}).values():
        overrides = proj_cfg.get("invocation_overrides") or {}
        if not overrides:
            continue
        active = set(resolve_project_skills(proj_cfg, registry))
        for s_name, mode in overrides.items():
            cfg = skills.get(s_name)
            if not cfg or cfg.get("type") == "mcp-server":
                continue
            if s_name not in active:
                continue
            if cfg.get("scope", "portable") == "global":
                continue
            if mode not in VALID_INVOCATIONS or skill_invocation(cfg) == mode:
                continue
            demanded.add(_variant_dir_name(s_name, mode))
    return demanded


def _cleanup_variant_orphans(registry: dict) -> int:
    """Remove variant dirs no current (project, skill) override demands."""
    root = skill_variants_root()
    if not root.is_dir():
        return 0
    demanded = _demanded_variant_names(registry)
    removed = 0
    for entry in sorted(root.iterdir()):
        if entry.name in demanded:
            continue
        if entry.is_symlink() or entry.is_file():
            entry.unlink()
        else:
            shutil.rmtree(entry)
        removed += 1
        print(f"  {c('✗', RED)} removed orphaned variant: {entry.name}")
    return removed


def _sync_project_skills(
    proj_name: str,
    proj_path: Path,
    proj_cfg: dict,
    registry: dict,
    effective: set[str],
    installed: set[str],
    report: Optional[dict] = None,
) -> None:
    """Per-project sync: write symlinks per harness, dedup shared dirs, clean stale."""
    import harnesses as _harnesses

    rec = new_project_report() if report is not None else None
    skills = registry.get("skills", {})
    invocation_overrides = proj_cfg.get("invocation_overrides") or {}
    resolved = resolve_project_skills(proj_cfg, registry)
    resolved_skills = [
        n for n in resolved if skills.get(n, {}).get("type") != "mcp-server"
    ]
    # Exclude scope:global mcp-servers — they are OWNED by the global-MCP pass
    # (see _run_global_mcp_dispatch). Writing them per-project too would cause a
    # double-write and let Claude's project>user precedence silently shadow the
    # global entry (mirrors how the global-skills pass owns scope:global skills).
    resolved_mcps = [
        n
        for n in resolved
        if skills.get(n, {}).get("type") == "mcp-server"
        and skills.get(n, {}).get("scope") != "global"
    ]

    # Per-project log line: effective harnesses
    effective_labels = (
        ", ".join(sorted(_harnesses.HARNESSES[h].label for h in effective)) or "(none)"
    )
    print(f"\n  {c(proj_name, BOLD)} [{proj_path}]")
    print(f"    effective harnesses: {effective_labels}")

    # Log uninstalled-but-listed
    listed = set(registry.get("harnesses_global") or []) | set(
        proj_cfg.get("harnesses") or []
    )
    known_listed = listed & set(_harnesses.HARNESSES.keys())
    for missing in sorted(known_listed - installed):
        label = _harnesses.HARNESSES[missing].label
        print(
            f"    {c('!', YELLOW)} {label} listed but not installed on this "
            f"machine — skipped"
        )

    # Build target set: { (target_dir, skill_name, source) } — dedup across
    # harnesses that share a project_skills_dir (codex + pi → .agents/skills/).
    target_dir_expected: dict[Path, set[str]] = {}

    for skill_name in resolved_skills:
        if skill_name not in skills:
            print(f"    {c('?', YELLOW)} unknown skill: {skill_name}")
            if rec is not None:
                rec["errors"].append(
                    {"stage": "unknown-skill", "message": f"unknown skill: {skill_name}"}
                )
            continue
        cfg = skills[skill_name]
        src = skill_source(cfg)
        if not src.exists():
            print(f"    {c('!', YELLOW)} source missing: {src}")
            if rec is not None:
                rec["errors"].append(
                    {"stage": "symlink", "message": f"source missing: {src}"}
                )
            continue

        override_mode = invocation_overrides.get(skill_name)
        if override_mode:
            src = _apply_invocation_override(skill_name, cfg, src, override_mode, rec)

        affinity = _skill_affinity(cfg)
        skill_target_harnesses = (
            effective & affinity if affinity is not None else effective
        )
        if not skill_target_harnesses:
            if affinity is not None and effective:
                affinity_str = ", ".join(sorted(affinity))
                effective_str = ", ".join(sorted(effective)) or "none"
                print(
                    f"    {c('·', DIM)} skill {skill_name} not synced: "
                    f"skill targets [{affinity_str}], effective harnesses [{effective_str}]"
                )
                if rec is not None:
                    rec["affinity_skips"].append(
                        {
                            "skill": skill_name,
                            "skill_harnesses": sorted(affinity),
                            "project_harnesses": sorted(effective),
                        }
                    )
            continue

        target_dirs: set[Path] = set()
        for h_id in skill_target_harnesses:
            h = _harnesses.HARNESSES[h_id]
            target_dirs.add(proj_path / Path(str(h.project_skills_dir)))

        for target_dir in target_dirs:
            # Convert dir-level symlink to actual dir if needed (pre-existing edge case)
            if target_dir.is_symlink():
                target_dir.unlink()
                target_dir.mkdir(parents=True, exist_ok=True)
                print(
                    f"    {c('→', CYAN)} converted {target_dir.name} dir-symlink to dir"
                )
            link = target_dir / skill_name
            if ensure_symlink(link, src) and rec is not None:
                rec["writes"] += 1
            target_dir_expected.setdefault(target_dir, set()).add(skill_name)

    # Overrides for skills not active here are kept but inert — say so.
    for ov_name in sorted(set(invocation_overrides) - set(resolved_skills)):
        print(
            f"    {c('!', YELLOW)} invocation override for '{ov_name}' is inert "
            f"(skill not active on this project)"
        )

    # Cleanup: walk EVERY known harness's project_skills_dir, including ones
    # not in effective. This is what removes orphans when a harness is disabled.
    managed_dirs: set[Path] = {
        proj_path / Path(str(h.project_skills_dir))
        for h in _harnesses.HARNESSES.values()
    }
    for skills_dir in managed_dirs:
        if not skills_dir.exists() or skills_dir.is_symlink():
            continue
        expected = target_dir_expected.get(skills_dir, set())
        for link in skills_dir.iterdir():
            if link.is_symlink() and link.name not in expected:
                link.unlink()
                if rec is not None:
                    rec["removed"] += 1
                print(f"    {c('✗', RED)} removed stale: {link.relative_to(proj_path)}")

    if resolved_mcps:
        print(f"\n  {c(proj_name + ' MCP:', BOLD)}")
        sync_mcp_for_project(proj_path, resolved_mcps, registry)

    if report is not None and rec is not None:
        rec["ok"] = len(rec["errors"]) == 0
        report["projects"][proj_name] = rec


# ─────────────────────────────────────────────────────────────────────────────
# Permissions sync stream
# ─────────────────────────────────────────────────────────────────────────────


def _serialize_perms_block(perms) -> dict:
    """Convert a NormalizedPermissions back to a plain registry block (no origin).

    `NormalizedPermissions.from_block()` canonicalizes duplicate rules/hooks, so
    serializing a parsed block also acts as the registry cleanup path for older
    duplicate imports.
    """

    def rule_dict(r):
        out = {"pattern": r.pattern, "kind": r.kind}
        if r.harnesses is not None:
            out["harnesses"] = list(r.harnesses)
        return out

    def hook_dict(h):
        out = {"event": h.event, "matcher": h.matcher, "command": h.command}
        if h.harnesses is not None:
            out["harnesses"] = list(h.harnesses)
        return out

    block: dict = {}

    def dedupe_rules(rules):
        seen = set()
        out = []
        for r in rules:
            harnesses = (
                None
                if r.harnesses is None
                else tuple(sorted(str(h) for h in r.harnesses))
            )
            key = (r.kind, r.pattern, harnesses)
            if key in seen:
                continue
            seen.add(key)
            out.append(r)
        return out

    def dedupe_hooks(hooks):
        seen = set()
        out = []
        for h in hooks:
            harnesses = (
                None
                if h.harnesses is None
                else tuple(sorted(str(v) for v in h.harnesses))
            )
            key = (h.event, h.matcher, h.command, harnesses)
            if key in seen:
                continue
            seen.add(key)
            out.append(h)
        return out

    allow = dedupe_rules(perms.allow)
    deny = dedupe_rules(perms.deny)
    ask = dedupe_rules(perms.ask)
    hooks = dedupe_hooks(perms.hooks)
    if allow:
        block["allow"] = [rule_dict(r) for r in allow]
    if deny:
        block["deny"] = [rule_dict(r) for r in deny]
    if ask:
        block["ask"] = [rule_dict(r) for r in ask]
    if hooks:
        block["hooks"] = [hook_dict(h) for h in hooks]
    if perms.sandbox_mode is not None:
        block["sandbox_mode"] = perms.sandbox_mode
    if perms.approval_policy is not None:
        block["approval_policy"] = perms.approval_policy
    if perms.project_trust is not None:
        block["project_trust"] = perms.project_trust
    if perms.additional_dirs:
        block["additional_dirs"] = list(perms.additional_dirs)
    if perms.extras:
        block["extras"] = dict(perms.extras)
    return block


def _canonicalize_permissions_block(block) -> tuple[dict, bool]:
    """Return a deduped canonical permissions block and whether it changed."""
    from permissions import NormalizedPermissions

    current = block if isinstance(block, dict) else {}
    canonical = _serialize_perms_block(NormalizedPermissions.from_block(current))
    unmanaged = list(current.get("_unmanaged") or [])
    if unmanaged:
        canonical["_unmanaged"] = unmanaged
    return canonical, canonical != current


def _permissions_duplicate_count(block) -> int:
    current = block if isinstance(block, dict) else {}
    canonical, _changed = _canonicalize_permissions_block(current)
    before = sum(len(current.get(k) or []) for k in ("allow", "deny", "ask", "hooks"))
    after = sum(len(canonical.get(k) or []) for k in ("allow", "deny", "ask", "hooks"))
    return max(0, before - after)


def _dedupe_registry_permissions(registry: dict) -> bool:
    """Collapse duplicate permission entries in global and project blocks."""
    mutated = False
    canonical, changed = _canonicalize_permissions_block(
        registry.get("permissions_global") or {}
    )
    if changed:
        registry["permissions_global"] = canonical
        mutated = True
    for proj_cfg in (registry.get("projects") or {}).values():
        if not isinstance(proj_cfg, dict):
            continue
        canonical, changed = _canonicalize_permissions_block(
            proj_cfg.get("permissions") or {}
        )
        if changed:
            proj_cfg["permissions"] = canonical
            mutated = True
    return mutated


def _has_any_managed_perms(block) -> bool:
    if not block:
        return False
    if not isinstance(block, dict):
        return False
    for key in ("allow", "deny", "ask", "hooks", "additional_dirs"):
        if block.get(key):
            return True
    for key in ("sandbox_mode", "approval_policy", "project_trust"):
        if block.get(key) is not None:
            return True
    if block.get("extras"):
        return True
    return False


def _unmanaged_list(block) -> list:
    if not isinstance(block, dict):
        return []
    return list(block.get("_unmanaged") or [])


def _scope_managed_before(harness_id: str, scope) -> bool:
    """Whether hub has previously written managed permissions for (harness, scope).

    Distinguishes genuine first-contact adoption from a deliberate registry-side
    delete. Once any sidecar (primary OR rules-kind) exists, an empty registry
    block is a deliberate delete — not re-imported. This prevents the rules-only
    Codex case (rules sidecar exists but no config sidecar) from boomeranging.
    """
    import permissions as _perms

    return (
        _perms.sidecar_path(harness_id, scope).exists()
        or _perms.sidecar_path(harness_id, scope, kind="rules").exists()
    )


def _run_permissions_stream(
    registry: dict,
    projects: dict,
    installed: set[str],
    _harnesses,
    report: Optional[dict] = None,
) -> int:
    """Permissions sync stream — global pass + per-project pass + doctor.

    Returns non-zero exit code if any adapter errored OR any doctor finding has
    `severity = "danger"`. Per-(scope, harness) errors do not stop the stream.
    """
    perm_errors: list[dict] = []

    def _perm_err(stage: str, message: str) -> None:
        perm_errors.append({"stage": stage, "message": message})
    import permission_adapters as pa
    from permissions import (
        GlobalScope,
        NormalizedPermissions,
        ProjectScope,
        resolve_effective,
        resolve_project_local_own,
        resolve_project_own,
    )
    import risks

    print(f"\n{c('Permissions:', BOLD)}")

    if _dedupe_registry_permissions(registry):
        print(f"  {c('↧', CYAN)} collapsed duplicate permission rules in registry")

    any_error = False
    doctor_targets: list[tuple[str, str, NormalizedPermissions]] = []
    blocked_global_harnesses: list[str] = []

    # ── Global pass ────────────────────────────────────────────────────────
    global_perms_block = registry.get("permissions_global") or {}
    global_perms = NormalizedPermissions.from_block(global_perms_block)
    # Attach origin GLOBAL for everything so doctor finds them with provenance.
    for r in global_perms.allow + global_perms.deny + global_perms.ask:
        r.origin = "global"
    for h in global_perms.hooks:
        h.origin = "global"

    for h_id in sorted(installed):
        harness = _harnesses.HARNESSES.get(h_id)
        if harness is None or harness.permission_adapter_key is None:
            continue
        if h_id in _unmanaged_list(global_perms_block):
            print(f"  {c('·', DIM)} global  [{harness.label}] unmanaged — skipped")
            continue
        adapter = pa.get_adapter(harness.permission_adapter_key)
        if adapter is None:
            continue
        scope = GlobalScope()

        managed = _has_any_managed_perms(global_perms_block)
        try:
            if not managed and not _scope_managed_before(h_id, scope):
                discovered = adapter.discover_existing(scope, h_id)
                if _discovered_has_anything(discovered):
                    # AdoptionRequired: block this (scope, harness) only.
                    backup_dir = pa._backups_root() / h_id / scope.slug
                    print(
                        f"  {c('!', YELLOW)} global  [{harness.label}] "
                        f"AdoptionRequired — pre-existing permissions detected; "
                        f"run: hub permissions adopt --global --harness {h_id} --action import"
                    )
                    blocked_global_harnesses.append(h_id)
                    continue

            try:
                result = adapter.translate(global_perms, scope, h_id)
            except Exception as e:
                print(
                    f"  {c('✗', RED)} global  [{harness.label}] translate failed: {e}"
                )
                any_error = True
                _perm_err("permissions", f"global [{harness.label}] translate failed: {e}")
                continue

            writes_count = 0
            for write in result.writes:
                try:
                    if adapter.apply(scope, write, h_id):
                        writes_count += 1
                except Exception as e:
                    print(
                        f"  {c('✗', RED)} global  [{harness.label}] apply failed: {e}"
                    )
                    any_error = True
                    _perm_err("permissions", f"global [{harness.label}] apply failed: {e}")

            if writes_count == 0 and not result.skipped:
                print(f"  {c('·', DIM)} global  [{harness.label}] no rules to write")
            else:
                print(
                    f"  {c('✓', GREEN)} global  [{harness.label}] "
                    f"writes={writes_count} skips={len(result.skipped)}"
                )
            for w in getattr(result, "warnings", []) or []:
                print(f"  {c('!', YELLOW)} global  [{harness.label}] {w}")

            doctor_targets.append(("global", h_id, global_perms))
        except Exception as e:
            print(f"  {c('✗', RED)} global  [{harness.label}] {e}")
            any_error = True
            _perm_err("permissions", f"global [{harness.label}] {e}")

    # ── Per-project pass ──────────────────────────────────────────────────
    for proj_name, proj_cfg in projects.items():
        proj_path = expand(proj_cfg["path"])
        effective = _harnesses.resolve_effective(
            proj_cfg, registry, installed=installed
        )
        if not effective:
            continue
        proj_perms_block = proj_cfg.get("permissions") or {}
        for h_id in sorted(effective):
            harness = _harnesses.HARNESSES.get(h_id)
            if harness is None or harness.permission_adapter_key is None:
                continue
            # Skip if this harness is opted out at project OR global scope.
            if h_id in _unmanaged_list(proj_perms_block) or h_id in _unmanaged_list(global_perms_block):
                print(
                    f"  {c('·', DIM)} {proj_name}  [{harness.label}] "
                    f"unmanaged — skipped"
                )
                continue
            adapter = pa.get_adapter(harness.permission_adapter_key)
            if adapter is None:
                continue
            scope = ProjectScope(name=proj_name, path=str(proj_path))

            try:
                # Auto-import only on genuine first contact: no managed block in
                # the registry AND no sidecar (hub never wrote this scope before).
                # If a sidecar exists, an empty block is a deliberate delete.
                project_managed = _has_any_managed_perms(proj_perms_block)
                if not project_managed and not _scope_managed_before(h_id, scope):
                    discovered = adapter.discover_existing(
                        scope, h_id, project_path=proj_path
                    )
                    if _discovered_has_anything(discovered):
                        target_for_backup = (
                            adapter.target_files(scope, h_id)
                            if hasattr(adapter, "target_files")
                            else None
                        )
                        if target_for_backup and target_for_backup.exists():
                            backup_path = pa._backup_once_per_session(
                                target_for_backup, scope, h_id
                            )
                        else:
                            backup_path = None
                        # Persist discovered into registry as starting point.
                        new_block = _serialize_perms_block(discovered)
                        proj_cfg["permissions"] = {**proj_perms_block, **new_block}
                        proj_perms_block = proj_cfg["permissions"]
                        bp_str = f" (backup: {backup_path})" if backup_path else ""
                        print(
                            f"  {c('↥', CYAN)} {proj_name}  [{harness.label}] "
                            f"auto-imported pre-existing permissions{bp_str}"
                        )

                # Scope-targeted writes: project files receive ONLY the project's
                # own rules. The harness merges user-level + project-level at runtime.
                project_own_perms = resolve_project_own(proj_cfg)

                try:
                    result = adapter.translate(project_own_perms, scope, h_id)
                except Exception as e:
                    print(
                        f"  {c('✗', RED)} {proj_name}  [{harness.label}] translate failed: {e}"
                    )
                    any_error = True
                    _perm_err(
                        "permissions",
                        f"{proj_name} [{harness.label}] translate failed: {e}",
                    )
                    continue

                writes_count = 0
                for write in result.writes:
                    try:
                        if adapter.apply(scope, write, h_id):
                            writes_count += 1
                    except Exception as e:
                        print(
                            f"  {c('✗', RED)} {proj_name}  [{harness.label}] apply failed: {e}"
                        )
                        any_error = True
                        _perm_err(
                            "permissions",
                            f"{proj_name} [{harness.label}] apply failed: {e}",
                        )

                if writes_count == 0 and not result.skipped:
                    print(
                        f"  {c('·', DIM)} {proj_name}  [{harness.label}] no rules to write"
                    )
                else:
                    print(
                        f"  {c('✓', GREEN)} {proj_name}  [{harness.label}] "
                        f"writes={writes_count} skips={len(result.skipped)}"
                    )
                for w in getattr(result, "warnings", []) or []:
                    print(f"  {c('!', YELLOW)} {proj_name}  [{harness.label}] {w}")

                # ── Personal per-project tier (claude-family only) ──────────
                # A `permissions_local` block holds PERSONAL rules that target
                # the harness's gitignored `.claude/settings.local.json` instead
                # of the committed `.claude/settings.json`. Scope-targeted: the
                # local file gets ONLY this project's personal block — never the
                # shared/global rules. Codex/opencode have no committed-vs-
                # personal split in this model, so they are skipped.
                local_block = proj_cfg.get("permissions_local") or {}
                local_scope = ProjectScope(
                    name=proj_name, path=str(proj_path), personal=True
                )
                if harness.permission_adapter_key != "claude":
                    if _has_any_managed_perms(local_block):
                        print(
                            f"  {c('·', DIM)} {proj_name}  [{harness.label}] "
                            f"personal tier skipped — no committed-vs-personal "
                            f"split for this harness"
                        )
                # Write when the block has rules, OR when it is now empty but a
                # personal sidecar from a prior sync exists (so removing the block
                # strips the stale entries from settings.local.json).
                elif _has_any_managed_perms(local_block) or _scope_managed_before(
                    h_id, local_scope
                ):
                    project_local_perms = resolve_project_local_own(proj_cfg)
                    try:
                        local_result = adapter.translate(
                            project_local_perms, local_scope, h_id
                        )
                    except Exception as e:
                        print(
                            f"  {c('✗', RED)} {proj_name}  [{harness.label}] "
                            f"personal translate failed: {e}"
                        )
                        any_error = True
                        _perm_err(
                            "permissions",
                            f"{proj_name} [{harness.label}] personal translate failed: {e}",
                        )
                        local_result = None
                    if local_result is not None:
                        local_writes = 0
                        for write in local_result.writes:
                            try:
                                if adapter.apply(local_scope, write, h_id):
                                    local_writes += 1
                            except Exception as e:
                                print(
                                    f"  {c('✗', RED)} {proj_name}  [{harness.label}] "
                                    f"personal apply failed: {e}"
                                )
                                any_error = True
                                _perm_err(
                                    "permissions",
                                    f"{proj_name} [{harness.label}] personal apply failed: {e}",
                                )
                        print(
                            f"  {c('✓', GREEN)} {proj_name}  [{harness.label}] "
                            f"personal writes={local_writes} "
                            f"skips={len(local_result.skipped)}"
                        )
                        doctor_targets.append(
                            (f"project-local:{proj_name}", h_id, project_local_perms)
                        )

                # Doctor uses the full effective view (global + project) to detect
                # the complete risk surface for this project.
                effective_perms = resolve_effective(proj_cfg, registry)
                doctor_targets.append((f"project:{proj_name}", h_id, effective_perms))
            except Exception as e:
                print(f"  {c('✗', RED)} {proj_name}  [{harness.label}] {e}")
                any_error = True
                _perm_err("permissions", f"{proj_name} [{harness.label}] {e}")

    # ── Doctor rollup ─────────────────────────────────────────────────────
    print(f"\n{c('Permissions doctor:', BOLD)}")
    danger_count = 0
    warning_count = 0
    any_findings = False
    for scope_label, h_id, perms in doctor_targets:
        adapter = None
        harness = _harnesses.HARNESSES.get(h_id)
        if harness is not None and harness.permission_adapter_key:
            import permission_adapters as pa_mod

            adapter = pa_mod.get_adapter(harness.permission_adapter_key)
        caps = adapter.capabilities() if adapter is not None else set()
        findings = risks.detect_risks(perms, caps)
        if not findings:
            continue
        any_findings = True
        for f in findings:
            colour = RED if f.severity == "danger" else YELLOW
            icon = "✗" if f.severity == "danger" else "!"
            print(
                f"  {c(icon, colour)} {scope_label}  [{harness.label if harness else h_id}] "
                f"{f.code} ({f.severity}): {f.detail}"
            )
            if f.severity == "danger":
                danger_count += 1
                _perm_err(
                    "doctor",
                    f"{scope_label} [{harness.label if harness else h_id}] "
                    f"{f.code}: {f.detail}",
                )
            else:
                warning_count += 1
    if not any_findings:
        print(f"  {c('✓', GREEN)} no risks detected")

    if blocked_global_harnesses:
        # Surface a clear summary at the tail
        ids = ", ".join(blocked_global_harnesses)
        print(
            f"\n  {c('!', YELLOW)} global permissions blocked for: {ids} — "
            f"resolve via `hub permissions adopt --global --action import`"
        )

    # First-post-upgrade detection (D2): project native files copied from a
    # pre-scope-targeting install may still carry global-sourced duplicates.
    # Detection is non-blocking; the user runs the migration explicitly.
    if _project_files_have_global_duplicates(registry):
        print(
            f"\n  {c('!', YELLOW)} project files still contain global-sourced "
            f"duplicate rules — preview/remove with "
            f"`hub permissions migrate-scope` (add --apply to commit)"
        )

    rc = 2 if danger_count > 0 else (1 if any_error else 0)
    if report is not None:
        report["global"]["permissions"] = {"ok": rc == 0, "errors": perm_errors}
    return rc


def _discovered_has_anything(perms) -> bool:
    return bool(
        perms.allow
        or perms.deny
        or perms.ask
        or perms.hooks
        or perms.additional_dirs
        or perms.sandbox_mode
        or perms.approval_policy
        or perms.project_trust is not None
        or perms.extras
    )


# ─────────────────────────────────────────────────────────────────────────────
# hub list
# ─────────────────────────────────────────────────────────────────────────────


def cmd_list(args):
    registry = load_registry()
    skills = registry.get("skills", {})
    projects = registry.get("projects", {})
    bundles = registry.get("bundles", {})

    # Build skill → bundle membership map
    skill_bundles: dict[str, list[str]] = {}
    for bname, bcfg in bundles.items():
        for s in bcfg.get("skills", []):
            skill_bundles.setdefault(s, []).append(bname)

    project_filter = args.project
    if project_filter and project_filter not in projects:
        matches = [
            k
            for k in projects
            if project_filter in k or project_filter in projects[k]["path"]
        ]
        if len(matches) == 1:
            project_filter = matches[0]
        elif len(matches) > 1:
            print(f"Ambiguous project '{project_filter}': {matches}")
            sys.exit(1)
        else:
            print(f"Unknown project '{project_filter}'. Known: {list(projects.keys())}")
            sys.exit(1)

    active_in_project: set[str] = set()
    if project_filter:
        active_in_project = set(
            resolve_project_skills(projects[project_filter], registry)
        )

    col_w = [28, 12, 12, 9, 35]
    header = (
        f"{'NAME':<{col_w[0]}} {'TYPE':<{col_w[1]}} {'SCOPE':<{col_w[2]}} "
        f"{'VERSION':<{col_w[3]}} {'BUNDLES':<{col_w[4]}}"
    )
    if project_filter:
        header += "  STATUS"

    print(f"\n{c(header, BOLD)}")
    print("─" * 120)

    by_scope = {"global": [], "portable": [], "project-specific": []}
    for name, cfg in skills.items():
        scope = cfg.get("scope", "portable")
        by_scope.setdefault(scope, []).append((name, cfg))

    for scope_label in ["global", "portable", "project-specific"]:
        entries = by_scope.get(scope_label, [])
        if not entries:
            continue
        print(f"\n  {c(scope_label.upper(), DIM)}")
        for name, cfg in sorted(entries):
            typ = cfg.get("type", "claude-skill")
            version = cfg.get("version", "—")
            bundles_str = ", ".join(skill_bundles.get(name, [])) or c("—", DIM)
            if len(bundles_str) > 35:
                bundles_str = bundles_str[:32] + "..."

            type_col = c(typ[:11], CYAN) if typ == "mcp-server" else typ[:11]
            row = (
                f"  {name:<{col_w[0]}} {type_col:<{col_w[1] + 9}} {scope_label:<{col_w[2]}} "
                f"v{version:<{col_w[3] - 1}} {bundles_str}"
            )
            invocation = skill_invocation(cfg)
            if invocation != "auto":
                row += f"  {c(f'[{invocation}]', YELLOW)}"
            if project_filter:
                status = (
                    c("● active", GREEN)
                    if name in active_in_project
                    else c("○ inactive", DIM)
                )
                row += f"  {status}"
            print(row)

    total = len(skills)
    print(f"\n{c(f'{total} skills total', DIM)}\n")


# ─────────────────────────────────────────────────────────────────────────────
# hub enable / disable
# ─────────────────────────────────────────────────────────────────────────────


@registry_mutation("enable")
def cmd_enable(args):
    registry = load_registry()
    skills = registry.get("skills", {})
    projects = registry.get("projects", {})

    skill_name = args.skill
    if skill_name not in skills:
        print(f"Unknown skill '{skill_name}'. Run 'hub list' to see available skills.")
        sys.exit(1)

    if not args.project:
        cfg = skills[skill_name]
        if cfg.get("scope") != "global":
            print(
                f"'{skill_name}' has scope '{cfg.get('scope')}'. To make it global, edit registry.yaml."
            )
        print(
            f"'{skill_name}' is already global — no project needed. Run 'hub sync' to refresh symlinks."
        )
        return

    proj_name = args.project
    if proj_name not in projects:
        print(
            f"Unknown project '{proj_name}'. Run 'hub project add {proj_name} <path>' first."
        )
        sys.exit(1)

    enabled = projects[proj_name].get("enabled", [])
    if skill_name in enabled:
        print(f"'{skill_name}' already enabled for '{proj_name}'.")
        return

    enabled.append(skill_name)
    projects[proj_name]["enabled"] = enabled
    save_registry(registry)
    print(f"{c('✓', GREEN)} enabled '{skill_name}' for '{proj_name}'.")

    _auto_sync()


@registry_mutation("disable")
def cmd_disable(args):
    registry = load_registry()
    projects = registry.get("projects", {})

    if not args.project:
        print(
            "Specify a project with --project <name>. Global skills cannot be disabled per-project."
        )
        sys.exit(1)

    proj_name = args.project
    if proj_name not in projects:
        print(f"Unknown project '{proj_name}'.")
        sys.exit(1)

    skill_name = args.skill
    enabled = projects[proj_name].get("enabled", [])
    if skill_name not in enabled:
        print(f"'{skill_name}' not enabled for '{proj_name}'.")
        return

    enabled.remove(skill_name)
    projects[proj_name]["enabled"] = enabled
    save_registry(registry)
    print(f"{c('✓', GREEN)} disabled '{skill_name}' for '{proj_name}'.")

    _auto_sync()


# ─────────────────────────────────────────────────────────────────────────────
# hub new
# ─────────────────────────────────────────────────────────────────────────────

SKILL_TEMPLATE = """\
---
name: {name}
description: |
  {description}
---

# {title}

Brief overview of what this skill does.

## When to Use

- Condition 1
- Condition 2
- Trigger phrase: "/{name}", "..."

## Workflow

Describe the step-by-step process the skill executes.

## Output

Describe what the skill produces.
"""

MCP_SKILL_TEMPLATE = """\
---
name: {name}
description: |
  {description}
type: mcp-server
---

# {title} (MCP Server)

Exposes the following tools via MCP protocol:

## Tools

### `tool_name(param: str) -> str`

Description of what this tool does.
"""

MCP_SERVER_TEMPLATE = '''\
#!/usr/bin/env python3
"""
{name} — MCP server
Expose tools via MCP stdio protocol.
"""

import json
import sys


def handle_initialize(req_id, params):
    return {{
        "jsonrpc": "2.0",
        "id": req_id,
        "result": {{
            "protocolVersion": "2024-11-05",
            "capabilities": {{"tools": {{}}}},
            "serverInfo": {{"name": "{name}", "version": "1.0.0"}},
        }},
    }}


def handle_tools_list(req_id):
    return {{
        "jsonrpc": "2.0",
        "id": req_id,
        "result": {{
            "tools": [
                {{
                    "name": "example_tool",
                    "description": "An example tool — replace with your implementation.",
                    "inputSchema": {{
                        "type": "object",
                        "properties": {{
                            "input": {{"type": "string", "description": "Input to process"}},
                        }},
                        "required": ["input"],
                    }},
                }}
            ]
        }},
    }}


def handle_tools_call(req_id, params):
    name = params.get("name")
    args = params.get("arguments", {{}})

    if name == "example_tool":
        result = f"Processed: {{args.get('input', '')}}"
        return {{
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {{"content": [{{"type": "text", "text": result}}]}},
        }}

    return {{
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {{"code": -32601, "message": f"Unknown tool: {{name}}"}},
    }}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = req.get("method")
        req_id = req.get("id")
        params = req.get("params", {{}})

        if method == "initialize":
            resp = handle_initialize(req_id, params)
        elif method == "tools/list":
            resp = handle_tools_list(req_id)
        elif method == "tools/call":
            resp = handle_tools_call(req_id, params)
        elif method == "notifications/initialized":
            continue
        else:
            resp = {{
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {{"code": -32601, "message": f"Method not found: {{method}}"}},
            }}

        print(json.dumps(resp), flush=True)


if __name__ == "__main__":
    main()
'''


@registry_mutation("new")
def cmd_new(args):
    registry = load_registry()
    skills = registry.get("skills", {})

    kind = args.kind
    name = args.name.strip()
    validate_slug(name)
    scope = parse_scope(getattr(args, "scope", None), default="portable")
    description = (
        getattr(args, "description", None)
        or f"New {'MCP server' if kind == 'mcp' else 'skill'}: {name}"
    ).strip()
    title = name.replace("-", " ").title()

    if kind == "skill":
        dest = hub_skills_dir() / name
        if dest.exists():
            print(f"'{name}' already exists at {dest}")
            sys.exit(1)
        dest.mkdir(parents=True)
        (dest / "SKILL.md").write_text(
            SKILL_TEMPLATE.format(name=name, title=title, description=description)
        )
        print(f"{c('✓', GREEN)} scaffolded skill at {dest}/")

    elif kind == "mcp":
        dest = hub_mcp_servers_dir() / name
        if dest.exists():
            print(f"'{name}' already exists at {dest}")
            sys.exit(1)
        dest.mkdir(parents=True)
        (dest / "SKILL.md").write_text(
            MCP_SKILL_TEMPLATE.format(name=name, title=title, description=description)
        )
        (dest / "server.py").write_text(MCP_SERVER_TEMPLATE.format(name=name))
        os.chmod(dest / "server.py", 0o755)
        print(f"{c('✓', GREEN)} scaffolded MCP server at {dest}/")

    if name not in skills:
        entry = {
            "version": "1.0.0",
            "description": description,
            "source": collapse_home(dest),
            "type": "mcp-server" if kind == "mcp" else "claude-skill",
            "scope": scope,
            "upstream": None,
        }
        if kind == "mcp":
            entry["mcp"] = {
                "runtime": "python",
                "command": "python3",
                "args": ["{source}/server.py"],
                "env": {},
            }
        skills[name] = entry
        registry["skills"] = skills
        save_registry(registry)
        print(f"{c('✓', GREEN)} registered '{name}' in registry.yaml")

    print(f"\nNext: edit the files in {dest}/, then run '{c('hub sync', CYAN)}'")


# ─────────────────────────────────────────────────────────────────────────────
# hub migrate
# ─────────────────────────────────────────────────────────────────────────────


@registry_mutation("migrate")
def cmd_migrate(args):
    registry = load_registry()
    skills = registry.get("skills", {})
    name = args.skill

    if name not in skills:
        print(f"Unknown skill '{name}'.")
        sys.exit(1)

    cfg = skills[name]
    current_src = skill_source(cfg)
    hub_target = hub_skills_dir() / name

    if hub_target.exists() or hub_target.is_symlink():
        print(f"Already at hub location: {hub_target}")
        return

    if not current_src.exists():
        print(f"Source not found: {current_src}")
        sys.exit(1)

    # Copy to data home
    shutil.copytree(current_src, hub_target, symlinks=True)
    new_source = collapse_home(hub_target)
    skills[name]["source"] = new_source
    save_registry(registry)
    print(f"{c('✓', GREEN)} migrated '{name}' to hub")
    print(f"  source updated → {new_source}")
    print(f"  original still at {current_src} (delete manually if satisfied)")
    print(f"  run 'hub sync' to rebuild symlinks")


# ─────────────────────────────────────────────────────────────────────────────
# hub project add/remove
# ─────────────────────────────────────────────────────────────────────────────


def cmd_project_scan_skills(args):
    """List hand-authored project-local skills not yet adopted (read-only).

    The sanctioned discovery surface over `scan_project_skill_candidates`,
    consumed by the control-plane MCP `skill_candidates` tool and the app's
    per-project candidate section. Optional `--project` filters to one project.
    Never mutates; exits 0 even when nothing is found.
    """
    registry = _read_registry_optional()
    project = getattr(args, "project", None)
    if project and project not in (registry.get("projects") or {}):
        msg = f"Unknown project '{project}'"
        if getattr(args, "json", False):
            print(json.dumps({"error": msg}))
        else:
            print(f"{c('!', RED)} {msg}")
        sys.exit(1)

    candidates = scan_project_skill_candidates(registry)
    if project:
        candidates = [c for c in candidates if c.get("project") == project]

    if getattr(args, "json", False):
        print(json.dumps(candidates))
        return

    if not candidates:
        scope = f" in {project}" if project else ""
        print(f"{c('·', DIM)} no un-adopted project-local skills{scope}")
        return
    for cand in candidates:
        tag = c("NEW", GREEN) if cand["category"] == "NEW" else c("INVALID", YELLOW)
        print(f"  {tag}  {cand['name']}  ({cand['project']})  {cand['path']}")
        if cand.get("reason"):
            print(f"        → {cand['reason']}")


@registry_mutation("project-import-skill")
def cmd_project_import_skill(args):
    """Adopt a hand-authored project-local skill into the hub.

    Copies the project's skill dir into data_home/skills/<name>, registers it,
    enables it on the project, then removes the original (only after a verified
    copy + registry write — the original is never at risk before the copy
    succeeds). The next `hub sync` re-creates it as a managed symlink.
    """
    registry = load_registry()
    projects = registry.get("projects") or {}
    proj_name = args.project
    name = args.name

    if proj_name not in projects:
        fail(f"Unknown project: {proj_name}")
    proj_cfg = projects[proj_name]

    cands = [
        cand
        for cand in scan_project_skill_candidates(registry)
        if cand["project"] == proj_name and cand["name"] == name
    ]
    if not cands:
        skills = registry.get("skills") or {}
        if name in skills:
            fail(
                f"'{name}' is already a registered skill "
                f"(source: {skills[name].get('source')}). Nothing to import."
            )
        fail(
            f"No untracked skill named '{name}' found in project '{proj_name}'. "
            f"Run `hub sync` to see detected project-local skills."
        )
    cand = cands[0]
    if cand["category"] == "INVALID_NAME":
        fail(
            f"'{name}' has an invalid skill name (must match ^[a-z0-9-]+$). "
            f"Rename the directory and its SKILL.md `name:` first."
        )

    source_path = Path(cand["path"])
    dest = hub_skills_dir() / name
    if dest.exists():
        fail(
            f"{dest} already exists — refusing to overwrite. "
            f"Resolve the collision manually."
        )

    # 1. Copy into data home, then verify before touching the original.
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source_path, dest, symlinks=True, dirs_exist_ok=False)
    if not (dest / "SKILL.md").exists():
        shutil.rmtree(dest, ignore_errors=True)
        fail("Copy verification failed; aborted (original left untouched).")

    # 2. Register + enable, then persist.
    skills = registry.setdefault("skills", {})
    skills[name] = {
        "version": cand.get("version") or "1.0.0",
        "description": cand.get("description") or "",
        "source": collapse_home(dest),
        "type": "claude-skill",
        "scope": "project-specific",
        "upstream": None,
    }
    enabled = proj_cfg.setdefault("enabled", [])
    if name not in enabled:
        enabled.append(name)
    save_registry(registry)

    # 3. Remove the original real dir — it is now safely adopted. (If this
    #    fails, the next `hub sync` backs it up via ensure_symlink anyway.)
    try:
        shutil.rmtree(source_path)
    except OSError as e:
        print(
            f"  {c('!', YELLOW)} adopted, but could not remove original "
            f"{source_path}: {e}"
        )
        print("    (next `hub sync` will back it up automatically)")

    print(f"  {c('✓', GREEN)} adopted {name} into the hub ({collapse_home(dest)})")
    print(f"  {c('✓', GREEN)} enabled {name} on project {proj_name}")
    print(f"  → run `hub sync` to create the managed symlink")


@registry_mutation("project-add")
def cmd_project_add(args):
    registry = load_registry()
    projects = registry.get("projects", {})

    name = args.name
    validate_slug(name, label="project name")
    raw_path = Path(args.path).expanduser()
    if not raw_path.exists() or not raw_path.is_dir():
        fail(f"Path does not exist or is not a directory: {raw_path}")
    resolved = str(raw_path.resolve())

    if name in projects:
        print(f"Project '{name}' already registered at {projects[name]['path']}")
        return
    for other_name, other_cfg in projects.items():
        if Path(other_cfg["path"]).expanduser().resolve() == raw_path.resolve():
            fail(f"Path already used by project '{other_name}'")

    projects[name] = {"path": resolved, "enabled": [], "bundles": []}
    registry["projects"] = projects
    save_registry(registry)
    print(f"{c('✓', GREEN)} registered project '{name}' at {resolved}")
    print(f"  use 'hub enable <skill> --project {name}' to activate skills")


def clean_project_artifacts(
    proj_path: Path, registry: dict, dry_run: bool = False
) -> dict:
    """Plan/execute removal of hub-owned artifacts in a project directory.

    Returns a dict with the same shape whether dry-run or applied.
    Uses os.readlink (literal target) to decide ownership — NOT Path.resolve.
    """
    plan = {
        "removed_symlinks": [],
        "removed_mcp_entries": [],
        "removed_empty_dirs": [],
        "warnings": [],
    }

    if not proj_path.exists():
        plan["warnings"].append(f"project path no longer exists: {proj_path}")
        return plan

    data = data_home()
    skill_prefix = str(data / "skills") + os.sep
    mcp_prefix = str(data / "mcp-servers") + os.sep

    def _is_hub_owned(target_str: str) -> bool:
        return target_str.startswith(skill_prefix) or target_str.startswith(mcp_prefix)

    for skills_dir in (
        proj_path / ".claude" / "skills",
        proj_path / ".agents" / "skills",
    ):
        if not skills_dir.exists() or skills_dir.is_symlink():
            continue
        try:
            entries = list(skills_dir.iterdir())
        except OSError as e:
            plan["warnings"].append(f"cannot list {skills_dir}: {e}")
            continue
        for entry in entries:
            if not entry.is_symlink():
                continue
            try:
                target = os.readlink(entry)
                if not os.path.isabs(target):
                    target = str((entry.parent / target).resolve())
            except OSError:
                continue
            if _is_hub_owned(target):
                plan["removed_symlinks"].append(str(entry))
                if not dry_run:
                    try:
                        entry.unlink()
                    except OSError as e:
                        plan["warnings"].append(f"could not delete {entry}: {e}")
        # Empty-dir cleanup
        try:
            if not any(skills_dir.iterdir()):
                plan["removed_empty_dirs"].append(str(skills_dir))
                if not dry_run:
                    try:
                        skills_dir.rmdir()
                    except OSError as e:
                        plan["warnings"].append(f"could not rmdir {skills_dir}: {e}")
        except OSError:
            pass

    # MCP cleanup
    registered_mcps = {
        n
        for n, cfg in (registry.get("skills") or {}).items()
        if cfg.get("type") == "mcp-server"
    }
    for mcp_file in (proj_path / ".mcp.json", proj_path / ".pi" / "mcp.json"):
        if not mcp_file.exists():
            continue
        try:
            with open(mcp_file) as f:
                data_json = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            plan["warnings"].append(f"cannot read {mcp_file}: {e}")
            continue
        servers = data_json.get("mcpServers") or {}
        to_remove = [k for k in servers if k in registered_mcps]
        for k in to_remove:
            plan["removed_mcp_entries"].append({"file": str(mcp_file), "name": k})
        if to_remove and not dry_run:
            for k in to_remove:
                del servers[k]
            if servers:
                data_json["mcpServers"] = servers
                with open(mcp_file, "w") as f:
                    json.dump(data_json, f, indent=2)
                    f.write("\n")
            else:
                try:
                    mcp_file.unlink()
                except OSError as e:
                    plan["warnings"].append(f"could not delete {mcp_file}: {e}")

    return plan


@registry_mutation("project-remove")
def cmd_project_remove(args):
    registry = load_registry()
    projects = registry.get("projects", {})
    name = args.name

    if name not in projects:
        fail(f"Unknown project '{name}'.")

    dry_run = getattr(args, "dry_run", False)
    json_out = getattr(args, "json", False)
    proj_path = expand(projects[name]["path"])

    if dry_run:
        plan = clean_project_artifacts(proj_path, registry, dry_run=True)
        plan["project"] = name
        plan["project_path"] = str(proj_path)
        if json_out:
            print(json.dumps(plan, indent=2))
        else:
            print(f"\n{c('Plan for `hub project remove ' + name + '`:', BOLD)}")
            print(f"  Project path: {proj_path}")
            for sl in plan["removed_symlinks"]:
                print(f"  {c('-', RED)} symlink: {sl}")
            for me in plan["removed_mcp_entries"]:
                print(f"  {c('-', RED)} mcp entry {me['name']} in {me['file']}")
            for d in plan["removed_empty_dirs"]:
                print(f"  {c('-', RED)} empty dir: {d}")
            for w in plan["warnings"]:
                print(f"  {c('!', YELLOW)} {w}")
        return

    with data_home_lock():
        plan = clean_project_artifacts(proj_path, registry, dry_run=False)
        for sl in plan["removed_symlinks"]:
            print(f"  {c('✗', RED)} removed {sl}")
        for me in plan["removed_mcp_entries"]:
            print(f"  {c('✗', RED)} removed mcp entry {me['name']} from {me['file']}")
        for w in plan["warnings"]:
            print(f"  {c('!', YELLOW)} {w}")
        del projects[name]
        registry["projects"] = projects
        save_registry(registry)
    print(f"{c('✓', GREEN)} removed project '{name}' from registry.")


@registry_mutation("project-edit-path")
def cmd_project_edit_path(args):
    registry = load_registry()
    projects = registry.get("projects", {})
    name = args.name

    if name not in projects:
        fail(f"Unknown project '{name}'.")

    new_path = Path(args.new_path).expanduser()
    if not new_path.exists() or not new_path.is_dir():
        fail(f"New path does not exist or is not a directory: {new_path}")
    new_resolved = new_path.resolve()

    for other_name, other_cfg in projects.items():
        if other_name == name:
            continue
        if Path(other_cfg["path"]).expanduser().resolve() == new_resolved:
            fail(f"Path already used by project '{other_name}'")

    old_path = expand(projects[name]["path"])

    with data_home_lock():
        # Best-effort cleanup of old path
        plan = clean_project_artifacts(old_path, registry, dry_run=False)
        for sl in plan["removed_symlinks"]:
            print(f"  {c('✗', RED)} removed {sl}")
        for w in plan["warnings"]:
            print(f"  {c('!', YELLOW)} {w}")
        projects[name]["path"] = str(new_resolved)
        save_registry(registry)
        print(f"  {c('✓', GREEN)} updated path: {old_path} → {new_resolved}")

    _auto_sync()


# ─────────────────────────────────────────────────────────────────────────────
# hub skill metadata / update checks
# ─────────────────────────────────────────────────────────────────────────────


@registry_mutation("set-meta")
def cmd_set_meta(args):
    registry = load_registry()
    skills = registry.get("skills", {})
    name = args.name

    if name not in skills:
        fail(f"Unknown skill '{name}'.")

    cfg = skills[name]

    if args.version is not None:
        validate_version(args.version)
        cfg["version"] = args.version
    if args.description is not None:
        cfg["description"] = args.description
    if args.scope is not None:
        cfg["scope"] = parse_scope(args.scope)
        if cfg["scope"] == "global":
            # Per-project invocation overrides can never win against a
            # user-level skill (Claude Code precedence) — warn, keep them inert.
            holders = [
                p_name
                for p_name, p_cfg in (registry.get("projects") or {}).items()
                if name in (p_cfg.get("invocation_overrides") or {})
            ]
            if holders:
                print(
                    f"  {c('!', YELLOW)} '{name}' is now scope: global — its "
                    f"per-project invocation overrides become inert (user-level "
                    f"skills take precedence in Claude Code): {', '.join(sorted(holders))}",
                    file=sys.stderr,
                )
    if args.upstream is not None:
        cfg["upstream"] = args.upstream or None
    if getattr(args, "harnesses", None) is not None:
        # Empty string clears the affinity (back to "all effective harnesses")
        if args.harnesses == "":
            cfg.pop("harnesses", None)
        else:
            values = [v.strip() for v in args.harnesses.split(",") if v.strip()]
            cfg["harnesses"] = _validate_harness_affinity(values, f"skill '{name}'")

    invocation_changed = False
    if getattr(args, "invocation", None) is not None:
        mode = args.invocation
        if mode not in VALID_INVOCATIONS:
            fail(
                f"Invalid invocation '{mode}'. Expected one of: "
                f"{', '.join(VALID_INVOCATIONS)}."
            )
        if cfg.get("type") == "mcp-server":
            fail("Invocation mode applies to claude-skills only (MCP servers have no SKILL.md frontmatter).")
        ownership = infer_skill_ownership(name, cfg)
        if ownership["managed"] == "external":
            fail(
                f"'{name}' is owned by external source '{ownership['source_id']}' — "
                f"the hub does not edit upstream checkouts. Set a per-project override "
                f"instead: hub project invocation <project> --skill {name} --mode {mode}"
            )
        if ownership["managed"] == "starter":
            fail(f"'{name}' is a read-only starter asset — its frontmatter cannot be edited.")
        skill_md = skill_source(cfg) / "SKILL.md"
        try:
            text = skill_md.read_text()
        except OSError as exc:
            fail(f"Cannot read {skill_md}: {exc}")
        new_text = render_invocation_frontmatter(text, mode)
        if new_text is None:
            fail(
                f"Cannot rewrite {skill_md}: frontmatter is missing or unparseable — "
                f"fix the file manually, nothing was changed."
            )
        if new_text != text:
            skill_md.write_text(new_text)
            invocation_changed = True
        if mode == "auto":
            cfg.pop("invocation", None)
        else:
            cfg["invocation"] = mode

    skills[name] = cfg
    registry["skills"] = skills
    save_registry(registry)
    print(f"{c('✓', GREEN)} updated metadata for '{name}'")

    if invocation_changed:
        _auto_sync()


def cmd_update(args):
    # `hub update <skill>` keeps the legacy per-skill upstream check; bare
    # `hub update` self-checks the app/CLI against the latest GitHub Release.
    if getattr(args, "skill", None):
        return _cmd_update_skill(args.skill)
    return _cmd_update_self(args)


def _cmd_update_skill(target: str):
    registry = load_registry()
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
    print(f"  (auto-check not yet implemented — visit upstream manually)")


def _fetch_latest_release() -> dict:
    """GET the latest GitHub Release on the public mirror. Raises on failure."""
    import urllib.request

    req = urllib.request.Request(
        GITHUB_API_LATEST,
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
    home = code_home().resolve()
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
    import urllib.request
    import tarfile

    tarball = release.get("tarball_url") or (
        f"https://github.com/{GITHUB_REPO}/archive/refs/tags/v{latest}.tar.gz"
    )
    home = code_home().resolve()
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
    current = hub_version()
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
    url = release.get("html_url") or GITHUB_RELEASES_URL
    newer = _version_tuple(latest) > _version_tuple(current)
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
                    "code_home": str(code_home()),
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
            print(f"  git -C {code_home()} pull")
        return

    # standalone
    if not do_apply:
        if not as_json:
            print("\nStandalone install. Apply the update in place with:")
            print("  hub update --apply")
        return
    _apply_self_update(release, latest)


# ─────────────────────────────────────────────────────────────────────────────
# hub archive
# ─────────────────────────────────────────────────────────────────────────────


@registry_mutation("archive")
def cmd_archive(args):
    registry = load_registry()
    skills = registry.get("skills", {})
    projects = registry.get("projects", {})
    name = args.skill

    if name not in skills:
        print(f"Unknown skill '{name}'.")
        sys.exit(1)

    cfg = skills[name]
    src = skill_source(cfg)
    archive_dir = hub_skills_dir() / "_archive"
    archive_dest = archive_dir / name

    if getattr(args, "dry_run", False):
        print(f"{c('DRY-RUN', YELLOW)} archive '{name}' (no changes made):")
        if src.exists() and not src.is_symlink() and src.is_relative_to(data_home()):
            print(f"  would move {src} → skills/_archive/{name}/")
        affected = [p for p, pc in projects.items() if name in (pc.get("enabled") or [])]
        if affected:
            print(f"  would unenable from: {', '.join(affected)}")
        print(f"  would remove registry skill '{name}' and its symlinks")
        return

    if src.exists() and not src.is_symlink() and src.is_relative_to(data_home()):
        archive_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(archive_dest))
        print(f"  {c('→', YELLOW)} moved to skills/_archive/{name}/")

    del skills[name]
    registry["skills"] = skills

    for proj_name, proj_cfg in projects.items():
        enabled = proj_cfg.get("enabled", [])
        if name in enabled:
            enabled.remove(name)
            proj_cfg["enabled"] = enabled
            print(f"  {c('✗', RED)} removed from project: {proj_name}")

    save_registry(registry)

    remove_symlink(CLAUDE_SKILLS_DIR / name)
    for proj_cfg in projects.values():
        proj_path = expand(proj_cfg["path"])
        remove_symlink(proj_path / ".claude" / "skills" / name)
        remove_symlink(proj_path / ".agents" / "skills" / name)

    print(f"{c('✓', GREEN)} archived '{name}'")


# ─────────────────────────────────────────────────────────────────────────────
# hub rename
# ─────────────────────────────────────────────────────────────────────────────


@registry_mutation("rename")
def cmd_rename(args):
    registry = load_registry()
    skills = registry.get("skills", {})
    projects = registry.get("projects", {})
    old_name = args.old_name
    new_name = args.new_name

    if old_name not in skills:
        print(f"Unknown skill '{old_name}'.")
        sys.exit(1)

    if new_name in skills:
        print(f"'{new_name}' already exists in registry.")
        sys.exit(1)

    if getattr(args, "dry_run", False):
        print(f"{c('DRY-RUN', YELLOW)} rename '{old_name}' → '{new_name}' (no changes made):")
        src = skill_source(skills[old_name])
        if src.exists() and not src.is_symlink() and src.is_relative_to(data_home()):
            print(f"  would move dir {old_name}/ → {new_name}/ and update its SKILL.md name")
        affected = [p for p, pc in projects.items() if old_name in (pc.get("enabled") or [])]
        if affected:
            print(f"  would update projects: {', '.join(affected)}")
        print("  would re-sync symlinks")
        return

    cfg = dict(skills[old_name])
    src = skill_source(cfg)

    if src.exists() and not src.is_symlink() and src.is_relative_to(data_home()):
        new_src = src.parent / new_name
        shutil.move(str(src), str(new_src))
        cfg["source"] = collapse_home(new_src)
        print(f"  {c('→', CYAN)} renamed directory: {old_name}/ → {new_name}/")

        skill_md = new_src / "SKILL.md"
        if skill_md.exists():
            text = skill_md.read_text()
            updated = text.replace(f"name: {old_name}", f"name: {new_name}", 1)
            if updated != text:
                skill_md.write_text(updated)
                print(f"  {c('✓', GREEN)} updated SKILL.md name field")

    new_skills = {}
    for k, v in skills.items():
        new_skills[new_name if k == old_name else k] = cfg if k == old_name else v
    registry["skills"] = new_skills

    for proj_name, proj_cfg in projects.items():
        enabled = proj_cfg.get("enabled", [])
        if old_name in enabled:
            enabled[enabled.index(old_name)] = new_name
            proj_cfg["enabled"] = enabled
            print(
                f"  {c('✓', GREEN)} updated project {proj_name}: {old_name} → {new_name}"
            )

    save_registry(registry)

    remove_symlink(CLAUDE_SKILLS_DIR / old_name)
    for proj_cfg in projects.values():
        proj_path = expand(proj_cfg["path"])
        remove_symlink(proj_path / ".claude" / "skills" / old_name)
        remove_symlink(proj_path / ".agents" / "skills" / old_name)

    print(f"{c('✓', GREEN)} renamed '{old_name}' → '{new_name}'")

    _auto_sync()


# ─────────────────────────────────────────────────────────────────────────────
# hub bundle
# ─────────────────────────────────────────────────────────────────────────────


def cmd_bundle(args):
    sub = getattr(args, "bundle_cmd", None)
    dispatch = {
        "list": cmd_bundle_list,
        "apply": cmd_bundle_apply,
        "remove": cmd_bundle_remove,
        "new": cmd_bundle_new,
        "update": cmd_bundle_update,
        "delete": cmd_bundle_delete,
    }
    if sub in dispatch:
        dispatch[sub](args)
    else:
        print(
            "Usage: hub bundle {list|apply <name> --project <p>|remove <name> --project <p>|new <name> --skills s1,s2|delete <name>}"
        )


def cmd_bundle_list(_args):
    registry = load_registry()
    bundles = registry.get("bundles", {})
    projects = registry.get("projects", {})
    if not bundles:
        print(
            "No bundles defined. Create one with: hub bundle new <name> --skills skill1,skill2"
        )
        return

    # Build bundle → assigned projects map
    bundle_projects: dict[str, list[str]] = {name: [] for name in bundles}
    for proj_name, proj_cfg in projects.items():
        for b in proj_cfg.get("bundles", []):
            if b in bundle_projects:
                bundle_projects[b].append(proj_name)

    print(f"\n{c('Bundles:', BOLD)}")
    for name, cfg in bundles.items():
        bundle_skills = cfg.get("skills", [])
        icon = cfg.get("icon", "📦")
        desc = cfg.get("description", "")
        scope = bundle_scope(cfg)
        assigned = bundle_projects.get(name, [])
        assigned_str = (
            f"  {c('→', CYAN)} applies to all projects"
            if scope == "global"
            else (
                f"  {c('→', CYAN)} {', '.join(assigned)}"
                if assigned
                else f"  {c('(unassigned)', DIM)}"
            )
        )
        print(
            f"\n  {icon} {c(name, BOLD, CYAN)} [{scope}] — {desc} ({len(bundle_skills)} skills){assigned_str}"
        )
        for s in bundle_skills:
            print(f"    · {s}")
    print()


@registry_mutation("bundle-apply")
def cmd_bundle_apply(args):
    registry = load_registry()
    bundles = registry.get("bundles", {})
    projects = registry.get("projects", {})
    bundle_name = args.bundle_name

    if bundle_name not in bundles:
        print(f"Unknown bundle '{bundle_name}'. Run 'hub bundle list'.")
        sys.exit(1)

    if bundle_scope(bundles[bundle_name]) == "global":
        fail(
            f"Bundle '{bundle_name}' has scope 'global' and already applies everywhere. Manage its scope with 'hub bundle update {bundle_name} --scope project-specific'."
        )

    proj_name = getattr(args, "project", None)
    if not proj_name:
        print("Specify a project: hub bundle apply <bundle> --project <name>")
        sys.exit(1)

    if proj_name not in projects:
        print(f"Unknown project '{proj_name}'.")
        sys.exit(1)

    assigned = projects[proj_name].setdefault("bundles", [])
    if bundle_name in assigned:
        print(f"Bundle '{bundle_name}' already assigned to '{proj_name}'.")
        return

    assigned.append(bundle_name)
    save_registry(registry)
    print(f"{c('✓', GREEN)} assigned bundle '{bundle_name}' to '{proj_name}'.")

    _auto_sync()


@registry_mutation("bundle-remove")
def cmd_bundle_remove(args):
    registry = load_registry()
    bundles = registry.get("bundles", {})
    projects = registry.get("projects", {})
    bundle_name = args.bundle_name

    if bundle_name not in bundles:
        print(f"Unknown bundle '{bundle_name}'. Run 'hub bundle list'.")
        sys.exit(1)

    if bundle_scope(bundles[bundle_name]) == "global":
        fail(
            f"Bundle '{bundle_name}' has scope 'global' and is not stored in project assignments. Manage its scope with 'hub bundle update {bundle_name} --scope project-specific'."
        )

    proj_name = getattr(args, "project", None)
    if not proj_name:
        print("Specify a project: hub bundle remove <bundle> --project <name>")
        sys.exit(1)

    if proj_name not in projects:
        print(f"Unknown project '{proj_name}'.")
        sys.exit(1)

    assigned = projects[proj_name].get("bundles", [])
    if bundle_name not in assigned:
        print(f"Bundle '{bundle_name}' is not assigned to '{proj_name}'.")
        return

    assigned.remove(bundle_name)
    projects[proj_name]["bundles"] = assigned
    save_registry(registry)
    print(f"{c('✓', GREEN)} removed bundle '{bundle_name}' from '{proj_name}'.")

    _auto_sync()


@registry_mutation("bundle-new")
def cmd_bundle_new(args):
    registry = load_registry()
    bundles = registry.setdefault("bundles", {})
    skills = registry.get("skills", {})
    name = args.bundle_name
    validate_slug(name, label="bundle name")

    if name in bundles:
        print(f"Bundle '{name}' already exists.")
        sys.exit(1)

    skill_list = parse_csv(args.skills)
    unknown = [s for s in skill_list if s not in skills]
    if unknown:
        fail(f"Unknown skills for bundle '{name}': {', '.join(unknown)}")

    scope = parse_bundle_scope(getattr(args, "scope", None))
    bundles[name] = {
        "description": getattr(args, "description", None) or f"Bundle: {name}",
        "icon": getattr(args, "icon", None) or "📦",
        "scope": scope,
        "skills": skill_list,
    }
    save_registry(registry)
    print(
        f"{c('✓', GREEN)} created bundle '{name}' with {len(skill_list)} skills [{scope}]"
    )

    _auto_sync()


@registry_mutation("bundle-update")
def cmd_bundle_update(args):
    registry = load_registry()
    bundles = registry.get("bundles", {})
    skills = registry.get("skills", {})
    name = args.bundle_name

    if name not in bundles:
        fail(f"Unknown bundle '{name}'.")

    bundle = bundles[name]
    if args.skills is not None:
        skill_list = parse_csv(args.skills)
        unknown = [s for s in skill_list if s not in skills]
        if unknown:
            fail(f"Unknown skills for bundle '{name}': {', '.join(unknown)}")
        bundle["skills"] = skill_list
    if args.description is not None:
        bundle["description"] = args.description
    if args.icon is not None:
        bundle["icon"] = args.icon or "📦"
    if args.scope is not None:
        bundle["scope"] = parse_bundle_scope(args.scope)

    bundles[name] = bundle
    registry["bundles"] = bundles
    save_registry(registry)
    print(f"{c('✓', GREEN)} updated bundle '{name}'.")

    _auto_sync()


@registry_mutation("bundle-delete")
def cmd_bundle_delete(args):
    registry = load_registry()
    bundles = registry.get("bundles", {})
    projects = registry.get("projects", {})
    name = args.bundle_name

    if name not in bundles:
        print(f"Unknown bundle '{name}'.")
        sys.exit(1)

    if getattr(args, "dry_run", False):
        would_affect = [p for p, pc in projects.items() if name in (pc.get("bundles") or [])]
        print(f"{c('DRY-RUN', YELLOW)} delete bundle '{name}' (no changes made):")
        if would_affect:
            print(f"  would unassign from: {', '.join(would_affect)}")
        print(f"  would remove bundle '{name}' from registry")
        return

    # Remove from all project bundle assignments
    affected = []
    for proj_name, proj_cfg in projects.items():
        assigned = proj_cfg.get("bundles", [])
        if name in assigned:
            assigned.remove(name)
            proj_cfg["bundles"] = assigned
            affected.append(proj_name)

    del bundles[name]
    registry["bundles"] = bundles
    save_registry(registry)

    if affected:
        print(
            f"{c('✓', GREEN)} deleted bundle '{name}' (unassigned from: {', '.join(affected)})"
        )

        _auto_sync()
    else:
        print(f"{c('✓', GREEN)} deleted bundle '{name}'")


# ─────────────────────────────────────────────────────────────────────────────
# hub dashboard
# ─────────────────────────────────────────────────────────────────────────────


def _app_dir() -> Path:
    """Dev-mode app source dir (lives alongside hub.py in the repo checkout)."""
    return code_home() / "app"


def _app_env() -> dict[str, str]:
    """Env for subprocesses (Tauri dev/build). Pass both data home and code home."""
    env = {
        **os.environ,
        "SKILL_HUB_HOME": str(data_home()),
        "SKILL_HUB_CODE": str(code_home()),
    }
    # Drop legacy var so subprocesses do not pick it up
    env.pop("SKILL_HUB_DIR", None)
    return env


def _find_app_binary() -> Optional[Path]:
    app_dir = _app_dir()
    import platform

    system = platform.system()
    if system == "Darwin":
        binary_candidates = [
            app_dir
            / "src-tauri"
            / "target"
            / "release"
            / "Skill Tree.app"
            / "Contents"
            / "MacOS"
            / "Skill Tree",
            app_dir
            / "src-tauri"
            / "target"
            / "debug"
            / "Skill Tree.app"
            / "Contents"
            / "MacOS"
            / "Skill Tree",
            app_dir / "src-tauri" / "target" / "release" / "skill-tree",
            app_dir / "src-tauri" / "target" / "debug" / "skill-tree",
        ]
    elif system == "Windows":
        binary_candidates = [
            app_dir / "src-tauri" / "target" / "release" / "Skill Tree.exe",
            app_dir / "src-tauri" / "target" / "debug" / "Skill Tree.exe",
        ]
    else:
        binary_candidates = [
            app_dir / "src-tauri" / "target" / "release" / "skill-tree",
            app_dir / "src-tauri" / "target" / "debug" / "skill-tree",
        ]
    return next((p for p in binary_candidates if p.exists()), None)


def cmd_app_dev(_args):
    app_dir = _app_dir()
    print(f"{c('Starting Skill Tree in dev mode', BOLD)} (Vite HMR + Tauri)")
    try:
        subprocess.run(
            ["npm", "run", "tauri", "dev"],
            cwd=str(app_dir),
            env=_app_env(),
        )
    except KeyboardInterrupt:
        print("\nDev server stopped.")


def cmd_app_build(args):
    app_dir = _app_dir()
    print(f"{c('Building Skill Tree production app', BOLD)}")
    cmd = ["npm", "run", "tauri", "build"]
    # Updater artifacts (`.app.tar.gz` + `.sig`) must be SIGNED, which requires
    # TAURI_SIGNING_PRIVATE_KEY (set in CI). For a local build/install that key
    # is absent and `tauri build` aborts after bundling the .app — breaking
    # `hub app build --install`. When the key is missing, build WITHOUT updater
    # artifacts so the local install succeeds; CI (with the key) still produces
    # the signed updater payload. Pass `--no-updater` to force-skip explicitly.
    no_updater = getattr(args, "no_updater", False) or not os.environ.get(
        "TAURI_SIGNING_PRIVATE_KEY"
    )
    if no_updater:
        print(
            f"{c('·', DIM)} no TAURI_SIGNING_PRIVATE_KEY — building without "
            "updater artifacts (fine for local install)"
        )
        cmd += ["--", "--config", '{"bundle":{"createUpdaterArtifacts":false}}']
    subprocess.run(
        cmd,
        cwd=str(app_dir),
        env=_app_env(),
        check=True,
    )

    if getattr(args, "install", False):
        import platform

        if platform.system() != "Darwin":
            print(f"{c('Install step currently supported on macOS only.', YELLOW)}")
            return
        built_app = (
            app_dir
            / "src-tauri"
            / "target"
            / "release"
            / "bundle"
            / "macos"
            / "Skill Tree.app"
        )
        installed_app = Path("/Applications/Skill Tree.app")
        if not built_app.exists():
            print(f"{c('Built app bundle not found after build.', RED)}")
            sys.exit(1)
        if installed_app.exists():
            shutil.rmtree(installed_app)
        shutil.copytree(built_app, installed_app)
        print(f"{c('Installed updated app to /Applications/Skill Tree.app', GREEN)}")


def cmd_dashboard(args):
    if getattr(args, "dev", False):
        cmd_app_dev(args)
        return

    binary = _find_app_binary()

    if binary is None:
        app_dir = _app_dir()
        print(f"{c('Skill Tree binary not found.', BOLD)}")
        print("Build it first with:")
        print("  hub app build")
        print("Or build + install on macOS with:")
        print("  hub app build --install")
        print("Or launch in dev mode with:")
        print("  hub app dev")
        print(f"  (manual equivalent: cd {app_dir} && npm run tauri build)")
        sys.exit(1)

    try:
        subprocess.run([str(binary)], env=_app_env())
    except KeyboardInterrupt:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# hub cleanup-backups
# ─────────────────────────────────────────────────────────────────────────────


def cmd_cleanup_backups(_args):
    backup_dirs = [
        Path.home() / ".claude" / "_hub-backups",
        PI_AGENT_DIR / "_hub-backups",
    ]

    removed = 0
    for backup_dir in backup_dirs:
        if not backup_dir.exists():
            continue
        for path in sorted(backup_dir.rglob("*"), reverse=True):
            if path.is_file() or path.is_symlink():
                path.unlink()
                removed += 1
            elif path.is_dir():
                try:
                    path.rmdir()
                except OSError:
                    pass
        try:
            backup_dir.rmdir()
        except OSError:
            pass

    print(f"{c('✓', GREEN)} removed {removed} backup artifact(s)")


# ─────────────────────────────────────────────────────────────────────────────
# hub version
# ─────────────────────────────────────────────────────────────────────────────


def cmd_harnesses_emit_schema(_args):
    """Print the harness registry as JSON (consumed by app build.rs)."""
    import harnesses as _harnesses

    print(_harnesses.emit_schema_json())


def cmd_harness_list(args):
    """List harnesses with installed / on-globally / used-by-projects."""
    import harnesses as _harnesses

    json_out = getattr(args, "json", False)
    registry = _read_registry_optional()
    installed = _harnesses.detect_installed()
    on_globally = set(registry.get("harnesses_global") or [])
    used_by: dict[str, list[str]] = {}
    for proj_name, proj_cfg in (registry.get("projects") or {}).items():
        for h_id in proj_cfg.get("harnesses") or []:
            used_by.setdefault(h_id, []).append(proj_name)

    rows = []
    for h_id, h in sorted(_harnesses.HARNESSES.items()):
        rows.append(
            {
                "id": h_id,
                "label": h.label,
                "installed": h_id in installed,
                "on_globally": h_id in on_globally,
                "used_by_projects": sorted(used_by.get(h_id, [])),
            }
        )

    if json_out:
        print(json.dumps(rows, indent=2))
        return

    print(f"\n{c('Harnesses', BOLD, CYAN)}\n")
    header = f"{'HARNESS':<14}{'INSTALLED':<12}{'GLOBAL':<10}USED BY"
    print(c(header, BOLD))
    for row in rows:
        inst = c("✓", GREEN) if row["installed"] else c("✗", DIM)
        glob = c("on", GREEN) if row["on_globally"] else c("off", DIM)
        used = (
            ", ".join(row["used_by_projects"])
            if row["used_by_projects"]
            else c("(none)", DIM)
        )
        print(f"{row['id']:<14}{inst:<23}{glob:<19}{used}")
    print()


def _modify_harnesses_global(action: str, h_id: str) -> None:
    """Add or remove `h_id` from `harnesses_global`. action: 'add' or 'remove'."""
    import harnesses as _harnesses

    if h_id not in _harnesses.HARNESSES:
        fail(f"Unknown harness: {h_id}")
    installed = _harnesses.detect_installed()
    if h_id not in installed:
        print(
            f"  {c('!', YELLOW)} {h_id} is not installed on this machine "
            f"(registry is portable — proceeding anyway)",
            file=sys.stderr,
        )
    with data_home_lock():
        registry = load_registry()
        current = list(registry.get("harnesses_global") or [])
        if action == "add":
            if h_id not in current:
                current.append(h_id)
            registry["harnesses_global"] = current
            print(f"{c('✓', GREEN)} enabled '{h_id}' globally")
        else:
            registry["harnesses_global"] = [v for v in current if v != h_id]
            print(f"{c('✓', GREEN)} disabled '{h_id}' globally")
        save_registry(registry)


def cmd_harness_enable(args):
    _modify_harnesses_global("add", args.id)


def cmd_harness_disable(args):
    _modify_harnesses_global("remove", args.id)


def cmd_remote_list(args):
    """List configured remotes from the `remotes:` block (Wave 0: read-only).

    Wave 1 adds add/show/sync/resolve/etc.; this is the minimal lister the
    framework wave ships so `hub remote list` is wired end-to-end.
    """
    from remotes import load_remotes

    json_out = getattr(args, "json", False)
    registry = _read_registry_optional()
    remotes = load_remotes(registry)

    if json_out:
        print(
            json.dumps(
                [
                    {
                        "id": r.id,
                        "connector": r.connector,
                        "sync_enabled": r.sync_enabled,
                        "apply_global_bundles": r.apply_global_bundles,
                        "ssh_host": r.ssh_host,
                        "bundles": list(r.bundles),
                        "enabled": list(r.enabled),
                    }
                    for r in remotes.values()
                ],
                indent=2,
            )
        )
        return

    if not remotes:
        print(c("no remotes configured", DIM))
        return

    print(f"\n{c('Remotes', BOLD, CYAN)}\n")
    header = f"{'REMOTE':<20}{'CONNECTOR':<14}{'SYNC':<8}HOST"
    print(c(header, BOLD))
    for r in remotes.values():
        sync = c("on", GREEN) if r.sync_enabled else c("off", DIM)
        host = r.ssh_host or c("(none)", DIM)
        print(f"{r.id:<20}{r.connector:<14}{sync:<17}{host}")
    print()


def cmd_remote_connectors(args):
    """List every registered connector + its metadata (read-only, no lock).

    Runs discovery (builtin/private/entry-point/drop-in) and emits one row per
    connector with `key/label/description/transport_kind/publishable/available/
    source`. `available` is True for every registered connector — the disabled
    "More connectors" placeholder is a UI-only concept. Drives the app's
    registry-derived connector cards via a Tauri marshal command.
    """
    from connectors import all_connectors, connector_source

    conns = all_connectors()
    rows = [
        {
            "key": key,
            "label": conn.display_label,
            "description": getattr(conn, "description", "") or "",
            "transport_kind": getattr(conn, "transport_kind", "ssh") or "ssh",
            "publishable": bool(getattr(conn, "publishable", False)),
            "available": True,
            "source": connector_source(key),
        }
        for key, conn in sorted(conns.items())
    ]

    if getattr(args, "json", False):
        print(json.dumps(rows, indent=2))
        return

    if not rows:
        print(c("no connectors registered", DIM))
        return

    print(f"\n{c('Connectors', BOLD, CYAN)}\n")
    header = f"{'KEY':<24}{'TRANSPORT':<12}{'PUBLISHABLE':<13}{'SOURCE':<12}LABEL"
    print(c(header, BOLD))
    for r in rows:
        pub = c("yes", GREEN) if r["publishable"] else c("no", DIM)
        print(
            f"{r['key']:<24}{r['transport_kind']:<12}{pub:<22}"
            f"{r['source']:<12}{r['label']}"
        )
    print()


@registry_mutation("remote-add")
def cmd_remote_add(args):
    """Register a remote (references only — secrets stay in the OS keychain)."""
    from remotes import RemoteTarget

    registry = load_registry()
    remotes = registry.setdefault("remotes", {})
    rid = args.id
    if rid in remotes:
        fail(f"Remote '{rid}' already exists. Use `hub remote remove {rid}` first.")

    transport = {}
    if getattr(args, "ssh_host", None):
        transport["ssh_host"] = args.ssh_host

    # HTTP/MCP connectors (goalrunner-orchestrator) carry an https endpoint in the
    # transport dict. Enforce https up front so the bearer token can never travel
    # in the clear (fail-closed, parallel to the transport's own guard).
    endpoint = getattr(args, "endpoint", None)
    if endpoint:
        if not str(endpoint).lower().startswith("https://"):
            fail(f"--endpoint must be an https:// URL (got {endpoint!r}); the bearer "
                 "token must never travel over plaintext.")
        transport["endpoint"] = endpoint

    # --token-ref: the keychain handle the connector resolves the bearer token from
    # at call time. The registry stores ONLY the ref (secret_ref) — never the token
    # bytes. If --token (or stdin) supplies a value, store it under the ref now.
    token_ref = getattr(args, "token_ref", None)
    secret_ref = getattr(args, "secret_ref", None) or token_ref
    if token_ref:
        from connectors.transport import keychain

        token_value = getattr(args, "token", None)
        if token_value is None and not sys.stdin.isatty():
            token_value = sys.stdin.readline().rstrip("\n")
        if token_value:
            try:
                keychain.set_secret(token_ref, token_value)
                print(f"  {c('✓', GREEN)} stored bearer token in keychain under {c(token_ref, BOLD)}")
            except Exception as e:
                fail(f"failed to store token in keychain: {e}")
        else:
            print(
                f"  {c('·', DIM)} no token value provided (pass --token or pipe via stdin) — "
                f"registered the ref {token_ref!r} only; store the token before syncing"
            )

    # H2.3 multi-host-key pin: --host-key may be repeated and/or comma-separated.
    # Collapse to a single string when one pin, a list when several.
    host_key = _normalize_host_key_arg(getattr(args, "host_key", None))

    # M1: custom (non-publishable) or root-transport connectors default
    # sync_enabled=false so a UI skill-toggle can't silently trigger a privileged
    # remote write. Hermes (publishable, non-root) keeps default-on. An explicit
    # --sync / --no-sync always wins.
    sync_enabled = _default_sync_enabled(
        args.connector,
        explicit_sync=getattr(args, "sync", False),
        explicit_no_sync=getattr(args, "no_sync", False),
    )

    # D15: per-remote opt-in for global-bundle inheritance, default OFF. A new
    # remote inherits NO global-scope bundle skills unless --apply-global is set.
    apply_global = bool(getattr(args, "apply_global", False))

    target = RemoteTarget(
        id=rid,
        connector=args.connector,
        transport=transport,
        secret_ref=secret_ref,
        host_key_sha256=host_key,
        home=getattr(args, "home", None),
        sync_enabled=sync_enabled,
        apply_global_bundles=apply_global,
        bundles=tuple(_split_csv(getattr(args, "bundles", None))),
        enabled=tuple(_split_csv(getattr(args, "enabled", None))),
    )
    remotes[rid] = target.to_dict()
    save_registry(registry)
    print(f"  {c('✓', GREEN)} registered remote {c(rid, BOLD)} (connector: {args.connector})")
    print(
        f"  {c('·', DIM)} apply_global_bundles={apply_global} "
        f"({'inherits' if apply_global else 'does NOT inherit'} global-scope bundle skills)"
    )
    if not target.host_key_sha256:
        print(f"  {c('!', YELLOW)} no host-key pin set — add one before syncing (TOFU)")
    if not sync_enabled:
        print(
            f"  {c('·', DIM)} sync_enabled=false (custom/root-transport connectors "
            f"default off — enable with `hub remote enable {rid}` or re-add with --sync)"
        )


def _normalize_host_key_arg(value):
    """Normalize a repeated/comma-separated --host-key arg → None | str | list[str].

    `argparse action="append"` yields a list (or None). Each element may itself be
    comma-separated. One pin collapses to a bare string (the legacy shape); two or
    more become a list (H2.3 multi-key).
    """
    if not value:
        return None
    fprs: list[str] = []
    items = value if isinstance(value, list) else [value]
    for item in items:
        for part in str(item).split(","):
            part = part.strip()
            if part and part not in fprs:
                fprs.append(part)
    if not fprs:
        return None
    return fprs[0] if len(fprs) == 1 else fprs


def _default_sync_enabled(connector: str, *, explicit_sync: bool, explicit_no_sync: bool) -> bool:
    """M1: decide a new remote's default sync_enabled.

    Explicit --no-sync / --sync always win. Otherwise default OFF for a connector
    that is non-publishable (custom) OR uses a root transport (codex-workers);
    default ON for a publishable non-root connector (Hermes).
    """
    if explicit_no_sync:
        return False
    if explicit_sync:
        return True
    return not _connector_defaults_sync_off(connector)


def _connector_defaults_sync_off(connector: str) -> bool:
    """True when a connector should default to sync_enabled=false (M1).

    A connector defaults OFF if it is non-publishable (custom) OR root-transport.
    Resolution is best-effort against the registered connector instance; an
    unknown connector is treated as custom (off) to fail safe.
    """
    from connectors import all_connectors

    conn = all_connectors().get(connector)
    if conn is None:
        return True  # unknown → treat as custom, default off (fail safe)
    if not getattr(conn, "publishable", False):
        return True  # custom / private connector
    # Root-transport connectors (e.g. codex-workers) also default off, even if a
    # future one were marked publishable.
    if getattr(conn, "root_transport", False):
        return True
    return False


def _split_csv(value) -> list:
    if not value:
        return []
    return [v.strip() for v in str(value).split(",") if v.strip()]


def _require_remote(registry: dict, rid: str):
    from remotes import load_remotes

    remotes = load_remotes(registry)
    if rid not in remotes:
        fail(f"Unknown remote '{rid}'.")
    return remotes[rid]


def cmd_remote_show(args):
    """Show one remote's config + resolved skills (read-only)."""
    from remotes import resolve_remote_skills

    registry = _read_registry_optional()
    target = _require_remote(registry, args.id)
    remote_cfg = (registry.get("remotes") or {}).get(args.id) or {}
    resolved = resolve_remote_skills(remote_cfg, registry)
    info = {
        "id": target.id,
        "connector": target.connector,
        "ssh_host": target.ssh_host,
        "host_key_pinned": bool(target.host_key_sha256),
        "secret_ref": target.secret_ref,
        "home": target.home,
        "sync_enabled": target.sync_enabled,
        "apply_global_bundles": target.apply_global_bundles,
        "bundles": list(target.bundles),
        "enabled": list(target.enabled),
        "resolved_skills": resolved,
    }
    if getattr(args, "json", False):
        print(json.dumps(info, indent=2))
        return
    print(f"\n{c('Remote', BOLD, CYAN)} {c(target.id, BOLD)}\n")
    print(f"  connector:    {target.connector}")
    print(f"  ssh_host:     {target.ssh_host or c('(none)', DIM)}")
    print(f"  host-key pin: {'yes' if target.host_key_sha256 else c('no', YELLOW)}")
    print(f"  secret_ref:   {target.secret_ref or c('(none)', DIM)}")
    print(f"  home:         {target.home or c('(connector default)', DIM)}")
    print(f"  sync_enabled: {target.sync_enabled}")
    print(f"  apply_global: {target.apply_global_bundles}")
    print(f"  bundles:      {', '.join(target.bundles) or c('(none)', DIM)}")
    print(f"  enabled:      {', '.join(target.enabled) or c('(none)', DIM)}")
    print(f"  resolved:     {', '.join(resolved) or c('(none)', DIM)}")
    print()


def cmd_remote_diff(args):
    """Read-only plan: per-artifact drift status. Performs NO remote writes."""
    from connectors import get_connector

    registry = _read_registry_optional()
    target = _require_remote(registry, args.id)
    try:
        connector = get_connector(target.connector)
    except KeyError as e:
        fail(str(e))

    health = connector.health_check(target)
    if not health.ok:
        if getattr(args, "json", False):
            print(json.dumps({"remote": args.id, "reachable": health.reachable,
                              "ok": False, "detail": health.detail}, indent=2))
        else:
            print(
                f"  {c('!', YELLOW)} {args.id} not ready "
                f"(reachable={health.reachable} auth={health.authenticated} "
                f"host_key={health.host_key_match}): {health.detail}"
            )
        return

    remote_cfg = (registry.get("remotes") or {}).get(args.id) or {}
    desired = build_remote_desired_state(remote_cfg, registry)
    plan = connector.plan(target, desired)
    rows = [
        {"name": a.name, "kind": a.kind, "action": a.action.value,
         "drift": a.drift_status.value if a.drift_status else None}
        for a in plan.actions
    ]
    if getattr(args, "json", False):
        print(json.dumps({"remote": args.id, "actions": rows}, indent=2))
        return
    print(f"\n{c('Plan for', BOLD, CYAN)} {c(args.id, BOLD)} (no writes)\n")
    if not rows:
        print(f"  {c('·', DIM)} nothing to do")
    for r in rows:
        print(f"  {r['kind']:<10} {r['name']:<24} {r['action']:<20} {r['drift'] or ''}")
    print()


def cmd_remote_sync(args):
    """Sync one remote now (honors non-clobber; --force ignores sync_enabled)."""
    registry = load_registry()
    target = _require_remote(registry, args.id)
    if not target.sync_enabled and not getattr(args, "force", False):
        fail(
            f"Remote '{args.id}' has sync_enabled=false. "
            f"Use `hub remote sync {args.id} --force` to sync anyway."
        )
    import harnesses as _harnesses

    installed = _harnesses.detect_installed()
    strict = bool(getattr(args, "strict", False))
    alarming = _run_remote_dispatch(registry, installed, only=args.id, strict=strict)
    if strict and alarming:
        print(f"\n{c('✗ remote sync: alarming failure(s)', RED, BOLD)} ({alarming})\n")
        sys.exit(2)
    print(f"\n{c('✓ remote sync complete', GREEN, BOLD)}\n")


@registry_mutation("remote-resolve")
def cmd_remote_resolve(args):
    """Explicit, non-destructive resolution of a drifted/conflicting artifact.

    push        — force-push local content to the remote (widens allow set)
    pull        — adopt remote content back into the hub (re-base sidecar)
    keep-local  — re-base the sidecar to local so the artifact reads in-sync
    keep-remote — re-base the sidecar to the remote sha (accept the agent's edit)
    """
    from connectors import Action, get_connector
    from connectors import sidecar as _sidecar
    from connectors import hermes as _hermes
    from connectors.layouts import agentskills

    # F2: validate the artifact name BEFORE any local or remote path is built.
    # The `pull` op adopts the remote tree into `hub_skills_dir()/<name>` and
    # re-bases a sidecar keyed on the name; an unvalidated `../../tmp/x` would
    # write a local dir outside the skills dir and poison the sidecar with a
    # traversal name. Mirror `import-skill`'s slug guard for skills; doc/mcp
    # names are not slugs (e.g. `MEMORY.md`) so they are constrained to the
    # known doc set / a slash-free server name instead.
    if args.kind == "skill":
        validate_slug(args.artifact, "artifact")
    elif args.kind == "agent_doc":
        from connectors.hermes import DOC_PATHS as _DOC_PATHS
        if args.artifact not in _DOC_PATHS:
            fail(
                f"Unknown agent doc '{args.artifact}'. "
                f"Expected one of: {', '.join(sorted(_DOC_PATHS))}."
            )
    else:  # mcp — a bare server name, never a path
        if "/" in args.artifact or ".." in args.artifact.split("/"):
            fail(f"Invalid mcp server name '{args.artifact}'.")

    registry = load_registry()
    target = _require_remote(registry, args.id)
    connector = get_connector(target.connector)
    health = connector.health_check(target)
    if not health.ok:
        fail(f"Remote '{args.id}' not reachable/ready: {health.detail}")

    name = args.artifact
    kind = args.kind
    surface = {"skill": "skills", "mcp": "mcp", "agent_doc": "docs"}[kind]
    op = args.op

    remote_cfg = (registry.get("remotes") or {}).get(args.id) or {}
    desired = build_remote_desired_state(remote_cfg, registry)
    desired_item = next(
        (d for d in desired.items() if d.kind == kind and d.name == name), None
    )

    if op == "push":
        if desired_item is None:
            fail(f"No local artifact '{name}' to push.")
        plan = connector.plan(target, desired)
        # Widen allow so a drifted/conflict artifact is force-pushed.
        result = connector.apply(
            target, plan, allow=frozenset({Action.CREATE, Action.FAST_FORWARD,
                                           Action.REMOVE, Action.SKIP_REMOTE_DRIFTED,
                                           Action.SKIP_CONFLICT})
        )
        print(f"  {c('✓', GREEN)} push resolved (forced) — re-run `hub remote diff {args.id}` to confirm")
        return

    if op in ("pull", "keep-remote"):
        # Fetch the remote artifact + adopt/re-base.
        from connectors.transport import audit as _audit

        home = connector._resolve_home(target, connector._transport(target))
        paths = _hermes._Paths(home)
        if kind == "skill":
            ref = paths.managed_skill_dir(name)
            blob = connector.pull_artifact(target, ref)
            tree = _hermes._decode_skill_tree(name, blob)
            remote_sha = agentskills.tree_sha256(tree)
            if op == "pull":
                # M2 confirm-on-pull: adopting a remote/agent-edited skill brings
                # UNAUTHENTICATED LLM output (OWASP LLM05) into the hub where it
                # can re-propagate via sync. Show a summary + require explicit
                # confirmation (or --yes for headless). NEVER auto-adopt.
                existing = (registry.get("skills") or {}).get(name)
                print(f"\n{c('Pull remote-agent-edited content', BOLD, YELLOW)}")
                print(f"  skill:    {c(name, BOLD)}")
                print(f"  origin:   remote:{args.id}")
                print(f"  remote sha256: {remote_sha}")
                print(f"  files:    {len(tree.files)} ({', '.join(sorted(tree.files)[:6])}"
                      f"{' …' if len(tree.files) > 6 else ''})")
                print(f"  scope:    project-specific (quarantined — never global)")
                if existing:
                    print(f"  {c('!', YELLOW)} overwrites the existing hub skill {name!r}")
                if not getattr(args, "yes", False) and not _confirm(
                    "Adopt this remote-agent-authored content into the hub?"
                ):
                    fail("Pull aborted — no content adopted.")
                # Adopt the remote tree into the hub skill dir + registry.
                dest = hub_skills_dir() / name
                dest.mkdir(parents=True, exist_ok=True)
                agentskills.write_skill_dir(dest, tree)
                skills = registry.setdefault("skills", {})
                entry = skills.get(name) or {}
                entry.setdefault("version", "1.0.0")
                entry["source"] = collapse_home(dest)
                entry["type"] = "claude-skill"
                # M2 quarantine: FORCE project-specific (never global) so a
                # poisoned pull-back can't fan out via global bundles — even if a
                # prior entry was global.
                entry["scope"] = "project-specific"
                entry["origin"] = f"remote:{args.id}"
                skills[name] = entry
                save_registry(registry)
                # M2 provenance: tag the content as remote-agent-origin in the
                # audit log so a doctor can later flag a global skill carrying
                # agent-authored bytes.
                _audit.append(
                    args.id, "pull-adopt", f"skill:{name}",
                    sha_after=remote_sha,
                    detail="remote-agent-origin: adopted into hub (scope=project-specific)",
                )
                print(f"  {c('✓', GREEN)} pulled {name} into the hub (origin: remote:{args.id}, quarantined)")
        else:
            ref = name if kind == "mcp" else paths.doc_path(name)
            data = connector.pull_artifact(target, ref)
            remote_sha = hashlib.sha256(data).hexdigest()
            print(f"  {c('✓', GREEN)} fetched remote {kind} {name} ({len(data)} bytes)")
        # Re-base the sidecar to the remote sha.
        sc = _sidecar.read_sidecar(args.id, surface)
        sc.record(name, kind, remote_sha)
        _sidecar.write_sidecar(sc)
        print(f"  {c('✓', GREEN)} sidecar re-based to remote content")
        return

    if op == "keep-local":
        if desired_item is None:
            fail(f"No local artifact '{name}' to keep.")
        sc = _sidecar.read_sidecar(args.id, surface)
        sc.record(name, kind, desired_item.sha256)
        _sidecar.write_sidecar(sc)
        print(
            f"  {c('✓', GREEN)} sidecar re-based to local content — next sync "
            f"reads {name} as local-ahead and fast-forwards it"
        )
        return


@registry_mutation("remote-disable")
def cmd_remote_disable(args):
    registry = load_registry()
    remotes = registry.get("remotes") or {}
    if args.id not in remotes:
        fail(f"Unknown remote '{args.id}'.")
    remotes[args.id]["sync_enabled"] = False
    save_registry(registry)
    print(f"  {c('✓', GREEN)} {args.id} sync disabled")
    # H2.1: offer the credential off-boarding step (the box still trusts the
    # hub's key until it is revoked). Honored only when --revoke-key is passed,
    # else just a hint so the user knows the follow-up exists.
    if getattr(args, "revoke_key", False):
        cmd_remote_revoke_key(args)
    else:
        print(
            f"  {c('·', DIM)} the box still trusts the hub's key — run "
            f"`hub remote revoke-key {args.id}` (or re-run with --revoke-key) to off-board it"
        )


@registry_mutation("remote-enable")
def cmd_remote_enable(args):
    registry = load_registry()
    remotes = registry.get("remotes") or {}
    if args.id not in remotes:
        fail(f"Unknown remote '{args.id}'.")
    remotes[args.id]["sync_enabled"] = True
    save_registry(registry)
    print(f"  {c('✓', GREEN)} {args.id} sync enabled")


@registry_mutation("remote-set-global")
def cmd_remote_set_global(args):
    """Flip a remote's `apply_global_bundles` flag (D15).

    `hub remote set-global <id> on|off`. When off (the default), the remote
    inherits NO global-scope bundle skills — only its own bundles + enabled.
    Consistent with `remote enable`/`disable` (the sync toggle).
    """
    state = str(getattr(args, "state", "")).lower()
    # Accept the positional on|off, or an explicit --apply-global on|off.
    explicit = getattr(args, "apply_global", None)
    if explicit is not None:
        state = str(explicit).lower()
    truthy = {"on", "true", "yes", "1"}
    falsy = {"off", "false", "no", "0"}
    if state not in truthy and state not in falsy:
        fail("expected on|off (or --apply-global on|off)")
    value = state in truthy

    registry = load_registry()
    remotes = registry.get("remotes") or {}
    if args.id not in remotes:
        fail(f"Unknown remote '{args.id}'.")
    remotes[args.id]["apply_global_bundles"] = value
    save_registry(registry)
    print(
        f"  {c('✓', GREEN)} {args.id} apply_global_bundles="
        f"{c('on' if value else 'off', GREEN if value else DIM)} "
        f"({'inherits' if value else 'does NOT inherit'} global-scope bundle skills)"
    )


@registry_mutation("remote-equip")
def cmd_remote_equip(args):
    """`hub remote equip <id> --kind {bundle|skill} --name <name> --state {on|off}`.

    Registry-only toggle of a remote's equipped bundles/skills (D8). Validates the
    remote id and that <name> exists in the registry (bundle in `bundles:`, skill
    in `skills:`); adds/removes it from the remote's `bundles`/`enabled` array.
    NEVER pushes to the box — the remote is reconciled by the next `hub sync` /
    `hub remote sync`. Idempotent (on when present, off when absent).
    """
    kind = args.kind
    name = args.name
    on = args.state == "on"

    registry = load_registry()
    remotes = registry.get("remotes") or {}
    if args.id not in remotes:
        fail(f"Unknown remote '{args.id}'.")

    if kind == "bundle":
        if name not in (registry.get("bundles") or {}):
            fail(f"Unknown bundle '{name}'.")
        field = "bundles"
    elif kind == "skill":
        if name not in (registry.get("skills") or {}):
            fail(f"Unknown skill '{name}'.")
        field = "enabled"
    else:
        fail(f"Unknown kind '{kind}' (expected bundle|skill).")

    remote_cfg = remotes[args.id]
    current = list(remote_cfg.get(field) or [])
    if on:
        if name not in current:
            current.append(name)
    else:
        current = [x for x in current if x != name]
    remote_cfg[field] = current
    save_registry(registry)

    result = {
        "ok": True,
        "bundles": list(remote_cfg.get("bundles") or []),
        "enabled": list(remote_cfg.get("enabled") or []),
    }
    if getattr(args, "json", False):
        print(json.dumps(result, indent=2))
    else:
        state_str = c("on", GREEN) if on else c("off", DIM)
        print(f"  {c('✓', GREEN)} {args.id}: {kind} {c(name, BOLD)} {state_str}")
    return result


@registry_mutation("remote-remove")
def cmd_remote_remove(args):
    """Unregister a remote: drop the registry entry + its ownership sidecars.

    Never touches the remote box — this is a local de-registration only.
    """
    from connectors import sidecar as _sidecar

    registry = load_registry()
    remotes = registry.get("remotes") or {}
    if args.id not in remotes:
        fail(f"Unknown remote '{args.id}'.")

    # H2.1: optionally off-board the credential on the box BEFORE dropping the
    # registry entry (we need the entry to resolve the transport + key material).
    if getattr(args, "revoke_key", False):
        cmd_remote_revoke_key(args)

    del remotes[args.id]
    save_registry(registry)
    for surface in ("skills", "mcp", "docs"):
        _sidecar.delete_sidecar(args.id, surface)
    print(f"  {c('✓', GREEN)} removed remote {args.id} (registry entry + sidecars)")
    if not getattr(args, "revoke_key", False):
        print(
            f"  {c('·', DIM)} the box may still trust the hub's key — "
            f"manual off-boarding: see docs/remote-connectors.md (revoke-key was not run)"
        )


def cmd_remote_clear(args):
    """Forget hub ownership of a remote's artifacts (clears sidecars only).

    The remote box is NOT touched; this just makes the hub treat every remote
    artifact as unmanaged (so cleanup becomes a no-op). The registry entry stays.
    """
    from connectors import sidecar as _sidecar

    registry = _read_registry_optional()
    _require_remote(registry, args.id)
    cleared = []
    for surface in ("skills", "mcp", "docs"):
        if _sidecar.delete_sidecar(args.id, surface):
            cleared.append(surface)
    if cleared:
        print(f"  {c('✓', GREEN)} cleared ownership sidecars: {', '.join(cleared)}")
    else:
        print(f"  {c('·', DIM)} no ownership sidecars to clear for {args.id}")


def cmd_remote_import_skill(args):
    """Adopt a box-native skill into the hub with provenance, or --scan candidates.

    Scan is read-only (lists never-managed box skills). Import fetches the box
    skill, registers it (scope: project-specific) with `origin: remote:<id>`, and
    NEVER mutates the box copy (D9 / skill-import spec).
    """
    from connectors import get_connector
    from connectors import hermes as _hermes
    from connectors.layouts import agentskills

    registry = _read_registry_optional()
    rid = args.remote
    target = _require_remote(registry, rid)
    connector = get_connector(target.connector)

    if getattr(args, "scan", False):
        health = connector.health_check(target)
        if not health.ok:
            fail(f"Remote '{rid}' not reachable/ready: {health.detail}")
        arts = connector.list_remote_artifacts(target, "skill")
        existing = registry.get("skills") or {}
        candidates = []
        for a in arts:
            if a.managed:
                continue  # already hub-owned
            cat = "NEW" if SLUG_RE.match(a.name) else "INVALID_NAME"
            if a.name in existing:
                cat = "ALREADY_REGISTERED"
            candidates.append({
                "name": a.name,
                "ref": a.ref,
                "sha256": a.sha256,
                "category": cat,
                "origin": f"remote:{rid}",
            })
        if getattr(args, "json", False):
            print(json.dumps({"remote": rid, "candidates": candidates}, indent=2))
            return
        print(f"\n{c('Import candidates', BOLD, CYAN)} on {c(rid, BOLD)}\n")
        if not candidates:
            print(f"  {c('·', DIM)} no box-native skills to import")
        for cand in candidates:
            label = cand["name"]
            note = ""
            if cand["category"] == "INVALID_NAME":
                note = c(" (invalid name)", YELLOW)
            elif cand["category"] == "ALREADY_REGISTERED":
                note = c(" (already registered)", DIM)
            print(f"  {label}{note}  origin={cand['origin']}")
        print()
        return

    name = args.name
    if not name:
        fail("Provide a skill NAME to import, or use --scan to list candidates.")

    health = connector.health_check(target)
    if not health.ok:
        fail(f"Remote '{rid}' not reachable/ready: {health.detail}")

    if not SLUG_RE.match(name):
        fail(f"'{name}' has an invalid skill name (must match ^[a-z0-9-]+$).")

    skills = registry.get("skills") or {}
    if name in skills:
        fail(f"'{name}' is already a registered skill. Nothing to import.")

    # Locate the box-native skill (unmanaged only — never adopt a managed one here).
    arts = connector.list_remote_artifacts(target, "skill")
    match = next((a for a in arts if a.name == name and not a.managed), None)
    if match is None:
        fail(
            f"No never-managed box-native skill '{name}' found on '{rid}'. "
            f"Run `hub remote import-skill --remote {rid} --scan` to list candidates."
        )

    # Read-fetch the whole tree (NEVER mutates the box copy) and adopt locally.
    blob = connector.pull_artifact(target, match.ref)
    tree = _hermes._decode_skill_tree(name, blob)
    dest = hub_skills_dir() / name
    if dest.exists():
        fail(f"{dest} already exists — refusing to overwrite.")
    dest.mkdir(parents=True, exist_ok=True)
    agentskills.write_skill_dir(dest, tree)
    if not (dest / "SKILL.md").exists():
        shutil.rmtree(dest, ignore_errors=True)
        fail("Fetched skill has no SKILL.md; aborted (box copy untouched).")

    with data_home_lock():
        registry = load_registry()
        skills = registry.setdefault("skills", {})
        meta = _parse_skill_md(dest / "SKILL.md") or {}
        skills[name] = {
            "version": meta.get("version") or "1.0.0",
            "description": meta.get("description") or "",
            "source": collapse_home(dest),
            "type": "claude-skill",
            "scope": "project-specific",
            "upstream": None,
            "origin": f"remote:{rid}",
        }
        save_registry(registry)

    # M2 provenance: record the remote-agent origin in the audit log so a later
    # doctor can flag agent-authored bytes that reach a global scope.
    from connectors.transport import audit as _audit
    _audit.append(
        rid, "import", f"skill:{name}",
        sha_after=getattr(match, "sha256", None),
        detail="remote-agent-origin: imported into hub (scope=project-specific)",
    )

    print(f"  {c('✓', GREEN)} imported {name} into the hub (origin: remote:{rid})")
    print(f"  {c('·', DIM)} the box copy under skills/ was read, not modified (D9)")


# ─────────────────────────────────────────────────────────────────────────────
# Wave 3 CLI gap closure — the subcommands the Tauri layer marshals so no ssh /
# ssh-keyscan / ssh-copy-id business logic lives in Rust (CLAUDE.md: Rust only
# marshals). All reuse the connector/transport methods; no ssh logic is
# duplicated in hub.py, and secrets never enter argv (SSH auth is via ssh-agent).
# ─────────────────────────────────────────────────────────────────────────────

_REMOTE_DOC_NAMES = ("SOUL.md", "MEMORY.md", "USER.md")


def _transport_for_host(ssh_host: str, *, host_key=None):
    """Build a Wave-0 SshTransport for a bare ssh-host (no registry entry yet)."""
    from connectors.transport.ssh import SshTransport

    return SshTransport(ssh_host, host_key_sha256=host_key)


def cmd_remote_keyscan(args):
    """Fetch the live SHA256 host-key fingerprint for an ssh-host (TOFU pin).

    Accepts a raw ssh-host (e.g. `hermes@moon-base`), NOT a registry id, because
    the onboarding wizard needs this BEFORE a remote is registered. Pure read —
    delegates to `SshTransport.fetch_host_key_fingerprint()`.
    """
    ssh_host = args.ssh_host
    transport = _transport_for_host(ssh_host)
    try:
        fpr = transport.fetch_host_key_fingerprint()
    except Exception as e:  # keyscan tooling missing / resolution failure
        fpr = None
        detail = str(e)
    else:
        detail = "host key fetched" if fpr else "no host key returned by ssh-keyscan"

    if getattr(args, "json", False):
        print(json.dumps({"ssh_host": ssh_host, "fingerprint": fpr, "detail": detail}, indent=2))
        return
    if fpr:
        print(f"  {c('✓', GREEN)} {ssh_host}\n  {c(fpr, BOLD)}")
    else:
        print(f"  {c('!', YELLOW)} {ssh_host}: {detail}")


def pinned_signing_pubkey(registry: dict) -> Optional[str]:
    """The hub signing PUBLIC key pinned in the registry's top-level `signing:` block.

    Returns None when no key is pinned (signing not yet initialized). The block
    holds references only — the PUBLIC key + a short `key_id`; the PRIVATE key
    never enters the registry (it lives in the 0600 hub-owned signing-key file).
    """
    block = registry.get("signing") or {}
    pub = block.get("pubkey")
    return str(pub).strip() if pub else None


def cmd_remote_signing_key(args):
    """Bootstrap (`--init`) or display (`--show`) the hub's pinned signing pubkey.

    `--init` generates the dedicated ed25519 hub signing keypair (private key in a
    0600 hub-owned file, never in the registry or on argv) and PINS the public key
    in the registry's top-level `signing:` block, parallel to a host-key pin.
    Idempotent — a second `--init` re-pins the existing pubkey. `--show` prints the
    pinned pubkey (and whether the on-disk key + ssh-keygen are present).
    """
    from connectors import signing as _signing

    do_init = getattr(args, "init", False)
    do_show = getattr(args, "show", False)
    if not do_init and not do_show:
        do_show = True  # default action

    if do_init:
        try:
            pub = _signing.ensure_signing_key()
        except _signing.SigningUnavailable as e:
            fail(f"ssh-keygen unavailable — cannot initialize signing key: {e}")
        except _signing.SigningError as e:
            fail(f"signing key initialization failed: {e}")
        kid = _signing.key_id(pub)
        with data_home_lock():
            # Tolerate a not-yet-bootstrapped data home: seed an empty registry
            # rather than hard-failing — initializing the signing key is itself a
            # bootstrap-adjacent step.
            registry = _read_registry_optional()
            registry["signing"] = {"pubkey": pub, "key_id": kid}
            save_registry(registry)
        if getattr(args, "json", False):
            print(json.dumps({"initialized": True, "pubkey": pub, "key_id": kid}, indent=2))
            return
        print(f"  {c('✓', GREEN)} hub signing key initialized + pinned in the registry")
        print(f"  {c('key_id', DIM)}  {kid}")
        print(f"  {c('pubkey', DIM)}  {pub}")
        return

    # --show
    registry = _read_registry_optional()
    pinned = pinned_signing_pubkey(registry)
    on_disk = _signing.get_public_key()
    available = _signing.is_available()
    if getattr(args, "json", False):
        print(json.dumps({
            "pinned_pubkey": pinned,
            "key_id": (registry.get("signing") or {}).get("key_id"),
            "on_disk_pubkey": on_disk,
            "ssh_keygen_available": available,
        }, indent=2))
        return
    print(f"\n{c('Hub signing key', BOLD, CYAN)}\n")
    if pinned:
        print(f"  pinned:   {pinned}")
        print(f"  key_id:   {(registry.get('signing') or {}).get('key_id') or ''}")
    else:
        print(f"  {c('!', YELLOW)} no signing key pinned — run `hub remote signing-key --init`")
    print(f"  on-disk:  {'yes' if on_disk else c('no', YELLOW)}")
    print(f"  ssh-keygen: {'available' if available else c('MISSING', YELLOW)}")
    print()


def cmd_remote_setup_key(args):
    """One-time `ssh-copy-id` for a remote (confirmed onboarding, D3).

    Accepts EITHER a registered remote id (resolves its ssh_host + pin) OR a raw
    ssh-host via --ssh-host — so the onboarding wizard can install the key BEFORE
    the remote is registered. Attempts to append our pubkey to the remote's
    authorized_keys via the transport's `copy_id`. On failure (no password auth /
    no existing key on a fresh box), prints the EXACT root-side
    fallback the user must run manually; it never attempts the root write itself.
    """
    host_key = None
    ssh_host = getattr(args, "ssh_host", None)
    if ssh_host:
        # Raw-host mode (pre-registration): no registry lookup needed.
        rid_label = ssh_host
    elif not getattr(args, "id", None):
        fail("Provide a remote id or --ssh-host <host>.")
    else:
        registry = _read_registry_optional()
        target = _require_remote(registry, args.id)
        ssh_host = target.ssh_host
        host_key = target.host_key_sha256
        rid_label = args.id
        if not ssh_host:
            fail(f"Remote '{args.id}' has no ssh_host configured.")

    pubkey = _read_default_ssh_pubkey()
    if pubkey is None:
        fail(
            "No SSH public key found (looked for ~/.ssh/id_ed25519.pub, "
            "~/.ssh/id_rsa.pub). Generate one with `ssh-keygen` first."
        )

    transport = _transport_for_host(ssh_host, host_key=host_key)
    try:
        transport.copy_id(pubkey)
    except Exception as e:
        # Print the precise root-side fallback (for a fresh box where
        # `ssh hermes@` is not yet authorized).
        user = ssh_host.split("@", 1)[0] if "@" in ssh_host else "hermes"
        bare = ssh_host.split("@", 1)[-1]
        key_line = pubkey.strip()
        fallback = (
            f"ssh root@{bare} "
            f"\"mkdir -p ~{user}/.ssh && "
            f"echo '{key_line}' >> ~{user}/.ssh/authorized_keys && "
            f"chown -R {user}:{user} ~{user}/.ssh && "
            f"chmod 700 ~{user}/.ssh && chmod 600 ~{user}/.ssh/authorized_keys\""
        )
        if getattr(args, "json", False):
            print(json.dumps({"remote": rid_label, "ok": False, "detail": str(e),
                              "fallback": fallback}, indent=2))
            sys.exit(1)
        print(f"  {c('✗', RED)} ssh-copy-id to {ssh_host} failed: {e}")
        print(f"  {c('·', DIM)} If password/existing-key auth is unavailable, run as root:")
        print(f"\n    {fallback}\n")
        sys.exit(1)

    if getattr(args, "json", False):
        print(json.dumps({"remote": rid_label, "ok": True, "detail": "key installed"}, indent=2))
        return
    print(f"  {c('✓', GREEN)} pubkey installed on {ssh_host} (authorized_keys)")


def cmd_remote_setup_codex_helper(args):
    """C2: stage the least-privilege codex-workers box helper install (NO box write).

    Generates (idempotent) the DEDICATED restricted ed25519 keypair the
    codex-workers connector uses — NOT the user's existing root key, which is
    left untouched — and prints the EXACT box-side install commands:

      1. copy `connectors_private/box/codex-skill-apply` → /usr/local/bin/ (chmod 755)
      2. append the forced-command line to root's authorized_keys:
         command="/usr/local/bin/codex-skill-apply",restrict <dedicated-pubkey>

    It DOES NOT run them — installing the forced-command key is a one-time box
    write, user-approved at GATE 4b. Also notes the infra-repo mirror path.
    """
    import shlex

    try:
        from connectors_private import codex_key
    except ImportError:
        fail(
            "The codex-workers connector is not available in this build "
            "(the private connectors package is not installed)."
        )

    do_init = getattr(args, "init", False)
    try:
        if do_init:
            pub = codex_key.ensure_key()
        else:
            pub = codex_key.get_public_key()
            if pub is None:
                pub = codex_key.ensure_key()
    except codex_key.CodexKeyError as e:
        fail(str(e))

    helper_src = code_home() / "connectors_private" / "box" / "codex-skill-apply"
    ak_line = codex_key.authorized_keys_line(pub)
    install_path = codex_key.HELPER_INSTALL_PATH

    # The box-side commands (printed, NOT executed). `id` is an optional remote id
    # used only to resolve the ssh host for the scp/ssh examples.
    ssh_host = None
    if getattr(args, "id", None):
        registry = _read_registry_optional()
        target = _require_remote(registry, args.id)
        ssh_host = target.ssh_host
    host = ssh_host or "root@<box>"
    bare = host.split("@", 1)[-1]

    scp_cmd = f"scp {shlex.quote(str(helper_src))} root@{bare}:{install_path}"
    chmod_cmd = f"ssh root@{bare} chmod 755 {install_path}"
    # The authorized_keys line carries `command="…"` quotes; the cleanest
    # copy-pasteable form streams it over stdin so the local shell never has to
    # nest-quote it. The user runs this single block as-is.
    ak_cmd = (
        f"ssh root@{bare} 'umask 077 && mkdir -p ~/.ssh && "
        f"cat >> ~/.ssh/authorized_keys' <<'EOF'\n"
        f"{ak_line}\n"
        f"EOF"
    )
    mirror_note = (
        "<infra-repo>/<...>/codex-skill-apply  (mirror discipline — keep the box "
        "copy and the repo copy identical; do NOT edit the infra repo from here)"
    )

    if getattr(args, "json", False):
        print(json.dumps({
            "dedicated_pubkey": pub,
            "helper_source": str(helper_src),
            "install_path": install_path,
            "authorized_keys_line": ak_line,
            "box_commands": [scp_cmd, chmod_cmd, ak_cmd],
            "mirror_path_note": mirror_note,
            "executed": False,
        }, indent=2))
        return

    print(f"\n{c('Codex-workers least-privilege helper — install plan (NOT executed)', BOLD, CYAN)}\n")
    print(f"  {c('dedicated pubkey', DIM)}  {pub}")
    print(f"  {c('helper source', DIM)}     {helper_src}")
    print(f"\n  {c('Run these on the box (user-approved, GATE 4b):', BOLD)}\n")
    print(f"    # 1. install the helper")
    print(f"    {scp_cmd}")
    print(f"    {chmod_cmd}\n")
    print(f"    # 2. pin the forced-command restricted key in root's authorized_keys")
    print(f"    {ak_cmd}\n")
    print(f"  {c('!', YELLOW)} the user's root '{bare}' key is untouched; this adds a SEPARATE")
    print(f"     restricted key that can ONLY run {install_path}.")
    print(f"  {c('·', DIM)} mirror: {mirror_note}\n")


# ─────────────────────────────────────────────────────────────────────────────
# H2 — credential lifecycle: revoke-key / repin / rotate-token
# ─────────────────────────────────────────────────────────────────────────────


def _pubkey_body(line: str) -> Optional[str]:
    """Extract the base64 key body from an authorized_keys / pubkey line.

    A pubkey is `<type> <base64-body> [comment]` possibly preceded by options
    (e.g. `command="…",restrict ssh-ed25519 AAAA… comment`). The base64 body is
    the stable identity used to match a specific key surgically — NOT the comment
    (which a user can change) and NOT the whole line (which carries options).
    """
    if not line:
        return None
    toks = line.strip().split()
    for i, tok in enumerate(toks):
        if tok.startswith(("ssh-", "ecdsa-", "sk-")) and i + 1 < len(toks):
            return toks[i + 1]
    return None


def _resolve_revoke_plan(registry: dict, target):
    """Resolve (transport, ak_path, match_pred, key_desc) for a connector's revoke.

    Returns the transport that reaches the authorized_keys file, the remote path
    of that file, a client-side line-matching predicate that surgically selects
    ONLY this connector's hub-installed line, and a human description.

    Raises (via `fail`) when the key material to match cannot be resolved.
    """
    from connectors import get_connector

    connector = target.connector

    try:
        conn = get_connector(connector)
    except KeyError:
        fail(
            f"The '{connector}' connector is not available in this build "
            "(its plugin package is not installed)."
        )

    # A connector that installs a dedicated / privileged key (e.g. codex-workers'
    # root forced-command key) resolves its own transport + surgical matcher via
    # the `setup_key_transport` hook. `None` → fall through to the generic
    # user-key path below. This removes the last connector-name conditional.
    custom = conn.setup_key_transport(target)
    if custom is not None:
        return custom

    # Hermes (and any other non-root connector): remove the hub's OWN pubkey line
    # from the connector user's ~/.ssh/authorized_keys, over the connector's own
    # transport (the hermes user).
    pub = _read_default_ssh_pubkey()
    if not pub:
        fail(
            "No local SSH public key found (looked for ~/.ssh/id_ed25519.pub, "
            "id_rsa.pub) to identify the installed authorized_keys line."
        )
    body = _pubkey_body(pub)
    transport = conn._transport(target)
    ak_path = "~/.ssh/authorized_keys"

    def match(ln: str) -> bool:
        return body is not None and body in ln

    return transport, ak_path, match, "hub pubkey (this connector's installed key)"


def cmd_remote_revoke_key(args):
    """H2.1: surgically remove THIS connector's hub-installed authorized_keys line.

    The inverse of the key install. For Hermes: drops the hub's own pubkey line
    from the hermes user's `~/.ssh/authorized_keys`. For codex-workers: drops the
    `command="…codex-skill-apply…",restrict <dedicated-pubkey>` line from root's
    authorized_keys, matched by the dedicated key body (NOT a blunt truncate —
    every other line is preserved). Idempotent. Shows the line(s) + confirms; pass
    --yes for headless.
    """
    registry = _read_registry_optional()
    target = _require_remote(registry, args.id)

    transport, ak_path, match, key_desc = _resolve_revoke_plan(registry, target)

    try:
        lines = transport.read_authorized_keys(ak_path)
    except Exception as e:
        fail(f"Could not read {ak_path} on '{args.id}': {e}")

    to_remove = [ln for ln in lines if match(ln)]
    json_out = getattr(args, "json", False)

    if not to_remove:
        if json_out:
            print(json.dumps({"remote": args.id, "removed": 0,
                              "detail": "no matching line (already revoked)"}, indent=2))
        else:
            print(f"  {c('·', DIM)} {args.id}: no matching {key_desc} line — already revoked (no-op)")
        return

    if not json_out:
        print(f"\n{c('Revoke key', BOLD, YELLOW)} on {c(args.id, BOLD)} ({ak_path})\n")
        print(f"  {c('will REMOVE', RED)} ({key_desc}):")
        for ln in to_remove:
            shown = ln if len(ln) <= 100 else ln[:97] + "…"
            print(f"    {c('-', RED)} {shown}")
        print(f"  {c('keeps', GREEN)} {len(lines) - len(to_remove)} other line(s) untouched\n")

    if not getattr(args, "yes", False) and not json_out:
        if not _confirm(f"Remove this {key_desc} line from {args.id}?"):
            fail("Revoke aborted — no change made.")

    try:
        removed = transport.revoke_authorized_key(match, ak_path=ak_path)
    except Exception as e:
        fail(f"Revoke failed on '{args.id}': {e}")

    from connectors.transport import audit as _audit
    _audit.append(args.id, "revoke-key", key_desc, detail=f"removed {removed} authorized_keys line(s)")

    if json_out:
        print(json.dumps({"remote": args.id, "removed": removed, "key": key_desc}, indent=2))
        return
    print(f"  {c('✓', GREEN)} revoked {removed} {key_desc} line(s) on {args.id}")


def cmd_remote_repin(args):
    """H2.2: audited host-key rotation — re-pin a legitimately rotated host key.

    Fetches the live fingerprint, shows OLD vs NEW, requires confirmation
    (--yes headless, or --accept <fpr> to pin a specific known-good value),
    replaces the registry pin, re-seeds the hub-owned known_hosts (drops the
    stale line, adds the new), and audit-logs the rotation. Without this a legit
    host rekey hard-fails every op with no recovery path.
    """
    from connectors import get_connector

    registry = load_registry()
    target = _require_remote(registry, args.id)
    json_out = getattr(args, "json", False)

    old_pin = target.host_key_sha256
    old_pins = []
    if isinstance(old_pin, (list, tuple)):
        old_pins = [str(p) for p in old_pin]
    elif old_pin:
        old_pins = [str(old_pin)]

    accept = getattr(args, "accept", None)
    connector = get_connector(target.connector)
    transport = connector._transport(target)

    if accept:
        new_fpr = accept.strip()
        detail_src = "operator-supplied (--accept)"
    else:
        try:
            new_fpr = transport.fetch_host_key_fingerprint()
        except Exception as e:
            fail(f"Could not fetch the live host key for '{args.id}': {e}")
        detail_src = "live host scan"
        if not new_fpr:
            fail(f"ssh-keyscan returned no host key for '{args.id}'.")

    if new_fpr in old_pins:
        if json_out:
            print(json.dumps({"remote": args.id, "repinned": False,
                              "detail": "live key already matches the pin"}, indent=2))
        else:
            print(f"  {c('·', DIM)} {args.id}: live key already matches the pin — no change")
        return

    if not json_out:
        print(f"\n{c('Host-key rotation (repin)', BOLD, YELLOW)} on {c(args.id, BOLD)}\n")
        print(f"  OLD pin: {', '.join(old_pins) or c('(none — TOFU)', DIM)}")
        print(f"  NEW pin: {c(new_fpr, BOLD)}  ({detail_src})")
        print(f"  {c('!', YELLOW)} only proceed if you KNOW this rotation is legitimate "
              f"(a rekey, not a MITM).\n")

    if not getattr(args, "yes", False) and not accept and not json_out:
        if not _confirm(f"Replace the host-key pin for {args.id} with {new_fpr}?"):
            fail("Repin aborted — pin unchanged.")

    # Replace the registry pin (host_key_sha256 lives at the entry top level OR
    # under transport; write it at the top level, the canonical location).
    remotes = registry.setdefault("remotes", {})
    entry = remotes.get(args.id) or {}
    entry["host_key_sha256"] = new_fpr
    if isinstance(entry.get("transport"), dict):
        entry["transport"].pop("host_key_sha256", None)
    remotes[args.id] = entry
    save_registry(registry)

    # Re-seed the hub-owned known_hosts: drop every stale line for this host, then
    # let the next verify() seed the new pinned line. Simplest robust approach:
    # rebuild known_hosts by removing the old fingerprints' lines.
    reseeded = _reseed_known_hosts_after_repin(target, transport, old_pins, new_fpr)

    from connectors.transport import audit as _audit
    _audit.append(
        args.id, "repin",
        f"host-key: {', '.join(old_pins) or '(none)'} → {new_fpr}",
        sha_before=(old_pins[0] if old_pins else None),
        sha_after=new_fpr,
        detail=f"host-key rotation ({detail_src}); known_hosts reseeded={reseeded}",
    )

    if json_out:
        print(json.dumps({"remote": args.id, "repinned": True,
                          "old_pins": old_pins, "new_pin": new_fpr,
                          "known_hosts_reseeded": reseeded}, indent=2))
        return
    print(f"  {c('✓', GREEN)} re-pinned {args.id}: now trusts {new_fpr}")
    print(f"  {c('·', DIM)} known_hosts re-seeded (stale entry dropped, new key added)")


def _reseed_known_hosts_after_repin(target, transport, old_pins, new_fpr) -> bool:
    """Drop stale host-key lines from the hub-owned known_hosts + seed the new pin.

    Returns True if the file was rewritten. Best-effort: a missing known_hosts is
    fine (the next verify() seeds it fresh). Re-fetches the live key lines and
    keeps only the line(s) whose fingerprint == the new pin.
    """
    from connectors.transport.ssh import known_hosts_path

    kh = known_hosts_path()
    # Re-scan live lines via the existing transport (its runner is the test/live
    # subprocess) and filter to the new fingerprint.
    try:
        lines = transport._scan_key_lines()  # noqa: SLF001 — our transport
    except Exception:
        lines = []

    existing = kh.read_text().splitlines() if kh.exists() else []
    # Drop any line that fingerprints to an OLD pin (stale) — keep unrelated hosts.
    stale_bodies = set()
    for ln, fpr in (lines or []):
        if fpr in old_pins:
            stale_bodies.add(ln)
    kept = [ln for ln in existing if ln.strip() and ln not in stale_bodies]

    # Add the new pinned line(s) if not already present.
    new_lines = [ln for ln, fpr in (lines or []) if fpr == new_fpr and ln not in kept]
    if not new_lines and not stale_bodies:
        # Nothing to drop and no new line obtained from the scan — leave the file;
        # the next verify() with the new pin will seed it.
        return False
    out = kept + new_lines
    kh.parent.mkdir(parents=True, exist_ok=True)
    kh.write_text(("\n".join(out) + "\n") if out else "")
    try:
        kh.chmod(0o600)
    except OSError:
        pass
    return True


def cmd_remote_rotate_token(args):
    """H2.4: rotate a connector's keychain token (Wave-5 gateway connector).

    For an SSH connector there is no bearer token (auth is via ssh-agent / the
    dedicated key), so this is a no-op-with-message today. For a future gateway
    connector carrying a `secret_ref`, it overwrites the keychain entry with a
    new value read from stdin (never argv). Wave 5 fills in the gateway side.
    """
    registry = _read_registry_optional()
    target = _require_remote(registry, args.id)
    json_out = getattr(args, "json", False)

    secret_ref = target.secret_ref
    if not secret_ref:
        msg = (
            f"Remote '{args.id}' (connector {target.connector}) has no token "
            f"(secret_ref) — SSH connectors authenticate via ssh-agent / the "
            f"dedicated key, not a bearer token. Nothing to rotate."
        )
        if json_out:
            print(json.dumps({"remote": args.id, "rotated": False, "detail": msg}, indent=2))
        else:
            print(f"  {c('·', DIM)} {msg}")
        return

    # A connector that DOES carry a token (Wave-5 gateway): read the new value
    # from stdin and overwrite the keychain entry. Kept minimal here.
    from connectors.transport import keychain

    if sys.stdin.isatty():
        fail(
            f"Pipe the new token on stdin, e.g. "
            f"`printf '%s' \"$NEW_TOKEN\" | hub remote rotate-token {args.id}`."
        )
    new_value = sys.stdin.read().strip()
    if not new_value:
        fail("Empty token on stdin — nothing rotated.")
    try:
        keychain.set_secret(secret_ref, new_value)
    except Exception as e:
        fail(f"Keychain write failed for {secret_ref!r}: {e}")

    from connectors.transport import audit as _audit
    _audit.append(args.id, "rotate-token", secret_ref, detail="keychain entry overwritten")

    if json_out:
        print(json.dumps({"remote": args.id, "rotated": True, "secret_ref": secret_ref}, indent=2))
        return
    print(f"  {c('✓', GREEN)} rotated token for {args.id} (keychain entry {secret_ref})")


def _read_default_ssh_pubkey() -> Optional[str]:
    """Read the user's default SSH public key (ed25519 preferred, then RSA)."""
    ssh_dir = Path.home() / ".ssh"
    for name in ("id_ed25519.pub", "id_rsa.pub", "id_ecdsa.pub"):
        p = ssh_dir / name
        if p.exists():
            try:
                text = p.read_text().strip()
            except OSError:
                continue
            if text:
                return text
    return None


def _resolve_remote_for_doc(args):
    """Shared helper: load + validate a remote, connector, and doc name."""
    from connectors import get_connector

    registry = _read_registry_optional()
    target = _require_remote(registry, args.id)
    doc = args.doc
    if doc not in _REMOTE_DOC_NAMES:
        fail(f"Unknown doc '{doc}'. Expected one of: {', '.join(_REMOTE_DOC_NAMES)}.")
    try:
        connector = get_connector(target.connector)
    except KeyError as e:
        fail(str(e))
    return registry, target, connector, doc


def cmd_remote_list_docs(args):
    """List the LIVE agent docs present on the box (SOUL.md/MEMORY.md/USER.md).

    Read-only. Surfaces each documented doc independent of any pending diff plan,
    so the UI can show fetch→edit→push for docs that exist on the box even when
    nothing is queued. Backed by `connector.list_remote_artifacts(kind=
    "agent_doc")` (which reads each doc's sha and skips absent ones).
    """
    from connectors import get_connector

    registry = _read_registry_optional()
    target = _require_remote(registry, args.id)
    try:
        connector = get_connector(target.connector)
    except KeyError as e:
        fail(str(e))

    health = connector.health_check(target)
    if not health.ok:
        if getattr(args, "json", False):
            print(json.dumps({"remote": args.id, "ok": False,
                              "reachable": health.reachable,
                              "detail": health.detail, "docs": []}, indent=2))
            return
        fail(f"Remote '{args.id}' not reachable/ready: {health.detail}")

    # _list_docs skips absent docs; report the full documented set with present
    # flags so the UI can show which exist vs which the box does not have yet.
    present = {a.name: a for a in connector.list_remote_artifacts(target, "agent_doc")}
    docs = []
    for name in _REMOTE_DOC_NAMES:
        art = present.get(name)
        docs.append({
            "name": name,
            "present": art is not None,
            "sha256": art.sha256 if art is not None else None,
            "managed": bool(art.managed) if art is not None else False,
        })
    if getattr(args, "json", False):
        print(json.dumps({"remote": args.id, "ok": True, "docs": docs}, indent=2))
        return
    print(f"\n{c('Agent docs', BOLD, CYAN)} on {c(args.id, BOLD)}\n")
    for d in docs:
        mark = c("✓", GREEN) if d["present"] else c("·", DIM)
        suffix = "" if d["present"] else c(" (absent)", DIM)
        print(f"  {mark} {d['name']}{suffix}")
    print()


def cmd_remote_fetch_doc(args):
    """Fetch one remote agent-doc's content (so the app editor loads real text).

    Returns the doc bytes via the connector's `fetch_artifact` against the
    resolved doc path. Read-only; never mutates the box.
    """
    from connectors import hermes as _hermes

    registry, target, connector, doc = _resolve_remote_for_doc(args)
    health = connector.health_check(target)
    if not health.ok:
        if getattr(args, "json", False):
            print(json.dumps({"remote": args.id, "doc": doc, "ok": False,
                              "reachable": health.reachable, "detail": health.detail}, indent=2))
            return
        fail(f"Remote '{args.id}' not reachable/ready: {health.detail}")

    home = connector._resolve_home(target, connector._transport(target))
    paths = _hermes._Paths(home)
    ref = paths.doc_path(doc)
    try:
        data = connector.fetch_artifact(target, ref)
    except Exception as e:
        if getattr(args, "json", False):
            print(json.dumps({"remote": args.id, "doc": doc, "ok": False, "detail": str(e)}, indent=2))
            return
        fail(f"Could not fetch {doc} from '{args.id}': {e}")
    text = data.decode("utf-8", "replace")
    sha = hashlib.sha256(data).hexdigest()
    if getattr(args, "json", False):
        print(json.dumps({"remote": args.id, "doc": doc, "ok": True,
                          "sha256": sha, "content": text}, indent=2))
        return
    # Raw content to stdout for non-JSON consumers/piping.
    sys.stdout.write(text)


def cmd_remote_push_doc(args):
    """Write an edited agent-doc back to the box (content via stdin).

    Atomic + backup-on-change (transport handles both). Drift-checked: if the
    remote doc has changed since the hub last fetched/pushed it (sidecar base
    sha differs from the live remote sha), the push is REFUSED unless --force,
    so an agent edit on the box is never silently clobbered (D8).
    """
    from connectors import hermes as _hermes
    from connectors import sidecar as _sidecar
    from connectors.transport import audit as _audit

    registry, target, connector, doc = _resolve_remote_for_doc(args)
    health = connector.health_check(target)
    if not health.ok:
        fail(f"Remote '{args.id}' not reachable/ready: {health.detail}")

    # Content arrives on stdin (never argv — keeps large/sensitive bodies out of
    # the process table and logs).
    content = sys.stdin.buffer.read()

    transport = connector._transport(target)
    home = connector._resolve_home(target, transport)
    paths = _hermes._Paths(home)
    ref = paths.doc_path(doc)

    remote_sha = transport.sha256(ref)
    sc = _sidecar.read_sidecar(args.id, _hermes.SURFACE_DOCS)
    base_sha = sc.base_sha(doc)
    force = getattr(args, "force", False)

    # Drift guard: the remote doc changed under us since we last touched it.
    if (
        not force
        and remote_sha is not None
        and base_sha is not None
        and remote_sha != base_sha
    ):
        fail(
            f"Refusing to push {doc}: the remote copy has drifted since the hub "
            f"last fetched it (base {base_sha[:12]}… ≠ remote {remote_sha[:12]}…). "
            f"Re-fetch and re-apply your edit, or pass --force to overwrite."
        )

    new_sha = hashlib.sha256(content).hexdigest()
    if remote_sha == new_sha:
        print(f"  {c('·', DIM)} {doc} already up to date — no write")
        # Still re-base the sidecar so future drift checks have a base.
        sc.record(doc, "agent_doc", new_sha)
        _sidecar.write_sidecar(sc)
        return

    # Atomic + backup-on-change via the transport.
    connector._guard_write_path(paths, ref)
    transport.backup_on_change(ref, content)
    transport.atomic_write(ref, content)
    _audit.append(args.id, "write", f"doc:{doc}", sha_before=remote_sha, sha_after=new_sha)

    # Re-base the sidecar to the just-pushed content (this is now the base).
    sc.record(doc, "agent_doc", new_sha)
    _sidecar.write_sidecar(sc)

    forced = " (forced over drift)" if force and base_sha and remote_sha != base_sha else ""
    print(f"  {c('✓', GREEN)} pushed {doc} to '{args.id}'{forced} ({len(content)} bytes)")


def cmd_remote_health(args):
    """Report a remote's connection health (reachable/auth/host-key-match).

    Thin wrapper over the connector's `health_check` — the dedicated subcommand
    the Tauri layer marshals (previously it had to reuse `remote diff`).
    """
    from connectors import get_connector

    registry = _read_registry_optional()
    target = _require_remote(registry, args.id)
    try:
        connector = get_connector(target.connector)
    except KeyError as e:
        fail(str(e))
    health = connector.health_check(target)
    payload = {
        "remote": args.id,
        "reachable": health.reachable,
        "authenticated": health.authenticated,
        "host_key_match": health.host_key_match,
        "ok": health.ok,
        "detail": health.detail,
    }
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return
    icon, colour = (("✓", GREEN) if health.ok else ("✗", RED if health.reachable else YELLOW))
    print(f"  {c(icon, colour)} {args.id}  "
          f"reachable={health.reachable} auth={health.authenticated} "
          f"host_key={health.host_key_match}")
    if health.detail:
        print(f"  {c('·', DIM)} {health.detail}")


def cmd_remote_doctor(args):
    """Detect remote-connector risks across every registered remote (task 3.2).

    Checks (per remote):
      * host-key pin mismatch — live fingerprint ≠ pinned `host_key_sha256` (DANGER)
      * unreachable `sync_enabled` remote (warning — sync silently skips it)
      * stale/orphaned sidecar entries — managed names no longer desired AND gone
        from the box (orphan ownership rot; warning)
      * never-clobber sanity — any artifact currently in `remote-drifted`/`conflict`
        that would be silently skipped (warning, so the user knows to resolve it)

    Danger findings exit non-zero (matching `permissions doctor`).
    """
    from connectors import get_connector, Action, DriftStatus
    from connectors import sidecar as _sidecar
    from connectors.transport.ssh import HostKeyMismatch
    from remotes import load_remotes

    registry = _read_registry_optional()
    remotes = load_remotes(registry)

    findings: list[dict] = []

    def add(remote_id, code, severity, detail):
        findings.append({"remote": remote_id, "code": code,
                         "severity": severity, "detail": detail})

    # C1 signing check (SHOULD, light): a remote with hub-managed skills but no
    # pinned signing pubkey ships executable content that no verifier can attest.
    signing_pinned = bool(pinned_signing_pubkey(registry))

    for rid, target in remotes.items():
        try:
            connector = get_connector(target.connector)
        except KeyError as e:
            add(rid, "unknown-connector", "danger", str(e))
            continue

        if not signing_pinned:
            from connectors import sidecar as _sc_signing
            if _sc_signing.read_sidecar(rid, "skills").managed_names():
                add(rid, "signing-unpinned", "warning",
                    "remote has hub-managed skills but no signing pubkey is pinned "
                    "(run `hub remote signing-key --init`) — pushed skills cannot be "
                    "integrity-verified by a remote verifier")

        # --- host-key pin verification (DANGER on mismatch) ---
        pinned = target.host_key_sha256
        transport = connector._transport(target)
        if not pinned:
            add(rid, "host-key-unpinned", "warning",
                "no host_key_sha256 pin set (TOFU not completed)")
        else:
            try:
                live = transport.fetch_host_key_fingerprint()
            except Exception as e:
                live = None
                add(rid, "host-key-unreadable", "warning",
                    f"could not read live host key to verify the pin: {e}")
            if live is not None and live != pinned:
                add(rid, "host-key-mismatch", "danger",
                    f"live host key {live} != pinned {pinned} — possible MITM; "
                    f"sync will hard-fail")

        # --- reachability for sync_enabled remotes ---
        try:
            health = connector.health_check(target)
        except Exception as e:
            health = None
            add(rid, "health-error", "warning", f"health check errored: {e}")
        if health is not None:
            # NOTE: a mismatch is detected authoritatively above via the live
            # fingerprint comparison. `health.host_key_match` is ALSO False when
            # the box is merely unreachable (the pin can't be checked), so it is
            # NOT used here to avoid a false DANGER on a down box.
            if target.sync_enabled and not health.reachable:
                add(rid, "unreachable", "warning",
                    f"sync_enabled but unreachable: {health.detail}")

        # --- sidecar rot + never-clobber: only when reachable + ready ---
        if health is None or not health.ok:
            continue
        remote_cfg = (registry.get("remotes") or {}).get(rid) or {}
        try:
            desired = build_remote_desired_state(remote_cfg, registry)
            plan = connector.plan(target, desired)
        except Exception as e:
            add(rid, "plan-error", "warning", f"could not compute plan: {e}")
            continue

        drifted = [a.name for a in plan.actions
                   if a.action in (Action.SKIP_REMOTE_DRIFTED, Action.SKIP_CONFLICT)]
        if drifted:
            add(rid, "unresolved-drift", "warning",
                f"{len(drifted)} artifact(s) drifted/conflicting and silently "
                f"skipped by sync: {', '.join(sorted(drifted))} — resolve with "
                f"`hub remote resolve {rid} --artifact <name> --op …`")

        # Stale/orphaned sidecar entries: managed names that are gone both from
        # the desired set AND the box (ownership rot — nothing left to clean).
        desired_names = {(d.kind, d.name) for d in desired.items()}
        for surface in ("skills", "mcp", "docs"):
            sc = _sidecar.read_sidecar(rid, surface)
            for a in sc.artifacts:
                kind = {"skills": "skill", "mcp": "mcp", "docs": "agent_doc"}[surface]
                if (kind, a.name) in desired_names:
                    continue
                # Not desired — is it still on the box? If a corresponding REMOVE
                # or NOOP action wasn't emitted as ORPHANED, the entry is stale.
                planned = next((p for p in plan.actions
                                if p.kind == kind and p.name == a.name), None)
                if planned is None:
                    add(rid, "stale-sidecar", "warning",
                        f"{surface} sidecar lists '{a.name}' but it is neither "
                        f"desired nor present on the box (stale ownership entry)")

    danger = sum(1 for f in findings if f["severity"] == "danger")
    if getattr(args, "json", False):
        print(json.dumps({"findings": findings, "danger_count": danger}, indent=2))
    else:
        print(f"\n{c('Remote doctor', BOLD, CYAN)}\n")
        if not findings:
            print(f"  {c('✓', GREEN)} no remote risks detected")
        for f in findings:
            colour = RED if f["severity"] == "danger" else YELLOW
            icon = "✗" if f["severity"] == "danger" else "!"
            print(f"  {c(icon, colour)} {f['remote']}  "
                  f"{f['code']} ({f['severity']}): {f['detail']}")
        print()
    if danger > 0:
        sys.exit(2)


def cmd_project_agent_docs(args):
    """Show a project's Agent Docs preferences (read-only)."""
    registry = load_registry()
    projects = registry.get("projects") or {}
    name = args.name
    if name not in projects:
        fail(f"Unknown project '{name}'.")

    import agent_docs

    prefs = dict(projects[name].get("agent_docs") or {})
    # The legacy suggest_companion_links preference is no longer honored; drop
    # it from the display (a residual key in the registry is tolerated).
    prefs.pop("suggest_companion_links", None)
    prefs["effective_strategy"] = agent_docs.resolve_strategy(projects[name], registry)
    print(json.dumps(prefs, indent=2, sort_keys=True))


def cmd_agent_docs_strategy(args):
    """Get or set the canonical root-derivation strategy (global or per-project)."""
    import agent_docs

    registry = load_registry()
    proj_name = getattr(args, "project", None)
    set_value = getattr(args, "set_value", None)
    clear = getattr(args, "clear", False)
    use_json = getattr(args, "json", False)

    if clear and not proj_name:
        fail("--clear requires --project")
    if set_value and clear:
        fail("--set and --clear are mutually exclusive")
    if proj_name and proj_name not in (registry.get("projects") or {}):
        fail(f"Unknown project '{proj_name}'.")

    if set_value or clear:
        with data_home_lock():
            registry = load_registry()
            if proj_name:
                proj_cfg = registry["projects"][proj_name]
                ad = proj_cfg.setdefault("agent_docs", {})
                if clear:
                    ad.pop("root_strategy", None)
                    if not ad:
                        proj_cfg.pop("agent_docs", None)
                else:
                    ad["root_strategy"] = set_value
            else:
                registry.setdefault("agent_docs", {})["root_strategy"] = set_value
            save_registry(registry)
        registry = load_registry()

    glob = (registry.get("agent_docs") or {}).get(
        "root_strategy"
    ) or agent_docs.DEFAULT_STRATEGY
    if proj_name:
        proj = registry["projects"][proj_name]
        override = (proj.get("agent_docs") or {}).get("root_strategy")
        effective = agent_docs.resolve_strategy(proj, registry)
        if use_json:
            print(
                json.dumps(
                    {
                        "project": proj_name,
                        "override": override,
                        "global": glob,
                        "effective": effective,
                    },
                    indent=2,
                )
            )
        else:
            print(
                f"{proj_name}: effective={c(effective, BOLD)} "
                f"(override={override or '—'}, global={glob})"
            )
    else:
        if use_json:
            print(json.dumps({"global": glob}, indent=2))
        else:
            print(f"global agent-docs root_strategy: {c(glob, BOLD)}")


def _resolve_project_target(registry, proj_name, path):
    """Resolve a `--project name` / `--path /abs/path` arg pair to a project name.

    Returns ``None`` when neither is supplied (caller defaults to all projects).
    """
    projects = registry.get("projects") or {}
    if proj_name:
        if proj_name not in projects:
            fail(f"Unknown project '{proj_name}'.")
        return proj_name
    if path:
        try:
            target = Path(path).expanduser().resolve()
        except (OSError, RuntimeError):
            fail(f"Invalid --path: {path}")
        for name, cfg in projects.items():
            try:
                if Path(cfg.get("path", "")).expanduser().resolve() == target:
                    return name
            except (OSError, RuntimeError):
                continue
        fail(f"No registered project matches --path {path}")
    return None


def cmd_agent_docs_status(args):
    """Emit canonical-root status for one or all projects (read-only)."""
    import agent_docs
    import harnesses as _harnesses

    registry = load_registry()
    projects = registry.get("projects") or {}
    proj_name = _resolve_project_target(
        registry, getattr(args, "project", None), getattr(args, "path", None)
    )
    use_json = getattr(args, "json", False)
    targets = [proj_name] if proj_name else list(projects.keys())
    installed = _harnesses.detect_installed()

    results = []
    for name in targets:
        status = agent_docs.detect_status(
            projects[name], registry, installed=installed
        )
        results.append({"project": name, **status})

    if use_json:
        # Single-project callers (Tauri) want a bare object; multi-project want a list.
        payload = results[0] if proj_name else results
        print(json.dumps(payload, indent=2))
        return
    for r in results:
        print(
            f"{r['project']}: {r['state']} "
            f"(canonical={r['canonical']}, derived={r['derived']}, strategy={r['strategy']})"
        )


def cmd_agent_docs_fix(args):
    """Transactional canonical-layout fix (dry-run unless --apply).

    One plan per project: root promotion/derivation/collapse, opt-in nested
    promotions (--nested), legacy AGENT.md cleanup. Apply re-verifies every
    step's precondition fingerprint and aborts whole on any mismatch.
    `hub agent-docs migrate` routes here as an alias.
    """
    import agent_docs
    import harnesses as _harnesses

    registry = load_registry()
    projects = registry.get("projects") or {}
    proj_name = _resolve_project_target(
        registry, getattr(args, "project", None), getattr(args, "path", None)
    )
    do_apply = getattr(args, "apply", False)
    use_json = getattr(args, "json", False)
    nested = getattr(args, "nested", None) or "none"
    rename_legacy = getattr(args, "rename_legacy", False)
    do_commit = getattr(args, "commit", False)
    plan_stdin = getattr(args, "plan_stdin", False)

    targets = [proj_name] if proj_name else list(projects.keys())
    installed = _harnesses.detect_installed()
    backups_root = data_home() / "_hub-backups"
    state_root = data_home() / "state"

    def select_nested(plan: dict):
        for step in plan["steps"]:
            if not step.get("optional"):
                continue
            # Rename of a user-authored AGENT.md is its own decision, gated on
            # --rename-legacy; --nested only governs nested promotions.
            if step["action"] == "rename_legacy_file":
                step["selected"] = rename_legacy
                continue
            if nested == "all":
                step["selected"] = True
            elif nested != "none":
                step["selected"] = step["dir"] in {
                    d.strip() for d in nested.split(",") if d.strip()
                }

    def maybe_commit(name: str, res: dict) -> dict:
        # Opt-in, after a successful apply. Commit failure is a warning —
        # the filesystem changes stay applied.
        if not do_commit or not res.get("applied") or not res.get("executed"):
            return res
        from pathlib import Path as _P

        root = _P(projects[name]["path"]).expanduser()
        msg = agent_docs.build_commit_message(res["executed"])
        res["commit"] = agent_docs.commit_layout_change(
            root, res.get("touched", []), msg
        )
        return res

    results = []
    if do_apply:
        if plan_stdin:
            if not proj_name:
                fail("--plan-stdin requires --project or --path")
            try:
                plan = json.loads(sys.stdin.read())
            except ValueError as e:
                fail(f"--plan-stdin: invalid JSON ({e})")
            with data_home_lock():
                res = agent_docs.apply_fix(
                    projects[proj_name],
                    registry,
                    proj_name,
                    backups_root,
                    plan,
                    installed=installed,
                )
            results.append({"project": proj_name, **maybe_commit(proj_name, res)})
        else:
            with data_home_lock():
                for name in targets:
                    plan = agent_docs.plan_fix(
                        projects[name], registry, installed=installed, state_root=state_root
                    )
                    select_nested(plan)
                    res = agent_docs.apply_fix(
                        projects[name], registry, name, backups_root, plan, installed=installed
                    )
                    results.append({"project": name, **maybe_commit(name, res)})
    else:
        for name in targets:
            plan = agent_docs.plan_fix(
                projects[name], registry, installed=installed, state_root=state_root
            )
            select_nested(plan)
            results.append({"project": name, **plan})

    if use_json:
        # Machine consumers (the Tauri bridge) read `applied`/`error` from the
        # payload; exit 0 so a disk_changed abort still parses as JSON.
        payload = results[0] if proj_name else results
        print(json.dumps(payload, indent=2))
        return

    mode = "applied" if do_apply else "dry-run"
    print(f"\n{c('Agent docs fix', BOLD, CYAN)} ({mode})\n")
    for r in results:
        name = r["project"]
        if do_apply:
            if not r.get("applied"):
                print(
                    f"  {c('!', RED)} {name}: disk changed since preview — nothing executed; re-run to re-plan"
                )
                continue
            if not r.get("executed"):
                print(f"  {c('·', DIM)} {name}: already canonical, nothing to do")
            for ex in r.get("executed", []):
                where = ex["dir"] or "root"
                print(f"  {c('•', GREEN)} {name}: {ex['action']} ({where})")
            for b in r.get("backups", []):
                print(f"      {c('backup', GREEN)} {b}")
            commit = r.get("commit")
            if commit:
                if commit.get("committed"):
                    print(f"      {c('commit', GREEN)} {commit.get('sha')}")
                else:
                    print(
                        f"      {c('commit skipped', YELLOW)} {commit.get('reason')}"
                    )
        else:
            steps = r.get("steps", [])
            if not steps and not r.get("attention") and not r.get("flagged"):
                print(f"  {c('·', DIM)} {name}: already canonical")
            for s in steps:
                marker = (
                    c("•", YELLOW)
                    if s["selected"]
                    else c("◦", DIM)
                )
                opt_flag = (
                    "--rename-legacy"
                    if s["action"] == "rename_legacy_file"
                    else "--nested"
                )
                opt = "" if not s["optional"] else (
                    " (opt-in, selected)"
                    if s["selected"]
                    else f" (opt-in — pass {opt_flag})"
                )
                print(f"  {marker} {name}: {s['details']}{opt}")
        for a in r.get("attention", []):
            print(f"  {c('!', RED)} {name}: {a['details']}")
        for f in r.get("flagged", []):
            print(f"  {c('!', YELLOW)} {name}: {f['path']} — {f['reason']}")
    if not do_apply and any(r.get("steps") for r in results):
        print(f"\n  Re-run with {c('--apply', BOLD)} to perform the selected steps.")


def cmd_agent_docs_resolve(args):
    """Explicit conflict/appendix resolution for a root pair (never merges)."""
    import agent_docs
    import harnesses as _harnesses

    registry = load_registry()
    projects = registry.get("projects") or {}
    proj_name = _resolve_project_target(
        registry, getattr(args, "project", None), getattr(args, "path", None)
    )
    if not proj_name:
        fail("resolve requires --project or --path")
    op = getattr(args, "op", None)
    if op not in agent_docs.RESOLVE_OPS:
        fail(f"--op must be one of: {', '.join(agent_docs.RESOLVE_OPS)}")
    rel_dir = getattr(args, "dir", "") or ""
    installed = _harnesses.detect_installed()
    backups_root = data_home() / "_hub-backups"

    with data_home_lock():
        res = agent_docs.resolve_root(
            projects[proj_name],
            registry,
            proj_name,
            backups_root,
            rel_dir=rel_dir,
            op=op,
            installed=installed,
        )

    if getattr(args, "commit", False) and res.get("applied"):
        from pathlib import Path as _P

        root = _P(projects[proj_name]["path"]).expanduser()
        msg = agent_docs.build_commit_message([], op=op)
        res["commit"] = agent_docs.commit_layout_change(
            root, res.get("touched", []), msg
        )

    if getattr(args, "json", False):
        print(json.dumps({"project": proj_name, **res}, indent=2))
        return
    if res.get("applied"):
        print(f"{c('✓', GREEN)} {proj_name}: {op} applied ({rel_dir or 'root'})")
        for b in res.get("backups", []):
            print(f"    {c('backup', GREEN)} {b}")
        commit = res.get("commit")
        if commit:
            if commit.get("committed"):
                print(f"    {c('commit', GREEN)} {commit.get('sha')}")
            else:
                print(f"    {c('commit skipped', YELLOW)} {commit.get('reason')}")
    else:
        fail(f"{proj_name}: {res.get('error', 'resolution failed')}")


# ─────────────────────────────────────────────────────────────────────────────
# Snippets — reusable agent-doc instruction blocks (see snippets.py)
# ─────────────────────────────────────────────────────────────────────────────


def _snippet_ctx():
    import snippets as _snippets

    registry = load_registry()
    sdir = _snippets.snippets_dir(data_home())
    return _snippets, registry, sdir


def _snippet_read_body(args) -> Optional[str]:
    body = getattr(args, "body", None)
    body_file = getattr(args, "body_file", None)
    if body is not None and body_file:
        fail("--body and --body-file are mutually exclusive")
    if body_file:
        p = Path(body_file).expanduser()
        if not p.is_file():
            fail(f"--body-file not found: {body_file}")
        return p.read_text(encoding="utf-8")
    if body == "-":
        return sys.stdin.read()
    return body


def _snippet_installed():
    import harnesses as _harnesses

    return _harnesses.detect_installed()


def cmd_snippet_list(args):
    """List snippets with scan-derived usage roll-ups."""
    _snippets, registry, sdir = _snippet_ctx()
    items = _snippets.list_snippets(
        sdir, tag=getattr(args, "tag", None), query=getattr(args, "query", None)
    )
    library = _snippets.library_by_name(sdir)
    rows = []
    for s in items:
        usage = _snippets.snippet_usage(registry, library, s.name)
        usage.pop("locations", None)
        rows.append({**s.to_dict(with_body=False), "usage": usage})
    if getattr(args, "json", False):
        print(json.dumps(rows, indent=2))
        return
    if not rows:
        print("No snippets. Create one with `hub snippet new <name>`.")
        return
    for r in rows:
        u = r["usage"]
        pip = "unused" if u["count"] == 0 else f"applied to {u['count']} ({u['summary']})"
        tags = " ".join(f"#{t}" for t in r["tags"])
        print(f"  {c(r['name'], BOLD)} v{r['version']} — {pip} {c(tags, DIM)}")
        if r["description"]:
            print(f"      {c(r['description'], DIM)}")


def cmd_snippet_show(args):
    """Show one snippet incl. body and scan-derived applied locations."""
    _snippets, registry, sdir = _snippet_ctx()
    s = _snippets.get_snippet(sdir, args.name)
    if s is None:
        fail(f'No snippet named "{args.name}".')
    library = _snippets.library_by_name(sdir)
    usage = _snippets.snippet_usage(registry, library, s.name)
    payload = {**s.to_dict(), "usage": usage}
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return
    print(f"{c(s.name, BOLD)} v{s.version}  {' '.join('#' + t for t in s.tags)}")
    if s.description:
        print(f"  {s.description}")
    for loc in usage["locations"]:
        print(f"  {loc['project']}/{loc['rel']}: {loc['status']}")
    print()
    print(s.body)


def cmd_snippet_new(args):
    """Create a snippet in <data_home>/snippets/."""
    import snippets as _snippets

    body = _snippet_read_body(args) or ""
    tags = [t for t in (getattr(args, "tags", None) or "").split(",") if t.strip()]
    with data_home_lock():
        sdir = _snippets.snippets_dir(data_home())
        try:
            s = _snippets.create_snippet(
                sdir,
                args.name,
                description=getattr(args, "description", None) or "",
                tags=tags,
                body=body,
            )
        except _snippets.SnippetError as exc:
            fail(str(exc))
    if getattr(args, "json", False):
        print(json.dumps(s.to_dict(), indent=2))
    else:
        print(f"Created snippet {c(s.name, BOLD)} (v1)")


def cmd_snippet_edit(args):
    """Patch description/tags/body. Body changes bump the version."""
    _snippets, registry, sdir = _snippet_ctx()
    body = _snippet_read_body(args)
    tags_arg = getattr(args, "tags", None)
    tags = (
        [t for t in tags_arg.split(",") if t.strip()] if tags_arg is not None else None
    )
    with data_home_lock():
        try:
            s, body_changed = _snippets.edit_snippet(
                sdir,
                args.name,
                description=getattr(args, "description", None),
                tags=tags,
                body=body,
            )
        except _snippets.SnippetError as exc:
            fail(str(exc))
    outdated = 0
    if body_changed:
        library = _snippets.library_by_name(sdir)
        outdated = sum(
            1
            for loc in _snippets.applied_locations(registry, library, s.name)
            if loc["status"] == "outdated"
        )
    payload = {**s.to_dict(), "body_changed": body_changed, "outdated_locations": outdated}
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return
    print(f"Saved {c(s.name, BOLD)} (v{s.version})")
    if body_changed and outdated:
        print(
            f"  {c('!', YELLOW)} {outdated} applied location(s) are now outdated — "
            f"run `hub snippet update {s.name} --all` to propagate."
        )


def cmd_snippet_delete(args):
    """Delete a snippet definition. Scan-guarded; --force leaves blocks orphaned."""
    _snippets, registry, sdir = _snippet_ctx()
    library = _snippets.library_by_name(sdir)
    if args.name not in library:
        fail(f'No snippet named "{args.name}".')
    locs = _snippets.applied_locations(registry, library, args.name)
    if locs and not getattr(args, "force", False):
        files = ", ".join(f"{l['project']}/{l['rel']}" for l in locs)
        fail(
            f'"{args.name}" is applied to {len(locs)} file(s): {files}\n'
            f"Remove it there first, or re-run with --force to delete the definition "
            f"only (the in-file blocks remain and become orphaned)."
        )
    with data_home_lock():
        try:
            _snippets.delete_snippet(sdir, args.name)
        except _snippets.SnippetError as exc:
            fail(str(exc))
    payload = {
        "deleted": args.name,
        "orphaned_blocks": [
            {"project": l["project"], "rel": l["rel"]} for l in locs
        ],
    }
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return
    print(f"Deleted snippet {c(args.name, BOLD)}")
    if locs:
        print(
            f"  {c('!', YELLOW)} {len(locs)} in-file block(s) remain — now orphaned "
            f"(remove via `hub snippet remove` or by hand)."
        )


def cmd_snippet_apply(args):
    """Append a snippet block to a project agent doc file."""
    _snippets, registry, sdir = _snippet_ctx()
    library = _snippets.library_by_name(sdir)
    backups_root = data_home() / "_hub-backups"
    with data_home_lock():
        try:
            res = _snippets.apply_snippet(
                registry,
                library,
                backups_root,
                args.name,
                args.project,
                rel=getattr(args, "file", None),
                installed=_snippet_installed(),
            )
        except _snippets.SnippetError as exc:
            fail(str(exc))
    if getattr(args, "json", False):
        print(json.dumps(res, indent=2))
        return
    where = f"{res['project']}/{res['rel']}"
    extra = " (file created)" if res["created"] else ""
    if res["mirrored"]:
        extra += " (mirrored to " + ", ".join(m["rel"] for m in res["mirrored"]) + ")"
    print(f"Applied {c(args.name, BOLD)} → {where}{extra}")


def cmd_snippet_remove(args):
    """Excise a snippet block from a project agent doc file."""
    _snippets, registry, sdir = _snippet_ctx()
    library = _snippets.library_by_name(sdir)
    backups_root = data_home() / "_hub-backups"
    with data_home_lock():
        try:
            res = _snippets.remove_snippet(
                registry,
                library,
                backups_root,
                args.name,
                args.project,
                rel=getattr(args, "file", None),
                force=getattr(args, "force", False),
                installed=_snippet_installed(),
            )
        except _snippets.SnippetError as exc:
            fail(str(exc))
    if getattr(args, "json", False):
        print(json.dumps(res, indent=2))
        return
    print(f"Removed {c(args.name, BOLD)} from {res['project']}/{res['rel']}")


def cmd_snippet_update(args):
    """Refresh applied block(s) to the current library body."""
    _snippets, registry, sdir = _snippet_ctx()
    library = _snippets.library_by_name(sdir)
    backups_root = data_home() / "_hub-backups"
    use_all = getattr(args, "all", False)
    project = getattr(args, "project", None)
    if use_all and project:
        fail("--all and --project are mutually exclusive")
    if not use_all and not project:
        fail("Specify --project <name> (with optional --file) or --all")
    with data_home_lock():
        try:
            if use_all:
                res = _snippets.update_everywhere(
                    registry,
                    library,
                    backups_root,
                    args.name,
                    installed=_snippet_installed(),
                )
            else:
                res = _snippets.update_snippet_in_file(
                    registry,
                    library,
                    backups_root,
                    args.name,
                    project,
                    rel=getattr(args, "file", None),
                    force=getattr(args, "force", False),
                    installed=_snippet_installed(),
                )
        except _snippets.SnippetError as exc:
            fail(str(exc))
    if getattr(args, "json", False):
        print(json.dumps(res, indent=2))
        return
    if use_all:
        print(
            f"Updated {c(args.name, BOLD)} in {len(res['refreshed'])} location(s)"
        )
        for s in res["skipped"]:
            print(
                f"  {c('!', YELLOW)} skipped {s['project']}/{s['rel']} — modified "
                f"in-file; update it by hand or with --force per file"
            )
    else:
        print(f"Updated {c(args.name, BOLD)} in {res['project']}/{res['rel']}")


def cmd_snippet_status(args):
    """Scan registered projects for snippet blocks; pure read of file content."""
    _snippets, registry, sdir = _snippet_ctx()
    library = _snippets.library_by_name(sdir)
    proj_filter = getattr(args, "project", None)
    name_filter = getattr(args, "name", None)
    projects = registry.get("projects") or {}
    if proj_filter:
        if proj_filter not in projects:
            fail(f"Unknown project '{proj_filter}'.")
        result = _snippets.scan_project(proj_filter, projects[proj_filter], library)
    else:
        result = _snippets.scan_all(registry, library)
    if name_filter:
        result["locations"] = [
            l for l in result["locations"] if l["snippet"] == name_filter
        ]
    if getattr(args, "json", False):
        print(json.dumps(result, indent=2))
        return
    if not result["locations"] and not result["damaged"]:
        print("No snippet blocks found.")
        return
    for loc in result["locations"]:
        print(
            f"  {loc['project']}/{loc['rel']}: {c(loc['snippet'], BOLD)} "
            f"v{loc['version']} — {loc['status']}"
        )
    for d in result["damaged"]:
        print(
            f"  {c('!', RED)} {d['project']}/{d['rel']}:{d['line']} — "
            f"{d['kind']} marker for '{d['name']}' (clean up by hand in the editor)"
        )


def cmd_project_harnesses(args):
    """Show or mutate a project's per-project `harnesses` list."""
    import harnesses as _harnesses

    registry = load_registry()
    projects = registry.get("projects") or {}
    name = args.name
    if name not in projects:
        fail(f"Unknown project '{name}'.")
    proj_cfg = projects[name]

    add = getattr(args, "add", None)
    remove = getattr(args, "remove", None)

    if add is None and remove is None:
        # Show
        global_set = set(registry.get("harnesses_global") or [])
        project_set = set(proj_cfg.get("harnesses") or [])
        installed = _harnesses.detect_installed()
        effective = _harnesses.resolve_effective(
            proj_cfg, registry, installed=installed
        )
        print(f"\n{c(f'Project: {name}', BOLD)}")
        print(f"  global    : {sorted(global_set) or '(none)'}")
        print(f"  project   : {sorted(project_set) or '(none)'}")
        print(f"  effective : {sorted(effective) or '(none)'}")
        print()
        return

    with data_home_lock():
        registry = load_registry()
        proj_cfg = registry["projects"][name]
        current = list(proj_cfg.get("harnesses") or [])
        if add:
            for h_id in [v.strip() for v in add.split(",") if v.strip()]:
                if h_id not in _harnesses.HARNESSES:
                    print(
                        f"  {c('!', YELLOW)} unknown harness id '{h_id}' — adding anyway "
                        f"(forward-compat)",
                        file=sys.stderr,
                    )
                if h_id not in current:
                    current.append(h_id)
        if remove:
            for h_id in [v.strip() for v in remove.split(",") if v.strip()]:
                current = [v for v in current if v != h_id]
        proj_cfg["harnesses"] = current
        save_registry(registry)
        print(f"{c('✓', GREEN)} project '{name}' harnesses: {current}")


def cmd_project_invocation(args):
    """Show or mutate a project's per-skill invocation overrides.

    No flags → table of active claude-skills (library mode / override /
    effective) plus any inert overrides. `--skill S --mode M` sets an override
    (`inherit` clears it). Overrides are gated to project-synced scopes —
    a `scope: global` skill lives at the user level, which Claude Code lets
    win over any project-level copy, so an override could never take effect.
    """
    registry = load_registry()
    projects = registry.get("projects") or {}
    name = args.name
    if name not in projects:
        fail(f"Unknown project '{name}'.")
    proj_cfg = projects[name]
    skills = registry.get("skills") or {}

    skill = getattr(args, "skill", None)
    mode = getattr(args, "mode", None)

    if skill is None and mode is None:
        overrides = proj_cfg.get("invocation_overrides") or {}
        active = [
            n
            for n in resolve_project_skills(proj_cfg, registry)
            if skills.get(n, {}).get("type") != "mcp-server" and n in skills
        ]
        rows = []
        for n in active:
            cfg = skills[n]
            library = skill_invocation(cfg)
            override = overrides.get(n)
            gated = cfg.get("scope", "portable") == "global" and override is not None
            effective_mode = override if (override and not gated) else library
            rows.append(
                {
                    "skill": n,
                    "scope": cfg.get("scope", "portable"),
                    "library": library,
                    "override": override,
                    "effective": effective_mode,
                    "inert": gated,
                }
            )
        stale = sorted(set(overrides) - set(active))
        if getattr(args, "json", False):
            print(
                json.dumps(
                    {"project": name, "skills": rows, "stale_overrides": stale},
                    indent=2,
                )
            )
            return
        print(f"\n{c(f'Project: {name}', BOLD)}")
        header = f"  {'SKILL':<28} {'SCOPE':<18} {'LIBRARY':<11} {'OVERRIDE':<11} EFFECTIVE"
        print(c(header, BOLD))
        for r in rows:
            note = c("  (inert: scope global)", YELLOW) if r["inert"] else ""
            print(
                f"  {r['skill']:<28} {r['scope']:<18} {r['library']:<11} "
                f"{r['override'] or '—':<11} {r['effective']}{note}"
            )
        for s in stale:
            print(
                f"  {c('!', YELLOW)} override '{overrides[s]}' for '{s}' is inert "
                f"(skill not active on this project)"
            )
        print()
        return

    if skill is None or mode is None:
        fail("--skill and --mode must be used together.")

    if skill not in skills:
        fail(f"Unknown skill '{skill}'.")
    cfg = skills[skill]

    with data_home_lock():
        registry = load_registry()
        proj_cfg = registry["projects"][name]
        overrides = proj_cfg.get("invocation_overrides") or {}

        if mode == "inherit":
            if skill not in overrides:
                print(f"No invocation override for '{skill}' on '{name}'.")
                return
            del overrides[skill]
            if overrides:
                proj_cfg["invocation_overrides"] = overrides
            else:
                proj_cfg.pop("invocation_overrides", None)
            save_registry(registry)
            print(f"{c('✓', GREEN)} '{skill}' on '{name}' inherits the library mode again")
        else:
            if mode not in VALID_INVOCATIONS:
                fail(
                    f"Invalid mode '{mode}'. Expected one of: "
                    f"{', '.join(VALID_INVOCATIONS)}, inherit."
                )
            if cfg.get("type") == "mcp-server":
                fail("Invocation overrides apply to claude-skills only.")
            if cfg.get("scope", "portable") == "global":
                fail(
                    f"'{skill}' has scope: global — it lives at the user level, and "
                    f"Claude Code gives user-level skills precedence over project-level "
                    f"copies, so a per-project override could never take effect. "
                    f"Change the skill's library default instead: "
                    f"hub set-meta {skill} --invocation {mode}"
                )
            active = resolve_project_skills(proj_cfg, registry)
            if skill not in active:
                print(
                    f"  {c('!', YELLOW)} '{skill}' is not active on '{name}' — the "
                    f"override is stored but inert until the skill is equipped",
                    file=sys.stderr,
                )
            if overrides.get(skill) == mode:
                print(f"'{skill}' on '{name}' is already overridden to {mode}.")
                return
            overrides[skill] = mode
            proj_cfg["invocation_overrides"] = overrides
            save_registry(registry)
            print(f"{c('✓', GREEN)} '{skill}' on '{name}': invocation override → {mode}")

    _auto_sync()


# ─────────────────────────────────────────────────────────────────────────────
# hub permissions ...
# ─────────────────────────────────────────────────────────────────────────────


def _perm_scope_from_args(args, registry: dict):
    """Resolve `--global` / `--project <n>` into a (scope, block_setter, label) tuple."""
    from permissions import GlobalScope, ProjectScope

    if getattr(args, "global_", False):
        return ("global", None, GlobalScope(), "global")
    proj_name = getattr(args, "project", None)
    if not proj_name:
        fail("specify --global or --project <name>")
    if proj_name not in registry.get("projects", {}):
        fail(f"unknown project: {proj_name}")
    proj_cfg = registry["projects"][proj_name]
    proj_path = expand(proj_cfg["path"])
    return (
        "project",
        proj_name,
        ProjectScope(name=proj_name, path=str(proj_path)),
        proj_name,
    )


def _perm_personal_flag(args, scope_kind: str) -> bool:
    """Resolve the `--personal` flag, rejecting it outside project scope.

    Personal (`permissions_local`) is a project-only tier — the global scope has no
    committed/personal split. Returns False when the flag is absent.
    """
    personal = bool(getattr(args, "personal", False))
    if personal and scope_kind != "project":
        fail("--personal requires --project <name> (global has no personal tier)")
    return personal


def _get_perm_block(
    registry: dict,
    scope_kind: str,
    proj_name: Optional[str],
    personal: bool = False,
) -> dict:
    if scope_kind == "global":
        block = registry.setdefault("permissions_global", {})
        return block
    key = "permissions_local" if personal else "permissions"
    return registry["projects"][proj_name].setdefault(key, {})


def _format_rules_json(perms) -> dict:
    return perms.to_dict()


def cmd_permissions_list(args):
    import risks as _risks
    from permissions import NormalizedPermissions, resolve_effective

    registry = load_registry()
    print(f"\n{c('Permissions overview', BOLD)}\n")
    g = registry.get("permissions_global") or {}
    g_counts = (
        len(g.get("allow") or []),
        len(g.get("deny") or []),
        len(g.get("ask") or []),
        len(g.get("hooks") or []),
    )
    g_risks = len(_risks.detect_risks(NormalizedPermissions.from_block(g), set()))
    unmanaged = ", ".join(g.get("_unmanaged") or []) or "-"
    print(
        f"  global   allow={g_counts[0]}  deny={g_counts[1]}  ask={g_counts[2]}  "
        f"hooks={g_counts[3]}  sandbox={g.get('sandbox_mode') or '-'}  "
        f"approval={g.get('approval_policy') or '-'}  risks={g_risks}  "
        f"unmanaged=[{unmanaged}]"
    )
    for proj_name, proj_cfg in (registry.get("projects") or {}).items():
        b = proj_cfg.get("permissions") or {}
        counts = (
            len(b.get("allow") or []),
            len(b.get("deny") or []),
            len(b.get("ask") or []),
            len(b.get("hooks") or []),
        )
        proj_risks = len(
            _risks.detect_risks(resolve_effective(proj_cfg, registry), set())
        )
        unmanaged = ", ".join(b.get("_unmanaged") or []) or "-"
        print(
            f"  {proj_name}  allow={counts[0]}  deny={counts[1]}  ask={counts[2]}  "
            f"hooks={counts[3]}  risks={proj_risks}  unmanaged=[{unmanaged}]"
        )
    print()


def cmd_permissions_show(args):
    import harnesses as _harnesses
    import permission_adapters as pa
    from permissions import (
        GlobalScope,
        NormalizedPermissions,
        ProjectScope,
        resolve_effective,
    )

    registry = load_registry()
    scope_kind, proj_name, _scope, label = _perm_scope_from_args(args, registry)
    effective_mode = bool(getattr(args, "effective", False))
    personal = _perm_personal_flag(args, scope_kind)
    if personal:
        label = f"{label} · personal"

    if scope_kind == "global":
        raw_block = registry.get("permissions_global") or {}
        duplicate_collapsed = _permissions_duplicate_count(raw_block)
        perms = NormalizedPermissions.from_block(raw_block)
        for r in perms.allow + perms.deny + perms.ask:
            r.origin = "global"
        for h in perms.hooks:
            h.origin = "global"
        scope_obj = GlobalScope()
    else:
        proj_cfg = registry["projects"][proj_name]
        if effective_mode:
            duplicate_collapsed = 0
            perms = resolve_effective(proj_cfg, registry)
        else:
            block_key = "permissions_local" if personal else "permissions"
            raw_block = proj_cfg.get(block_key) or {}
            duplicate_collapsed = _permissions_duplicate_count(raw_block)
            perms = NormalizedPermissions.from_block(raw_block)
            for r in perms.allow + perms.deny + perms.ask:
                r.origin = "project"
            for h in perms.hooks:
                h.origin = "project"
        scope_obj = ProjectScope(name=proj_name, path=str(expand(proj_cfg["path"])))

    # In --effective mode, gather skip reasons per (pattern, kind) and per (event, matcher, command)
    # by running each installed harness's adapter translate() against the resolved perms.
    skip_index: dict[tuple, list[tuple[str, str]]] = {}
    hook_skip_index: dict[tuple, list[tuple[str, str]]] = {}
    if effective_mode:
        installed = _harnesses.detect_installed()
        for h_id in sorted(installed):
            harness = _harnesses.HARNESSES.get(h_id)
            if harness is None or harness.permission_adapter_key is None:
                continue
            adapter = pa.get_adapter(harness.permission_adapter_key)
            if adapter is None:
                continue
            try:
                tr = adapter.translate(perms, scope_obj, h_id)
            except Exception:
                continue
            for sr in tr.skipped:
                if sr.rule_pattern is not None:
                    key = (sr.rule_pattern, _kind_for_feature(sr.feature))
                    skip_index.setdefault(key, []).append((h_id, sr.reason))
                elif sr.detail and "/" in (sr.detail or ""):
                    hook_skip_index.setdefault(sr.detail, []).append((h_id, sr.reason))

    if getattr(args, "json", False):
        payload = perms.to_dict()
        if duplicate_collapsed:
            payload["duplicate_collapsed"] = duplicate_collapsed
        if scope_kind == "global":
            # Populate adoption_required for unmanaged installed harnesses whose
            # discover_existing() finds rules. Per-project show --json never
            # populates this field — auto-import already runs on sync and is
            # surfaced via the inline banner.
            installed = _harnesses.detect_installed()
            managed_block = registry.get("permissions_global") or {}
            unmanaged_set = set(managed_block.get("_unmanaged") or [])
            block_has_rules = _has_any_managed_perms(managed_block)
            adoption: dict[str, list[dict]] = {}
            for h_id in sorted(installed):
                harness = _harnesses.HARNESSES.get(h_id)
                if harness is None or harness.permission_adapter_key is None:
                    continue
                # "Managed" = the block has rules AND this harness isn't on the
                # _unmanaged list. When the user explicitly marked the harness
                # _unmanaged, we still want to surface the discovery (per spec).
                managed = block_has_rules and h_id not in unmanaged_set
                if managed:
                    continue
                adapter = pa.get_adapter(harness.permission_adapter_key)
                if adapter is None or not hasattr(adapter, "discover_existing"):
                    continue
                try:
                    discovered = adapter.discover_existing(
                        scope_obj, h_id, project_path=None
                    )
                except Exception:
                    continue
                if not _discovered_has_anything(discovered):
                    continue
                entries: list[dict] = []
                source_file = None
                if hasattr(adapter, "target_files"):
                    try:
                        tf = adapter.target_files(scope_obj, h_id)
                        source_file = str(tf) if tf else None
                    except Exception:
                        source_file = None
                for kind, rules in (
                    ("allow", discovered.allow),
                    ("deny", discovered.deny),
                    ("ask", discovered.ask),
                ):
                    for r in rules:
                        entries.append(
                            {
                                "pattern": r.pattern,
                                "kind": kind,
                                "source_file": source_file,
                            }
                        )
                if entries:
                    adoption[h_id] = entries
            payload["adoption_required"] = adoption or None
        print(json.dumps(payload, indent=2))
        return

    print(f"\n{c(f'Permissions ({label})', BOLD)}")
    if effective_mode:
        print(f"{c('  origin  kind   pattern                  applies to', DIM)}")
    else:
        print(f"{c('  kind   pattern                  applies to', DIM)}")
    for kind, rules in (
        ("allow", perms.allow),
        ("deny", perms.deny),
        ("ask", perms.ask),
    ):
        for r in rules:
            applies = ", ".join(r.harnesses) if r.harnesses else "all"
            if effective_mode:
                print(f"  {r.origin:7s} {kind:6s} {r.pattern:24s} {applies}")
                for h_id, reason in skip_index.get((r.pattern, kind), []):
                    print(f"           {c(f'· skipped on {h_id}: {reason}', DIM)}")
            else:
                print(f"  {kind:6s} {r.pattern:24s} {applies}")
    for h in perms.hooks:
        applies = ", ".join(h.harnesses) if h.harnesses else "all"
        prefix = f"{(h.origin or '-'):7s} " if effective_mode else ""
        print(f"  {prefix}hook   {h.event}/{h.matcher}: {h.command}  {applies}")
        if effective_mode:
            for h_id, reason in hook_skip_index.get(f"{h.event}/{h.matcher}", []):
                print(f"           {c(f'· skipped on {h_id}: {reason}', DIM)}")
    if perms.sandbox_mode is not None:
        print(f"  sandbox_mode = {perms.sandbox_mode}")
    if perms.approval_policy is not None:
        print(f"  approval_policy = {perms.approval_policy}")
    if perms.project_trust is not None:
        print(f"  project_trust = {perms.project_trust}")
    if perms.additional_dirs:
        print(f"  additional_dirs = {perms.additional_dirs}")
    print()


def _kind_for_feature(feature: str) -> str:
    """Map a PermissionFeature value back to a rule kind for skip-index lookup."""
    return {
        "tool_allowlist": "allow",
        "tool_denylist": "deny",
        "tool_ask": "ask",
    }.get(feature, "")


def _validate_pattern_across_adapters(pattern: str, kind: str) -> tuple[bool, str]:
    """Return (ok, error). Validation passes if at least one installed adapter accepts it."""
    import permission_adapters as pa
    from permissions import Rule

    rule = Rule(pattern=pattern, kind=kind)
    any_ok = False
    last_err = ""
    for key, adapter in pa.ADAPTERS.items():
        if key == "codex":
            # Codex never accepts per-tool rules — skip in validation aggregate.
            continue
        res = adapter.validate(rule)
        if res.ok:
            any_ok = True
        else:
            last_err = res.error or "invalid"
    return any_ok, last_err


def cmd_permissions_add(args):
    registry = load_registry()
    scope_kind, proj_name, _scope, label = _perm_scope_from_args(args, registry)

    kind = args.kind
    pattern = args.pattern
    if kind not in {"allow", "deny", "ask"}:
        fail(f"--kind must be allow|deny|ask, got {kind!r}")
    ok, err = _validate_pattern_across_adapters(pattern, kind)
    if not ok:
        fail(f"pattern {pattern!r} rejected: {err}")

    personal = _perm_personal_flag(args, scope_kind)
    if personal:
        label = f"{label} · personal"
    block = _get_perm_block(registry, scope_kind, proj_name, personal=personal)
    bucket = list(block.get(kind) or [])
    harnesses = parse_csv(getattr(args, "harnesses", None))
    entry: dict = {"pattern": pattern, "kind": kind}
    if harnesses:
        entry["harnesses"] = harnesses
    # Dedup: (pattern, kind) already present?
    for existing in bucket:
        ex_pat = (
            existing.get("pattern") if isinstance(existing, dict) else str(existing)
        )
        if ex_pat == pattern:
            fail(f"rule already exists for {pattern!r} in {label}")
    bucket.append(entry)
    block[kind] = bucket
    save_registry(registry)
    print(f"{c('✓', GREEN)} added {kind} rule {pattern!r} to {label}")


def cmd_permissions_remove(args):
    registry = load_registry()
    scope_kind, proj_name, _scope, label = _perm_scope_from_args(args, registry)
    kind = args.kind
    pattern = args.pattern
    personal = _perm_personal_flag(args, scope_kind)
    if personal:
        label = f"{label} · personal"
    block = _get_perm_block(registry, scope_kind, proj_name, personal=personal)
    bucket = list(block.get(kind) or [])
    new_bucket = [
        r
        for r in bucket
        if (r.get("pattern") if isinstance(r, dict) else str(r)) != pattern
    ]
    if len(new_bucket) == len(bucket):
        fail(f"no {kind} rule with pattern {pattern!r} in {label}")
    block[kind] = new_bucket
    save_registry(registry)
    print(f"{c('✓', GREEN)} removed {kind} rule {pattern!r} from {label}")


def cmd_permissions_hooks_add(args):
    registry = load_registry()
    scope_kind, proj_name, _scope, label = _perm_scope_from_args(args, registry)
    event = args.event
    matcher = args.matcher
    command = args.command
    harnesses = parse_csv(getattr(args, "harnesses", None))
    personal = _perm_personal_flag(args, scope_kind)
    if personal:
        label = f"{label} · personal"
    block = _get_perm_block(registry, scope_kind, proj_name, personal=personal)
    hooks = list(block.get("hooks") or [])
    for h in hooks:
        if (
            isinstance(h, dict)
            and h.get("event") == event
            and h.get("matcher") == matcher
            and h.get("command") == command
        ):
            fail(f"hook already exists: ({event}, {matcher}, {command}) in {label}")
    entry: dict = {"event": event, "matcher": matcher, "command": command}
    if harnesses:
        entry["harnesses"] = harnesses
    hooks.append(entry)
    block["hooks"] = hooks
    save_registry(registry)
    print(f"{c('✓', GREEN)} added hook ({event}, {matcher}, {command}) to {label}")


def cmd_permissions_hooks_remove(args):
    registry = load_registry()
    scope_kind, proj_name, _scope, label = _perm_scope_from_args(args, registry)
    event = args.event
    matcher = args.matcher
    command = args.command
    personal = _perm_personal_flag(args, scope_kind)
    if personal:
        label = f"{label} · personal"
    block = _get_perm_block(registry, scope_kind, proj_name, personal=personal)
    hooks = list(block.get("hooks") or [])
    new_hooks = [
        h
        for h in hooks
        if not (
            isinstance(h, dict)
            and h.get("event") == event
            and h.get("matcher") == matcher
            and h.get("command") == command
        )
    ]
    if len(new_hooks) == len(hooks):
        fail(f"no matching hook in {label}")
    block["hooks"] = new_hooks
    save_registry(registry)
    print(f"{c('✓', GREEN)} removed hook from {label}")


def _latest_backup_for(harness_id: str, scope) -> Optional[Path]:
    import permission_adapters as pa

    backup_dir = pa._backups_root() / harness_id / scope.slug
    if not backup_dir.exists():
        return None
    backups = sorted(backup_dir.iterdir())
    return backups[-1] if backups else None


def cmd_permissions_adopt(args):
    import permission_adapters as pa
    import harnesses as _harnesses
    from permissions import GlobalScope, ProjectScope

    registry = load_registry()
    action = args.action
    if action not in {"import", "replace", "skip"}:
        fail(f"--action must be import|replace|skip, got {action!r}")
    json_out = bool(getattr(args, "json", False))

    if getattr(args, "global_", False):
        scope = GlobalScope()
        scope_kind = "global"
        proj_name = None
    else:
        proj_name = getattr(args, "project", None)
        if not proj_name:
            fail("specify --global or --project <name>")
        if proj_name not in registry.get("projects", {}):
            fail(f"unknown project: {proj_name}")
        proj_cfg = registry["projects"][proj_name]
        scope = ProjectScope(name=proj_name, path=str(expand(proj_cfg["path"])))
        scope_kind = "project"

    h_filter = getattr(args, "harness", None)
    installed = _harnesses.detect_installed()
    targets = sorted(installed if h_filter is None else {h_filter} & installed)
    if not targets:
        fail("no installed harnesses to adopt")

    def _emit_result(imported: int, backup_path: Optional[Path], text_msg: str):
        block_after = (
            registry.get("permissions_global") or {}
            if scope_kind == "global"
            else registry["projects"][proj_name].get("permissions") or {}
        )
        payload = {
            "scope_kind": scope_kind,
            "harness_id": h_filter,
            "action": action,
            "imported": imported,
            "backup_path": str(backup_path) if backup_path else None,
            "unmanaged_after": list(block_after.get("_unmanaged") or []),
        }
        if json_out:
            print(json.dumps(payload, indent=2))
        else:
            print(text_msg)

    block = _get_perm_block(registry, scope_kind, proj_name)
    if action == "skip":
        unmanaged = list(block.get("_unmanaged") or [])
        for h_id in targets:
            if h_id not in unmanaged:
                unmanaged.append(h_id)
        block["_unmanaged"] = unmanaged
        save_registry(registry)
        _emit_result(
            0,
            None,
            f"{c('✓', GREEN)} marked {targets} as unmanaged for {scope_kind}",
        )
        return

    discovered_union = []
    for h_id in targets:
        harness = _harnesses.HARNESSES.get(h_id)
        if harness is None or harness.permission_adapter_key is None:
            continue
        adapter = pa.get_adapter(harness.permission_adapter_key)
        if adapter is None:
            continue
        proj_path = Path(scope.path) if isinstance(scope, ProjectScope) else None
        discovered = adapter.discover_existing(scope, h_id, project_path=proj_path)
        if _discovered_has_anything(discovered):
            discovered_union.append((h_id, discovered))

    if not discovered_union:
        _emit_result(0, None, f"{c('·', DIM)} nothing to adopt")
        return

    if action == "replace":
        # Clear current block and replace with union of discovered
        keep_unmanaged = block.get("_unmanaged")
        block.clear()
        if keep_unmanaged:
            block["_unmanaged"] = keep_unmanaged

    imported_count = 0
    for h_id, discovered in discovered_union:
        new_block = _serialize_perms_block(discovered)
        for key in ("allow", "deny", "ask", "hooks"):
            if key in new_block:
                block.setdefault(key, [])
                block[key].extend(new_block[key])
                imported_count += len(new_block[key])
        for key in ("sandbox_mode", "approval_policy", "project_trust"):
            if key in new_block and block.get(key) is None:
                block[key] = new_block[key]
                imported_count += 1
        if "additional_dirs" in new_block:
            existing = list(block.get("additional_dirs") or [])
            for d in new_block["additional_dirs"]:
                if d not in existing:
                    existing.append(d)
                    imported_count += 1
            block["additional_dirs"] = existing

    # Clear unmanaged flag for these harnesses if present
    if block.get("_unmanaged"):
        block["_unmanaged"] = [h for h in block["_unmanaged"] if h not in targets]
        if not block["_unmanaged"]:
            del block["_unmanaged"]

    _dedupe_registry_permissions(registry)
    save_registry(registry)
    backup_for_emit = _latest_backup_for(h_filter, scope) if h_filter else None
    _emit_result(
        imported_count,
        backup_for_emit,
        f"{c('✓', GREEN)} adopted permissions from {targets} into {scope_kind}",
    )


def _codex_default_rules_for_scope(scope):
    import permission_adapters as pa
    return pa._codex_default_rules_target(scope)


def _add_rule_to_block(block: dict, pattern: str, kind: str, harnesses) -> bool:
    """Add a {pattern, kind[, harnesses]} rule into a registry permissions block,
    de-duplicating on (pattern, kind, harnesses). Returns True if added."""
    lst = block.setdefault(kind, [])
    norm_harn = sorted(harnesses) if harnesses else None
    for entry in lst:
        ep = entry.get("pattern") if isinstance(entry, dict) else entry
        eh = entry.get("harnesses") if isinstance(entry, dict) else None
        if ep == pattern and (sorted(eh) if eh else None) == norm_harn:
            return False
    rule: dict = {"pattern": pattern, "kind": kind}
    if norm_harn:
        rule["harnesses"] = norm_harn
    lst.append(rule)
    return True


def _drop_claude_rule(file_path: Path, pattern: str, kind: Optional[str]) -> bool:
    """Remove a user-authored rule pattern from a Claude-shape settings.json."""
    if not file_path.exists():
        return False
    try:
        data = json.loads(file_path.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    perms = data.get("permissions")
    if not isinstance(perms, dict):
        return False
    removed = False
    kinds = [kind] if kind else ["allow", "deny", "ask"]
    for k in kinds:
        lst = perms.get(k)
        if isinstance(lst, list) and pattern in lst:
            perms[k] = [p for p in lst if p != pattern]
            removed = True
    if removed:
        import permission_adapters as pa
        pa._atomic_replace(file_path, json.dumps(data, indent=2) + "\n")
    return removed


def cmd_permissions_import(args):
    """Discover + reconcile pre-existing native rules across harnesses, then
    import/keep/drop them with MOVE semantics (D10/D11/D12)."""
    import permission_adapters as pa
    import harnesses as _harnesses
    from permissions import GlobalScope, ProjectScope

    registry = load_registry()
    json_out = bool(getattr(args, "json", False))

    if getattr(args, "global_", False):
        scope = GlobalScope()
        scope_kind, proj_name = "global", None
    else:
        proj_name = getattr(args, "project", None)
        if not proj_name:
            fail("specify --global or --project <name>")
        if proj_name not in registry.get("projects", {}):
            fail(f"unknown project: {proj_name}")
        proj_cfg = registry["projects"][proj_name]
        scope = ProjectScope(name=proj_name, path=str(expand(proj_cfg["path"])))
        scope_kind = "project"

    installed = _harnesses.detect_installed()
    h_filter = getattr(args, "harness", None)
    targets = sorted(installed if h_filter is None else {h_filter} & installed)

    candidates = pa.gather_import_candidates(scope, targets)
    reconciled = pa.reconcile_candidates(candidates)

    apply_flag = bool(getattr(args, "apply", False))
    interactive = bool(getattr(args, "interactive", False))

    # ── Apply mode: consume a decisions payload from stdin ──
    if apply_flag:
        if not getattr(args, "decisions_stdin", False):
            fail("--apply requires --decisions-stdin")
        try:
            payload = json.loads(sys.stdin.read() or "{}")
        except json.JSONDecodeError as e:
            fail(f"invalid decisions JSON: {e}")
        decisions = payload.get("decisions") or []
        # `import` is a thin alias for `reconcile` (D3): same transactional +
        # auto-syncing apply path.
        summary = _reconcile_apply(
            registry, scope, scope_kind, proj_name, decisions, installed,
            conflict_patterns={cf["pattern"] for cf in reconciled["conflicts"]},
        )
        if json_out:
            print(json.dumps(summary, indent=2))
        else:
            print(
                f"{c('✓', GREEN)} import: {summary['imported']} imported, "
                f"{summary['dropped']} dropped, {summary['kept']} kept"
            )
        return

    # ── Discovery mode: emit (or interactively prompt) the reconciled set ──
    def _candidate_view(reconciled):
        return {
            "scope_kind": scope_kind,
            "project": proj_name,
            "merged": [
                {"pattern": m["pattern"], "kind": m["kind"],
                 "harnesses": m["harnesses"],
                 "sources": [{"harness": s["harness"], "source": s["source"]}
                             for s in m["sources"]]}
                for m in reconciled["merged"]
            ],
            "conflicts": [
                {"pattern": cf["pattern"], "options": cf["options"]}
                for cf in reconciled["conflicts"]
            ],
            "un_importable": [
                {"source": u.get("source"), "harness": u.get("harness"),
                 "reason": u.get("reason"), "file": u.get("file")}
                for u in reconciled["un_importable"]
            ],
        }

    if json_out:
        print(json.dumps(_candidate_view(reconciled), indent=2))
        return

    if interactive and sys.stdin.isatty():
        decisions = _prompt_import_decisions(reconciled)
        summary = _apply_import_decisions(
            registry, scope, scope_kind, proj_name, decisions
        )
        save_registry(registry)
        print(
            f"\n{c('✓', GREEN)} import: {summary['imported']} imported, "
            f"{summary['dropped']} dropped, {summary['kept']} kept"
        )
        return

    # Plain text summary (non-interactive)
    print(f"\n{c('Permissions import — ' + scope_kind, BOLD)}\n")
    if not (reconciled["merged"] or reconciled["conflicts"] or reconciled["un_importable"]):
        print(f"  {c('·', DIM)} nothing to import")
        return
    for m in reconciled["merged"]:
        srcs = ", ".join(sorted({s["harness"] for s in m["sources"]}))
        print(f"  {c('+', GREEN)} {m['kind']:<5} {m['pattern']}  [{srcs}]")
    for cf in reconciled["conflicts"]:
        opts = "; ".join(f"{k}={','.join(v)}" for k, v in cf["options"].items())
        print(f"  {c('!', YELLOW)} CONFLICT {cf['pattern']}  ({opts})")
    for u in reconciled["un_importable"]:
        print(
            f"  {c('×', DIM)} un-importable [{u.get('harness')}] "
            f"{u.get('reason')}"
        )
    print(f"\n  run with --interactive to choose, or --json for machine output")


def _prompt_import_decisions(reconciled: dict) -> list[dict]:
    decisions: list[dict] = []
    for m in reconciled["merged"]:
        ans = input(
            f"  {m['kind']} {m['pattern']} — [i]mport / [k]eep / [d]rop? "
        ).strip().lower()
        action = {"i": "import", "k": "keep", "d": "drop"}.get(ans, "keep")
        decisions.append({"pattern": m["pattern"], "kind": m["kind"], "action": action})
    for cf in reconciled["conflicts"]:
        kinds = list(cf["options"].keys())
        prompt = (
            f"  CONFLICT {cf['pattern']} — pick "
            + " / ".join(f"[{k}]" for k in kinds)
            + " / [b]oth (affinity) / [k]eep / [d]rop? "
        )
        ans = input(prompt).strip().lower()
        if ans == "b":
            for k, harns in cf["options"].items():
                decisions.append({
                    "pattern": cf["pattern"], "kind": k,
                    "harnesses": harns, "action": "import",
                })
        elif ans in {k[0] for k in kinds}:
            chosen = next(k for k in kinds if k[0] == ans)
            decisions.append({
                "pattern": cf["pattern"], "kind": chosen, "action": "import",
            })
        elif ans == "d":
            decisions.append({"pattern": cf["pattern"], "action": "drop"})
        # else keep
    return decisions


def _excise_from_all_origins(
    scope, pattern: str, kind: Optional[str]
) -> bool:
    """Remove a pattern from every native origin file for the scope.

    Covers: Codex default.rules, Codex skill-hub.rules, Claude/Pi settings.json.
    Returns True if any file was modified.
    """
    import permission_adapters as pa
    import harnesses as _harnesses

    removed = False
    codex_adapter = pa.get_adapter("codex")
    if codex_adapter is not None:
        # Codex user-authored rules (default.rules)
        codex_default = _codex_default_rules_for_scope(scope)
        if codex_adapter.excise_pattern(codex_default, pattern, kind):
            removed = True
        # Codex hub-generated rules (skill-hub.rules) — also excise so re-syncs
        # don't leave a ghost when the rule is later deleted from the registry.
        codex_skill_hub = pa._codex_rules_target(scope)
        if codex_adapter.excise_pattern(codex_skill_hub, pattern, kind):
            removed = True
    # Claude-family settings.json (best-effort per installed harness)
    ca = pa.get_adapter("claude")
    if ca is not None:
        for h_id in ("claude-code", "pi"):
            h = _harnesses.HARNESSES.get(h_id)
            if h is None or h.permission_adapter_key != "claude":
                continue
            try:
                tf = ca.target_files(scope, h_id)
            except Exception:
                continue
            if _drop_claude_rule(tf, pattern, kind):
                removed = True
    return removed


def _apply_import_decisions(
    registry: dict, scope, scope_kind: str, proj_name, decisions: list[dict]
) -> dict:
    block = _get_perm_block(registry, scope_kind, proj_name)

    imported = dropped = kept = 0
    for d in decisions:
        action = d.get("action", "keep")
        pattern = d.get("pattern")
        kind = d.get("kind")
        if not pattern:
            continue
        if action == "keep":
            kept += 1
            continue
        if action == "import":
            if kind and _add_rule_to_block(block, pattern, kind, d.get("harnesses")):
                imported += 1
            # MOVE: excise from every origin so rules never appear as both
            # user-authored and hub-managed after import.
            _excise_from_all_origins(scope, pattern, kind)
        elif action == "drop":
            if _excise_from_all_origins(scope, pattern, kind):
                dropped += 1

    _dedupe_registry_permissions(registry)
    return {"imported": imported, "dropped": dropped, "kept": kept}


def _scope_native_files(scope, scope_kind: str, proj_name, installed: set) -> list:
    """Every native file the reconcile transaction for `scope` may touch — the
    hub-managed write targets AND the MOVE-excision origins. Used to snapshot for
    rollback. Returns a de-duplicated list of `Path`."""
    import permission_adapters as pa
    import harnesses as _harnesses

    files: list = []

    def _add(p):
        if p is not None and p not in files:
            files.append(p)

    for h_id in sorted(installed):
        harness = _harnesses.HARNESSES.get(h_id)
        if harness is None or harness.permission_adapter_key is None:
            continue
        adapter = pa.get_adapter(harness.permission_adapter_key)
        if adapter is None:
            continue
        if harness.permission_adapter_key == "claude":
            try:
                _add(adapter.target_files(scope, h_id))
            except Exception:
                pass
        elif harness.permission_adapter_key == "codex":
            try:
                _add(adapter.target_files(scope, h_id))  # config.toml
            except Exception:
                pass
            _add(pa._codex_rules_target(scope))           # skill-hub.rules
            _add(_codex_default_rules_for_scope(scope))   # default.rules
    return files


def _sync_scope_native(
    registry: dict, scope, scope_kind: str, proj_name, installed: set
) -> list:
    """Write native files for a single scope via the adapters — the same path as
    `hub sync`, narrowed to one scope. Global writes the global block; a project
    writes its own block (scope-targeted, D1). Returns the written file paths."""
    import permission_adapters as pa
    import harnesses as _harnesses
    from permissions import NormalizedPermissions, resolve_project_own

    written: list[str] = []

    if scope_kind == "global":
        block = registry.get("permissions_global") or {}
        perms = NormalizedPermissions.from_block(block)
        for r in perms.allow + perms.deny + perms.ask:
            r.origin = "global"
        for h in perms.hooks:
            h.origin = "global"
        harness_ids = sorted(installed)
        unmanaged = _unmanaged_list(block)
    else:
        proj_cfg = registry["projects"][proj_name]
        perms = resolve_project_own(proj_cfg)
        proj_block = proj_cfg.get("permissions") or {}
        global_block = registry.get("permissions_global") or {}
        effective = _harnesses.resolve_effective(
            proj_cfg, registry, installed=installed
        )
        harness_ids = sorted(effective)
        unmanaged = set(_unmanaged_list(proj_block)) | set(
            _unmanaged_list(global_block)
        )

    for h_id in harness_ids:
        harness = _harnesses.HARNESSES.get(h_id)
        if harness is None or harness.permission_adapter_key is None:
            continue
        if h_id in unmanaged:
            continue
        adapter = pa.get_adapter(harness.permission_adapter_key)
        if adapter is None:
            continue
        result = adapter.translate(perms, scope, h_id)
        for write in result.writes:
            if adapter.apply(scope, write, h_id):
                written.append(str(write.target_path))
    return written


def _set_perm_block(registry: dict, scope_kind: str, proj_name, block: dict) -> None:
    if scope_kind == "global":
        registry["permissions_global"] = block
    else:
        registry["projects"][proj_name]["permissions"] = block


def _reconcile_apply(
    registry: dict,
    scope,
    scope_kind: str,
    proj_name,
    decisions: list,
    installed: set,
    conflict_patterns: Optional[set] = None,
) -> dict:
    """Apply reconcile decisions as a single transaction for one scope (D3):

    1. Snapshot the registry block + every native file we may touch.
    2. Mutate the registry block (import/drop/keep) + MOVE-excise origins.
    3. Write the registry, then auto-sync native files for the scope.

    On any failure after the registry write, restore the registry block and every
    native file from its pre-apply snapshot, then re-raise. Returns
    `{imported, dropped, kept, conflicts_resolved, synced_files}`.
    """
    import copy

    pre_block = copy.deepcopy(_get_perm_block(registry, scope_kind, proj_name))
    touched = _scope_native_files(scope, scope_kind, proj_name, installed)
    snapshots: dict = {}
    for p in touched:
        try:
            snapshots[p] = p.read_bytes() if p.exists() else None
        except OSError:
            snapshots[p] = None

    try:
        summary = _apply_import_decisions(
            registry, scope, scope_kind, proj_name, decisions
        )
        save_registry(registry)
        synced = _sync_scope_native(
            registry, scope, scope_kind, proj_name, installed
        )
        summary["synced_files"] = synced
        cps = conflict_patterns or set()
        summary["conflicts_resolved"] = len(
            {
                d.get("pattern")
                for d in decisions
                if d.get("pattern") in cps and d.get("action") == "import"
            }
        )
        return summary
    except Exception:
        # Roll back registry block then native files to the pre-apply snapshot.
        _set_perm_block(registry, scope_kind, proj_name, pre_block)
        try:
            save_registry(registry)
        except Exception:
            pass
        for p, data in snapshots.items():
            try:
                if data is None:
                    if p.exists():
                        p.unlink()
                else:
                    p.write_bytes(data)
            except OSError:
                pass
        raise


def cmd_permissions_reconcile(args):
    """`hub permissions reconcile` — unified ingest of pre-existing native rules
    across all installed harnesses for a scope (D3), subsuming `adopt` + `import`.

    Discovery (no `--apply`): emit/print the reconciled candidate set
    (`merged` / `conflicts` / `un_importable`). Apply (`--apply --decisions-stdin`):
    transactional + auto-syncing via `_reconcile_apply`.
    """
    import permission_adapters as pa
    import harnesses as _harnesses
    from permissions import GlobalScope, ProjectScope

    registry = load_registry()
    json_out = bool(getattr(args, "json", False))

    if getattr(args, "global_", False):
        scope = GlobalScope()
        scope_kind, proj_name = "global", None
    else:
        proj_name = getattr(args, "project", None)
        if not proj_name:
            fail("specify --global or --project <name>")
        if proj_name not in registry.get("projects", {}):
            fail(f"unknown project: {proj_name}")
        proj_cfg = registry["projects"][proj_name]
        scope = ProjectScope(name=proj_name, path=str(expand(proj_cfg["path"])))
        scope_kind = "project"

    installed = _harnesses.detect_installed()
    h_filter = getattr(args, "harness", None)
    targets = sorted(installed if h_filter is None else {h_filter} & installed)

    candidates = pa.gather_import_candidates(scope, targets)
    reconciled = pa.reconcile_candidates(candidates)
    conflict_patterns = {cf["pattern"] for cf in reconciled["conflicts"]}

    apply_flag = bool(getattr(args, "apply", False))
    if apply_flag:
        if not getattr(args, "decisions_stdin", False):
            fail("--apply requires --decisions-stdin")
        try:
            payload = json.loads(sys.stdin.read() or "{}")
        except json.JSONDecodeError as e:
            fail(f"invalid decisions JSON: {e}")
        decisions = payload.get("decisions") or []
        summary = _reconcile_apply(
            registry, scope, scope_kind, proj_name, decisions, installed,
            conflict_patterns=conflict_patterns,
        )
        if json_out:
            print(json.dumps(summary, indent=2))
        else:
            print(
                f"{c('✓', GREEN)} reconcile: {summary['imported']} imported, "
                f"{summary['dropped']} dropped, {summary['kept']} kept, "
                f"{summary.get('conflicts_resolved', 0)} conflict(s) resolved; "
                f"synced {len(summary.get('synced_files') or [])} file(s)"
            )
        return

    # Discovery view (shared shape with `import` for the unified dialog).
    view = {
        "scope_kind": scope_kind,
        "project": proj_name,
        "merged": [
            {"pattern": m["pattern"], "kind": m["kind"],
             "harnesses": m["harnesses"],
             "sources": [{"harness": s["harness"], "source": s["source"]}
                         for s in m["sources"]]}
            for m in reconciled["merged"]
        ],
        "conflicts": [
            {"pattern": cf["pattern"], "options": cf["options"]}
            for cf in reconciled["conflicts"]
        ],
        "un_importable": [
            {"source": u.get("source"), "harness": u.get("harness"),
             "reason": u.get("reason"), "file": u.get("file")}
            for u in reconciled["un_importable"]
        ],
    }
    if json_out:
        print(json.dumps(view, indent=2))
        return
    print(f"\n{c('Permissions reconcile — ' + scope_kind, BOLD)}\n")
    if not (reconciled["merged"] or reconciled["conflicts"] or reconciled["un_importable"]):
        print(f"  {c('·', DIM)} nothing to reconcile")
        return
    for m in reconciled["merged"]:
        srcs = ", ".join(sorted({s["harness"] for s in m["sources"]}))
        print(f"  {c('+', GREEN)} {m['kind']:<5} {m['pattern']}  [{srcs}]")
    for cf in reconciled["conflicts"]:
        opts = "; ".join(f"{k}={','.join(v)}" for k, v in cf["options"].items())
        print(f"  {c('!', YELLOW)} CONFLICT {cf['pattern']}  ({opts})")
    for u in reconciled["un_importable"]:
        print(f"  {c('×', DIM)} un-importable [{u.get('harness')}] {u.get('reason')}")
    print("\n  apply with --apply --decisions-stdin, or --json for machine output")


def cmd_permissions_set(args):
    """Atomic full-block replace for permissions_global or projects.<n>.permissions.

    Reads a NormalizedPermissions JSON payload from `--stdin-json` or `--json-file`,
    normalises via `NormalizedPermissions.from_block`, diffs against the current
    block, and writes the registry only if the normalised forms differ. The write
    runs under the data-home lock so concurrent invocations serialise.

    Emits `{"changed": <bool>, "normalized": <NormalizedPermissions.to_dict()>}`.
    """
    from permissions import NormalizedPermissions

    stdin_json = bool(getattr(args, "stdin_json", False))
    json_file = getattr(args, "json_file", None)
    if stdin_json == bool(json_file):
        fail("specify exactly one of --stdin-json or --json-file <path>")

    if stdin_json:
        raw = sys.stdin.read()
    else:
        try:
            raw = Path(json_file).read_text()
        except OSError as e:
            fail(f"could not read {json_file}: {e}")
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        fail(f"invalid JSON payload: {e}")
    if payload is not None and not isinstance(payload, dict):
        fail("JSON payload must be an object")

    with data_home_lock():
        registry = load_registry()
        scope_kind, proj_name, _scope, _label = _perm_scope_from_args(args, registry)
        personal = _perm_personal_flag(args, scope_kind)

        if scope_kind == "global":
            current_block = registry.get("permissions_global") or {}
        else:
            block_key = "permissions_local" if personal else "permissions"
            current_block = registry["projects"][proj_name].get(block_key) or {}

        current_norm = NormalizedPermissions.from_block(current_block)
        new_norm = NormalizedPermissions.from_block(payload)

        # Diff via normalised dict representation (the canonical form). Also
        # treat an already-corrupted duplicate block as changed so `set` repairs
        # it even when the submitted normalized payload is otherwise identical.
        current_dict = current_norm.to_dict()
        new_dict = new_norm.to_dict()
        _canonical_current, canonical_current_changed = _canonicalize_permissions_block(
            current_block
        )
        changed = current_dict != new_dict or canonical_current_changed

        if changed:
            # Build the new block. Preserve `_unmanaged` from the payload if it
            # has any entries; otherwise inherit from the current block so
            # callers can omit it without clearing.
            new_block = _serialize_perms_block(new_norm)
            unmanaged = list(new_norm._unmanaged or [])
            if not unmanaged and current_block.get("_unmanaged"):
                # Caller did not provide `_unmanaged`; preserve.
                unmanaged = list(current_block.get("_unmanaged") or [])
            if unmanaged:
                new_block["_unmanaged"] = unmanaged

            if scope_kind == "global":
                registry["permissions_global"] = new_block
            else:
                block_key = "permissions_local" if personal else "permissions"
                registry["projects"][proj_name][block_key] = new_block
            save_registry(registry)

    print(json.dumps({"changed": changed, "normalized": new_dict}, indent=2))


def cmd_permissions_validate(args):
    """Validate a (kind, pattern) pair across installed adapters.

    Wraps `_validate_pattern_across_adapters`. JSON output: `{ok, error}`.
    """
    pattern = args.pattern
    kind = args.kind
    ok, err = _validate_pattern_across_adapters(pattern, kind)
    payload = {"ok": ok, "error": None if ok else (err or "invalid")}
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
    else:
        if ok:
            print(f"{c('✓', GREEN)} {kind} {pattern!r} accepted")
        else:
            print(f"{c('✗', RED)} {kind} {pattern!r} rejected: {payload['error']}")
            sys.exit(1)


def cmd_permissions_capabilities(args):
    """Emit per-installed-harness PermissionFeature lists.

    Only installed harnesses whose adapter exposes `capabilities()` are listed.
    """
    import harnesses as _harnesses
    import permission_adapters as pa

    installed = _harnesses.detect_installed()
    out: dict[str, list[str]] = {}
    for h_id in sorted(installed):
        harness = _harnesses.HARNESSES.get(h_id)
        if harness is None or harness.permission_adapter_key is None:
            continue
        adapter = pa.get_adapter(harness.permission_adapter_key)
        if adapter is None or not hasattr(adapter, "capabilities"):
            continue
        try:
            caps = adapter.capabilities()
        except Exception:
            continue
        out[h_id] = sorted(getattr(f, "value", str(f)) for f in caps)
    if getattr(args, "json", False):
        print(json.dumps(out, indent=2))
    else:
        for h_id, feats in out.items():
            print(f"  {h_id}: {', '.join(feats) or '-'}")


def cmd_permissions_doctor(args):
    import risks
    import permission_adapters as pa
    import harnesses as _harnesses
    from permissions import NormalizedPermissions, resolve_effective

    registry = load_registry()
    installed = _harnesses.detect_installed()

    targets: list[tuple[str, str, "NormalizedPermissions"]] = []
    global_perms = NormalizedPermissions.from_block(registry.get("permissions_global"))
    for r in global_perms.allow + global_perms.deny + global_perms.ask:
        r.origin = "global"
    for h in global_perms.hooks:
        h.origin = "global"
    for h_id in sorted(installed):
        targets.append(("global", h_id, global_perms))
    for proj_name, proj_cfg in (registry.get("projects") or {}).items():
        eff = resolve_effective(proj_cfg, registry)
        eff_harnesses = _harnesses.resolve_effective(
            proj_cfg, registry, installed=installed
        )
        for h_id in sorted(eff_harnesses):
            targets.append((f"project:{proj_name}", h_id, eff))

    all_findings = []
    danger = 0
    for scope_label, h_id, perms in targets:
        harness = _harnesses.HARNESSES.get(h_id)
        adapter = (
            pa.get_adapter(harness.permission_adapter_key)
            if (harness and harness.permission_adapter_key)
            else None
        )
        caps = adapter.capabilities() if adapter else set()
        findings = risks.detect_risks(perms, caps)
        for f in findings:
            all_findings.append(
                {
                    "scope": scope_label,
                    "harness": h_id,
                    **f.to_dict(),
                }
            )
            if f.severity == "danger":
                danger += 1

    if getattr(args, "json", False):
        print(json.dumps({"findings": all_findings, "danger_count": danger}, indent=2))
    else:
        if not all_findings:
            print(f"{c('✓', GREEN)} no risks detected")
        for f in all_findings:
            colour = RED if f["severity"] == "danger" else YELLOW
            icon = "✗" if f["severity"] == "danger" else "!"
            print(
                f"{c(icon, colour)} {f['scope']}  [{f['harness']}]  "
                f"{f['code']} ({f['severity']}): {f['detail']}"
            )

    if danger > 0:
        sys.exit(2)


def _rule_keys(block: Optional[dict]) -> set:
    """`(pattern, kind)` set for the allow/deny/ask rules in a permissions block."""
    from permissions import NormalizedPermissions

    perms = NormalizedPermissions.from_block(block or {})
    keys = set()
    for kind, rules in (
        ("allow", perms.allow),
        ("deny", perms.deny),
        ("ask", perms.ask),
    ):
        for r in rules:
            keys.add((r.pattern, kind))
    return keys


def _build_migrate_scope_plan(registry: dict, apply_flag: bool) -> list[dict]:
    """De-duplicate global-sourced hub-managed rules out of project native files (D2).

    For each project Claude-family native file (claude-code, pi) that hub manages
    (has a sidecar), find hub-managed `permissions.{allow,deny,ask}[i]` entries
    whose `(pattern, kind)` is present in the **global** block and absent from the
    project's **own** block, and remove them — the global rule reaches the project
    via the harness's user-level file at runtime, so the project copy is a stale
    duplicate. Backup-first; dry-run unless `apply_flag`. Rules the project owns,
    user-authored (non-hub-managed) rules, and entries that don't cleanly resolve
    are left in place and reported.

    Codex is exempt: its project rules file (`skill-hub.rules`) and `config.toml`
    knobs are scope-targeted by construction, so global rules never landed there.

    Returns a list of per-(project, harness) entry dicts:
    `{scope_label, harness_id, target_file, removed[], kept[], ambiguous[],
      backup_path, applied}`.
    """
    import json as _json
    import re as _re

    import harnesses as _harnesses
    import permission_adapters as pa
    from permissions import ProjectScope, read_sidecar, write_sidecar

    installed = _harnesses.detect_installed()
    # Only Claude-family adapters ever copied global rules into project files.
    claude_harnesses = sorted(
        h_id
        for h_id in installed
        if _harnesses.HARNESSES.get(h_id)
        and _harnesses.HARNESSES[h_id].permission_adapter_key == "claude"
    )

    global_keys = _rule_keys(registry.get("permissions_global"))

    entries: list[dict] = []
    if not global_keys:
        return entries  # nothing global to de-duplicate against

    for proj_name, proj_cfg in (registry.get("projects") or {}).items():
        proj_path = str(expand(proj_cfg["path"]))
        own_keys = _rule_keys(proj_cfg.get("permissions"))
        scope = ProjectScope(name=proj_name, path=proj_path)
        for h_id in claude_harnesses:
            sc = read_sidecar(h_id, scope)
            if sc is None:
                continue  # hub does not manage this (scope, harness)
            target = Path(sc.file)
            if not target.exists():
                continue
            try:
                data = _json.loads(target.read_text())
            except (OSError, _json.JSONDecodeError):
                continue

            # Group hub-managed permission-rule indices by kind (allow/deny/ask).
            managed_by_kind: dict[str, list[int]] = {}
            ambiguous: list[dict] = []
            for key in sc.managed_keys:
                m = _re.match(r"^permissions\.(allow|deny|ask)\[(\d+)\]$", key)
                if not m:
                    continue  # hooks / additionalDirectories — not rule de-dup
                managed_by_kind.setdefault(m.group(1), []).append(int(m.group(2)))

            removed: list[dict] = []
            kept: list[dict] = []
            # Per kind, decide which hub-managed indices to drop.
            remove_idx_by_kind: dict[str, set] = {}
            for kind, idxs in managed_by_kind.items():
                arr = (data.get("permissions") or {}).get(kind)
                if not isinstance(arr, list):
                    for i in idxs:
                        ambiguous.append(
                            {"key": f"permissions.{kind}[{i}]",
                             "reason": "section missing in native file"}
                        )
                    continue
                drop: set = set()
                for i in idxs:
                    if not (0 <= i < len(arr)):
                        ambiguous.append(
                            {"key": f"permissions.{kind}[{i}]",
                             "reason": "index out of range"}
                        )
                        continue
                    pattern = arr[i]
                    if not isinstance(pattern, str):
                        ambiguous.append(
                            {"key": f"permissions.{kind}[{i}]",
                             "reason": "non-string rule value"}
                        )
                        continue
                    rkey = (pattern, kind)
                    if rkey in global_keys and rkey not in own_keys:
                        drop.add(i)
                        removed.append({"pattern": pattern, "kind": kind})
                    else:
                        reason = (
                            "also in project's own block"
                            if rkey in own_keys
                            else "not a global-sourced rule"
                        )
                        kept.append(
                            {"pattern": pattern, "kind": kind, "reason": reason}
                        )
                if drop:
                    remove_idx_by_kind[kind] = drop

            backup_path: Optional[Path] = None
            applied = False
            if apply_flag and remove_idx_by_kind:
                backup_path = pa._backup_once_per_session(target, scope, h_id)
                # Remove the dropped entries and recompute sidecar managed_keys
                # so surviving hub-managed rules keep correct indices.
                new_managed_keys: list[str] = []
                # Non-rule managed keys (hooks, additionalDirectories) are
                # untouched — different paths, unaffected by rule deletions.
                for key in sc.managed_keys:
                    if not _re.match(r"^permissions\.(allow|deny|ask)\[(\d+)\]$", key):
                        new_managed_keys.append(key)
                for kind, idxs in managed_by_kind.items():
                    drop = remove_idx_by_kind.get(kind, set())
                    arr = (data.get("permissions") or {}).get(kind)
                    if not isinstance(arr, list):
                        continue
                    # Delete dropped indices (reverse) so earlier indices stay valid.
                    for i in sorted(drop, reverse=True):
                        if 0 <= i < len(arr):
                            del arr[i]
                    pa._maybe_prune_empty(data, ("permissions", kind))
                    # Re-index surviving hub-managed indices for this kind.
                    for j in sorted(set(idxs) - drop):
                        shift = sum(1 for d in drop if d < j)
                        new_managed_keys.append(f"permissions.{kind}[{j - shift}]")
                pa._atomic_replace(target, _json.dumps(data, indent=2) + "\n")
                write_sidecar(h_id, scope, new_managed_keys, target)
                applied = True

            if removed or ambiguous:
                entries.append(
                    {
                        "scope_label": proj_name,
                        "harness_id": h_id,
                        "target_file": str(target),
                        "removed": removed,
                        "kept": kept,
                        "ambiguous": ambiguous,
                        "backup_path": str(backup_path) if backup_path else None,
                        "applied": applied,
                    }
                )
    return entries


def cmd_permissions_migrate_scope(args):
    """`hub permissions migrate-scope` — strip global-sourced duplicates from
    project native files (D2). Dry-run by default; `--apply` to commit."""
    apply_flag = bool(getattr(args, "apply", False))
    json_out = bool(getattr(args, "json", False))

    registry = load_registry()
    entries = _build_migrate_scope_plan(registry, apply_flag)

    if json_out:
        print(json.dumps({"apply": apply_flag, "entries": entries}, indent=2))
        return

    label = "APPLY" if apply_flag else "DRY RUN"
    print(f"\n{c(f'hub permissions migrate-scope — {label}', BOLD)}\n")
    if not entries:
        print(f"  {c('✓', GREEN)} no global-sourced duplicates found in project files\n")
        return
    total_removed = 0
    for e in entries:
        total_removed += len(e["removed"])
        print(f"  {c(e['scope_label'], BOLD)}  [{e['harness_id']}]  {e['target_file']}")
        for r in e["removed"]:
            verb = "removed" if e["applied"] else "would remove"
            print(f"      {c('−', YELLOW)} {verb} {r['kind']}: {r['pattern']}")
        for a in e["ambiguous"]:
            print(f"      {c('?', DIM)} left in place: {a['key']} ({a['reason']})")
        if e["backup_path"]:
            print(f"      {c('backup:', DIM)} {e['backup_path']}")
    print()
    if apply_flag:
        print(f"{c('✓', GREEN, BOLD)} removed {total_removed} duplicate rule(s)\n")
    else:
        msg = (
            f"(dry-run — {total_removed} rule(s) would be removed; "
            f"pass --apply to commit)"
        )
        print(f"{c(msg, DIM)}\n")


def _project_files_have_global_duplicates(registry: dict) -> bool:
    """First-post-upgrade detection (D2): True if any project native file still
    contains a hub-managed rule that is global-sourced and not project-owned."""
    try:
        return bool(_build_migrate_scope_plan(registry, apply_flag=False))
    except Exception:
        return False


def _build_disable_entries(args, registry, mode: str, apply_flag: bool):
    """Resolve `hub permissions disable` targets into a list of structured entry dicts.

    Each entry: `{scope_kind, scope_label, harness_id, target_file, backup_path,
    sidecar_path, action, will_write, applied}` where `action ∈ {"restore",
    "detach", "clear"}`. Mutates `registry` in place when `apply_flag` is True.
    Caller is responsible for `save_registry(registry)` after.
    """
    import permission_adapters as pa
    import harnesses as _harnesses
    from permissions import (
        GlobalScope,
        ProjectScope,
        delete_sidecar,
        read_sidecar,
        sidecar_path,
        write_sidecar,
    )

    installed = _harnesses.detect_installed()
    h_filter = getattr(args, "harness", None)

    def harness_ids() -> list[str]:
        ids = sorted(
            h_id
            for h_id in installed
            if _harnesses.HARNESSES[h_id].permission_adapter_key is not None
        )
        if h_filter:
            ids = [h_id for h_id in ids if h_id == h_filter]
        return ids

    targets: list[tuple[str, Any, list[str]]] = []
    if getattr(args, "all", False):
        targets.append(("global", GlobalScope(), harness_ids()))
        for proj_name, proj_cfg in (registry.get("projects") or {}).items():
            proj_path = str(expand(proj_cfg["path"]))
            targets.append(
                ("project", ProjectScope(name=proj_name, path=proj_path), harness_ids())
            )
    elif getattr(args, "global_", False):
        targets.append(("global", GlobalScope(), harness_ids()))
    elif getattr(args, "project", None):
        proj_name = args.project
        if proj_name not in registry.get("projects", {}):
            fail(f"unknown project: {proj_name}")
        proj_cfg = registry["projects"][proj_name]
        proj_path = str(expand(proj_cfg["path"]))
        targets.append(
            ("project", ProjectScope(name=proj_name, path=proj_path), harness_ids())
        )
    else:
        fail("specify --all, --global, or --project <name>")

    entries: list[dict] = []
    for scope_kind, scope, h_ids in targets:
        scope_label = "global" if scope_kind == "global" else scope.name
        for h_id in h_ids:
            harness = _harnesses.HARNESSES[h_id]
            adapter = pa.get_adapter(harness.permission_adapter_key)
            if adapter is None:
                continue
            sc = read_sidecar(h_id, scope)
            target_file = None
            if hasattr(adapter, "target_files"):
                try:
                    target_file = adapter.target_files(scope, h_id)
                except Exception:
                    target_file = None
            sidecar_loc = sidecar_path(h_id, scope)
            backup_path: Optional[Path] = None
            action: str
            if mode == "restore":
                backup_dir = pa._backups_root() / h_id / scope.slug
                if backup_dir.exists():
                    backups = sorted(backup_dir.iterdir())
                    # Prefer a backup matching the primary target's extension
                    # (Codex backs up both config.toml and skill-hub.rules into
                    # the same dir; restore must not cross-restore them).
                    if target_file is not None:
                        suffixed = [
                            b for b in backups if b.suffix == target_file.suffix
                        ]
                        if suffixed:
                            backups = suffixed
                    if backups:
                        backup_path = backups[-1]
                action = "restore"
                rules_sc_present = (
                    read_sidecar(h_id, scope, kind="rules") is not None
                )
                has_claim = sc is not None or rules_sc_present
                no_backup = backup_path is None
                # Restore writes when a backup can be reinstated; with no backup
                # we still surgically strip hub-managed keys (incl. Codex
                # trust_level) so registry and native files don't diverge.
                will_write = target_file is not None and (
                    backup_path is not None or has_claim
                )
            else:
                # detach: drop hub's sidecar claim, leave native files untouched
                action = "detach"
                will_write = False  # native files are NOT written on detach
                no_backup = False

            entry = {
                "scope_kind": scope_kind,
                "scope_label": scope_label,
                "harness_id": h_id,
                "target_file": str(target_file) if target_file else None,
                "backup_path": str(backup_path) if backup_path else None,
                "sidecar_path": str(sidecar_loc),
                "action": action,
                "will_write": bool(will_write),
                "no_backup": bool(no_backup) if mode == "restore" else False,
                "applied": False,
            }

            if apply_flag:
                if mode == "restore":
                    if backup_path is not None and target_file is not None:
                        # Pre-hub backup exists → revert the primary target to
                        # it. Because the backup predates hub, this also drops
                        # any hub-granted trust_level / rule lines naturally.
                        target_file.parent.mkdir(parents=True, exist_ok=True)
                        _shutil_copy_atomic(backup_path, target_file)
                        if sidecar_loc.exists():
                            delete_sidecar(h_id, scope)
                        # Tear down any hub-owned rules file (Codex
                        # skill-hub.rules): it is fully hub-generated, so
                        # restore = delete it.
                        rules_sc = read_sidecar(h_id, scope, kind="rules")
                        if rules_sc is not None:
                            rules_file = Path(rules_sc.file)
                            if rules_file.exists():
                                try:
                                    rules_file.unlink()
                                except OSError:
                                    pass
                            delete_sidecar(h_id, scope, kind="rules")
                    else:
                        # No pre-hub backup — we can't revert to a prior file,
                        # but leaving hub's managed keys (Codex trust_level, hub
                        # rule lines) in place would leave native files and the
                        # registry in disagreement. Surgically strip every
                        # hub-managed key via the adapter's cleanup (which also
                        # removes the hub-owned rules file and its sidecars).
                        try:
                            adapter.cleanup(scope, h_id)
                        except Exception:
                            pass
                        # Belt-and-suspenders: ensure sidecars are gone even if
                        # cleanup found nothing to strip.
                        if sidecar_loc.exists():
                            delete_sidecar(h_id, scope)
                        if read_sidecar(h_id, scope, kind="rules") is not None:
                            delete_sidecar(h_id, scope, kind="rules")
                else:
                    if sc is not None:
                        write_sidecar(h_id, scope, [], target_file or Path(sc.file))
                    delete_sidecar(h_id, scope)

                # Mutate registry: drop block content, mark unmanaged
                if scope_kind == "global":
                    blk = registry.setdefault("permissions_global", {})
                else:
                    blk = registry["projects"][scope.name].setdefault("permissions", {})
                for key in (
                    "allow",
                    "deny",
                    "ask",
                    "hooks",
                    "additional_dirs",
                    "extras",
                    "sandbox_mode",
                    "approval_policy",
                    "project_trust",
                ):
                    blk.pop(key, None)
                unmanaged = list(blk.get("_unmanaged") or [])
                if h_id not in unmanaged:
                    unmanaged.append(h_id)
                blk["_unmanaged"] = unmanaged
                entry["applied"] = True

            entries.append(entry)
    return entries


def cmd_permissions_disable(args):
    mode = args.mode
    if mode not in {"restore", "detach"}:
        fail(f"--mode must be restore|detach, got {mode!r}")
    apply_flag = bool(getattr(args, "apply", False))
    json_out = bool(getattr(args, "json", False))

    registry = load_registry()
    entries = _build_disable_entries(args, registry, mode, apply_flag)
    if apply_flag:
        save_registry(registry)

    if json_out:
        print(
            json.dumps(
                {"mode": mode, "apply": apply_flag, "entries": entries}, indent=2
            )
        )
        return

    label = "DRY RUN" if not apply_flag else "APPLY"
    print(f"\n{c(f'hub permissions disable ({mode}) — {label}', BOLD)}\n")
    for e in entries:
        harness_label = e["harness_id"]
        if e["action"] == "restore":
            if e.get("no_backup"):
                no_backup_note = c(
                    "no pre-hub backup — will strip hub-managed keys "
                    "(incl. Codex trust) in place",
                    YELLOW,
                )
                print(
                    f"  {e['scope_label']} [{harness_label}]  "
                    f"target={e['target_file']}  {no_backup_note}  "
                    f"sidecar={e['sidecar_path']}"
                )
            else:
                print(
                    f"  {e['scope_label']} [{harness_label}]  "
                    f"target={e['target_file']}  backup={e['backup_path']}  "
                    f"sidecar={e['sidecar_path']}"
                )
        else:
            print(
                f"  {e['scope_label']} [{harness_label}]  "
                f"detach — drop hub claim, leave native files as-is, "
                f"clear registry block, delete sidecar={e['sidecar_path']}"
            )
    if apply_flag:
        print(f"\n{c('✓ disabled', GREEN, BOLD)}\n")
    else:
        print(f"\n{c('(dry-run — pass --apply to commit)', DIM)}\n")


# ─────────────────────────────────────────────────────────────────────────────
# hub permissions presets ...
# ─────────────────────────────────────────────────────────────────────────────


def cmd_permissions_presets_list(args):
    from permission_presets import all_presets, is_builtin

    registry = load_registry()
    presets = all_presets(registry)
    if getattr(args, "json", False):
        print(
            json.dumps(
                [
                    {
                        "id": p.id,
                        "name": p.name,
                        "description": p.description,
                        "icon": p.icon,
                        "category": p.category,
                        "builtin": p.builtin,
                        "rule_count": len(p.rules),
                    }
                    for p in presets
                ],
                indent=2,
            )
        )
        return

    print(f"\n{c('Permission Presets', BOLD)}\n")
    for p in presets:
        label = c("builtin", DIM) if p.builtin else c("custom", CYAN)
        rule_word = "rule" if len(p.rules) == 1 else "rules"
        print(
            f"  {p.icon} {c(p.id, BOLD)}  "
            f"({len(p.rules)} {rule_word}, {label})"
        )
        if p.description:
            print(f"      {c(p.description, DIM)}")
    print()


def cmd_permissions_presets_show(args):
    from permission_presets import get_preset

    registry = load_registry()
    preset = get_preset(args.id, registry)
    if preset is None:
        fail(f"unknown preset: {args.id}")

    if getattr(args, "json", False):
        print(json.dumps(preset.to_dict(), indent=2))
        return

    label = "builtin" if preset.builtin else "custom"
    print(f"\n{preset.icon} {c(preset.name, BOLD)}  {c('(' + label + ')', DIM)}")
    if preset.description:
        print(f"  {c(preset.description, DIM)}")
    print(f"  {c('category:', DIM)} {preset.category}")
    print()
    for r in preset.rules:
        flag = c("default", GREEN) if r.enabled_by_default else c("off", DIM)
        print(f"  [{flag}] {c(r.pattern, BOLD)}  {c(r.kind, DIM)}")
        if r.description:
            print(f"          {c(r.description, DIM)}")
    print()


def cmd_permissions_presets_apply(args):
    from permission_presets import apply_preset, get_preset

    registry = load_registry()
    preset = get_preset(args.id, registry)
    if preset is None:
        fail(f"unknown preset: {args.id}")

    proj_name = args.project
    if proj_name not in (registry.get("projects") or {}):
        fail(f"unknown project: {proj_name}")

    enabled_patterns: Optional[list[str]] = None
    if getattr(args, "rules", None):
        enabled_patterns = parse_csv(args.rules)

    proj_cfg = registry["projects"][proj_name]
    block = proj_cfg.setdefault("permissions", {})
    existing = list(block.get("allow") or [])
    before = len(existing)
    new_allow = apply_preset(preset, enabled_patterns, existing)
    block["allow"] = new_allow
    added = len(new_allow) - before
    save_registry(registry)

    if getattr(args, "json", False):
        print(
            json.dumps(
                {
                    "preset": preset.id,
                    "project": proj_name,
                    "added": added,
                    "total": len(new_allow),
                },
                indent=2,
            )
        )
        return

    word = "rule" if added == 1 else "rules"
    print(
        f"{c('✓', GREEN)} applied {c(preset.id, BOLD)} → {c(proj_name, BOLD)}: "
        f"added {added} {word} ({len(new_allow)} total in allow)"
    )


def _require_user_preset_id(args_id: str) -> str:
    from permission_presets import is_builtin

    if is_builtin(args_id):
        fail(
            f"{args_id!r} is a built-in preset — built-ins cannot be modified or deleted"
        )
    if not SLUG_RE.match(args_id):
        fail(f"preset id must be a slug (lowercase letters, digits, hyphens): {args_id!r}")
    return args_id


def cmd_permissions_presets_new(args):
    preset_id = _require_user_preset_id(args.id)
    registry = load_registry()
    block = registry.setdefault("permission_presets", {}) or {}
    if not isinstance(block, dict):
        block = {}
        registry["permission_presets"] = block
    if preset_id in block:
        fail(f"preset already exists: {preset_id}")
    block[preset_id] = {
        "name": args.name,
        "description": args.description or "",
        "icon": args.icon or "📦",
        "category": args.category or "custom",
        "rules": [],
    }
    registry["permission_presets"] = block
    save_registry(registry)
    print(f"{c('✓', GREEN)} created preset {c(preset_id, BOLD)}")


def cmd_permissions_presets_update(args):
    preset_id = _require_user_preset_id(args.id)
    registry = load_registry()
    block = registry.get("permission_presets") or {}
    if not isinstance(block, dict) or preset_id not in block:
        fail(f"unknown user preset: {preset_id}")
    entry = block[preset_id]
    if not isinstance(entry, dict):
        fail(f"corrupt preset entry for {preset_id}")

    if args.name is not None:
        entry["name"] = args.name
    if args.description is not None:
        entry["description"] = args.description
    if args.icon is not None:
        entry["icon"] = args.icon

    rules = list(entry.get("rules") or [])
    # Index by pattern for add/remove operations.
    by_pattern: dict[str, dict] = {}
    for r in rules:
        if isinstance(r, dict):
            by_pattern[str(r.get("pattern", ""))] = r

    remove_patterns = set(getattr(args, "remove_rule", None) or [])
    for pat in remove_patterns:
        by_pattern.pop(pat, None)

    add_patterns = list(getattr(args, "add_rule", None) or [])
    for pat in add_patterns:
        if pat in by_pattern:
            continue
        by_pattern[pat] = {
            "pattern": pat,
            "kind": "allow",
            "description": "",
            "enabled_by_default": True,
        }

    # Preserve original ordering for kept rules, then append new patterns.
    new_rules: list[dict] = []
    seen: set[str] = set()
    for r in rules:
        if not isinstance(r, dict):
            continue
        pat = str(r.get("pattern", ""))
        if pat in remove_patterns or pat in seen:
            continue
        if pat in by_pattern:
            new_rules.append(by_pattern[pat])
            seen.add(pat)
    for pat in add_patterns:
        if pat in seen:
            continue
        new_rules.append(by_pattern[pat])
        seen.add(pat)

    entry["rules"] = new_rules
    block[preset_id] = entry
    registry["permission_presets"] = block
    save_registry(registry)
    print(
        f"{c('✓', GREEN)} updated preset {c(preset_id, BOLD)} "
        f"({len(new_rules)} rules)"
    )


def cmd_permissions_presets_delete(args):
    preset_id = _require_user_preset_id(args.id)
    registry = load_registry()
    block = registry.get("permission_presets") or {}
    if not isinstance(block, dict) or preset_id not in block:
        fail(f"unknown user preset: {preset_id}")
    del block[preset_id]
    if not block:
        registry.pop("permission_presets", None)
    else:
        registry["permission_presets"] = block
    save_registry(registry)
    print(f"{c('✓', GREEN)} deleted preset {c(preset_id, BOLD)}")


def _shutil_copy_atomic(src: Path, dst: Path) -> None:
    """Copy src → dst atomically by writing to a temp sibling and replacing."""
    import shutil as _sh

    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=dst.name + ".", suffix=".tmp", dir=str(dst.parent)
    )
    try:
        os.close(fd)
        _sh.copy2(src, tmp_name)
        os.replace(tmp_name, dst)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def cmd_selfcheck(args):
    """Registry-free runtime self-check used by the app's preflight.

    Reaching this function proves `hub.py` loaded and its load-time dependency
    (`yaml`, via the vendor shim) imported successfully — without touching
    `data_home()` or the registry, since the preflight runs *before* bootstrap.
    Optional/lazy dependencies (`tomlkit`, used only for Codex sync) are reported
    as non-fatal warnings, never failures, so a Codex-only gap can't block
    onboarding. Always exits 0 when the onboarding-critical chain is intact;
    any hard failure (missing vendor, syntax error, broken interpreter) surfaces
    as a non-zero exit with a real traceback for the preflight to relay.
    """
    warnings: list[str] = []
    try:
        import tomlkit  # noqa: F401
    except ImportError:
        warnings.append(
            "tomlkit unavailable — Codex MCP/permission sync will be degraded"
        )

    payload = {
        "ok": True,
        "python": (
            f"{sys.version_info.major}."
            f"{sys.version_info.minor}."
            f"{sys.version_info.micro}"
        ),
        "vendor_dir": str(_VENDOR_DIR) if _VENDOR_DIR.is_dir() else None,
        "warnings": warnings,
    }
    if getattr(args, "json", False):
        print(json.dumps(payload))
    else:
        vendor = "yes" if payload["vendor_dir"] else "no"
        print(f"ok  python={payload['python']}  vendor={vendor}")
        for w in warnings:
            print(f"warning: {w}")


def cmd_version(_args):
    registry = load_registry()
    skills = registry.get("skills", {})
    print(f"\n{c('Skill Hub v' + hub_version(), BOLD)}")
    print(f"Data home: {data_home()}")
    print(f"Code home: {code_home()}")
    print(f"Registry:  {registry_file()}")
    print(f"Skills: {len(skills)} registered")
    global_count = sum(1 for s in skills.values() if s.get("scope") == "global")
    portable_count = sum(1 for s in skills.values() if s.get("scope") == "portable")
    ps_count = sum(1 for s in skills.values() if s.get("scope") == "project-specific")
    mcp_count = sum(1 for s in skills.values() if s.get("type") == "mcp-server")
    print(
        f"  {global_count} global, {portable_count} portable, {ps_count} project-specific, {mcp_count} MCP servers"
    )
    print()


# ─────────────────────────────────────────────────────────────────────────────
# hub mcp-control — register/unregister the control-plane MCP server
# ─────────────────────────────────────────────────────────────────────────────

MCP_CONTROL_SKILL_NAME = "skill-hub"


def _mcp_control_server_path() -> Path:
    return code_home() / "skill_hub_mcp_server.py"


def _mcp_control_entry() -> dict:
    server_path = str(_mcp_control_server_path())
    return {
        "type": "mcp-server",
        "version": "1.0.0",
        "description": "Skill Hub control-plane MCP server (manage skills + bundles).",
        "scope": "global",
        "source": None,
        "upstream": None,
        "mcp": {
            "runtime": "python",
            "command": "python3",
            "args": [server_path],
            # Tag mutations made through the MCP server so the audit log
            # distinguishes them from human `hub` CLI use.
            "env": {"SKILL_HUB_ACTOR": "skill-hub-mcp"},
        },
    }


@registry_mutation("mcp-control-install")
def cmd_mcp_control_install(_args):
    registry = load_registry()
    skills = registry.setdefault("skills", {})
    entry = _mcp_control_entry()
    existing = skills.get(MCP_CONTROL_SKILL_NAME)
    if existing == entry:
        print(
            f"'{MCP_CONTROL_SKILL_NAME}' control-plane MCP server already registered "
            f"({entry['mcp']['args'][0]})."
        )
        return
    skills[MCP_CONTROL_SKILL_NAME] = entry
    registry["skills"] = skills
    save_registry(registry)
    verb = "updated" if existing is not None else "registered"
    print(
        f"{c('✓', GREEN)} {verb} control-plane MCP server '{MCP_CONTROL_SKILL_NAME}' "
        f"→ {entry['mcp']['args'][0]}"
    )
    print(f"  → run `{c('hub sync', CYAN)}` to dispatch it to your harnesses")


@registry_mutation("mcp-control-uninstall")
def cmd_mcp_control_uninstall(_args):
    registry = load_registry()
    skills = registry.get("skills", {})
    if MCP_CONTROL_SKILL_NAME not in skills:
        print(f"'{MCP_CONTROL_SKILL_NAME}' control-plane MCP server is not registered.")
        return
    del skills[MCP_CONTROL_SKILL_NAME]
    registry["skills"] = skills
    save_registry(registry)
    print(f"{c('✓', GREEN)} removed control-plane MCP server '{MCP_CONTROL_SKILL_NAME}'")


def cmd_mcp_control_status(_args):
    server_path = _mcp_control_server_path()
    registry = _read_registry_optional()
    entry = (registry.get("skills") or {}).get(MCP_CONTROL_SKILL_NAME)
    registered = entry is not None
    print(f"\n{c('Control-plane MCP server', BOLD, CYAN)}\n")
    print(f"  name:       {MCP_CONTROL_SKILL_NAME}")
    print(f"  server:     {server_path}")
    print(f"  exists:     {'yes' if server_path.exists() else 'no'}")
    print(
        f"  registered: {c('yes', GREEN) if registered else c('no', DIM)}"
    )
    if registered:
        args_path = ((entry.get("mcp") or {}).get("args") or ["?"])[0]
        print(f"  registry args[0]: {args_path}")


def cmd_mcp_control(args):
    sub = getattr(args, "mcp_control_cmd", None)
    if sub == "install":
        cmd_mcp_control_install(args)
    elif sub == "uninstall":
        cmd_mcp_control_uninstall(args)
    elif sub == "status":
        cmd_mcp_control_status(args)
    else:
        print("Usage: hub mcp-control {install|uninstall|status}")


# ─────────────────────────────────────────────────────────────────────────────
# Sub-agents (Claude Code) — see subagents.py + the claude-subagents-manager change
# ─────────────────────────────────────────────────────────────────────────────


def _subagent_registry() -> dict:
    """Registry for path/skill resolution — optional (project scope needs it)."""
    return _read_registry_optional()


def cmd_subagent_list(args):
    import subagents

    scope = getattr(args, "scope", "user")
    project = getattr(args, "project", None)
    harness = getattr(args, "harness", None) or "claude-code"
    try:
        result = subagents.list_agents(scope, project, _subagent_registry(), harness)
    except ValueError as e:
        fail(str(e))
        return
    print(json.dumps(result, indent=2, ensure_ascii=False))


def cmd_subagent_show(args):
    import subagents

    scope = getattr(args, "scope", "user")
    project = getattr(args, "project", None)
    harness = getattr(args, "harness", None) or "claude-code"
    try:
        result = subagents.show_agent(args.name, scope, project, _subagent_registry(), harness)
    except ValueError as e:
        fail(str(e))
        return
    print(json.dumps(result, indent=2, ensure_ascii=False))


def cmd_subagent_save(args):
    import subagents

    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "errors": [
            {"field": "payload", "level": "error",
             "message": f"invalid JSON payload on stdin: {e}", "value": ""}]}))
        sys.exit(1)
    if not isinstance(payload, dict) or not isinstance(payload.get("safe"), dict):
        print(json.dumps({"ok": False, "errors": [
            {"field": "payload", "level": "error",
             "message": "payload must be an object with a 'safe' object", "value": ""}]}))
        sys.exit(1)
    with data_home_lock():
        try:
            result = subagents.save_agent(payload, _subagent_registry())
        except ValueError as e:
            result = {"ok": False, "errors": [
                {"field": "scope", "level": "error", "message": str(e), "value": ""}]}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result.get("ok"):
        sys.exit(1)


def cmd_subagent_delete(args):
    import subagents

    scope = getattr(args, "scope", "user")
    project = getattr(args, "project", None)
    harness = getattr(args, "harness", None) or "claude-code"
    link_action = getattr(args, "link_action", None) or "this"
    with data_home_lock():
        try:
            result = subagents.delete_agent(args.name, scope, project, _subagent_registry(),
                                            harness, link_action)
        except ValueError as e:
            result = {"ok": False, "errors": [
                {"field": "scope", "level": "error", "message": str(e), "value": ""}]}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result.get("ok"):
        sys.exit(1)


def cmd_subagent_set_disabled(args):
    import subagents

    scope = getattr(args, "scope", "user")
    project = getattr(args, "project", None)
    disabled = str(getattr(args, "disabled", "")).strip().lower() in ("true", "1", "yes")
    harness = getattr(args, "harness", None) or "claude-code"
    with data_home_lock():
        try:
            state = subagents.set_disabled(
                args.name, disabled, scope, project, _subagent_registry(), harness)
        except ValueError as e:
            fail(str(e))
            return
    print(json.dumps({"ok": True, "disabled": state}, indent=2, ensure_ascii=False))


def cmd_subagent_skill_usage(args):
    import subagents

    result = subagents.skill_usage(_subagent_registry())
    print(json.dumps(result, indent=2, ensure_ascii=False))


def cmd_subagent_attachable_skills(args):
    import subagents

    scope = getattr(args, "scope", "user")
    project = getattr(args, "project", None)
    harness = getattr(args, "harness", None) or "claude-code"
    try:
        result = subagents.attachable_skills(scope, project, _subagent_registry(), harness)
    except ValueError as e:
        fail(str(e))
        return
    print(json.dumps(result, indent=2, ensure_ascii=False))


def cmd_subagent_link(args):
    """Link the same-named agent across harnesses (linked twins, D3)."""
    import subagent_links

    harnesses_arg = getattr(args, "harnesses", None)
    hs = ([h.strip() for h in harnesses_arg.split(",") if h.strip()]
          if harnesses_arg else None)
    with data_home_lock():
        try:
            result = subagent_links.link_agents(
                args.name, hs, getattr(args, "scope", "user"),
                _subagent_registry(), getattr(args, "copy_from", None))
        except ValueError as e:
            result = {"ok": False, "error": str(e)}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result.get("ok"):
        sys.exit(1)


def cmd_subagent_unlink(args):
    """Remove the link sidecar entry; native files untouched."""
    import subagent_links

    with data_home_lock():
        try:
            result = subagent_links.unlink_agents(args.name, getattr(args, "scope", "user"))
        except ValueError as e:
            result = {"ok": False, "error": str(e)}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result.get("ok"):
        sys.exit(1)


def cmd_subagent_link_status(args):
    """Links (with twin-lost + drift) and same-name suggestions for a scope."""
    import subagent_links

    try:
        result = subagent_links.link_status(getattr(args, "scope", "user"),
                                            _subagent_registry())
    except ValueError as e:
        fail(str(e))
        return
    print(json.dumps(result, indent=2, ensure_ascii=False))


def cmd_subagent_resolve_drift(args):
    """Resolve linked-twin drift per field. Decisions JSON on stdin:
    {"decisions": {"description": "codex", ...}} — winner harness id per field."""
    import subagent_links

    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False,
                          "error": f"invalid JSON payload on stdin: {e}"}))
        sys.exit(1)
    decisions = payload.get("decisions") if isinstance(payload, dict) else None
    if not isinstance(decisions, dict) or not decisions:
        print(json.dumps({"ok": False,
                          "error": "payload must be an object with a non-empty 'decisions' object"}))
        sys.exit(1)
    with data_home_lock():
        try:
            result = subagent_links.resolve_drift(
                args.name, getattr(args, "scope", "user"),
                _subagent_registry(), decisions)
        except ValueError as e:
            result = {"ok": False, "error": str(e)}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result.get("ok"):
        sys.exit(1)


def _provision_project_skill(
    proj_cfg: dict, registry: dict, skill_name: str, installed: set[str]
) -> None:
    """Targeted resync of ONE skill for ONE project: symlink its source into each
    effective harness's project_skills_dir (honoring the skill's `harnesses:`
    affinity). Mirrors the per-skill inner loop of `_sync_project_skills` without
    touching any other skill or running cleanup — so it never disturbs unrelated
    links. No-op if the source is missing."""
    import harnesses as _harnesses

    skills = registry.get("skills", {})
    cfg = skills[skill_name]
    src = skill_source(cfg)
    if not src.exists():
        return
    proj_path = expand(proj_cfg["path"])
    effective = _harnesses.resolve_effective(proj_cfg, registry, installed=installed)
    affinity = _skill_affinity(cfg)
    targets = effective & affinity if affinity is not None else effective
    target_dirs: set[Path] = set()
    for h_id in targets:
        h = _harnesses.HARNESSES[h_id]
        target_dirs.add(proj_path / Path(str(h.project_skills_dir)))
    for target_dir in target_dirs:
        if target_dir.is_symlink():
            target_dir.unlink()
            target_dir.mkdir(parents=True, exist_ok=True)
        link = target_dir / skill_name
        ensure_symlink(link, src)


def _provision_skill(
    skill_name: str, project: Optional[str], is_global: bool,
    harness_id: str, widen: bool,
) -> dict:
    """Two-phase provisioning (design D5). Runs a TARGETED sync — never bare
    cmd_sync. All guards run BEFORE any mutation; the human sync log is redirected
    to stderr so the caller's JSON stays clean on stdout. Returns
    {ok, skill, mode, path, widened_affinity} or {ok:false, error, ...}."""
    import contextlib
    import harnesses as _harnesses

    h = _harnesses.HARNESSES.get(harness_id)
    if h is None:
        return {"ok": False, "error": f"unknown harness '{harness_id}'"}
    if h.agents_dir is None:
        return {"ok": False,
                "error": f"harness '{harness_id}' does not support sub-agent definitions"}

    with data_home_lock():
        registry = load_registry()
        skills = registry.get("skills", {})
        projects = registry.get("projects", {})

        cfg = skills.get(skill_name)
        if cfg is None:
            return {"ok": False,
                    "error": f"unknown skill '{skill_name}' (not in the registry)"}

        # Guard 1 — remote quarantine (hard refuse; no override in this change).
        origin = str(cfg.get("origin") or "")
        if origin.startswith("remote:"):
            remote_id = origin[len("remote:"):] or "?"
            return {"ok": False,
                    "error": (
                        f"skill '{skill_name}' is quarantined (imported from remote "
                        f"'{remote_id}'). Remote-origin skills are held project-specific "
                        f"by design and cannot be provisioned global/project — no override.")}

        if is_global == bool(project):
            return {"ok": False,
                    "error": "provision-skill requires exactly one of --global or --project"}

        # Guard 2 — affinity: a `harnesses:` restriction excluding this agent's
        # harness would make the global/project link dangle. Clear it with
        # --widen-affinity, else refuse.
        affinity = _skill_affinity(cfg)
        # Snapshot everything the command may mutate so a failed verification
        # rolls the registry back — provisioning must never persist a
        # half-applied state (a stuck `scope: global` would fan the skill out
        # to every harness on all later syncs; a stuck `enabled` entry and a
        # cleared affinity likewise outlive the reported failure).
        prev_affinity = cfg.get("harnesses")
        prev_scope = cfg.get("scope")
        widened = False
        if affinity is not None and harness_id not in affinity:
            if not widen:
                return {"ok": False,
                        "error": (
                            f"skill '{skill_name}' is restricted to harnesses "
                            f"{sorted(affinity)}, which excludes '{harness_id}'; the "
                            f"provisioned link would dangle. Pass --widen-affinity to "
                            f"clear the restriction."),
                        "affinity": sorted(affinity),
                        "widen_available": True}
            cfg.pop("harnesses", None)  # clear the narrowing entirely
            widened = True

        installed = _harnesses.detect_installed()

        def _rollback():
            if prev_affinity is not None:
                cfg["harnesses"] = prev_affinity
            else:
                cfg.pop("harnesses", None)
            if prev_scope is not None:
                cfg["scope"] = prev_scope
            else:
                cfg.pop("scope", None)

        if project is not None:
            pcfg = projects.get(project)
            if pcfg is None:
                return {"ok": False, "error": f"unknown project '{project}'"}
            prev_enabled = list(pcfg.get("enabled") or [])
            enabled = list(prev_enabled)
            if skill_name not in enabled:
                enabled.append(skill_name)
                pcfg["enabled"] = enabled
            save_registry(registry)
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    _provision_project_skill(pcfg, registry, skill_name, installed)
            except Exception as e:
                _rollback()
                pcfg["enabled"] = prev_enabled
                save_registry(registry)
                return {"ok": False,
                        "error": (f"provisioning failed for '{skill_name}': {e}. "
                                  f"No registry changes were kept.")}
            proj_path = expand(pcfg["path"])
            expected = proj_path / Path(str(h.project_skills_dir)) / skill_name / "SKILL.md"
            if not expected.exists():
                _rollback()
                pcfg["enabled"] = prev_enabled
                save_registry(registry)
                # Sweep links this failed attempt DID create for other
                # (effective) harness dirs of the project — symmetric with the
                # global-path rollback sweep.
                for hh in _harnesses.HARNESSES.values():
                    link = proj_path / Path(str(hh.project_skills_dir)) / skill_name
                    try:
                        if link.is_symlink():
                            link.unlink()
                    except OSError:
                        pass
                return {"ok": False,
                        "error": (
                            f"provisioning did not resolve '{skill_name}' for project "
                            f"'{project}' on harness '{harness_id}' (expected {expected}). "
                            f"Is '{harness_id}' effective for the project? "
                            f"No registry changes were kept.")}
            return {"ok": True, "skill": skill_name, "mode": "project-enable",
                    "path": str(expected), "widened_affinity": widened}

        # Global path: flip scope, re-run ONLY the global-skills pass.
        cfg["scope"] = "global"
        save_registry(registry)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                _sync_global_skills(registry, installed)
        except Exception as e:
            _rollback()
            save_registry(registry)
            return {"ok": False,
                    "error": (f"provisioning failed for '{skill_name}': {e}. "
                              f"No registry changes were kept.")}
        expected = Path(str(h.global_skills_dir)).expanduser() / skill_name / "SKILL.md"
        if not expected.exists():
            _rollback()
            save_registry(registry)
            # Sweep any links the failed attempt DID create in other harness
            # global dirs: re-running the pass against the restored registry
            # removes them (the skill is no longer scope: global).
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    _sync_global_skills(registry, installed)
            except Exception:
                pass  # the next `hub sync` performs the same cleanup
            return {"ok": False,
                    "error": (
                        f"provisioning did not resolve '{skill_name}' at {expected} for "
                        f"harness '{harness_id}' (is it installed / admitted by affinity?). "
                        f"No registry changes were kept.")}
        return {"ok": True, "skill": skill_name, "mode": "make-global",
                "path": str(expected), "widened_affinity": widened}


def cmd_subagent_provision_skill(args):
    """Provision an attached skill so a sub-agent's `skills:` reference resolves
    (design D5, phase 2). Project path enables + resyncs the skill for the
    project; global path flips scope to global + re-runs the global-skills pass."""
    skill = args.skill
    project = getattr(args, "project", None)
    is_global = bool(getattr(args, "global_scope", False))
    harness = getattr(args, "harness", None) or "claude-code"
    widen = bool(getattr(args, "widen_affinity", False))
    result = _provision_skill(skill, project, is_global, harness, widen)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result.get("ok"):
        sys.exit(1)


# ─────────────────────────────────────────────────────────────────────────────
# CLI entry point
# ─────────────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        prog="hub",
        description="Skill Hub — central skill registry and project linker",
    )
    sub = parser.add_subparsers(dest="command")

    # list
    p_list = sub.add_parser("list", help="List all skills and their status")
    p_list.add_argument("--project", "-p", help="Filter by project name")

    # enable
    p_enable = sub.add_parser("enable", help="Enable a skill for a project")
    p_enable.add_argument("skill", help="Skill name")
    p_enable.add_argument(
        "--project", "-p", help="Project name (required for non-global skills)"
    )

    # disable
    p_disable = sub.add_parser("disable", help="Disable a skill for a project")
    p_disable.add_argument("skill", help="Skill name")
    p_disable.add_argument("--project", "-p", required=True, help="Project name")

    # sync
    p_sync = sub.add_parser(
        "sync", help="Rebuild all symlinks and MCP configs from registry"
    )
    p_sync.add_argument(
        "--skip-permissions",
        action="store_true",
        help="Bypass the permissions stream and doctor rollup",
    )
    p_sync.add_argument(
        "--skip-remotes",
        action="store_true",
        help="Bypass the remote connector dispatch pass",
    )
    p_sync.add_argument(
        "--strict-remotes",
        action="store_true",
        help="Exit non-zero on an ALARMING remote failure (auth / host-key mismatch "
        "/ integrity); unreachable remotes stay quiet (L1, mirrors the perms doctor)",
    )

    # new
    p_new = sub.add_parser("new", help="Scaffold a new skill or MCP server")
    p_new.add_argument("kind", choices=["skill", "mcp"], help="Type to create")
    p_new.add_argument("name", help="Name for the new skill/mcp")
    p_new.add_argument("--scope", choices=sorted(VALID_SCOPES), help="Initial scope")
    p_new.add_argument("--description", help="Initial description")
    p_new.add_argument(
        "--type",
        choices=["claude-skill", "mcp-server"],
        help="Accepted for UI compatibility; inferred from kind",
    )

    # migrate
    p_migrate = sub.add_parser(
        "migrate", help="Move an existing skill into the hub's skills/ dir"
    )
    p_migrate.add_argument("skill", help="Skill name to migrate")

    # project
    p_proj = sub.add_parser("project", help="Manage projects")
    proj_sub = p_proj.add_subparsers(dest="project_cmd")
    p_proj_add = proj_sub.add_parser("add", help="Register a new project")
    p_proj_add.add_argument("name", help="Project name")
    p_proj_add.add_argument("path", help="Absolute path to project")
    p_proj_remove = proj_sub.add_parser(
        "remove", help="Remove a registered project (cleans hub-owned artifacts)"
    )
    p_proj_remove.add_argument("name", help="Project name")
    p_proj_remove.add_argument(
        "--dry-run", action="store_true", help="Print the removal plan without applying"
    )
    p_proj_remove.add_argument(
        "--json", action="store_true", help="Emit dry-run plan as JSON"
    )
    p_proj_edit = proj_sub.add_parser(
        "edit-path", help="Change a registered project's filesystem location"
    )
    p_proj_edit.add_argument("name", help="Project name")
    p_proj_edit.add_argument("new_path", help="New absolute path")
    p_proj_h = proj_sub.add_parser(
        "harnesses",
        help="Show or mutate a project's harness list",
    )
    p_proj_h.add_argument("name", help="Project name")
    p_proj_h.add_argument("--add", help="Comma-separated harness ids to add")
    p_proj_h.add_argument("--remove", help="Comma-separated harness ids to remove")
    p_proj_inv = proj_sub.add_parser(
        "invocation",
        help="Show or set per-skill invocation overrides for a project",
    )
    p_proj_inv.add_argument("name", help="Project name")
    p_proj_inv.add_argument("--skill", help="Skill to override")
    p_proj_inv.add_argument(
        "--mode",
        choices=list(PROJECT_INVOCATION_MODES),
        help="Override mode (inherit clears the override)",
    )
    p_proj_inv.add_argument("--json", action="store_true", help="Emit JSON")
    p_proj_docs = proj_sub.add_parser(
        "agent-docs", help="Show Agent Docs preferences (read-only)"
    )
    p_proj_docs.add_argument("name", help="Project name")

    p_proj_import = proj_sub.add_parser(
        "import-skill",
        help="Adopt a hand-authored project-local skill into the hub",
    )
    p_proj_import.add_argument(
        "name", help="Skill name (its SKILL.md `name:`) to import"
    )
    p_proj_import.add_argument(
        "--project", required=True, help="Project the skill currently lives in"
    )

    p_proj_scan = proj_sub.add_parser(
        "scan-skills",
        help="List hand-authored project-local skills not yet adopted (read-only)",
    )
    p_proj_scan.add_argument(
        "--project", help="Limit to one registered project by name"
    )
    p_proj_scan.add_argument("--json", action="store_true", help="Emit JSON list")

    # agent-docs (top-level): canonical root strategy + migration
    p_ad = sub.add_parser(
        "agent-docs", help="Agent Docs root strategy and canonical migration"
    )
    ad_sub = p_ad.add_subparsers(dest="agent_docs_cmd")
    p_ad_strat = ad_sub.add_parser(
        "strategy", help="Get or set the root-derivation strategy (symlink|import)"
    )
    p_ad_strat.add_argument(
        "--get", action="store_true", help="Print the resolved strategy"
    )
    p_ad_strat.add_argument(
        "--set",
        dest="set_value",
        choices=["symlink", "import"],
        help="Set the strategy (global, or per-project with --project)",
    )
    p_ad_strat.add_argument(
        "--project", help="Target a project's override instead of the global value"
    )
    p_ad_strat.add_argument(
        "--clear",
        action="store_true",
        help="Clear a per-project override (requires --project)",
    )
    p_ad_strat.add_argument("--json", action="store_true", help="Emit JSON")
    for alias in ("fix", "migrate"):
        p_ad_fix = ad_sub.add_parser(
            alias,
            help=(
                "Transactional canonical-layout fix: root promotion/derivation, "
                "opt-in nested promotions, legacy AGENT.md cleanup"
                + (" (alias of fix)" if alias == "migrate" else "")
            ),
        )
        p_ad_fix.add_argument("--project", help="Limit to one project by name")
        p_ad_fix.add_argument(
            "--path", help="Limit to one project by absolute filesystem path"
        )
        p_ad_fix.add_argument(
            "--apply", action="store_true", help="Apply changes (default: dry-run)"
        )
        p_ad_fix.add_argument(
            "--nested",
            help="Opt-in nested promotions: 'all', 'none' (default), or comma-separated dirs",
        )
        p_ad_fix.add_argument(
            "--rename-legacy",
            action="store_true",
            help="Also rename user-authored AGENT.md files to AGENTS.md where the "
            "directory has no other instruction file (backup-first, content preserved)",
        )
        p_ad_fix.add_argument(
            "--commit",
            action="store_true",
            help="After a successful apply, git-commit ONLY the touched files with a "
            "prepared message (opt-in; never pushes; skipped outside a git repo)",
        )
        p_ad_fix.add_argument(
            "--plan-stdin",
            action="store_true",
            help="Apply a previously previewed plan read as JSON from stdin "
            "(requires --apply and a single project; preconditions are re-verified)",
        )
        p_ad_fix.add_argument("--json", action="store_true", help="Emit JSON")
    p_ad_res = ad_sub.add_parser(
        "resolve", help="Resolve a divergent or appended root pair (never merges)"
    )
    p_ad_res.add_argument("--project", help="Project name")
    p_ad_res.add_argument("--path", help="Project by absolute filesystem path")
    p_ad_res.add_argument(
        "--dir", default="", help="Instruction directory relative to the root ('' = root)"
    )
    p_ad_res.add_argument(
        "--op",
        required=True,
        choices=["keep_agents", "keep_claude", "absorb_appendix"],
        help="Resolution operation",
    )
    p_ad_res.add_argument(
        "--commit",
        action="store_true",
        help="After a successful resolution, git-commit ONLY the touched files "
        "with a prepared message (opt-in; never pushes)",
    )
    p_ad_res.add_argument("--json", action="store_true", help="Emit JSON")
    p_ad_status = ad_sub.add_parser(
        "status",
        help="Read-only canonical-root status (the same data sync's detection pass uses)",
    )
    p_ad_status.add_argument("--project", help="Limit to one project by name")
    p_ad_status.add_argument(
        "--path", help="Limit to one project by absolute filesystem path"
    )
    p_ad_status.add_argument("--json", action="store_true", help="Emit JSON")

    # snippet: reusable agent-doc instruction blocks
    p_snip = sub.add_parser(
        "snippet", help="Reusable agent-doc instruction blocks (apply/remove on doc files)"
    )
    snip_sub = p_snip.add_subparsers(dest="snippet_cmd")
    p_snip_list = snip_sub.add_parser("list", help="List snippets with usage roll-ups")
    p_snip_list.add_argument("--tag", help="Filter by tag")
    p_snip_list.add_argument("--query", help="Match name/description/body (case-insensitive)")
    p_snip_list.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_show = snip_sub.add_parser("show", help="Show one snippet incl. applied locations")
    p_snip_show.add_argument("name", help="Snippet name")
    p_snip_show.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_new = snip_sub.add_parser("new", help="Create a snippet")
    p_snip_new.add_argument("name", help="Kebab-case snippet name (immutable)")
    p_snip_new.add_argument("--description", help="One-line description")
    p_snip_new.add_argument("--tags", help="Comma-separated tags")
    p_snip_new.add_argument("--body", help="Markdown body ('-' reads stdin)")
    p_snip_new.add_argument("--body-file", help="Read the body from a file")
    p_snip_new.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_edit = snip_sub.add_parser("edit", help="Patch description/tags/body (body change bumps version)")
    p_snip_edit.add_argument("name", help="Snippet name")
    p_snip_edit.add_argument("--description", help="New description")
    p_snip_edit.add_argument("--tags", help="Comma-separated tags (replaces; empty string clears)")
    p_snip_edit.add_argument("--body", help="New markdown body ('-' reads stdin)")
    p_snip_edit.add_argument("--body-file", help="Read the new body from a file")
    p_snip_edit.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_del = snip_sub.add_parser(
        "delete", help="Delete a snippet definition (scan-guarded while applied)"
    )
    p_snip_del.add_argument("name", help="Snippet name")
    p_snip_del.add_argument(
        "--force",
        action="store_true",
        help="Delete even while applied; in-file blocks remain and become orphaned",
    )
    p_snip_del.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_apply = snip_sub.add_parser(
        "apply", help="Append a snippet block to a project agent doc file"
    )
    p_snip_apply.add_argument("name", help="Snippet name")
    p_snip_apply.add_argument("--project", required=True, help="Registered project name")
    p_snip_apply.add_argument(
        "--file", help="Project-relative agent doc path (default: canonical root)"
    )
    p_snip_apply.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_remove = snip_sub.add_parser(
        "remove", help="Excise a snippet block from a project agent doc file"
    )
    p_snip_remove.add_argument("name", help="Snippet name")
    p_snip_remove.add_argument("--project", required=True, help="Registered project name")
    p_snip_remove.add_argument(
        "--file", help="Project-relative agent doc path (default: canonical root)"
    )
    p_snip_remove.add_argument(
        "--force", action="store_true", help="Remove even if the block was edited in-file"
    )
    p_snip_remove.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_update = snip_sub.add_parser(
        "update", help="Refresh applied block(s) to the current library body"
    )
    p_snip_update.add_argument("name", help="Snippet name")
    p_snip_update.add_argument("--project", help="Registered project name")
    p_snip_update.add_argument(
        "--file", help="Project-relative agent doc path (default: canonical root)"
    )
    p_snip_update.add_argument(
        "--all", action="store_true", help="Refresh every outdated location (skips modified)"
    )
    p_snip_update.add_argument(
        "--force", action="store_true", help="Update even if the block was edited in-file"
    )
    p_snip_update.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_status = snip_sub.add_parser(
        "status", help="Scan registered projects for snippet blocks (read-only)"
    )
    p_snip_status.add_argument("--name", help="Limit to one snippet")
    p_snip_status.add_argument("--project", help="Limit to one project")
    p_snip_status.add_argument("--json", action="store_true", help="Emit JSON")

    p_set_meta = sub.add_parser("set-meta", help="Update skill metadata in registry")
    p_set_meta.add_argument("name", help="Skill name")
    p_set_meta.add_argument("--version", help="Semver version")
    p_set_meta.add_argument("--description", help="Registry description")
    p_set_meta.add_argument("--scope", choices=sorted(VALID_SCOPES), help="Skill scope")
    p_set_meta.add_argument("--upstream", help="Upstream URL (empty string clears it)")
    p_set_meta.add_argument(
        "--harnesses",
        help="Comma-separated harness affinity (claude-code,codex,pi). Empty string clears it.",
    )
    p_set_meta.add_argument(
        "--invocation",
        choices=list(VALID_INVOCATIONS),
        help="Who may invoke the skill (rewrites SKILL.md frontmatter): "
        "auto = user + model, user-only = /name only (description not in "
        "context), model-only = hidden from the / menu.",
    )

    # archive
    p_archive = sub.add_parser(
        "archive", help="Archive a skill (removes from registry, moves files)"
    )
    p_archive.add_argument("skill", help="Skill name to archive")
    p_archive.add_argument(
        "--dry-run", action="store_true", help="Print the plan without applying"
    )

    # rename
    p_rename = sub.add_parser(
        "rename", help="Rename a skill (updates registry, files, symlinks)"
    )
    p_rename.add_argument("old_name", help="Current skill name")
    p_rename.add_argument("new_name", help="New skill name")
    p_rename.add_argument(
        "--dry-run", action="store_true", help="Print the plan without applying"
    )

    # bundle
    p_bundle = sub.add_parser("bundle", help="Manage skill bundles")
    bundle_sub = p_bundle.add_subparsers(dest="bundle_cmd")
    bundle_sub.add_parser("list", help="List all bundles")
    p_ba = bundle_sub.add_parser("apply", help="Assign a bundle to a project")
    p_ba.add_argument("bundle_name", help="Bundle name")
    p_ba.add_argument("--project", "-p", required=True, help="Project name")
    p_br = bundle_sub.add_parser(
        "remove", help="Remove a bundle assignment from a project"
    )
    p_br.add_argument("bundle_name", help="Bundle name")
    p_br.add_argument("--project", "-p", required=True, help="Project name")
    p_bn = bundle_sub.add_parser("new", help="Create a new bundle")
    p_bn.add_argument("bundle_name", help="Bundle name")
    p_bn.add_argument("--skills", required=True, help="Comma-separated skill names")
    p_bn.add_argument("--description", help="Bundle description")
    p_bn.add_argument("--icon", help="Bundle icon")
    p_bn.add_argument(
        "--scope", choices=sorted(VALID_BUNDLE_SCOPES), help="Bundle scope"
    )
    p_bu = bundle_sub.add_parser("update", help="Update an existing bundle")
    p_bu.add_argument("bundle_name", help="Bundle name")
    p_bu.add_argument("--skills", help="Comma-separated skill names")
    p_bu.add_argument("--description", help="Bundle description")
    p_bu.add_argument("--icon", help="Bundle icon")
    p_bu.add_argument(
        "--scope", choices=sorted(VALID_BUNDLE_SCOPES), help="Bundle scope"
    )
    p_bd = bundle_sub.add_parser(
        "delete", help="Delete a bundle (unassigns from all projects)"
    )
    p_bd.add_argument("bundle_name", help="Bundle name")
    p_bd.add_argument(
        "--dry-run", action="store_true", help="Print the plan without applying"
    )

    # dashboard
    p_dash = sub.add_parser("dashboard", help="Launch Skill Tree native app")
    p_dash.add_argument(
        "--dev", action="store_true", help="Launch in Vite HMR dev mode"
    )

    # app
    p_app = sub.add_parser("app", help="Skill Tree app development/build shortcuts")
    app_sub = p_app.add_subparsers(dest="app_cmd")
    app_sub.required = True
    app_sub.add_parser("dev", help="Run Skill Tree in Tauri dev mode")
    p_app_build = app_sub.add_parser(
        "build", help="Build the production Skill Tree app"
    )
    p_app_build.add_argument(
        "--install",
        action="store_true",
        help="On macOS, copy the built app to /Applications",
    )
    p_app_build.add_argument(
        "--no-updater",
        action="store_true",
        help="Skip signed updater artifacts (auto-skipped when "
        "TAURI_SIGNING_PRIVATE_KEY is unset; use for local installs)",
    )

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

    # cleanup-backups
    sub.add_parser(
        "cleanup-backups",
        help="Delete hub-created backup artifacts outside managed skill dirs",
    )

    # bootstrap
    p_boot = sub.add_parser(
        "bootstrap",
        help="Initialize data home, optionally import global skills (first-run wizard)",
    )
    p_boot.add_argument(
        "--force", action="store_true", help="Re-run even if already bootstrapped"
    )
    p_boot.add_argument(
        "--yes", action="store_true", help="Accept defaults (no prompts)"
    )
    p_boot.add_argument(
        "--dry-run", action="store_true", help="Print plan without writing"
    )
    p_boot.add_argument("--json", action="store_true", help="Emit dry-run as JSON")
    p_boot.add_argument(
        "--skip-migrate",
        action="store_true",
        help="Do not auto-migrate legacy data home",
    )

    # migrate-home
    p_mh = sub.add_parser(
        "migrate-home", help="Move data from legacy ~/Dev/.skill-hub/ to ~/.skill-hub/"
    )
    p_mh.add_argument("--yes", action="store_true", help="Skip confirmation prompt")

    # harnesses (Rust-mirror emission + future read commands)
    p_harn = sub.add_parser(
        "harnesses",
        help="Inspect the harness registry (claude-code, codex, pi, opencode)",
    )
    harn_sub = p_harn.add_subparsers(dest="harnesses_cmd")
    harn_sub.add_parser(
        "emit-schema",
        help="Print the harness registry as JSON (consumed by app build.rs)",
    )

    # `hub harness ...` — top-level alias for the CLI surface in the spec
    p_harness = sub.add_parser(
        "harness",
        help="Manage harnesses (claude-code, codex, pi, opencode)",
    )
    harness_sub = p_harness.add_subparsers(dest="harness_cmd")
    p_hl = harness_sub.add_parser("list", help="List harnesses with status")
    p_hl.add_argument(
        "--json", action="store_true", help="Emit JSON instead of a table"
    )
    p_he = harness_sub.add_parser("enable", help="Add a harness to harnesses_global")
    p_he.add_argument("id", help="Harness id (claude-code | codex | pi | opencode)")
    p_hd = harness_sub.add_parser(
        "disable", help="Remove a harness from harnesses_global"
    )
    p_hd.add_argument("id", help="Harness id (claude-code | codex | pi | opencode)")

    # subagent — manage sub-agents in place (claude-subagents-manager +
    # cross-harness-subagents: claude-code .md and codex .toml)
    p_sa = sub.add_parser("subagent", help="Manage sub-agents in place (claude-code, codex)")
    sa_sub = p_sa.add_subparsers(dest="subagent_cmd")

    def _add_scope_args(p, require_name=False):
        p.add_argument("--scope", choices=["user", "project"], default="user",
                       help="user (~/.claude/agents) or project (<path>/.claude/agents)")
        p.add_argument("--project", help="project name (required for --scope project)")
        p.add_argument("--harness", default="claude-code",
                       help="harness id (claude-code | codex; default claude-code)")
        if require_name:
            p.add_argument("--name", required=True, help="agent name (the `name:` field)")
        p.add_argument("--json", action="store_true", help="Emit JSON (always JSON for subagent)")

    p_sa_list = sa_sub.add_parser("list", help="List sub-agents in a scope")
    _add_scope_args(p_sa_list)

    p_sa_show = sa_sub.add_parser("show", help="Show one sub-agent (safe+advanced+body)")
    _add_scope_args(p_sa_show, require_name=True)

    p_sa_save = sa_sub.add_parser("save", help="Save a sub-agent (JSON payload on stdin)")
    p_sa_save.add_argument("--json", action="store_true", help="Emit JSON")

    p_sa_del = sa_sub.add_parser("delete", help="Delete a sub-agent (backup + strip deny)")
    _add_scope_args(p_sa_del, require_name=True)
    p_sa_del.add_argument("--link-action", dest="link_action",
                          choices=["this", "both"], default="this",
                          help="linked agents: delete only this harness's file "
                               "(unlink the pair) or both twins (default: this)")

    p_sa_dis = sa_sub.add_parser("set-disabled", help="Toggle Agent(<name>) deny entry")
    _add_scope_args(p_sa_dis, require_name=True)
    p_sa_dis.add_argument("--disabled", required=True, choices=["true", "false"],
                          help="true to disable, false to enable")

    p_sa_usage = sa_sub.add_parser("skill-usage", help="Reverse index skill → sub-agents")
    p_sa_usage.add_argument("--json", action="store_true", help="Emit JSON")

    p_sa_attach = sa_sub.add_parser(
        "attachable-skills",
        help="List registry/on-disk skills with attachability for the picker")
    _add_scope_args(p_sa_attach)

    p_sa_link = sa_sub.add_parser(
        "link", help="Link the same-named agent across harnesses (linked twins)")
    p_sa_link.add_argument("--name", required=True, help="agent name (link identity)")
    p_sa_link.add_argument("--scope", choices=["user"], default="user",
                           help="user scope only in this release")
    p_sa_link.add_argument("--harnesses",
                           help="comma-separated harness ids (default: all agent-capable)")
    p_sa_link.add_argument("--copy-from", dest="copy_from",
                           help="when the agent is missing in a harness, project the "
                                "shared core from this harness (model not carried)")
    p_sa_link.add_argument("--json", action="store_true", help="Emit JSON (always JSON)")

    p_sa_unlink = sa_sub.add_parser(
        "unlink", help="Remove the link sidecar entry (files untouched)")
    p_sa_unlink.add_argument("--name", required=True, help="agent name")
    p_sa_unlink.add_argument("--scope", choices=["user"], default="user",
                             help="user scope only in this release")
    p_sa_unlink.add_argument("--json", action="store_true", help="Emit JSON (always JSON)")

    p_sa_lstatus = sa_sub.add_parser(
        "link-status", help="Links (twin-lost + drift) and same-name suggestions")
    p_sa_lstatus.add_argument("--scope", choices=["user"], default="user",
                              help="user scope only in this release")
    p_sa_lstatus.add_argument("--json", action="store_true", help="Emit JSON (always JSON)")

    p_sa_resolve = sa_sub.add_parser(
        "resolve-drift",
        help="Resolve linked-twin drift per field (decisions JSON on stdin)")
    p_sa_resolve.add_argument("--name", required=True, help="agent name")
    p_sa_resolve.add_argument("--scope", choices=["user"], default="user",
                              help="user scope only in this release")
    p_sa_resolve.add_argument("--json", action="store_true", help="Emit JSON (always JSON)")

    p_sa_prov = sa_sub.add_parser(
        "provision-skill",
        help="Provision an attached skill so an agent's skills: reference resolves")
    p_sa_prov.add_argument("--skill", required=True, help="skill name to provision")
    p_sa_prov_scope = p_sa_prov.add_mutually_exclusive_group(required=True)
    p_sa_prov_scope.add_argument(
        "--global", dest="global_scope", action="store_true",
        help="make the skill global (scope: global; every installed harness)")
    p_sa_prov_scope.add_argument(
        "--project", dest="project",
        help="enable + resync the skill for this project")
    p_sa_prov.add_argument("--harness", default="claude-code",
                           help="the agent's harness (affinity + verify target; "
                                "default claude-code)")
    p_sa_prov.add_argument("--widen-affinity", dest="widen_affinity",
                           action="store_true",
                           help="clear a harnesses: restriction that excludes --harness")
    p_sa_prov.add_argument("--json", action="store_true", help="Emit JSON (always JSON)")

    # remote — manage remote connector targets (Hermes, etc.)
    p_remote = sub.add_parser("remote", help="Manage remote connector targets")
    remote_sub = p_remote.add_subparsers(dest="remote_cmd")

    p_remote_list = remote_sub.add_parser("list", help="List configured remotes")
    p_remote_list.add_argument(
        "--json", action="store_true", help="Emit JSON instead of a table"
    )

    p_remote_connectors = remote_sub.add_parser(
        "connectors",
        help="List registered connectors + metadata (key/label/transport/source)",
    )
    p_remote_connectors.add_argument(
        "--json", action="store_true", help="Emit JSON instead of a table"
    )

    p_remote_add = remote_sub.add_parser(
        "add", help="Register a remote (references only; no secrets in the registry)"
    )
    p_remote_add.add_argument("id", help="Remote id (registry key under remotes:)")
    p_remote_add.add_argument(
        "--connector", default="hermes", help="Connector key (default: hermes)"
    )
    p_remote_add.add_argument("--ssh-host", help="SSH host/alias (e.g. hermes@moon-base)")
    p_remote_add.add_argument(
        "--endpoint",
        help="HTTPS MCP endpoint URL (for the goalrunner-orchestrator connector). "
        "Stored as transport.endpoint; the connector talks JSON-RPC over it.",
    )
    p_remote_add.add_argument(
        "--token-ref",
        dest="token_ref",
        help="Keychain handle for the bearer token (HTTP/MCP connectors). With "
        "--token / stdin, the provided token is stored under this handle; the "
        "registry holds ONLY the ref. Sets secret_ref.",
    )
    p_remote_add.add_argument(
        "--token",
        help="Bearer token VALUE to store under --token-ref in the OS keychain "
        "(prefer stdin: omit to read one line from stdin). Never persisted in "
        "the registry.",
    )
    p_remote_add.add_argument(
        "--host-key", dest="host_key", action="append",
        help="Pinned TOFU host-key fingerprint (SHA256:...). Repeat or "
        "comma-separate to pin BOTH the ed25519 AND rsa keys (H2.3 multi-key).",
    )
    p_remote_add.add_argument("--secret-ref", dest="secret_ref", help="Keychain handle")
    p_remote_add.add_argument("--home", help="Remote home dir (connector default if omitted)")
    p_remote_add_sync = p_remote_add.add_mutually_exclusive_group()
    p_remote_add_sync.add_argument(
        "--no-sync", action="store_true",
        help="Register with sync_enabled=false (the default for custom/root-transport "
        "connectors like codex-workers, so a UI toggle can't trigger a privileged push)",
    )
    p_remote_add_sync.add_argument(
        "--sync", action="store_true",
        help="Force sync_enabled=true (override the custom/root-transport default-off)",
    )
    p_remote_add_global = p_remote_add.add_mutually_exclusive_group()
    p_remote_add_global.add_argument(
        "--apply-global", dest="apply_global", action="store_true",
        help="Opt this remote into inheriting global-scope bundle skills (D15). "
        "Default OFF: a remote inherits NO global bundle unless this is set. Its "
        "own --bundles/--enabled always apply regardless.",
    )
    p_remote_add_global.add_argument(
        "--no-apply-global", dest="apply_global", action="store_false",
        help="Explicitly do NOT inherit global-scope bundle skills (the default).",
    )
    p_remote_add.set_defaults(apply_global=False)
    p_remote_add.add_argument(
        "--bundles", help="Comma-separated bundles to equip"
    )
    p_remote_add.add_argument(
        "--enabled", help="Comma-separated individual skills to equip"
    )

    p_remote_show = remote_sub.add_parser("show", help="Show one remote's config + resolved skills")
    p_remote_show.add_argument("id", help="Remote id")
    p_remote_show.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_diff = remote_sub.add_parser(
        "diff", help="Read-only plan: per-artifact drift status (no writes)"
    )
    p_remote_diff.add_argument("id", help="Remote id")
    p_remote_diff.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_sync = remote_sub.add_parser("sync", help="Sync one remote now")
    p_remote_sync.add_argument("id", help="Remote id")
    p_remote_sync.add_argument(
        "--force", action="store_true", help="Run even if sync_enabled is false"
    )
    p_remote_sync.add_argument(
        "--strict", action="store_true",
        help="Exit non-zero on an ALARMING failure (auth / host-key mismatch / "
        "integrity); unreachable stays quiet (L1)",
    )

    p_remote_resolve = remote_sub.add_parser(
        "resolve", help="Explicitly resolve a drifted/conflicting artifact"
    )
    p_remote_resolve.add_argument("id", help="Remote id")
    p_remote_resolve.add_argument(
        "--artifact", required=True, help="Artifact name/ref to resolve"
    )
    p_remote_resolve.add_argument(
        "--op",
        required=True,
        choices=["push", "pull", "keep-local", "keep-remote"],
        help="Resolution operation",
    )
    p_remote_resolve.add_argument(
        "--kind", default="skill", choices=["skill", "mcp", "agent_doc"],
        help="Artifact kind (default: skill)",
    )
    p_remote_resolve.add_argument(
        "--yes", action="store_true",
        help="Skip the confirm-on-pull prompt (headless adoption of remote content)",
    )

    p_remote_disable = remote_sub.add_parser("disable", help="Set sync_enabled=false")
    p_remote_disable.add_argument("id", help="Remote id")
    p_remote_disable.add_argument(
        "--revoke-key", dest="revoke_key", action="store_true",
        help="Also revoke the hub's installed authorized_keys line on the box (H2.1)",
    )
    p_remote_disable.add_argument(
        "--yes", action="store_true", help="Skip the revoke confirm (headless)"
    )

    p_remote_enable = remote_sub.add_parser("enable", help="Set sync_enabled=true")
    p_remote_enable.add_argument("id", help="Remote id")

    p_remote_set_global = remote_sub.add_parser(
        "set-global",
        help="Toggle apply_global_bundles (inherit global-scope bundle skills)",
    )
    p_remote_set_global.add_argument("id", help="Remote id")
    p_remote_set_global.add_argument(
        "state", nargs="?", choices=["on", "off"],
        help="on = inherit global bundles; off = don't (default)",
    )
    p_remote_set_global.add_argument(
        "--apply-global", dest="apply_global", choices=["on", "off"],
        help="Alternative to the positional on|off",
    )

    p_remote_equip = remote_sub.add_parser(
        "equip",
        help="Add/remove a bundle or skill on a remote (registry-only; no box push)",
    )
    p_remote_equip.add_argument("id", help="Remote id")
    p_remote_equip.add_argument(
        "--kind", required=True, choices=["bundle", "skill"],
        help="Whether <name> is a bundle or an individual skill",
    )
    p_remote_equip.add_argument(
        "--name", required=True, help="Bundle or skill name to toggle",
    )
    p_remote_equip.add_argument(
        "--state", required=True, choices=["on", "off"],
        help="on = equip; off = unequip",
    )
    p_remote_equip.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_remove = remote_sub.add_parser(
        "remove", help="Unregister a remote (drops the registry entry + sidecars)"
    )
    p_remote_remove.add_argument("id", help="Remote id")
    p_remote_remove.add_argument(
        "--revoke-key", dest="revoke_key", action="store_true",
        help="Also revoke the hub's installed authorized_keys line on the box first (H2.1)",
    )
    p_remote_remove.add_argument(
        "--yes", action="store_true", help="Skip the revoke confirm (headless)"
    )

    p_remote_clear = remote_sub.add_parser(
        "clear", help="Forget hub ownership of a remote's artifacts (clears sidecars)"
    )
    p_remote_clear.add_argument("id", help="Remote id")

    p_remote_import = remote_sub.add_parser(
        "import-skill", help="Adopt a box-native skill into the hub with provenance"
    )
    p_remote_import.add_argument(
        "name", nargs="?", help="Skill name to import (omit with --scan)"
    )
    p_remote_import.add_argument("--remote", required=True, help="Remote id")
    p_remote_import.add_argument(
        "--scan", action="store_true", help="List import candidates instead of importing"
    )
    p_remote_import.add_argument("--json", action="store_true", help="Emit JSON (with --scan)")

    p_remote_keyscan = remote_sub.add_parser(
        "keyscan",
        help="Fetch a host's SHA256 host-key fingerprint for TOFU pinning",
    )
    p_remote_keyscan.add_argument(
        "ssh_host", metavar="ssh-host", help="SSH host/alias (e.g. hermes@moon-base)"
    )
    p_remote_keyscan.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_setup_key = remote_sub.add_parser(
        "setup-key",
        help="One-time ssh-copy-id of our pubkey to a remote (confirmed onboarding)",
    )
    p_remote_setup_key.add_argument(
        "id", nargs="?", help="Remote id (omit when using --ssh-host)"
    )
    p_remote_setup_key.add_argument(
        "--ssh-host",
        help="Raw SSH host/alias to install the key on (pre-registration; "
        "skips the registry lookup)",
    )
    p_remote_setup_key.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_setup_helper = remote_sub.add_parser(
        "setup-codex-helper",
        help="Stage the least-privilege codex-workers box helper install (C2; NOT executed)",
    )
    p_remote_setup_helper.add_argument(
        "id", nargs="?", help="Remote id (optional; only resolves the ssh host for the printed commands)"
    )
    p_remote_setup_helper.add_argument(
        "--init", action="store_true",
        help="Generate the dedicated restricted keypair if absent (idempotent)",
    )
    p_remote_setup_helper.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_list_docs = remote_sub.add_parser(
        "list-docs", help="List the LIVE agent docs present on the box (SOUL/MEMORY/USER)"
    )
    p_remote_list_docs.add_argument("id", help="Remote id")
    p_remote_list_docs.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_fetch_doc = remote_sub.add_parser(
        "fetch-doc", help="Fetch a remote agent-doc's content (SOUL.md/MEMORY.md/USER.md)"
    )
    p_remote_fetch_doc.add_argument("id", help="Remote id")
    p_remote_fetch_doc.add_argument(
        "--doc", required=True, choices=_REMOTE_DOC_NAMES, help="Which agent-doc"
    )
    p_remote_fetch_doc.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_push_doc = remote_sub.add_parser(
        "push-doc",
        help="Push an edited agent-doc back to the box (content on stdin; drift-checked)",
    )
    p_remote_push_doc.add_argument("id", help="Remote id")
    p_remote_push_doc.add_argument(
        "--doc", required=True, choices=_REMOTE_DOC_NAMES, help="Which agent-doc"
    )
    p_remote_push_doc.add_argument(
        "--force", action="store_true", help="Overwrite even if the remote drifted"
    )
    p_remote_push_doc.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_health = remote_sub.add_parser(
        "health", help="Report a remote's connection health (reachable/auth/host-key)"
    )
    p_remote_health.add_argument("id", help="Remote id")
    p_remote_health.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_doctor = remote_sub.add_parser(
        "doctor", help="Detect remote risks (host-key drift, stale sidecars, unreachable, unresolved drift)"
    )
    p_remote_doctor.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_signing = remote_sub.add_parser(
        "signing-key",
        help="Bootstrap (--init) or display (--show) the hub's pinned signing pubkey (C1)",
    )
    p_remote_signing.add_argument(
        "--init", action="store_true",
        help="Generate the hub signing keypair + pin its pubkey in the registry",
    )
    p_remote_signing.add_argument(
        "--show", action="store_true", help="Show the pinned signing pubkey (default)"
    )
    p_remote_signing.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_revoke = remote_sub.add_parser(
        "revoke-key",
        help="Surgically remove THIS connector's hub-installed authorized_keys line "
        "on the box (H2.1; inverse of the key install — idempotent)",
    )
    p_remote_revoke.add_argument("id", help="Remote id")
    p_remote_revoke.add_argument(
        "--yes", action="store_true", help="Skip the confirm prompt (headless)"
    )
    p_remote_revoke.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_repin = remote_sub.add_parser(
        "repin",
        help="Audited host-key rotation — re-pin a legitimately rotated host key "
        "(H2.2; shows OLD→NEW, re-seeds known_hosts, audit-logged)",
    )
    p_remote_repin.add_argument("id", help="Remote id")
    p_remote_repin.add_argument(
        "--accept", help="Pin this exact fingerprint (SHA256:...) instead of the live scan",
    )
    p_remote_repin.add_argument(
        "--yes", action="store_true", help="Accept the live-scanned key without prompting (headless)"
    )
    p_remote_repin.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_rotate = remote_sub.add_parser(
        "rotate-token",
        help="Rotate a connector's keychain token (H2.4; no-op for SSH connectors "
        "with no token — new token on stdin for a gateway connector)",
    )
    p_remote_rotate.add_argument("id", help="Remote id")
    p_remote_rotate.add_argument("--json", action="store_true", help="Emit JSON")

    # permissions
    p_perm = sub.add_parser("permissions", help="Manage agent permissions")
    perm_sub = p_perm.add_subparsers(dest="permissions_cmd")

    def _add_scope_args(p):
        g = p.add_mutually_exclusive_group(required=False)
        g.add_argument(
            "--global",
            dest="global_",
            action="store_true",
            help="Operate on permissions_global",
        )
        g.add_argument("--project", help="Operate on a project's permissions")

    def _add_personal_arg(p):
        p.add_argument(
            "--personal",
            action="store_true",
            help="Target the project's PERSONAL (uncommitted) permissions_local "
            "block instead of the committed permissions block (requires --project)",
        )

    p_perm_list = perm_sub.add_parser(
        "list", help="Summary of permissions across scopes"
    )
    p_perm_list.add_argument("--json", action="store_true")

    p_perm_show = perm_sub.add_parser("show", help="Show permissions for a scope")
    _add_scope_args(p_perm_show)
    _add_personal_arg(p_perm_show)
    p_perm_show.add_argument(
        "--effective",
        action="store_true",
        help="Show resolved (global+project) permissions for a project",
    )
    p_perm_show.add_argument("--json", action="store_true")

    p_perm_add = perm_sub.add_parser("add", help="Add a rule")
    _add_scope_args(p_perm_add)
    _add_personal_arg(p_perm_add)
    p_perm_add.add_argument("--kind", required=True, choices=["allow", "deny", "ask"])
    p_perm_add.add_argument("--pattern", required=True)
    p_perm_add.add_argument("--harnesses", help="CSV of harness ids; default = all")

    p_perm_remove = perm_sub.add_parser("remove", help="Remove a rule")
    _add_scope_args(p_perm_remove)
    _add_personal_arg(p_perm_remove)
    p_perm_remove.add_argument(
        "--kind", required=True, choices=["allow", "deny", "ask"]
    )
    p_perm_remove.add_argument("--pattern", required=True)

    p_perm_hooks = perm_sub.add_parser("hooks", help="Manage hooks")
    hooks_sub = p_perm_hooks.add_subparsers(dest="hooks_cmd")
    p_hooks_add = hooks_sub.add_parser("add", help="Add a hook")
    _add_scope_args(p_hooks_add)
    _add_personal_arg(p_hooks_add)
    p_hooks_add.add_argument("--event", required=True)
    p_hooks_add.add_argument("--matcher", required=True)
    p_hooks_add.add_argument("--command", required=True)
    p_hooks_add.add_argument("--harnesses", help="CSV of harness ids; default = all")
    p_hooks_remove = hooks_sub.add_parser("remove", help="Remove a hook")
    _add_scope_args(p_hooks_remove)
    _add_personal_arg(p_hooks_remove)
    p_hooks_remove.add_argument("--event", required=True)
    p_hooks_remove.add_argument("--matcher", required=True)
    p_hooks_remove.add_argument("--command", required=True)

    p_perm_adopt = perm_sub.add_parser(
        "adopt", help="Adopt pre-existing native permissions into the registry"
    )
    _add_scope_args(p_perm_adopt)
    p_perm_adopt.add_argument(
        "--action", required=True, choices=["import", "replace", "skip"]
    )
    p_perm_adopt.add_argument("--harness", help="Limit to a single harness id")

    p_perm_import = perm_sub.add_parser(
        "import",
        help="Discover + reconcile pre-existing native rules (cross-harness) and "
        "import/keep/drop them with MOVE semantics",
    )
    _add_scope_args(p_perm_import)
    p_perm_import.add_argument("--harness", help="Limit discovery to a single harness id")
    p_perm_import.add_argument(
        "--json", action="store_true", help="Emit the reconciled candidate set as JSON"
    )
    p_perm_import.add_argument(
        "--interactive",
        action="store_true",
        help="Prompt per-rule import/keep/drop on a TTY",
    )
    p_perm_import.add_argument(
        "--apply",
        action="store_true",
        help="Apply decisions read from --decisions-stdin (non-interactive)",
    )
    p_perm_import.add_argument(
        "--decisions-stdin",
        action="store_true",
        help="Read a {decisions:[...]} JSON payload from stdin (with --apply)",
    )

    p_perm_reconcile = perm_sub.add_parser(
        "reconcile",
        help="Unified ingest of pre-existing native rules (subsumes adopt+import): "
        "transactional + auto-syncing",
    )
    _add_scope_args(p_perm_reconcile)
    p_perm_reconcile.add_argument(
        "--harness", help="Limit discovery to a single harness id"
    )
    p_perm_reconcile.add_argument(
        "--json", action="store_true", help="Emit candidate set / apply result as JSON"
    )
    p_perm_reconcile.add_argument(
        "--apply", action="store_true",
        help="Apply decisions read from --decisions-stdin (transactional)",
    )
    p_perm_reconcile.add_argument(
        "--decisions-stdin", action="store_true",
        help="Read a {decisions:[...]} JSON payload from stdin (with --apply)",
    )

    p_perm_doctor = perm_sub.add_parser("doctor", help="Detect risks across all scopes")
    p_perm_doctor.add_argument("--json", action="store_true")

    p_perm_disable = perm_sub.add_parser(
        "disable", help="Disable hub-managed permissions for a scope"
    )
    p_perm_disable.add_argument("--mode", required=True, choices=["restore", "detach"])
    g_dis = p_perm_disable.add_mutually_exclusive_group()
    g_dis.add_argument("--all", action="store_true")
    g_dis.add_argument("--global", dest="global_", action="store_true")
    g_dis.add_argument("--project")
    p_perm_disable.add_argument("--harness", help="Limit to a single harness id")
    p_perm_disable.add_argument(
        "--apply", action="store_true", help="Commit changes (default is dry-run)"
    )
    p_perm_disable.add_argument(
        "--json", action="store_true", help="Emit structured entries as JSON"
    )

    p_perm_migrate_scope = perm_sub.add_parser(
        "migrate-scope",
        help="Strip global-sourced duplicate rules from project native files",
    )
    p_perm_migrate_scope.add_argument(
        "--apply", action="store_true", help="Commit changes (default is dry-run)"
    )
    p_perm_migrate_scope.add_argument(
        "--json", action="store_true", help="Emit structured plan as JSON"
    )

    # Add --json to existing adopt parser (declared above _add_scope_args block)
    p_perm_adopt.add_argument(
        "--json", action="store_true", help="Emit result payload as JSON"
    )

    p_perm_set = perm_sub.add_parser(
        "set", help="Atomic full-block replace of a scope's permissions"
    )
    _add_scope_args(p_perm_set)
    _add_personal_arg(p_perm_set)
    g_set = p_perm_set.add_mutually_exclusive_group(required=True)
    g_set.add_argument(
        "--stdin-json",
        dest="stdin_json",
        action="store_true",
        help="Read NormalizedPermissions JSON payload from stdin",
    )
    g_set.add_argument(
        "--json-file",
        dest="json_file",
        help="Read NormalizedPermissions JSON payload from a file path",
    )

    p_perm_validate = perm_sub.add_parser(
        "validate", help="Validate a (kind, pattern) pair across installed adapters"
    )
    p_perm_validate.add_argument(
        "--kind", required=True, choices=["allow", "deny", "ask"]
    )
    p_perm_validate.add_argument("--pattern", required=True)
    p_perm_validate.add_argument("--json", action="store_true")

    p_perm_capabilities = perm_sub.add_parser(
        "capabilities", help="List PermissionFeature support per installed harness"
    )
    p_perm_capabilities.add_argument("--json", action="store_true")

    # permissions presets
    p_perm_presets = perm_sub.add_parser(
        "presets", help="Manage permission presets (built-in + user-defined)"
    )
    presets_sub = p_perm_presets.add_subparsers(dest="presets_cmd")

    p_presets_list = presets_sub.add_parser(
        "list", help="List built-in and user-defined presets"
    )
    p_presets_list.add_argument("--json", action="store_true")

    p_presets_show = presets_sub.add_parser(
        "show", help="Show all rules in a preset"
    )
    p_presets_show.add_argument("id", help="Preset id")
    p_presets_show.add_argument("--json", action="store_true")

    p_presets_apply = presets_sub.add_parser(
        "apply", help="Stamp a preset's rules into a project's permissions"
    )
    p_presets_apply.add_argument("id", help="Preset id")
    p_presets_apply.add_argument("--project", required=True, help="Project name")
    p_presets_apply.add_argument(
        "--rules",
        help="CSV of patterns to apply (default: all enabled_by_default rules)",
    )
    p_presets_apply.add_argument("--json", action="store_true")

    p_presets_new = presets_sub.add_parser(
        "new", help="Create a user-defined preset (empty rule list)"
    )
    p_presets_new.add_argument("id", help="Preset id (slug)")
    p_presets_new.add_argument("--name", required=True)
    p_presets_new.add_argument("--description", default="")
    p_presets_new.add_argument("--icon", default="📦")
    p_presets_new.add_argument("--category", default="custom")

    p_presets_update = presets_sub.add_parser(
        "update", help="Update a user-defined preset"
    )
    p_presets_update.add_argument("id", help="Preset id")
    p_presets_update.add_argument("--name")
    p_presets_update.add_argument("--description")
    p_presets_update.add_argument("--icon")
    p_presets_update.add_argument(
        "--add-rule",
        dest="add_rule",
        action="append",
        default=[],
        help="Pattern to add (repeatable)",
    )
    p_presets_update.add_argument(
        "--remove-rule",
        dest="remove_rule",
        action="append",
        default=[],
        help="Pattern to remove (repeatable)",
    )

    p_presets_delete = presets_sub.add_parser(
        "delete", help="Delete a user-defined preset (built-ins cannot be deleted)"
    )
    p_presets_delete.add_argument("id", help="Preset id")

    # source (external skill sources)
    p_source = sub.add_parser("source", help="Manage external skill sources")
    source_sub = p_source.add_subparsers(dest="source_cmd")
    p_src_list = source_sub.add_parser(
        "list", help="List sources (built-in + configured)"
    )
    p_src_list.add_argument("--json", action="store_true", help="Emit JSON")
    p_src_status = source_sub.add_parser(
        "status", help="Show detailed status for one source"
    )
    p_src_status.add_argument("id", help="Source id")
    p_src_status.add_argument("--json", action="store_true", help="Emit JSON")
    p_src_add = source_sub.add_parser("add", help="Add a new source")
    src_add_sub = p_src_add.add_subparsers(dest="source_type")
    p_src_add_git = src_add_sub.add_parser("git", help="Add a Git repository source")
    p_src_add_git.add_argument("url", help="Git URL (SSH or HTTPS)")
    p_src_add_git.add_argument(
        "--id", help="Source id slug (default: derived from URL)"
    )
    p_src_add_git.add_argument("--name", help="Display name (default: source id)")
    p_src_add_git.add_argument("--branch", help="Branch (default: remote default)")
    p_src_add_git.add_argument(
        "--path", default="", help="Repo-relative subdirectory to scan"
    )
    p_src_add_git.add_argument(
        "--dry-run",
        action="store_true",
        help="Clone to temp, return preview, no registry mutation",
    )
    p_src_add_git.add_argument(
        "--decisions-stdin",
        dest="decisions_stdin",
        action="store_true",
        help=(
            "Read per-conflict decisions from stdin as "
            '{"decisions": {"<name>": "skip"|"replace"|"suffix"}} (apply only)'
        ),
    )
    p_src_add_git.add_argument("--json", action="store_true", help="Emit JSON")

    p_src_check = source_sub.add_parser(
        "check", help="Fetch and compare refs without mutating skill files"
    )
    p_src_check.add_argument("id", help="Source id")
    p_src_check.add_argument("--json", action="store_true", help="Emit JSON")

    p_src_sync = source_sub.add_parser(
        "sync", help="Pull configured branch, rescan candidates, update metadata"
    )
    p_src_sync.add_argument("id", help="Source id")
    p_src_sync.add_argument("--json", action="store_true", help="Emit JSON")

    p_src_remove = source_sub.add_parser(
        "remove", help="Remove a source (preview with --dry-run before applying)"
    )
    p_src_remove.add_argument("id", help="Source id")
    p_src_remove.add_argument(
        "--dry-run", action="store_true", help="Preview impact without mutating"
    )
    p_src_remove.add_argument(
        "--mode",
        choices=["unequip", "keep-local"],
        help="Apply mode: 'unequip' removes everything; 'keep-local' converts owned skills to local copies",
    )
    p_src_remove.add_argument("--json", action="store_true", help="Emit JSON")

    p_src_dup = source_sub.add_parser(
        "duplicate",
        help="Duplicate an external/starter skill into a local editable copy",
    )
    p_src_dup.add_argument("name", help="Existing managed skill name")
    p_src_dup.add_argument(
        "--as", dest="new_name", help="New local slug (default: <name>-local)"
    )
    p_src_dup.add_argument("--json", action="store_true", help="Emit JSON")

    # version
    sub.add_parser("version", help="Show hub version and stats")

    # selfcheck — registry-free runtime probe consumed by the app's preflight
    p_selfcheck = sub.add_parser(
        "selfcheck",
        help="Registry-free runtime self-check (used by the Skill Tree app preflight)",
    )
    p_selfcheck.add_argument("--json", action="store_true", help="Emit JSON")

    # mcp-control — register/unregister the control-plane MCP server
    p_mcpctl = sub.add_parser(
        "mcp-control",
        help="Register/unregister the Skill Hub control-plane MCP server",
    )
    mcpctl_sub = p_mcpctl.add_subparsers(dest="mcp_control_cmd")
    mcpctl_sub.add_parser("install", help="Register the control-plane MCP server")
    mcpctl_sub.add_parser("uninstall", help="Remove the control-plane MCP server")
    mcpctl_sub.add_parser("status", help="Show registration status + resolved path")

    args = parser.parse_args()

    dispatch = {
        "list": cmd_list,
        "enable": cmd_enable,
        "disable": cmd_disable,
        "sync": cmd_sync,
        "new": cmd_new,
        "migrate": cmd_migrate,
        "set-meta": cmd_set_meta,
        "archive": cmd_archive,
        "rename": cmd_rename,
        "dashboard": cmd_dashboard,
        "update": cmd_update,
        "app-dev": cmd_app_dev,
        "app-build": cmd_app_build,
        "cleanup-backups": cmd_cleanup_backups,
        "version": cmd_version,
        "selfcheck": cmd_selfcheck,
        "bootstrap": cmd_bootstrap,
        "migrate-home": cmd_migrate_home,
    }

    if args.command == "project":
        if args.project_cmd == "add":
            cmd_project_add(args)
        elif args.project_cmd == "remove":
            cmd_project_remove(args)
        elif args.project_cmd == "edit-path":
            cmd_project_edit_path(args)
        elif args.project_cmd == "harnesses":
            cmd_project_harnesses(args)
        elif args.project_cmd == "invocation":
            cmd_project_invocation(args)
        elif args.project_cmd == "agent-docs":
            cmd_project_agent_docs(args)
        elif args.project_cmd == "import-skill":
            cmd_project_import_skill(args)
        elif args.project_cmd == "scan-skills":
            cmd_project_scan_skills(args)
        else:
            p_proj.print_help()
    elif args.command == "agent-docs":
        if args.agent_docs_cmd == "strategy":
            cmd_agent_docs_strategy(args)
        elif args.agent_docs_cmd in ("fix", "migrate"):
            cmd_agent_docs_fix(args)
        elif args.agent_docs_cmd == "resolve":
            cmd_agent_docs_resolve(args)
        elif args.agent_docs_cmd == "status":
            cmd_agent_docs_status(args)
        else:
            p_ad.print_help()
    elif args.command == "snippet":
        snip_cmd = getattr(args, "snippet_cmd", None)
        if snip_cmd == "list":
            cmd_snippet_list(args)
        elif snip_cmd == "show":
            cmd_snippet_show(args)
        elif snip_cmd == "new":
            cmd_snippet_new(args)
        elif snip_cmd == "edit":
            cmd_snippet_edit(args)
        elif snip_cmd == "delete":
            cmd_snippet_delete(args)
        elif snip_cmd == "apply":
            cmd_snippet_apply(args)
        elif snip_cmd == "remove":
            cmd_snippet_remove(args)
        elif snip_cmd == "update":
            cmd_snippet_update(args)
        elif snip_cmd == "status":
            cmd_snippet_status(args)
        else:
            p_snip.print_help()
    elif args.command == "bundle":
        cmd_bundle(args)
    elif args.command == "mcp-control":
        cmd_mcp_control(args)
    elif args.command == "app":
        if args.app_cmd == "dev":
            cmd_app_dev(args)
        elif args.app_cmd == "build":
            cmd_app_build(args)
    elif args.command == "harnesses":
        if args.harnesses_cmd == "emit-schema":
            cmd_harnesses_emit_schema(args)
        else:
            p_harn.print_help()
    elif args.command == "harness":
        if args.harness_cmd == "list":
            cmd_harness_list(args)
        elif args.harness_cmd == "enable":
            cmd_harness_enable(args)
        elif args.harness_cmd == "disable":
            cmd_harness_disable(args)
        else:
            p_harness.print_help()
    elif args.command == "subagent":
        sc = getattr(args, "subagent_cmd", None)
        if sc == "list":
            cmd_subagent_list(args)
        elif sc == "show":
            cmd_subagent_show(args)
        elif sc == "save":
            cmd_subagent_save(args)
        elif sc == "delete":
            cmd_subagent_delete(args)
        elif sc == "set-disabled":
            cmd_subagent_set_disabled(args)
        elif sc == "skill-usage":
            cmd_subagent_skill_usage(args)
        elif sc == "attachable-skills":
            cmd_subagent_attachable_skills(args)
        elif sc == "link":
            cmd_subagent_link(args)
        elif sc == "unlink":
            cmd_subagent_unlink(args)
        elif sc == "link-status":
            cmd_subagent_link_status(args)
        elif sc == "resolve-drift":
            cmd_subagent_resolve_drift(args)
        elif sc == "provision-skill":
            cmd_subagent_provision_skill(args)
        else:
            p_sa.print_help()
    elif args.command == "remote":
        rc = getattr(args, "remote_cmd", None)
        if rc == "list":
            cmd_remote_list(args)
        elif rc == "connectors":
            cmd_remote_connectors(args)
        elif rc == "add":
            cmd_remote_add(args)
        elif rc == "show":
            cmd_remote_show(args)
        elif rc == "diff":
            cmd_remote_diff(args)
        elif rc == "sync":
            cmd_remote_sync(args)
        elif rc == "resolve":
            cmd_remote_resolve(args)
        elif rc == "disable":
            cmd_remote_disable(args)
        elif rc == "enable":
            cmd_remote_enable(args)
        elif rc == "set-global":
            cmd_remote_set_global(args)
        elif rc == "equip":
            cmd_remote_equip(args)
        elif rc == "remove":
            cmd_remote_remove(args)
        elif rc == "clear":
            cmd_remote_clear(args)
        elif rc == "import-skill":
            cmd_remote_import_skill(args)
        elif rc == "keyscan":
            cmd_remote_keyscan(args)
        elif rc == "setup-key":
            cmd_remote_setup_key(args)
        elif rc == "setup-codex-helper":
            cmd_remote_setup_codex_helper(args)
        elif rc == "list-docs":
            cmd_remote_list_docs(args)
        elif rc == "fetch-doc":
            cmd_remote_fetch_doc(args)
        elif rc == "push-doc":
            cmd_remote_push_doc(args)
        elif rc == "health":
            cmd_remote_health(args)
        elif rc == "doctor":
            cmd_remote_doctor(args)
        elif rc == "signing-key":
            cmd_remote_signing_key(args)
        elif rc == "revoke-key":
            cmd_remote_revoke_key(args)
        elif rc == "repin":
            cmd_remote_repin(args)
        elif rc == "rotate-token":
            cmd_remote_rotate_token(args)
        else:
            p_remote.print_help()
    elif args.command == "permissions":
        sub_cmd = getattr(args, "permissions_cmd", None)
        if sub_cmd == "list":
            cmd_permissions_list(args)
        elif sub_cmd == "show":
            cmd_permissions_show(args)
        elif sub_cmd == "add":
            cmd_permissions_add(args)
        elif sub_cmd == "remove":
            cmd_permissions_remove(args)
        elif sub_cmd == "hooks":
            hc = getattr(args, "hooks_cmd", None)
            if hc == "add":
                cmd_permissions_hooks_add(args)
            elif hc == "remove":
                cmd_permissions_hooks_remove(args)
            else:
                p_perm_hooks.print_help()
        elif sub_cmd == "adopt":
            cmd_permissions_adopt(args)
        elif sub_cmd == "import":
            cmd_permissions_import(args)
        elif sub_cmd == "reconcile":
            cmd_permissions_reconcile(args)
        elif sub_cmd == "doctor":
            cmd_permissions_doctor(args)
        elif sub_cmd == "disable":
            cmd_permissions_disable(args)
        elif sub_cmd == "migrate-scope":
            cmd_permissions_migrate_scope(args)
        elif sub_cmd == "set":
            cmd_permissions_set(args)
        elif sub_cmd == "validate":
            cmd_permissions_validate(args)
        elif sub_cmd == "capabilities":
            cmd_permissions_capabilities(args)
        elif sub_cmd == "presets":
            pc = getattr(args, "presets_cmd", None)
            if pc == "list":
                cmd_permissions_presets_list(args)
            elif pc == "show":
                cmd_permissions_presets_show(args)
            elif pc == "apply":
                cmd_permissions_presets_apply(args)
            elif pc == "new":
                cmd_permissions_presets_new(args)
            elif pc == "update":
                cmd_permissions_presets_update(args)
            elif pc == "delete":
                cmd_permissions_presets_delete(args)
            else:
                p_perm_presets.print_help()
        else:
            p_perm.print_help()
    elif args.command == "source":
        if args.source_cmd == "list":
            cmd_source_list(args)
        elif args.source_cmd == "status":
            cmd_source_status(args)
        elif args.source_cmd == "add":
            if args.source_type == "git":
                cmd_source_add_git(args)
            else:
                p_src_add.print_help()
        elif args.source_cmd == "check":
            cmd_source_check(args)
        elif args.source_cmd == "sync":
            cmd_source_sync(args)
        elif args.source_cmd == "remove":
            cmd_source_remove(args)
        elif args.source_cmd == "duplicate":
            cmd_source_duplicate(args)
        else:
            p_source.print_help()
    elif args.command in dispatch:
        dispatch[args.command](args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
