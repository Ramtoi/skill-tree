"""Skill frontmatter axis: parse, render, rewrite, validate, rename-patch.

Cut verbatim out of hub.py (wave 17 of AUDIT.md). A leaf: at module scope it
imports hub_core only, never hub or hub_cli (`_validate_harness_affinity`
imports the stdlib-only `harnesses` inside the function). hub.py re-imports
every name so `hub.<name>` keeps resolving.

Stub visibility: a call from one function here to another resolves through
this module, so `monkeypatch.setattr(hub, "<name>", …)` no longer reaches
it (`sync_skill_frontmatter_metadata` → `_validate_harness_affinity`,
`validate_registry_skills` → `skill_rename_patch`). A test that needs to
stub such an inner call patches `skill_meta.<name>` instead.
"""

import re
import sys
from pathlib import Path
from typing import Any, Optional

# isort: off
# `hub_core` must import BEFORE `yaml`: it prepends the vendored `vendor/`
# dir to sys.path, which is what lets `import yaml` resolve on a machine (or
# sandboxed test) with no system/user-site pyyaml — the same reason hub.py's
# own top does its own vendor priming ahead of its `import yaml`.
from skill_hub import hub_core
from skill_hub.hub_core import BOLD, RED, SLUG_RE, YELLOW, c, expand

import yaml
# isort: on


def skill_source(skill_cfg: dict) -> Path:
    # A registry entry with no `source` is a broken registry (hand-edit, partial
    # restore), not a programming error — say so instead of raising KeyError up
    # through whatever command happened to touch it.
    raw = (skill_cfg or {}).get("source") if isinstance(skill_cfg, dict) else None
    if not isinstance(raw, str) or not raw.strip():
        hub_core.fail(
            "Registry entry is missing its `source:` path — repair "
            f"{hub_core.registry_file()} (or re-import the skill)."
        )
    p = expand(raw)
    # for mcp-server, source may point to a dir without SKILL.md — that's fine
    return p


def skill_affinity(skill_cfg: dict) -> Optional[set[str]]:
    """Return the skill's harness affinity set, or None if absent (= all).

    Moved here from `sync_engine._skill_affinity` (usage-loadout-analytics
    design D1): a leaf module needs this to filter a footprint composition or
    a loadout row without importing `sync_engine`, which reaches the
    monolith. `sync_engine.py` re-exports the name so every existing caller
    keeps resolving.
    """
    h = skill_cfg.get("harnesses")
    if not h:
        return None
    return set(h)


def hub_skills_dir() -> Path:
    """Where user-owned skills live (data home)."""
    return hub_core.data_home() / "skills"


def hub_mcp_servers_dir() -> Path:
    return hub_core.data_home() / "mcp-servers"


def parse_skill_frontmatter_name(skill_md: Path) -> Optional[str]:
    meta = parse_skill_frontmatter(skill_md)
    if not meta:
        return None
    name = meta.get("name")
    return str(name).strip() if name else None


def parse_frontmatter_text(text: str) -> Optional[dict]:
    """Parse a SKILL.md's leading `---` frontmatter block from a STRING.

    The string-based twin of `parse_skill_frontmatter` (which reads a path), for
    callers holding the bytes but no file — e.g. skillpack validation, which must
    inspect the SKILL.md blob BEFORE it is allowed anywhere near the disk.
    """
    if not isinstance(text, str) or not text.lstrip().startswith("---"):
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


# The `name:` KEY line inside a frontmatter block — anchored at column 0 so an
# indented continuation line (a block-scalar description mentioning "name: x")
# can never match.
_FRONTMATTER_NAME_LINE_RE = re.compile(r"^name:[ \t]*.*$", re.MULTILINE)

# A genuine fenced frontmatter block: an opening `---` line, the body
# (captured, non-greedy), and a REAL closing `---` line — each fence on its
# own line, newline-terminated. Used to verify a rewrite produced a file a
# real fenced-frontmatter parser can still read (R1): the naive
# `text.split("---", 2)` a rewrite might verify itself against still
# produces 3 parts even when the closing fence got glued onto the last
# content line with no newline before it.
_FENCED_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.S)


