"""Canonical agent-docs root policy.

Almost every harness reads ``AGENTS.md``; only Claude Code reads ``CLAUDE.md``.
When more than one harness is in play we make ``AGENTS.md`` the single real root
and ``CLAUDE.md`` a *derived* artifact pointing at it. How ``CLAUDE.md`` is
derived is governed by a global (optionally per-project) strategy:

    symlink — CLAUDE.md is a relative symlink → AGENTS.md
    import  — CLAUDE.md is a regular file whose entire body is ``@AGENTS.md``

A derived ``CLAUDE.md`` is therefore self-describing on disk (a symlink, or a
file whose content is exactly ``@AGENTS.md``); any other regular ``CLAUDE.md``
is treated as user-authored and never silently overwritten.

``hub sync`` only *detects* whether a project differs from its canonical layout
(``detect_status``). All mutation happens through the explicit ``migrate``
action so a reflexive sync never dirties git-tracked instruction files.
"""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import Optional

import harnesses as _harnesses

CLAUDE = "CLAUDE.md"
CANONICAL = "AGENTS.md"
IMPORT_LINE = "@AGENTS.md"
VALID_STRATEGIES = ("symlink", "import")
DEFAULT_STRATEGY = "symlink"


# ─────────────────────────────────────────────────────────────────────────────
# Strategy + canonical-root resolution
# ─────────────────────────────────────────────────────────────────────────────


def resolve_strategy(project: dict, registry: dict) -> str:
    """Effective strategy: project override ?? global ?? symlink."""
    proj = ((project or {}).get("agent_docs") or {}).get("root_strategy")
    if proj in VALID_STRATEGIES:
        return proj
    glob = ((registry or {}).get("agent_docs") or {}).get("root_strategy")
    if glob in VALID_STRATEGIES:
        return glob
    return DEFAULT_STRATEGY


def required_root_files(effective: set[str]) -> set[str]:
    """Root instruction filenames required by an effective harness set."""
    files: set[str] = set()
    for h_id in effective:
        h = _harnesses.HARNESSES.get(h_id)
        files.add(h.root_doc if h else CANONICAL)
    return files


def resolve_canonical_root(
    project: dict, registry: dict, installed: Optional[set[str]] = None
) -> dict:
    """Return ``{"canonical": <file|None>, "derived": <file|None>}``.

    - Claude-only            → canonical CLAUDE.md, no derived
    - Claude + other harness → canonical AGENTS.md, derived CLAUDE.md
    - non-Claude only        → canonical AGENTS.md, no derived
    - no effective harness   → both None
    """
    effective = _harnesses.resolve_effective(project, registry, installed=installed)
    req = required_root_files(effective)
    needs_claude = CLAUDE in req
    needs_agents = CANONICAL in req
    if needs_agents and needs_claude:
        return {"canonical": CANONICAL, "derived": CLAUDE}
    if needs_agents:
        return {"canonical": CANONICAL, "derived": None}
    if needs_claude:
        return {"canonical": CLAUDE, "derived": None}
    return {"canonical": None, "derived": None}


# ─────────────────────────────────────────────────────────────────────────────
# On-disk classification
# ─────────────────────────────────────────────────────────────────────────────


def classify_claude(root: Path) -> str:
    """Classify the project-root CLAUDE.md.

    Returns one of: ``absent``, ``derived-symlink``, ``derived-import``, ``user``.
    """
    p = root / CLAUDE
    if p.is_symlink():
        return "derived-symlink"
    if p.exists():
        try:
            txt = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return "user"
        return "derived-import" if txt.strip() == IMPORT_LINE else "user"
    return "absent"


def _is_real_file(p: Path) -> bool:
    return p.exists() and not p.is_symlink()


def _derived_matches_strategy(root: Path, strategy: str) -> bool:
    klass = classify_claude(root)
    if strategy == "symlink":
        if klass != "derived-symlink":
            return False
        try:
            return os.readlink(root / CLAUDE) == CANONICAL
        except OSError:
            return False
    return klass == "derived-import"


# ─────────────────────────────────────────────────────────────────────────────
# Detection (read-only) — used by `hub sync`
# ─────────────────────────────────────────────────────────────────────────────


# Legacy singular filename. Recognized only to classify and clean — it never
# satisfies the AGENT format (no configured harness reads it).
LEGACY = "AGENT.md"

# Directories skipped while discovering nested instruction dirs. Mirrors the
# Rust scanner's IGNORED_DIR_NAMES/IGNORED_NESTED_PATHS (agent_docs.rs) — the
# shared corpus test keeps the two classifiers in agreement.
IGNORED_DIR_NAMES = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "vendor",
    ".venv",
    "venv",
    "dist",
    "build",
    "target",
    ".next",
    ".turbo",
    ".gradle",
}
IGNORED_NESTED_PATHS = {".claude/skills", ".agents/skills"}
MAX_DEPTH = 8

VERDICTS = (
    "none",
    "canonical",
    "claude_only",
    "agents_only",
    "derived_drift",
    "replaced_derived",
    "conflict",
    "pointer_plus_content",
    "empty",
)


