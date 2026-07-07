"""The Hermes remote connector — SSH-fs to a Hermes box's `~/.hermes/`.

Hermes is a self-improving agent: its curator actively edits skills on the box,
so **remote drift is the common case** (DECISIONS.md D8). This connector is
standalone, publishable, and Hermes-only (D7) — it knows nothing of any other
connector. It works convention-over-configuration against the documented Hermes
layout (D1, hermes-connector spec):

  <home>/skill-hub/<name>/SKILL.md   ← hub-owned managed skills (D12)
  <home>/skills/<name>/SKILL.md      ← Hermes's OWN tree — READ-ONLY to us (D9),
                                        import source only, never written
  <home>/config.yaml                 ← mcp_servers: (merge-preserving) +
                                        skills.external_dirs (register skill-hub)
  <home>/SOUL.md                     ← persona doc
  <home>/memories/MEMORY.md          ← memory doc
  <home>/memories/USER.md            ← user doc

Upgrade-safety (D14): the connector confines writes to those documented
extension points ONLY. Any resolved write path inside `<home>/hermes-agent/`
(the Hermes code tree) or `<home>/skills/` (Hermes's own `.hub` tree) is a hard
refusal — `_guard_write_path` raises `UpgradeSafetyViolation`.

All remote I/O goes through the injectable Wave-0 `SshTransport`, so this module
makes no real connection at import or construction; tests inject a runner that
reads/writes a local temp tree.
"""

from __future__ import annotations

import hashlib
import posixpath
from dataclasses import dataclass
from typing import Optional

from .base import (
    Action,
    ApplyResult,
    Capability,
    DEFAULT_ALLOW,
    DesiredItem,
    DesiredState,
    DriftStatus,
    HealthResult,
    PlannedAction,
    RemoteArtifact,
    RemoteConnector,
    RemotePlan,
)
from . import drift as _drift
from . import sidecar as _sidecar
from .layouts import agentskills, yaml_mcp
from .transport import audit as _audit
from .transport.ssh import HostKeyMismatch, SshCommandError, SshTransport


DEFAULT_HOME = "~/.hermes"

# Surfaces (sidecar files are per-surface).
SURFACE_SKILLS = "skills"
SURFACE_MCP = "mcp"
SURFACE_DOCS = "docs"

# The documented agent-doc artifacts and their remote-relative paths.
#: doc-name → posix path relative to <home>.
DOC_PATHS: dict[str, str] = {
    "SOUL.md": "SOUL.md",
    "MEMORY.md": "memories/MEMORY.md",
    "USER.md": "memories/USER.md",
}

# Forbidden subtrees — never written (D14 / D9).
FORBIDDEN_SUBDIRS = ("hermes-agent", "skills")


class UpgradeSafetyViolation(RuntimeError):
    """A resolved write path would touch the Hermes code tree or own skills tree.

    Hard refusal per D14: the connector must stay version-agnostic and never
    fork/patch Hermes or collide with its `.hub`-managed `~/.hermes/skills/`.
    """


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _normalize_home(home: Optional[str]) -> str:
    """Resolve the remote Hermes home (no trailing slash). `None` ⇒ DEFAULT_HOME.

    The literal `$HERMES_HOME` auto-detection happens on the *box* via
    `health_check`/`_resolve_home`; this only normalizes a configured value.

    F6: a `home` containing a `..` path component is rejected — a malicious
    `registry.yaml` could otherwise shift the entire managed subtree upward
    (e.g. `~/.hermes/../../etc`) and slip past `_guard_write_path`.
    """
    h = (home or DEFAULT_HOME).strip()
    h = h.rstrip("/") or DEFAULT_HOME
    if ".." in h.split("/"):
        raise UpgradeSafetyViolation(
            f"refusing remote home {h!r}: a '..' path component is not allowed"
        )
    return h


@dataclass(frozen=True)
class _Paths:
    """Resolved remote paths for one target's home."""

    home: str

    @property
    def skill_hub_dir(self) -> str:
        return posixpath.join(self.home, "skill-hub")

    @property
    def native_skills_dir(self) -> str:
        return posixpath.join(self.home, "skills")

    @property
    def config_yaml(self) -> str:
        return posixpath.join(self.home, "config.yaml")

    def managed_skill_dir(self, name: str) -> str:
        return posixpath.join(self.skill_hub_dir, name)

    def doc_path(self, doc_name: str) -> str:
        return posixpath.join(self.home, DOC_PATHS[doc_name])


