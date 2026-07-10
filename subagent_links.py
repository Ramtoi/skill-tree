#!/usr/bin/env python3
"""subagent_links — linked-twin membership + shared-core co-write + drift.

Design D3 (linked twins): a *logical* sub-agent identified by its `name` across
harnesses. Linking is **explicit, recorded state** stored in a hub-side link
sidecar at ``<data_home>/state/subagents/links.json``:

    {"links": [{"name": str, "scope": "user",
                "harnesses": ["claude-code", "codex"], "linked_at": iso8601}]}

The sidecar holds **membership only, never content** — the native agent files
remain the sole content storage (no registry mirror). A same-name pair NOT in
the sidecar is merely a *link suggestion*; a sidecar-linked pair whose twin file
is missing surfaces as *twin-lost* rather than silently degrading.

Shared core = ``{description, instructions (the body), skills}``. ``name`` is the
link identity (equal by construction). ``model`` and every overlay field are
PER-HARNESS and are never cross-written.

**User scope only in this wave** (project linking ships with Wave 8); project-
scope link ops are rejected with a clean error.

This module reuses ``subagents`` (loaded lazily to avoid an import cycle — the
Claude-only path never needs it) for path/parse/serialize helpers.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Optional

# Shared-core fields co-written across linked files (name is identity; handled
# separately). ``instructions`` is the agent body / developer_instructions.
SHARED_FIELDS = ["description", "instructions", "skills"]


# ─────────────────────────────────────────────────────────────────────────────
# Lazy imports (avoid import cycle: subagents imports us lazily too)
# ─────────────────────────────────────────────────────────────────────────────

def _sa():
    import subagents
    return subagents


def agent_capable_harness_ids() -> list[str]:
    """Harness ids that model sub-agent definitions (agents_dir is not None)."""
    import harnesses
    return [hid for hid, h in harnesses.HARNESSES.items() if h.agents_dir is not None]


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────────────────────
# Sidecar IO — atomic write, tolerant read (missing/corrupt ⇒ [] + warning)
# ─────────────────────────────────────────────────────────────────────────────

def _links_file() -> Path:
    import hub
    return hub.data_home() / "state" / "subagents" / "links.json"


def read_links() -> tuple[list[dict], Optional[str]]:
    """Tolerant read of the link sidecar. Returns (links, warning). A missing
    file ⇒ ([], None); a corrupt/malformed file ⇒ ([], warning-string) — never
    raises."""
    p = _links_file()
    if not p.exists():
        return [], None
    try:
        data = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError) as e:
        return [], f"link sidecar unreadable ({e}); treated as empty"
    if not isinstance(data, dict):
        return [], "link sidecar malformed (top-level not an object); treated as empty"
    raw = data.get("links")
    if not isinstance(raw, list):
        return [], "link sidecar malformed (no links array); treated as empty"
    out: list[dict] = []
    for entry in raw:
        if (isinstance(entry, dict) and entry.get("name")
                and isinstance(entry.get("harnesses"), list)):
            out.append(entry)
    return out, None


def write_links(links: list[dict]) -> None:
    """Atomic (temp + os.replace) write of the whole sidecar."""
    p = _links_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps({"links": links}, indent=2, ensure_ascii=False) + "\n"
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def find_link(name: str, scope: str) -> Optional[dict]:
    """Return the sidecar entry for (name, scope) or None."""
    links, _ = read_links()
    for e in links:
        if e.get("name") == name and (e.get("scope") or "user") == scope:
            return e
    return None


def _rename_link(old: str, new: str, scope: str) -> None:
    links, _ = read_links()
    changed = False
    for e in links:
        if e.get("name") == old and (e.get("scope") or "user") == scope:
            e["name"] = new
            changed = True
    if changed:
        write_links(links)


# ─────────────────────────────────────────────────────────────────────────────
# Shared-core projection + drift
# ─────────────────────────────────────────────────────────────────────────────

def shared_core_from_doc(doc: dict, hid: str) -> dict:
    """Project a parsed agent doc onto the harness-neutral shared core."""
    sa = _sa()
    fm = doc["frontmatter"]
    body = doc.get("body") or ""
    if hid == "codex":
        skills = list(fm.get("skills") or [])
    else:
        skills = sa._as_tool_list(fm.get("skills"))
    desc = fm.get("description")
    return {
        "name": str(fm.get("name") or ""),
        "description": "" if desc is None else str(desc),
        "instructions": body,
        "skills": [str(s) for s in skills],
    }


def shared_core_from_payload(payload: dict) -> dict:
    """Project a save payload onto the shared core."""
    safe = payload.get("safe") or {}
    desc = safe.get("description")
    return {
        "name": str(safe.get("name") or "").strip(),
        "description": "" if desc is None else str(desc),
        "instructions": payload.get("body") or "",
        "skills": [str(s).strip() for s in (safe.get("skills") or []) if str(s).strip()],
    }


def _instr_norm(s: Any) -> str:
    """Trailing-whitespace normalization for the instructions projection —
    Claude's normalize_body appends a trailing newline that TOML strings don't
    carry, so a normal save must not manufacture perpetual false drift."""
    return str(s or "").rstrip()


def _field_equal(field: str, a: Any, b: Any) -> bool:
    if field == "instructions":
        return _instr_norm(a) == _instr_norm(b)
    if field == "skills":
        return list(a or []) == list(b or [])
    return str(a or "") == str(b or "")


def compute_drift(cores_by_harness: dict[str, Optional[dict]]) -> list[dict]:
    """Per-field drift over the shared-core projections of the linked files.

    Result: ``[{field, values: {<harness>: value, ...}}]``. Fewer than two
    present cores ⇒ no drift (nothing to compare)."""
    present = {h: c for h, c in cores_by_harness.items() if c is not None}
    if len(present) < 2:
        return []
    hids = sorted(present)
    out: list[dict] = []
    for f in SHARED_FIELDS:
        drift = False
        for i in range(len(hids)):
            for j in range(i + 1, len(hids)):
                if not _field_equal(f, present[hids[i]][f], present[hids[j]][f]):
                    drift = True
        if drift:
            out.append({"field": f, "values": {h: present[h][f] for h in hids}})
    return out


def _core_for(name: str, hid: str, scope: str, registry: Optional[dict]) -> Optional[dict]:
    sa = _sa()
    f = sa._find_agent_file(name, scope, None, registry, hid)
    if f is None:
        return None
    doc = sa.load_agent_file(f, hid)
    if doc is None:
        return None
    return shared_core_from_doc(doc, hid)


# ─────────────────────────────────────────────────────────────────────────────
# Link presence / suggestion computation (cheap, one scan per harness)
# ─────────────────────────────────────────────────────────────────────────────

def present_names_by_harness(scope: str, registry: Optional[dict]) -> dict[str, set]:
    """One scan of each agent-capable harness's scope dir → {harness: {names}}."""
    sa = _sa()
    out: dict[str, set] = {}
    for hid in agent_capable_harness_ids():
        names: set[str] = set()
        try:
            adir = sa.agents_dir(scope, None, registry, hid)
            for f in sa._iter_agent_files(adir, hid):
                doc = sa.load_agent_file(f, hid)
                if doc:
                    nm = str(doc["frontmatter"].get("name") or "").strip()
                    if nm:
                        names.add(nm)
        except (ValueError, OSError):
            pass
        out[hid] = names
    return out


