"""`hub skill` — portable `.skillpack` sharing + the cross-reference graph.

A skillpack is a SINGLE JSON envelope (not a tarball) so a recipient can read
every byte before it lands on disk: the app previews name/version/description
and the full file list before the user confirms. Text files ride as `utf8`,
anything undecodable as `base64`; the file list is sorted so the same skill
always produces the same bytes.

v1 refuses `type: mcp-server` in BOTH directions — an MCP entry's runtime
block (`command`/`args`/`env`) lives in the registry, and `env` can hold
secrets. Sharing one safely needs a redaction story we deliberately defer.

`hub skill refs` is unrelated in mechanism (it reads `skill_refs.py`, not the
pack format) but shares the `skill` subcommand word, so it lives here too.

Carved out of `hub.py` (S5 slice C) — see `hub_cli/__init__.py` for the
module contract this file implements (`NAME`, `register`, `dispatch`).
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import sys
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any, Optional

from skill_hub import hub_core
from skill_hub.application.skills.import_scanner import _read_registry_optional
from skill_hub.domain.skills.skill_meta import VALID_INVOCATIONS, skill_invocation
from skill_hub.entrypoints.cli.hook import _hook_attach, _hook_detach, _hook_new
from skill_hub.entrypoints.cli.permissions import _get_perm_block
from skill_hub.hub_core import (
    BOLD,
    CYAN,
    DIM,
    GREEN,
    RED,
    SEMVER_RE,
    SLUG_RE,
    VALID_SCOPES,
    YELLOW,
    c,
    collapse_home,
    data_home,
    expand,
    fail,
    parse_scope,
    registry_mutation,
    validate_slug,
    validate_version,
)
from skill_hub.infrastructure.registry.sources import skills_from_disabled_sources

NAME = "skill"

p_skill = None

SKILLPACK_FORMAT = "skill-tree-pack"
SKILLPACK_FORMAT_VERSION = 1
SKILLPACK_EXT = ".skillpack"

CLASSIFICATION_ENUMS = {
    "working_mode": ("inline", "delegator", "mixed"),
    "interaction_style": ("conversational", "checkpointed", "autonomous"),
    "maturity": ("experimental", "confident", "trusted"),
}


def register_set_meta_arguments(parser) -> None:
    """Register the top-level ``set-meta`` options on *parser*."""
    parser.add_argument("name", help="Skill name")
    parser.add_argument("--version", help="Semver version")
    parser.add_argument("--description", help="Registry description")
    parser.add_argument("--scope", choices=sorted(VALID_SCOPES), help="Skill scope")
    parser.add_argument("--upstream", help="Upstream URL (empty string clears it)")
    parser.add_argument(
        "--harnesses",
        help="Comma-separated harness affinity (claude-code,codex,pi). Empty string clears it.",
    )
    parser.add_argument(
        "--invocation",
        choices=list(VALID_INVOCATIONS),
        help="Select invocation intent. Native behavior varies by harness; "
        "inspect with hub skill invocation <name> --json.",
    )
    parser.add_argument(
        "--refs-ignore",
        help="Comma-separated names this skill's body mentions that are NOT "
        "references. Empty string clears it.",
    )
    parser.add_argument(
        "--classes-json", dest="classes_json", help="Classification classes as a JSON array"
    )
    parser.add_argument(
        "--outputs-json", dest="outputs_json", help="Classification outputs as a JSON array"
    )
    parser.add_argument(
        "--working-mode", dest="working_mode", help="Classification working mode (empty clears it)"
    )
    parser.add_argument(
        "--interaction-style",
        dest="interaction_style",
        help="Classification interaction style (empty clears it)",
    )
    parser.add_argument(
        "--maturity", dest="maturity", help="Classification maturity (empty clears it)"
    )


def register(sub) -> None:
    global p_skill

    # skill (portable .skillpack sharing)
    p_skill = sub.add_parser(
        "skill", help="Share skills as portable .skillpack files"
    )
    skill_sub = p_skill.add_subparsers(dest="skill_cmd")
    p_skill_export = skill_sub.add_parser(
        "export", help="Write a registered skill out as a .skillpack file"
    )
    p_skill_export.add_argument("name", help="Skill name")
    p_skill_export.add_argument(
        "--out", help="Output path (default: ./<name>.skillpack, or ./<name>.zip)"
    )
    p_skill_export.add_argument(
        "--format",
        choices=["pack", "zip"],
        default="pack",
        help="pack = portable .skillpack envelope (default); "
        "zip = deterministic <skill>/SKILL.md archive for manual cloud upload",
    )
    p_skill_export.add_argument("--json", action="store_true", help="Emit JSON")
    p_skill_import = skill_sub.add_parser(
        "import", help="Import a .skillpack file into the hub"
    )
    p_skill_import.add_argument("file", help="Path to the .skillpack file")
    p_skill_import.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate + preview the pack without writing anything",
    )
    p_skill_import.add_argument(
        "--name", help="Import under this name instead of the pack's own"
    )
    p_skill_import.add_argument("--json", action="store_true", help="Emit JSON")
    p_skill_refs = skill_sub.add_parser(
        "refs", help="Show the skill cross-reference graph, or one skill's refs"
    )
    p_skill_refs.add_argument(
        "name", nargs="?", help="Skill name (omit for the whole graph)"
    )
    p_skill_refs.add_argument("--json", action="store_true", help="Emit JSON")
    p_inv = skill_sub.add_parser("invocation", help="Read native invocation outcomes and mode previews")
    p_inv.add_argument("name", help="Skill name")
    p_inv.add_argument("--project", dest="project", help="Resolve this project's destinations and override")
    p_inv.add_argument("--json", dest="json", action="store_true")
    from skill_hub.entrypoints.cli import companions as _companions

    _companions.register_companions(skill_sub)


def dispatch(args) -> None:
    sk = getattr(args, "skill_cmd", None)
    if sk == "export":
        cmd_skill_export(args)
    elif sk == "import":
        cmd_skill_import(args)
    elif sk == "refs":
        cmd_skill_refs(args)
    elif sk == "invocation":
        cmd_skill_invocation(args)
    elif sk == "companions":
        from skill_hub.entrypoints.cli import companions as _companions

        _companions.dispatch_companions(args)
    else:
        p_skill.print_help()


# ─────────────────────────────────────────────────────────────────────────────
# hub skill export / import — the portable `.skillpack` format (v1)
# ─────────────────────────────────────────────────────────────────────────────


def build_skill_pack(name: str, cfg: dict, root) -> dict:
    """Assemble the v1 pack envelope for one registered skill."""
    import hub

    skill: dict = {
        "name": name,
        "version": cfg.get("version") or "1.0.0",
        "description": cfg.get("description") or "",
        "type": cfg.get("type") or "claude-skill",
        "scope": cfg.get("scope") or "portable",
    }
    harnesses = cfg.get("harnesses")
    if isinstance(harnesses, list) and harnesses:
        skill["harnesses"] = [str(h) for h in harnesses]
    invocation = cfg.get("invocation")
    if invocation in hub.VALID_INVOCATIONS:
        skill["invocation"] = invocation
    files = hub.collect_skill_pack_files(root)
    # A renamed source-managed skill ships the PATCHED SKILL.md, so the pack's
    # envelope name and its frontmatter agree — import validates that they do.
    apply_skill_rename_to_pack_files(name, cfg, files)
    return {
        "format": SKILLPACK_FORMAT,
        "format_version": SKILLPACK_FORMAT_VERSION,
        "skill": skill,
        "files": files,
    }


def _ascii_identity(value: str) -> str:
    return "".join(chr(ord(ch) + 32) if "A" <= ch <= "Z" else ch for ch in value)


def _classification_preflight(args) -> dict[str, Any]:
    """Parse and validate every classification option before any write."""
    updates: dict[str, Any] = {}
    for option, field in (("classes_json", "classes"), ("outputs_json", "outputs")):
        raw = getattr(args, option, None)
        if raw is None:
            continue
        try:
            values = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as exc:
            fail(f"Invalid {option.replace('_', '-')} value: expected a JSON array ({exc}).")
        if not isinstance(values, list):
            fail(f"Invalid {option.replace('_', '-')} value: expected a JSON array.")
        normalized: list[str] = []
        seen: set[str] = set()
        for value in values:
            if not isinstance(value, str):
                fail(f"Invalid {option.replace('_', '-')} value: every label must be a string.")
            label = value.strip()
            if not label:
                continue
            identity = _ascii_identity(label)
            if identity not in seen:
                seen.add(identity)
                normalized.append(label)
        updates[field] = normalized
    for field in CLASSIFICATION_ENUMS:
        raw = getattr(args, field, None)
        if raw is None:
            continue
        if raw == "":
            updates[field] = None
        elif raw not in CLASSIFICATION_ENUMS[field]:
            fail(
                f"Invalid {field.replace('_', '-')} '{raw}'. Expected one of: "
                f"{', '.join(CLASSIFICATION_ENUMS[field])}."
            )
        else:
            updates[field] = raw
    return updates


def apply_skill_rename_to_pack_files(
    skill_name: str, skill_cfg: dict, files: list[dict]
) -> bool:
    """Substitute the patched SKILL.md into collected pack entries, in place.

    The content-side twin of `effective_skill_source`: exports read the upstream
    tree (variant dirs are symlink farms that hub's content walkers refuse to
    follow) and swap in the one file the rename touches. Returns True when a
    substitution happened.
    """
    import hub

    patched = hub.skill_rename_patch(skill_name, skill_cfg)
    if patched is None:
        return False
    for entry in files:
        if entry.get("path") == "SKILL.md":
            entry["encoding"] = "utf8"
            entry["content"] = patched
            return True
    return False


def _pack_path_error(raw: Any) -> Optional[str]:
    """Return a reason string when a pack file path is unsafe, else None."""
    if not isinstance(raw, str) or not raw.strip():
        return "empty or non-string path"
    if "\x00" in raw:
        return f"path contains a NUL byte: {raw!r}"
    # Reject backslashes outright: they are a Windows separator (and
    # `C:\x` / `\\server\share` are absolute) that POSIX parsing would
    # happily swallow as a single filename.
    if "\\" in raw:
        return f"path contains a backslash: {raw!r}"
    if raw.startswith("/"):
        return f"absolute path: {raw!r}"
    if re.match(r"^[A-Za-z]:", raw):
        return f"absolute path: {raw!r}"
    parts = PurePosixPath(raw).parts
    if not parts:
        return f"empty path: {raw!r}"
    for part in parts:
        if part == "..":
            return f"path escapes the skill dir: {raw!r}"
        if part in ("", "."):
            return f"malformed path: {raw!r}"
    return None


def _skillpack_frontmatter_errors(
    skill_md: Optional[bytes], envelope_name: Optional[str]
) -> list[str]:
    """Check the SKILL.md blob's own frontmatter against the envelope name.

    The envelope name becomes the registry key AND the directory name, while the
    harness reads the name out of SKILL.md. `validate_registry_skills` treats any
    disagreement between the two as FATAL and exits — from inside `hub sync`,
    which every registry mutation reaches through `_auto_sync`. So a pack whose
    envelope says `innocent` while its SKILL.md says `evil` would import
    "successfully" and then wedge the whole hub. Catch it before it lands.
    """
    import hub

    if skill_md is None:
        return []
    try:
        text = skill_md.decode("utf-8")
    except UnicodeDecodeError:
        return ["SKILL.md is not valid UTF-8 text."]
    front = hub.parse_frontmatter_text(text)
    if front is None:
        return ["SKILL.md has no readable `---` frontmatter block."]
    raw_name = front.get("name")
    front_name = str(raw_name).strip() if raw_name is not None else ""
    if not front_name:
        return ["SKILL.md frontmatter is missing a `name:` field."]
    if envelope_name and front_name != envelope_name:
        return [
            f"Name mismatch: the pack declares skill '{envelope_name}' but its "
            f"SKILL.md frontmatter says '{front_name}'. Importing it would break "
            f"`hub sync` for every skill."
        ]
    return []


def validate_skill_pack(pack: Any) -> tuple[list[str], dict]:
    """Fail-closed validation of a parsed pack.

    Returns `(errors, meta)`. `meta` carries whatever could be read (for the
    dry-run preview) plus `_blobs` — the decoded bytes per path — and `_exec`
    (relpaths to chmod 0o755) / `_exec_ignored` (a carried `true` outside
    `scripts/`), all three populated only when `errors` is empty.
    """
    import hub

    errors: list[str] = []
    meta: dict = {
        "name": None,
        "version": None,
        "description": None,
        "type": None,
        "scope": None,
        "files": [],
        "harnesses": None,
        "invocation": None,
        "_blobs": {},
        "_exec": set(),
        "_exec_ignored": [],
    }

    if not isinstance(pack, dict):
        return ["Not a skillpack: top level is not a JSON object."], meta

    fmt = pack.get("format")
    if fmt != SKILLPACK_FORMAT:
        errors.append(
            f"Unknown format {fmt!r} (expected {SKILLPACK_FORMAT!r})."
        )
    version = pack.get("format_version")
    if version != SKILLPACK_FORMAT_VERSION:
        errors.append(
            f"Unsupported format_version {version!r} (this hub reads "
            f"{SKILLPACK_FORMAT_VERSION})."
        )

    skill = pack.get("skill")
    if not isinstance(skill, dict):
        errors.append("Missing or malformed `skill` block.")
        skill = {}

    name = skill.get("name")
    if not isinstance(name, str) or not name.strip():
        errors.append("Missing skill name.")
    else:
        name = name.strip()
        meta["name"] = name
        if not SLUG_RE.match(name):
            errors.append(
                f"Invalid skill name '{name}'. Use lowercase letters, numbers, "
                f"and hyphens only."
            )

    pack_version = skill.get("version") or "1.0.0"
    if not isinstance(pack_version, str) or not SEMVER_RE.match(pack_version):
        errors.append(f"Invalid version {skill.get('version')!r}. Expected semver like 1.2.3.")
        pack_version = None
    meta["version"] = pack_version

    description = skill.get("description")
    meta["description"] = description if isinstance(description, str) else ""

    s_type = skill.get("type") or "claude-skill"
    meta["type"] = s_type
    if s_type == "mcp-server":
        errors.append(
            "MCP servers cannot be shared as a skillpack (their runtime config "
            "and env may hold secrets)."
        )
    elif s_type != "claude-skill":
        errors.append(f"Unknown skill type {s_type!r} (expected 'claude-skill').")

    scope = skill.get("scope") or "portable"
    meta["scope"] = scope
    if scope not in VALID_SCOPES:
        errors.append(
            f"Invalid scope {scope!r}. Expected one of: {', '.join(sorted(VALID_SCOPES))}."
        )

    harnesses = skill.get("harnesses")
    if harnesses is not None:
        if isinstance(harnesses, list) and all(isinstance(h, str) for h in harnesses):
            meta["harnesses"] = [h.strip() for h in harnesses if h.strip()]
        else:
            errors.append("`skill.harnesses` must be a list of strings.")
    invocation = skill.get("invocation")
    if invocation is not None:
        if invocation in hub.VALID_INVOCATIONS:
            meta["invocation"] = invocation
        else:
            errors.append(
                f"Invalid invocation {invocation!r}. Expected one of: "
                f"{', '.join(hub.VALID_INVOCATIONS)}."
            )

    files = pack.get("files")
    if not isinstance(files, list) or not files:
        errors.append("Pack contains no files.")
        return errors, meta

    # Dedupe on the NFC-normalized, case-folded path, not the raw string: on a
    # case-insensitive / normalizing filesystem (APFS, NTFS) `SKILL.md` +
    # `skill.md`, or NFC/NFD twins of `café.txt`, are ONE inode. Accepting both
    # would mean the file the user previewed is not the file that lands.
    seen: set[str] = set()
    seen_exact: set[str] = set()
    blobs: dict[str, bytes] = {}
    listing: list[dict] = []
    exec_set: set[str] = set()
    exec_ignored: list[str] = []
    for entry in files:
        if not isinstance(entry, dict):
            errors.append(f"Malformed file entry: {entry!r}")
            continue
        raw_path = entry.get("path")
        path_error = _pack_path_error(raw_path)
        if path_error:
            errors.append(f"Unsafe file path — {path_error}")
            continue
        rel = PurePosixPath(raw_path).as_posix()
        key = unicodedata.normalize("NFC", rel).casefold()
        if key in seen:
            if rel in seen_exact:
                errors.append(f"Duplicate file path: {rel}")
            else:
                errors.append(
                    f"Colliding file path: {rel} — differs only by case or "
                    f"Unicode normalization from another entry, and would "
                    f"overwrite it on a case-insensitive filesystem."
                )
            continue
        seen.add(key)
        seen_exact.add(rel)
        try:
            data = hub.decode_skill_pack_entry(entry)
        except ValueError as exc:
            errors.append(f"{rel}: {exc}")
            continue
        blobs[rel] = data
        listing.append({"path": rel, "bytes": len(data)})
        if entry.get("executable") is True:
            if hub.pack_entry_is_executable(entry):
                exec_set.add(rel)
            else:
                exec_ignored.append(rel)

    listing.sort(key=lambda e: e["path"])
    meta["files"] = listing
    if "SKILL.md" not in seen_exact:
        errors.append("Pack is missing SKILL.md at the skill root.")
    else:
        errors.extend(_skillpack_frontmatter_errors(blobs.get("SKILL.md"), meta["name"]))

    if not errors:
        meta["_blobs"] = blobs
        meta["_exec"] = exec_set
        meta["_exec_ignored"] = sorted(exec_ignored)
        for f in listing:
            if f["path"] in exec_set:
                f["executable"] = True
    return errors, meta


def _skillpack_fail(message: str, json_mode: bool, errors: Optional[list] = None):
    """Uniform error exit that stays machine-readable under `--json`."""
    if json_mode:
        payload = {"error": message}
        if errors:
            payload["errors"] = errors
        print(json.dumps(payload))
    else:
        print(message, file=sys.stderr)
        for err in errors or []:
            print(f"  - {err}", file=sys.stderr)
    sys.exit(1)


def cmd_skill_export(args):
    """Write one registered skill out as a `.skillpack` (default) or a `.zip`.

    Read-only: no registry mutation, no lock, no sync.

    `--format pack` is the portable hub-to-hub envelope (unchanged). `--format
    zip` is the manual-upload artifact for cloud surfaces — a byte-reproducible
    archive in claude.ai's required `<skill>/SKILL.md` layout, built by the same
    code `hub cloud export` uses. Both formats refuse `type: mcp-server`.
    """
    import hub
    from skill_hub.infrastructure.filesystem import cloud_targets

    json_mode = bool(getattr(args, "json", False))
    fmt = getattr(args, "format", None) or "pack"
    name = args.name
    registry = hub_core.load_registry()
    skills = registry.get("skills") or {}

    if name not in skills:
        _skillpack_fail(f"Unknown skill '{name}'.", json_mode)
    cfg = skills[name]

    if cfg.get("type") == "mcp-server":
        _skillpack_fail(
            f"'{name}' is an MCP server — export is limited to skills in v1 "
            f"(its runtime config and env may hold secrets).",
            json_mode,
        )

    root = hub.skill_source(cfg)
    if not root.is_dir():
        _skillpack_fail(
            f"Source directory for '{name}' not found: {root}", json_mode
        )

    if fmt == "zip":
        out_arg = getattr(args, "out", None)
        if out_arg:
            out = Path(out_arg).expanduser()
        else:
            # The default filename is derived from the registry KEY, so a
            # hand-edited path-shaped name must be refused, not turned into one.
            try:
                out = Path(cloud_targets.zip_name_for(name))
            except ValueError as exc:
                _skillpack_fail(str(exc), json_mode)
        try:
            built = cloud_targets.build_skill_zip(
                name, root, out, hub.skill_rename_patch(name, cfg)
            )
        except OSError as exc:
            _skillpack_fail(f"Cannot write {out}: {exc}", json_mode)
        if json_mode:
            print(
                json.dumps(
                    {
                        "exported": name,
                        "out": built["zip_path"],
                        "files": built["files"],
                        "format": "zip",
                        "sha256": built["sha256"],
                    }
                )
            )
        else:
            print(
                f"{c('✓', GREEN)} exported '{name}' → {built['zip_path']} "
                f"({built['files']} file(s), sha256 {built['sha256'][:12]})"
            )
        return

    pack = build_skill_pack(name, cfg, root)
    out = Path(getattr(args, "out", None) or f"{name}{SKILLPACK_EXT}").expanduser()
    try:
        if out.parent and not out.parent.exists():
            out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(pack, indent=2, ensure_ascii=False) + "\n")
    except OSError as exc:
        _skillpack_fail(f"Cannot write {out}: {exc}", json_mode)

    count = len(pack["files"])
    if json_mode:
        print(
            json.dumps(
                {
                    "exported": name,
                    "out": str(out),
                    "files": count,
                    "format": "pack",
                }
            )
        )
    else:
        print(f"{c('✓', GREEN)} exported '{name}' → {out} ({count} file(s))")


def _read_skill_pack(path_str: str, json_mode: bool) -> Any:
    path = Path(path_str).expanduser()
    if not path.is_file():
        _skillpack_fail(f"Pack file not found: {path}", json_mode)
    try:
        raw = path.read_text()
    except OSError as exc:
        _skillpack_fail(f"Cannot read {path}: {exc}", json_mode)
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        _skillpack_fail(f"{path} is not valid JSON: {exc}", json_mode)


def _skillpack_collision(final_name: str, registry: dict) -> tuple[bool, Optional[dict]]:
    """Would importing under `final_name` clash with what's already here?"""
    import hub

    skills = registry.get("skills") or {}
    existing = None
    if final_name in skills:
        cfg = skills[final_name]
        existing = {
            "version": cfg.get("version"),
            "source": cfg.get("source"),
            "scope": cfg.get("scope"),
        }
    # lexists, not exists: a DANGLING symlink at the destination is still an
    # occupied path — `exists()` says False and the later mkdir then fails with a
    # bare EEXIST instead of our clean "already exists, pick another --name".
    dest_exists = os.path.lexists(hub.hub_skills_dir() / final_name)
    return (existing is not None or dest_exists), existing


