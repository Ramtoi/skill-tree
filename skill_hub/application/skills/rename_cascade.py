"""Rename cascade: rewrite mentions of a renamed skill across the library.

`hub rename <old> <new> --rewrite-refs [--rewrite-agent-docs]` renames a skill
and then rewrites every mention of its old name it can safely reach: other
hub-owned skills' markdown files, the snippet library, and — opt-in — the
registered projects' agent docs. This module is the ONE enumeration both the
dry-run plan and the real apply read: `collect_cascade_targets` is called by
both `plan_cascade` and `apply_cascade`, so the dry-run can never describe a
set the run would not honour.

A leaf: module-scope imports are stdlib, `hub_core`, `skill_meta`, and
`skill_refs` only. `snippets` is imported function-locally (the same
`import snippets as _snippets` convention `hub_cli/snippet.py` already uses).
This module never imports `hub`.

See docs/SKILL-REFS.md ("Renaming a referenced skill") for the user-facing
contract and plans/3.md (§CLI contract, §Interfaces) for the design.
"""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import Any, Iterator, Optional

from skill_hub import hub_core
from skill_hub.domain.skills import skill_refs
from skill_hub.infrastructure.registry import sources

# A closed set — mirrored, verbatim, by the TypeScript twin.
SKIP_REASONS = (
    "source-managed",
    "snippet-owned",
    "unreadable",
    "unparseable-frontmatter",
    "project-quarantined",
)

_AGENT_DOC_MIRROR = {"AGENTS.md": "CLAUDE.md", "CLAUDE.md": "AGENTS.md"}


# ---------------------------------------------------------------------------
# The one collector
# ---------------------------------------------------------------------------


def collect_cascade_targets(
    registry: dict,
    old: str,
    new: str,
    *,
    exclude_keys: set,
    include_agent_docs: bool,
) -> dict:
    """The ONE enumeration both `plan_cascade` and `apply_cascade` read.

    Returns ``{"targets": [row, ...], "skipped": [row, ...]}``. A target row
    is ``{kind, name, path, count, new_text, project?, rel?}`` — `new_text`
    is the already-rewritten content, so a writer never re-derives it. A
    skipped row is ``{kind, name, reason, count}`` with `reason` drawn from
    `SKIP_REASONS`. Reads files, writes nothing, never raises: an unreadable
    or unparseable file becomes a `skipped` row instead of stopping the walk.

    `exclude_keys` is the renamed skill's own registry key(s) — the dry-run
    plan runs before the registry re-key (the registry still holds `old`) and
    the real apply runs after it (the registry holds `new`), so every caller
    passes ``{old, new}`` and this function never has to know which side of
    the rename it is on. Self is never a referrer.
    """
    skill_rows, skill_skips = _skill_targets(registry, old, new, exclude_keys)
    snippet_rows = _snippet_targets(old, new)

    if include_agent_docs:
        doc_rows, doc_skips = _agent_doc_targets(registry, old, new)
    else:
        doc_rows, doc_skips = [], []

    targets = skill_rows + snippet_rows + doc_rows
    skipped = skill_skips + doc_skips
    return {"targets": targets, "skipped": skipped}


def plan_cascade(registry: dict, old: str, new: str) -> dict:
    """The dry-run plan (`hub rename <old> <new> --dry-run --json`).

    Calls the collector with ``exclude_keys={old, new}``,
    ``include_agent_docs=True`` (the dialog needs the count to decide whether
    its own toggle is live, even before the user opts in), drops `new_text`,
    and shapes the §CLI contract dry-run payload.
    """
    result = collect_cascade_targets(registry, old, new, exclude_keys={old, new}, include_agent_docs=True)
    targets = result["targets"]
    skipped = result["skipped"]

    referrer_skills = sorted(
        ({"name": t["name"], "count": t["count"]} for t in targets if t["kind"] == "skill"),
        key=lambda r: r["name"],
    )
    referrer_snippets = sorted(
        ({"name": t["name"], "count": t["count"]} for t in targets if t["kind"] == "snippet"),
        key=lambda r: r["name"],
    )
    referrer_docs = sorted(
        (
            {"project": t["project"], "rel": t["rel"], "path": str(t["path"]), "count": t["count"]}
            for t in targets
            if t["kind"] == "agent_doc"
        ),
        key=lambda r: (r["project"], r["rel"]),
    )
    skipped_out = sorted(
        ({"kind": s["kind"], "name": s["name"], "reason": s["reason"], "count": s["count"]} for s in skipped),
        key=lambda s: (s["kind"], s["name"]),
    )

    library_refs = sum(r["count"] for r in referrer_skills) + sum(r["count"] for r in referrer_snippets)
    agent_doc_refs = sum(r["count"] for r in referrer_docs)
    skipped_total = sum(s["count"] for s in skipped_out)
    project_count = len({r["project"] for r in referrer_docs})

    return {
        "dry_run": True,
        "old": old,
        "new": new,
        "referrers": {
            "skills": referrer_skills,
            "snippets": referrer_snippets,
            "agent_docs": referrer_docs,
        },
        "skipped": skipped_out,
        "totals": {
            "skills": len(referrer_skills),
            "snippets": len(referrer_snippets),
            "agent_docs": len(referrer_docs),
            "projects": project_count,
            "library_refs": library_refs,
            "agent_doc_refs": agent_doc_refs,
            "refs": library_refs + agent_doc_refs,
            "skipped": skipped_total,
            "files": len(referrer_skills) + len(referrer_snippets) + len(referrer_docs),
        },
    }


