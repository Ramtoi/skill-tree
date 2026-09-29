"""The hooks sync stream and the shared doctor rollup.

Cut verbatim out of hub.py (wave 23f of AUDIT.md). Not a leaf: `_run_hooks_stream`
reads `project_sync_skip_reason` (hub.py until wave 23g) through a function-local
`import hub` — a call-time read, so a `hub.<name>` stub still lands. `data_home`
is read as `hub_core.data_home()`. Module scope imports hub_core only; the
`hook_adapters` / `hook_scripts` / `hooks_model` / `harness_probe` / `lsp_report_sync`
/ `permissions` / `permission_adapters` / `risks` imports stay function-local as
they were. hub.py re-imports every name so `hub.<name>` keeps resolving — the
`monkeypatch.setattr(hub, "_run_hooks_stream" | "_run_doctor_rollup", …)` stubs
keep landing because their only caller, `_cmd_sync_body`, stays in hub.py.

Stub visibility: a call from one function here to another resolves through this
module, so `monkeypatch.setattr(hub, "<name>", …)` no longer reaches it
(`_run_hooks_stream` → `_scope_from_slug` / `_SlugScope`). No test stubs those
today; one that needs to patches `hooks_stream.<name>`.
"""

import json
from pathlib import Path
from typing import Optional

from skill_hub import hub_core
from skill_hub.hub_core import BOLD, DIM, GREEN, RED, YELLOW, c, expand


def _operation_harness_ids(operation_context, installed=None) -> set[str]:
    if operation_context is not None:
        return set(operation_context.installed_harness_ids or ())
    return set(installed or ())


def _operation_permission_key(operation_context, harness_id: str):
    if operation_context is not None:
        layout = operation_context.layout(harness_id)
        return layout.permission_adapter_key if layout is not None else None
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    harness = _harnesses.HARNESSES.get(harness_id)
    return harness.permission_adapter_key if harness is not None else None


def _operation_effective_harnesses(
    project_cfg, registry, operation_context, installed
) -> set[str]:
    requested = set(registry.get("harnesses_global") or []) | set(
        project_cfg.get("harnesses") or []
    )
    available = _operation_harness_ids(operation_context, installed)
    if operation_context is None:
        from skill_hub.infrastructure.harnesses import harnesses as _harnesses

        return _harnesses.resolve_effective(project_cfg, registry, installed=available)
    return {
        harness_id
        for harness_id in requested & available
        if operation_context.layout(harness_id) is not None
    }


# ─────────────────────────────────────────────────────────────────────────────
# Hooks sync stream (hooks-surface task 2.3)
# ─────────────────────────────────────────────────────────────────────────────


class _SlugScope:
    """Minimal `Scope` stand-in carrying a sidecar's recorded slug verbatim.

    `_backup_once_per_session` reads only `.slug` (backup dir + session key), and
    a recorded slug like `project-alpha-local` cannot be round-tripped back into
    a `ProjectScope` unambiguously — so carry the string as-is.
    """

    __slots__ = ("slug",)

    def __init__(self, slug: str) -> None:
        self.slug = slug


def _scope_from_slug(slug: str) -> "_SlugScope":
    return _SlugScope(slug or "global")


