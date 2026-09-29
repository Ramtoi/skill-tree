"""Fixture stdio MCP server: answers `tools/list` with one tool, then
answers JSON-RPC `-32601` (Method not found) for all three ADDED catalogue
methods — pins the "optimistic probing, not capability gating" rule
(plans/G.md §5.4): `-32601` must read as `offered: false`, never a
`fetch_errors` entry. Keeps running (does not exit after `tools/list`) so
the catalogue phase can reach it.
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
                        "serverInfo": {"name": "demo-server", "version": "1.2.3"},
                    },
                }
            )
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            _send(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "tools": [
                            {
                                "name": "tool_a",
                                "description": "does a thing",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {"x": {"type": "string"}},
                                },
                            }
                        ]
                    },
                }
            )
        elif method in ("resources/list", "resources/templates/list", "prompts/list"):
            _send({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": "Method not found"}})


if __name__ == "__main__":
    main()