def rewrite_frontmatter_name(text: str, new_name: str) -> Optional[str]:
    """Return `text` with the frontmatter `name:` line set to `new_name`.

    Frontmatter-aware and fail-closed: only the leading `---` block is touched,
    only the `name:` KEY line is replaced (quoted values included), and the
    result is re-parsed to confirm the new name actually took. Returns None when
    the rewrite could not be made — callers must treat that as a failure rather
    than shipping a file whose advertised name disagrees with its registry key.
    """
    if not isinstance(text, str) or not text.lstrip().startswith("---"):
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None
    front, count = _FRONTMATTER_NAME_LINE_RE.subn(
        lambda _m: f"name: {new_name}", parts[1], count=1
    )
    if count != 1:
        return None
    rewritten = f"{parts[0]}---{front}---{parts[2]}"
    meta = parse_frontmatter_text(rewritten)
    if not meta or str(meta.get("name") or "").strip() != new_name:
        return None
    return rewritten


def parse_skill_frontmatter(skill_md: Path) -> Optional[dict]:
    """Return the parsed frontmatter dict, or None if missing/invalid."""
    if not skill_md.exists():
        return None
    try:
        text = skill_md.read_text()
    except OSError:
        return None
    return parse_frontmatter_text(text)


def _validate_harness_affinity(values: list[str], context: str) -> list[str]:
    """Filter a `harnesses:` list to known ids; warn (don't reject) on unknown.

    Per spec, unknown ids are forward-compat: log a warning, accept the field,
    but treat the unknown id as inert at resolution time.
    """
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

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

# Rename variants (see the variant section further down): a SOURCE-MANAGED skill
# registered under a key that differs from its upstream `name:` — the `suffix`
# conflict decision of `hub source add git` — is synced through a variant whose
# SKILL.md carries the registry key, because a harness identifies a skill by its
# frontmatter name and would otherwise see two skills claiming the same name.
RENAME_VARIANT_MODE = "renamed"

