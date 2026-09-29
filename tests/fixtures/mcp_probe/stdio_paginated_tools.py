"""Fixture stdio MCP server: paginates `tools/list` across two pages (a
`nextCursor` on page one, none on page two) — pins the catalogue's
continued-pagination path (plans/G.md §5.16). Answers `-32601` for the three
added methods so the test can focus on tools pagination alone.
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
            _send(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "serverInfo": {"name": "demo-server", "version": "1.0"},
                    },
                }
            )
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            cursor = (msg.get("params") or {}).get("cursor")
            if not cursor:
                _send(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {"tools": [{"name": "tool_a"}], "nextCursor": "page2"},
                    }
                )
            else:
                _send({"jsonrpc": "2.0", "id": req_id, "result": {"tools": [{"name": "tool_b"}]}})
        elif method in ("resources/list", "resources/templates/list", "prompts/list"):
            _send({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": "Method not found"}})


if __name__ == "__main__":
    main()
