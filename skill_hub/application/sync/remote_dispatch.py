"""Remote dispatch: the sync pass that pushes hub-managed artifacts to remotes.

Cut verbatim out of hub.py (wave 23c of AUDIT.md). A leaf: at module scope it
imports hub_core, skill_meta and sources only, never hub or hub_cli (the
`connectors` / `remotes` imports stay function-local, as they were). hub.py
re-imports every name so `hub.<name>` keeps resolving — `_cmd_sync_body` still
calls `_run_remote_dispatch` through hub.py's globals, so the
`monkeypatch.setattr(hub, "_run_remote_dispatch", …)` stub in
tests/test_auto_sync.py keeps landing.

Stub visibility: a call from one function here to another resolves through
this module, so `monkeypatch.setattr(hub, "<name>", …)` no longer reaches it
(`_run_remote_dispatch` → `build_remote_desired_state` /
`_is_alarming_remote_failure` / `_remote_has_owned_artifacts`). No test stubs
those three today; one that needs to patches `remote_dispatch.<name>`. The same
holds for the `skill_rename_patch` / `skill_source` copies imported from
`skill_meta` above: a fake for the remote push path patches
`remote_dispatch.<name>`, not `hub.<name>`.
"""

import hashlib
from typing import Optional

from skill_hub.domain.mcp import mcp_spec
from skill_hub.domain.skills.skill_meta import skill_rename_patch, skill_source
from skill_hub.hub_core import BOLD, DIM, GREEN, RED, YELLOW, c
from skill_hub.infrastructure.registry.sources import skills_from_disabled_sources


def build_remote_desired_state(remote_cfg: dict, registry: dict):
    """Resolve a remote's `DesiredState` (skills + mcp specs) from the registry.

    Reuses `resolve_remote_skills` (project equip semantics) and the local skill
    source dirs the hub already manages. Each skill becomes a `DesiredItem` whose
    payload is the connector-internal skill-tree blob; each scope-agnostic
    mcp-server skill becomes an mcp `DesiredItem`. Agent docs are resolved by the
    connector itself (it owns the SOUL/MEMORY/USER round-trip), so the dispatch
    leaves `agent_docs` empty here.
    """
    from skill_hub.infrastructure.connectors import DesiredItem, DesiredState
    from skill_hub.infrastructure.connectors import hermes as _hermes
    from skill_hub.infrastructure.connectors.layouts import agentskills
    from skill_hub.infrastructure.remotes.remotes import resolve_remote_skills

    skills = registry.get("skills", {})
    resolved = resolve_remote_skills(remote_cfg, registry)
    # Same rule as the project passes: a disabled source's artifacts are not part
    # of the desired state, so the connector's REMOVE plan drops them from the box.
    # No log line here — this helper also feeds `hub remote diff --json`.
    inactive = skills_from_disabled_sources(registry)

    skill_items: list = []
    mcp_items: list = []
    for name in resolved:
        cfg = skills.get(name)
        if not cfg or name in inactive:
            continue
        if cfg.get("type") == "mcp-server":
            # The RAW (unexpanded) reader only — `{source}` must survive
            # verbatim so an existing scaffolded server's remote sha does not
            # move under this wave (F1, plans/B.md).
            spec = mcp_spec.canonical_spec_dict(mcp_spec.raw_spec_from_registry(name, cfg))
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
        # Push the EFFECTIVE content: a renamed source-managed skill must land on
        # the box declaring its registry key. Patched in memory rather than read
        # from the variant dir — `read_skill_dir` skips symlinks, and a variant
        # is symlinks for everything but SKILL.md.
        renamed = skill_rename_patch(name, cfg)
        if renamed is not None:
            tree.files[agentskills.SKILL_FILE] = renamed.encode("utf-8")
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
    from skill_hub.infrastructure.connectors.hermes import UpgradeSafetyViolation
    from skill_hub.infrastructure.connectors.transport.ssh import HostKeyMismatch

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
    from skill_hub.infrastructure.connectors.transport.ssh import SshCommandError
    if isinstance(exc, SshCommandError):
        msg = (exc.stderr or str(exc)).lower()
        if "permission denied" in msg or "authentication" in msg or "publickey" in msg:
            return True
        return False
    return False


