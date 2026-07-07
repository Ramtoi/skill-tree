"""Remote targets — the `remotes:` registry block + `RemoteTarget` model.

A *remote* is a destination a connector pushes Hub-managed artifacts to (a box
over SSH, an MCP control plane). The registry's top-level `remotes:` block is
parallel to `projects:` and holds only **references** — a `connector` key, SSH
transport coordinates, a pinned `host_key_sha256`, and a keychain `secret_ref`
— never secret bytes (secrets live in the OS keychain; see
`connectors.transport.keychain`).

`RemoteTarget` mirrors `harnesses.Harness` (frozen dataclass). Skill resolution
reuses the project equip model via `resolve_remote_skills`, which delegates to
`hub.resolve_project_skills` so a remote's `bundles` / `enabled` resolve exactly
like a project's.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


# ─────────────────────────────────────────────────────────────────────────────
# RemoteTarget — one entry under `remotes:`
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RemoteTarget:
    """A configured remote destination (parallels `harnesses.Harness`).

    References only — no secret bytes. Fields per design.md §3:
      - `id`              — registry key under `remotes:`.
      - `connector`       — `REMOTE_CONNECTORS` key (e.g. "hermes").
      - `transport`       — connector-specific transport dict (e.g. `ssh_host`).
      - `secret_ref`      — keychain handle (e.g. "skill-hub:hermes-main").
      - `host_key_sha256` — pinned TOFU host-key fingerprint.
      - `home`            — remote home dir (connector default if omitted).
      - `sync_enabled`    — include in the auto-sync dispatch pass.
      - `apply_global_bundles` — opt in to inheriting global-scope bundle skills
                            (default false: a remote inherits NO global bundle
                            unless it explicitly opts in; D15).
      - `bundles`         — equipped bundles (project equip model).
      - `enabled`         — individually equipped skills.
    """

    id: str
    connector: str
    transport: dict = field(default_factory=dict)
    secret_ref: Optional[str] = None
    host_key_sha256: Optional[str] = None
    home: Optional[str] = None
    sync_enabled: bool = True
    apply_global_bundles: bool = False
    bundles: tuple[str, ...] = ()
    enabled: tuple[str, ...] = ()

    # Convenience accessors for the common SSH transport coordinates.
    @property
    def ssh_host(self) -> Optional[str]:
        return self.transport.get("ssh_host")

    @classmethod
    def from_dict(cls, remote_id: str, data: dict) -> "RemoteTarget":
        data = data or {}
        transport = dict(data.get("transport") or {})
        # host_key_sha256/home may live at the entry top level OR inside
        # transport (design's example nests them under transport); accept both.
        host_key = data.get("host_key_sha256") or transport.get("host_key_sha256")
        home = data.get("home") or transport.get("home")
        return cls(
            id=remote_id,
            connector=str(data.get("connector", "")),
            transport=transport,
            secret_ref=data.get("secret_ref"),
            host_key_sha256=host_key,
            home=home,
            sync_enabled=bool(data.get("sync_enabled", True)),
            # D15: default false — existing remotes without the key do NOT
            # inherit global bundles (so `brainstorm` disappears unless opted in).
            apply_global_bundles=bool(data.get("apply_global_bundles", False)),
            bundles=tuple(data.get("bundles") or ()),
            enabled=tuple(data.get("enabled") or ()),
        )

    def to_dict(self) -> dict:
        """Serialize back to a `remotes:` entry. References only — no secrets."""
        out: dict[str, Any] = {"connector": self.connector}
        if self.transport:
            out["transport"] = dict(self.transport)
        if self.secret_ref is not None:
            out["secret_ref"] = self.secret_ref
        if self.host_key_sha256 is not None:
            out["host_key_sha256"] = self.host_key_sha256
        if self.home is not None:
            out["home"] = self.home
        out["sync_enabled"] = self.sync_enabled
        out["apply_global_bundles"] = self.apply_global_bundles
        out["bundles"] = list(self.bundles)
        out["enabled"] = list(self.enabled)
        return out


# ─────────────────────────────────────────────────────────────────────────────
# Schema migration + loaders
# ─────────────────────────────────────────────────────────────────────────────


def migrate_remotes_schema(registry: dict) -> bool:
    """Ensure a top-level `remotes: {}` block exists (idempotent).

    Parallels `hub.migrate_harnesses_schema`: the presence of the `remotes` key
    is the idempotency marker, so a second call is a no-op and existing remote
    entries are left untouched. Returns True iff the registry was mutated.
    """
    if "remotes" in registry:
        return False
    registry["remotes"] = {}
    return True


def load_remotes(registry: dict) -> dict[str, RemoteTarget]:
    """Parse the `remotes:` block into `{id: RemoteTarget}` (empty if absent)."""
    raw = registry.get("remotes") or {}
    out: dict[str, RemoteTarget] = {}
    for remote_id, data in raw.items():
        if isinstance(data, dict):
            out[remote_id] = RemoteTarget.from_dict(remote_id, data)
    return out


def resolve_remote_skills(remote_cfg: dict, registry: dict) -> list:
    """Resolve a remote's active skills, reusing project equip semantics.

    `remote_cfg` is the raw `remotes:<id>` dict (with `bundles` / `enabled`
    and the optional `apply_global_bundles` flag).

    Mirrors `hub.resolve_project_skills` (same union + order + dedup) with ONE
    deviation (D15): global-scope bundle skills are included **only** when the
    remote opts in via `apply_global_bundles: true`. The remote's OWN `bundles`
    + `enabled` ALWAYS apply, regardless of the flag. Default false means an
    existing remote inherits no global bundle (so `brainstorm` no longer shows
    up unbidden).
    """
    import hub  # local import to avoid an import cycle at module load

    bundles_cfg = registry.get("bundles", {})

    global_bundle_skills: list = []
    if bool(remote_cfg.get("apply_global_bundles", False)):
        for cfg in bundles_cfg.values():
            if hub.bundle_scope(cfg) == "global":
                global_bundle_skills.extend(cfg.get("skills", []))

    remote_bundle_skills: list = []
    for b in remote_cfg.get("bundles", []):
        remote_bundle_skills.extend(bundles_cfg.get(b, {}).get("skills", []))

    all_skills = (
        global_bundle_skills + remote_bundle_skills + list(remote_cfg.get("enabled", []))
    )
    return list(dict.fromkeys(all_skills))  # deduplicate, preserve order
