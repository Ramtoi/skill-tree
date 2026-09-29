#!/usr/bin/env python3
"""Built-in ``lsp-report`` hook — one-shot per-language diagnostics after edits.

STDLIB-ONLY (no third-party imports) so it runs under any resolved interpreter
with zero dependencies. Invoked as a PostToolUse command hook on claude-code and
codex; the same stdin/stdout contract works on both.

Contract (hooks-surface spec builtin-lsp-hook / design D5):
  1. Read the hook payload JSON from stdin.
  2. ``--config <path>`` → load per-language ``{enabled, mode, timeout}`` config.
  3. Per-harness input resolver → the SET of edited files (claude Edit/Write/
     MultiEdit ``tool_input.file_path``; codex ``apply_patch`` envelope in
     ``tool_input.command`` with a ``git status --porcelain`` fallback).
  4. Filter to files under ``cwd``; drop vendored/generated dirs.
  5. Detect language by extension; skip languages disabled in config.
  6. Single-flight lock per ``(project, language)`` — a concurrent invocation for
     the same key SKIPS and notes the skip (never double-runs a checker).
  7. Run the one-shot checker (python: ruff [+pyright]; typescript: tsc --noEmit;
     rust: cargo check; go: gopls check — experimental, failures swallowed).
     A missing checker binary is a SILENT no-op (doctor surfaces it at sync time).
  8. Timeouts are reported honestly (never claim a clean result).
  9. Aggregate into a report capped at ~4KB (truncation stated in the text).
 10. Delivery: advisory ⇒ exit 0 + ``hookSpecificOutput.additionalContext``;
     blocking (any blocking-mode language with findings) ⇒ exit 2 + stderr,
     phrased as an interrupt the agent must address (the edit already happened).
 11. Clean ⇒ exit 0, no output.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from contextlib import contextmanager

try:
    import fcntl  # POSIX advisory locks
except ImportError:  # pragma: no cover - Windows fallback path
    fcntl = None  # type: ignore

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

REPORT_CAP = 4096  # ~4KB advisory report cap (spec)
_TRUNCATE_NOTE = "\n… [report truncated at ~4KB]"

# Extension → language. `.ts`/`.tsx` → typescript; anything else → no checker.
_EXT_LANG = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".rs": "rust",
    ".go": "go",
}

# Path segments that mark generated/vendored trees — never checked.
_VENDOR_SEGMENTS = {"node_modules", "target", "dist", ".git"}

# Per-language defaults, used when a config file is absent/unparseable so the
# script degrades to the same posture the shipped hook.yaml declares.
_DEFAULT_LANGUAGES = {
    "python": {"enabled": True, "mode": "advisory", "timeout": 30},
    "go": {"enabled": True, "mode": "advisory", "timeout": 30},
    "typescript": {"enabled": False, "mode": "advisory", "timeout": 30},
    "rust": {"enabled": False, "mode": "advisory", "timeout": 30},
}


# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────


def parse_argv_config(argv: list[str]) -> str | None:
    """Return the ``--config <path>`` value (or None if absent)."""
    for i, arg in enumerate(argv):
        if arg == "--config" and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith("--config="):
            return arg.split("=", 1)[1]
    return None


def load_config(path: str | None) -> dict:
    """Load the per-scope config JSON. Missing/unparseable ⇒ built-in defaults.

    Returns a dict with a ``languages`` map of ``{enabled, mode, timeout}``.
    """
    languages = dict(_DEFAULT_LANGUAGES)
    if path and os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError):
            data = None
        if isinstance(data, dict) and isinstance(data.get("languages"), dict):
            # Overlay configured languages over the defaults so a partial config
            # still yields a complete per-language view.
            for lang, cfg in data["languages"].items():
                if isinstance(cfg, dict):
                    base = dict(languages.get(lang, {}))
                    base.update(cfg)
                    languages[lang] = base
    return {"languages": languages}


def _lang_cfg(config: dict, language: str) -> dict:
    langs = config.get("languages") or {}
    cfg = langs.get(language) or {}
    return {
        "enabled": bool(cfg.get("enabled", False)),
        "mode": str(cfg.get("mode", "advisory")),
        "timeout": int(cfg.get("timeout", 30)) if str(cfg.get("timeout", 30)).isdigit()
        else 30,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Per-harness input resolvers
# ─────────────────────────────────────────────────────────────────────────────


def _resolve_claude_files(tool_input: dict) -> list[str]:
    """Claude-family (Edit/Write/MultiEdit): explicit ``file_path``, with a
    defensive fallback that scans string values for an existing file path."""
    files: list[str] = []
    fp = tool_input.get("file_path")
    if isinstance(fp, str) and fp:
        files.append(fp)
    if not files:
        for val in tool_input.values():
            if isinstance(val, str) and val and os.path.isfile(val):
                files.append(val)
    return files


def parse_apply_patch(command: str) -> list[str]:
    """Parse a codex ``apply_patch`` envelope, extracting every changed path.

    Handles ``*** Update File:``, ``*** Add File:`` and ``*** Delete File:`` lines
    from a ``*** Begin Patch`` / ``*** End Patch`` string. Returns [] when the
    string carries no recognizable file directive.
    """
    markers = ("*** Update File:", "*** Add File:", "*** Delete File:")
    files: list[str] = []
    for raw in command.splitlines():
        line = raw.strip()
        for marker in markers:
            if line.startswith(marker):
                path = line[len(marker):].strip()
                if path:
                    files.append(path)
                break
    return files


def _git_status_paths(cwd: str) -> list[str]:
    """Fallback: paths from ``git status --porcelain`` in ``cwd``."""
    try:
        proc = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return []
    if proc.returncode != 0:
        return []
    out: list[str] = []
    for line in proc.stdout.splitlines():
        if len(line) < 4:
            continue
        path = line[3:]
        if " -> " in path:  # rename: keep the destination
            path = path.split(" -> ", 1)[1]
        path = path.strip().strip('"')
        if path:
            out.append(path)
    return out


def _resolve_codex_files(tool_input: dict, cwd: str) -> list[str]:
    command = tool_input.get("command")
    files: list[str] = []
    if isinstance(command, str) and command:
        files = parse_apply_patch(command)
    if not files:
        files = _git_status_paths(cwd)
    return files


def resolve_edited_files(payload: dict, cwd: str) -> list[str]:
    """Resolve the raw (unfiltered) set of edited files from a hook payload."""
    tool_name = str(payload.get("tool_name") or "")
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = {}
    if tool_name in ("Edit", "Write", "MultiEdit"):
        return _resolve_claude_files(tool_input)
    if tool_name == "apply_patch":
        return _resolve_codex_files(tool_input, cwd)
    # Unknown tool: best-effort claude shape, then codex shape.
    files = _resolve_claude_files(tool_input)
    if files:
        return files
    return _resolve_codex_files(tool_input, cwd)


# ─────────────────────────────────────────────────────────────────────────────
# Path filter
# ─────────────────────────────────────────────────────────────────────────────


def filter_paths(paths: list[str], cwd: str) -> list[str]:
    """Keep only files under ``cwd`` (``..``/symlinks resolved), dropping any path
    that traverses a vendored/generated dir. De-duped, order preserved."""
    cwd_real = os.path.realpath(cwd)
    kept: list[str] = []
    seen: set[str] = set()
    for path in paths:
        absolute = path if os.path.isabs(path) else os.path.join(cwd, path)
        real = os.path.realpath(absolute)
        if real != cwd_real and not real.startswith(cwd_real + os.sep):
            continue
        rel = os.path.relpath(real, cwd_real)
        if set(rel.split(os.sep)) & _VENDOR_SEGMENTS:
            continue
        if real not in seen:
            seen.add(real)
            kept.append(real)
    return kept


def detect_language(path: str) -> str | None:
    _, ext = os.path.splitext(path)
    return _EXT_LANG.get(ext.lower())


# ─────────────────────────────────────────────────────────────────────────────
# Single-flight lock (keyed by project + language)
# ─────────────────────────────────────────────────────────────────────────────


def _lock_path(lock_dir: str, project: str, language: str) -> str:
    key = hashlib.sha1(project.encode("utf-8")).hexdigest()[:12]
    return os.path.join(lock_dir, f".lsp-report.{key}.{language}.lock")


@contextmanager
def single_flight_lock(lock_dir: str, project: str, language: str):
    """Yield True iff this invocation acquired the ``(project, language)`` lock.

    POSIX: a non-blocking ``fcntl.flock`` on a dedicated lock file. Without fcntl
    (e.g. Windows): an ``O_CREAT|O_EXCL`` create acts as the lock. A concurrent
    invocation for the same key yields False (caller SKIPS its checker).
    """
    try:
        os.makedirs(lock_dir, exist_ok=True)
    except OSError:
        # Cannot create a lock dir → proceed rather than wedge (best-effort).
        yield True
        return

    path = _lock_path(lock_dir, project, language)

    if fcntl is not None:
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        acquired = False
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except OSError:
                acquired = False
            yield acquired
        finally:
            if acquired:
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                except OSError:
                    pass
            os.close(fd)
        return

    # fcntl-less fallback: exclusive create.
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    except FileExistsError:
        yield False
        return
    try:
        yield True
    finally:
        os.close(fd)
        try:
            os.unlink(path)
        except OSError:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Checkers
# ─────────────────────────────────────────────────────────────────────────────


class LangResult:
    """Outcome of one language's checker pass."""

    __slots__ = ("language", "findings", "text", "skipped")

    def __init__(
        self,
        language: str,
        findings: bool = False,
        text: str = "",
        skipped: bool = False,
    ) -> None:
        self.language = language
        self.findings = findings  # produced diagnostics (drives blocking)
        self.text = text          # report body (may be present without findings)
        self.skipped = skipped    # lock contention / no-op