def _read_text(p: Path) -> Optional[str]:
    try:
        return p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _pointer_kind(content: str) -> str:
    """Classify a regular CLAUDE.md body: ``import`` (pure pointer),
    ``pointer_plus`` (pointer line + extra content), ``materialized``
    (a git core.symlinks=false checkout wrote the link target as the body),
    or ``user``."""
    stripped = content.strip()
    if stripped == IMPORT_LINE:
        return "import"
    if stripped == CANONICAL:
        return "materialized"
    first, _, rest = content.lstrip().partition("\n")
    if first.strip() == IMPORT_LINE and rest.strip():
        return "pointer_plus"
    return "user"


def _link_state(p: Path, project_root: Path) -> dict:
    """Inspect one instruction path. Returns
    ``{kind: missing|file|symlink, target, resolves, sibling, external}``."""
    out = {
        "kind": "missing",
        "target": None,
        "resolves": False,
        "sibling": False,
        "external": False,
    }
    if p.is_symlink():
        out["kind"] = "symlink"
        try:
            out["target"] = os.readlink(p)
        except OSError:
            return out
        try:
            resolved = p.resolve(strict=True)
        except OSError:
            return out  # broken
        out["resolves"] = True
        out["resolved_name"] = resolved.name
        try:
            resolved.relative_to(project_root.resolve())
        except ValueError:
            out["external"] = True
            return out
        out["sibling"] = resolved.parent == p.parent.resolve() and resolved.name in (
            CLAUDE,
            CANONICAL,
            LEGACY,
        )
        return out
    if p.exists():
        out["kind"] = "file"
        out["resolves"] = True
    return out


def classify_directory(
    dir_path: Path,
    project_root: Path,
    *,
    is_root: bool,
    requires_claude: bool,
    requires_agent: bool,
    strategy: str,
) -> dict:
    """One-model verdict for a single instruction directory.

    This is THE status definition (design D2). The Rust scanner implements the
    same table; ``tests/fixtures/agent_docs_corpus.json`` pins both.
    Returns ``{verdict, flags, claude, agents, legacy, appendix}``.
    """
    claude_p = dir_path / CLAUDE
    agents_p = dir_path / CANONICAL
    legacy_p = dir_path / LEGACY
    claude = _link_state(claude_p, project_root)
    agents = _link_state(agents_p, project_root)
    legacy = _link_state(legacy_p, project_root)

    flags: list[str] = []
    for st in (claude, agents, legacy):
        if st["kind"] == "symlink" and not st["resolves"]:
            if "broken_link" not in flags:
                flags.append("broken_link")
        if st["kind"] == "symlink" and st["external"]:
            if "external_link" not in flags:
                flags.append("external_link")
    if legacy["kind"] != "missing":
        flags.append("legacy")

    out = {
        "verdict": "none",
        "flags": flags,
        "claude": claude,
        "agents": agents,
        "legacy": legacy,
        "appendix": None,
    }
    if not requires_claude and not requires_agent:
        return out

    # External symlinks are user-managed: the format counts as satisfied and
    # the fix plan must never touch it.
    claude_external = claude["kind"] == "symlink" and claude["external"]
    agents_external = agents["kind"] == "symlink" and agents["external"]
    agents_real = agents["kind"] == "file"
    claude_real = claude["kind"] == "file"
    claude_content = _read_text(claude_p) if claude_real else None
    claude_kind = (
        _pointer_kind(claude_content)
        if claude_content is not None
        else ("unreadable" if claude_real else "absent")
    )
    claude_derived_link = (
        claude["kind"] == "symlink"
        and claude["resolves"]
        and claude["sibling"]
        and claude_p.resolve().name == CANONICAL
    )

    # Claude-only project: CLAUDE.md is the standalone real root; AGENTS.md is
    # not required and never demanded.
    if requires_claude and not requires_agent:
        if claude_real or claude_derived_link or claude_external:
            out["verdict"] = "canonical"
        else:
            out["verdict"] = "empty"
        return out

    # Agent-only project: AGENTS.md must be real; CLAUDE.md is irrelevant.
    if requires_agent and not requires_claude:
        if agents_real or agents_external:
            out["verdict"] = "canonical"
        elif claude_real and claude_kind == "user":
            out["verdict"] = "claude_only"
        else:
            out["verdict"] = "empty"
        return out

    # Multi-harness: AGENTS.md real, CLAUDE.md derived (root) / derived-or-absent (nested).
    if agents_real or agents_external:
        if claude_external:
            out["verdict"] = "canonical"
        elif claude["kind"] == "missing":
            out["verdict"] = "agents_only" if is_root else "canonical"
        elif claude_derived_link:
            out["verdict"] = "canonical" if strategy == "symlink" else "derived_drift"
        elif claude["kind"] == "symlink" and not claude["resolves"]:
            # Broken CLAUDE.md link next to a real AGENTS.md: needs re-derive.
            out["verdict"] = "agents_only" if is_root else "canonical"
        elif claude["kind"] == "symlink":
            # Resolving link elsewhere in the project — treat as drift.
            out["verdict"] = "derived_drift"
        elif claude_kind == "import":
            out["verdict"] = "canonical" if strategy == "import" else "derived_drift"
        elif claude_kind == "materialized":
            out["verdict"] = "derived_drift"
        elif claude_kind == "pointer_plus":
            out["verdict"] = "pointer_plus_content"
            first, _, rest = (claude_content or "").lstrip().partition("\n")
            out["appendix"] = rest.lstrip("\n")
        elif claude_kind == "unreadable":
            out["verdict"] = "conflict"
        else:  # user content
            agents_txt = _read_text(agents_p)
            if agents_txt is not None and agents_txt == claude_content:
                out["verdict"] = "replaced_derived"
            else:
                out["verdict"] = "conflict"
        return out

    # No real AGENTS.md (absent, broken, or a reverse symlink at CLAUDE.md).
    if claude_real and claude_kind == "user":
        out["verdict"] = "claude_only"
    elif claude_real and claude_kind in ("import", "materialized", "pointer_plus"):
        # Pointer at a missing AGENTS.md is effectively broken.
        if "broken_link" not in out["flags"]:
            out["flags"].append("broken_link")
        out["verdict"] = "empty"
    else:
        out["verdict"] = "empty"
    return out