def cmd_skill_refs(args):
    """Print the skill cross-reference graph, or one skill's refs.

    Read-only: no registry mutation, no lock, and no auto-sync — `--json`
    prints ONLY the JSON payload, nothing else on stdout.
    """
    import hub
    from skill_hub.domain.skills import skill_refs as _skill_refs

    json_mode = bool(getattr(args, "json", False))
    name = getattr(args, "name", None)
    registry = hub_core.load_registry()
    skills = registry.get("skills") or {}
    graph = _skill_refs.build_graph(registry)

    if not name:
        if json_mode:
            print(json.dumps(graph, indent=2))
            return
        edges = graph.get("edges", [])
        skill_set: set = set()
        for edge in edges:
            label = f"{edge['from']} → {edge['to']}"
            print(f"{label:<46}{edge['count']}×")
            skill_set.add(edge["from"])
            skill_set.add(edge["to"])
        print(f"\n{len(edges)} edges across {len(skill_set)} skills.")
        return

    if name not in skills:
        fail(f"Unknown skill '{name}'.")
    cfg = skills[name]

    refs_by_name: dict[str, int] = {}
    referenced_by: dict[str, int] = {}
    for edge in graph.get("edges", []):
        if edge["from"] == name:
            refs_by_name[edge["to"]] = refs_by_name.get(edge["to"], 0) + edge["count"]
        if edge["to"] == name:
            referenced_by[edge["from"]] = (
                referenced_by.get(edge["from"], 0) + edge["count"]
            )

    refs = [{"name": n, "count": c} for n, c in sorted(refs_by_name.items())]
    referenced = [{"name": n, "count": c} for n, c in sorted(referenced_by.items())]

    ignore_list = cfg.get("refs_ignore")
    if not isinstance(ignore_list, list):
        ignore_list = []
    ignored: list = []
    if ignore_list:
        text: Optional[str] = None
        try:
            patched = hub.skill_rename_patch(name, cfg)
            if isinstance(patched, str):
                text = patched
            else:
                text = (hub.skill_source(cfg) / "SKILL.md").read_text(encoding="utf-8")
        except Exception:
            text = None
        if text is not None:
            all_counts = _skill_refs.count_refs(text, set(skills.keys()), name, ())
            ignored = sorted(n for n in ignore_list if n in all_counts)

    if json_mode:
        print(
            json.dumps(
                {
                    "skill": name,
                    "refs": refs,
                    "referenced_by": referenced,
                    "ignored": ignored,
                },
                indent=2,
            )
        )
        return

    print(name)
    print()
    print("  MENTIONS")
    if refs:
        for r in refs:
            print(f"    {r['name']:<26}{r['count']}×")
    else:
        print("    (none)")
    print()
    print("  MENTIONED BY")
    if referenced:
        for r in referenced:
            print(f"    {r['name']:<26}{r['count']}×")
    else:
        print("    (none)")
    print()
    print("  IGNORED")
    if ignored:
        for n in ignored:
            print(f"    {n}")
    else:
        print("    (none)")


