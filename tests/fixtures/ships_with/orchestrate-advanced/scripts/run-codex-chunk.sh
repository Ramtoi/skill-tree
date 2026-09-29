#!/bin/bash
# run-codex-chunk.sh: spawn a codex-exec chunk runner for orchestrate-advanced.
#
# Usage: run-codex-chunk.sh --worktree DIR --report FILE --model M
#          [--sandbox MODE] [--session-file FILE] -- <prompt>
#
# Exit 2 when stdin is a terminal, --worktree is not a directory, or the
# prompt is empty. Always execs `codex exec` with stdin from /dev/null (codex
# exec reads stdin even when the prompt is also given as an argument, so a
# live terminal or an inherited pipe left open stalls the run), flags in this
# fixed order:
#
#   codex exec -s <sandbox, default workspace-write> -m <model> -o <report> --json -C <worktree> -- <prompt>
#
# Streams JSONL to <report>.jsonl, extracts the first session_id/thread_id it
# sees into --session-file (default <report>.session), prints
# "session=<id> report=<file> exit=<n>".
#
# ORCH_DRY_RUN=1 prints the argv one token per line and exits 0 without
# spawning -- used by tests and by anyone auditing the exact invocation.
set -euo pipefail

usage() {
  echo "usage: run-codex-chunk.sh --worktree DIR --report FILE --model M [--sandbox MODE] [--session-file FILE] -- <prompt>" >&2
  exit 2
}

WORKTREE=""
REPORT=""
MODEL=""
SANDBOX="workspace-write"
SESSION_FILE=""

while [[ $# -gt 0 && "$1" != "--" ]]; do
  case "$1" in
    --worktree) [[ $# -ge 2 ]] || usage; WORKTREE="$2"; shift 2 ;;
    --report) [[ $# -ge 2 ]] || usage; REPORT="$2"; shift 2 ;;
    --model) [[ $# -ge 2 ]] || usage; MODEL="$2"; shift 2 ;;
    --sandbox) [[ $# -ge 2 ]] || usage; SANDBOX="$2"; shift 2 ;;
    --session-file) [[ $# -ge 2 ]] || usage; SESSION_FILE="$2"; shift 2 ;;
    --*) echo "error: unknown option $1" >&2; usage ;;
    *) usage ;;
  esac
done

[[ "${1:-}" == "--" ]] || usage
shift
PROMPT="$*"

if [[ -t 0 ]]; then
  echo "error: stdin is a terminal; codex exec always runs with stdin redirected from /dev/null -- run this script with stdin piped or redirected, not attached to a tty" >&2
  exit 2
fi

[[ -n "$WORKTREE" ]] || { echo "error: --worktree DIR is required" >&2; exit 2; }
[[ -d "$WORKTREE" ]] || { echo "error: --worktree not a directory: $WORKTREE" >&2; exit 2; }
[[ -n "$REPORT" ]] || { echo "error: --report FILE is required" >&2; exit 2; }
[[ -n "$MODEL" ]] || { echo "error: --model M is required" >&2; exit 2; }
[[ -n "$PROMPT" ]] || { echo "error: prompt must not be empty" >&2; exit 2; }

[[ -n "$SESSION_FILE" ]] || SESSION_FILE="$REPORT.session"
JSONL="$REPORT.jsonl"

ARGV=(codex exec -s "$SANDBOX" -m "$MODEL" -o "$REPORT" --json -C "$WORKTREE" -- "$PROMPT")

if [[ "${ORCH_DRY_RUN:-}" == "1" ]]; then
  printf '%s\n' "${ARGV[@]}"
  exit 0
fi

set +e
"${ARGV[@]}" < /dev/null | tee "$JSONL" | while IFS= read -r line; do
  [[ -s "$SESSION_FILE" ]] && continue
  id="$(printf '%s' "$line" | python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
sid = d.get("session_id") or d.get("thread_id")
if sid:
    print(sid)
' 2>/dev/null)"
  [[ -n "$id" ]] && printf '%s' "$id" > "$SESSION_FILE"
done
CODE="${PIPESTATUS[0]}"
set -e

SESSION_ID=""
[[ -f "$SESSION_FILE" ]] && SESSION_ID="$(cat "$SESSION_FILE")"

echo "session=$SESSION_ID report=$REPORT exit=$CODE"
exit "$CODE"