def _policy_for_project(
    project: dict, registry: dict, installed: Optional[set[str]] = None
) -> dict:
    res = resolve_canonical_root(project, registry, installed=installed)
    canonical, derived = res["canonical"], res["derived"]
    return {
        "requires_claude": canonical == CLAUDE or derived == CLAUDE,
        "requires_agent": canonical == CANONICAL,
        "strategy": resolve_strategy(project, registry),
        "canonical": canonical,
        "derived": derived,
    }


def discover_instruction_dirs(root: Path) -> list[str]:
    """Relative dirs (``""`` = root) containing any instruction file.
    Mirrors the Rust scanner's bounded walk and ignore rules."""
    found: set[str] = {""}
    stack: list[tuple[Path, int, str]] = [(root, 0, "")]
    while stack:
        d, depth, rel = stack.pop()
        if depth > MAX_DEPTH:
            continue
        try:
            entries = list(os.scandir(d))
        except OSError:
            continue
        for e in entries:
            name = e.name
            new_rel = f"{rel}/{name}" if rel else name
            try:
                is_dir = e.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if is_dir:
                if name in IGNORED_DIR_NAMES or new_rel in IGNORED_NESTED_PATHS:
                    continue
                if depth < MAX_DEPTH:
                    stack.append((Path(e.path), depth + 1, new_rel))
            elif name in (CLAUDE, CANONICAL, LEGACY):
                found.add(rel)
    return sorted(found)


def detect_statuses(
    project: dict, registry: dict, installed: Optional[set[str]] = None
) -> dict:
    """Per-directory verdicts for a whole project. ``{"": {...}, "cli": {...}}``"""
    root = Path(project["path"]).expanduser()
    policy = _policy_for_project(project, registry, installed=installed)
    out: dict[str, dict] = {}
    for rel in discover_instruction_dirs(root):
        cls = classify_directory(
            root / rel if rel else root,
            root,
            is_root=(rel == ""),
            requires_claude=policy["requires_claude"],
            requires_agent=policy["requires_agent"],
            strategy=policy["strategy"],
        )
        out[rel] = cls
    return out


def detect_status(
    project: dict, registry: dict, installed: Optional[set[str]] = None
) -> dict:
    """Read-only classification of a project's root-doc layout.

    ``state`` is one of:
      - ``none``                 — no effective harness, nothing to do
      - ``ok``                   — already canonical for the effective strategy
      - ``needs_canonicalization`` — the fix would change the layout
      - ``conflict``             — two divergent real root docs (also needs resolution)

    Also carries the underlying ``verdict`` + ``flags`` from the shared status
    model and ``nested_deviations`` (count of non-canonical nested dirs).
    """
    root = Path(project["path"]).expanduser()
    policy = _policy_for_project(project, registry, installed=installed)
    canonical, derived = policy["canonical"], policy["derived"]
    out = {
        "state": "none",
        "canonical": canonical,
        "derived": derived,
        "strategy": policy["strategy"],
        "reason": "",
        "verdict": "none",
        "flags": [],
        "nested_deviations": 0,
    }
    if canonical is None:
        return out

    cls = classify_directory(
        root,
        root,
        is_root=True,
        requires_claude=policy["requires_claude"],
        requires_agent=policy["requires_agent"],
        strategy=policy["strategy"],
    )
    out["verdict"] = cls["verdict"]
    out["flags"] = cls["flags"]

    reasons = {
        "claude_only": "CLAUDE.md should be derived from canonical AGENTS.md",
        "agents_only": "CLAUDE.md should be derived from canonical AGENTS.md",
        "derived_drift": "derived CLAUDE.md does not match the effective strategy",
        "replaced_derived": "CLAUDE.md duplicates AGENTS.md and should collapse to the derived form",
        "pointer_plus_content": "CLAUDE.md carries content appended after its @AGENTS.md pointer",
        "empty": "AGENTS.md should be the real root",
        "conflict": "divergent CLAUDE.md and AGENTS.md",
    }

    nested = detect_statuses(project, registry, installed=installed)
    out["nested_deviations"] = sum(
        1
        for rel, c in nested.items()
        if rel != ""
        and (c["verdict"] not in ("canonical", "none") or "legacy" in c["flags"])
    )

    # Claude-only project: CLAUDE.md is the real root; nothing to canonicalize
    # (creating a missing root doc is the create flow, not canonicalization).
    if canonical == CLAUDE:
        if "legacy" in cls["flags"]:
            out["state"] = "needs_canonicalization"
            out["reason"] = "legacy AGENT.md artifacts should be cleaned up"
        else:
            out["state"] = "ok"
        return out

    if cls["verdict"] == "conflict":
        out["state"] = "conflict"
        out["reason"] = reasons["conflict"]
        return out
    if cls["verdict"] == "canonical" and "legacy" not in cls["flags"]:
        out["state"] = "ok"
        return out
    out["state"] = "needs_canonicalization"
    if cls["verdict"] == "canonical":
        out["reason"] = "legacy AGENT.md artifacts should be cleaned up"
    else:
        out["reason"] = reasons.get(cls["verdict"], "")
    if canonical == CANONICAL and derived is None and cls["verdict"] in (
        "empty",
        "claude_only",
    ):
        out["reason"] = "AGENTS.md should be the real root"
    return out