def cmd_skill_import(args):
    """Dispatch `hub skill import`.

    `--dry-run` is routed BEFORE the mutation wrapper so a preview never takes
    the lock, never writes the registry, and never appends an audit record.
    """
    if getattr(args, "dry_run", False):
        return _cmd_skill_import_dry_run(args)
    return _cmd_skill_import_apply(args)


def _cmd_skill_import_dry_run(args):
    json_mode = bool(getattr(args, "json", False))
    pack = _read_skill_pack(args.file, json_mode)
    errors, meta = validate_skill_pack(pack)

    override = getattr(args, "name", None)
    final_name = meta["name"]
    if override:
        override = override.strip()
        final_name = override
        if not SLUG_RE.match(override):
            errors.append(
                f"Invalid name '{override}'. Use lowercase letters, numbers, "
                f"and hyphens only."
            )

    collision, existing = (False, None)
    if final_name and SLUG_RE.match(final_name):
        registry = hub_core.load_registry()
        collision, existing = _skillpack_collision(final_name, registry)

    payload = {
        "valid": not errors,
        "errors": errors,
        "name": final_name,
        "version": meta["version"],
        "description": meta["description"],
        "type": meta["type"],
        "scope": meta["scope"],
        "files": meta["files"],
        "collision": collision,
        "existing": existing,
    }
    if json_mode:
        print(json.dumps(payload))
        return

    head = c("DRY-RUN", YELLOW)
    print(f"{head} import '{final_name}' from {args.file} (no changes made):")
    print(f"  version:     {payload['version']}")
    print(f"  type/scope:  {payload['type']} / {payload['scope']}")
    print(f"  description: {payload['description']}")
    for f in payload["files"]:
        suffix = " +x" if f.get("executable") else ""
        print(f"    {f['path']}  ({f['bytes']} B){suffix}")
    if collision:
        print(f"  {c('!', YELLOW)} '{final_name}' already exists — re-run with --name <other>")
    if errors:
        print(f"  {c('✗', RED)} pack is INVALID:")
        for err in errors:
            print(f"    - {err}")
    else:
        print(f"  {c('✓', GREEN)} pack is valid")


@registry_mutation("skill-import")
def _cmd_skill_import_apply(args):
    import hub

    json_mode = bool(getattr(args, "json", False))
    pack = _read_skill_pack(args.file, json_mode)
    errors, meta = validate_skill_pack(pack)
    if errors:
        _skillpack_fail(
            f"Refusing to import {args.file}: the pack is invalid.", json_mode, errors
        )

    pack_name = meta["name"]
    override = (getattr(args, "name", None) or "").strip()
    final_name = override or pack_name
    if override and not SLUG_RE.match(override):
        _skillpack_fail(
            f"Invalid name '{override}'. Use lowercase letters, numbers, and "
            f"hyphens only.",
            json_mode,
        )

    registry = hub_core.load_registry()
    collision, _existing = _skillpack_collision(final_name, registry)
    if collision:
        if override:
            _skillpack_fail(
                f"'{final_name}' already exists too — pick another --name.", json_mode
            )
        _skillpack_fail(
            f"'{final_name}' already exists. Re-run with --name <other-name> to "
            f"import it under a different name.",
            json_mode,
        )

    # Resolve the harness affinity BEFORE anything touches the disk: it can warn
    # or raise, and doing it after `dest.mkdir()` would strand a half-imported
    # directory with no registry entry pointing at it.
    affinity = (
        hub._validate_harness_affinity(meta["harnesses"], f"skill '{final_name}'")
        if meta["harnesses"]
        else None
    )

    dest = hub.hub_skills_dir() / final_name
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        dest.mkdir()
        for rel, data in sorted(meta["_blobs"].items()):
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        # Additive-only, `scripts/`-confined (#2): chmod exactly the flagged,
        # eligible entries — every other file is left at the mode `write_bytes`
        # gave it under the caller's own umask.
        for rel in sorted(meta["_exec"]):
            os.chmod(dest / rel, 0o755)
        if not (dest / "SKILL.md").is_file():
            raise OSError("SKILL.md missing after write")
        if override and override != pack_name and pack_name:
            # Keep the on-disk frontmatter `name:` in step with the directory we
            # imported into, or the harness advertises the pack's original name
            # AND `validate_registry_skills` fails the next sync. Frontmatter-
            # aware (quoted names included) and fail-closed: a rewrite we cannot
            # make is an aborted import, never a silent no-op.
            skill_md = dest / "SKILL.md"
            updated = hub.rewrite_frontmatter_name(skill_md.read_text(), final_name)
            if updated is None:
                raise ValueError(
                    f"cannot rewrite the SKILL.md frontmatter `name:` to "
                    f"'{final_name}' — refusing to import under a name its own "
                    f"SKILL.md contradicts"
                )
            skill_md.write_text(updated)
        if meta["invocation"]:
            # `sync_skill_frontmatter_metadata` treats SKILL.md as authoritative
            # for invocation on every sync — including when its flags are
            # absent, which it reads as `auto` — so a bare registry mirror with
            # no matching frontmatter would be silently reset on the very next
            # sync. Stamp it onto disk too, or the pack's declared mode never
            # survives past this command.
            skill_md = dest / "SKILL.md"
            skill_md_text = skill_md.read_text()
            existing_fm = hub.parse_frontmatter_text(skill_md_text)
            if existing_fm is None:
                # `validate_skill_pack` validates the envelope only — it never
                # parses SKILL.md content — so a pack can declare
                # `skill.invocation` while shipping a SKILL.md with no fenced
                # frontmatter block at all. That is a malformed pack, not a
                # reason to abort an otherwise-valid import: degrade to a
                # warning. The registry mirror still records the declared
                # value; the next sync's frontmatter reconcile will surface
                # the mismatch against the (absent) on-disk flags.
                print(
                    f"  {c('!', YELLOW)} '{final_name}': could not stamp "
                    f"invocation '{meta['invocation']}' onto SKILL.md — no "
                    f"fenced frontmatter block found; the registry keeps the "
                    f"declared value",
                    file=sys.stderr,
                )
            elif hub.invocation_from_frontmatter(existing_fm) != meta["invocation"]:
                updated_inv = hub.render_invocation_frontmatter(
                    skill_md_text, meta["invocation"]
                )
                if updated_inv is None:
                    raise ValueError(
                        f"cannot rewrite the SKILL.md invocation frontmatter to "
                        f"'{meta['invocation']}'"
                    )
                skill_md.write_text(updated_inv)
            # else: the on-disk frontmatter already encodes the declared
            # mode — skip the rewrite so the imported SKILL.md bytes match
            # the pack's exactly (byte-stable re-import of an already-flagged
            # pack).
    except (OSError, ValueError) as exc:
        shutil.rmtree(dest, ignore_errors=True)
        _skillpack_fail(f"Import failed, nothing was registered: {exc}", json_mode)

    entry = {
        "version": meta["version"],
        "description": meta["description"],
        "source": hub.collapse_home(dest),
        "type": "claude-skill",
        "scope": meta["scope"],
        "upstream": None,
    }
    if affinity is not None:
        entry["harnesses"] = affinity
    if meta["invocation"]:
        entry["invocation"] = meta["invocation"]

    try:
        skills = registry.setdefault("skills", {})
        skills[final_name] = entry
        hub_core.save_registry(registry)
    except Exception as exc:
        shutil.rmtree(dest, ignore_errors=True)
        _skillpack_fail(f"Import failed, nothing was registered: {exc}", json_mode)

    count = len(meta["files"])
    if meta["_exec_ignored"]:
        print(
            f"  {c('!', YELLOW)} ignored the executable flag outside scripts/: "
            f"{', '.join(meta['_exec_ignored'])}",
            file=sys.stderr,
        )
    if json_mode:
        print(json.dumps({"imported": final_name, "files": count}))
    else:
        print(f"  {c('✓', GREEN)} imported '{final_name}' ({count} file(s)) → {hub.collapse_home(dest)}")

    # Registry write is already durable; a sync-stream failure past this point
    # must never surface as an import failure, and stdout stays a clean
    # payload for `--json` callers — the chatter goes to stderr either way.
    # `_auto_sync_tail()` returns whether it came back clean — a swallowed
    # rc 1/2 is not a synced skill, so the human-facing "✓" line is gated on
    # it rather than printed unconditionally.
    with contextlib.redirect_stdout(sys.stderr):
        synced = hub._auto_sync_tail()
    if not json_mode:
        if synced:
            print(f"  {c('✓', GREEN)} synced — linked into your projects")
        else:
            print(
                f"  {c('!', YELLOW)} imported, but the trailing sync did not "
                f"finish cleanly — see the warning above"
            )


# ─────────────────────────────────────────────────────────────────────────────
# hub list
# ─────────────────────────────────────────────────────────────────────────────


def cmd_list(args):
    import hub

    registry = hub_core.load_registry()
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
            hub.resolve_project_skills(projects[project_filter], registry)
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
            invocation = hub.skill_invocation(cfg)
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


def _effective_skill_text(name: str, cfg: dict) -> Optional[str]:
    """The SKILL.md body `skill_refs` should scan for `name` — rename-patched
    when the skill is a suffix-renamed source import, else the on-disk file.
    `None` on any read failure (never raises)."""
    import hub

    try:
        patched = hub.skill_rename_patch(name, cfg)
        if isinstance(patched, str):
            return patched
        return (hub.skill_source(cfg) / "SKILL.md").read_text(encoding="utf-8")
    except Exception:
        return None


