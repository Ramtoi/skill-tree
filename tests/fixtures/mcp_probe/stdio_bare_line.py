"""Fixture stdio MCP server: prints a bare non-JSON line to stdout right
before answering `tools/list` for real — pins the per-id JSON-RPC
correlation fix (plans/G.md §5.1). The stray line must be discarded as
noise, and the row must still read `ok` with the right tools — never
`protocol_error`.
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
                    "result": {"protocolVersion": "2025-06-18", "capabilities": {}},
                }
            )
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            sys.stdout.write("this is not json at all\n")
            sys.stdout.flush()
            _send(
                {
                    "jsonrpc": "2.0",
                    "id": msg.get("id"),
                    "result": {"tools": [{"name": "tool_a"}]},
                }
            )
            return


if __name__ == "__main__":
    main()