def _root_docs_equivalent(agents: Path, claude: Path) -> bool:
    """True when CLAUDE.md may safely collapse onto AGENTS.md.

    Equivalent iff byte-identical, or CLAUDE.md is already a pure ``@AGENTS.md``
    import pointer.
    """
    try:
        c_txt = claude.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    if c_txt.strip() == IMPORT_LINE:
        return True
    try:
        a_txt = agents.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    return a_txt == c_txt


# ─────────────────────────────────────────────────────────────────────────────
# Migration (explicit) — never called from sync
# ─────────────────────────────────────────────────────────────────────────────


def _backup(path: Path, project_name: str, backups_root: Path) -> Path:
    dest_dir = backups_root / "agent-docs" / project_name
    dest_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    dest = dest_dir / f"{path.name}.{ts}"
    # Copy content (resolve symlinks) so the backup is restorable.
    shutil.copy2(path, dest, follow_symlinks=True)
    return dest


def _write_derived(root: Path, strategy: str) -> None:
    claude = root / CLAUDE
    if claude.is_symlink() or claude.exists():
        claude.unlink()
    if strategy == "symlink":
        os.symlink(CANONICAL, claude)  # relative link to the sibling
    else:
        claude.write_text(IMPORT_LINE + "\n", encoding="utf-8")


def plan_migration(
    project: dict, registry: dict, installed: Optional[set[str]] = None
) -> dict:
    """Describe what ``migrate --apply`` would do, without writing.

    Returns ``{"action": <str>, "state": <str>, "details": <str>, ...}``.
    ``action`` is one of: ``noop``, ``promote``, ``collapse``, ``derive``,
    ``rederive``, ``conflict``.
    """
    status = detect_status(project, registry, installed=installed)
    root = Path(project["path"]).expanduser()
    strategy = status["strategy"]
    canonical, derived = status["canonical"], status["derived"]
    plan = {
        "action": "noop",
        "state": status["state"],
        "strategy": strategy,
        "canonical": canonical,
        "derived": derived,
        "details": status["reason"],
    }
    if status["state"] in ("none", "ok"):
        return plan
    if status["state"] == "conflict":
        plan["action"] = "conflict"
        return plan

    agents = root / CANONICAL
    claude = root / CLAUDE
    agents_real = _is_real_file(agents)

    if canonical == CANONICAL and derived is None:
        # non-Claude only and AGENTS.md missing.
        if not agents_real and _is_real_file(claude):
            plan["action"] = "promote"
            plan["details"] = "rename CLAUDE.md → AGENTS.md"
        else:
            plan["action"] = "derive"
            plan["details"] = "AGENTS.md missing"
        return plan

    # Multi-harness (canonical AGENTS.md, derived CLAUDE.md).
    if not agents_real and _is_real_file(claude):
        plan["action"] = "promote"
        plan["details"] = f"rename CLAUDE.md → AGENTS.md, derive CLAUDE.md ({strategy})"
    elif agents_real and _is_real_file(claude):
        plan["action"] = "collapse"
        plan["details"] = f"replace CLAUDE.md with derived form ({strategy})"
    elif agents_real:
        plan["action"] = "rederive" if classify_claude(root) != "absent" else "derive"
        plan["details"] = f"derive CLAUDE.md ({strategy})"
    else:
        plan["action"] = "derive"
        plan["details"] = "AGENTS.md missing"
    return plan


def migrate(
    project: dict,
    registry: dict,
    project_name: str,
    backups_root: Path,
    installed: Optional[set[str]] = None,
) -> dict:
    """Apply the canonical layout. Backup-first, idempotent, conflict-safe.

    Returns the plan augmented with ``applied: bool`` and ``backups: [paths]``.
    """
    plan = plan_migration(project, registry, installed=installed)
    plan["applied"] = False
    plan["backups"] = []
    if plan["action"] in ("noop", "conflict"):
        return plan

    root = Path(project["path"]).expanduser()
    strategy = plan["strategy"]
    derived = plan["derived"]
    agents = root / CANONICAL
    claude = root / CLAUDE

    if plan["action"] == "promote":
        if _is_real_file(claude):
            plan["backups"].append(str(_backup(claude, project_name, backups_root)))
        os.replace(claude, agents)
        if derived == CLAUDE:
            _write_derived(root, strategy)
    elif plan["action"] == "collapse":
        if _is_real_file(claude):
            plan["backups"].append(str(_backup(claude, project_name, backups_root)))
        _write_derived(root, strategy)
    elif plan["action"] in ("derive", "rederive"):
        if claude.is_symlink() or claude.exists():
            plan["backups"].append(str(_backup(claude, project_name, backups_root)))
        if derived == CLAUDE:
            _write_derived(root, strategy)

    plan["applied"] = True
    return plan