def _missing_refs_hint_for(
    skill_name: str, cfg: dict, proj_cfg: dict, registry: dict
) -> list[str]:
    """Registered, non-global names `skill_name`'s body mentions that are not
    (yet) active for `proj_cfg`. One file read via `count_refs` — never
    `build_graph` (a command that reads one skill must not read every skill).
    """
    import hub
    from skill_hub.domain.skills import skill_refs as _skill_refs

    text = _effective_skill_text(skill_name, cfg)
    if text is None:
        return []
    skills = registry.get("skills", {})
    ignore = cfg.get("refs_ignore")
    if not isinstance(ignore, list):
        ignore = []
    counts = _skill_refs.count_refs(text, set(skills.keys()), skill_name, ignore)
    active = set(hub.resolve_project_skills(proj_cfg, registry))
    missing = [
        n
        for n in counts
        if n not in active
        and isinstance(skills.get(n), dict)
        and skills[n].get("scope") != "global"
    ]
    return sorted(missing)


def _print_missing_refs_hint(skill_name: str, proj_name: str, missing: list[str]) -> None:
    print(
        f"  {c('!', YELLOW)} {skill_name} references {', '.join(missing)} — "
        f"not equipped on {proj_name}."
    )
    print(f"    Run: hub enable {skill_name} --project {proj_name} --with-refs")


# ─────────────────────────────────────────────────────────────────────────────
# ships_with companion provisioning (plans/0-direction.md D1-D6, plan 1 W2)
#
# `_apply_companions` / `_remove_companions` are the ledger-scoped transaction
# bodies behind `hub enable --with-companions`, `hub disable`, `hub project
# remove` and `hub archive`/`hub rename`. Both are IN-MEMORY only except the
# user-scope agent file writes/deletes `ships_with.render_agent_payload` and
# `subagents.save_agent`/`delete_agent` require — hooks and permission rules
# are registry mutations that reach native files on the next sync pass (no new
# writer, per plan 1's Approach).
# ─────────────────────────────────────────────────────────────────────────────


class _CompanionApplyError(Exception):
    """Raised by `_apply_companions` on a hard refuse (an unclaimed collision)
    or a mid-transaction write failure. The caller must not save the registry
    when this propagates — every filesystem write already made in this call is
    undone first, and the in-memory registry mutations are simply discarded."""


def _ships_with_block(skill_cfg: dict) -> Optional[dict]:
    """The declared `ships_with:` block, read from the SKILL.md FRONTMATTER —
    never the registry mirror (A4) — the same way `ships_with.plan_provision`
    resolves it. Returns `None` for an unresolvable/absent/malformed block."""
    from skill_hub.domain.skills import ships_with
    from skill_hub.domain.skills import skill_meta as _sm

    raw_source = skill_cfg.get("source")
    if not isinstance(raw_source, str) or not raw_source.strip():
        return None
    skill_dir = _sm.skill_source(skill_cfg)
    meta = _sm.parse_skill_frontmatter(skill_dir / "SKILL.md") or {}
    return ships_with.normalize_block(meta.get("ships_with"), skill_dir)


def _companion_claim_count(
    registry: dict, skill: str, kind: str, name: str, *, exclude: Optional[str] = None
) -> int:
    """How many (scope, skill) ledger entries — other than `exclude` (a
    project name OR `ships_with.GLOBAL_SCOPE`, C3) — still list `name` under
    `kind` ('hooks' | 'agents'). Used for the hard-refuse pre-check: a name
    that is not claimed by any ledger entry for THIS skill, anywhere
    (project OR global), is not ours to overwrite. Goes through
    `ships_with.ledger_scopes` (C3) so a project's pre-check also sees the
    global ledger and vice versa."""
    from skill_hub.domain.skills import ships_with

    count = 0
    for scope, container in ships_with.ledger_scopes(registry):
        if scope == exclude:
            continue
        entry = (container or {}).get(skill) or {}
        if name in (entry.get(kind) or []):
            count += 1
    return count


def _agent_write_would_differ(
    skill: str, agent_name: str, harness: str, registry: dict, existing_file: Path
) -> bool:
    """A23 (review R2/R3) — true when writing `agent_name` for `harness`
    would change `existing_file`'s CURRENT bytes (a real collision with a
    file no ledger claims); false when the render reproduces byte-identical
    content (an agent whose `<skill>/agents/<name>.md` was copied FROM this
    exact harness file is equal 'by construction'). Never re-implements
    Claude's YAML / Codex's TOML serialization here — it probes through the
    REAL per-harness renderer (`render_agent_payload` + `save_agent`) and
    restores the file's ORIGINAL bytes byte-for-byte before returning,
    whatever the answer, so this call leaves the file exactly as it found
    it either way; the caller decides separately whether a genuinely NEW
    write should land."""
    from skill_hub.domain.skills import ships_with
    from skill_hub.infrastructure.harnesses import subagent_links, subagents

    if subagent_links.find_link(agent_name, scope="user") is not None:
        # A pre-existing link record under this exact name is a rare,
        # unrelated collision the plain hard-refuse already covered safely —
        # writing through it risks co-writing a twin hub has no business
        # touching (R5's own hazard), so this path stays a hard refuse.
        return True
    original_bytes = existing_file.read_bytes()
    payload = ships_with.render_agent_payload(skill, agent_name, harness, registry, rerender=True)
    res = subagents.save_agent(payload, registry)
    if not res.get("ok"):
        return True
    written_path = Path(res["file"])
    differs = written_path.read_bytes() != original_bytes
    written_path.write_bytes(original_bytes)
    return differs