def _run(cmd: list[str], cwd: str, timeout: int):
    """Run a checker. Returns (returncode|None, output, timed_out, missing)."""
    try:
        proc = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout
        )
    except FileNotFoundError:
        return None, "", False, True
    except subprocess.TimeoutExpired:
        return None, "", True, False
    except OSError:
        return None, "", False, True
    return proc.returncode, (proc.stdout or "") + (proc.stderr or ""), False, False


def _check_python(files: list[str], cwd: str, timeout: int) -> LangResult:
    findings = False
    parts: list[str] = []
    if shutil.which("ruff"):
        rc, out, timed_out, missing = _run(
            ["ruff", "check", *files], cwd, timeout
        )
        if timed_out:
            parts.append(f"ruff timed out after {timeout}s (result unknown)")
        elif not missing and rc not in (0, None):
            findings = True
            parts.append(out.strip() or "ruff reported diagnostics")
    if shutil.which("pyright"):
        rc, out, timed_out, missing = _run(["pyright", *files], cwd, timeout)
        if timed_out:
            parts.append(f"pyright timed out after {timeout}s (result unknown)")
        elif not missing and rc not in (0, None):
            findings = True
            parts.append(out.strip() or "pyright reported diagnostics")
    return LangResult("python", findings, "\n".join(p for p in parts if p))


