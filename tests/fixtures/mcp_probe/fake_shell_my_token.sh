#!/bin/sh
# Fixture login-shell stub: answers `-lic 'env -0'` with one NUL-delimited
# exported var, MY_TOKEN=abc — the shape `mcp_probe._snapshot_login_shell_env`
# parses. Used by the M5 login-shell-consulted/cached tests.
printf 'MY_TOKEN=abc\0'