def _apply_companions(registry: dict, skill: str, project: Optional[str], plan: dict) -> dict:
    """Apply `plan['items']` (from `ships_with.plan_provision`) to `registry`.

    `project=None` (A17) applies against the GLOBAL scope (`companions_global`,
    `hooks_global`, `permissions_global`) instead of a project's own ledger —
    `plan` must itself have been built with `project=None` (no trust row is
    ever emitted there).

    Order mirrors plan 1's Transaction and rollback boundary: (1) hard-refuse
    pre-check, no mutation yet; (2) hooks/permissions/ledger mutated
    in-memory; (3) agent files written (the only filesystem writes) and
    linked when 2+ agent-capable harnesses; ledger entry set last. On any
    failure in (3) every agent file this call wrote — and any link it made —
    is undone, then `_CompanionApplyError` propagates; the caller must not
    save the registry (its in-memory mutations are simply discarded).

    Ledger v2 (A19/C2): every freshly-attached hook records
    `hook_state.<n>.attached` (= `_hook_attach`'s real return — was it US that
    newly added it, or was it already there?) and every freshly-added rule
    records `permissions[].added` (= not already present) — the flags
    `_remove_companions`/the sync-time reconcile gate a later removal on, so a
    plain re-provision can never mistake something the user attached by hand
    for something hub itself owns. `schema: 2` marks the entry as native v2 —
    never backfilled.

    Returns `{"agents", "hooks", "permissions", "kept", "kept_shared",
    "still_active_via"}` — the last three always empty here (they only apply
    to `_remove_companions`), kept for a uniform shape between the two.
    """
    from skill_hub.application.skills import ships_with_reconcile as swr
    from skill_hub.domain.hooks import hooks_model
    from skill_hub.domain.skills import ships_with
    from skill_hub.infrastructure.harnesses import subagent_links, subagents

    result: dict = {
        "agents": [], "hooks": [], "permissions": [],
        "kept": [], "kept_shared": [], "still_active_via": [],
    }

    skill_cfg = (registry.get("skills") or {}).get(skill) or {}
    raw_source = skill_cfg.get("source")
    if isinstance(raw_source, str) and raw_source.startswith("remote:"):
        raise _CompanionApplyError(
            f"'{skill}' is remote-quarantined (origin '{raw_source}') — "
            f"companions cannot be provisioned"
        )

    scope_global = project is None
    proj_cfg = registry["projects"][project] if project else None
    block = _ships_with_block(skill_cfg) or {}
    skill_dir = hub_core.expand(str(skill_cfg.get("source") or ""))

    if scope_global:
        ledger_ent = dict(ships_with.global_ledger(registry).get(skill) or {})
    else:
        ledger_ent = dict(ships_with.ledger_entry(proj_cfg, skill))
    ledger_hooks = list(ledger_ent.get("hooks") or [])
    ledger_agents = list(ledger_ent.get("agents") or [])
    ledger_perms = [dict(p) for p in (ledger_ent.get("permissions") or [])]
    hook_state = dict(ledger_ent.get("hook_state") or {})
    agent_state = dict(ledger_ent.get("agent_state") or {})

    items = plan.get("items") or []
    perm_scope_kind = "global" if scope_global else "project"

    # ── (1) hard-refuse pre-check — no mutation yet ──
    # A23 (review R2/R3) — hub never overwrites a definition/file it did not
    # write. Provisioning a companion whose definition already exists means
    # ATTACH (a `{ref}` hook: it never overwrites a definition, only attaches
    # one that already exists by construction) or CLAIM (an agent whose
    # rendered bytes equal the existing harness file — `already_present`,
    # ledger `written: false`; a `from:`-copied agent is equal by
    # construction). The pre-check refuses ONLY when hub would write
    # DIFFERENT bytes over a file no ledger claims.
    all_hook_defs = hooks_model.all_definitions(registry)
    hooks_by_name = {h["name"]: h for h in block.get("hooks") or []}
    will_write_hooks = sorted(
        {it["name"] for it in items if it["kind"] == "hook" and it["verdict"] == "will_write"}
    )
    for name in will_write_hooks:
        if name in ledger_hooks:
            continue
        decl = hooks_by_name.get(name)
        if decl is not None and "ref" in decl:
            continue  # A23 — a ref only ATTACHES an existing definition
        if name in all_hook_defs and _companion_claim_count(registry, skill, "hooks", name) == 0:
            raise _CompanionApplyError(
                f"hook '{name}' already exists and is claimed by no ships_with "
                f"ledger entry for '{skill}' — refusing to overwrite it"
            )

    agent_write_items = [
        it for it in items if it["kind"] == "agent" and it["verdict"] == "will_write"
    ]
    will_write_agents = sorted({it["name"] for it in agent_write_items})
    claim_without_write: set[tuple[str, str]] = set()  # A23 — (agent, harness)
    for name in will_write_agents:
        if name in ledger_agents or ships_with.agent_refcount(name, registry) > 0:
            continue
        for it in agent_write_items:
            if it["name"] != name:
                continue
            hid = it["harness"]
            existing = subagents._find_agent_file(name, "user", None, registry, hid)
            if existing is None:
                continue
            if _agent_write_would_differ(skill, name, hid, registry, existing):
                raise _CompanionApplyError(
                    f"agent '{name}' already exists for harness '{hid}' and "
                    f"is claimed by no ships_with ledger entry — refusing to overwrite it"
                )
            claim_without_write.add((name, hid))

    # ── (2) hooks + permissions + trust — in-memory ──
    for name in will_write_hooks:
        decl = hooks_by_name.get(name)
        if decl is None:
            continue
        is_ref = "ref" in decl
        if name not in all_hook_defs:
            command = str((skill_dir / decl["command"]).resolve(strict=False))
            _hook_new(
                registry,
                name,
                event=decl["event"],
                command=command,
                tools=list(decl.get("tools") or []) or None,
                matcher=None,
                timeout=None,
                harnesses=list(decl["harnesses"]) if decl.get("harnesses") else None,
                description=f"Shipped by {skill}",
            )
        newly_attached = _hook_attach(registry, name, scope_global=scope_global, proj_name=project)
        if name not in ledger_hooks:
            ledger_hooks.append(name)
            result["hooks"].append(name)
        rec: dict = {"origin": "ref" if is_ref else "inline", "attached": newly_attached}
        if not is_ref:
            rec["def_sha256"] = swr.hook_def_sha256(decl)
        hook_state[name] = rec

    for it in items:
        if it["kind"] != "permission" or it["verdict"] != "will_write":
            continue
        pattern, rule_kind = it["name"], it["rule_kind"]
        perm_block = _get_perm_block(registry, perm_scope_kind, project)
        bucket = list(perm_block.get(rule_kind) or [])
        already = any(
            (b.get("pattern") if isinstance(b, dict) else str(b)) == pattern for b in bucket
        )
        if not already:
            bucket.append({"pattern": pattern, "kind": rule_kind})
            perm_block[rule_kind] = bucket
        already_ledgered = any(
            p.get("pattern") == pattern and p.get("kind") == rule_kind for p in ledger_perms
        )
        if not already_ledgered:
            ledger_perms.append({"pattern": pattern, "kind": rule_kind, "added": not already})
            result["permissions"].append({"pattern": pattern, "kind": rule_kind})

    trust_granted = False
    if project:  # A17: plan_provision never emits a trust row for project=None
        for it in items:
            if it["kind"] == "trust" and it["verdict"] == "will_write":
                perm_block = _get_perm_block(registry, "project", project)
                perm_block["project_trust"] = True
                trust_granted = True  # C-2: recorded in the ledger below

    # ── (3) agent files — the only filesystem writes ──
    written_files: list[Path] = []
    linked_names: list[str] = []

    def _rollback() -> None:
        for f in written_files:
            try:
                if f.exists():
                    f.unlink()
            except OSError:
                pass
        for name in linked_names:
            try:
                subagent_links.unlink_agents(name, scope="user")
            except Exception:
                pass

    try:
        # C-1: walk every DECLARED agent (any verdict), not just the
        # `will_write` rows — a harness row can be `already_present` because
        # ANOTHER project's ledger already claims it (the shared-agent path),
        # in which case this project writes nothing for it but must still
        # claim it in its OWN ledger, or its own future disable/refcount is
        # wrong.
        agent_items_all = [it for it in items if it["kind"] == "agent"]
        # An effective harness with no sub-agent concept (pi, opencode) is in
        # `items` as an `unsupported` row so the consequence dialog can say so;
        # it must never reach `_find_agent_file`/`link_agents`, which raise
        # for such an id — the first real equip with `pi` on a project's
        # harness list died on exactly that, after every file had been
        # written, and rolled the whole provisioning back.
        agent_capable_harnesses = sorted(
            {it["harness"] for it in agent_items_all if it["verdict"] != "unsupported"}
        )
        by_name: dict[str, list[dict]] = {}
        for it in agent_items_all:
            by_name.setdefault(it["name"], []).append(it)
        for agent_name, its in by_name.items():
            if agent_name in ledger_agents:
                continue  # W1 reprovision skip — already claimed by us
            if all(it["verdict"] == "unsupported" for it in its):
                # Review R1: no effective harness can hold this agent (pi /
                # opencode only) — claiming it would report it as provisioned
                # with `files: {}`, and a later disable would remove nothing.
                continue
            files: dict = {}
            for it in its:
                if it["verdict"] != "will_write":
                    continue
                hid = it["harness"]
                if (agent_name, hid) in claim_without_write:
                    # A23 — the pre-check found this harness's existing file
                    # byte-identical to what hub would render (a `from:`-copy
                    # source qualifies by construction): CLAIM it in the
                    # ledger without ever touching the file, `written: false`
                    # so stale removal and drift-check both leave it alone.
                    existing = subagents._find_agent_file(agent_name, "user", None, registry, hid)
                    if existing is not None:
                        files[hid] = {"sha256": swr.agent_file_sha256(existing), "written": False}
                    continue
                payload = ships_with.render_agent_payload(skill, agent_name, hid, registry)
                res = subagents.save_agent(payload, registry)
                if not res.get("ok"):
                    raise _CompanionApplyError(
                        f"failed writing agent '{agent_name}' for '{hid}': "
                        f"{res.get('errors')}"
                    )
                written_files.append(Path(res["file"]))
                files[hid] = {"sha256": swr.agent_file_sha256(Path(res["file"])), "written": True}
            ledger_agents.append(agent_name)
            result["agents"].append(agent_name)
            source_sha = swr.agent_file_sha256(skill_dir / "agents" / f"{agent_name}.md")
            agent_state[agent_name] = {
                "origin": "skill", "source_sha256": source_sha, "files": files,
            }
            # Only ever CREATE a new link here, never touch one that already
            # exists (it may belong to a transaction this call knows nothing
            # about) — rollback must be able to undo exactly what THIS call
            # made, nothing a prior project's provisioning already committed.
            if (
                len(agent_capable_harnesses) >= 2
                and subagent_links.find_link(agent_name, scope="user") is None
            ):
                present = all(
                    subagents._find_agent_file(agent_name, "user", None, registry, hid)
                    is not None
                    for hid in agent_capable_harnesses
                )
                if present:
                    link_res = subagent_links.link_agents(
                        agent_name, agent_capable_harnesses, scope="user", registry=registry
                    )
                    if link_res.get("ok"):
                        linked_names.append(agent_name)
    except Exception:
        _rollback()
        raise

    # C-2: once granted, remember it — a re-apply that finds the project
    # already trusted must not forget an EARLIER grant this same ledger made.
    trust_flag = bool(ledger_ent.get("trust")) or trust_granted
    entry: dict = {
        "schema": 2,
        "hooks": ledger_hooks,
        "permissions": ledger_perms,
        "agents": ledger_agents,
        "hook_state": hook_state,
        "agent_state": agent_state,
        "provisioned_at": hub_core._now_iso(),
    }
    if trust_flag:
        entry["trust"] = True
    if scope_global:
        ships_with.set_global_ledger_entry(registry, skill, entry)
    else:
        ships_with.set_ledger_entry(proj_cfg, skill, entry)
    return result


def _remove_companions(
    registry: dict, skill: str, project: Optional[str], *, operation_context=None
) -> dict:
    """Remove everything `projects.<project>.companions.<skill>` (D4) — or, for
    `project=None` (A17), `companions_global.<skill>` — lists: ledger-scoped,
    never a broader sweep. Shared by `hub disable`, `hub project remove` and
    `hub archive`/`hub rename`. In-memory except the refcounted user-scope
    agent deletes.

    A19/C2 — a hook is detached, and a rule dropped, ONLY when this ledger's
    v2 `hook_state.<n>.attached` / `permissions[].added` flag says WE were the
    one who put it there; a legacy v1 entry (`schema != 2`, pre-dating this
    wave — wave 1's pre-check refused any unclaimed collision, so every v1
    ledgered item really is hub's) is treated as if both flags were `true`
    (the same default the sync-time reconcile's backfill uses). A detach also
    prunes `hook_settings[name]`, the way `cmd_hook_delete` does.

    Returns `{"agents", "hooks", "permissions", "kept", "kept_shared",
    "still_active_via"}` — the last one always empty here (only `hub disable`
    computes it, before deciding whether to call this at all)."""
    from skill_hub.domain.skills import ships_with
    from skill_hub.infrastructure.harnesses import subagent_links, subagents

    result: dict = {
        "agents": [], "hooks": [], "permissions": [],
        "kept": [], "kept_shared": [], "still_active_via": [],
    }
    scope_global = project is None
    projects = registry.get("projects") or {}
    proj_cfg: Optional[dict] = None
    if scope_global:
        entry = ships_with.global_ledger(registry).get(skill) or {}
    else:
        proj_cfg = projects.get(project)
        if not isinstance(proj_cfg, dict):
            return result
        entry = ships_with.ledger_entry(proj_cfg, skill)
    if not entry:
        return result
    is_backfill = entry.get("schema") != 2
    exclude_scope = ships_with.GLOBAL_SCOPE if scope_global else project

    for name in list(entry.get("hooks") or []):
        hs = ships_with.hook_state(entry, name)
        attached = True if is_backfill else bool(hs.get("attached"))
        if not attached:
            result["kept"].append(name)  # not hub's attach — leave it alone
            continue
        _hook_detach(
            registry, name, scope_global=scope_global, proj_name=project,
            operation_context=operation_context,
        )
        result["hooks"].append(name)
        if proj_cfg is not None:
            hook_settings = proj_cfg.get("hook_settings")
            if isinstance(hook_settings, dict) and name in hook_settings:
                del hook_settings[name]
                if not hook_settings:
                    proj_cfg.pop("hook_settings", None)
        still_global = name in (registry.get("hooks_global") or [])
        still_project_attach = any(
            name in (pc.get("hooks") or [])
            for pn, pc in projects.items()
            if isinstance(pc, dict) and pn != project
        )
        still_ledger = (
            _companion_claim_count(registry, skill, "hooks", name, exclude=exclude_scope) > 0
        )
        origin = "inline" if is_backfill else hs.get("origin")
        if still_global or still_project_attach or still_ledger:
            result["kept_shared"].append({"kind": "hook", "name": name})
        elif origin == "inline":
            hooks_map = registry.get("hooks")
            if isinstance(hooks_map, dict) and name in hooks_map:
                del hooks_map[name]
                if not hooks_map:
                    registry.pop("hooks", None)

    perm_block = _get_perm_block(registry, "global" if scope_global else "project", project)
    for item in list(entry.get("permissions") or []):
        pattern, kind = item.get("pattern"), item.get("kind")
        added = True if is_backfill else bool(item.get("added"))
        if not added:
            result["kept"].append(item)  # not hub's rule — leave it alone
            continue
        bucket = list(perm_block.get(kind) or [])
        matched = [
            b for b in bucket if (b.get("pattern") if isinstance(b, dict) else str(b)) == pattern
        ]
        if matched:
            perm_block[kind] = [b for b in bucket if b not in matched]
            result["permissions"].append(item)
        else:
            result["kept"].append(item)  # hand-edited away — nothing to remove

    for name in list(entry.get("agents") or []):
        refcount = ships_with.agent_refcount(name, registry, exclude=(exclude_scope, skill))
        if refcount > 0:
            result["kept_shared"].append({"kind": "agent", "name": name})
            continue
        if is_backfill:
            written_hids = ["claude-code", "codex"]
        else:
            a_state = ships_with.agent_state(entry, name)
            written_hids = [
                hid for hid, f in (a_state.get("files") or {}).items() if f.get("written")
            ]
        existing = [
            hid for hid in written_hids
            if subagents._find_agent_file(
                name, "user", None, registry, hid, context=operation_context
            ) is not None
        ]
        deleted_any = False
        if existing:
            # A25 (review R5) — `link_action="both"` deletes EVERY harness the
            # link SIDECAR tracks, not every harness THIS LEDGER wrote; using
            # it when the sidecar names a harness we never wrote (e.g. the
            # user linked a twin in later via `hub subagent link
            # --copy-from`) deletes a file hub never provisioned, with no
            # restore. Safe only when every linked harness is one we wrote;
            # else delete exactly the written files, one harness at a time.
            link = subagent_links.find_link(name, "user", context=operation_context)
            link_harnesses = set((link or {}).get("harnesses") or [])
            if link_harnesses and link_harnesses.issubset(set(existing)):
                res = subagents.delete_agent(
                    name, "user", None, registry, harness_id=existing[0], link_action="both",
                    context=operation_context,
                )
                if res.get("ok"):
                    deleted_any = True
            else:
                for hid in existing:
                    res = subagents.delete_agent(
                        name, "user", None, registry, harness_id=hid, link_action="this",
                        context=operation_context,
                    )
                    if res.get("ok"):
                        deleted_any = True
        if deleted_any:
            result["agents"].append(name)

    # C-2: this ledger entry granted Codex trust — revoke it, unless some
    # OTHER skill's ledger on the SAME project still needs it. Otherwise
    # `project_trust: true` outlives every rule that justified it.
    if entry.get("trust") and proj_cfg is not None:
        other_needs_trust = any(
            other_skill != skill and isinstance(other_entry, dict) and other_entry.get("trust")
            for other_skill, other_entry in ships_with.ledger(proj_cfg).items()
        )
        if not other_needs_trust:
            _get_perm_block(registry, "project", project).pop("project_trust", None)

    if scope_global:
        ships_with.drop_global_ledger_entry(registry, skill)
    else:
        ships_with.drop_ledger_entry(proj_cfg, skill)
    return result