def _check_typescript(files: list[str], cwd: str, timeout: int) -> LangResult:
    # tsc is project-scoped: run once from cwd (it wants the whole project /
    # tsconfig), not per-file. The edited-file set only gates whether we run.
    if not shutil.which("tsc"):
        return LangResult("typescript")
    rc, out, timed_out, missing = _run(["tsc", "--noEmit"], cwd, timeout)
    if timed_out:
        return LangResult(
            "typescript", False, f"tsc timed out after {timeout}s (result unknown)"
        )
    if missing:
        return LangResult("typescript")
    if rc not in (0, None):
        return LangResult(
            "typescript", True, out.strip() or "tsc reported type errors"
        )
    return LangResult("typescript")


def _check_rust(files: list[str], cwd: str, timeout: int) -> LangResult:
    # cargo check is project-scoped: run once from cwd.
    if not shutil.which("cargo"):
        return LangResult("rust")
    rc, out, timed_out, missing = _run(
        ["cargo", "check", "--message-format=json"], cwd, timeout
    )
    if timed_out:
        return LangResult(
            "rust", False, f"cargo check timed out after {timeout}s (result unknown)"
        )
    if missing:
        return LangResult("rust")
    if rc not in (0, None):
        return LangResult(
            "rust", True, out.strip() or "cargo check reported errors"
        )
    return LangResult("rust")


