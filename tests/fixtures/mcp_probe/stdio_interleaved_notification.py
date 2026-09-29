"""Fixture stdio MCP server: emits a stray `notifications/message` between a
request and its response, on BOTH `initialize` and `tools/list` — pins the
per-id JSON-RPC correlation fix (plans/G.md §5.1). A position-based reader
would read the notification as the response and misattribute everything
after it; `_read_response` must discard it and find the real one.
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
            _send({"jsonrpc": "2.0", "method": "notifications/message", "params": {"data": "noise"}})
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
            _send({"jsonrpc": "2.0", "method": "notifications/message", "params": {"data": "noise"}})
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