def _bundles_providing_skill(proj_cfg: dict, registry: dict, skill_name: str) -> list[str]:
    """Bundle names (global, or applied to this project) whose `skills:` list
    still names `skill_name` — used to report `still_active_via` on disable."""
    names = []
    for name, cfg in (registry.get("bundles") or {}).items():
        if not isinstance(cfg, dict) or skill_name not in (cfg.get("skills") or []):
            continue
        if hub_core.bundle_scope(cfg) == "global" or name in (proj_cfg.get("bundles") or []):
            names.append(name)
    return sorted(names)


def cmd_skill_companions(args):
    """Back-compat re-export: the read-only I5 status command moved to
    `hub_cli/companions.py` in wave 2 (it now also owns `set`/`add`/`remove`/
    `resolve`, which share its argparse block). Kept so any caller still
    importing `skill_hub.entrypoints.cli.skill.cmd_skill_companions` directly keeps resolving."""
    from skill_hub.entrypoints.cli import companions

    companions.cmd_skill_companions(args)


def _skill_operation_context(args):
    """Capture one cache-only companion operation context for this command."""
    context = getattr(args, "_operation_context", None)
    if context is not None:
        return context

    from skill_hub.application.harnesses.harness_operation_context import KNOWN_HARNESSES, build_operation_context
    from skill_hub.infrastructure.harnesses import harnesses

    installed = sorted(harnesses.detect_installed())
    context = build_operation_context(
        data_home=hub_core.data_home(),
        harness_ids=KNOWN_HARNESSES,
        requested_features=("companions", "subagents", "hooks", "permissions"),
        force_refresh=False,
        installed_harness_ids=installed,
    )
    args._operation_context = context
    return context


def _cmd_enable_global_companions(
    args, registry: dict, skill_name: str, cfg: dict, *, operation_context=None
) -> None:
    """A17/C4 — `hub enable <skill>` with NO `--project` on a `scope: global`
    skill that declares companions. Same two-phase gate as the project path
    (D2), against `companions_global`/`hooks_global`/`permissions_global`
    (`project=None` throughout `plan_provision`/`_apply_companions`) — no
    `enabled` list to mutate (a global skill is always active) and no Codex
    trust row (`plan_provision` never emits one for `project=None`)."""
    import hub
    from skill_hub.domain.skills import ships_with

    with_companions = bool(getattr(args, "with_companions", False))
    skill_only = bool(getattr(args, "skill_only", False))
    json_mode = bool(getattr(args, "json", False))

    plan = ships_with.plan_provision(
        skill_name, None, registry, operation_context=operation_context
    )
    has_companions = bool(plan["items"])
    needs_consent = any(it.get("verdict") == "will_write" for it in plan["items"])
    gate = needs_consent and not with_companions and not skill_only

    if gate:
        payload = {
            "needs_provisioning": {
                "skill": plan["skill"],
                "project": None,
                "items": plan["items"],
                "linked": plan["linked"],
                "companions_pending": [],
            }
        }
        print(json.dumps(payload, separators=(",", ":")))
        hub._auto_sync_tail()
        sys.exit(2)

    applied: dict = {}
    if with_companions and has_companions:
        try:
            applied = _apply_companions(registry, skill_name, None, plan)
        except _CompanionApplyError as e:
            print(f"{c('✗', RED)} companion provisioning refused: {e}")
            sys.exit(1)
        hub_core.save_registry(registry)

    if json_mode:
        print(
            json.dumps(
                {
                    "ok": True,
                    "skill": skill_name,
                    "project": None,
                    "already_enabled": True,
                    "companions_pending": [],
                    "provisioned": applied,
                },
                separators=(",", ":"),
            )
        )
    else:
        print(
            f"'{skill_name}' is already global — no project needed. "
            f"Run 'hub sync' to refresh symlinks."
        )
        if with_companions:
            for kind in ("agents", "hooks", "permissions"):
                for name in applied.get(kind, []):
                    label = name if isinstance(name, str) else name.get("pattern")
                    print(f"  {c('✓', GREEN)} provisioned {kind[:-1]}: {label}")
    hub._auto_sync_tail()


@registry_mutation("enable")
def cmd_enable(args):
    import hub
    from skill_hub.domain.skills import ships_with

    operation_context = _skill_operation_context(args)
    registry = hub_core.load_registry()
    skills = registry.get("skills", {})
    projects = registry.get("projects", {})

    skill_name = args.skill
    if skill_name not in skills:
        print(f"Unknown skill '{skill_name}'. Run 'hub list' to see available skills.")
        sys.exit(1)

    if not args.project:
        cfg = skills[skill_name]
        # A17/C4 — a `scope: global` skill that declares companions runs the
        # SAME two-phase consent gate as a project equip, against the real
        # global ledger (`companions_global`, `hooks_global`,
        # `permissions_global`), with `project=None`. Any other project-less
        # call (no companions, or not global) keeps the old plain message.
        if cfg.get("scope") == "global" and _ships_with_block(cfg):
            return _cmd_enable_global_companions(
                args, registry, skill_name, cfg, operation_context=operation_context
            )
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

    with_refs = bool(getattr(args, "with_refs", False))
    with_companions = bool(getattr(args, "with_companions", False))
    skill_only = bool(getattr(args, "skill_only", False))
    json_mode = bool(getattr(args, "json", False))

    proj_cfg = projects[proj_name]
    enabled = proj_cfg.get("enabled", [])
    already_enabled = skill_name in enabled
    cfg = skills[skill_name]

    # A4: the plan reads the SKILL.md frontmatter directly, never the
    # registry mirror — a never-synced or hand-edited skill still gates.
    plan = ships_with.plan_provision(
        skill_name, proj_name, registry, operation_context=operation_context
    )
    has_companions = bool(plan["items"])
    # W-1: gate on there being SOMETHING left to write — a fully provisioned
    # skill (every item already_present/unsupported/etc.) must not re-open
    # the consequence dialog on a plain `hub enable` with no flag.
    needs_consent = any(it.get("verdict") == "will_write" for it in plan["items"])
    gate = needs_consent and not with_companions and not skill_only

    # Bug found by the proof unit: the real two-call flow is (1) no flag ->
    # equips + exits 2, (2) the user confirms -> a SECOND process runs
    # `--with-companions`. By then `already_enabled` is already True, so this
    # short-circuit must never swallow `--with-companions` — it still has
    # real work to do (idempotently; `already_present` items are skipped
    # inside `_apply_companions` itself). `--skill-only` stays a true no-op
    # here, but the response must still honor `--json` either way.
    if already_enabled and not with_refs and not gate and not with_companions:
        if json_mode:
            print(
                json.dumps(
                    {
                        "ok": True,
                        "skill": skill_name,
                        "project": proj_name,
                        "already_enabled": True,
                        "companions_pending": [],
                        "provisioned": {},
                    },
                    separators=(",", ":"),
                )
            )
        else:
            print(f"'{skill_name}' already enabled for '{proj_name}'.")
        return

    # A22/A24/W9 (review R4) — NEITHER call of the two-phase companion flow
    # may silently promote a bundle-only skill to direct-equipped: not call 1
    # (`gate=True`, no flag, exit 2 — the ORIGINAL bug: `bundle_only_provision`
    # required `with_companions`, so it was unreachable on the gate branch,
    # which already appended before printing the payload) and not call 2
    # (`--with-companions` confirming it). A direct-equip promotion would
    # survive a later `hub bundle remove`, which A22 explicitly forbids.
    # `--skill-only` (an explicit "equip only, skip companions" request) is
    # unaffected — that stays a deliberate direct equip, same as a plain
    # `hub enable` on a skill with no companions at all.
    bundle_only_provision = (
        not already_enabled
        and has_companions
        and (gate or with_companions)
        and skill_name in hub.resolve_project_skills(proj_cfg, registry)
    )
    if not already_enabled and not bundle_only_provision:
        enabled.append(skill_name)
    proj_cfg["enabled"] = enabled

    missing = _missing_refs_hint_for(skill_name, cfg, proj_cfg, registry)
    companions_pending: list[str] = []
    if with_refs:
        for ref in missing:
            if ref not in enabled:
                enabled.append(ref)
            # A4 posture: read the referenced skill's own FRONTMATTER, never
            # the registry mirror — a never-synced ref still gets reported.
            if _ships_with_block(skills.get(ref) or {}):
                companions_pending.append(ref)

    if gate:
        # D2/A4 — two-phase consequence gate: the equip lands, companions do
        # not. Order is pinned: save → print (first stdout line) → tail →
        # (audit, via registry_mutation's SystemExit catch, S1) → exit(2).
        hub_core.save_registry(registry)
        payload = {
            "needs_provisioning": {
                "skill": plan["skill"],
                "project": plan["project"],
                "items": plan["items"],
                "linked": plan["linked"],
                "companions_pending": companions_pending,
            }
        }
        print(json.dumps(payload, separators=(",", ":")))
        hub._auto_sync_tail()
        sys.exit(2)

    applied: dict = {}
    if with_companions and has_companions:
        try:
            applied = _apply_companions(registry, skill_name, proj_name, plan)
        except _CompanionApplyError as e:
            print(f"{c('✗', RED)} companion provisioning refused: {e}")
            sys.exit(1)

    hub_core.save_registry(registry)

    if json_mode:
        print(
            json.dumps(
                {
                    "ok": True,
                    "skill": skill_name,
                    "project": proj_name,
                    "already_enabled": already_enabled,
                    "companions_pending": companions_pending,
                    "provisioned": applied,
                },
                separators=(",", ":"),
            )
        )
    else:
        if already_enabled:
            print(f"'{skill_name}' already enabled for '{proj_name}'.")
        else:
            print(f"{c('✓', GREEN)} enabled '{skill_name}' for '{proj_name}'.")
        if with_refs:
            for ref in missing:
                print(f"  + {ref}")
        elif missing:
            _print_missing_refs_hint(skill_name, proj_name, missing)
        if with_companions:
            for kind in ("agents", "hooks", "permissions"):
                for name in applied.get(kind, []):
                    label = name if isinstance(name, str) else name.get("pattern")
                    print(f"  {c('✓', GREEN)} provisioned {kind[:-1]}: {label}")
        if companions_pending:
            print(
                f"  {c('!', YELLOW)} equipped skill-only (refs never provision "
                f"companions in the same command): {', '.join(companions_pending)}"
            )

    hub._auto_sync_tail()