def _check_go(files: list[str], cwd: str, timeout: int) -> LangResult:
    # `gopls check` is officially experimental/unsupported (design D5): failures
    # are SILENT no-ops — never block or error on a flaky/absent gopls. Only a
    # clean (rc 0) run with output is surfaced as advisory diagnostics.
    if not shutil.which("gopls"):
        return LangResult("go")
    rc, out, timed_out, missing = _run(["gopls", "check", *files], cwd, timeout)
    if timed_out or missing:
        return LangResult("go")  # swallow silently
    if rc == 0 and out.strip():
        return LangResult("go", False, out.strip())  # advisory only, never blocks
    return LangResult("go")  # non-zero / empty → swallow


_CHECKERS = {
    "python": _check_python,
    "typescript": _check_typescript,
    "rust": _check_rust,
    "go": _check_go,
}


# ─────────────────────────────────────────────────────────────────────────────
# Report assembly + delivery
# ─────────────────────────────────────────────────────────────────────────────


def build_report(results: list[LangResult], *, blocking: bool) -> str:
    sections: list[str] = []
    for res in results:
        if res.skipped:
            sections.append(
                f"[{res.language}] skipped — another {res.language} check is "
                f"already running for this project"
            )
            continue
        if res.text:
            sections.append(f"[{res.language}]\n{res.text}")
    body = "\n\n".join(sections)
    if blocking:
        header = (
            "LSP interrupt — the agent must address the diagnostics below. "
            "The edit was already applied (PostToolUse); this does not undo it."
        )
        body = f"{header}\n\n{body}" if body else header
    if len(body) > REPORT_CAP:
        body = body[: REPORT_CAP - len(_TRUNCATE_NOTE)] + _TRUNCATE_NOTE
    return body


def deliver(report: str, *, blocking: bool) -> int:
    if blocking:
        sys.stderr.write(report + "\n")
        return 2
    if report.strip():
        sys.stdout.write(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PostToolUse",
                        "additionalContext": report,
                    }
                }
            )
        )
    return 0


# ─────────────────────────────────────────────────────────────────────────────
# Orchestration
# ─────────────────────────────────────────────────────────────────────────────


def run(payload: dict, config: dict, *, lock_dir: str | None = None) -> int:
    cwd = str(payload.get("cwd") or os.getcwd())
    if lock_dir is None:
        lock_dir = _default_lock_dir(config)

    raw_files = resolve_edited_files(payload, cwd)
    files = filter_paths(raw_files, cwd)
    if not files:
        return 0  # nothing under cwd to check → clean no-op

    # Group edited files by language, skipping disabled / no-checker languages.
    by_lang: dict[str, list[str]] = {}
    for path in files:
        lang = detect_language(path)
        if lang is None or lang not in _CHECKERS:
            continue
        if not _lang_cfg(config, lang)["enabled"]:
            continue
        by_lang.setdefault(lang, []).append(path)

    if not by_lang:
        return 0  # no enabled language among the edits → clean no-op

    results: list[LangResult] = []
    blocking = False
    for lang, lang_files in by_lang.items():
        cfg = _lang_cfg(config, lang)
        with single_flight_lock(lock_dir, cwd, lang) as acquired:
            if not acquired:
                results.append(LangResult(lang, skipped=True))
                continue
            res = _CHECKERS[lang](lang_files, cwd, cfg["timeout"])
        results.append(res)
        if res.findings and cfg["mode"] == "blocking":
            blocking = True

    report = build_report(results, blocking=blocking)
    return deliver(report, blocking=blocking)


def _default_lock_dir(config: dict) -> str:
    """Locks live next to the config file when we have its path, else a temp dir
    under the user's home so concurrent invocations still coordinate."""
    path = config.get("__config_path__")
    if isinstance(path, str) and path:
        return os.path.dirname(os.path.abspath(path)) or os.getcwd()
    return os.path.join(os.path.expanduser("~"), ".skill-hub", "state", "hooks")


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    config_path = parse_argv_config(argv)
    config = load_config(config_path)
    if config_path:
        config["__config_path__"] = config_path
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0  # unreadable payload → silent no-op (never noise on stdin junk)
    if not isinstance(payload, dict):
        return 0
    return run(payload, config)


if __name__ == "__main__":
    sys.exit(main())
