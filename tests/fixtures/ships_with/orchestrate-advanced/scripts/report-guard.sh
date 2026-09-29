#!/bin/bash
# report-guard.sh -- SubagentStop hook for orchestrate-advanced (C4/C5, plans/3.md).
#
# Reads one JSON hook payload on stdin. Gated on the workspace marker exactly
# like scope-guard.sh (see there for the discovery/pointer contract, A14).
#
# First check is the role (C5): a marker with role "unit" exits 0 at once --
# the 12-line contract binds the chunk report, and a depth-3 unit neither
# writes it nor answers in that shape.
#
# For role "sub-orchestrator", refuse when either holds: the marker's
# report_path does not exist on disk, or last_assistant_message has more than
# 12 non-empty lines. Refuse: exit 0, stdout is the SubagentStop block JSON
# -- a TOP-LEVEL {"decision":"block","reason":...}, confirmed against the
# installed Claude Code's hooks reference (T0), NOT PreToolUse's nested
# hookSpecificOutput shape. Allow: exit 0, no stdout.
#
# Loop guard: each refusal increments <units>/<agent-id>.denies; at 2 the
# script allows instead of refusing a third time, and appends a note to the
# marker so a wedged unit is never held forever.
set -euo pipefail

PAYLOAD="$(cat)"

extract_str() {
  local key="$1"
  if [[ "$PAYLOAD" =~ \"$key\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

CWD="$(extract_str cwd)"
AGENT_ID="$(extract_str agent_id)"

[[ -n "$AGENT_ID" && -n "$CWD" ]] || exit 0

GITDIR="$(git -C "$CWD" rev-parse --git-dir 2>/dev/null)" || exit 0
case "$GITDIR" in
  /*) : ;;
  *) GITDIR="$CWD/$GITDIR" ;;
esac
POINTER="$GITDIR/orch-units"
[[ -f "$POINTER" ]] || exit 0
UNITS_DIR="$(cat "$POINTER" 2>/dev/null || true)"
[[ -n "$UNITS_DIR" ]] || exit 0

MARKER="$UNITS_DIR/$AGENT_ID.json"
[[ -f "$MARKER" ]] || exit 0

ROLE=""
REPORT_PATH=""
{
  IFS= read -r ROLE || true
  IFS= read -r REPORT_PATH || true
} < <(python3 -c '
import json, sys
try:
    m = json.load(open(sys.argv[1]))
except Exception:
    print("")
    print("")
    raise SystemExit
print(m.get("role") or "")
print(m.get("report_path") or "")
' "$MARKER" 2>/dev/null || true)

# C5: a depth-3 unit neither writes the 12-line report nor answers in that
# shape -- this hook is not for it, and never refuses it.
[[ "$ROLE" == "unit" ]] && exit 0
[[ "$ROLE" == "sub-orchestrator" ]] || exit 0

LAST_MSG="$(printf '%s' "$PAYLOAD" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("")
    raise SystemExit
print(d.get("last_assistant_message") or "")
' 2>/dev/null || true)"

NON_EMPTY_LINES=0
if [[ -n "$LAST_MSG" ]]; then
  NON_EMPTY_LINES="$(printf '%s\n' "$LAST_MSG" | grep -c '[^[:space:]]' || true)"
fi

DENY=0
if [[ -z "$REPORT_PATH" || ! -f "$REPORT_PATH" ]]; then
  DENY=1
elif [[ "$NON_EMPTY_LINES" -gt 12 ]]; then
  DENY=1
fi

[[ "$DENY" -eq 0 ]] && exit 0

DENY_COUNT_FILE="$UNITS_DIR/$AGENT_ID.denies"
PRIOR=0
if [[ -f "$DENY_COUNT_FILE" ]]; then
  PRIOR="$(cat "$DENY_COUNT_FILE" 2>/dev/null || echo 0)"
  [[ "$PRIOR" =~ ^[0-9]+$ ]] || PRIOR=0
fi

if [[ "$PRIOR" -ge 2 ]]; then
  python3 -c '
import json, sys
path = sys.argv[1]
try:
    m = json.load(open(path))
except Exception:
    raise SystemExit
notes = m.get("notes")
if not isinstance(notes, list):
    notes = []
notes.append("guard gave up after 2 refusals")
m["notes"] = notes
with open(path, "w") as f:
    json.dump(m, f, indent=2)
    f.write("\n")
' "$MARKER" || true
  exit 0
fi

echo $((PRIOR + 1)) > "$DENY_COUNT_FILE"

python3 -c '
import json, sys
reason = "orchestrate-advanced: write " + sys.argv[1] + " and return at most 12 lines"
print(json.dumps({"decision": "block", "reason": reason}))
' "${REPORT_PATH:-<unknown>}"
exit 0
