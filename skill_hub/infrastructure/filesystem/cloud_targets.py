"""Cloud upload targets — the `cloud:` registry block + the deterministic ZIP.

A *cloud target* is a hosted chat surface that consumes Skill Hub skills but
exposes **no API**: the only sanctioned path is a manual ZIP upload in its
settings UI. Today that is claude.ai and ChatGPT on the web. ChatGPT's *desktop*
app is NOT a cloud target — it reads `~/.agents/skills`, which the existing
`codex` harness already writes (see `chatgpt_desktop_installed`, surfaced as an
annotation on `hub harness list`).

Because there is no API, hub cannot push and cannot read back. What it CAN do is
be honest about what it handed the user: this module owns

  * `CLOUD_TARGETS` — the fixed, in-code catalog (never registry-driven: these
    are properties of somebody else's product, not user config).
  * `build_skill_zip` — a byte-reproducible ZIP in claude.ai's required layout
    (exactly one top-level dir named after the skill, `SKILL.md` inside it).
  * `content_fingerprint` — the canonical drift fingerprint.
  * the per-target export-state sidecar under `<data_home>/state/cloud/`.
  * `compute_status` — the `new` / `up_to_date` / `changed` / `orphaned` grammar
    plus the claude.ai frontmatter caps as non-blocking lints.

Fingerprint choice (documented once, used everywhere): the stored + reported
`sha256` is the **content-walk** fingerprint, not the sha256 of the `.zip`
container. The zip IS byte-reproducible (so its own sha would work), but
`hub cloud status` must answer "has this drifted?" WITHOUT writing a zip, and a
content hash is computable from the source tree alone. One value, one meaning.

Like `.skillpack`, ZIP export REFUSES `type: mcp-server` entries: their runtime
block (`command`/`args`/`env`) lives in the registry and `env` can hold secrets.
Those show up in `hub cloud status` under `unsupported` with a reason, never in
an export.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from skill_hub import hub_core

# ─────────────────────────────────────────────────────────────────────────────
# Catalog — fixed in code, NOT registry-driven
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CloudTarget:
    """One hosted surface reachable only by a manual ZIP upload."""

    id: str
    label: str
    upload_url: str
    upload_path: str          # human breadcrumb through the target's own UI
    supports: tuple[str, ...] = ("skill",)
    notes: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "upload_url": self.upload_url,
            "upload_path": self.upload_path,
            "supports": list(self.supports),
            "notes": list(self.notes),
        }


CLOUD_TARGETS: dict[str, CloudTarget] = {
    "claude-ai": CloudTarget(
        id="claude-ai",
        label="claude.ai",
        # Verified against support.claude.com (articles 12512180 / 12512198),
        # which both link this exact path for managing + uploading skills.
        upload_url="https://claude.ai/customize/skills",
        upload_path="Customize > Skills > + > Create skill (upload the .zip)",
        supports=("skill",),
        notes=(
            "The ZIP must contain the skill folder as its root (not a subfolder) "
            "— `<skill>/SKILL.md`. Hub builds exactly that layout.",
            "Skills you enable in claude.ai settings follow your account across "
            "claude.ai and the Claude desktop app, and are also available in the "
            "Claude add-ins for Excel, PowerPoint, Word and Outlook. Anthropic's "
            "docs do not state that they reach the Claude mobile apps — check the "
            "app before relying on it.",
            "MCP servers are NOT uploadable here: claude.ai only talks to REMOTE "
            "connectors you add by URL in its own settings. A local stdio server "
            "(the kind hub manages) cannot connect.",
            "Frontmatter caps: name <= 64 chars, description <= 200 chars.",
        ),
    ),
    "chatgpt-web": CloudTarget(
        id="chatgpt-web",
        label="ChatGPT (web)",
        # OpenAI publishes no deep link for the Skills page; the breadcrumb below
        # is the documented path from help.openai.com's "Skills in ChatGPT".
        upload_url="https://chatgpt.com",
        upload_path="Plugins > Skills > Create > Upload from your computer",
        supports=("skill",),
        notes=(
            "ChatGPT reads the same SKILL.md package format, so hub's ZIP "
            "uploads as-is.",
            "Personal skills do NOT sync across surfaces: a skill uploaded on "
            "the web is not installed on the ChatGPT mobile app (or vice versa) "
            "— upload it again there.",
            "MCP connectors here are developer-mode and REMOTE-only; a local "
            "stdio server cannot connect.",
            "ChatGPT's DESKTOP app reads ~/.agents/skills, which the `codex` "
            "harness already writes for `scope: global` skills — set a skill's "
            "scope to global to land it there. A project equip writes "
            "<repo>/.agents/skills instead, so it reaches the desktop app only "
            "inside that repo's workspace.",
        ),
    ),
}


def get_target(target_id: str) -> Optional[CloudTarget]:
    return CLOUD_TARGETS.get(target_id)


# claude.ai's hard frontmatter caps (article 12512198). Lints, never blocks.
NAME_MAX = 64
DESCRIPTION_MAX = 200


# ─────────────────────────────────────────────────────────────────────────────
# ChatGPT desktop probe — one stat(), monkeypatchable
# ─────────────────────────────────────────────────────────────────────────────


CHATGPT_DESKTOP_APP = Path("/Applications/ChatGPT.app")
CHATGPT_DESKTOP_LABEL = "ChatGPT desktop app"


def chatgpt_desktop_installed() -> bool:
    """True when the macOS ChatGPT desktop app is present.

    Deliberately a single `Path.exists()` — no subprocess, no version probe — so
    `hub harness list` stays cheap, and trivially monkeypatchable in tests.
    """
    try:
        return CHATGPT_DESKTOP_APP.exists()
    except OSError:
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Registry block: `cloud:` — absent means nothing equipped anywhere
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CloudEquip:
    """One `cloud:<target>` entry — the project equip model, nothing else."""

    id: str
    bundles: tuple[str, ...] = ()
    enabled: tuple[str, ...] = ()
    apply_global_bundles: bool = False

    @classmethod
    def from_dict(cls, target_id: str, data: Optional[dict]) -> "CloudEquip":
        data = data if isinstance(data, dict) else {}
        return cls(
            id=target_id,
            bundles=_str_tuple(data.get("bundles")),
            enabled=_str_tuple(data.get("enabled")),
            apply_global_bundles=bool(data.get("apply_global_bundles", False)),
        )

    def to_cfg(self) -> dict:
        """The sanitized equip config the shared project/remote resolver eats.

        Every reader goes through this instead of the raw registry dict, so a
        hand-edited `cloud:` block can never hand a resolver a string where it
        expects a list.
        """
        return {
            "bundles": list(self.bundles),
            "enabled": list(self.enabled),
            "apply_global_bundles": self.apply_global_bundles,
        }


def _str_tuple(value) -> tuple[str, ...]:
    """Coerce a registry list-of-names field to a clean tuple of strings.

    `cloud.<id>.bundles: "pack"` (a hand-edit typo) must not iterate a string
    character by character, and a nested dict/int must not reach the resolver.
    """
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(v for v in value if isinstance(v, str) and v)


def load_cloud(registry: dict) -> dict[str, CloudEquip]:
    """Parse the `cloud:` block into `{target_id: CloudEquip}` (empty if absent).

    Unknown target ids are dropped: the catalog is the authority, and a stale key
    left behind by a downgrade must never invent a target.
    """
    raw = registry.get("cloud") if isinstance(registry, dict) else None
    out: dict[str, CloudEquip] = {}
    if not isinstance(raw, dict):
        return out
    for target_id, data in raw.items():
        if target_id in CLOUD_TARGETS and isinstance(data, dict):
            out[target_id] = CloudEquip.from_dict(target_id, data)
    return out


def equip_for(target_id: str, registry: dict) -> CloudEquip:
    """The sanitized `CloudEquip` for one target (empty when absent/malformed).

    THE single entry point every reader uses. `load_cloud` used to be dead
    production code — `partition_equipped` read the raw dict — so `cloud: "nope"`
    or `cloud: {claude-ai: "nope"}` crashed every `hub cloud` command with an
    AttributeError. Sanitization only counts when it is on the real path.
    """
    return load_cloud(registry).get(target_id) or CloudEquip(id=target_id)


def resolve_cloud_skills(cloud_cfg: dict, registry: dict) -> list:
    """Resolve a cloud target's equipped skills via the remote/project resolver.

    Straight delegation to `remotes.resolve_remote_skills` (which itself
    delegates to `hub.resolve_project_skills`) so a cloud target's
    `bundles` / `enabled` resolve EXACTLY like a project's or a remote's — one
    equip model, one union, one dedup order. Like a remote, a cloud target does
    not inherit `scope: global` bundles unless it sets `apply_global_bundles`.
    """
    from skill_hub.infrastructure.remotes.remotes import resolve_remote_skills

    return resolve_remote_skills(cloud_cfg or {}, registry)


# ─────────────────────────────────────────────────────────────────────────────
# The deterministic ZIP
# ─────────────────────────────────────────────────────────────────────────────


# The ZIP spec's epoch — the lowest DOS timestamp a zip entry can carry. Fixed
# so the archive bytes never encode when it was built.
ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)
# Fixed member permissions: rw-r--r-- for everything (an uploaded skill's
# executable bit is meaningless on the far side, and a varying mode would break
# byte-reproducibility across machines with different umasks).
ZIP_FILE_MODE = 0o644
FINGERPRINT_DOMAIN = b"skill-tree-cloud-zip-v1\n"


def _extra_ignored(rel_posix: str) -> bool:
    """Junk the skillpack walk does not already drop.

    `hub.collect_skill_pack_files` excludes `.DS_Store`, `__pycache__/` and
    `.hub-bak*`; a stray `foo.pyc` sitting OUTSIDE a `__pycache__` dir would
    still ride along. The zip exclusion set is a documented superset.
    """
    return rel_posix.endswith((".pyc", ".pyo"))


def collect_zip_entries(
    root: Path, skill_md_override: Optional[str] = None
) -> list[tuple[str, bytes]]:
    """`[(relative_posix_path, bytes)]` for a skill dir, sorted, junk-free.

    Reuses `hub.collect_skill_pack_files` verbatim — same junk exclusions, same
    "skip symlinks that resolve outside the skill dir (with a warning)" rule,
    same sorted order — so a `.skillpack` and a `.zip` of one skill can never
    disagree about what the skill contains. Only the extra `*.pyc` filter above
    is layered on top.

    `skill_md_override` replaces the SKILL.md bytes (never adds them): the
    EFFECTIVE content of a renamed source-managed skill, whose upstream file
    still carries the pre-suffix name (`hub.skill_rename_patch`). Substituted
    here so the fingerprint and the archive can never disagree about it.
    """
    import hub

    entries: list[tuple[str, bytes]] = []
    for entry in hub.collect_skill_pack_files(root):
        rel = entry["path"]
        if _extra_ignored(rel):
            continue
        if rel == "SKILL.md" and skill_md_override is not None:
            entries.append((rel, skill_md_override.encode("utf-8")))
            continue
        entries.append((rel, hub.decode_skill_pack_entry(entry)))
    entries.sort(key=lambda e: e[0])
    return entries


def content_fingerprint(
    skill_name: str, root: Path, skill_md_override: Optional[str] = None
) -> str:
    """The canonical drift fingerprint: sha256 over the content walk.

    Hashes a domain tag, the top-level dir name, then every entry as
    `path \\0 len \\0 bytes`. Length-prefixing each blob keeps the stream
    unambiguous (no `a`+`bc` vs `ab`+`c` collision), and folding in the skill
    name means a rename is drift even when the bytes are identical.

    Computable from the source tree alone — that is why status can classify
    drift without building a zip.
    """
    h = hashlib.sha256()
    h.update(FINGERPRINT_DOMAIN)
    h.update(skill_name.encode("utf-8") + b"\0")
    for rel, data in collect_zip_entries(root, skill_md_override):
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(str(len(data)).encode("ascii"))
        h.update(b"\0")
        h.update(data)
    return h.hexdigest()


def build_skill_zip(
    skill_name: str,
    root: Path,
    out_path: Path,
    skill_md_override: Optional[str] = None,
) -> dict:
    """Write a byte-reproducible ZIP of one skill and return its metadata.

    Layout is what claude.ai requires: exactly ONE top-level folder named after
    the skill, with `SKILL.md` inside it (`<skill>/SKILL.md`,
    `<skill>/references/...`). No wrapper dir, no `./` prefix.

    Determinism, so the same tree always yields the same bytes (and therefore a
    comparable archive):
      * entries written in sorted order (from `collect_zip_entries`),
      * every `ZipInfo.date_time` pinned to the 1980 ZIP epoch,
      * fixed 0o644 permissions and a fixed `create_system` (Unix), so neither
        the builder's umask nor its OS leaks into the archive,
      * deflate at the default level (zlib is deterministic for equal input).

    Written to a sibling temp file and `os.replace`d into place, so a reader
    never sees a half-written archive.

    Returns `{"zip_path", "sha256", "files", "bytes"}` where `sha256` is the
    CONTENT fingerprint (see module docstring), not the archive's own digest.
    """
    entries = collect_zip_entries(root, skill_md_override)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_name(out_path.name + ".tmp")
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
            for rel, data in entries:
                info = zipfile.ZipInfo(f"{skill_name}/{rel}", date_time=ZIP_EPOCH)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3  # Unix, regardless of the building OS
                info.external_attr = (stat.S_IFREG | ZIP_FILE_MODE) << 16
                zf.writestr(info, data)
        os.replace(tmp, out_path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    return {
        "zip_path": str(out_path),
        "sha256": content_fingerprint(skill_name, root, skill_md_override),
        "files": len(entries),
        "bytes": out_path.stat().st_size,
    }


def zip_name_for(skill_name: str) -> str:
    """`<skill>.zip`, refusing any name that is not a bare slug.

    A skill name is a registry KEY and a sidecar KEY — both plain text a user
    (or a restored backup) can hand-edit. Unvalidated, `../../pwned` turns this
    filename into a path that escapes the export dir on write and, worse, on the
    prune's `unlink()`. `hub_core.SLUG_RE` is the same pattern every other name gate
    in the repo uses, applied here at the one place a name becomes a filename.
    """
    if not isinstance(skill_name, str) or not hub_core.SLUG_RE.match(skill_name):
        raise ValueError(
            f"unsafe skill name for an export filename: {skill_name!r} "
            f"(must match {hub_core.SLUG_RE.pattern})"
        )
    return f"{skill_name}.zip"


def recorded_zip_name(skill_name: str, entry: Optional[dict]) -> Optional[str]:
    """The archive name a sidecar entry refers to — basename only, or None.

    The sidecar is hub's own state, but it is a plain JSON file on disk: a
    doctored `zip_name` must not steer a delete. Only the BASENAME of whatever
    it stored is honoured, and when neither that nor the skill name yields a
    safe filename the caller gets `None` (display "—", never unlink).
    """
    raw = (entry or {}).get("zip_name")
    if isinstance(raw, str) and raw.strip():
        base = os.path.basename(raw.strip())
        if base and base not in (".", ".."):
            return base
    try:
        return zip_name_for(skill_name)
    except ValueError:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Export-state sidecar — <data_home>/state/cloud/<target>.json
# ─────────────────────────────────────────────────────────────────────────────


SIDECAR_SCHEMA_VERSION = 1


def sidecar_dir() -> Path:
    return hub_core.data_home() / "state" / "cloud"


def sidecar_path(target_id: str) -> Path:
    return sidecar_dir() / f"{target_id}.json"


def empty_sidecar() -> dict:
    return {"schema_version": SIDECAR_SCHEMA_VERSION, "skills": {}}


def read_sidecar(target_id: str) -> dict:
    """Read a target's export state; a corrupt/foreign file is treated as empty.

    Fail-OPEN by design: this file records only "what we last handed the user",
    so losing it costs a re-export, never data. Refusing to run because a JSON
    byte flipped would be strictly worse. Corruption is reported through
    `_corrupt` so callers can warn.
    """
    path = sidecar_path(target_id)
    if not path.exists():
        return empty_sidecar()
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        out = empty_sidecar()
        out["_corrupt"] = str(path)
        return out
    if not isinstance(data, dict) or not isinstance(data.get("skills"), dict):
        out = empty_sidecar()
        out["_corrupt"] = str(path)
        return out
    skills = {
        name: entry
        for name, entry in data["skills"].items()
        if isinstance(entry, dict)
    }
    return {
        "schema_version": data.get("schema_version", SIDECAR_SCHEMA_VERSION),
        "skills": skills,
    }


def write_sidecar(target_id: str, data: dict) -> Path:
    """Atomically persist a target's export state (temp + `os.replace`)."""
    path = sidecar_path(target_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": SIDECAR_SCHEMA_VERSION,
        "skills": data.get("skills") or {},
    }
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, path)
    return path