# ─────────────────────────────────────────────────────────────────────────────
# Fix engine (supersedes single-root migrate; `hub agent-docs fix`)
#
# One transactional plan per project: root promotion/derivation/collapse,
# opt-in nested promotions/derivations, legacy AGENT.md cleanup. Every step
# carries precondition fingerprints captured at plan time; apply re-verifies
# all of them before executing anything and aborts whole on any mismatch.
# ─────────────────────────────────────────────────────────────────────────────

import hashlib as _hashlib
import json as _json


def _fingerprint(p: Path) -> dict:
    if p.is_symlink():
        try:
            target = os.readlink(p)
        except OSError:
            target = None
        return {"kind": "symlink", "target": target}
    if p.exists():
        try:
            digest = _hashlib.sha256(p.read_bytes()).hexdigest()[:32]
        except OSError:
            digest = None
        return {"kind": "file", "hash": digest}
    return {"kind": "missing"}


def _fingerprint_matches(p: Path, expected: dict) -> bool:
    return _fingerprint(p) == {k: v for k, v in expected.items() if k != "rel"}


def _sidecar_generated_rels(project_root: Path, state_root: Optional[Path]) -> set[str]:
    """Rels the legacy companion feature recorded as hub-generated. The sidecar
    is retained read-only purely for cleanup attribution (key mirrors the Rust
    scanner: sha256(project_path)[:32])."""
    if state_root is None:
        return set()
    key = _hashlib.sha256(str(project_root).encode()).hexdigest()[:32]
    p = state_root / "agent-docs" / f"{key}.json"
    try:
        records = _json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    return {
        r.get("target_rel")
        for r in records
        if isinstance(r, dict) and r.get("target_rel")
    }


def _rel_path(rel_dir: str, basename: str) -> str:
    return f"{rel_dir}/{basename}" if rel_dir else basename


