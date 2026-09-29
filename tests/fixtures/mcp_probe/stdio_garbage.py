"""Fixture stdio MCP server: answers the `initialize` request with a line
that is not valid JSON — used to exercise the probe's `protocol_error` state."""

import sys

if __name__ == "__main__":
    for line in sys.stdin:
        if line.strip():
            print("this is not json", flush=True)
            break