def _remote_has_owned_artifacts(remote_id: str) -> bool:
    """True if any ownership sidecar for `remote_id` records a pushed artifact.

    Reads the per-surface sidecars (skills / mcp / docs); a missing or corrupt
    sidecar reads as empty (never raises). Used to tell a never-provisioned box
    (quiet `home_missing` skip) apart from a box we HAVE pushed to whose home has
    since vanished (ALARMING — likely wiped/reset).
    """
    from skill_hub.infrastructure.connectors import sidecar as _sidecar

    for surface in ("skills", "mcp", "docs"):
        if _sidecar.read_sidecar(remote_id, surface).managed_names():
            return True
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
    from skill_hub.infrastructure.connectors import get_connector
    from skill_hub.infrastructure.remotes.remotes import RemoteTarget

    alarming = 0
    attempted = 0
    target_results: dict = {}

    def _record():
        if report is not None:
            report["global"]["remotes"]["attempted"] = attempted
            report["global"]["remotes"]["alarming"] = alarming
            report["global"]["remotes"]["targets"] = target_results

    remotes_map = registry.get("remotes") or {}
    if not isinstance(remotes_map, dict):
        print(f"  {c('!', YELLOW)} Invalid remotes configuration; local sync can continue.")
        _record()
        return alarming

    # The delivery preference applies only to the ordinary full-sync pass. An
    # explicit `hub remote sync <id>` must still work as the user's direct
    # override. Treat malformed policy as disabled for headless machines only;
    # other connectors keep their established behavior.
    publish_headless = True
    if only is None:
        from skill_hub.infrastructure.remotes.remotes import remote_delivery_settings

        try:
            publish_headless = remote_delivery_settings(registry)["publish_on_sync"]
        except ValueError:
            publish_headless = False
            print(f"  {c('!', YELLOW)} Invalid remote delivery settings; headless delivery skipped.")
    if not remotes_map:
        if only is None:
            print(f"\n{c('Remotes:', BOLD)} none configured")
        _record()
        return alarming

    print(f"\n{c('Remotes:', BOLD)}")
    for remote_id, remote_cfg in remotes_map.items():
        if only is not None and remote_id != only:
            continue
        try:
            if not isinstance(remote_cfg, dict):
                raise ValueError("Remote configuration must be a mapping.")
            target = RemoteTarget.from_dict(remote_id, remote_cfg)
        except Exception:
            target_results[remote_id] = {"state": "failed", "error": {"code": "invalid_remote"}}
            print(f"  {c('!', YELLOW)} {remote_id}: invalid remote configuration; skipped")
            continue
        if only is None and not target.sync_enabled:
            target_results[remote_id] = {"state": "disabled", "error": None}
            print(f"  {c('·', DIM)} {remote_id} skipped: sync disabled")
            continue

        if only is None and target.connector == "headless-loadouts" and not publish_headless:
            target_results[remote_id] = {"state": "delivery_disabled", "error": None}
            print(f"  {c('·', DIM)} {remote_id} skipped: publish on Sync disabled")
            continue

        try:
            connector = get_connector(target.connector)
        except Exception:
            target_results[remote_id] = {"state": "failed", "error": {"code": "connector_unavailable"}}
            print(f"  {c('!', YELLOW)} {remote_id}: connector unavailable; skipped")
            continue

        if getattr(connector, "deployment_kind", "artifacts") == "project-loadouts":
            attempted += 1
            try:
                outcome = connector.sync_deployment(target, registry)
                target_results[remote_id] = outcome
                print(f"  {c('·', DIM)} {remote_id}: {outcome['state'].replace('_', ' ')}")
                if (outcome.get("error") or {}).get("code") in {
                    "feed_signature_invalid", "feed_integrity_error", "feed_identity_mismatch", "write_confinement"
                }:
                    alarming += 1
            except Exception as exc:
                target_results[remote_id] = {"state": "failed", "error": {"code": "deployment_failed"}}
                if _is_alarming_remote_failure(exc):
                    alarming += 1
                print(f"  {c('!', YELLOW)} {remote_id}: project delivery failed; other targets can continue")
            continue

        attempted += 1
        target_results[remote_id] = {"state": "failed", "error": {"code": "remote_not_ready"}}
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
            kind = getattr(health, "detail_kind", "") or ""
            if kind == "home_missing":
                # Authenticated + host-key-matched, but the connector's home dir
                # isn't installed on the box. Two cases:
                #   * we NEVER pushed here (empty ownership sidecar) → a quiet,
                #     informative "not set up" skip (never fails --strict-remotes);
                #   * we HAVE pushed here before (sidecar records artifacts) but the
                #     home is now gone → the box was wiped/reset out from under us —
                #     ALARMING (surfaced loudly, fails --strict-remotes).
                if _remote_has_owned_artifacts(remote_id):
                    alarming += 1
                    print(
                        f"  {c('✗', RED)} {remote_id} ALARMING: was provisioned but the "
                        f"remote home is gone ({health.detail}) — investigate or "
                        f"`hub remote clear {remote_id}`"
                    )
                else:
                    print(
                        f"  {c('·', DIM)} {remote_id} not set up: {health.detail} — skipped"
                    )
            elif health.reachable and not health.host_key_match and not unreadable:
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

        try:
            desired = build_remote_desired_state(remote_cfg, registry)
            plan = connector.plan(target, desired)
            result = connector.apply(target, plan)
        except Exception as e:
            if _is_alarming_remote_failure(e):
                alarming += 1
                print(f"  {c('✗', RED)} {remote_id} ALARMING dispatch failure: {e}")
            else:
                print(f"  {c('!', YELLOW)} {remote_id} dispatch error: {e} — skipped")
            continue

        target_results[remote_id] = {"state": "completed", "error": None}

        # Report drift/conflict (skipped) — surfaced, never applied.
        from skill_hub.infrastructure.connectors import Action

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
