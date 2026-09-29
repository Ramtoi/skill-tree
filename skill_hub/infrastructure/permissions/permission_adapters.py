"""Permission adapters — translate NormalizedPermissions → per-harness native writes.

Mirrors `mcp_adapters.py`. Each harness's `permission_adapter_key` selects an
adapter from the `ADAPTERS` registry. Adapters expose:

    translate(perms, scope, harness_id) -> TranslateResult
    apply(scope, native_write, harness_id) -> bool
    cleanup(scope, harness_id) -> bool
    capabilities() -> set[PermissionFeature]
    validate(rule) -> ValidationResult
    discover_existing(scope, harness_id) -> NormalizedPermissions

Round-trip writes preserve unrelated user keys. Cleanup is driven by sidecar
state at `~/.skill-hub/state/<harness>/<scope>.managed.json` — user config files
never contain hub-internal metadata.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from skill_hub.domain.harnesses.harness_adapter_api import PermissionPatternBlock
from skill_hub.domain.permissions.permission_adapter_base import (  # noqa: F401
    _BACKUP_SESSION,
    _BASH_PATTERN_RE,
    DirectoryContribution,
    DirectoryEndpoint,
    DirectoryPlan,
    NativeDirectoryMutation,
    NativeWrite,
    PermissionAdapter,
    SkipReason,
    TranslateResult,
    ValidationResult,
    WorktreeAccessStatus,
    _atomic_replace,
    _backup_once_per_session,
    _backups_root,
    _bash_prefix_tokens,
    _detect_risks_for_translate,
    _kind_feature,
    _maybe_prune_empty,
    _parse_managed_key,
    _resolve_list_at_path,
    _strip_managed_from_json,
    _strip_managed_verified,
    apply_directory_cleanup,
    permission_block_sha256,
    plan_directory_cleanup,
)
from skill_hub.domain.permissions.permissions import (
    DirectoryLedgerIdentity,
    GlobalScope,
    NormalizedPermissions,
    PermissionFeature,
    ProjectScope,
    Rule,
    Scope,
    delete_directory_sidecar,
    delete_sidecar,
    read_directory_sidecar,
    read_sidecar,
    write_directory_sidecar,
    write_sidecar,
)
from skill_hub.infrastructure.harnesses.harness_bundled_permissions import bundled_pattern_codec

# ─────────────────────────────────────────────────────────────────────────────
# Claude / Pi adapter (JSON settings file)
# ─────────────────────────────────────────────────────────────────────────────


_CLAUDE_PATHS = {
    "claude-code": {
        "project": Path(".claude/settings.json"),
        # Personal, gitignored per-project tier (the harness's native local
        # layer). Targeted only by a ProjectScope with personal=True so a
        # developer can keep per-project rules out of the committed settings.
        "project_local": Path(".claude/settings.local.json"),
        "global": Path("~/.claude/settings.json"),
    },
    "pi": {
        "project": Path(".pi/agent/settings.json"),
        # Pi's personal-file analog under its own settings dir (same
        # settings.local.json convention as Claude Code).
        "project_local": Path(".pi/agent/settings.local.json"),
        "global": Path("~/.pi/agent/settings.json"),
    },
}


# Tool(arg) pattern: a tool name (alnum/underscore) optionally followed by a
# parenthesised argument spec, OR a `Tool:arg` colon form. Used by the
# Claude-family validator below.
def _validate_claude_pattern(pattern: str) -> ValidationResult:
    """Syntactic validation of a Claude-family permission pattern.

    Rejects malformed patterns the harness would silently ignore at runtime:
      * unbalanced parentheses (e.g. ``Bash(npm:*`` — missing close paren),
      * empty / missing tool name,
      * stray characters outside the ``Tool(arg)`` / ``Tool:arg`` shapes.

    Valid: ``Bash(npm:*)``, ``Bash(git push:*)``, ``Read(secrets/**)``,
    ``WebFetch(*)``, ``Bash:*``, bare ``Bash``.
    """
    error = bundled_pattern_codec("claude").validation_error(pattern)
    return ValidationResult(ok=error is None, error=error)


_CLAUDE_CAPS = {
    PermissionFeature.TOOL_ALLOWLIST,
    PermissionFeature.TOOL_DENYLIST,
    PermissionFeature.TOOL_ASK,
    PermissionFeature.HOOKS,
    PermissionFeature.ADDITIONAL_DIRECTORIES,
}


class ClaudePermissionAdapter:
    """Writes JSON settings for Claude-shape harnesses (claude-code and pi).

    File target depends on `harness_id` (see `target_files`). Adapter body is
    harness-agnostic; only the path resolver branches.
    """

    def __init__(self, layout=None):
        self._layout = layout

    def target_files(self, scope: Scope, harness_id: str) -> Path:
        if self._layout is not None:
            if isinstance(scope, GlobalScope):
                if self._layout.permission_global_config is not None:
                    return Path(self._layout.permission_global_config)
            elif getattr(scope, "personal", False):
                if self._layout.permission_project_local_config is not None:
                    return Path(scope.path) / self._layout.permission_project_local_config
            elif self._layout.permission_project_config is not None:
                return Path(scope.path) / self._layout.permission_project_config
            raise ValueError("permission target is unavailable in this operation")
        paths = _CLAUDE_PATHS.get(harness_id)
        if paths is None:
            raise ValueError(f"ClaudePermissionAdapter: no path config for harness {harness_id!r}")
        if isinstance(scope, GlobalScope):
            return Path(str(paths["global"])).expanduser()
        # ProjectScope: a personal scope routes to the gitignored local file
        # (.claude/settings.local.json), the shared scope to the committed one.
        if getattr(scope, "personal", False):
            return Path(scope.path) / paths["project_local"]
        return Path(scope.path) / paths["project"]

    def capabilities(self) -> set:
        return set(_CLAUDE_CAPS)

    def validate(self, rule: Rule) -> ValidationResult:
        if not rule.pattern:
            return ValidationResult(ok=False, error="empty pattern")
        if rule.kind not in {"allow", "deny", "ask"}:
            return ValidationResult(ok=False, error=f"unknown kind {rule.kind!r}")
        return _validate_claude_pattern(rule.pattern)

    def translate(
        self,
        perms: NormalizedPermissions,
        scope: Scope,
        harness_id: str,
    ) -> TranslateResult:
        target = self.target_files(scope, harness_id)
        result = TranslateResult()
        caps = self.capabilities()

        # Filter rules by harness affinity (None = all) and feature support.
        def feature_for_kind(kind: str) -> PermissionFeature:
            return {
                "allow": PermissionFeature.TOOL_ALLOWLIST,
                "deny": PermissionFeature.TOOL_DENYLIST,
                "ask": PermissionFeature.TOOL_ASK,
            }[kind]

        def applicable(rule: Rule) -> bool:
            if rule.harnesses is not None and harness_id not in rule.harnesses:
                return False
            return feature_for_kind(rule.kind) in caps

        allow = [r for r in perms.allow if applicable(r)]
        deny = [r for r in perms.deny if applicable(r)]
        ask = [r for r in perms.ask if applicable(r)]

        # Hooks are NO LONGER authored from the permissions block (hooks-surface
        # D6): the hook LIBRARY + `hook_adapters.ClaudeHookAdapter` own every
        # native hook write now. This adapter neither translates nor writes
        # `perms.hooks`; the hooks sync stream handles them out-of-band.
        additional_dirs = list(perms.additional_dirs)

        # Skips: typed Codex-only fields not applicable here.
        if perms.sandbox_mode is not None:
            result.skipped.append(
                SkipReason(
                    feature=PermissionFeature.SANDBOX_MODE.value,
                    reason=f"{harness_id} has no sandbox_mode field",
                )
            )
        if perms.approval_policy is not None:
            result.skipped.append(
                SkipReason(
                    feature=PermissionFeature.APPROVAL_POLICY.value,
                    reason=f"{harness_id} has no approval_policy field",
                )
            )
        if perms.project_trust is not None:
            result.skipped.append(
                SkipReason(
                    feature=PermissionFeature.PROJECT_TRUST.value,
                    reason=f"{harness_id} has no project_trust field",
                )
            )

        # Forward-compat: unknown `extras` keys are not recognised by this adapter.
        for extras_key in perms.extras.keys():
            result.skipped.append(
                SkipReason(
                    feature=extras_key,
                    reason=f"{harness_id} adapter does not recognise extras key {extras_key!r}",
                )
            )

        managed_keys: list[str] = []
        for i, _ in enumerate(allow):
            managed_keys.append(f"permissions.allow[{i}]")
        for i, _ in enumerate(deny):
            managed_keys.append(f"permissions.deny[{i}]")
        for i, _ in enumerate(ask):
            managed_keys.append(f"permissions.ask[{i}]")
        for i, _ in enumerate(additional_dirs):
            managed_keys.append(f"permissions.additionalDirectories[{i}]")

        payload = {
            "allow": allow,
            "deny": deny,
            "ask": ask,
            "additional_dirs": additional_dirs,
        }

        result.writes.append(
            NativeWrite(
                target_path=target,
                payload=payload,
                managed_keys=managed_keys,
                format="json",
            )
        )
        result.risks = _detect_risks_for_translate(perms, self.capabilities())
        return result

    def apply(self, scope: Scope, write: NativeWrite, harness_id: str) -> bool:
        target = write.target_path

        # 1. Backup once per session if file already exists.
        _backup_once_per_session(target, scope, harness_id)

        # 2. Strip previously-managed keys (sidecar-driven) before re-writing.
        #    An existing-but-unreadable/unparseable settings file ABORTS this
        #    write (same posture as the Codex adapter's `_load_doc`): treating it
        #    as `{}` and serializing would overwrite the user's whole settings
        #    file — model, env, hooks, everything — to "fix" a permission rule.
        existing: dict = {}
        if target.exists():
            try:
                with open(target) as f:
                    existing = json.load(f)
            except (OSError, json.JSONDecodeError) as e:
                print(
                    f"warning: cannot parse {target}: {e} — skipping {harness_id} permission write",
                    file=sys.stderr,
                )
                return False
            if not isinstance(existing, dict):
                print(
                    f"warning: {target} root is not a JSON object — skipping {harness_id} permission write",
                    file=sys.stderr,
                )
                return False

        prior = read_sidecar(harness_id, scope)
        drift_events: list[dict] = []
        if prior is not None and prior.managed_keys:
            drift_events = _strip_managed_verified(existing, prior.managed_keys, prior.managed_values)
            for ev in drift_events:
                if ev["mode"] == "fallback":
                    print(
                        f"warning: {target}: sidecar index drift — "
                        f"{ev['key']} no longer held {ev['expected']!r}; "
                        f"removed hub's copy by value (file was edited "
                        f"externally)",
                        file=sys.stderr,
                    )

        # 3. Splice in the new managed payload.
        payload = write.payload
        new_managed_keys: list[str] = []
        new_managed_values: dict[str, str] = {}
        codec = bundled_pattern_codec(harness_id if harness_id == "pi" else "claude")
        encoded = codec.encode(
            PermissionPatternBlock(
                allow=tuple(r.pattern for r in payload["allow"]),
                deny=tuple(r.pattern for r in payload["deny"]),
                ask=tuple(r.pattern for r in payload["ask"]),
                additional_directories=tuple(payload["additional_dirs"]),
            )
        )

        if payload["allow"] or payload["deny"] or payload["ask"]:
            permissions_section = existing.get("permissions")
            if not isinstance(permissions_section, dict):
                permissions_section = {}
            for kind in ("allow", "deny", "ask"):
                rules = payload[kind]
                if not rules:
                    continue
                lst = list(permissions_section.get(kind) or [])
                base = len(lst)
                for offset, r in enumerate(rules):
                    lst.append(encoded[kind][offset])
                    mk = f"permissions.{kind}[{base}]"
                    new_managed_keys.append(mk)
                    new_managed_values[mk] = r.pattern
                    base += 1
                permissions_section[kind] = lst
            existing["permissions"] = permissions_section

        # Hooks are owned by the hook library + `hook_adapters` now — this
        # permissions adapter never writes a `hooks:` section. Any legacy
        # `hooks.<event>[<i>]` key still recorded in this scope's permissions
        # sidecar was already stripped in step 2 (format-agnostic index strip),
        # which removes the stale hub-written hook entry from the native file;
        # it is NOT re-emitted here. The hooks stream re-establishes correct,
        # hooks-kind-sidecar ownership on its own pass.

        if payload["additional_dirs"]:
            permissions_section = existing.get("permissions")
            if not isinstance(permissions_section, dict):
                permissions_section = {}
            existing_dirs = list(permissions_section.get("additionalDirectories") or [])
            base = len(existing_dirs)
            encoded_dirs = encoded["additionalDirectories"]
            for offset, d in enumerate(payload["additional_dirs"]):
                existing_dirs.append(encoded_dirs[offset])
                mk = f"permissions.additionalDirectories[{base}]"
                new_managed_keys.append(mk)
                new_managed_values[mk] = d
                base += 1
            permissions_section["additionalDirectories"] = existing_dirs
            existing["permissions"] = permissions_section

        # 4. Atomic write of the user-config file.
        content = json.dumps(existing, indent=2, sort_keys=False) + "\n"
        _atomic_replace(target, content)

        # 5. Update sidecar with the new managed keys (v2: value guards +
        #    block hash for staleness detection + this strip's drift log).
        write_sidecar(
            harness_id,
            scope,
            new_managed_keys,
            target,
            managed_values=new_managed_values,
            block_sha256=permission_block_sha256(payload),
            drift_events=drift_events,
        )
        return True

    def cleanup(self, scope: Scope, harness_id: str) -> bool:
        sc = read_sidecar(harness_id, scope)
        if sc is None:
            return False
        target = Path(sc.file)
        if not target.exists():
            delete_sidecar(harness_id, scope)
            return True
        try:
            with open(target) as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            return False
        _strip_managed_verified(data, sc.managed_keys, sc.managed_values)
        _atomic_replace(target, json.dumps(data, indent=2) + "\n")
        delete_sidecar(harness_id, scope)
        return True

    def discover_existing(
        self,
        scope: Scope,
        harness_id: str,
        project_path: Optional[Path] = None,
    ) -> NormalizedPermissions:
        target = self.target_files(scope, harness_id)
        if not target.exists():
            return NormalizedPermissions()
        try:
            with open(target) as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            return NormalizedPermissions()
        try:
            block = bundled_pattern_codec(harness_id if harness_id == "pi" else "claude").decode(
                data.get("permissions") or {}
            )
        except (TypeError, ValueError):
            return NormalizedPermissions()
        allow = [Rule(pattern=p, kind="allow") for p in block.allow]
        deny = [Rule(pattern=p, kind="deny") for p in block.deny]
        ask = [Rule(pattern=p, kind="ask") for p in block.ask]
        # Native `hooks:` sections are no longer discovered into the permissions
        # block — the hook library owns hooks (hooks-surface D6). Discovery here
        # is permission-rules only.
        additional_dirs = list(block.additional_directories)
        return NormalizedPermissions(
            allow=allow,
            deny=deny,
            ask=ask,
            additional_dirs=additional_dirs,
        )

    def plan_directories(self, scope, contributions, harness_id):
        target = self.target_files(scope, harness_id)
        paths = tuple(dict.fromkeys(p for c in contributions for p in c.paths))
        return DirectoryPlan(
            target, "permissions.additionalDirectories", tuple(contributions), "claude-json", "configured"
        )

    def apply_directories(self, scope, plan, harness_id):
        target = plan.target_file
        try:
            data = json.loads(target.read_text()) if target.exists() else {}
            if not isinstance(data, dict):
                raise ValueError("root is not an object")
            identity = DirectoryLedgerIdentity.from_scope(scope, harness_id)
            prior = read_directory_sidecar(identity)
            if prior is not None and prior.directory_ledger.get("native_key") != plan.native_key:
                old_plan = plan_directory_cleanup(self, scope, harness_id)
                old_status = apply_directory_cleanup(self, old_plan)
                if old_status.config_state == "failed":
                    return old_status
                prior = None
            if not plan.contributions and prior is None:
                return WorktreeAccessStatus(harness_id, "unmanaged", "not_applicable", str(target))
            generic = read_sidecar(harness_id, scope)
            ledger = (
                dict(prior.directory_ledger)
                if prior
                else {"native_key": plan.native_key, "contributions": {}, "entries": {}}
            )
            if prior is None and generic is not None:
                legacy = {k: v for k, v in generic.managed_values.items() if k.startswith("additionalDirectories[")}
                if legacy:
                    for value in legacy.values():
                        entry = ledger.setdefault("entries", {}).setdefault(value, {"owned_count": 0})
                        entry["owned_count"] = int(entry.get("owned_count", 0)) + 1
                    _strip_managed_verified(data, generic.managed_keys, generic.managed_values)
            desired = {p for c in plan.contributions for p in c.paths}
            old_entries = ledger.get("entries", {})
            section = data.setdefault("permissions", {})
            if not isinstance(section, dict):
                raise ValueError("permissions is not an object")
            raw_current = section.get("additionalDirectories", [])
            if not isinstance(raw_current, list) or any(not isinstance(p, str) or not p for p in raw_current):
                raise ValueError("additionalDirectories must be a list of strings")
            current = list(raw_current)
            preexisting_counts = {p: current.count(p) for p in set(current)}
            for path in sorted(desired):
                if path not in current:
                    current.append(path)
            for path, info in old_entries.items():
                if path not in desired:
                    for _ in range(int((info or {}).get("owned_count", 0))):
                        if path in current:
                            current.remove(path)
            if current:
                section["additionalDirectories"] = current
            else:
                section.pop("additionalDirectories", None)
            data["permissions"] = section
            _atomic_replace(target, json.dumps(data, indent=2) + "\n")
            ledger["contributions"] = {c.id: list(c.paths) for c in plan.contributions}
            ledger["identity"] = identity.to_dict()
            ledger["native_key"] = plan.native_key
            ledger["entries"] = {
                p: {
                    "owned_count": int((old_entries.get(p) or {}).get("owned_count", 0))
                    if p in old_entries
                    else (0 if preexisting_counts.get(p, 0) else 1),
                    "observed_preexisting_count": int(
                        (old_entries.get(p) or {}).get("observed_preexisting_count", preexisting_counts.get(p, 0))
                    ),
                    "last_verified_count": current.count(p),
                }
                for p in desired
            }
            if not ledger["contributions"] and not ledger["entries"]:
                delete_directory_sidecar(identity)
                return WorktreeAccessStatus(harness_id, "removed", "not_applicable", str(target))
            write_directory_sidecar(identity, target, ledger)
            requested = next(iter(desired), None)
            missing = bool(requested and not Path(requested).exists())
            return WorktreeAccessStatus(
                harness_id,
                "configured",
                "needs_session_check",
                str(target),
                requested,
                missing,
                "CLAUDE_PROJECT_SETTINGS_UNVERIFIED",
                "Start a new session; project settings precedence is not verified.",
            )
        except (OSError, ValueError, json.JSONDecodeError):
            return WorktreeAccessStatus(
                harness_id,
                "failed",
                "not_applicable",
                str(target),
                None,
                False,
                "CLAUDE_DIRECTORIES_MALFORMED",
                "The Claude settings file has an unsupported shape.",
            )

    def read_directories(self, scope, contributions, harness_id):
        plan = self.plan_directories(scope, contributions, harness_id)
        requested = next((p for c in contributions for p in c.paths), None)
        missing = bool(requested and not Path(requested).exists())
        try:
            data = json.loads(plan.target_file.read_text()) if plan.target_file.exists() else {}
            section = data.get("permissions") if isinstance(data, dict) else None
            values = section.get("additionalDirectories", []) if section is not None else []
            if (
                not isinstance(data, dict)
                or (section is not None and not isinstance(section, dict))
                or not isinstance(values, list)
                or any(not isinstance(p, str) or not p for p in values)
            ):
                raise ValueError
            configured = bool(requested and requested in values)
            if requested and not configured:
                return WorktreeAccessStatus(
                    harness_id,
                    "failed",
                    "not_applicable",
                    str(plan.target_file),
                    requested,
                    missing,
                    "CLAUDE_DIRECTORY_MISSING",
                    "The requested directory grant is absent from native settings.",
                )
            ledger = read_directory_sidecar(DirectoryLedgerIdentity.from_scope(scope, harness_id))
            owned = bool(ledger and ledger.directory_ledger.get("entries", {}).get(requested, {}).get("owned_count", 0))
        except (OSError, ValueError, json.JSONDecodeError):
            return WorktreeAccessStatus(
                harness_id,
                "failed",
                "not_applicable",
                str(plan.target_file),
                requested,
                missing,
                "CLAUDE_DIRECTORIES_MALFORMED",
                "The Claude settings file has an unsupported shape.",
            )
        return WorktreeAccessStatus(
            harness_id,
            "configured" if owned else "borrowed",
            "needs_session_check",
            str(plan.target_file),
            requested,
            missing,
            "CLAUDE_PROJECT_SETTINGS_UNVERIFIED",
            "Start a new session; project settings precedence is not verified.",
        )

    def directory_cleanup_endpoint(self, scope, harness_id, native_key):
        if native_key != "permissions.additionalDirectories":
            raise ValueError("unsupported Claude directory key")
        return DirectoryEndpoint(self.target_files(scope, harness_id), native_key)

    def plan_owned_directory_removal(self, endpoint, entries):
        if not endpoint.target_file.exists():
            return None
        data = json.loads(endpoint.target_file.read_text())
        if not isinstance(data, dict):
            raise ValueError("root is not an object")
        section = data.get("permissions")
        if not isinstance(section, dict):
            raise ValueError("permissions is not an object")
        current = section.get("additionalDirectories", [])
        if not isinstance(current, list) or any(not isinstance(p, str) or not p for p in current):
            raise ValueError("additionalDirectories must be a list of strings")
        kept = list(current)
        changed = False
        for path, info in entries.items():
            if not isinstance(path, str) or not isinstance(info, dict):
                raise ValueError("invalid directory entry")
            count = info.get("owned_count")
            if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                raise ValueError("owned_count must be a non-negative integer")
            if count == 0:
                continue
            for _ in range(count):
                if path in kept:
                    kept.remove(path)
                    changed = True
        if not changed:
            return None
        if kept:
            section["additionalDirectories"] = kept
        else:
            section.pop("additionalDirectories", None)
        return NativeDirectoryMutation(
            endpoint.target_file, endpoint.native_key, json.dumps(data, indent=2) + "\n", "json"
        )

    def apply_owned_directory_removal(self, mutation):
        if mutation.content is not None:
            _atomic_replace(mutation.target_file, mutation.content)

    def cleanup_directories(self, scope, harness_id):
        return apply_directory_cleanup(self, plan_directory_cleanup(self, scope, harness_id))

    def discover_candidates(
        self,
        scope: Scope,
        harness_id: str,
    ) -> list[dict]:
        """Discovered allow/deny/ask rules as import candidates (cross-harness
        reconciliation). Claude-family rules are always representable (the
        registry pattern model is Claude-shaped). No line span — Claude `drop`
        removes the rule from the JSON settings, not via a source excise.

        Hub-managed rules (those at sidecar `managed_keys` indices) are excluded
        so a rule hub already imported/auto-synced does not re-surface as a fresh
        candidate, and a deliberately-deleted scope (empty managed set) never
        re-prompts (D3 first-contact guarantee).

        At project scope this ALSO scans the personal file
        (`.claude/settings.local.json`) — Claude Code writes every
        session-accepted permission there, which used to be a structural blind
        spot. Personal-file candidates are excluded against the PERSONAL scope's
        own sidecar and carry that file as their `file`/`source`; they are
        candidates only, never auto-imported."""
        out = self._candidates_from_file(
            self.target_files(scope, harness_id),
            read_sidecar(harness_id, scope),
            harness_id,
        )
        if isinstance(scope, ProjectScope) and not scope.personal:
            personal = ProjectScope(name=scope.name, path=scope.path, personal=True)
            out.extend(
                self._candidates_from_file(
                    self.target_files(personal, harness_id),
                    read_sidecar(harness_id, personal),
                    harness_id,
                )
            )
        return out

    @staticmethod
    def _candidates_from_file(target: Path, sc, harness_id: str) -> list[dict]:
        if not target.exists():
            return []
        try:
            with open(target) as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            return []
        try:
            block = bundled_pattern_codec(harness_id if harness_id == "pi" else "claude").decode(
                data.get("permissions") or {}
            )
        except (TypeError, ValueError):
            return []

        # Indices hub owns, per kind — exclude them from candidates.
        managed: dict[str, set] = {"allow": set(), "deny": set(), "ask": set()}
        if sc is not None:
            for key in sc.managed_keys:
                parsed = _parse_managed_key(key)
                if parsed is None:
                    continue
                path, idx = parsed
                if len(path) == 2 and path[0] == "permissions" and path[1] in managed:
                    managed[path[1]].add(idx)

        out: list[dict] = []
        for kind in ("allow", "deny", "ask"):
            arr = getattr(block, kind)
            for i, p in enumerate(arr):
                if i in managed[kind]:
                    continue  # hub-managed — not a pre-existing user rule
                out.append(
                    {
                        "pattern": str(p),
                        "kind": kind,
                        "decision": None,
                        "source": target.name,
                        "harness": harness_id,
                        "file": str(target),
                        "lineno": None,
                        "end_lineno": None,
                        "importable": True,
                        "reason": None,
                    }
                )
        return out


from skill_hub.infrastructure.permissions.permission_adapter_codex import (  # noqa: F401
    _CODEX_CAPS,
    _CODEX_GLOBAL,
    _CODEX_RULES_HEADER,
    _DECISION_TO_KIND,
    _KIND_TO_DECISION,
    _RULES_SIDECAR_KIND,
    _TOMLKIT_MISSING_REASON,
    CodexPermissionAdapter,
    _codex_default_rules_target,
    _codex_project_key,
    _codex_rules_target,
    _codex_strip_key,
    _emit_prefix_rule_line,
    _nonempty_literal,
    _parse_prefix_rules,
    _prefix_rule_to_registry_pattern,
    _render_codex_rules_file,
    _tomlkit_missing,
)

# ─────────────────────────────────────────────────────────────────────────────
# Cross-harness import reconciliation (D11)
# ─────────────────────────────────────────────────────────────────────────────


def gather_import_candidates(scope: Scope, harness_ids: list[str], operation_context=None) -> list[dict]:
    """Collect import candidates from every installed harness that exposes
    `discover_candidates`, tagged by source file + harness."""
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    out: list[dict] = []
    for h_id in harness_ids:
        harness = _harnesses.HARNESSES.get(h_id)
        if harness is None or harness.permission_adapter_key is None:
            continue
        adapter = select_permission_adapter(operation_context, h_id).adapter
        if adapter is None or not hasattr(adapter, "discover_candidates"):
            continue
        try:
            out.extend(adapter.discover_candidates(scope, h_id))
        except Exception as e:
            print(f"warning: discover_candidates failed for {h_id}: {e}", file=sys.stderr)
    return out


def reconcile_candidates(candidates: list[dict]) -> dict:
    """Reconcile cross-harness candidates into the single registry model (D11).

    - Same command (registry pattern) + same kind across harnesses → one
      affinity-free `merged` rule (collapsed; `sources` records every origin so
      import can MOVE/excise each).
    - Same command + divergent kind across harnesses → a `conflict` (never
      auto-picked); `options` maps kind → harness ids.
    - Un-representable candidates (Codex `match`/`not_match`, unions) pass
      through as `un_importable` with their reason.
    """
    importable = [c for c in candidates if c.get("importable") and c.get("pattern")]
    un_importable = [c for c in candidates if not c.get("importable")]

    by_pattern: dict[str, list[dict]] = {}
    for c in importable:
        by_pattern.setdefault(c["pattern"], []).append(c)

    merged: list[dict] = []
    conflicts: list[dict] = []
    for pattern in sorted(by_pattern):
        group = by_pattern[pattern]
        kinds = {c["kind"] for c in group}
        if len(kinds) == 1:
            merged.append(
                {
                    "pattern": pattern,
                    "kind": next(iter(kinds)),
                    "harnesses": None,  # collapses → applies to all
                    "sources": group,
                }
            )
        else:
            options: dict[str, list[str]] = {}
            for c in group:
                options.setdefault(c["kind"], []).append(c["harness"])
            conflicts.append(
                {
                    "pattern": pattern,
                    "options": {k: sorted(set(v)) for k, v in options.items()},
                    "sources": group,
                }
            )
    return {"merged": merged, "conflicts": conflicts, "un_importable": un_importable}


from skill_hub.infrastructure.permissions.permission_adapter_opencode import (  # noqa: F401
    _OPENCODE_BASH_PREFIX,
    _OPENCODE_CAPS,
    _OPENCODE_DECISION,
    OpenCodePermissionAdapter,
    _opencode_bash_prefix,
    _opencode_pattern_from_prefix,
    _opencode_sort_key,
    _opencode_target,
)

# ─────────────────────────────────────────────────────────────────────────────
# Adapter registry
# ─────────────────────────────────────────────────────────────────────────────


_CLAUDE_ADAPTER = ClaudePermissionAdapter()
_CODEX_ADAPTER = CodexPermissionAdapter()
_OPENCODE_ADAPTER = OpenCodePermissionAdapter()

ADAPTERS: dict[str, PermissionAdapter] = {
    "claude": _CLAUDE_ADAPTER,
    "codex": _CODEX_ADAPTER,
    "opencode": _OPENCODE_ADAPTER,
}


@dataclass(frozen=True)
class PermissionAdapterSelection:
    """Host adapter paired with the immutable operation route."""

    adapter: Optional[PermissionAdapter]
    route: object


def validate_rule_across_adapters(
    rule: Rule,
    *,
    operation_context=None,
    mode: str = "operation",
) -> ValidationResult:
    """Validate one registry rule against the applicable native codecs.

    ``mode='baseline'`` is for metadata-only validation and deliberately uses
    the stable bundled adapter table.  Operation callers pass their captured
    context so route mismatches fail before a mutation.  Codex remains
    excluded from the aggregate because its command-rule surface is not the
    portable registry rule contract.
    """
    if mode not in {"operation", "baseline"}:
        raise ValueError("permission validation mode must be operation or baseline")

    if operation_context is None and mode != "baseline":
        return ValidationResult(ok=False, error="permission route unavailable")

    adapters: list[PermissionAdapter] = []
    if mode == "baseline":
        adapters = [
            adapter
            for key, adapter in sorted(ADAPTERS.items())
            if key != "codex"
        ]
    else:
        harness_ids = sorted(set(operation_context.harness_ids or ()))
        for harness_id in harness_ids:
            if harness_id == "codex":
                continue
            selection = select_permission_adapter(operation_context, harness_id)
            if selection.adapter is None:
                return ValidationResult(ok=False, error="permission route unavailable")
            adapters.append(selection.adapter)
        if not adapters:
            return ValidationResult(
                ok=False, error="no non-Codex permission adapter captured"
            )

    any_ok = False
    last_error = ""
    for adapter in adapters:
        result = adapter.validate(rule)
        if result.ok:
            any_ok = True
        elif result.error:
            last_error = result.error
        elif not last_error:
            last_error = "invalid"
    return ValidationResult(ok=any_ok, error=None if any_ok else last_error)


def validate_rule_for_harness(
    rule: Rule,
    harness_id: str,
    *,
    operation_context=None,
    mode: str = "operation",
) -> ValidationResult:
    """Validate a rule through one captured harness route."""
    if operation_context is None and mode != "baseline":
        return ValidationResult(ok=False, error="permission route unavailable")
    if mode == "baseline":
        from skill_hub.infrastructure.harnesses import harnesses

        declaration = harnesses.HARNESSES.get(harness_id)
        key = declaration.permission_adapter_key if declaration is not None else harness_id
        adapter = get_adapter(key)
    else:
        adapter = select_permission_adapter(operation_context, harness_id).adapter
    if adapter is None:
        return ValidationResult(ok=False, error="permission route unavailable")
    return adapter.validate(rule)


def get_adapter(key: Optional[str]) -> Optional[PermissionAdapter]:
    if key is None:
        return None
    return ADAPTERS.get(key)


def select_permission_adapter(context, harness_id: str) -> PermissionAdapterSelection:
    """Select permissions from a supplied operation snapshot.

    The legacy getter remains public for compatibility, but operation callers
    must use this function so no cache, probe, or replacement context can enter
    the operation midway through a stream.
    """
    from skill_hub.application.harnesses.harness_operation_context import AdapterRoute
    from skill_hub.infrastructure.harnesses import harnesses

    if context is None:
        declaration = harnesses.HARNESSES.get(harness_id)
        key = declaration.permission_adapter_key if declaration is not None else harness_id
        return PermissionAdapterSelection(
            get_adapter(key),
            AdapterRoute(harness_id, "permissions", adapter_key=key),
        )
    route = context.route(harness_id, "permissions")
    layout = context.layout(harness_id)
    if (
        layout is None or route.mode != "legacy_shadow" or route.status != "shadow"
        or route.adapter_key != layout.permission_adapter_key
        or route.harness_id != harness_id or route.feature != "permissions"
    ):
        return PermissionAdapterSelection(None, route)
    key = route.adapter_key
    adapter = get_adapter(key)
    if layout is not None and key == "claude":
        adapter = ClaudePermissionAdapter(layout=layout)
    elif key == "codex":
        adapter = CodexPermissionAdapter(layout=layout)
    elif key == "opencode":
        adapter = OpenCodePermissionAdapter(layout=layout)
    return PermissionAdapterSelection(adapter, route)


# ─────────────────────────────────────────────────────────────────────────────
# Rule simulator — "what decision would command X get?"
# ─────────────────────────────────────────────────────────────────────────────


def _command_tokens(command: str) -> list[str]:
    """Split a concrete shell command into its leading tokens for prefix matching.

    Best-effort: whitespace split is enough to match `Bash(<prefix>:*)` rules,
    whose patterns are themselves whitespace-split prefixes.
    """
    return command.strip().split()


def _bash_rule_matches_command(pattern: str, cmd_tokens: list[str]) -> Optional[int]:
    """Return the prefix length (specificity) a `Bash(...)` pattern matches the
    command with, or None when it does not apply.

    `Bash(*)` (unbounded) matches everything with specificity 0. A bounded
    prefix `Bash(git push:*)` matches `git push origin main` with specificity 2
    (it is a token-wise prefix of the command). A longer/divergent prefix does
    not match.
    """
    m = _BASH_PATTERN_RE.match(pattern.strip())
    if not m:
        return None  # non-Bash tool pattern — simulator only models Bash
    tokens = _bash_prefix_tokens(pattern)
    if tokens is None:
        # Unbounded Bash(*) (or empty) — matches any command, lowest specificity.
        inner = m.group(1).strip()
        if inner in ("*", ""):
            return 0
        return None
    if len(tokens) > len(cmd_tokens):
        return None
    if cmd_tokens[: len(tokens)] != tokens:
        return None
    return len(tokens)


def evaluate_decision(perms: NormalizedPermissions, command: str) -> str:
    """Resolve a concrete shell command against a rule set (Claude-family
    semantics) and return the effective decision: "allow" | "ask" | "deny".

    Precedence:
      * Among matching rules, the MOST SPECIFIC (longest matched prefix) wins.
      * On a specificity tie, kind precedence breaks it: deny > ask > allow.
        (A deny exception carved out of a broader allow therefore wins because
        it is more specific; an equally-specific deny still beats an allow.)
      * No matching rule → the implicit default "ask" (the harness prompts).
    """
    cmd_tokens = _command_tokens(command)
    kind_rank = {"deny": 2, "ask": 1, "allow": 0}
    best: Optional[tuple[int, int, str]] = None  # (specificity, kind_rank, kind)
    for kind, rules in (
        ("allow", perms.allow),
        ("ask", perms.ask),
        ("deny", perms.deny),
    ):
        for r in rules:
            spec = _bash_rule_matches_command(r.pattern, cmd_tokens)
            if spec is None:
                continue
            candidate = (spec, kind_rank[kind], kind)
            if best is None or candidate > best:
                best = candidate
    if best is None:
        return "ask"
    return best[2]


# ─────────────────────────────────────────────────────────────────────────────
# Test seam (reset backup session state)
# ─────────────────────────────────────────────────────────────────────────────


def _reset_backup_session_state_for_tests() -> None:
    _BACKUP_SESSION.clear()
