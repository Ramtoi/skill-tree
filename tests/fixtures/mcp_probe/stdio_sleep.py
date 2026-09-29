"""Fixture stdio MCP server: never answers anything — used to exercise the
probe's wall-clock timeout (and the finally-block kill/reap)."""

import time

if __name__ == "__main__":
    time.sleep(30)