def plan_fix(
    project: dict,
    registry: dict,
    installed: Optional[set[str]] = None,
    state_root: Optional[Path] = None,
) -> dict:
    """Build the transactional fix plan for one project.

    Returns ``{strategy, policy, steps, attention, flagged}`` where each step is
    ``{id, dir, action, optional, selected, paths, preconditions, details}``.
    Actions: ``promote`` | ``derive`` | ``rederive`` | ``collapse`` |
    ``remove_legacy_link``. Conflicts and pointer-plus-content never get steps —
    they appear under ``attention`` (resolved via ``resolve_root``).
    """
    root = Path(project["path"]).expanduser()
    policy = _policy_for_project(project, registry, installed=installed)
    strategy = policy["strategy"]
    statuses = detect_statuses(project, registry, installed=installed)
    generated = _sidecar_generated_rels(root.resolve(), state_root)

    steps: list[dict] = []
    attention: list[dict] = []
    flagged: list[dict] = []
    next_id = 0

    def add_step(rel_dir: str, action: str, optional: bool, paths: list[str], details: str):
        nonlocal next_id
        pre = []
        for rel in paths:
            fp = _fingerprint(root / rel)
            fp["rel"] = rel
            pre.append(fp)
        steps.append(
            {
                "id": next_id,
                "dir": rel_dir,
                "action": action,
                "optional": optional,
                "selected": not optional,
                "paths": paths,
                "preconditions": pre,
                "details": details,
            }
        )
        next_id += 1

    for rel_dir, cls in sorted(statuses.items()):
        is_root = rel_dir == ""
        verdict = cls["verdict"]
        claude_rel = _rel_path(rel_dir, CLAUDE)
        agents_rel = _rel_path(rel_dir, CANONICAL)
        legacy_rel = _rel_path(rel_dir, LEGACY)
        derive_claude = policy["derived"] == CLAUDE

        if verdict == "claude_only" and policy["canonical"] == CANONICAL:
            detail = f"rename {claude_rel} → {agents_rel}"
            if derive_claude:
                detail += f", derive {claude_rel} ({strategy})"
            add_step(
                rel_dir,
                "promote",
                optional=not is_root,
                paths=[claude_rel, agents_rel],
                details=detail,
            )
        elif verdict == "agents_only" and is_root and derive_claude:
            add_step(
                rel_dir,
                "derive",
                optional=False,
                paths=[agents_rel, claude_rel],
                details=f"derive {claude_rel} from {agents_rel} ({strategy})",
            )
        elif verdict == "derived_drift":
            add_step(
                rel_dir,
                "rederive",
                optional=False,
                paths=[agents_rel, claude_rel],
                details=f"re-derive {claude_rel} ({strategy})",
            )
        elif verdict == "replaced_derived":
            add_step(
                rel_dir,
                "collapse",
                optional=False,
                paths=[agents_rel, claude_rel],
                details=f"replace {claude_rel} with derived form ({strategy})",
            )
        elif verdict == "conflict":
            attention.append(
                {
                    "dir": rel_dir,
                    "verdict": verdict,
                    "details": f"divergent {claude_rel} vs {agents_rel} — resolve via keep_agents / keep_claude",
                }
            )
        elif verdict == "pointer_plus_content":
            attention.append(
                {
                    "dir": rel_dir,
                    "verdict": verdict,
                    "details": f"{claude_rel} has content appended after its @AGENTS.md pointer — resolve via absorb_appendix",
                    "appendix": cls.get("appendix"),
                }
            )
        elif verdict == "empty" and "broken_link" in cls["flags"] and is_root:
            attention.append(
                {
                    "dir": rel_dir,
                    "verdict": verdict,
                    "details": "root instruction file is missing; a broken derived link remains — author a new root doc",
                }
            )

        # Legacy AGENT.md cleanup, independent of the layout verdict.
        legacy = cls["legacy"]
        if legacy["kind"] == "symlink":
            removable = (
                legacy["sibling"]  # points at a same-dir instruction file
                or not legacy["resolves"]  # dead link — points at nothing
                or legacy_rel in generated  # hub-created per sidecar
            ) and not legacy["external"]
            if removable:
                add_step(
                    rel_dir,
                    "remove_legacy_link",
                    optional=False,
                    paths=[legacy_rel],
                    details=f"remove legacy link {legacy_rel} (→ {legacy['target']}) — no configured agent reads AGENT.md",
                )
            else:
                flagged.append(
                    {
                        "path": legacy_rel,
                        "reason": f"legacy AGENT.md symlink with unrecognized target ({legacy['target']}) — review manually",
                    }
                )
        elif legacy["kind"] == "file":
            # A real-content AGENT.md can safely become the canonical
            # AGENTS.md (same content, a name agents actually read) when no
            # AGENTS.md exists and CLAUDE.md is either absent or a sibling
            # link pointing AT the legacy file (the old companion shape — it
            # gets re-derived against the renamed target). Offered opt-in;
            # any other sibling shape could clobber or manufacture a
            # conflict, so it is only flagged.
            claude_st = cls["claude"]
            claude_links_legacy = (
                claude_st["kind"] == "symlink"
                and claude_st["resolves"]
                and claude_st["sibling"]
                and claude_st.get("resolved_name") == LEGACY
            )
            renamable = cls["agents"]["kind"] == "missing" and (
                claude_st["kind"] == "missing" or claude_links_legacy
            )
            if renamable:
                paths = [legacy_rel, agents_rel]
                detail = (
                    f"rename {legacy_rel} → {agents_rel} "
                    f"(user-authored content, preserved verbatim — AGENT.md is read by no configured agent)"
                )
                if claude_links_legacy:
                    paths.append(claude_rel)
                    detail += f", re-derive {claude_rel}"
                add_step(
                    rel_dir,
                    "rename_legacy_file",
                    optional=True,
                    paths=paths,
                    details=detail,
                )
            else:
                flagged.append(
                    {
                        "path": legacy_rel,
                        "reason": "user-authored legacy AGENT.md with its own content — review manually; the fix never deletes it",
                    }
                )

    return {
        "strategy": strategy,
        "policy": {
            "requires_claude": policy["requires_claude"],
            "requires_agent": policy["requires_agent"],
            "canonical": policy["canonical"],
            "derived": policy["derived"],
        },
        "steps": steps,
        "attention": attention,
        "flagged": flagged,
    }


def _backup_rel(
    root: Path, rel: str, project_name: str, backups_root: Path
) -> Optional[str]:
    """Backup one path (content-resolving). Returns the backup path, or None
    for paths whose content cannot be copied (e.g. broken symlinks)."""
    src = root / rel
    try:
        dest_dir = backups_root / "agent-docs" / project_name
        dest_dir.mkdir(parents=True, exist_ok=True)
        ts = time.strftime("%Y%m%d-%H%M%S")
        safe = rel.replace("/", "__")
        dest = dest_dir / f"{safe}.{ts}"
        shutil.copy2(src, dest, follow_symlinks=True)
        return str(dest)
    except OSError:
        return None