# ─────────────────────────────────────────────────────────────────────────────
# Lints — claude.ai's frontmatter caps. Warn, never block.
# ─────────────────────────────────────────────────────────────────────────────


def lint_skill(
    skill_name: str, root: Path, skill_md_override: Optional[str] = None
) -> list[str]:
    """Frontmatter warnings for one skill dir (empty list = clean).

    claude.ai rejects a skill whose `name` exceeds 64 chars or whose
    `description` exceeds 200, and a missing description makes it undiscoverable.
    We surface all three as warnings so a user can still export deliberately.

    `skill_md_override` lints the EFFECTIVE SKILL.md (see `collect_zip_entries`)
    so the warnings describe the bytes that actually ship.
    """
    import hub

    warnings: list[str] = []
    skill_md = Path(root) / "SKILL.md"
    if not skill_md.exists():
        return [f"SKILL.md not found at {skill_md} — the upload will be rejected."]
    if skill_md_override is not None:
        front = hub.parse_frontmatter_text(skill_md_override)
    else:
        front = hub.parse_skill_frontmatter(skill_md)
    if front is None:
        return ["SKILL.md has no readable `---` frontmatter block."]

    raw_name = front.get("name")
    front_name = str(raw_name).strip() if raw_name is not None else ""
    if not front_name:
        warnings.append("frontmatter `name:` is missing.")
    elif len(front_name) > NAME_MAX:
        warnings.append(
            f"frontmatter `name:` is {len(front_name)} chars "
            f"(max {NAME_MAX} on claude.ai)."
        )

    raw_desc = front.get("description")
    desc = str(raw_desc).strip() if raw_desc is not None else ""
    if not desc:
        warnings.append(
            "frontmatter `description:` is missing — the target cannot tell when "
            "to use the skill."
        )
    elif len(desc) > DESCRIPTION_MAX:
        warnings.append(
            f"frontmatter `description:` is {len(desc)} chars "
            f"(max {DESCRIPTION_MAX} on claude.ai)."
        )
    return warnings