def apply_cascade(
    registry: dict,
    old: str,
    new: str,
    *,
    include_agent_docs: bool,
    backups_root: Path,
) -> dict:
    """Run the rewrite. Calls the SAME collector with ``exclude_keys={old, new}``,
    then writes each target, per file, error-isolated. Never unwinds the
    rename: a per-file write failure lands in ``errors[]`` and the other
    targets are still written. "Never raises" is a docstring promise here —
    the enforcement is the caller wrapping this whole call in a
    ``try/except``.
    """
    result = collect_cascade_targets(
        registry, old, new, exclude_keys={old, new}, include_agent_docs=include_agent_docs
    )
    targets = result["targets"]
    skipped = result["skipped"]

    run_dir_label = f"{time.strftime('%Y%m%d-%H%M%S')}-{old}-to-{new}"

    rewritten: list[dict] = []
    errors: list[dict] = []
    snippets_outdated: list[str] = []

    for t in sorted(targets, key=lambda row: (row["kind"], row["name"])):
        try:
            if t["kind"] == "snippet":
                row = _apply_snippet(t, old, new, backups_root, run_dir_label)
                snippets_outdated.append(t["name"])
            else:
                row = _apply_file(t, old, new, backups_root, run_dir_label)
            rewritten.append(row)
        except _StaleContentError as exc:
            err = {"kind": t["kind"], "name": t["name"], "error": str(exc)}
            if t["kind"] == "agent_doc":
                err["path"] = str(t["path"])
            errors.append(err)
        except Exception as exc:  # noqa: BLE001 — per-file isolation, never stops the cascade
            err: dict[str, Any] = {"kind": t["kind"], "name": t["name"], "error": repr(exc)}
            if t["kind"] == "agent_doc":
                err["path"] = str(t["path"])
            errors.append(err)

    _attach_mirror_hints(errors, rewritten)

    return {
        "renamed": True,
        "old": old,
        "new": new,
        "rewritten": rewritten,
        "skipped": skipped,
        "errors": errors,
        "snippets_outdated": sorted(snippets_outdated),
        "agent_docs_requested": include_agent_docs,
    }


# ---------------------------------------------------------------------------
# Skill referrers
# ---------------------------------------------------------------------------


def _skill_targets(registry: dict, old: str, new: str, exclude_keys: set) -> tuple[list[dict], list[dict]]:
    skills = registry.get("skills")
    if not isinstance(skills, dict):
        skills = {}

    targets: list[dict] = []
    skipped: list[dict] = []

    for name, cfg in sorted(skills.items()):
        if name in exclude_keys:
            continue
        if not isinstance(cfg, dict) or cfg.get("type") != "claude-skill":
            continue
        raw = cfg.get("source")
        if not isinstance(raw, str) or not raw.strip():
            continue
        root = hub_core.expand(raw)
        ownership = sources.infer_skill_ownership(name, cfg)
        source_managed = ownership["managed"] in {"external", "starter"}
        skill_hit_total = 0

        for fpath in _iter_skill_md_files(root):
            try:
                text = fpath.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                if not source_managed:
                    skipped.append(
                        {"kind": "skill", "name": _row_name(name, root, fpath), "reason": "unreadable", "count": 0}
                    )
                continue

            if _frontmatter_unparseable(text):
                if not source_managed:
                    skipped.append(
                        {
                            "kind": "skill",
                            "name": _row_name(name, root, fpath),
                            "reason": "unparseable-frontmatter",
                            "count": 0,
                        }
                    )
                continue

            hits = skill_refs.find_refs(text, [old])
            if not hits:
                continue
            skill_hit_total += len(hits)
            if source_managed:
                continue

            targets.append(
                {
                    "kind": "skill",
                    "name": _row_name(name, root, fpath),
                    "path": fpath,
                    "count": len(hits),
                }
            )

        if source_managed and skill_hit_total:
            skipped.append({"kind": "skill", "name": name, "reason": "source-managed", "count": skill_hit_total})

    return targets, skipped


