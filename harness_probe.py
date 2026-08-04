"""Per-harness hook-capability probe (hooks-surface, task 1.1 / design D4).

Hooks exist per harness with very different mechanisms and availability. Before
the hooks sync stream resolves write targets it must know, for each *installed*
harness, whether hook writes will actually take effect. This module runs a cheap
probe per installed harness and yields a verdict + human-readable reason, caches
the result at ``<data_home>/state/harness-capabilities.json`` (with a ``probed_at``
timestamp), and exposes a cache reader for the UI/Tauri render path (which must
NEVER probe on render — it reads the cache only).

Verdict vocabulary (``HookCapability.verdict``):

    supported      hook writes will take effect on this harness
    feature_off    harness is installed & capable, but the hook feature is
                   explicitly disabled (e.g. codex ``[features] hooks = false``).
                   Distinct from ``unsupported`` because feature-off is a
                   transient user toggle, NOT an uninstall — written entries are
                   kept in place (design D4: "feature-off ≠ uninstall").
    unsupported    the harness fundamentally does not accept hub-managed hook
                   writes in v1 (opencode plugins, pi shim).
    not_installed  the harness is not installed on this machine (no subprocess
                   is spawned for these).

Rules (spec: harness-capability-probe):
  * claude-code — installed ⇒ ``supported``.
  * codex — prefer ``codex features list`` over version heuristics. Hooks is a
    stable, default-on feature: an ABSENT ``[features].hooks`` key means enabled;
    ``unsupported``/``feature_off`` only on an explicit ``false`` (either in
    ``config.toml`` ``[features] hooks = false`` or reported false by the CLI).
    Binary missing ⇒ ``not_installed``. A flaky probe (timeout / nonzero exit)
    fails SAFE to ``supported`` (never brick writes) while recording the
    uncertainty in the reason + ``extra.probe_failed``.
  * opencode — hook writes always ``unsupported``; the probe additionally reports
    opencode's ``lsp`` runtime state (``extra.lsp_state``) for the UI badge.
  * pi — ``unsupported`` in v1; the probe checks for a community-shim marker
    (``extra.shim``) for the badge only.

Every subprocess call is a single, timeout-bounded invocation.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import harnesses

# ─────────────────────────────────────────────────────────────────────────────
# Verdict vocabulary
# ─────────────────────────────────────────────────────────────────────────────

SUPPORTED = "supported"
FEATURE_OFF = "feature_off"
UNSUPPORTED = "unsupported"
NOT_INSTALLED = "not_installed"

VERDICTS = frozenset({SUPPORTED, FEATURE_OFF, UNSUPPORTED, NOT_INSTALLED})

# Single-call subprocess budget (seconds). Kept small — the probe runs at the
# start of every sync.
PROBE_TIMEOUT = 5

CACHE_SCHEMA_VERSION = 1


def _now_iso() -> str:
    """UTC ISO-8601 with a trailing Z (mirrors hub._now_iso)."""
    return _dt.datetime.now(tz=_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ─────────────────────────────────────────────────────────────────────────────
# Result shape
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class HookCapability:
    """One harness's probed hook capability.

    ``extra`` carries harness-specific badge data that is NOT the verdict itself:
      * opencode → ``{"lsp_state": "enabled"|"disabled"|"unknown"}``
      * pi       → ``{"shim": "detected"|"shim_not_detected"}``
      * codex    → ``{"probe_failed": true}`` when the CLI probe was inconclusive
    """

    harness_id: str
    verdict: str
    reason: str
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "harness_id": self.harness_id,
            "verdict": self.verdict,
            "reason": self.reason,
            "extra": dict(self.extra),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "HookCapability":
        return cls(
            harness_id=data.get("harness_id", ""),
            verdict=data.get("verdict", NOT_INSTALLED),
            reason=data.get("reason", ""),
            extra=dict(data.get("extra") or {}),
        )


# ─────────────────────────────────────────────────────────────────────────────
# Per-harness probes
# ─────────────────────────────────────────────────────────────────────────────


def _probe_claude_code(harness_id: str) -> HookCapability:
    # Reaching here means detection already reported it installed.
    return HookCapability(
        harness_id=harness_id,
        verdict=SUPPORTED,
        reason="Claude Code is installed; command hooks are supported.",
    )


def _parse_codex_hooks_enabled(output: str) -> Optional[bool]:
    """Parse a ``codex features list`` table for the ``hooks`` row.

    Each row is whitespace-columns: ``<name> <status…> <true|false>``. The status
    may contain spaces ("under development"), so name is the first token and the
    enabled flag is the last. Returns True/False, or None when there is no
    ``hooks`` row (feature absent from the table).
    """
    for line in output.splitlines():
        parts = line.split()
        if not parts or parts[0] != "hooks":
            continue
        last = parts[-1].strip().lower()
        if last == "true":
            return True
        if last == "false":
            return False
        return None
    return None


def _codex_config_hooks_explicitly_off(codex_home: Optional[Path]) -> bool:
    """True iff ``config.toml`` has an explicit ``[features] hooks = false``.

    Absent key / absent file / parse error ⇒ False (default-on; never brick).
    """
    base = Path(codex_home).expanduser() if codex_home else Path("~/.codex").expanduser()
    cfg = base / "config.toml"
    try:
        text = cfg.read_text()
    except OSError:
        return False
    try:
        import tomlkit

        data = tomlkit.parse(text)
    except Exception:
        return False
    features = data.get("features")
    if not isinstance(features, dict):
        return False
    if "hooks" not in features:
        return False
    return features.get("hooks") is False


def _probe_codex(
    harness_id: str,
    *,
    codex_home: Optional[Path] = None,
    binary: Optional[str] = None,
) -> HookCapability:
    resolved = binary or shutil.which("codex")
    if resolved is None:
        # Detected via config-dir marker but no runnable binary on PATH.
        return HookCapability(
            harness_id=harness_id,
            verdict=NOT_INSTALLED,
            reason="codex binary not found on PATH.",
        )

    # Explicit user disable in config.toml wins over the (default-on) CLI probe.
    if _codex_config_hooks_explicitly_off(codex_home):
        return HookCapability(
            harness_id=harness_id,
            verdict=FEATURE_OFF,
            reason="codex config.toml sets [features] hooks = false (feature disabled).",
        )

    try:
        proc = subprocess.run(
            [resolved, "features", "list"],
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT,
        )
    except FileNotFoundError:
        return HookCapability(
            harness_id=harness_id,
            verdict=NOT_INSTALLED,
            reason="codex binary not found on PATH.",
        )
    except subprocess.TimeoutExpired:
        # Fail SAFE: hooks is default-on; never brick writes on a flaky probe.
        return HookCapability(
            harness_id=harness_id,
            verdict=SUPPORTED,
            reason=(
                "`codex features list` timed out; assuming hooks enabled "
                "(stable, default-on)."
            ),
            extra={"probe_failed": True},
        )

    if proc.returncode != 0:
        return HookCapability(
            harness_id=harness_id,
            verdict=SUPPORTED,
            reason=(
                "`codex features list` exited nonzero (rc="
                f"{proc.returncode}); assuming hooks enabled (default-on)."
            ),
            extra={"probe_failed": True},
        )

    enabled = _parse_codex_hooks_enabled(proc.stdout)
    if enabled is False:
        return HookCapability(
            harness_id=harness_id,
            verdict=FEATURE_OFF,
            reason="`codex features list` reports the hooks feature disabled (false).",
        )
    if enabled is None:
        # No hooks row: treat absence as enabled (design D4: absent key = on).
        return HookCapability(
            harness_id=harness_id,
            verdict=SUPPORTED,
            reason=(
                "`codex features list` did not list a hooks row; treating as "
                "enabled (default-on)."
            ),
        )
    return HookCapability(
        harness_id=harness_id,
        verdict=SUPPORTED,
        reason="`codex features list` reports the hooks feature enabled.",
    )


def _opencode_lsp_state(config_path: Optional[Path] = None) -> str:
    """Report opencode's ``lsp`` runtime state for the badge.

    opencode's LSP integration is off by default: an absent ``lsp`` key (or an
    absent config) ⇒ ``disabled``. An unreadable/malformed config ⇒ ``unknown``.
    """
    path = (
        Path(config_path).expanduser()
        if config_path is not None
        else Path("~/.config/opencode/opencode.json").expanduser()
    )
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        return "disabled"
    except (OSError, json.JSONDecodeError):
        return "unknown"
    if not isinstance(data, dict) or "lsp" not in data:
        return "disabled"
    lsp = data["lsp"]
    if lsp is False:
        return "disabled"
    if lsp is True:
        return "enabled"
    if isinstance(lsp, dict):
        if not lsp:
            return "disabled"
        # An object of server configs: enabled unless every server is disabled.
        any_enabled = any(
            (not isinstance(v, dict)) or v.get("enabled", True) is not False
            for v in lsp.values()
        )
        return "enabled" if any_enabled else "disabled"
    return "unknown"


def _probe_opencode(
    harness_id: str, *, opencode_config: Optional[Path] = None
) -> HookCapability:
    lsp_state = _opencode_lsp_state(opencode_config)
    return HookCapability(
        harness_id=harness_id,
        verdict=UNSUPPORTED,
        reason="LSP available but off by default; plugins not hub-managed.",
        extra={"lsp_state": lsp_state},
    )


def _pi_shim_state(pi_home: Optional[Path] = None) -> str:
    """Cheaply check for a community pi-hooks shim marker (badge only)."""
    base = Path(pi_home).expanduser() if pi_home else Path("~/.pi").expanduser()
    markers = (
        base / "hooks",
        base / "agent" / "hooks",
        base / "plugins" / "pi-hooks",
    )
    for marker in markers:
        try:
            if marker.exists():
                return "detected"
        except OSError:
            continue
    return "shim_not_detected"


def _probe_pi(harness_id: str, *, pi_home: Optional[Path] = None) -> HookCapability:
    shim = _pi_shim_state(pi_home)
    return HookCapability(
        harness_id=harness_id,
        verdict=UNSUPPORTED,
        reason="pi hooks are unsupported in v1 (no native hooks; shim not hub-managed).",
        extra={"shim": shim},
    )


# ─────────────────────────────────────────────────────────────────────────────
# Orchestration + cache
# ─────────────────────────────────────────────────────────────────────────────


def probe_harness(
    harness_id: str,
    *,
    installed: Optional[set] = None,
    codex_home: Optional[Path] = None,
    codex_binary: Optional[str] = None,
    opencode_config: Optional[Path] = None,
    pi_home: Optional[Path] = None,
) -> HookCapability:
    """Probe a single harness. Uninstalled harnesses never spawn a subprocess."""
    if installed is None:
        installed = harnesses.detect_installed()
    if harness_id not in installed:
        return HookCapability(
            harness_id=harness_id,
            verdict=NOT_INSTALLED,
            reason=f"{harness_id} is not installed on this machine.",
        )
    if harness_id == "claude-code":
        return _probe_claude_code(harness_id)
    if harness_id == "codex":
        return _probe_codex(harness_id, codex_home=codex_home, binary=codex_binary)
    if harness_id == "opencode":
        return _probe_opencode(harness_id, opencode_config=opencode_config)
    if harness_id == "pi":
        return _probe_pi(harness_id, pi_home=pi_home)
    # Unknown harness id: honest unsupported, no subprocess.
    return HookCapability(
        harness_id=harness_id,
        verdict=UNSUPPORTED,
        reason=f"No hook-capability probe defined for '{harness_id}'.",
    )


def probe_all(
    harness_registry: Optional[dict] = None,
    installed: Optional[set] = None,
    *,
    codex_home: Optional[Path] = None,
    codex_binary: Optional[str] = None,
    opencode_config: Optional[Path] = None,
    pi_home: Optional[Path] = None,
) -> dict:
    """Probe every known harness; returns ``{harness_id: HookCapability}``.

    Only installed harnesses are actually probed (uninstalled ⇒ ``not_installed``
    with no subprocess). ``installed`` is detected once up front so a single
    ``detect_installed()`` covers the whole pass.
    """
    if harness_registry is None:
        harness_registry = harnesses.HARNESSES
    if installed is None:
        installed = harnesses.detect_installed()
    results: dict = {}
    for harness_id in harness_registry:
        results[harness_id] = probe_harness(
            harness_id,
            installed=installed,
            codex_home=codex_home,
            codex_binary=codex_binary,
            opencode_config=opencode_config,
            pi_home=pi_home,
        )
    return results


def capabilities_cache_path(data_home: Optional[Path] = None) -> Path:
    if data_home is None:
        import hub

        data_home = hub.data_home()
    return Path(data_home) / "state" / "harness-capabilities.json"


def save_cache(results: dict, data_home: Optional[Path] = None) -> Path:
    """Atomically write the probe results to the capability cache.

    Payload: ``{schema_version, probed_at, harnesses: {id: result-dict}}``.
    Sibling temp + ``os.replace`` so a reader never sees a half-written file.
    """
    path = capabilities_cache_path(data_home)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": CACHE_SCHEMA_VERSION,
        "probed_at": _now_iso(),
        "harnesses": {
            harness_id: cap.to_dict() for harness_id, cap in results.items()
        },
    }
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n")
    os.replace(tmp, path)
    return path


def load_cached(data_home: Optional[Path] = None) -> Optional[dict]:
    """Read the cached capability file. Returns None when missing/corrupt.

    This is the ONLY path the UI/Tauri render layer should use — it must never
    trigger a probe on render.
    """
    path = capabilities_cache_path(data_home)
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def probe_and_cache(
    data_home: Optional[Path] = None,
    harness_registry: Optional[dict] = None,
    installed: Optional[set] = None,
    **kwargs,
) -> dict:
    """Probe all harnesses and persist the cache. Returns the results map.

    Convenience for the sync stream: one call probes + refreshes the cache so
    the next render (and target resolution) sees this run's fresh verdicts.
    """
    results = probe_all(
        harness_registry=harness_registry, installed=installed, **kwargs
    )
    save_cache(results, data_home=data_home)
    return results
