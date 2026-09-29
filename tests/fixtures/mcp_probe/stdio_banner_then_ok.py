"""Fixture stdio MCP server: writes a NON-JSON startup banner to stdout, then
behaves perfectly.

Pins the per-request scoping of `_LineReader.non_json_lines`. The banner is
drained as noise while waiting for `initialize`'s reply, which sets the
non-JSON counter; if that counter were cumulative for the whole probe rather
than reset by every `_read_response`, this healthy server would be reported
as `protocol_error` the moment anything later timed out — and a real server
printing a banner to stdout is common, not exotic.

Expected verdict: `ok`, two tools, and no diagnosis coloured by the banner.
"""

import json
import sys


def _send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    # The banner: not JSON at all, on stdout, before anything is asked.
    sys.stdout.write("mcp-fixture 1.2.3 starting up\n")
    sys.stdout.write("listening on stdio\n")
    sys.stdout.flush()

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
            _send(
                {
                    "jsonrpc": "2.0",
                    "id": msg.get("id"),
                    "result": {
                        "tools": [
                            {"name": "alpha", "description": "First.", "inputSchema": {}},
                            {"name": "beta", "description": "Second.", "inputSchema": {}},
                        ]
                    },
                }
            )
        else:
            _send({"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32601, "message": "no"}})


if __name__ == "__main__":
    main()