def _cmd_disable_global_companions(args, registry: dict) -> None:
    """R6/A17 — `hub disable <skill> --global`: the `companions_global.<skill>`
    teardown path (`_remove_companions(project=None)`), the global twin of the
    per-project branch below. A `scope: global` skill has no `enabled` list to
    mutate — this only ever tears down what `_cmd_enable_global_companions`
    provisioned."""
    import hub
    from skill_hub.domain.skills import ships_with

    skill_name = args.skill
    skill_cfg = (registry.get("skills") or {}).get(skill_name)
    if not isinstance(skill_cfg, dict):
        print(f"Unknown skill '{skill_name}'.")
        sys.exit(1)

    keep_companions = bool(getattr(args, "keep_companions", False))
    json_mode = bool(getattr(args, "json", False))

    ledger_entry = ships_with.global_ledger(registry).get(skill_name) or {}
    removed = {"agents": [], "hooks": [], "permissions": []}
    if ledger_entry and not keep_companions:
        result = _remove_companions(registry, skill_name, None)
        removed = {
            "agents": result.get("agents", []),
            "hooks": result.get("hooks", []),
            "permissions": result.get("permissions", []),
        }

    hub_core.save_registry(registry)

    if json_mode:
        print(json.dumps({"removed_companions": removed}, separators=(",", ":")))
    elif not ledger_entry:
        print(f"'{skill_name}' has no global companions ledger entry.")
    else:
        print(f"{c('✓', GREEN)} removed global companions for '{skill_name}'.")
        if keep_companions:
            print(f"  {c('!', YELLOW)} companions left in place (--keep-companions)")

    hub._auto_sync()


@registry_mutation("disable")
def cmd_disable(args):
    import hub
    from skill_hub.domain.skills import ships_with

    registry = hub_core.load_registry()
    projects = registry.get("projects", {})

    # R6 — `companions_global` (A17's global-scope ledger) had no CLI teardown
    # anywhere: `hub archive`/`hub rename` scan only `projects`, and the
    # reconcile skips an entry once its skill leaves `skills`. `--global`
    # gives it the same `_remove_companions(project=None)` path a project
    # already had.
    if bool(getattr(args, "global_", False)):
        if args.project:
            print("Pass --project OR --global, not both.")
            sys.exit(1)
        return _cmd_disable_global_companions(args, registry)

    if not args.project:
        print(
            "Specify a project with --project <name>, or --global for a "
            "`scope: global` skill's companions."
        )
        sys.exit(1)

    proj_name = args.project
    if proj_name not in projects:
        print(f"Unknown project '{proj_name}'.")
        sys.exit(1)

    skill_name = args.skill
    proj_cfg = projects[proj_name]
    enabled = proj_cfg.get("enabled", [])
    if skill_name not in enabled:
        print(f"'{skill_name}' not enabled for '{proj_name}'.")
        return

    keep_companions = bool(getattr(args, "keep_companions", False))
    json_mode = bool(getattr(args, "json", False))

    enabled.remove(skill_name)
    proj_cfg["enabled"] = enabled

    ledger_entry = ships_with.ledger_entry(proj_cfg, skill_name)
    removed = {"agents": [], "hooks": [], "permissions": []}
    still_active_via: list[str] = []

    if ledger_entry:
        still_active = skill_name in hub.resolve_project_skills(proj_cfg, registry)
        if still_active:
            still_active_via = _bundles_providing_skill(proj_cfg, registry, skill_name)
        elif not keep_companions:
            result = _remove_companions(registry, skill_name, proj_name)
            removed = {
                "agents": result.get("agents", []),
                "hooks": result.get("hooks", []),
                "permissions": result.get("permissions", []),
            }
        # else: --keep-companions — the ledger is left exactly as-is, on
        # purpose, so `ships_with.orphans()` reports it (Risk 4).

    hub_core.save_registry(registry)

    if json_mode:
        print(json.dumps({"removed_companions": removed}, separators=(",", ":")))
    else:
        print(f"{c('✓', GREEN)} disabled '{skill_name}' for '{proj_name}'.")
        if still_active_via:
            print(
                f"  {c('!', YELLOW)} still active via bundle(s) "
                f"{', '.join(still_active_via)} — companions kept"
            )
        elif keep_companions and ledger_entry:
            print(f"  {c('!', YELLOW)} companions left in place (--keep-companions)")

    hub._auto_sync()


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