class HermesConnector(RemoteConnector):
    """Plan-then-apply connector for a Hermes box reached over SSH."""

    key = "hermes"
    publishable = True
    label = "Hermes"
    description = (
        "A self-improving agent box over SSH. Pushes skills, MCP servers, and "
        "SOUL/MEMORY/USER docs to a hub-owned dir — never touching the box's "
        "own skill library."
    )
    transport_kind = "ssh"

    # A test/embedder may inject a transport factory so no real SSH is made.
    def __init__(self, transport_factory=None):
        # transport_factory(target) -> SshTransport. Default builds a hardened
        # SshTransport from the target's ssh_host + pinned host key.
        self._transport_factory = transport_factory or _default_transport_factory

    # --- capability + health ------------------------------------------------

    def capabilities(self) -> set[Capability]:
        return {Capability.SKILLS, Capability.MCP, Capability.AGENT_DOCS}

    def _transport(self, target) -> SshTransport:
        return self._transport_factory(target)

    def _resolve_home(self, target, transport: SshTransport) -> str:
        """Resolve the remote home: explicit config wins, else $HERMES_HOME, else ~/.hermes.

        Auto-detection (D12) runs a tiny remote shell that echoes `$HERMES_HOME`
        when set; an empty result falls back to `~/.hermes`. A configured
        `target.home` short-circuits the probe.
        """
        configured = getattr(target, "home", None)
        if configured:
            return transport.expand_user(_normalize_home(configured))
        # Probe the box for $HERMES_HOME (out-of-the-box; D12).
        try:
            detected = transport.detect_env_home()
        except Exception:
            detected = None
        # Expand a leading `~` to the remote $HOME so downstream quoted paths work.
        return transport.expand_user(_normalize_home(detected or DEFAULT_HOME))

    def health_check(self, target) -> HealthResult:
        """Reachable + auth + host-key pin match (via the Wave-0 ssh wrapper)."""
        transport = self._transport(target)
        # Verify the pinned host key first — a mismatch is a hard fail and no
        # further remote command is issued.
        try:
            transport.verify_host_key()
        except HostKeyMismatch as e:
            return HealthResult(
                reachable=True,
                authenticated=False,
                host_key_match=False,
                detail=str(e),
            )
        # A trivial authenticated command proves reachability + auth. Any
        # connection-level failure (ssh exit 255, DNS, timeout) surfaces as a
        # raised exception → unreachable.
        try:
            home = self._resolve_home(target, transport)
            ok = transport.probe(home)
        except Exception as e:  # connection refused / DNS / timeout / ssh 255
            return HealthResult(reachable=False, detail=str(e))
        if not ok:
            return HealthResult(
                reachable=True,
                authenticated=False,
                host_key_match=True,
                detail="authenticated probe failed",
            )
        return HealthResult(reachable=True, authenticated=True, host_key_match=True, detail=home)

    # --- read side ----------------------------------------------------------

    def list_remote_artifacts(self, target, kind: str) -> list[RemoteArtifact]:
        """List remote artifacts of `kind`, flagging which are sidecar-managed.

        kind ∈ {"skill", "mcp", "agent_doc"}. For skills it lists BOTH the
        hub-owned `skill-hub/` tree (managed; cross-referenced against the
        sidecar) AND the box-native `skills/` tree (always flagged UNMANAGED →
        import candidates, never written — D9).
        """
        transport = self._transport(target)
        home = self._resolve_home(target, transport)
        paths = _Paths(home)
        if kind in ("skill", "skills"):
            return self._list_skills(target, transport, paths)
        if kind in ("mcp", "mcp_servers"):
            return self._list_mcp(target, transport, paths)
        if kind in ("agent_doc", "agent_docs", "doc", "docs"):
            return self._list_docs(target, transport, paths)
        return []

    def _list_skills(self, target, transport, paths: _Paths) -> list[RemoteArtifact]:
        managed_names = _sidecar.read_sidecar(target.id, SURFACE_SKILLS).managed_names()
        out: list[RemoteArtifact] = []
        # Hub-owned skill-hub/ tree.
        for name in transport.list_subdirs(paths.skill_hub_dir):
            ref = paths.managed_skill_dir(name)
            out.append(
                RemoteArtifact(
                    name=name,
                    kind="skill",
                    sha256=transport.dir_sha256(ref),
                    managed=name in managed_names,
                    ref=ref,
                )
            )
        # Box-native skills/ tree — ALWAYS unmanaged (import candidates only).
        #
        # The Hermes box stores its OWN skills CATEGORY-NESTED:
        #   <home>/skills/<category>/<skill>/SKILL.md   (2 levels deep, 95 dirs)
        # so a one-level `list_subdirs` returned CATEGORIES, not skills → zero
        # import candidates. Discover skill dirs at ANY depth in ONE remote call
        # (`find … -name SKILL.md`): a dir containing SKILL.md IS a skill. The
        # candidate NAME = the leaf dir name; the `ref` = the full nested dir path
        # (so `import-skill` reads the tree at the right place).
        #
        # NAMES ONLY: no `dir_sha256` per entry — that is an SSH round-trip (plus
        # file reads) PER skill, and a 95-skill curator tree blocked the UI for
        # minutes. The candidate list only needs names; the dir sha/content is
        # fetched lazily only when a specific skill is actually adopted.
        for leaf, ref in transport.find_skill_dirs(paths.native_skills_dir):
            out.append(
                RemoteArtifact(
                    name=leaf,
                    kind="skill",
                    sha256=None,
                    managed=False,
                    ref=ref,
                )
            )
        return out

    def _list_mcp(self, target, transport, paths: _Paths) -> list[RemoteArtifact]:
        managed_names = _sidecar.read_sidecar(target.id, SURFACE_MCP).managed_names()
        try:
            doc = transport.read(paths.config_yaml).decode("utf-8")
        except SshCommandError:
            doc = ""
        servers = yaml_mcp.read_mcp_servers(doc)
        out = []
        for name, spec in servers.items():
            out.append(
                RemoteArtifact(
                    name=name,
                    kind="mcp",
                    sha256=_sha256_bytes(_canonical_mcp_bytes(spec)),
                    managed=name in managed_names,
                    ref=name,
                )
            )
        return out

    def _list_docs(self, target, transport, paths: _Paths) -> list[RemoteArtifact]:
        managed_names = _sidecar.read_sidecar(target.id, SURFACE_DOCS).managed_names()
        out = []
        for doc_name in DOC_PATHS:
            ref = paths.doc_path(doc_name)
            sha = transport.sha256(ref)
            if sha is None:
                continue
            out.append(
                RemoteArtifact(
                    name=doc_name,
                    kind="agent_doc",
                    sha256=sha,
                    managed=doc_name in managed_names,
                    ref=ref,
                )
            )
        return out

    def fetch_artifact(self, target, ref: str) -> bytes:
        """Fetch one remote artifact's bytes (for diff / pull / doc edit).

        For a skill `ref` (a remote dir), this returns the SKILL.md bytes — the
        primary content for a diff. Use `pull_artifact` to adopt the whole tree.
        For mcp/docs `ref`, returns the canonical bytes of that artifact.
        """
        transport = self._transport(target)
        home = self._resolve_home(target, transport)
        paths = _Paths(home)
        return self._fetch(transport, paths, ref)

    def _fetch(self, transport, paths: _Paths, ref: str) -> bytes:
        # A doc ref is a full path ending in .md under <home>.
        if ref.endswith(".md") and "/skill-hub/" not in ref and "/skills/" not in ref:
            return transport.read(ref)
        # An mcp ref is a bare server name (no slash).
        if "/" not in ref:
            try:
                doc = transport.read(paths.config_yaml).decode("utf-8")
            except SshCommandError:
                doc = ""
            servers = yaml_mcp.read_mcp_servers(doc)
            if ref in servers:
                return _canonical_mcp_bytes(servers[ref])
            return b""
        # Otherwise a skill dir ref → its SKILL.md.
        return transport.read(posixpath.join(ref, agentskills.SKILL_FILE))

    # --- plan (NEVER mutates) ----------------------------------------------

    def plan(self, target, desired: DesiredState) -> RemotePlan:
        """Classify each desired/managed artifact's drift and emit a `RemotePlan`.

        Per artifact: base = sidecar last_pushed_sha256, remote = fetched sha,
        local = desired sha → `drift.classify` → action. Orphans (sidecar names
        no longer desired) become REMOVE. Performs NO remote mutation.
        """
        transport = self._transport(target)
        home = self._resolve_home(target, transport)
        paths = _Paths(home)
        actions: list[PlannedAction] = []

        actions.extend(self._plan_surface(target, transport, paths, desired.skills, SURFACE_SKILLS, "skill"))
        actions.extend(self._plan_surface(target, transport, paths, desired.mcp, SURFACE_MCP, "mcp"))
        actions.extend(self._plan_surface(target, transport, paths, desired.agent_docs, SURFACE_DOCS, "agent_doc"))

        rp = RemotePlan(target_id=target.id, actions=tuple(actions))
        # Stash the desired state (with payloads) on the plan so apply() can
        # write content without re-resolving. RemotePlan is frozen → use
        # object.__setattr__ for this connector-internal side channel.
        object.__setattr__(rp, "_desired", desired)
        return rp

    def _remote_sha_for(self, transport, paths: _Paths, surface: str, name: str) -> Optional[str]:
        if surface == SURFACE_SKILLS:
            ref = paths.managed_skill_dir(name)
            return transport.dir_sha256(ref)
        if surface == SURFACE_MCP:
            try:
                doc = transport.read(paths.config_yaml).decode("utf-8")
            except SshCommandError:
                return None
            servers = yaml_mcp.read_mcp_servers(doc)
            if name not in servers:
                return None
            return _sha256_bytes(_canonical_mcp_bytes(servers[name]))
        if surface == SURFACE_DOCS:
            return transport.sha256(paths.doc_path(name))
        return None

    def _batch_remote_shas(self, transport, paths, surface, names) -> dict:
        """Remote sha for EVERY name on a surface in ONE ssh round-trip.

        Returns `{name: sha-or-None}` for exactly the names it could resolve; a
        name absent from the result means the batch could not answer for it (or
        the batch failed entirely → `{}`), and the caller falls back to the
        per-artifact `_remote_sha_for`. The batched shas are byte-identical to
        the per-artifact ones (same schemes), so drift classification is
        unchanged — this is a pure transport-cost optimization.
        """
        names = [n for n in names if n]
        if not names:
            return {}
        try:
            if surface == SURFACE_SKILLS:
                return transport.dir_sha256_batch(paths.skill_hub_dir, names)
            if surface == SURFACE_MCP:
                # MCP already lives in ONE file — read it once and derive every
                # server's sha locally (vs re-reading config.yaml per name).
                try:
                    doc = transport.read(paths.config_yaml).decode("utf-8")
                except SshCommandError:
                    doc = ""
                servers = yaml_mcp.read_mcp_servers(doc)
                return {
                    name: (_sha256_bytes(_canonical_mcp_bytes(servers[name]))
                           if name in servers else None)
                    for name in names
                }
            if surface == SURFACE_DOCS:
                by_path = {paths.doc_path(n): n for n in names if n in DOC_PATHS}
                if not by_path:
                    return {}
                path_shas = transport.sha256_batch(by_path.keys())
                return {name: path_shas[p] for p, name in by_path.items() if p in path_shas}
        except Exception:
            # Any batch failure → empty; the per-artifact fallback covers it.
            return {}
        return {}

    def _plan_surface(self, target, transport, paths, desired_items, surface, kind):
        sc = _sidecar.read_sidecar(target.id, surface)
        desired_by_name = {d.name: d for d in desired_items}
        out: list[PlannedAction] = []

        # Resolve every relevant remote sha (desired ∪ sidecar-managed) in ONE
        # round-trip; fall back to the per-artifact primitive for any name the
        # batch could not answer (partial output / no remote python3 / etc.).
        all_names = set(desired_by_name) | set(sc.managed_names())
        batched = self._batch_remote_shas(transport, paths, surface, all_names)

        def remote_sha_for(name):
            if name in batched:
                return batched[name]
            return self._remote_sha_for(transport, paths, surface, name)

        # 1. Desired artifacts: classify against base + remote.
        for name, item in desired_by_name.items():
            base = sc.base_sha(name)
            remote_sha = remote_sha_for(name)
            local_sha = item.sha256
            if base is None:
                # Never pushed → create (unless it already happens to match).
                if remote_sha is None:
                    out.append(PlannedAction(name, kind, Action.CREATE, None, None))
                elif remote_sha == local_sha:
                    # Already present with identical content but not in sidecar —
                    # treat as a (re)create so the sidecar gets seeded; the write
                    # is byte-identical so it is effectively idempotent.
                    out.append(PlannedAction(name, kind, Action.CREATE, DriftStatus.IN_SYNC, None))
                else:
                    # Present + different + unowned → do NOT clobber; surface it.
                    out.append(PlannedAction(name, kind, Action.SKIP_REMOTE_DRIFTED, DriftStatus.REMOTE_DRIFTED, None))
                continue
            status = _drift.classify(base, remote_sha, local_sha)
            out.append(self._action_for(name, kind, status, surface, item, transport, paths))

        # 2. Orphans: sidecar names no longer desired → REMOVE (sidecar-scoped).
        for name in sc.managed_names():
            if name in desired_by_name:
                continue
            remote_sha = remote_sha_for(name)
            status = _drift.classify(sc.base_sha(name), remote_sha, None)
            if status == DriftStatus.ORPHANED:
                out.append(PlannedAction(name, kind, Action.REMOVE, status, None))
            elif status == DriftStatus.IN_SYNC:
                # Gone both sides — drop quietly (NOOP; cleanup handled at apply).
                out.append(PlannedAction(name, kind, Action.NOOP, status, None))
        return out

    def _action_for(self, name, kind, status, surface, item, transport, paths) -> PlannedAction:
        if status == DriftStatus.IN_SYNC:
            return PlannedAction(name, kind, Action.NOOP, status, None)
        if status == DriftStatus.LOCAL_AHEAD:
            return PlannedAction(name, kind, Action.FAST_FORWARD, status, None)
        if status == DriftStatus.REMOTE_DRIFTED:
            return PlannedAction(name, kind, Action.SKIP_REMOTE_DRIFTED, status, None)
        if status == DriftStatus.CONFLICT:
            return PlannedAction(name, kind, Action.SKIP_CONFLICT, status, None)
        if status == DriftStatus.MISSING:
            # Managed but gone from the remote → recreate (treat as create).
            return PlannedAction(name, kind, Action.CREATE, status, None)
        # ORPHANED handled in the orphan loop.
        return PlannedAction(name, kind, Action.NOOP, status, None)

    # --- apply (mutates only sidecar-owned, allowed artifacts) --------------

    def apply(self, target, plan: RemotePlan, *, allow: frozenset = DEFAULT_ALLOW) -> ApplyResult:
        """Execute the plan, touching only artifacts whose action is in `allow`.

        Skills push into `<home>/skill-hub/<name>/` and the dir is registered in
        `config.yaml` `skills.external_dirs` (merge-preserving). MCP entries
        merge into `mcp_servers:`. Docs write atomically. Every write is
        backup-on-change, audit-logged, and rebases the sidecar — but ONLY for
        artifacts actually applied. Sidecar-scoped cleanup removes only
        sidecar-listed orphans.
        """
        transport = self._transport(target)
        home = self._resolve_home(target, transport)
        paths = _Paths(home)

        created: list[str] = []
        fast_forwarded: list[str] = []
        removed: list[str] = []
        skipped: list[str] = []
        errors: list[str] = []

        # The DesiredItem payloads are needed to write content. The plan does not
        # carry them, so apply re-resolves desired state from the caller-supplied
        # plan + a fresh fetch of local content via the connector's desired cache.
        desired = getattr(plan, "_desired", None)
        desired_lookup = _desired_lookup(desired)

        # Ensure the external_dirs registration once if any skill is written.
        will_register_external = any(
            a.kind == "skill" and a.action in allow and a.action in (Action.CREATE, Action.FAST_FORWARD)
            for a in plan.actions
        )

        for action in plan.actions:
            if action.action not in allow:
                if action.action in (Action.SKIP_REMOTE_DRIFTED, Action.SKIP_CONFLICT):
                    skipped.append(action.name)
                continue
            if action.action == Action.NOOP:
                continue
            try:
                if action.action in (Action.CREATE, Action.FAST_FORWARD):
                    wrote = self._apply_write(target, transport, paths, action, desired_lookup)
                    if not wrote:
                        # F4: remote drifted between plan and apply → skip (don't
                        # clobber the agent's edit).
                        skipped.append(action.name)
                    elif action.action == Action.CREATE:
                        created.append(action.name)
                    else:
                        fast_forwarded.append(action.name)
                elif action.action == Action.REMOVE:
                    self._apply_remove(target, transport, paths, action)
                    removed.append(action.name)
            except UpgradeSafetyViolation:
                raise
            except Exception as e:  # pragma: no cover - defensive
                errors.append(f"{action.name}: {e}")

        if will_register_external:
            try:
                self._ensure_external_dir(target, transport, paths)
            except UpgradeSafetyViolation:
                raise
            except Exception as e:
                errors.append(f"external_dirs: {e}")

        # C1 sign-on-push: after any managed-skill write, attest the hub-owned
        # subtree with a signed manifest so a remote verifier (Wave-5 gateway /
        # re-verify) can check integrity before executing pulled content. Written
        # ONLY into the hub-owned skill-hub/ dir (guard-validated). A push that
        # cannot be attested is reported as an error (fail-closed) but does not
        # roll back the already-written skills.
        if created or fast_forwarded:
            try:
                self._write_skill_manifest(target, transport, paths, desired_lookup)
            except UpgradeSafetyViolation:
                raise
            except Exception as e:
                errors.append(f"manifest: {e}")

        return ApplyResult(
            created=tuple(created),
            fast_forwarded=tuple(fast_forwarded),
            removed=tuple(removed),
            skipped=tuple(skipped),
            errors=tuple(errors),
        )

    # --- write helpers ------------------------------------------------------

    def _guard_write_path(self, paths: _Paths, remote_path: str) -> None:
        """Hard-refuse any write outside the documented extension points (D14).

        ALLOWLIST (F1): a write path is permitted ONLY if its normalized form is
          * inside `<home>/skill-hub/` (the hub-owned managed-skill tree), or
          * exactly `<home>/config.yaml`, or
          * exactly one of the DOC_PATHS-resolved doc paths.
        Everything else — any `..` traversal, any absolute path that escapes
        `home`, the Hermes code tree (`hermes-agent/`), the box-native `skills/`
        tree, or any other location — is a hard refusal. This is the single
        backstop for both the local and remote (MITM) traversal vectors, so it
        must reason on the *normalized* path, not the literal first component.
        """
        np = posixpath.normpath(remote_path)
        hub_root = posixpath.normpath(paths.skill_hub_dir)
        allowed_exact = {posixpath.normpath(paths.config_yaml)}
        allowed_exact.update(
            posixpath.normpath(paths.doc_path(d)) for d in DOC_PATHS
        )

        inside_hub = np == hub_root or np.startswith(hub_root + "/")
        if inside_hub or np in allowed_exact:
            return
        raise UpgradeSafetyViolation(
            f"refusing to write {remote_path!r} (normalized {np!r}): not inside "
            f"the documented extension points of {paths.home!r} "
            f"(skill-hub/, config.yaml, or an agent doc) (D14)"
        )

    def _apply_write(self, target, transport, paths, action: PlannedAction, desired_lookup) -> bool:
        """Write one artifact, re-checking remote drift immediately before the write.

        Returns True if the artifact was written (or was already byte-identical
        and the sidecar rebased), False if the write was ABORTED because the
        remote drifted between plan() and apply() (F4 — TOCTOU). A False return
        leaves the remote untouched and the sidecar unchanged.
        """
        item = desired_lookup.get((action.kind, action.name))
        if item is None or item.payload is None:
            raise RuntimeError(f"no local payload for {action.kind} {action.name!r}")

        surface = {
            "skill": SURFACE_SKILLS,
            "mcp": SURFACE_MCP,
            "agent_doc": SURFACE_DOCS,
        }.get(action.kind)
        if surface is None:  # pragma: no cover
            raise RuntimeError(f"unknown kind {action.kind!r}")

        # F4: re-fetch the remote sha and re-classify against base + local
        # IMMEDIATELY before writing. If the artifact is no longer LOCAL_AHEAD or
        # CREATE-able (i.e. the agent edited it since plan()), abort rather than
        # clobber. A first-push (base is None) is allowed when the remote is
        # still absent or already byte-identical.
        sc = _sidecar.read_sidecar(target.id, surface)
        base = sc.base_sha(action.name)
        remote_now = self._remote_sha_for(transport, paths, surface, action.name)
        local_sha = item.sha256
        if base is None:
            # Never pushed: only safe to create if absent or already identical.
            if remote_now is not None and remote_now != local_sha:
                return False
        else:
            status = _drift.classify(base, remote_now, local_sha)
            if status not in (DriftStatus.LOCAL_AHEAD, DriftStatus.MISSING):
                # MISSING is treated as a recreate (CREATE); anything else
                # (REMOTE_DRIFTED / CONFLICT / IN_SYNC-but-changed) aborts.
                if status != DriftStatus.IN_SYNC:
                    return False

        if action.kind == "skill":
            self._write_skill(target, transport, paths, action.name, item)
        elif action.kind == "mcp":
            self._write_mcp(target, transport, paths, action.name, item)
        elif action.kind == "agent_doc":
            self._write_doc(target, transport, paths, action.name, item)

        # Rebase the sidecar base to the just-pushed sha (applied artifacts only).
        sc = _sidecar.read_sidecar(target.id, surface)
        sc.record(action.name, action.kind, item.sha256)
        _sidecar.write_sidecar(sc)
        return True

    def _write_skill(self, target, transport, paths, name, item: DesiredItem) -> None:
        dest = paths.managed_skill_dir(name)
        self._guard_write_path(paths, dest)
        # payload is the serialized SkillTree (relpath→bytes) as a flat blob; we
        # reconstruct + write each file. The dispatch encodes the tree files in
        # item.payload via _encode_skill_tree.
        tree = _decode_skill_tree(name, item.payload)
        for rel, data in tree.files.items():
            target_path = posixpath.join(dest, rel)
            self._guard_write_path(paths, target_path)
            before = transport.sha256(target_path)
            if before is not None and transport.read(target_path) == data:
                continue  # byte-identical → skip (idempotent)
            transport.backup_on_change(target_path, data)
            transport.atomic_write(target_path, data)
            _audit.append(
                target.id,
                "write",
                f"skill:{name}/{rel}",
                sha_before=before,
                sha_after=_sha256_bytes(data),
            )

    def _write_mcp(self, target, transport, paths, name, item: DesiredItem) -> None:
        cfg_path = paths.config_yaml
        self._guard_write_path(paths, cfg_path)
        try:
            doc = transport.read(cfg_path).decode("utf-8")
        except SshCommandError:
            doc = ""
        spec = _decode_mcp_spec(item.payload)
        before = transport.sha256(cfg_path)
        new_doc = yaml_mcp.merge_mcp_servers(doc, upserts={name: spec})
        if new_doc == doc:
            return
        transport.backup_on_change(cfg_path, new_doc.encode("utf-8"))
        transport.atomic_write(cfg_path, new_doc.encode("utf-8"))
        _audit.append(target.id, "write", f"mcp:{name}", sha_before=before, sha_after=transport.sha256(cfg_path))

    def _write_doc(self, target, transport, paths, doc_name, item: DesiredItem) -> None:
        ref = paths.doc_path(doc_name)
        self._guard_write_path(paths, ref)
        before = transport.sha256(ref)
        if before is not None and transport.read(ref) == item.payload:
            return
        transport.backup_on_change(ref, item.payload)
        transport.atomic_write(ref, item.payload)
        _audit.append(target.id, "write", f"doc:{doc_name}", sha_before=before, sha_after=_sha256_bytes(item.payload))

    def _apply_remove(self, target, transport, paths, action: PlannedAction) -> None:
        if action.kind == "skill":
            dest = paths.managed_skill_dir(action.name)
            self._guard_write_path(paths, dest)
            before = transport.dir_sha256(dest)
            transport.remove_dir(dest)
            surface = SURFACE_SKILLS
            _audit.append(target.id, "remove", f"skill:{action.name}", sha_before=before, sha_after=None)
        elif action.kind == "mcp":
            cfg_path = paths.config_yaml
            self._guard_write_path(paths, cfg_path)
            try:
                doc = transport.read(cfg_path).decode("utf-8")
            except SshCommandError:
                doc = ""
            before = transport.sha256(cfg_path)
            new_doc = yaml_mcp.merge_mcp_servers(doc, removals={action.name})
            if new_doc != doc:
                transport.backup_on_change(cfg_path, new_doc.encode("utf-8"))
                transport.atomic_write(cfg_path, new_doc.encode("utf-8"))
            surface = SURFACE_MCP
            _audit.append(target.id, "remove", f"mcp:{action.name}", sha_before=before, sha_after=transport.sha256(cfg_path))
        elif action.kind == "agent_doc":
            # Docs are never deleted from the box (they are part of the box's
            # identity); forget ownership only.
            surface = SURFACE_DOCS
        else:  # pragma: no cover
            return
        sc = _sidecar.read_sidecar(target.id, surface)
        sc.forget(action.name)
        _sidecar.write_sidecar(sc)

    def _ensure_external_dir(self, target, transport, paths: _Paths) -> None:
        """Register `<home>/skill-hub` in config.yaml `skills.external_dirs` (D12).

        Merge-preserving: only the `skills.external_dirs` list is touched; every
        other config key survives. Idempotent (no-op if already present).
        """
        cfg_path = paths.config_yaml
        self._guard_write_path(paths, cfg_path)
        try:
            doc = transport.read(cfg_path).decode("utf-8")
        except SshCommandError:
            doc = ""
        skill_hub_path = paths.skill_hub_dir
        new_doc = _merge_external_dir(doc, skill_hub_path)
        if new_doc == doc:
            return
        before = transport.sha256(cfg_path)
        transport.backup_on_change(cfg_path, new_doc.encode("utf-8"))
        transport.atomic_write(cfg_path, new_doc.encode("utf-8"))
        _audit.append(target.id, "write", "config:skills.external_dirs", sha_before=before, sha_after=transport.sha256(cfg_path))

    def _write_skill_manifest(self, target, transport, paths, desired_lookup) -> None:
        """C1: write a signed `[(relpath, sha256)]` manifest of the hub-owned skills.

        Covers every currently-managed skill (sidecar-listed) whose local payload
        is known, with one `(<skill>/<rel>, sha256)` row per file — so a verifier
        can re-hash the on-remote subtree and check the SSHSIG against the
        registry-pinned hub signing pubkey. Lands ONLY in the hub-owned
        `skill-hub/` dir (guard-validated). Fail-closed: a missing signing key or
        ssh-keygen propagates as an exception the caller records as an error.
        """
        from . import signing as _signing

        # Sign-on-push is ADDITIVE: when no hub signing key is initialized yet
        # (or ssh-keygen is absent) we skip the manifest rather than break the
        # push — the remote doctor surfaces the unpinned-signing warning. Once a
        # key exists, a signing FAILURE is fail-closed (propagates as an error).
        if _signing.get_public_key() is None:
            return

        sc = _sidecar.read_sidecar(target.id, SURFACE_SKILLS)
        items: list[tuple[str, str]] = []
        for name in sorted(sc.managed_names()):
            item = desired_lookup.get(("skill", name))
            if item is None or item.payload is None:
                continue
            tree = _decode_skill_tree(name, item.payload)
            for rel in sorted(tree.files):
                items.append((posixpath.join(name, rel), _sha256_bytes(tree.files[rel])))
        if not items:
            return
        _signing.write_signed_manifest(
            transport,
            paths.skill_hub_dir,
            items,
            guard=lambda p: self._guard_write_path(paths, p),
        )

    # --- resolution primitive ----------------------------------------------

    def pull_artifact(self, target, ref: str) -> bytes:
        """Adopt a remote artifact back into Hub (drift pull / import).

        For a skill dir ref, returns the serialized SkillTree blob (the whole
        directory), so the caller can reconstruct it locally. For mcp/docs,
        returns the artifact bytes. This is the read-fetch step; the caller
        performs the registry mutation (import) or re-base (drift pull).
        """
        transport = self._transport(target)
        home = self._resolve_home(target, transport)
        paths = _Paths(home)
        # Skill dir → whole-tree blob.
        if "/" in ref and not ref.endswith(".md"):
            tree = transport.read_remote_skill_dir(ref)
            return _encode_skill_tree(tree)
        return self._fetch(transport, paths, ref)


