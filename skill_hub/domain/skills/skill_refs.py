"""Skill cross-reference resolver.

A reference is a SKILL.md body mention of a registered skill name, either as an
exact backtick span (`` `deliver-it` ``, ``form: "backtick"``) or as a slash
token (``/deliver-it``, ``form: "slash"``). Bare slugs in prose are never
references, frontmatter is never scanned, and a name inside a fenced code
block still counts. The exact regex sources and every boundary rule are
pinned in ``plans/INTERFACES.md`` and mirrored, verbatim, by the TypeScript
twin ``app/src/lib/skillRefs.ts``.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence

# ---------------------------------------------------------------------------
# The matching rule — copied verbatim from plans/INTERFACES.md. Nothing else
# decides a hit. Only lookaheads and a leading alternation group are used (no
# lookbehind), and character classes are ASCII-explicit (never ``\w``), so the
# TypeScript twin can share the exact same source strings.
# ---------------------------------------------------------------------------

BACKTICK_SPAN_SOURCE = r"`([^`\n]+)`"
SLASH_REF_SOURCE = (
    r"(^|[^A-Za-z0-9_/.~(])/([a-z0-9][a-z0-9-]*)"
    r"(?![A-Za-z0-9_-])(?!/)(?!\.[A-Za-z0-9_])"
)

BACKTICK_SPAN_RE = re.compile(BACKTICK_SPAN_SOURCE, re.MULTILINE)
SLASH_REF_RE = re.compile(SLASH_REF_SOURCE, re.MULTILINE)


def split_frontmatter(text: str) -> tuple[Optional[str], str]:
    """Split ``text`` into ``(frontmatter, body)``.

    A straight port of the Rust ``split_frontmatter``
    (``app/src-tauri/src/commands/registry.rs:130-160``). Strips every leading
    BOM; the closing fence must use the same line-ending style as the opening
    one; the body has every leading repetition of that line ending removed. An
    unterminated (or absent, or empty) frontmatter fence means the whole file
    is body — the caller never treats that as an error.
    """
    stripped = text.lstrip("﻿")

    if stripped.startswith("---\r\n"):
        after_open = stripped[len("---\r\n") :]
        eol = "\r\n"
    elif stripped.startswith("---\n"):
        after_open = stripped[len("---\n") :]
        eol = "\n"
    else:
        return None, stripped

    closer = f"{eol}---{eol}"
    idx = after_open.find(closer)
    if idx == -1:
        return None, stripped

    frontmatter = after_open[:idx]
    body = after_open[idx + len(closer) :]
    while body.startswith(eol):
        body = body[len(eol) :]
    return frontmatter, body


# The exact whitespace class used to decide "single token" — pinned to the
# ASCII-explicit-classes doctrine at the top of this file rather than
# ``str.isspace()``/JS ``\s``, whose locale-dependent character sets diverge
# (Python's includes NEL/U+001C..U+001F, JS's includes U+FEFF) and would
# otherwise make this one predicate disagree with the TypeScript twin.
_TOKEN_WS = " \t\n\r\f\v"


def _is_single_token(content: str) -> bool:
    """True when ``content`` (a backtick span's content) has no whitespace."""
    return not any(ch in _TOKEN_WS for ch in content)


def find_refs(
    text: str,
    names: Iterable[str],
    self_name: Optional[str] = None,
    ignore: Iterable[str] = (),
) -> list[dict[str, Any]]:
    """Every reference to a registered skill name inside ``text``'s body.

    Returns ``[{"name": str, "form": "backtick" | "slash", "offset": int,
    "length": int}]`` sorted by ``(offset, name)``. ``self_name`` and every
    entry of ``ignore`` are removed from the target set before scanning.
    Offsets are indices into the FULL original ``text`` (frontmatter, if any,
    is skipped over). Pure: no I/O.
    """
    target_names = set(names)
    if self_name is not None:
        target_names.discard(self_name)
    for name in ignore:
        target_names.discard(name)

    _, body = split_frontmatter(text)
    base = len(text) - len(body)

    hits: list[dict[str, Any]] = []
    consumed_spans: list[tuple[int, int, str]] = []

    for match in BACKTICK_SPAN_RE.finditer(body):
        start, end = match.span()
        content = match.group(1)
        consumed_spans.append((start, end, content))
        if content in target_names:
            hits.append(
                {
                    "name": content,
                    "form": "backtick",
                    "offset": base + start,
                    "length": end - start,
                }
            )

    for match in SLASH_REF_RE.finditer(body):
        name = match.group(2)
        if name not in target_names:
            continue
        slash_pos = match.end(1)

        enclosing: Optional[tuple[int, int]] = None
        for span_start, span_end, span_content in consumed_spans:
            if span_start <= slash_pos < span_end and _is_single_token(span_content):
                enclosing = (span_start, span_end)
                break

        if enclosing is not None:
            span_start, span_end = enclosing
            hits.append(
                {
                    "name": name,
                    "form": "slash",
                    "offset": base + span_start,
                    "length": span_end - span_start,
                }
            )
        else:
            hits.append(
                {
                    "name": name,
                    "form": "slash",
                    "offset": base + slash_pos,
                    "length": 1 + len(name),
                }
            )

    hits.sort(key=lambda hit: (hit["offset"], hit["name"]))
    return hits


def count_refs(
    text: str,
    names: Iterable[str],
    self_name: Optional[str] = None,
    ignore: Iterable[str] = (),
) -> dict[str, int]:
    """Hit count per target name; a name with zero hits is absent."""
    counts: dict[str, int] = {}
    for hit in find_refs(text, names, self_name, ignore):
        counts[hit["name"]] = counts.get(hit["name"], 0) + 1
    return counts


def build_graph(registry: dict[str, Any]) -> dict[str, Any]:
    """The whole reference graph: ``{"edges": [{"from", "to", "count"}]}``.

    Sources are registry skills with ``type == "claude-skill"``, including
    ``scope: global`` ones. Targets are every registered skill name (an
    ``mcp-server`` may be a target, never a source). Each source's own
    ``refs_ignore`` is applied while scanning it, so no consumer needs to
    re-apply it. An unreadable or unparseable SKILL.md contributes no edges
    and never raises. Imports ``hub`` lazily so importing this module never
    imports ``hub``.
    """
    import hub as _hub

    skills = registry.get("skills")
    if not isinstance(skills, dict):
        skills = {}

    all_names = set(skills.keys())
    edges: dict[tuple[str, str], int] = {}

    for name, cfg in skills.items():
        if not isinstance(cfg, dict):
            continue
        if cfg.get("type") != "claude-skill":
            continue

        text: Optional[str] = None
        try:
            patched = _hub.skill_rename_patch(name, cfg)
            if isinstance(patched, str):
                text = patched
            else:
                source = _hub.skill_source(cfg)
                text = Path(source, "SKILL.md").read_text(encoding="utf-8")
        except Exception:
            continue

        ignore = cfg.get("refs_ignore")
        if not isinstance(ignore, list):
            ignore = []

        for target, count in count_refs(text, all_names, name, ignore).items():
            key = (name, target)
            edges[key] = edges.get(key, 0) + count

    edge_list = [
        {"from": src, "to": tgt, "count": count}
        for (src, tgt), count in sorted(edges.items())
    ]
    return {"edges": edge_list}


def missing_refs_for(
    active_names: Sequence[str],
    registry: dict[str, Any],
    graph: dict[str, Any],
    global_sources: Sequence[str] = (),
) -> list[dict[str, Any]]:
    """Per-skill missing references for a project's active skill set.

    A finding is emitted for a source in ``active_names ∪ global_sources``
    whose graph edge targets a name that IS in the registry, is NOT in
    ``active_names``, and whose registered ``scope`` is not ``"global"``.
    ``refs_ignore`` needs no re-application here — ``build_graph`` already
    applied it. Returns ``[{"skill": str, "refs": [str, ...]}]`` sorted by
    ``skill``, each ``refs`` sorted alphabetically; a skill with no missing
    ref produces no entry.
    """
    skills = registry.get("skills")
    if not isinstance(skills, dict):
        skills = {}

    active_set = set(active_names)
    source_set = active_set | set(global_sources)

    missing: dict[str, set[str]] = {}
    for edge in graph.get("edges", []):
        source = edge.get("from")
        target = edge.get("to")
        if source not in source_set:
            continue
        target_cfg = skills.get(target)
        if not isinstance(target_cfg, dict):
            continue
        if target in active_set:
            continue
        if target_cfg.get("scope") == "global":
            continue
        missing.setdefault(source, set()).add(target)

    result: list[dict[str, Any]] = [
        {"skill": skill, "refs": sorted(refs)}
        for skill, refs in missing.items()
        if refs
    ]
    result.sort(key=lambda entry: str(entry["skill"]))
    return result


def rewrite_refs(text: str, old: str, new: str) -> tuple[str, int]:
    """Return ``(rewritten_text, substitutions_made)``.

    Built on ``find_refs(text, [old])``. Hits are first DEDUPED by
    ``(offset, length)``: a slash reference inside a single-token backtick span
    is reported once per slash match but names ONE span, so ``` `/old,/old` ```
    yields two hits with identical spans.

    Each surviving span is then rewritten by FORM, in place (see
    ``_apply_ref_hits``):

    * ``form == "backtick"`` — the span is exactly `` `old` ``; it becomes
      `` `new` ``.
    * ``form == "slash"`` — the span is either the bare ``/old`` or a whole
      single-token backtick span that contains one or more slash references.
      The span is rewritten with ``SLASH_REF_RE.sub``, substituting only the
      matches whose ``group(2) == old``, preserving ``group(1)`` verbatim and
      replacing EVERY occurrence. This is what makes ``` `old-/old` ``` become
      ``` `old-/new` ``` (a plain string replace would rewrite the ``old-``
      prefix and leave the reference) and ``` `/old,/old` ``` become
      ``` `/new,/new` ```.

    Spans are applied in descending offset order, so earlier offsets stay
    valid. Distinct span keys are disjoint by construction: a backtick hit
    requires span content equal to the name, a slash hit's enclosing span
    contains a slash, and bare slash spans cannot nest.

    The returned count is the number of substitutions ACTUALLY MADE, never
    ``len(hits)`` — so a caller's reported count and the bytes on disk can
    never disagree.

    Frontmatter is skipped only as far as ``find_refs`` skips it: a file whose
    fence never closes is all body, which is why a cascade caller refuses such
    a file rather than rewriting it. Line endings are never touched — the
    function splices by offset and never re-joins lines, so a CRLF body
    round-trips byte-for-byte outside the spliced spans. Pure: no I/O.
    """
    hits = find_refs(text, [old])
    return _apply_ref_hits(text, hits, old, new)


def _apply_ref_hits(text: str, hits: list[dict[str, Any]], old: str, new: str) -> tuple[str, int]:
    """Splice ``new`` for ``old`` at each of ``hits`` (offset/length/form dicts
    in the shape ``find_refs`` returns), deduped by span and rewritten by
    form. A caller with its own pre-filtered hit list (for example one that
    drops hits inside a protected region) gets the exact same splicing
    mechanics ``rewrite_refs`` uses, without re-scanning the text.
    """
    if not hits:
        return text, 0

    spans: dict[tuple[int, int], str] = {}
    for hit in hits:
        spans.setdefault((hit["offset"], hit["length"]), hit["form"])

    result = text
    total = 0
    for (offset, length), form in sorted(spans.items(), key=lambda kv: kv[0][0], reverse=True):
        span_text = result[offset : offset + length]
        if form == "backtick":
            result = result[:offset] + f"`{new}`" + result[offset + length :]
            total += 1
        else:
            new_span, count = _rewrite_slash_span(span_text, old, new)
            result = result[:offset] + new_span + result[offset + length :]
            total += count
    return result, total


def _rewrite_slash_span(span_text: str, old: str, new: str) -> tuple[str, int]:
    """Rewrite every ``/old`` occurrence inside one span's text, preserving
    the character (or start-of-string) that precedes each match."""
    count = 0

    def _repl(m: "re.Match") -> str:
        nonlocal count
        if m.group(2) != old:
            return m.group(0)
        count += 1
        return f"{m.group(1)}/{new}"

    return SLASH_REF_RE.sub(_repl, span_text), count