def apply_fix(
    project: dict,
    registry: dict,
    project_name: str,
    backups_root: Path,
    plan: dict,
    installed: Optional[set[str]] = None,
) -> dict:
    """Execute a previewed fix plan transactionally.

    Re-verifies every executable step's preconditions against disk first; if
    any path changed since the plan was built, NOTHING is executed and the
    result is ``{"applied": False, "error": "disk_changed", "mismatches": [...]}``.
    """
    root = Path(project["path"]).expanduser()
    strategy = plan.get("strategy") or resolve_strategy(project, registry)
    derive_claude = (plan.get("policy") or {}).get("derived") == CLAUDE

    executable = [
        s for s in plan.get("steps", []) if not s.get("optional") or s.get("selected")
    ]

    mismatches = []
    for step in executable:
        for pre in step.get("preconditions", []):
            rel = pre.get("rel")
            if rel is None:
                continue
            if not _fingerprint_matches(root / rel, pre):
                mismatches.append({"step": step["id"], "rel": rel})
    if mismatches:
        return {
            "applied": False,
            "error": "disk_changed",
            "mismatches": mismatches,
            "executed": [],
            "backups": [],
        }

    executed: list[dict] = []
    backups: list[str] = []
    touched: list[str] = []

    def backup(rel: str):
        b = _backup_rel(root, rel, project_name, backups_root)
        if b:
            backups.append(b)

    def touch(*rels: str):
        for r in rels:
            if r not in touched:
                touched.append(r)

    # Legacy removals first so promotions never leave chained links behind.
    ordered = sorted(
        executable, key=lambda s: 0 if s["action"] == "remove_legacy_link" else 1
    )
    for step in ordered:
        action = step["action"]
        rel_dir = step["dir"]
        d = root / rel_dir if rel_dir else root
        claude_p = d / CLAUDE
        agents_p = d / CANONICAL
        claude_rel = _rel_path(rel_dir, CLAUDE)
        agents_rel = _rel_path(rel_dir, CANONICAL)
        legacy_rel = _rel_path(rel_dir, LEGACY)
        if action == "remove_legacy_link":
            legacy_p = d / LEGACY
            backup(legacy_rel)
            legacy_p.unlink(missing_ok=True)
            touch(legacy_rel)
        elif action == "promote":
            backup(claude_rel)
            if agents_p.is_symlink():
                agents_p.unlink()
            os.replace(claude_p, agents_p)
            if derive_claude:
                _write_derived(d, strategy)
            touch(claude_rel, agents_rel)
        elif action == "rename_legacy_file":
            backup(legacy_rel)
            # A CLAUDE.md link aimed at the legacy file would break on rename;
            # re-derive it against the new canonical target.
            had_claude_link = claude_p.is_symlink()
            if had_claude_link:
                backup(claude_rel)
                claude_p.unlink()
            os.replace(d / LEGACY, agents_p)
            if had_claude_link:
                _write_derived(d, strategy)
                touch(claude_rel)
            touch(legacy_rel, agents_rel)
        elif action in ("derive", "rederive"):
            if claude_p.is_symlink() or claude_p.exists():
                backup(claude_rel)
            _write_derived(d, strategy)
            touch(claude_rel)
        elif action == "collapse":
            backup(claude_rel)
            _write_derived(d, strategy)
            touch(claude_rel)
        executed.append(
            {
                "id": step["id"],
                "dir": rel_dir,
                "action": action,
                "details": step.get("details", ""),
            }
        )

    return {
        "applied": True,
        "executed": executed,
        "backups": backups,
        "touched": touched,
        "flagged": plan.get("flagged", []),
        "attention": plan.get("attention", []),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Opt-in git commit of layout mutations
#
# Stages and commits ONLY the paths the operation touched — never the rest of
# the working tree, never a push. Failure here is a warning, not a rollback:
# the filesystem changes already applied stay applied.
# ─────────────────────────────────────────────────────────────────────────────

import subprocess as _subprocess


def _git(root: Path, *args: str) -> _subprocess.CompletedProcess:
    return _subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True,
        text=True,
        timeout=30,
    )


_RESOLVE_EXPLANATIONS = {
    "keep_agents": (
        "CLAUDE.md and AGENTS.md had diverged. Skill Tree resolved the "
        "conflict by keeping AGENTS.md as the canonical root and replacing "
        "CLAUDE.md with a derived pointer to it. The previous CLAUDE.md "
        "content is preserved in a Skill Tree backup."
    ),
    "keep_claude": (
        "CLAUDE.md and AGENTS.md had diverged. Skill Tree resolved the "
        "conflict by promoting CLAUDE.md's content into AGENTS.md (now the "
        "canonical root) and replacing CLAUDE.md with a derived pointer. The "
        "previous AGENTS.md content is preserved in a Skill Tree backup."
    ),
    "absorb_appendix": (
        "CLAUDE.md had content appended after its @AGENTS.md import pointer "
        "(e.g. an agent memory append). Skill Tree moved that appendix "
        "verbatim to the end of AGENTS.md and restored CLAUDE.md to the pure "
        "pointer — no text was lost or rewritten."
    ),
}

_FIX_EXPLANATION = (
    "Skill Tree restructured this project's agent instruction files to the "
    "canonical layout: AGENTS.md is the single real root document (read by "
    "Codex, Pi, opencode, and other agents) and CLAUDE.md is derived from it "
    "for Claude Code. Files were only renamed, linked, or removed — no "
    "instruction prose was authored or edited."
)


def build_commit_message(executed: list[dict], op: Optional[str] = None) -> str:
    """Deterministic prepared message: Skill Tree-labelled subject, a plain-
    language explanation of what happened and why, and the step list."""
    if op:
        subject = f"skill-tree(agent-docs): {op.replace('_', ' ')} for the root instruction files"
        explanation = _RESOLVE_EXPLANATIONS.get(op, "")
        lines = [f"- {op.replace('_', ' ')}"]
    else:
        subject = "skill-tree(agent-docs): canonicalize agent instruction files"
        explanation = _FIX_EXPLANATION
        lines = [f"- {e.get('details') or e['action']}" for e in executed]
    body = "\n".join(lines)
    return (
        f"{subject}\n"
        "\n"
        f"{explanation}\n"
        "\n"
        "Steps applied:\n"
        f"{body}\n"
        "\n"
        "Every replaced or removed file was backed up first under\n"
        "~/.skill-hub/_hub-backups/agent-docs/.\n"
        "\n"
        "Generated by Skill Tree (hub agent-docs).\n"
    )


