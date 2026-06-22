# Grill: harden-onboarding change

**Date**: 2026-06-14
**Target**: openspec/changes/harden-onboarding (proposal + design + specs + tasks) — harden first-launch onboarding error handling
**Status**: Complete — artifacts rewritten to vendor-primary architecture (validates green)

## Critiques

| # | Lens | Severity | Critique | Status |
|---|------|----------|----------|--------|
| 1 | Assumptions / Failure Modes | Critical | `tomlkit` is NOT imported at module load — onboarding only needs `yaml`. Per-dep probe over-reports `missing-deps`, could block a healthy app over a Codex-only dep. | Resolved — vendoring removes the probe; preflight no longer enumerates deps (self-check stderr instead) |
| 2 | Failure Modes / Integration | Critical | macOS GUI apps get a truncated PATH; the interpreter the app finds ≠ the user's terminal python. Fix command targets the wrong python; `no-python` false negatives; Apple stub may prompt CLT install. | Addressed — D2 GUI-correct resolution (search known locations + timeout); vendoring makes dep-state interpreter-independent so divergence only affects version |
| 3 | Failure Modes / Strategic Fit | Significant | PEP 668 "externally-managed-environment" blocks `pip install --user` on Homebrew/managed pythons — the "reliable baseline," fails on exactly the target machines. | Resolved — pip remediation dropped entirely; vendoring needs no pip/network |
| 4 | Over-Engineering / Strategic Fit | Significant | Vendoring pure-Python deps sidesteps #1/#3 entirely and is the correct PRIMARY solution, not a deferred fast-follow. Plan built the fragile path first. | Resolved — vendoring is now D1, the spine of the change |
| 5 | Hidden Complexity | Moderate | `detect_python()` calling Apple's `/usr/bin/python3` stub on a machine without CLT can trigger a blocking GUI install dialog at startup. | Addressed — D2.2 short `--version` timeout + fall-through |
| 6 | Maintenance | Moderate | Renaming/replacing `check_python` ripples into `setup.ts` mocks, `lib.rs` startup prewarm, and the invoke handler list — not called out. | Addressed — tasks 3.4 + 6.5 call out all three |
| 7 | Legal | Resolved | Vendoring third-party code — license compatibility. | Resolved — PyYAML 6.0.3 + tomlkit 0.12.0 both MIT; obligation is retaining LICENSE files (tasks 1.1, 1.5) |

## Dialogue Log

### Round 1: Opening Salvo
See conversation. Core finding: the plan's factual premise ("`hub.py` imports `yaml, tomlkit` at module load") is wrong, and its chosen primary remediation (in-app `pip --user`) is the least reliable option on the exact machines it targets, while the macOS GUI PATH problem can make the app and the user's terminal disagree about which python is even in play.

### Round 2: Pivot to vendoring
User accepted the core argument. Verified licenses (PyYAML/tomlkit both MIT) and that pure-Python `safe_load` works without the `_yaml` C extension (→ arch-independent bundle). Rewrote all four artifacts to a vendor-primary architecture:
- **D1 (spine):** vendor pure-Python deps into `code_home()/vendor/` + `sys.path.insert` shim + `bundle.resources` + LICENSE files.
- **D2:** GUI-correct interpreter resolution (search known locations, `--version` timeout).
- **D3:** preflight reduced to `no-python` / `python-too-old` / `hub-unrunnable`, the last being a generic self-check stderr passthrough (no per-dep enumeration).
- **D4:** honest gate-chain routing (the original keystone, kept).
- **D5:** runtime-status screen per reason.
- **Dropped:** the in-app `pip install` remediation entirely.

## Verdict

**Overall Assessment**: Passed the grill after a structural pivot — the rewritten change is materially more robust than the original and ready for `/opsx:apply`.

### Surviving Concerns
- App-vs-terminal interpreter divergence still possible, but now only affects *version* detection (deps are bundled) — documented as a known, shrunk surface; error screen names the resolved path.
- Two open questions remain in design.md (vendor checked-in vs generated; which entrypoint is the cheapest self-check) — both implementation-level, non-blocking.

### Improvements Made
Vendoring promoted from deferred fast-follow to the spine; eliminated the false-`tomlkit`-block regression and the PEP-668-fragile pip button; added GUI-PATH resolution and a generic self-check stderr passthrough that catches arbitrary edge cases with real messages.

### Recommendation
Proceed to `/opsx:apply`. Resolve the two design open-questions during implementation (lean: generate `vendor/` at build; reuse `hub version --json` as the self-check).

**Status**: Complete

---
