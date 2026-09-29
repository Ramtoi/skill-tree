"""Fixture stdio MCP server: a "sloppy" (non-conformant) server that ERRORS
on `initialize` when asked for protocol `2025-06-18`, but succeeds when
retried with `2024-11-05` — pins the ONE-retry fallback (plans/G.md §11.2).
Answers `tools/list` normally afterward so the whole probe still reads `ok`.
"""

import json
import sys


def _send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = msg.get("method")
        req_id = msg.get("id")
        if method == "initialize":
            requested = (msg.get("params") or {}).get("protocolVersion")
            if requested == "2025-06-18":
                _send(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {"code": -32602, "message": "unsupported protocol version"},
                    }
                )
            else:
                _send(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {"protocolVersion": "2024-11-05", "capabilities": {}},
                    }
                )
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": req_id, "result": {"tools": [{"name": "tool_a"}]}})
            return


if __name__ == "__main__":
    main()