RENAME_MARKER_COMMENT = (
    "# name managed by Skill Tree (registered under a different key) — "
    "edit the upstream source, not this file"
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


def render_name_frontmatter(
    text: str, name: str, generated_marker: bool = False
) -> Optional[str]:
    """Return SKILL.md text with the frontmatter `name:` rewritten to `name`.

    The name-line rewrite itself is `rewrite_frontmatter_name` — ONE regex, one
    fail-closed verification, shared with `hub skill import --name` and
    `hub rename`. This wrapper adds only what the rename VARIANT needs on top:
    a slug guard (an unquoted emit must be safe), removal of a stale generated
    marker so re-rendering is byte-stable, and re-insertion of that marker.

    Returns None when the frontmatter is missing/unparseable, declares no
    `name:`, or fails verification — callers must refuse rather than corrupt.
    """
    if not isinstance(name, str) or not SLUG_RE.match(name):
        # Only bare slugs are safe to emit unquoted (and every registry key is one).
        return None
    if not isinstance(text, str) or not text.lstrip().startswith("---"):
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None

    # Drop a previous marker line first, so rendering an already-rendered file
    # yields the same bytes instead of stacking markers.
    front_lines = [
        ln for ln in parts[1].split("\n") if ln.strip() != RENAME_MARKER_COMMENT
    ]
    stripped = parts[0] + "---" + "\n".join(front_lines) + "---" + parts[2]

    rewritten = rewrite_frontmatter_name(stripped, name)
    if rewritten is None:
        return None
    if not generated_marker:
        return rewritten

    r_parts = rewritten.split("---", 2)
    if len(r_parts) < 3:
        return None
    kept = r_parts[1].split("\n")
    trailing = ""
    if kept and kept[-1] == "":
        kept = kept[:-1]
        trailing = "\n"
    marked = (
        r_parts[0]
        + "---"
        + "\n".join(kept + [RENAME_MARKER_COMMENT])
        + trailing
        + "---"
        + r_parts[2]
    )
    # Re-verify AFTER the marker insert: a comment must not disturb the name.
    meta = parse_frontmatter_text(marked)
    if not meta or str(meta.get("name") or "").strip() != name:
        return None
    return marked


def render_frontmatter_block(text: str, key: str, value: Optional[Any]) -> Optional[str]:
    """Rewrite one top-level frontmatter KEY to `value` (a whole-block, whole-value
    replace — for a compound key like `ships_with:`, not a scalar), or remove the
    key entirely when `value` is `None`.

    Extent = the column-0 `^<key>:` line through the next column-0 non-blank line
    (or the end of the frontmatter) — the same anchoring posture as
    `_FRONTMATTER_NAME_LINE_RE`, so an indented continuation of another key (a
    `description:` block scalar, say) can never be mistaken for `key`'s own
    line, and `key`'s own nested/indented value can never leak past its block.
    Renders `yaml.safe_dump({key: value}, sort_keys=False, allow_unicode=True)`
    for the replacement span, so comments inside the OLD block are dropped.

    Fail-closed (W4): returns `None` — never corrupting the file — when the
    frontmatter is missing/unparseable, or when re-parsing the rewritten text
    does not verify `parse(new) == {**parse(old), key: value}` (with `key`
    absent from the expected dict when `value is None`)."""
    if not isinstance(key, str) or not key:
        return None
    if not isinstance(text, str) or not text.lstrip().startswith("---"):
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None
    try:
        old_meta = yaml.safe_load(parts[1]) or {}
    except yaml.YAMLError:
        return None
    if not isinstance(old_meta, dict):
        return None

    lines = parts[1].split("\n")
    key_line_re = re.compile(rf"^{re.escape(key)}:[ \t]*.*$")
    start: Optional[int] = None
    for i, ln in enumerate(lines):
        if key_line_re.match(ln):
            start = i
            break

    rendered_lines: list[str] = []
    if value is not None:
        dumped = yaml.safe_dump({key: value}, sort_keys=False, allow_unicode=True)
        rendered_lines = dumped.rstrip("\n").split("\n")

    if start is None:
        # Key absent today: insert (or, when `value is None`, do nothing) right
        # before the trailing blank element the leading fence's split leaves —
        # the same insertion point `render_invocation_frontmatter` uses.
        kept = lines
        trailing = ""
        if kept and kept[-1] == "":
            kept = kept[:-1]
            trailing = "\n"
        new_front = "\n".join(kept + rendered_lines) + trailing
    else:
        end = len(lines)
        for j in range(start + 1, len(lines)):
            ln = lines[j]
            if ln and not ln[0].isspace():
                end = j
                break
        if end == len(lines) and lines and lines[-1] == "":
            # R1: `key` was the LAST frontmatter key — the scan above never
            # found a following column-0 line, so `end` still points PAST
            # the trailing `""` element that carries the newline before the
            # closing fence. Clamp back by one so that newline survives the
            # splice instead of being swallowed — without this, the closing
            # `---` glues onto the last rendered content line with no
            # newline between them, and no fenced-frontmatter parser can
            # read the file again.
            end = len(lines) - 1
        new_front = "\n".join(lines[:start] + rendered_lines + lines[end:])

    new_text = parts[0] + "---" + new_front + "---" + parts[2]

    # R1 hardening: require a REAL fenced-frontmatter shape (a genuine
    # newline-terminated closing `---` line), not just "the naive split
    # produces 3+ parts" — the corrupt output this bug used to produce
    # (`...  - b---\nBody.\n`) still splits into 3 parts on `"---"`, so the
    # old re-parse-and-compare check could not see the corruption.
    fence_match = _FENCED_FRONTMATTER_RE.match(new_text)
    if fence_match is None:
        return None
    try:
        new_meta = yaml.safe_load(fence_match.group(1)) or {}
    except yaml.YAMLError:
        return None
    if not isinstance(new_meta, dict):
        return None
    expected = dict(old_meta)
    if value is None:
        expected.pop(key, None)
    else:
        expected[key] = value
    if new_meta != expected:
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

        # `ships_with:` mirror (deferred import: ships_with.py imports this
        # module at module scope, so the reverse direction must be lazy to
        # avoid a circular import). Frontmatter is authoritative: an absent
        # OR malformed block both normalize to None and delete the mirror.
        from skill_hub.domain.skills import ships_with as _ships_with

        def _sync_warn(message: str, _name=name) -> None:
            print(f"  {c('!', YELLOW)} skill '{_name}': {message}", file=sys.stderr)

        normalized = _ships_with.normalize_block(
            meta.get("ships_with"), skill_source(cfg), warn=_sync_warn
        )
        if normalized is None:
            if "ships_with" in cfg:
                del cfg["ships_with"]
                changed = True
        elif cfg.get("ships_with") != normalized:
            cfg["ships_with"] = normalized
            changed = True
    return changed


def validate_registry_skills(registry: dict):
    skills = registry.get("skills", {})
    seen_names: dict[str, str] = {}
    errors: list[str] = []
    warnings: list[str] = []

    for registry_name, cfg in skills.items():
        if cfg.get("type") == "mcp-server":
            # A leaf-friendly local import (mcp_spec is stdlib-only at module
            # scope; importing it eagerly here would pull it into every
            # `hub_core`-only leaf that imports skill_meta at module scope).
            from skill_hub.domain.mcp import mcp_spec

            mcp_errors, mcp_warnings = mcp_spec.validate_mcp_entry(registry_name, cfg)
            errors.extend(mcp_errors)
            warnings.extend(mcp_warnings)

            owner = seen_names.get(registry_name)
            if owner and owner != registry_name:
                errors.append(
                    f"duplicate skill name '{registry_name}' declared by both "
                    f"'{owner}' and '{registry_name}'"
                )
            else:
                seen_names[registry_name] = registry_name
            continue

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

        # The name a harness will actually see. Normally the frontmatter name;
        # for a SOURCE-MANAGED skill registered under a different key (the
        # `suffix` conflict decision of `hub source add git`) hub cannot rewrite
        # the upstream checkout, so it syncs a rename VARIANT carrying the
        # registry key — and the effective name is that key.
        effective_name = frontmatter_name
        if frontmatter_name != registry_name:
            if skill_rename_patch(registry_name, cfg) is not None:
                effective_name = registry_name
                warnings.append(
                    f"{registry_name}: upstream frontmatter name is "
                    f"'{frontmatter_name}' ({skill_md}); source-managed files are "
                    f"never rewritten — syncing a renamed variant that declares "
                    f"'{registry_name}'"
                )
            else:
                errors.append(
                    f"{registry_name}: frontmatter name is '{frontmatter_name}' in "
                    f"{skill_md}; must match registry key to avoid collisions"
                )

        owner = seen_names.get(effective_name)
        if owner and owner != registry_name:
            errors.append(
                f"duplicate skill name '{effective_name}' declared by both '{owner}' and '{registry_name}'"
            )
        else:
            seen_names[effective_name] = registry_name

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


def _skill_is_source_managed(skill_cfg: dict) -> bool:
    """True when the skill's files live in a checkout hub must never rewrite.

    `managed: external` (a registered source) or a recorded `origin.source` —
    both mean "these bytes belong to somebody else's repo". Hub-owned skills
    (data-home library, starter assets) are excluded: there a key/name mismatch
    is corruption hub can and should refuse.
    """
    if not isinstance(skill_cfg, dict):
        return False
    if skill_cfg.get("managed") == "external":
        return True
    origin = skill_cfg.get("origin")
    return isinstance(origin, dict) and bool(origin.get("source"))


def skill_rename_patch(skill_name: str, skill_cfg: dict) -> Optional[str]:
    """Patched SKILL.md text for a source-managed skill whose upstream `name:`
    differs from its registry key — the one definition of "renamed".

    Returns None (no rename in play) when the names already agree, the skill is
    hub-owned, it is not a claude-skill, or its SKILL.md is unreadable /
    unparseable / carries no `name:` — the last case being what makes
    `validate_registry_skills` fall back to the hard error.

    Pure: reads the upstream file, writes nothing. `effective_skill_source`
    materializes it for symlink consumers; content consumers (pack/zip export,
    remote push) substitute it in memory, because hub's content walkers
    deliberately do not follow symlinks out of a skill dir.
    """
    if not isinstance(skill_cfg, dict):
        return None
    # Same gate as `validate_registry_skills`: only claude-skills have a
    # SKILL.md whose `name:` a harness reads. mcp-servers (and any future type)
    # are out of scope, and a typeless entry is not a claude-skill either.
    if skill_cfg.get("type") != "claude-skill":
        return None
    if not _skill_is_source_managed(skill_cfg):
        return None
    raw = skill_cfg.get("source")
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        text = (expand(raw) / "SKILL.md").read_text()
    except OSError:
        return None
    meta = parse_frontmatter_text(text)
    if not meta:
        return None
    raw_name = meta.get("name")
    upstream_name = str(raw_name).strip() if raw_name is not None else ""
    if not upstream_name or upstream_name == skill_name:
        return None
    return render_name_frontmatter(text, skill_name, generated_marker=True)