# ─────────────────────────────────────────────────────────────────────────────
# Skill-tree payload (de)serialization — a connector-internal flat blob so the
# generic DesiredItem.payload can carry a whole directory's bytes.
# ─────────────────────────────────────────────────────────────────────────────


def _encode_skill_tree(tree: agentskills.SkillTree) -> bytes:
    """Length-prefixed encoding of (relpath, bytes)* — round-trips exactly."""
    out = bytearray()
    out += len(tree.name.encode()).to_bytes(4, "big")
    out += tree.name.encode()
    for rel in sorted(tree.files):
        data = tree.files[rel]
        rb = rel.encode("utf-8")
        out += len(rb).to_bytes(4, "big")
        out += rb
        out += len(data).to_bytes(8, "big")
        out += data
    return bytes(out)


def _decode_skill_tree(name: str, blob: bytes) -> agentskills.SkillTree:
    files: dict[str, bytes] = {}
    i = 0
    nlen = int.from_bytes(blob[i:i + 4], "big"); i += 4
    tree_name = blob[i:i + nlen].decode("utf-8"); i += nlen
    while i < len(blob):
        rlen = int.from_bytes(blob[i:i + 4], "big"); i += 4
        rel = blob[i:i + rlen].decode("utf-8"); i += rlen
        dlen = int.from_bytes(blob[i:i + 8], "big"); i += 8
        data = blob[i:i + dlen]; i += dlen
        files[rel] = data
    return agentskills.SkillTree(name=tree_name or name, files=files)