def commit_layout_change(project_root: Path, rels: list[str], message: str) -> dict:
    """Commit exactly ``rels`` in the project repo.

    Returns ``{committed, sha, reason}``. ``reason`` explains a skip
    (``no_changes`` | ``not_a_repo``) or carries the git error on failure.
    """
    out: dict = {"committed": False, "sha": None, "reason": None}
    if not rels:
        out["reason"] = "no_changes"
        return out
    try:
        probe = _git(project_root, "rev-parse", "--is-inside-work-tree")
        if probe.returncode != 0 or probe.stdout.strip() != "true":
            out["reason"] = "not_a_repo"
            return out
        # Respect .gitignore: explicitly adding ignored paths is an error in
        # git, so drop them instead of forcing.
        ignored = set(
            _git(project_root, "check-ignore", "--", *rels).stdout.split("\n")
        )
        rels = [r for r in rels if r not in ignored]
        if not rels:
            out["reason"] = "no_changes"
            return out
        # Stage adds/modifications/deletions for exactly these paths.
        add = _git(project_root, "add", "-A", "--", *rels)
        if add.returncode != 0:
            out["reason"] = f"git add failed: {add.stderr.strip()}"
            return out
        staged = _git(project_root, "diff", "--cached", "--quiet", "--", *rels)
        if staged.returncode == 0:
            out["reason"] = "no_changes"
            return out
        # Partial commit limited to these paths — unrelated staged content in
        # the user's index is left untouched.
        commit = _git(project_root, "commit", "-m", message, "--", *rels)
        if commit.returncode != 0:
            out["reason"] = f"git commit failed: {commit.stderr.strip() or commit.stdout.strip()}"
            return out
        sha = _git(project_root, "rev-parse", "--short", "HEAD")
        out["committed"] = True
        out["sha"] = sha.stdout.strip() if sha.returncode == 0 else None
        return out
    except (OSError, _subprocess.TimeoutExpired) as e:
        out["reason"] = f"git unavailable: {e}"
        return out


RESOLVE_OPS = ("keep_agents", "keep_claude", "absorb_appendix")


def resolve_root(
    project: dict,
    registry: dict,
    project_name: str,
    backups_root: Path,
    *,
    rel_dir: str = "",
    op: str,
    installed: Optional[set[str]] = None,
) -> dict:
    """Explicit, never-merging resolution of a divergent or appended root pair."""
    if op not in RESOLVE_OPS:
        return {"applied": False, "error": f"unknown op '{op}'"}
    root = Path(project["path"]).expanduser()
    policy = _policy_for_project(project, registry, installed=installed)
    strategy = policy["strategy"]
    d = root / rel_dir if rel_dir else root
    claude_p = d / CLAUDE
    agents_p = d / CANONICAL

    cls = classify_directory(
        d,
        root,
        is_root=(rel_dir == ""),
        requires_claude=policy["requires_claude"],
        requires_agent=policy["requires_agent"],
        strategy=policy["strategy"],
    )
    verdict = cls["verdict"]
    backups: list[str] = []

    def backup(rel_base: str):
        b = _backup_rel(root, _rel_path(rel_dir, rel_base), project_name, backups_root)
        if b:
            backups.append(b)

    if op == "absorb_appendix":
        if verdict != "pointer_plus_content":
            return {
                "applied": False,
                "error": f"absorb_appendix requires pointer_plus_content (found {verdict})",
            }
        appendix = cls.get("appendix") or ""
        backup(CLAUDE)
        backup(CANONICAL)
        agents_txt = _read_text(agents_p) or ""
        if agents_txt and not agents_txt.endswith("\n"):
            agents_txt += "\n"
        agents_p.write_text(agents_txt + "\n" + appendix, encoding="utf-8")
        _write_derived(d, "import")
        if strategy == "symlink":
            _write_derived(d, "symlink")
        return {
            "applied": True,
            "op": op,
            "backups": backups,
            "touched": [_rel_path(rel_dir, CLAUDE), _rel_path(rel_dir, CANONICAL)],
        }

    if verdict not in ("conflict", "replaced_derived"):
        return {
            "applied": False,
            "error": f"{op} requires two real root files (found {verdict})",
        }
    if op == "keep_agents":
        backup(CLAUDE)
        _write_derived(d, strategy)
        return {
            "applied": True,
            "op": op,
            "backups": backups,
            "touched": [_rel_path(rel_dir, CLAUDE)],
        }
    # keep_claude
    backup(CLAUDE)
    backup(CANONICAL)
    content = _read_text(claude_p)
    if content is None:
        return {"applied": False, "error": f"cannot read {CLAUDE}"}
    agents_p.write_text(content, encoding="utf-8")
    _write_derived(d, strategy)
    return {
        "applied": True,
        "op": op,
        "backups": backups,
        "touched": [_rel_path(rel_dir, CLAUDE), _rel_path(rel_dir, CANONICAL)],
    }