# ─────────────────────────────────────────────────────────────────────────────
# Status — the new / up_to_date / changed / orphaned grammar
# ─────────────────────────────────────────────────────────────────────────────


STATUS_NEW = "new"
STATUS_UP_TO_DATE = "up_to_date"
STATUS_CHANGED = "changed"
STATUS_MISSING = "missing"


@dataclass
class SkillStatus:
    name: str
    status: str
    sha256: Optional[str] = None            # current content fingerprint
    exported_sha256: Optional[str] = None   # what the sidecar recorded
    exported_at: Optional[str] = None
    zip_name: Optional[str] = None
    lint: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "skill": self.name,
            "status": self.status,
            "sha256": self.sha256,
            "exported_sha256": self.exported_sha256,
            "exported_at": self.exported_at,
            "zip_name": self.zip_name,
            "lint": list(self.lint),
        }


def partition_equipped(target_id: str, registry: dict) -> tuple[list[str], list[dict]]:
    """Split a target's equipped skills into `(exportable, unsupported)`.

    Unsupported today means `type: mcp-server` (secrets in its `env`; same rule
    the `.skillpack` format enforces) or a name the registry no longer knows.

    Reads through `equip_for` — never the raw registry dict — so a malformed
    hand-edited `cloud:` block degrades to "nothing equipped" instead of raising
    out of every `hub cloud` command (and out of the app's Cloud band).
    """
    cloud_block = equip_for(target_id, registry).to_cfg()
    skills = registry.get("skills") or {}
    if not isinstance(skills, dict):
        skills = {}
    exportable: list[str] = []
    unsupported: list[dict] = []
    for name in resolve_cloud_skills(cloud_block, registry):
        cfg = skills.get(name)
        if not isinstance(cfg, dict):
            unsupported.append(
                {"skill": name, "reason": "not in the registry any more"}
            )
            continue
        if cfg.get("type") == "mcp-server":
            unsupported.append(
                {
                    "skill": name,
                    "reason": (
                        "MCP server — cloud targets only accept skill ZIPs, and "
                        "its runtime env may hold secrets"
                    ),
                }
            )
            continue
        exportable.append(name)
    return exportable, unsupported