def link_info_for(name: str, hid: str, scope: str, links: list[dict],
                  present: dict[str, set]) -> Optional[dict]:
    """Compute the ``link`` field for one agent. Returns the dict when the agent
    is linked OR a same-name twin suggestion exists; otherwise ``None`` (a plain
    standalone agent)."""
    for e in links:
        if e.get("name") == name and (e.get("scope") or "user") == scope:
            hs = list(e.get("harnesses") or [])
            if hid in hs:
                twin_lost = any(
                    oh != hid and name not in present.get(oh, set()) for oh in hs)
                return {"linked": True, "harnesses": hs,
                        "twin_lost": twin_lost, "suggested": False}
    # Not linked in this harness — is the same name present elsewhere?
    others = [oh for oh in present if oh != hid and name in present.get(oh, set())]
    if others:
        return {"linked": False, "harnesses": sorted({hid, *others}),
                "twin_lost": False, "suggested": True}
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Twin content builder (merge shared-core fields into an existing twin file,
# preserving that file's model + overlay + advanced/unknown keys)
# ─────────────────────────────────────────────────────────────────────────────

def _build_twin_content(hid: str, file: Path, update: dict,
                        new_name: Optional[str]) -> str:
    """Render new file content for a twin: start from its existing doc, override
    only the shared-core fields in ``update`` (and ``name`` when renaming), keep
    everything else (model, overlays, advanced keys) verbatim."""
    sa = _sa()
    doc = sa.load_agent_file(file, hid)
    fm = doc["frontmatter"]
    body = doc.get("body") or ""
    if hid == "codex":
        sc = sa._codex()
        existing_text = file.read_text()
        safe = sa._codex_safe(fm)
        try:
            advanced = sc.advanced_fragment(existing_text)
        except ValueError:
            advanced = ""
        if new_name:
            safe["name"] = new_name
        if "description" in update:
            safe["description"] = update["description"]
        if "skills" in update:
            safe["skills"] = list(update["skills"])
        new_body = update["instructions"] if "instructions" in update else body
        return sc.render_codex_agent(existing_text, safe, advanced, new_body)
    # claude-code
    safe, advanced = sa.split_safe_advanced(fm)
    if new_name:
        safe["name"] = new_name
    if "description" in update:
        safe["description"] = update["description"]
    if "skills" in update:
        safe["skills"] = list(update["skills"])
    new_body = update["instructions"] if "instructions" in update else body
    new_fm, _ = sa.build_frontmatter(safe, advanced)
    return sa.serialize_agent(new_fm, sa.normalize_body(new_body))


def _restore(path: Path, data: Optional[bytes]) -> None:
    """Undo a write during rollback: rewrite the original bytes, or remove the
    file if it did not exist before."""
    try:
        if data is None:
            if path.exists():
                path.unlink()
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    except OSError:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Linked save (co-write shared core, freeze drifted fields, transactional
# two-file rename)
# ─────────────────────────────────────────────────────────────────────────────

def save_linked(payload: dict, registry: Optional[dict], link: dict, hid: str) -> dict:
    """Save a LINKED agent. Validates against the payload harness, blocks a
    change to a currently-drifted shared field, co-writes changed non-drifted
    shared-core fields into the twin (freezing drifted fields), and renames both
    files transactionally (backup + rollback on any failure)."""
    sa = _sa()
    sc = sa._codex()
    scope = "user"
    original_name = payload.get("original_name")
    safe = payload.get("safe") or {}
    advanced = payload.get("advanced_yaml") or ""
    body = payload.get("body") or ""

    # 1. Build + validate H's frontmatter view.
    if hid == "codex":
        fm, build_w = sc.build_frontmatter_view(safe, advanced)
    else:
        fm, build_w = sa.build_frontmatter(safe, advanced)

    adir = sa.agents_dir(scope, None, registry, hid)
    existing_names: set[str] = set()
    for f in sa._iter_agent_files(adir, hid):
        d = sa.load_agent_file(f, hid)
        if d:
            nm = str(d["frontmatter"].get("name") or "").strip()
            if nm:
                existing_names.add(nm)

    original_skills = sa._original_skills_set(
        original_name, scope, None, registry, hid)
    v = sa._validate_for_harness(fm, body, scope, None, registry, hid,
                                 original_name=original_name,
                                 existing_names=existing_names,
                                 original_skills=original_skills)
    all_w = build_w + v["warnings"]
    errors = [w for w in all_w if w["level"] == "error"]
    if errors:
        return {"ok": False, "errors": errors}

    new_name = str(fm.get("name")).strip()
    is_rename = new_name != original_name

    # 2. Locate H's file + build its new content.
    h_old = sa._find_agent_file(original_name, scope, None, registry, hid)
    if h_old is None:
        return {"ok": False, "errors": [{
            "field": "name", "level": "error",
            "message": "linked agent file not found", "value": original_name}]}
    h_existing_text = h_old.read_text() if h_old.exists() else None

    if hid == "codex":
        suffix = sc.DISABLED_SUFFIX if sc.is_disabled_file(h_old) else sc.ENABLED_SUFFIX
        h_new = adir / f"{new_name}{suffix}"
        try:
            h_content = sc.render_codex_agent(h_existing_text, safe, advanced, body)
        except ValueError as e:
            return {"ok": False, "errors": [{
                "field": "advanced_yaml", "level": "error",
                "message": str(e), "value": ""}]}
    else:
        h_new = adir / f"{new_name}.md"
        h_content = sa.serialize_agent(fm, sa.normalize_body(body))

    if is_rename:
        tgt = sa._find_agent_file(new_name, scope, None, registry, hid)
        if tgt is not None and tgt != h_old:
            return {"ok": False, "errors": [{
                "field": "name", "level": "error",
                "message": f"cannot rename to '{new_name}': an agent with that name already exists",
                "value": new_name}]}

    # 3. Compute drift between H and the twin, and which shared fields changed.
    h_old_core = shared_core_from_doc(sa.load_agent_file(h_old, hid), hid)
    new_core = shared_core_from_payload(payload)

    twin_hids = [h for h in (link.get("harnesses") or []) if h != hid]
    twin_hid = twin_hids[0] if twin_hids else None
    twin_old = (sa._find_agent_file(original_name, scope, None, registry, twin_hid)
                if twin_hid else None)
    twin_core = None
    if twin_old is not None:
        twin_core = shared_core_from_doc(sa.load_agent_file(twin_old, twin_hid), twin_hid)

    drift_fields: set[str] = set()
    if twin_core is not None:
        for d in compute_drift({hid: h_old_core, twin_hid: twin_core}):
            drift_fields.add(d["field"])

    changed = [f for f in SHARED_FIELDS if not _field_equal(f, new_core[f], h_old_core[f])]
    blocked = [f for f in changed if f in drift_fields]
    if blocked:
        return {"ok": False, "errors": [{
            "field": f, "level": "error",
            "message": "this field has drifted between the linked files — resolve the drift first",
            "value": f} for f in blocked]}

    # 4. Twin update = changed non-drifted shared fields (drifted fields frozen).
    twin_update = {f: new_core[f] for f in changed if f not in drift_fields}
    twin_new = None
    twin_content = None
    if twin_old is not None and (twin_update or is_rename):
        twin_adir = sa.agents_dir(scope, None, registry, twin_hid)
        if twin_hid == "codex":
            tsuffix = (sc.DISABLED_SUFFIX if sc.is_disabled_file(twin_old)
                       else sc.ENABLED_SUFFIX)
            twin_new = twin_adir / f"{new_name}{tsuffix}"
        else:
            twin_new = twin_adir / f"{new_name}.md"
        if is_rename:
            ttgt = sa._find_agent_file(new_name, scope, None, registry, twin_hid)
            if ttgt is not None and ttgt != twin_old:
                return {"ok": False, "errors": [{
                    "field": "name", "level": "error",
                    "message": f"cannot rename twin to '{new_name}': an agent with that name already exists",
                    "value": new_name}]}
        twin_content = _build_twin_content(
            twin_hid, twin_old, twin_update, new_name if is_rename else None)

    # 5. Transactional write: H first, twin second; rollback both on failure.
    targets = [(h_old, h_new, h_content)]
    if twin_content is not None:
        targets.append((twin_old, twin_new, twin_content))

    modified: dict[Path, Optional[bytes]] = {}
    try:
        for (old_p, new_p, content) in targets:
            if new_p not in modified:
                modified[new_p] = new_p.read_bytes() if new_p.exists() else None
            if new_p.exists():
                sa._backup_settings(new_p)
            elif old_p is not None and old_p != new_p and old_p.exists():
                sa._backup_settings(old_p)
            sa._atomic_write(new_p, content)
            if old_p is not None and old_p != new_p and old_p.exists():
                if old_p not in modified:
                    modified[old_p] = old_p.read_bytes()
                old_p.unlink()
        if is_rename:
            _rename_link(original_name, new_name, scope)
    except Exception as e:  # noqa: BLE001 — rollback then report cleanly
        for p in reversed(list(modified)):
            _restore(p, modified[p])
        return {"ok": False, "errors": [{
            "field": "file", "level": "error",
            "message": f"linked save failed and was rolled back: {e}", "value": ""}]}

    return {
        "ok": True,
        "name": new_name,
        "file": str(h_new),
        "warnings": all_w,
        "renamed_from": original_name if is_rename else None,
        "cowrote_twin": twin_content is not None,
        "twin_harness": twin_hid,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Public link / unlink / status / resolve ops
# ─────────────────────────────────────────────────────────────────────────────

def _name_valid_for(name: str, hid: str) -> bool:
    sa = _sa()
    if hid == "codex":
        return bool(sa._codex().CODEX_SLUG_RE.match(name))
    return bool(sa.SLUG_RE.match(name))


def link_agents(name: str, harnesses: Optional[list[str]] = None, scope: str = "user",
                registry: Optional[dict] = None, copy_from: Optional[str] = None) -> dict:
    """Record a link between the same-named agent across ``harnesses``. When a
    target harness lacks the file and ``copy_from`` is given, project the shared
    core from ``copy_from`` into a new file there (model NOT carried — inherit;
    overlay empty; body translated)."""
    sa = _sa()
    if scope != "user":
        return {"ok": False, "error": "linking is user-scope only in this release"}
    caps = agent_capable_harness_ids()
    hs = list(harnesses) if harnesses else list(caps)
    for h in hs:
        if h not in caps:
            return {"ok": False,
                    "error": f"harness '{h}' does not support sub-agent definitions"}
    if len(set(hs)) < 2:
        return {"ok": False, "error": "linking requires at least two harnesses"}
    for h in hs:
        if not _name_valid_for(name, h):
            return {"ok": False,
                    "error": f"name '{name}' is not a valid agent name for harness '{h}'"}

    present = {h: sa._find_agent_file(name, scope, None, registry, h) is not None
               for h in hs}
    missing = [h for h in hs if not present[h]]
    if missing:
        if copy_from is None:
            return {"ok": False,
                    "error": f"agent '{name}' is missing in {missing}; "
                             f"pass copy_from to project it"}
        if copy_from not in hs:
            return {"ok": False,
                    "error": f"copy_from '{copy_from}' is not in the link set {hs}"}
        if not present.get(copy_from):
            return {"ok": False,
                    "error": f"copy_from harness '{copy_from}' has no agent '{name}'"}
        src_core = _core_for(name, copy_from, scope, registry)
        if src_core is None:
            return {"ok": False,
                    "error": f"could not read source agent '{name}' in '{copy_from}'"}
        for tgt in missing:
            proj = {
                "harness": tgt, "scope": "user", "original_name": None,
                "safe": {"name": name, "description": src_core["description"],
                         "skills": src_core["skills"]},
                "advanced_yaml": "", "body": src_core["instructions"],
            }
            res = sa.save_agent(proj, registry)
            if not res.get("ok"):
                return {"ok": False,
                        "error": f"projecting '{name}' into '{tgt}' failed",
                        "errors": res.get("errors")}

    for h in hs:
        if sa._find_agent_file(name, scope, None, registry, h) is None:
            return {"ok": False, "error": f"agent '{name}' still missing in '{h}' after link"}

    links, _ = read_links()
    links = [e for e in links
             if not (e.get("name") == name and (e.get("scope") or "user") == scope)]
    entry = {"name": name, "scope": scope, "harnesses": sorted(set(hs)),
             "linked_at": _now_iso()}
    links.append(entry)
    write_links(links)

    drift = compute_drift({h: _core_for(name, h, scope, registry) for h in hs})
    return {"ok": True, "name": name, "harnesses": entry["harnesses"],
            "linked_at": entry["linked_at"], "drift": drift}


def unlink_agents(name: str, scope: str = "user") -> dict:
    """Remove the sidecar entry for (name, scope). Files are left untouched — a
    subsequent list shows ``suggested: true`` (never an auto-relink)."""
    links, _ = read_links()
    kept = [e for e in links
            if not (e.get("name") == name and (e.get("scope") or "user") == scope)]
    unlinked = len(kept) != len(links)
    if unlinked:
        write_links(kept)
    return {"ok": True, "name": name, "unlinked": unlinked}


def link_status(scope: str = "user", registry: Optional[dict] = None) -> dict:
    """{links: [{name, harnesses, twin_lost, drift}], suggestions: [{name, harnesses}]}."""
    links, warn = read_links()
    present = present_names_by_harness(scope, registry)
    result_links: list[dict] = []
    linked_names: set[str] = set()
    for e in links:
        if (e.get("scope") or "user") != scope:
            continue
        name = e["name"]
        hs = list(e.get("harnesses") or [])
        linked_names.add(name)
        twin_lost = any(name not in present.get(h, set()) for h in hs)
        drift = compute_drift({h: _core_for(name, h, scope, registry) for h in hs})
        result_links.append({"name": name, "harnesses": hs,
                             "twin_lost": twin_lost, "drift": drift})

    name_to_harnesses: dict[str, list[str]] = {}
    for h, names in present.items():
        for nm in names:
            name_to_harnesses.setdefault(nm, []).append(h)
    suggestions = []
    for nm, hs in sorted(name_to_harnesses.items()):
        if nm in linked_names:
            continue
        if len(hs) >= 2:
            suggestions.append({"name": nm, "harnesses": sorted(hs)})

    out: dict = {"links": result_links, "suggestions": suggestions}
    if warn:
        out["links_warning"] = warn
    return out


def resolve_drift(name: str, scope: str, registry: Optional[dict],
                  decisions: dict) -> dict:
    """For each decided field, write the winner harness's value into the loser
    file(s) (translated). Backup-first every present file. Returns remaining
    drift."""
    sa = _sa()
    link = find_link(name, scope)
    if link is None:
        return {"ok": False, "error": f"agent '{name}' is not linked"}
    hs = list(link.get("harnesses") or [])
    cores = {h: _core_for(name, h, scope, registry) for h in hs}
    present = {h: c for h, c in cores.items() if c is not None}
    if len(present) < 2:
        return {"ok": False, "error": "cannot resolve drift: a twin file is missing"}

    writes: dict[str, dict] = {}
    for field, winner in (decisions or {}).items():
        if field not in SHARED_FIELDS:
            return {"ok": False, "error": f"unknown shared-core field '{field}'"}
        if winner not in present:
            return {"ok": False,
                    "error": f"winner harness '{winner}' is not present for field '{field}'"}
        wval = present[winner][field]
        for h in present:
            if h == winner:
                continue
            writes.setdefault(h, {})[field] = wval

    # Backup-first every present file, then write losers.
    files = {h: sa._find_agent_file(name, scope, None, registry, h) for h in present}
    for h, f in files.items():
        if f is not None:
            sa._backup_settings(f)
    for h, upd in writes.items():
        f = files[h]
        if f is None:
            continue
        content = _build_twin_content(h, f, upd, None)
        sa._atomic_write(f, content)

    remaining = compute_drift({h: _core_for(name, h, scope, registry) for h in hs})
    return {"ok": True, "name": name, "drift": remaining}
