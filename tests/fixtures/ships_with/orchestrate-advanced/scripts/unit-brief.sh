#!/bin/bash
# unit-brief.sh -- SubagentStart hook for orchestrate-advanced (plans/3.md, A14).
#
# Reads one JSON hook payload on stdin. This is the ONE hook that CLAIMS the
# workspace marker: it reads <units>/_pending/<chunk-id>.json (there is
# exactly one pending file per chunk's units dir under normal operation),
# writes <units>/<agent-id>.json as that payload plus agent_id, agent_type,
# claimed_at, and role -- and leaves the pending file in place so the next
# agent spawned into the same chunk claims it too.
#
# `role` is set here (C5): "unit" for the five orch-{researcher,planner,
# griller,implementer,reviewer} agent types, "sub-orchestrator" for exactly
# orch-sub-orchestrator. Any OTHER agent_type (W-6) claims nothing at all --
# no marker is written -- rather than defaulting to "sub-orchestrator", which
# would make report-guard.sh hold a stop to a 12-line contract it never
# owed. Discovery/pointer contract matches scope-guard.sh (A14).
#
# It never blocks: on this event exit 2 is ignored by the harness, and this
# script always exits 0 -- any failure along the way is silent (no stdout),
# never a crash.
set -uo pipefail

PAYLOAD="$(cat)"

extract_str() {
  local key="$1"
  if [[ "$PAYLOAD" =~ \"$key\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

CWD="$(extract_str cwd)"
AGENT_ID="$(extract_str agent_id)"
AGENT_TYPE="$(extract_str agent_type)"

[[ -n "$AGENT_ID" && -n "$CWD" ]] || exit 0

GITDIR="$(git -C "$CWD" rev-parse --git-dir 2>/dev/null)"
[[ -n "$GITDIR" ]] || exit 0
case "$GITDIR" in
  /*) : ;;
  *) GITDIR="$CWD/$GITDIR" ;;
esac
POINTER="$GITDIR/orch-units"
[[ -f "$POINTER" ]] || exit 0
UNITS_DIR="$(cat "$POINTER" 2>/dev/null)"
[[ -n "$UNITS_DIR" && -d "$UNITS_DIR/_pending" ]] || exit 0

PENDING_FILE=""
for f in "$UNITS_DIR"/_pending/*.json; do
  [[ -e "$f" ]] || continue
  PENDING_FILE="$f"
  break
done
[[ -n "$PENDING_FILE" ]] || exit 0

# W-6: an agent_type outside the six orch-* names this skill ever spawns (a
# general-purpose/Explore/Plan sub-agent the harness or the sub-orchestrator
# used for something else) claims NOTHING and exits 0 with no marker written
# -- it must never default to "sub-orchestrator", which would make
# report-guard.sh refuse its stop twice over a 12-line contract it never
# owed (C5's failure mode, inverted).
case "$AGENT_TYPE" in
  orch-researcher|orch-planner|orch-griller|orch-implementer|orch-reviewer)
    ROLE="unit" ;;
  orch-sub-orchestrator)
    ROLE="sub-orchestrator" ;;
  *)
    exit 0 ;;
esac

MARKER="$UNITS_DIR/$AGENT_ID.json"
CLAIMED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

python3 -c '
import json, sys
pending_path, marker_path, agent_id, agent_type, role, claimed_at = sys.argv[1:7]
try:
    with open(pending_path) as f:
        payload = json.load(f)
except Exception:
    sys.exit(1)
payload["agent_id"] = agent_id
payload["agent_type"] = agent_type
payload["role"] = role
payload["claimed_at"] = claimed_at
with open(marker_path, "w") as f:
    json.dump(payload, f, indent=2)
    f.write("\n")
' "$PENDING_FILE" "$MARKER" "$AGENT_ID" "$AGENT_TYPE" "$ROLE" "$CLAIMED_AT"
[[ $? -eq 0 ]] || exit 0

BRIEF_PATH="$(python3 -c '
import json, sys
try:
    m = json.load(open(sys.argv[1]))
except Exception:
    print("")
    sys.exit(0)
print(m.get("brief_path") or "")
' "$MARKER" 2>/dev/null)"

BRIEF_TEXT=""
if [[ -n "$BRIEF_PATH" && -f "$BRIEF_PATH" ]]; then
  BRIEF_TEXT="$(cat "$BRIEF_PATH" 2>/dev/null)"
fi

# bash 3.2 (macOS /bin/bash) has no `mapfile` builtin -- a plain read loop
# over process substitution is the portable equivalent.
ALLOWED=()
while IFS= read -r entry; do
  ALLOWED+=("$entry")
done < <(python3 -c '
import json, sys
try:
    m = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for entry in m.get("allowed", []):
    print(entry)
' "$MARKER" 2>/dev/null)

ALLOWED_TEXT="$(printf '%s\n' "${ALLOWED[@]:-}")"

python3 -c '
import json, sys
brief_text, allowed_text = sys.argv[1], sys.argv[2]
ctx = brief_text
if allowed_text.strip():
    ctx = ctx + "\n\nAllowed files:\n" + allowed_text
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "SubagentStart",
    "additionalContext": ctx,
}}))
' "$BRIEF_TEXT" "$ALLOWED_TEXT" || true

exit 0