def _row_name(skill: str, root: Path, path: Path) -> str:
    if path.name == "SKILL.md" and path.parent == root:
        return skill
    return f"{skill}/{path.relative_to(root).as_posix()}"


def _iter_skill_md_files(root: Path) -> Iterator[Path]:
    """Every `*.md` under `root`, bounded and symlink-skipping.

    Bounds reused from `snippets.py` rather than re-invented — the same walk
    `hub snippet status` already runs on an agent-doc root.
    """
    from skill_hub.infrastructure.filesystem import snippets as _snippets

    if not root.is_dir():
        return
    count = 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        reldir = Path(dirpath).relative_to(root)
        if len(reldir.parts) >= _snippets.MAX_SCAN_DEPTH:
            dirnames[:] = []
        for fname in sorted(filenames):
            if not fname.endswith(".md"):
                continue
            fpath = Path(dirpath) / fname
            if fpath.is_symlink():
                continue
            yield fpath
            count += 1
            if count >= _snippets.MAX_SCAN_FILES:
                return


# ---------------------------------------------------------------------------
# Snippet-library referrers
# ---------------------------------------------------------------------------


def _snippet_targets(old: str, new: str) -> list[dict]:
    from skill_hub.infrastructure.filesystem import snippets as _snippets

    sdir = _snippets.snippets_dir(hub_core.data_home())
    targets: list[dict] = []
    for snip in _snippets.list_snippets(sdir):
        hits = skill_refs.find_refs(snip.body, [old])
        if not hits:
            continue
        targets.append(
            {
                "kind": "snippet",
                "name": snip.name,
                "path": sdir / f"{snip.name}.md",
                "count": len(hits),
            }
        )
    return targets


# ---------------------------------------------------------------------------
# Agent-doc referrers (opt-in)
# ---------------------------------------------------------------------------


def _agent_doc_targets(registry: dict, old: str, new: str) -> tuple[list[dict], list[dict]]:
    from skill_hub.infrastructure.filesystem import snippets as _snippets

    projects = registry.get("projects")
    if not isinstance(projects, dict):
        projects = {}

    targets: list[dict] = []
    skipped: list[dict] = []

    for pname, pcfg in sorted(projects.items()):
        if not isinstance(pcfg, dict):
            continue
        if pcfg.get("path_unresolved"):
            skipped.append({"kind": "agent_doc", "name": pname, "reason": "project-quarantined", "count": 0})
            continue
        raw_path = pcfg.get("path")
        if not isinstance(raw_path, str) or not raw_path.strip():
            continue
        root = hub_core.expand(raw_path)

        for rel in _snippets.iter_agent_doc_files(root):
            fpath = root / rel
            row_name = f"{pname}/{rel}"
            try:
                text = fpath.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                skipped.append({"kind": "agent_doc", "name": row_name, "reason": "unreadable", "count": 0})
                continue

            if _frontmatter_unparseable(text):
                skipped.append(
                    {"kind": "agent_doc", "name": row_name, "reason": "unparseable-frontmatter", "count": 0}
                )
                continue

            hits = skill_refs.find_refs(text, [old])
            if not hits:
                continue

            protected = _snippet_protected_spans(text)
            kept = [h for h in hits if not _in_spans(h["offset"], protected)]
            protected_count = len(hits) - len(kept)
            if protected_count:
                skipped.append(
                    {"kind": "agent_doc", "name": row_name, "reason": "snippet-owned", "count": protected_count}
                )
            if not kept:
                continue

            targets.append(
                {
                    "kind": "agent_doc",
                    "name": row_name,
                    "path": fpath,
                    "project": pname,
                    "rel": rel,
                    "count": len(kept),
                }
            )

    return targets, skipped


def _frontmatter_unparseable(text: str) -> bool:
    text_without_bom = text.removeprefix("\ufeff")
    return text_without_bom.startswith("---") and skill_refs.split_frontmatter(text)[0] is None


