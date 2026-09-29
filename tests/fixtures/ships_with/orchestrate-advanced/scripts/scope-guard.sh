#!/bin/bash
# scope-guard.sh -- PreToolUse hook for orchestrate-advanced (D3, plans/3.md, A8, A14).
#
# Reads one JSON hook payload on stdin. Gated on the workspace marker: with no
# claimed marker for this session's agent_id it exits 0 at once, having written
# nothing (fail-open by design -- see plans/0-direction.md R3/D3).
#
# Discovery is a pointer, not a search (W6): a git worktree's `.git` is a FILE,
# so the pointer is computed as `$(git -C <cwd> rev-parse --git-dir)/orch-units`
# (A14) -- the one call that resolves correctly for both a main checkout and a
# linked worktree.
#
# Checks, once a marker is claimed:
#   - Edit/Write/MultiEdit and codex's apply_patch: the target path(s) must
#     match an entry of the marker's `allowed` array (exact path, `dir/`
#     prefix, or glob whose `*` crosses `/` -- the same matcher confine.sh
#     uses, copied here verbatim so a hook refusal and a confine violation can
#     never disagree).
#   - Bash: `git commit|push|merge|rebase` is refused ONLY when the claimed
#     marker's `role` is `unit` (A8) -- a depth-2 orch-sub-orchestrator must
#     commit its own waves, and the human is never claimed, so neither matches.
#
# Refuse: exit 0, stdout is the PreToolUse deny JSON. Allow: exit 0, no stdout
# at all (never emit permissionDecision:"allow" -- it would silently consume
# the user's own `ask` rule, S4).
set -euo pipefail

PAYLOAD="$(cat)"

# Pure bash, no subprocess (plan step 1): pull cwd and agent_id with a plain
# regex match over the raw JSON text -- cheap enough to run on every tool call
# in every project, not just an orchestrate-advanced chunk.
extract_str() {
  local key="$1"
  if [[ "$PAYLOAD" =~ \"$key\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

CWD="$(extract_str cwd)"
AGENT_ID="$(extract_str agent_id)"

# No agent_id => the human's own session; never gated.
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
CHUNK=""
{
  IFS= read -r ROLE || true
  IFS= read -r CHUNK || true
} < <(python3 -c '
import json, sys
try:
    m = json.load(open(sys.argv[1]))
except Exception:
    print("")
    print("")
    raise SystemExit
print(m.get("role") or "")
print(m.get("chunk") or "")
' "$MARKER" 2>/dev/null || true)

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
' "$MARKER" 2>/dev/null || true)

# Same matcher confine.sh uses (scripts/confine.sh, matches()).
path_allowed() {
  local path="$1" pattern
  for pattern in "${ALLOWED[@]:-}"; do
    [[ -z "$pattern" ]] && continue
    pattern="${pattern//\*\*\//}"
    pattern="${pattern//\*\*/*}"
    [[ "$path" == "$pattern" ]] && return 0
    [[ "$pattern" == */ && "$path" == "$pattern"* ]] && return 0
    # shellcheck disable=SC2053  # unquoted on purpose: the pattern is a glob
    [[ "$path" == $pattern ]] && return 0
  done
  return 1
}

to_repo_relative() {
  local p="$1"
  case "$p" in
    "$CWD"/*) printf '%s' "${p#"$CWD"/}" ;;
    *) printf '%s' "$p" ;;
  esac
}

deny() {
  local reason="$1"
  python3 -c '
import json, sys
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": sys.argv[1],
}}))
' "$reason"
  exit 0
}

json_from_payload() {
  # $1 = python expression body reading `d` (the parsed payload dict from stdin).
  printf '%s' "$PAYLOAD" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('')
    raise SystemExit
ti = d.get('tool_input') or {}
$1
"
}

# S-5: recognizes `git commit|push|merge|rebase` regardless of global options
# before the subcommand (`-C <dir>`, `-c <k=v>`, a bare flag like
# `--no-pager`), an `env` wrapper, an absolute interpreter path
# (`/usr/bin/git`), or chaining via `&&`, `||`, or `;`. Defense in depth only
# (A8's real containment is `-s workspace-write` + `confine.sh`); prints the
# matched subcommand on a hit, prints nothing and returns 1 otherwise.
git_gatekept_subcommand() {
  local command="$1" normalized statement
  normalized="${command//&&/$'\n'}"
  normalized="${normalized//||/$'\n'}"
  normalized="${normalized//;/$'\n'}"
  while IFS= read -r statement; do
    local tokens=() idx=0 tok
    read -ra tokens <<<"$statement"
    [[ ${#tokens[@]} -eq 0 ]] && continue
    idx=0
    [[ "${tokens[0]}" == "env" ]] && idx=1
    tok="${tokens[$idx]:-}"
    [[ "$tok" == "git" || "$tok" == */git ]] || continue
    idx=$((idx + 1))
    while [[ "${tokens[$idx]:-}" == -* ]]; do
      case "${tokens[$idx]}" in
        -C|-c) idx=$((idx + 2)) ;;
        *) idx=$((idx + 1)) ;;
      esac
    done
    tok="${tokens[$idx]:-}"
    case "$tok" in
      commit|push|merge|rebase)
        printf '%s' "$tok"
        return 0
        ;;
    esac
  done <<<"$normalized"
  return 1
}

TOOL_NAME="$(json_from_payload 'print(d.get("tool_name") or "")')"

case "$TOOL_NAME" in
  Edit|Write|MultiEdit)
    RAW_PATH="$(json_from_payload 'print(ti.get("file_path") or "")')"
    [[ -n "$RAW_PATH" ]] || exit 0
    REL="$(to_repo_relative "$RAW_PATH")"
    path_allowed "$REL" || deny "orchestrate-advanced: $REL is outside chunk $CHUNK's allowed list"
    exit 0
    ;;
  apply_patch)
    COMMAND="$(json_from_payload 'print(ti.get("command") or "")')"
    PATCH_PATHS=()
    while IFS= read -r entry; do
      PATCH_PATHS+=("$entry")
    done < <(python3 -c '
import sys
markers = ("*** Update File:", "*** Add File:", "*** Delete File:")
for raw in sys.argv[1].splitlines():
    line = raw.strip()
    for marker in markers:
        if line.startswith(marker):
            path = line[len(marker):].strip()
            if path:
                print(path)
            break
' "$COMMAND")
    for p in "${PATCH_PATHS[@]:-}"; do
      [[ -z "$p" ]] && continue
      REL="$(to_repo_relative "$p")"
      path_allowed "$REL" || deny "orchestrate-advanced: $REL is outside chunk $CHUNK's allowed list"
    done
    exit 0
    ;;
  Bash)
    [[ "$ROLE" == "unit" ]] || exit 0
    COMMAND="$(json_from_payload 'print(ti.get("command") or "")')"
    GATE_HIT="$(git_gatekept_subcommand "$COMMAND")" || GATE_HIT=""
    if [[ -n "$GATE_HIT" ]]; then
      deny "orchestrate-advanced: git $GATE_HIT is reserved for the sub-orchestrator on chunk $CHUNK"
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
