"""Fixture stdio MCP server: answers `initialize`/`tools/list` with two tools.

Speaks the same newline-delimited JSON-RPC handshake `mcp_probe._probe_stdio`
drives: reads `initialize`, responds; reads (and ignores)
`notifications/initialized`; reads `tools/list`, responds with two tools.
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
        if method == "initialize":
            _send(
                {
                    "jsonrpc": "2.0",
                    "id": msg.get("id"),
                    "result": {"protocolVersion": "2024-11-05", "capabilities": {}},
                }
            )
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            _send(
                {
                    "jsonrpc": "2.0",
                    "id": msg.get("id"),
                    "result": {"tools": [{"name": "tool_a"}, {"name": "tool_b"}]},
                }
            )
            return


if __name__ == "__main__":
    main()