def _snippet_protected_spans(content: str) -> list[tuple[int, int]]:
    """Byte spans of `content` owned by a hub-managed snippet marker block —
    rewriting text inside one would make the block read `modified`, which
    `hub snippet update` deliberately skips."""
    from skill_hub.infrastructure.filesystem import snippets as _snippets

    scan = _snippets.scan_content(content)
    return [(b["start"], b["end"]) for b in scan["blocks"]]


def _in_spans(offset: int, spans: list[tuple[int, int]]) -> bool:
    return any(start <= offset < end for start, end in spans)


# ---------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------


class _StaleContentError(RuntimeError):
    pass


def _flat_name(t: dict) -> str:
    """The backup file's flattened name — the human-readable recovery path.

    A skill or snippet target's `path` lives under `data_home()`, so its
    relative parts already read as `skills__<skill>__SKILL.md` or
    `snippets__<name>.md`. An agent-doc target lives outside the data home,
    so it is flattened from its project name + relative path instead.
    """
    if t["kind"] == "agent_doc":
        parts = [t["project"], *Path(t["rel"]).parts]
        return "__".join(parts)
    path: Path = t["path"]
    try:
        rel_parts = path.relative_to(hub_core.data_home()).parts
    except ValueError:
        rel_parts = (t["kind"], path.name)
    return "__".join(rel_parts)


def _backup(path: Path, flat_name: str, backups_root: Path, run_dir_label: str) -> Optional[str]:
    if not path.is_file():
        return None
    dest_dir = backups_root / "rename" / run_dir_label
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / flat_name
    n = 1
    while dest.exists():
        dest = dest_dir / f"{flat_name}.{n}"
        n += 1
    shutil.copy2(path, dest, follow_symlinks=True)
    return str(dest)


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".hub-tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


def _apply_file(t: dict, old: str, new: str, backups_root: Path, run_dir_label: str) -> dict:
    path: Path = t["path"]
    backup = _backup(path, _flat_name(t), backups_root, run_dir_label)
    current = path.read_text(encoding="utf-8")
    if t["kind"] == "agent_doc":
        protected = _snippet_protected_spans(current)
        hits = skill_refs.find_refs(current, [old])
        kept = [h for h in hits if not _in_spans(h["offset"], protected)]
        if not kept:
            raise _StaleContentError(
                f"stale-content: the file changed after the scan and no longer mentions {old}"
            )
        new_text, count = skill_refs._apply_ref_hits(current, kept, old, new)
    else:
        new_text, count = skill_refs.rewrite_refs(current, old, new)
        if count == 0:
            raise _StaleContentError(
                f"stale-content: the file changed after the scan and no longer mentions {old}"
            )
    _atomic_write(path, new_text)
    row: dict[str, Any] = {"kind": t["kind"], "name": t["name"], "count": count}
    if backup:
        row["backup"] = backup
    if t["kind"] == "agent_doc":
        row["path"] = str(path)
    return row


def _apply_snippet(t: dict, old: str, new: str, backups_root: Path, run_dir_label: str) -> dict:
    from skill_hub.infrastructure.filesystem import snippets as _snippets

    sdir = _snippets.snippets_dir(hub_core.data_home())
    path: Path = t["path"]
    backup = _backup(path, _flat_name(t), backups_root, run_dir_label)
    current_snippet = _snippets.get_snippet(sdir, t["name"])
    current, count = skill_refs.rewrite_refs(current_snippet.body, old, new)
    if count == 0:
        raise _StaleContentError(
            f"stale-content: the file changed after the scan and no longer mentions {old}"
        )
    snippet, _changed = _snippets.edit_snippet(sdir, t["name"], body=current)
    row: dict[str, Any] = {"kind": "snippet", "name": t["name"], "count": count, "version": snippet.version}
    if backup:
        row["backup"] = backup
    return row


def _attach_mirror_hints(errors: list[dict], rewritten: list[dict]) -> None:
    """Name a failed agent-doc's mirror partner when it was rewritten OK —
    `CLAUDE.md`/`AGENTS.md` are bound by byte-identity, and a half-failed
    pair silently unbinds unless this says so."""
    rewritten_names = {r["name"] for r in rewritten if r["kind"] == "agent_doc"}
    for err in errors:
        if err["kind"] != "agent_doc":
            continue
        project, _sep, rel = err["name"].partition("/")
        rel_path = Path(rel)
        partner_base = _AGENT_DOC_MIRROR.get(rel_path.name)
        if not partner_base:
            continue
        partner_name = f"{project}/{rel_path.with_name(partner_base)}"
        if partner_name in rewritten_names:
            err["hint"] = f"its mirror partner {partner_name} was rewritten"