def skill_tree_sha256(tree: agentskills.SkillTree) -> str:
    return agentskills.tree_sha256(tree)


# ─────────────────────────────────────────────────────────────────────────────
# MCP spec canonicalization — stable bytes for sha + a payload codec.
# ─────────────────────────────────────────────────────────────────────────────


def _canonical_mcp_bytes(spec) -> bytes:
    import json

    return json.dumps(spec, sort_keys=True, ensure_ascii=False).encode("utf-8")


def _encode_mcp_spec(spec: dict) -> bytes:
    return _canonical_mcp_bytes(spec)


def _decode_mcp_spec(blob: bytes) -> dict:
    import json

    return json.loads(blob.decode("utf-8"))


# ─────────────────────────────────────────────────────────────────────────────
# config.yaml skills.external_dirs merge — delegated to the shared, ruamel-only,
# fail-closed merge primitives in `yaml_mcp` (D14: never reformat the user's
# config). These thin module-level aliases keep the connector's public surface
# (`read_external_dirs`) and import sites stable.
# ─────────────────────────────────────────────────────────────────────────────

#: Backwards-compatible aliases — the real implementations live in `yaml_mcp`.
_merge_external_dir = yaml_mcp.merge_external_dir
read_external_dirs = yaml_mcp.read_external_dirs


# ─────────────────────────────────────────────────────────────────────────────
# Desired-state plumbing
# ─────────────────────────────────────────────────────────────────────────────


def _desired_lookup(desired: Optional[DesiredState]) -> dict:
    if desired is None:
        return {}
    out = {}
    for item in desired.items():
        out[(item.kind, item.name)] = item
    return out


def _default_transport_factory(target) -> SshTransport:
    host = getattr(target, "ssh_host", None)
    if not host:
        raise RuntimeError(f"remote {getattr(target, 'id', '?')!r} has no ssh_host")
    return SshTransport(host, host_key_sha256=getattr(target, "host_key_sha256", None))