See skill_hub_mcp_server.py in the skill-hub repo for the reference
implementation of tool annotations, output schemas, and structured results.
"""

import json
import sys

PROTOCOL_VERSION = "2024-11-05"

# Give every tool the hints that are TRUE for it. An absent hint falls
# back to the spec's documented default — destructiveHint and
# openWorldHint default to TRUE — so set a hint explicitly whenever the
# default would be wrong.
ANNOTATIONS = {{
    "example_tool": {{"destructiveHint": False, "openWorldHint": False}},
}}

# Every tool advertises this shape in tools/call's structuredContent. Replace
# it with a schema that matches what your tool actually returns.
OUTPUT_SCHEMA = {{
    "type": "object",
    "properties": {{
        "result": {{"type": "string", "description": "the tool's result"}},
    }},
    "required": ["result"],
}}

TOOLS = {{
    "example_tool": {{
        "description": "An example tool — replace with your implementation.",
        "inputSchema": {{
            "type": "object",
            "properties": {{
                "input": {{"type": "string", "description": "Input to process"}},
            }},
            "required": ["input"],
        }},
    }},
}}


def handle_initialize(req_id, params):
    return {{
        "jsonrpc": "2.0",
        "id": req_id,
        "result": {{
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {{"tools": {{}}}},
            "serverInfo": {{"name": "{name}", "version": "1.0.0"}},
        }},
    }}


def handle_tools_list(req_id):
    tools = [
        {{
            "name": name,
            "description": tool["description"],
            "inputSchema": tool["inputSchema"],
            "annotations": ANNOTATIONS.get(name, {{}}),
            "outputSchema": OUTPUT_SCHEMA,
        }}
        for name, tool in sorted(TOOLS.items())
    ]
    return {{
        "jsonrpc": "2.0",
        "id": req_id,
        "result": {{"tools": tools}},
    }}


def handle_tools_call(req_id, params):
    name = params.get("name")
    args = params.get("arguments", {{}})

    if name == "example_tool":
        payload = {{"result": f"Processed: {{args.get('input', '')}}"}}
        return {{
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {{
                "content": [{{"type": "text", "text": json.dumps(payload)}}],
                "structuredContent": payload,
            }},
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
    import hub

    registry = hub_core.load_registry()
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
        dest = hub.hub_skills_dir() / name
        if dest.exists():
            print(f"'{name}' already exists at {dest}")
            sys.exit(1)
        dest.mkdir(parents=True)
        (dest / "SKILL.md").write_text(
            SKILL_TEMPLATE.format(name=name, title=title, description=description)
        )
        print(f"{c('✓', GREEN)} scaffolded skill at {dest}/")

    elif kind == "mcp":
        dest = hub.hub_mcp_servers_dir() / name
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
        hub_core.save_registry(registry)
        print(f"{c('✓', GREEN)} registered '{name}' in registry.yaml")

    print(f"\nNext: edit the files in {dest}/, then run '{c('hub sync', CYAN)}'")


@registry_mutation("set-meta")
def cmd_set_meta(args):
    classification_updates = _classification_preflight(args)
    import hub

    registry = hub_core.load_registry()
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
            cfg["harnesses"] = hub._validate_harness_affinity(values, f"skill '{name}'")

    if getattr(args, "refs_ignore", None) is not None:
        # Empty string clears it. A value naming an unregistered skill is
        # accepted on purpose — a rename or a not-yet-imported target must not
        # break `set-meta`. This never touches SKILL.md.
        if args.refs_ignore == "":
            cfg.pop("refs_ignore", None)
        else:
            values = [v.strip() for v in args.refs_ignore.split(",") if v.strip()]
            for value in values:
                if not SLUG_RE.match(value):
                    fail(
                        f"Invalid refs-ignore value '{value}': expected a "
                        f"lowercase slug (letters, digits, hyphens)."
                    )
            cfg["refs_ignore"] = sorted(set(values))

    invocation_changed = False
    if getattr(args, "invocation", None) is not None:
        mode = args.invocation
        if mode not in hub.VALID_INVOCATIONS:
            fail(
                f"Invalid invocation '{mode}'. Expected one of: "
                f"{', '.join(hub.VALID_INVOCATIONS)}."
            )
        if cfg.get("type") == "mcp-server":
            fail("Invocation mode applies to claude-skills only (MCP servers have no SKILL.md frontmatter).")
        ownership = hub.infer_skill_ownership(name, cfg)
        if ownership["managed"] == "external":
            fail(
                f"'{name}' is owned by external source '{ownership['source_id']}' — "
                f"the hub does not edit upstream checkouts. Set a per-project override "
                f"instead: hub project invocation <project> --skill {name} --mode {mode}"
            )
        if ownership["managed"] == "starter":
            fail(f"'{name}' is a read-only starter asset — its frontmatter cannot be edited.")
        skill_md = hub.skill_source(cfg) / "SKILL.md"
        try:
            text = skill_md.read_text()
        except OSError as exc:
            fail(f"Cannot read {skill_md}: {exc}")
        new_text = hub.render_invocation_frontmatter(text, mode)
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

    if classification_updates:
        classification = dict(cfg.get("classification") or {})
        for field, value in classification_updates.items():
            if field in ("classes", "outputs"):
                if value:
                    classification[field] = value
                else:
                    classification.pop(field, None)
            elif value is None:
                classification.pop(field, None)
            else:
                classification[field] = value
        if classification:
            cfg["classification"] = classification
        else:
            cfg.pop("classification", None)

    skills[name] = cfg
    registry["skills"] = skills
    hub_core.save_registry(registry)
    print(f"{c('✓', GREEN)} updated metadata for '{name}'")

    if invocation_changed:
        # The frontmatter and registry write are already durable.  A trailing
        # sync can fail because of an unrelated project or harness, so keep
        # set-meta successful and let the caller surface the warning.
        hub._auto_sync_tail()


# ─────────────────────────────────────────────────────────────────────────────
# hub rename
# ─────────────────────────────────────────────────────────────────────────────


def cmd_rename(args):
    """Rename a skill. An undecorated shim: `--dry-run` is read-only (no lock,
    no audit row); the real run carries `@registry_mutation`. The
    `--rewrite-agent-docs` guard lives here so BOTH paths see it, before
    either one touches the registry.
    """
    if getattr(args, "rewrite_agent_docs", False) and not getattr(args, "rewrite_refs", False):
        print("--rewrite-agent-docs requires --rewrite-refs.", file=sys.stderr)
        sys.exit(2)
    if getattr(args, "dry_run", False):
        return _rename_plan(args)
    return _cmd_rename_mutate(args)


def _rename_plan(args):
    """Read-only rename plan. No lock, no audit row — this runs on every
    `⌘S` that stages a rename in the app, so it must cost nothing.
    """
    import hub

    registry = hub_core.load_registry()
    skills = registry.get("skills", {})
    old_name = args.old_name
    new_name = args.new_name

    if old_name not in skills:
        print(f"Unknown skill '{old_name}'.")
        sys.exit(1)

    if new_name in skills:
        print(f"'{new_name}' already exists in registry.")
        sys.exit(1)

    if getattr(args, "json", False):
        from skill_hub.application.skills import rename_cascade

        payload = rename_cascade.plan_cascade(registry, old_name, new_name)
        print(json.dumps(payload))
        return

    print(f"{c('DRY-RUN', YELLOW)} rename '{old_name}' → '{new_name}' (no changes made):")
    src = hub.skill_source(skills[old_name])
    if src.exists() and not src.is_symlink() and src.is_relative_to(data_home()):
        print(f"  would move dir {old_name}/ → {new_name}/ and update its SKILL.md name")
    sites = hub._skill_reference_sites(registry, old_name)
    for site in ("projects", "bundles", "remotes", "cloud"):
        if sites.get(site):
            print(f"  would update {hub._REFERENCE_SITE_LABELS[site]}: {', '.join(sites[site])}")
    if sites.get("invocation_overrides"):
        print(
            f"  would drop invocation overrides in: "
            f"{', '.join(sites['invocation_overrides'])}"
        )
    print("  would re-sync symlinks")
    if getattr(args, "rewrite_refs", False):
        from skill_hub.application.skills import rename_cascade

        payload = rename_cascade.plan_cascade(registry, old_name, new_name)
        for row in payload["referrers"]["skills"]:
            print(f"  would rewrite {row['count']}× in skill {row['name']}")
        for row in payload["referrers"]["snippets"]:
            print(f"  would rewrite {row['count']}× in snippet {row['name']}")
        if getattr(args, "rewrite_agent_docs", False):
            for row in payload["referrers"]["agent_docs"]:
                print(f"  would rewrite {row['count']}× in {row['project']}/{row['rel']}")
    return


@registry_mutation("rename")
def _cmd_rename_mutate(args):
    import hub

    registry = hub_core.load_registry()
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

    cfg = dict(skills[old_name])
    src = hub.skill_source(cfg)
    new_src: Optional[Path] = None

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

    sites = hub._prune_skill_references(registry, old_name, replacement=new_name)
    for site, keys in sites.items():
        for key in keys:
            if site == "invocation_overrides":
                print(f"  {c('✓', GREEN)} dropped invocation override in {key}")
            else:
                print(
                    f"  {c('✓', GREEN)} updated {hub._REFERENCE_SITE_LABELS[site]} "
                    f"{key}: {old_name} → {new_name}"
                )

    # `refs_ignore` re-key (rename only, unconditional — no flag needed): a
    # sibling skill's `refs_ignore: [old_name]` would otherwise keep muting a
    # name that no longer exists, and the NEW name's mention would surface as
    # a reference the user had deliberately muted. Deliberately not added to
    # `_skill_reference_sites` — that function's undo sidecar for `hub
    # archive` is a fixed key set and would not restore this on unarchive.
    for other_cfg in registry.get("skills", {}).values():
        if not isinstance(other_cfg, dict):
            continue
        ignore = other_cfg.get("refs_ignore")
        if isinstance(ignore, list) and old_name in ignore:
            other_cfg["refs_ignore"] = [new_name if x == old_name else x for x in ignore]

    # ships_with lifecycle (plan 1 W3): `_prune_skill_references` already
    # re-keyed `projects.<p>.companions.<old_name>` -> `<new_name>` above; a
    # hook whose registry `command` is a baked ABSOLUTE path into the skill
    # dir (`_apply_companions`) goes stale the moment that dir moves, so
    # re-bake it here — the only place that knows both the old and new dir.
    if new_src is not None and (sites.get("companions") or sites.get("companions_global")):
        hook_names: set[str] = set()
        for p in sites.get("companions") or []:
            entry = (projects[p].get("companions") or {}).get(new_name) or {}
            hook_names.update(entry.get("hooks") or [])
        if sites.get("companions_global"):
            g_entry = (registry.get("companions_global") or {}).get(new_name) or {}
            hook_names.update(g_entry.get("hooks") or [])
        hooks_map = registry.get("hooks") or {}
        old_src_str, new_src_str = str(src), str(new_src)
        for hook_name in sorted(hook_names):
            d = hooks_map.get(hook_name)
            command = d.get("command") if isinstance(d, dict) else None
            if isinstance(command, str) and command.startswith(old_src_str):
                d["command"] = new_src_str + command[len(old_src_str):]
                print(f"  {c('✓', GREEN)} re-baked hook command path: {hook_name}")

    hub_core.save_registry(registry)

    results = [hub.remove_symlink(hub_core.CLAUDE_SKILLS_DIR / old_name)]
    for proj_cfg in projects.values():
        proj_path = expand(proj_cfg["path"])
        results.append(hub.remove_symlink(proj_path / ".claude" / "skills" / old_name))
        results.append(hub.remove_symlink(proj_path / ".agents" / "skills" / old_name))

    print(f"{c('✓', GREEN)} renamed '{old_name}' → '{new_name}'")
    hub._warn_links_left_in_place(results)

    rewrite_agent_docs = bool(getattr(args, "rewrite_agent_docs", False))
    cascade: dict = {
        "rewritten": [],
        "skipped": [],
        "errors": [],
        "snippets_outdated": [],
        "renamed": True,
        "agent_docs_requested": rewrite_agent_docs,
    }
    if getattr(args, "rewrite_refs", False):
        from skill_hub.application.skills import rename_cascade

        try:
            cascade = rename_cascade.apply_cascade(
                registry,
                old_name,
                new_name,
                include_agent_docs=rewrite_agent_docs,
                backups_root=data_home() / "_hub-backups",
            )
        except Exception as exc:  # never let a cascade bug strand a completed rename
            cascade = {
                "rewritten": [],
                "skipped": [],
                "errors": [{"kind": "cascade", "name": "*", "error": repr(exc)}],
                "snippets_outdated": [],
                "renamed": True,
                "agent_docs_requested": rewrite_agent_docs,
            }
        for row in cascade.get("rewritten", []):
            print(f"  {c('✓', GREEN)} rewrote {row['count']}× in {row['kind']} {row['name']}")
        for err in cascade.get("errors", []):
            print(f"  {c('✗', RED)} {err['kind']} {err['name']}: {err['error']}", file=sys.stderr)

    payload = {
        "renamed": True,
        "old": old_name,
        "new": new_name,
        "rewritten": cascade.get("rewritten", []),
        "skipped": cascade.get("skipped", []),
        "errors": cascade.get("errors", []),
        "snippets_outdated": cascade.get("snippets_outdated", []),
        "agent_docs_requested": rewrite_agent_docs,
    }
    if getattr(args, "json", False):
        # Before the sync tail: the app's `parseCliJson` must find this
        # payload without fishing it out of the sync's own chatter.
        print(json.dumps(payload))

    hub._auto_sync_tail()

    if payload["errors"]:
        sys.exit(2)


def invocation_status(
    registry: dict, name: str, project: Optional[str] = None, *, operation_context=None
) -> dict:
    """Read current intent and native evidence. Never sync, probe, or save."""
    import hub
    from skill_hub.application.skills.skill_variants import invocation_preview
    from skill_hub.infrastructure.harnesses import harnesses

    if operation_context is None:
        from skill_hub.application.harnesses.harness_operation_context import KNOWN_HARNESSES, build_operation_context
        from skill_hub.domain.harnesses.harness_adapter_api import SDK_VERSION, Version

        installed_ids = sorted(harnesses.detect_installed())
        operation_context = build_operation_context(
            hub_core._resolve_data_home_path(),
            KNOWN_HARNESSES,
            requested_features=("skills", "invocation"),
            force_refresh=False,
            installed_harness_ids=installed_ids,
            host_version=Version.parse(hub_core.hub_version()),
            sdk_version=SDK_VERSION,
        )

    cfg = registry.get("skills", {}).get(name)
    if not cfg or cfg.get("type") == "mcp-server":
        return {"ok": False, "skill": name, "reason_code": "not-a-skill", "outcomes": [], "previews": {}}
    projects = registry.get("projects", {})
    if project is not None and project not in projects:
        return {"ok": False, "skill": name, "reason_code": "unknown-project", "outcomes": [], "previews": {}}
    installed = set(getattr(operation_context, "installed_harness_ids", ()) or ())
    proj = projects.get(project, {})
    is_global = cfg.get("scope") == "global"
    if project is None or is_global:
        targets = set(installed)
    else:
        effective_for = getattr(operation_context, "effective_harness_ids", None)
        targets = (
            set(effective_for(proj, registry))
            if callable(effective_for)
            else (
                set(registry.get("harnesses_global") or ())
                | set(proj.get("harnesses") or ())
            ) & installed & set(getattr(operation_context, "layouts", {}) or {})
        ) & installed
    affinity = hub._skill_affinity(cfg)
    if affinity is not None:
        targets &= affinity
    if name in skills_from_disabled_sources(registry):
        targets = set()
    if project is not None and not is_global and name not in hub.resolve_project_skills(proj, registry):
        targets = set()
    library = skill_invocation(cfg)
    override = (proj.get("invocation_overrides") or {}).get(name) if not is_global else None
    mode = override or library
    project_path = Path(proj["path"]) if project and not is_global and proj.get("path") else None
    previews = {
        choice: invocation_preview(
            name, cfg, targets, mode=choice, project=project, project_path=project_path,
            mode_origin="project" if project and not is_global else "library",
            operation_context=operation_context,
        )
        for choice in ("auto", "user-only", "model-only")
    }
    outcomes = invocation_preview(
        name, cfg, targets, mode=mode, project=project, project_path=project_path,
        mode_origin="project" if override else "library",
        operation_context=operation_context,
    )
    try:
        report_path = Path(str(operation_context.data_home)) / "state" / "sync-report.json"
        report = json.loads(report_path.read_text())
    except (OSError, ValueError):
        report = {}
    if is_global:
        records = [report.get("global", {}).get("skills", {})]
    elif project is not None:
        records = [report.get("projects", {}).get(project, {})]
    else:
        records = list(report.get("projects", {}).values())
    for row in outcomes:
        candidates = [
            saved for record in records for saved in record.get("invocation", [])
            if saved.get("skill") == name and saved.get("harness") == row["harness"]
            and saved.get("requested_mode") == mode
            and saved.get("input_fingerprint") == row.get("input_fingerprint")
            and saved.get("capability_profile") == row.get("capability_profile")
            and (saved.get("delivery") == "failed" or (
                saved.get("support") == row.get("support")
                and saved.get("mechanism") == row.get("mechanism")
                and saved.get("reason_code") == row.get("reason_code")
            ))
        ]
        if candidates:
            # A library summary must never hide a failed consumer behind one
            # successful project. Overrides are separately disclosed below.
            failed = next((saved for saved in candidates if saved.get("delivery") == "failed"), None)
            saved = failed or candidates[-1]
            row.update({key: saved[key] for key in (
                "delivery", "reason_code", "reason", "observed_at", "applied_mode",
            ) if key in saved})
    return {
        "ok": True, "skill": name, "project": project,
        "library": library, "override": override, "effective": mode,
        "targets": sorted(targets), "outcomes": outcomes, "previews": previews,
        "overridden_projects": sorted(
            key for key, value in projects.items()
            if name in (value.get("invocation_overrides") or {})
        ),
    }


def cmd_skill_invocation(args) -> None:
    payload = invocation_status(
        _read_registry_optional(), args.name, getattr(args, "project", None),
        operation_context=getattr(args, "_operation_context", None),
    )
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
    elif not payload["ok"]:
        print(payload["reason_code"])
    else:
        print(f"{args.name}: {payload['effective']}")
        for row in payload["outcomes"]:
            print(f"  {row['harness']}: {row['support']} ({row['delivery']})")