def migrate_permissions_hook_sidecars(operation_context=None) -> list[dict]:
    """One-time sidecar handover (hooks-surface task 2.2 / D6).

    Before this release, `ClaudePermissionAdapter` wrote hooks into the SAME
    settings file as permission rules and tracked them under `hooks.<Event>[<i>]`
    keys in the DEFAULT (permissions) sidecar (`<scope>.managed.json`). Hooks now
    live in the hook library and are written + tracked by `hook_adapters` under a
    disjoint `kind="hooks"` sidecar (`<scope>.hooks.managed.json`).

    This helper evicts every legacy `hooks.*` key from a permissions-kind sidecar:
    it strips those stale hook entries from the sidecar's native JSON file (so the
    old hub-written hook entry is removed from `settings.json`) and rewrites the
    sidecar without the hook keys (permission keys preserved). The hooks stream
    then re-establishes correct hooks-kind ownership on its own pass, appending
    fresh entries — so there is neither an orphaned native entry nor double
    ownership, and no duplicate (the old native entry is gone before the hooks
    stream writes).

    Chosen over "just drop the keys from the perms sidecar" because dropping the
    keys WITHOUT stripping the native entry would leave the old hook in the file;
    the hooks reconciler (empty hooks-kind sidecar ⇒ nothing to strip) would then
    APPEND a second copy → a duplicate. Stripping native + sidecar together is the
    only variant that is duplicate-free regardless of whether the permissions
    stream also runs.

    Idempotent: after the first run no `hooks.*` key remains in any permissions
    sidecar, so subsequent calls are no-ops. NEVER touches a `kind="hooks"` or
    `kind="rules"` sidecar. Returns a list of
    `{harness, scope, file, removed_keys}` for logging/tests.
    """
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    results: list[dict] = []
    state_root = hub_core.data_home() / "state"
    if not state_root.exists():
        return results
    for harness_dir in sorted(p for p in state_root.iterdir() if p.is_dir()):
        harness_id = harness_dir.name
        if operation_context is not None:
            if harness_id not in operation_context.harness_ids:
                continue
            route = operation_context.route(harness_id, "hooks")
            if route.status == "unavailable":
                continue
        for sidecar_file in sorted(harness_dir.glob("*.managed.json")):
            name = sidecar_file.name
            # Only the DEFAULT (permissions) sidecar — skip the disjoint kinds.
            if name.endswith(".hooks.managed.json") or name.endswith(
                ".rules.managed.json"
            ):
                continue
            try:
                sc = json.loads(sidecar_file.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(sc, dict):
                continue
            managed_keys = list(sc.get("managed_keys") or [])
            hook_keys = [k for k in managed_keys if str(k).startswith("hooks.")]
            if not hook_keys:
                continue
            non_hook = [k for k in managed_keys if not str(k).startswith("hooks.")]
            native_path = Path(str(sc.get("file") or ""))
            # Strip the stale hook entries from the native JSON settings file.
            if (
                native_path.suffix == ".json"
                and native_path.exists()
            ):
                try:
                    data = json.loads(native_path.read_text())
                    if isinstance(data, dict):
                        data = pa._strip_managed_from_json(data, hook_keys)
                        # Backup-first, like EVERY other native write path — this
                        # is a destructive rewrite of a user settings file and
                        # was previously the one place that skipped the backup.
                        pa._backup_once_per_session(
                            native_path,
                            _scope_from_slug(str(sc.get("scope") or "global")),
                            harness_id,
                        )
                        pa._atomic_replace(
                            native_path,
                            json.dumps(data, indent=2, sort_keys=False) + "\n",
                        )
                except (OSError, json.JSONDecodeError):
                    pass
            # Rewrite the permissions sidecar without the hook keys.
            sc["managed_keys"] = non_hook
            try:
                pa._atomic_replace(
                    sidecar_file, json.dumps(sc, indent=2) + "\n"
                )
            except OSError:
                pass
            results.append({
                "harness": harness_id,
                "scope": str(sc.get("scope") or ""),
                "file": str(native_path),
                "removed_keys": hook_keys,
            })
    return results


def _run_hooks_stream(
    registry: dict,
    projects: dict,
    installed: set[str],
    _harnesses,
    report: Optional[dict] = None,
    hook_targets: Optional[list] = None,
    operation_context=None,
) -> int:
    """Hooks sync stream — global pass + per-project pass (hooks-surface D2/2.3).

    Mirrors `_run_permissions_stream` but the data source is the hook LIBRARY
    (`hooks_model`) and writes go via `hook_adapters` into a DISJOINT native
    namespace (the `hooks:` section / `[[hooks.<Event>]]` tables), tracked by a
    `kind="hooks"` sidecar. Called AFTER the permissions stream completes so the
    two writers never interleave on a shared settings file.

    * Capability observations come from the caller's one operation context and
      are never refreshed per project or scope.
    * The legacy permissions→hooks sidecar handover runs first
      (`migrate_permissions_hook_sidecars`) so a pre-release install's stale hook
      entries are removed before any adapter appends fresh ones — this also makes
      the handover robust under `--skip-permissions`.
    * Dangling attached names are already warned + omitted by
      `hooks_model.resolve_*_hooks`, so they never reach `apply`; the adapter's
      strip-then-rewrite reconciler drops any entry it previously wrote for them.
    * Capability verdicts gate writes: SUPPORTED writes; FEATURE_OFF keeps
      existing entries (surfaced via `disabled`, NO cleanup); UNSUPPORTED /
      NOT_INSTALLED (opencode/pi/uninstalled) skip with the honest reason.
    * A cleanup pass walks EVERY known harness with a hook adapter (not just the
      currently-effective ones) so a harness that WAS attached but is now
      uninstalled/removed-from-effective gets its native entries stripped.

    Collects `(scope_label, harness_id, resolved_hooks, capability)` tuples into
    the caller-provided `hook_targets` list for the shared doctor rollup. Returns
    a non-zero exit code ONLY when an adapter errored.
    """
    import hub
    from skill_hub.application.sync import lsp_report_sync
    from skill_hub.domain.hooks import hooks_model
    from skill_hub.domain.permissions.permissions import GlobalScope, ProjectScope
    from skill_hub.infrastructure.harnesses.harness_probe import HookCapability
    from skill_hub.infrastructure.hooks import hook_adapters, hook_scripts

    hook_errors: list[dict] = []

    def _hook_err(message: str) -> None:
        hook_errors.append({"stage": "hooks", "message": message})

    if hook_targets is None:
        hook_targets = []

    print(f"\n{c('Hooks:', BOLD)}")

    any_error = False
    active_installed = (
        _operation_harness_ids(operation_context, installed)
        if operation_context is not None
        else set(installed)
    )

    # Everything from here to the adapter loops used to run UNWRAPPED: a failure
    # in the handover, the probe, hook resolution or the lsp-report bake escaped
    # `_run_hooks_stream` entirely, aborting `cmd_sync` after the skills / MCP /
    # permissions streams had already written — and (before the try/finally in
    # `cmd_sync`) with no sync report. Each pre-adapter step is now wrapped and
    # degrades to a recorded hook error + rc 1, letting the stream continue where
    # it still can.

    # One-time legacy sidecar handover (before any hook write).
    try:
        handover = migrate_permissions_hook_sidecars(operation_context)
    except Exception as e:
        print(f"  {c('✗', RED)} sidecar handover failed: {e}")
        any_error = True
        _hook_err(f"sidecar handover failed: {e}")
        handover = []
    for h in handover:
        print(
            f"  {c('→', YELLOW)} handover: cleared {len(h['removed_keys'])} legacy "
            f"hook key(s) from {h['harness']} {h['scope']} permissions sidecar"
        )

    def _cap(harness_id: str):
        if operation_context is not None:
            raw = operation_context.hook_observations.get(harness_id)
            return HookCapability.from_dict(dict(raw)) if raw else None
        return None

    candidate_harnesses = (
        set(operation_context.harness_ids)
        if operation_context is not None
        else set(_harnesses.HARNESSES)
    )
    known_hook_harnesses = [
        h_id
        for h_id in sorted(candidate_harnesses)
        if hook_adapters.select_hook_adapter(operation_context, h_id).adapter is not None
    ]

    def _log(scope_label: str, harness_id: str, res) -> None:
        harness = _harnesses.HARNESSES.get(harness_id) if operation_context is None else None
        label = harness.label if harness is not None else harness_id
        if res.error:
            print(f"  {c('✗', RED)} {scope_label}  [{label}] {res.error}")
        elif res.disabled:
            # FEATURE_OFF hooks are recorded in `skipped` (not `written_names` —
            # nothing is written this sync), and every skip in this branch IS a
            # kept entry (the adapter never strips on feature-off).
            print(
                f"  {c('!', YELLOW)} {scope_label}  [{label}] feature off — "
                f"{len(res.skipped)} kept, writes suppressed"
            )
        elif res.written or res.written_names:
            print(
                f"  {c('✓', GREEN)} {scope_label}  [{label}] "
                f"writes={len(res.written_names)} skips={len(res.skipped)}"
            )
        elif res.reason:
            print(f"  {c('·', DIM)} {scope_label}  [{label}] {res.reason}")
        else:
            print(f"  {c('·', DIM)} {scope_label}  [{label}] no hooks to write")

    # ── Global pass ────────────────────────────────────────────────────────
    # Resolution + the lsp-report bake (which WRITES state/hooks/…json and can
    # fail on a read-only state dir) are wrapped: a failure here must not abort
    # the whole sync, it degrades this scope to "no hooks written" + rc 1.
    global_hooks: list = []
    global_scope_ok = True
    try:
        global_hooks = hooks_model.resolve_global_hooks(registry)
        # Bake the built-in lsp-report command (interpreter + per-scope config)
        # BEFORE any adapter sees it — harness-agnostic, once per scope. Script
        # hooks bake right after (the script baker skips built-ins, so the two
        # never fight over the same hook).
        lsp_report_sync.bake_resolved_hooks(global_hooks, GlobalScope())
        hook_scripts.bake_script_hooks(global_hooks, GlobalScope())
    except Exception as e:
        print(f"  {c('✗', RED)} global  hook resolution failed: {e}")
        any_error = True
        _hook_err(f"global hook resolution failed: {e}")
        global_scope_ok = False
        global_hooks = []
    for h_id in (sorted(active_installed) if global_scope_ok else []):
        selection = hook_adapters.select_hook_adapter(operation_context, h_id)
        adapter = selection.adapter
        if adapter is None:
            cap = _cap(h_id)
            reason = cap.reason if cap is not None else "no hook adapter"
            if global_hooks:
                print(f"  {c('·', DIM)} global  [{h_id}] {reason}")
            # No native write, but the doctor still gets a target so the parallel
            # hook-risk wave (e.g. opencode LSP checks) can surface findings.
            hook_targets.append(("global", h_id, global_hooks, cap))
            continue
        scope = GlobalScope()
        try:
            res = adapter.apply(
                scope, global_hooks, h_id, _cap(h_id),
                data_home_path=Path(operation_context.data_home),
            )
        except Exception as e:
            print(f"  {c('✗', RED)} global  [{h_id}] apply failed: {e}")
            any_error = True
            _hook_err(f"global [{h_id}] apply failed: {e}")
        else:
            _log("global", h_id, res)
            if res.error:
                any_error = True
                _hook_err(f"global [{h_id}] {res.error}")
            hook_targets.append(("global", h_id, global_hooks, _cap(h_id)))

    # ── Per-project pass ──────────────────────────────────────────────────
    for proj_name, proj_cfg in projects.items():
        # Same quarantine guard as the skills and permissions passes: a hook
        # write conjures `<nonexistent>/.claude/settings.local.json`.
        quarantine = hub.project_sync_skip_reason(proj_cfg)
        if quarantine:
            print(f"  {c('!', YELLOW)} {proj_name}  skipped — {quarantine}")
            continue
        proj_path = expand(proj_cfg["path"])
        scope = ProjectScope(name=proj_name, path=str(proj_path))
        effective = _operation_effective_harnesses(
            proj_cfg, registry, operation_context, active_installed
        )
        # A harness that dropped out of THIS project's effective set (its
        # `harnesses:` override narrowed, while the harness is still installed
        # and effective for other projects) never has `apply()` called for it
        # below — apply() is the only place that reconciles/strips a scope's
        # entries, so skipping it entirely would orphan a still-firing hook in
        # this project's native file. Strip it here, the same way the full
        # uninstall cleanup pass strips a globally-gone harness.
        for h_id in set(known_hook_harnesses) - effective:
            selection = hook_adapters.select_hook_adapter(operation_context, h_id)
            adapter = selection.adapter
            if adapter is None:
                continue
            try:
                if adapter.cleanup(
                    scope, h_id,
                    data_home_path=Path(operation_context.data_home),
                ).removed:
                    print(
                        f"  {c('✗', RED)} {proj_name}  [{h_id}] cleaned "
                        f"(no longer effective for this project)"
                    )
            except Exception as e:
                any_error = True
                _hook_err(f"{proj_name} [{h_id}] cleanup failed: {e}")
        if not effective:
            continue
        try:
            resolved = hooks_model.resolve_project_hooks(proj_name, registry)
            lsp_report_sync.bake_resolved_hooks(resolved, scope)
            hook_scripts.bake_script_hooks(resolved, scope)
        except Exception as e:
            print(f"  {c('✗', RED)} {proj_name}  hook resolution failed: {e}")
            any_error = True
            _hook_err(f"{proj_name} hook resolution failed: {e}")
            continue
        for h_id in sorted(effective):
            selection = hook_adapters.select_hook_adapter(operation_context, h_id)
            adapter = selection.adapter
            if adapter is None:
                cap = _cap(h_id)
                reason = cap.reason if cap is not None else "no hook adapter"
                if resolved:
                    print(f"  {c('·', DIM)} {proj_name}  [{h_id}] {reason}")
                hook_targets.append((f"project:{proj_name}", h_id, resolved, cap))
                continue
            try:
                res = adapter.apply(
                    scope, resolved, h_id, _cap(h_id),
                    data_home_path=Path(operation_context.data_home),
                )
            except Exception as e:
                print(f"  {c('✗', RED)} {proj_name}  [{h_id}] apply failed: {e}")
                any_error = True
                _hook_err(f"{proj_name} [{h_id}] apply failed: {e}")
            else:
                _log(proj_name, h_id, res)
                if res.error:
                    any_error = True
                    _hook_err(f"{proj_name} [{h_id}] {res.error}")
                hook_targets.append(
                    (f"project:{proj_name}", h_id, resolved, _cap(h_id))
                )

    # ── Cleanup pass (walks EVERY known hook-capable harness) ──────────────
    # Only `installed` (harnesses.detect_installed(), a config-dir marker check)
    # is authoritative for "is this harness genuinely gone" — the SAME signal
    # every other stream (skills/MCP/permissions) already keys cleanup off of.
    # The probe's NOT_INSTALLED verdict uses a DIFFERENT, narrower check
    # (shutil.which the binary) that exists to gate WRITES, not to declare an
    # uninstall: a transient PATH miss (e.g. a hermetic subprocess environment)
    # must never be treated as "delete the user's real hooks" — it previously
    # was, via an `or cap.verdict == NOT_INSTALLED` clause here, which could
    # silently strip a genuinely-installed codex's hub-managed hooks whenever
    # the probe's `codex` binary lookup failed even though `~/.codex/config.toml`
    # (what `detect_installed` checks) was present. FEATURE_OFF keeps entries
    # (handled by apply's short-circuit above; we never cleanup a still-installed
    # feature-off harness).
    for h_id in known_hook_harnesses:
        selection = hook_adapters.select_hook_adapter(operation_context, h_id)
        adapter = selection.adapter
        if adapter is None:
            continue
        if h_id in active_installed:
            continue
        # Global scope.
        try:
            if adapter.cleanup(
                GlobalScope(), h_id,
                data_home_path=Path(operation_context.data_home),
            ).removed:
                print(f"  {c('✗', RED)} global  [{h_id}] cleaned (uninstalled)")
        except Exception as e:
            any_error = True
            _hook_err(f"global [{h_id}] cleanup failed: {e}")
        # Every registered project scope.
        for proj_name, proj_cfg in projects.items():
            if hub.project_sync_skip_reason(proj_cfg):
                continue
            proj_path = expand(proj_cfg["path"])
            scope = ProjectScope(name=proj_name, path=str(proj_path))
            try:
                if adapter.cleanup(
                    scope, h_id,
                    data_home_path=Path(operation_context.data_home),
                ).removed:
                    print(
                        f"  {c('✗', RED)} {proj_name}  [{h_id}] cleaned (uninstalled)"
                    )
            except Exception as e:
                any_error = True
                _hook_err(f"{proj_name} [{h_id}] cleanup failed: {e}")

    rc = 1 if any_error else 0
    if report is not None:
        report["global"]["hooks"] = {"ok": rc == 0, "errors": hook_errors}
        if operation_context is not None:
            report["global"]["hooks"]["routes"] = {
                h_id: {
                    "mode": operation_context.route(h_id, "hooks").mode,
                    "status": operation_context.route(h_id, "hooks").status,
                    "reason": operation_context.route(h_id, "hooks").reason,
                }
                for h_id in sorted(operation_context.harness_ids)
            }
    return rc


def _run_doctor_rollup(
    doctor_targets: list,
    hook_targets: list,
    _harnesses,
    report: Optional[dict] = None,
    registry: Optional[dict] = None,
    operation_context=None,
) -> int:
    """Shared post-streams doctor rollup (hooks-surface task 2.4).

    Runs after BOTH the permissions and hooks streams so a single risk scan
    covers permission rules AND hook definitions. `doctor_targets` are
    `(scope_label, harness_id, NormalizedPermissions)` from the permissions
    stream; `hook_targets` are `(scope_label, harness_id, resolved_hooks,
    capability)` from the hooks stream. Returns 2 when any finding has
    `severity = "danger"`, else 0.

    Hook-specific findings (broken-script, LSP_CHECKER_MISSING, …) are owned by a
    parallel wave (task 2.5). This rollup calls `risks.detect_hook_risks` when it
    exists so those findings surface as soon as that wave lands; until then the
    hook leg contributes no findings but the structural wiring (targets flow in)
    is already in place.
    """
    from skill_hub.domain.diagnostics import risks
    from skill_hub.infrastructure.permissions import permission_adapters as pa_mod

    print(f"\n{c('Doctor:', BOLD)}")
    danger_count = 0
    any_findings = False
    doctor_errors: list[dict] = []

    def _label(h_id: str) -> str:
        harness = _harnesses.HARNESSES.get(h_id) if operation_context is None else None
        return harness.label if harness is not None else h_id

    def _emit_prefixed(prefix: str, findings) -> None:
        nonlocal danger_count, any_findings
        if not findings:
            return
        any_findings = True
        for f in findings:
            colour = RED if f.severity == "danger" else YELLOW
            icon = "✗" if f.severity == "danger" else "!"
            print(f"  {c(icon, colour)} {prefix} {f.code} ({f.severity}): {f.detail}")
            if f.severity == "danger":
                danger_count += 1
                doctor_errors.append({
                    "stage": "doctor",
                    "message": f"{prefix} {f.code}: {f.detail}",
                })

    def _emit(scope_label: str, h_id: str, findings) -> None:
        _emit_prefixed(f"{scope_label}  [{_label(h_id)}]", findings)

    # Permissions leg.
    def _scope_for_label(scope_label: str):
        from skill_hub.domain.permissions.permissions import GlobalScope, ProjectScope

        if scope_label == "global":
            return GlobalScope()
        if scope_label.startswith("project:") and registry is not None:
            name = scope_label.split(":", 1)[1]
            cfg = (registry.get("projects") or {}).get(name)
            if cfg and cfg.get("path"):
                return ProjectScope(name=name, path=str(expand(cfg["path"])))
        return None

    for scope_label, h_id, perms in doctor_targets:
        adapter = None
        if _operation_permission_key(operation_context, h_id) is not None:
            adapter = pa_mod.select_permission_adapter(operation_context, h_id).adapter
        caps = adapter.capabilities() if adapter is not None else set()
        findings = risks.detect_risks(perms, caps)

        # Native leg: conflicts in the file's actual content + sidecar drift
        # from the strip this very sync just ran. Best-effort — never breaks
        # the rollup.
        scope_obj = _scope_for_label(scope_label)
        if scope_obj is not None and adapter is not None and hasattr(
            adapter, "discover_existing"
        ):
            try:
                from skill_hub.domain.permissions.permissions import read_sidecar as _read_sc

                discovered = adapter.discover_existing(scope_obj, h_id)
                source_file = ""
                if hasattr(adapter, "target_files"):
                    try:
                        source_file = str(adapter.target_files(scope_obj, h_id))
                    except Exception:
                        source_file = ""
                findings.extend(
                    risks.detect_native_conflicts(discovered, perms, source_file)
                )
                findings.extend(
                    risks.detect_sidecar_drift(_read_sc(h_id, scope_obj))
                )
            except Exception:
                pass

        _emit(scope_label, h_id, findings)

    # Hooks leg (structural seam for task 2.5's hook-specific findings).
    detect_hook_risks = getattr(risks, "detect_hook_risks", None)
    if callable(detect_hook_risks):
        for scope_label, h_id, resolved_hooks, capability in hook_targets:
            try:
                findings = detect_hook_risks(resolved_hooks, capability, h_id) or []
            except TypeError:
                # Tolerate a narrower signature from the parallel wave.
                findings = detect_hook_risks(resolved_hooks, capability) or []
            _emit(scope_label, h_id, findings)

    # Hook-script leg — registry-level, so it runs once (not per scope/harness):
    # a managed body is one file, and a repo script's existence is per PROJECT,
    # not per harness. Skipped entirely when the hooks stream did not run.
    detect_hook_script_risks = getattr(risks, "detect_hook_script_risks", None)
    if callable(detect_hook_script_risks) and registry is not None and hook_targets:
        try:
            _emit_prefixed("hooks", detect_hook_script_risks(registry) or [])
        except Exception as exc:  # pragma: no cover — never break the rollup
            print(f"  {c('!', YELLOW)} hook script scan skipped: {exc}")

    # Companions (ships_with) leg — registry-level, like the hook-script leg:
    # COMPANION_ORPHANED / COMPANIONS_PENDING / COMPANION_REF_MISSING /
    # COMPANION_AGENT_DRIFT come from the ledger, not from a harness file.
    detect_companion_risks = getattr(risks, "detect_companion_risks", None)
    if callable(detect_companion_risks) and registry is not None:
        try:
            _emit_prefixed("companions", detect_companion_risks(registry) or [])
        except Exception as exc:  # pragma: no cover — never break the rollup
            print(f"  {c('!', YELLOW)} companion risk scan skipped: {exc}")

    # Backup leg — harness-independent, so it carries no `[harness]` label. The
    # backup pass is fail-OPEN, which means a backup that has silently stopped
    # reaching GitHub leaves nothing behind but the counters in the `backup:`
    # block; this is what turns them into something the user is told about.
    detect_backup_risks = getattr(risks, "detect_backup_risks", None)
    if callable(detect_backup_risks) and registry is not None:
        try:
            _emit_prefixed("backup", detect_backup_risks(registry.get("backup")) or [])
        except Exception as exc:  # pragma: no cover — never break the rollup
            print(f"  {c('!', YELLOW)} backup risk scan skipped: {exc}")

    # MCP leg — never spawns the login shell itself: `doctor_findings` is
    # handed `env=None` and resolves `mcp_probe.resolved_env()` lazily, only
    # for a delivered spec that actually carries a `${VAR}` (C-2). Guarded
    # the same way as the legs above it — a corrupt probe cache or any other
    # unexpected failure here must never take down the rollup (C-1).
    if report is not None and registry is not None:
        try:
            from skill_hub.infrastructure.mcp import mcp_delivery

            _emit_prefixed("mcp", mcp_delivery.doctor_findings(report, registry, None) or [])
        except Exception as exc:  # pragma: no cover — never break the rollup
            print(f"  {c('!', YELLOW)} mcp risk scan skipped: {exc}")

    if not any_findings:
        print(f"  {c('✓', GREEN)} no risks detected")

    rc = 2 if danger_count > 0 else 0
    if report is not None:
        report["global"]["doctor"] = {"ok": rc == 0, "errors": doctor_errors}
    return rc
