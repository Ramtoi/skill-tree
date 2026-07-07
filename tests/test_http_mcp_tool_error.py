"""Regression: http_mcp must raise on MCP tool-LEVEL errors (live-caught bug).

A gateway returns a rejected `equip_skill` (e.g. C1 signature-verify failure or a
non-allowlisted connector) as a JSON-RPC *result* carrying an error envelope
(`{code, message}` or MCP-standard `isError: true`) — NOT a JSON-RPC protocol
error and NOT a non-2xx HTTP status. The transport previously returned that
envelope as if it were a success, so the connector treated a rejected equip as
applied. call_tool MUST fail-closed on these.
"""
import json

from connectors.transport.http_mcp import (
    McpHttpTransport,
    McpHttpError,
    McpAuthError,
    HttpResponse,
)


def _runner_returning(result_obj):
    def runner(request):
        envelope = {"jsonrpc": "2.0", "id": 1, "result": result_obj}
        return HttpResponse(status=200, body=json.dumps(envelope).encode(), headers={})
    return runner


def _tx(runner):
    return McpHttpTransport(
        "https://example/mcp", token_provider=lambda: "lk_test", runner=runner
    )


def test_code_message_envelope_raises_http_error():
    tx = _tx(_runner_returning(
        {"code": "equip_signature_invalid", "message": "manifest signature failed verification"}
    ))
    try:
        tx.call_tool("equip_skill", {})
        assert False, "expected McpHttpError on a tool-error result"
    except McpHttpError as e:
        assert "signature" in str(e).lower()


def test_not_allowed_code_raises_auth_error():
    tx = _tx(_runner_returning({"code": "equip_not_allowed", "message": "connector not authorized"}))
    try:
        tx.call_tool("equip_skill", {})
        assert False, "expected McpAuthError for a not-allowed/auth code"
    except McpAuthError:
        pass


def test_mcp_isError_flag_raises():
    tx = _tx(_runner_returning(
        {"isError": True, "content": [{"type": "text", "text": "boom"}]}
    ))
    try:
        tx.call_tool("equip_skill", {})
        assert False, "expected raise on isError:true"
    except (McpHttpError, McpAuthError):
        pass


def test_success_result_still_returns_dict():
    tx = _tx(_runner_returning({"equipments": [{"name": "x", "sha256": "a" * 64}]}))
    out = tx.call_tool("list_equipments", {})
    assert out["equipments"][0]["name"] == "x"


def test_success_with_code_field_that_is_not_an_error():
    # A legit result that happens to carry a non-string `code` must NOT be
    # misread as an error envelope (guard is: string code + message).
    tx = _tx(_runner_returning({"ok": True, "code": 0}))
    out = tx.call_tool("equip_skill", {})
    assert out["ok"] is True