def last_exported_at(recorded: dict) -> Optional[str]:
    """The most recent `exported_at` in a sidecar's skills map (None if never).

    The single most useful glance fact after drift — "you handed this target
    something two weeks ago" — and the only date hub can honestly claim, since
    it cannot know when (or whether) the ZIP was actually uploaded. ISO-8601
    stamps of one format sort lexicographically, which is why `max` suffices.
    """
    stamps = [
        entry["exported_at"]
        for entry in (recorded or {}).values()
        if isinstance(entry, dict) and isinstance(entry.get("exported_at"), str)
    ]
    return max(stamps) if stamps else None


def compute_status(target_id: str, registry: dict) -> dict:
    """Full status payload for one cloud target (read-only; builds no zips)."""
    import hub

    target = CLOUD_TARGETS[target_id]
    sidecar = read_sidecar(target_id)
    recorded = sidecar["skills"]
    exportable, unsupported = partition_equipped(target_id, registry)
    skills_cfg = registry.get("skills") or {}

    rows: list[SkillStatus] = []
    for name in exportable:
        root = hub.skill_source(skills_cfg[name])
        entry = recorded.get(name) or {}
        exported_sha = entry.get("sha256")
        if not Path(root).is_dir():
            rows.append(
                SkillStatus(
                    name=name,
                    status=STATUS_MISSING,
                    exported_sha256=exported_sha,
                    exported_at=entry.get("exported_at"),
                    zip_name=recorded_zip_name(name, entry),
                    lint=[f"source directory not found: {root}"],
                )
            )
            continue
        # Effective SKILL.md: a renamed source-managed skill exports (and so
        # fingerprints, and so lints) under its registry key, not the upstream
        # name its checkout still declares.
        renamed = hub.skill_rename_patch(name, skills_cfg[name])
        current = content_fingerprint(name, Path(root), renamed)
        if not exported_sha:
            status = STATUS_NEW
        elif exported_sha == current:
            status = STATUS_UP_TO_DATE
        else:
            status = STATUS_CHANGED
        rows.append(
            SkillStatus(
                name=name,
                status=status,
                sha256=current,
                exported_sha256=exported_sha,
                exported_at=entry.get("exported_at"),
                zip_name=recorded_zip_name(name, entry),
                lint=lint_skill(name, Path(root), renamed),
            )
        )

    equipped = set(exportable)
    orphaned = [
        {
            "skill": name,
            "sha256": (recorded[name] or {}).get("sha256"),
            "exported_at": (recorded[name] or {}).get("exported_at"),
            "zip_name": recorded_zip_name(name, recorded[name]),
        }
        for name in sorted(recorded)
        if name not in equipped
    ]

    summary = {
        "equipped": len(exportable),
        STATUS_NEW: sum(1 for r in rows if r.status == STATUS_NEW),
        STATUS_CHANGED: sum(1 for r in rows if r.status == STATUS_CHANGED),
        STATUS_UP_TO_DATE: sum(1 for r in rows if r.status == STATUS_UP_TO_DATE),
        STATUS_MISSING: sum(1 for r in rows if r.status == STATUS_MISSING),
        "orphaned": len(orphaned),
        "unsupported": len(unsupported),
        "lint_warnings": sum(len(r.lint) for r in rows),
    }

    payload = {
        "target": target_id,
        "label": target.label,
        "upload_url": target.upload_url,
        "upload_path": target.upload_path,
        "last_exported": last_exported_at(recorded),
        "notes": list(target.notes),
        "skills": [r.to_dict() for r in rows],
        "orphaned": orphaned,
        "unsupported": unsupported,
        "summary": summary,
    }
    if sidecar.get("_corrupt"):
        payload["warnings"] = [
            f"export state at {sidecar['_corrupt']} was unreadable and was "
            f"treated as empty — every skill reads as `new`."
        ]
    return payload


def default_export_dir(target_id: str) -> Path:
    return hub_core.data_home() / "exports" / target_id
