"""Generic MCP-over-HTTPS client transport — the framework's second transport.

Parallel to `transport/ssh.py`, this is a PUBLISHABLE framework transport that
knows nothing of any specific connector. A connector hands it an endpoint URL and
a `token_provider` (a zero-arg callable that fetches the bearer token from the OS
keychain at call time) and calls `call_tool(name, args)`; the transport performs
an MCP-style JSON-RPC `tools/call` over HTTPS POST and returns the structured tool
result as a dict.

Security invariants (http-mcp-transport spec + SECURITY-AUDIT):

  * **TLS chain ALWAYS verified.** The transport builds an `ssl.create_default_context()`
    (system trust store, `check_hostname=True`, `CERT_REQUIRED`) and NEVER exposes a
    knob to disable it. An endpoint whose chain does not verify is refused — the
    `ssl.SSLCertVerificationError` is surfaced as a typed `McpHttpError` (fail-closed).
  * **Bearer token from the keychain at call time, never leaked.** The token is
    fetched via `token_provider()` immediately before each request and placed ONLY
    in the `Authorization: Bearer …` header — never in argv (there is no argv; this
    is in-process urllib), never logged, and never embedded in an exception message
    (the redactor strips any `Authorization` header before an error escapes).
  * **Injectable HTTP runner.** `runner` is a callable `(request) -> HttpResponse`;
    when injected (offline tests) the transport makes NO real network call. The
    default runner uses stdlib `urllib.request` with the verified TLS context — no
    heavy third-party HTTP dependency.

Typed errors:
  * `McpHttpError`   — transport/protocol failure (TLS, network, malformed JSON-RPC,
                       a JSON-RPC `error` object that is not specifically auth).
  * `McpAuthError`   — a 401/403 or a JSON-RPC auth error → fail-closed, distinct so
                       callers can report "authenticated=False" without retrying.

This module imports nothing from the rest of the connector package and pulls in
no optional dependency, so it stays trivially importable.
"""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

# The transport never prints a token; this header name is redacted from any
# request echo that might reach an error message.
_AUTH_HEADER = "Authorization"
_REDACTED = "<redacted>"

#: A token provider is a zero-arg callable returning the bearer token string. It
#: is invoked at call time so the secret is never held longer than one request.
TokenProvider = Callable[[], str]


class McpHttpError(RuntimeError):
    """A transport/protocol failure talking to the MCP-over-HTTPS endpoint.

    Fail-closed: any TLS verification failure, network error, non-2xx HTTP status
    (other than an auth status → `McpAuthError`), malformed JSON-RPC envelope, or
    a JSON-RPC `error` result surfaces as this (or its `McpAuthError` subclass).
    The message NEVER contains the bearer token.
    """


class McpAuthError(McpHttpError):
    """Authentication/authorization was refused (HTTP 401/403 or a JSON-RPC auth error).

    Distinct so a connector's `health_check` can report `authenticated=False`
    without treating it as an unreachable-network condition, and so the sync
    dispatch can classify it as an ALARMING failure (L1).
    """


@dataclass(frozen=True)
class HttpRequest:
    """One outbound HTTPS request the runner executes (or a test mock inspects).

    `headers` may carry the `Authorization` bearer header; tests asserting "the
    token never leaks to argv/logs" inspect `redacted_headers()` instead, and the
    transport itself only ever logs/raises through the redactor.
    """

    method: str
    url: str
    body: bytes
    headers: dict[str, str] = field(default_factory=dict)

    def redacted_headers(self) -> dict[str, str]:
        """Headers with the bearer token replaced — safe to log or echo."""
        out = dict(self.headers)
        if _AUTH_HEADER in out:
            out[_AUTH_HEADER] = _REDACTED
        return out


@dataclass(frozen=True)
class HttpResponse:
    """The runner's structured response: HTTP status + raw body bytes."""

    status: int
    body: bytes
    headers: dict[str, str] = field(default_factory=dict)


#: A runner takes an `HttpRequest` → `HttpResponse`. Injectable so offline tests
#: mock the network entirely (parallel to the SSH runner).
Runner = Callable[[HttpRequest], HttpResponse]


def _build_tls_context() -> ssl.SSLContext:
    """A default-verifying TLS context — hostname + chain checked, NEVER weakened.

    Deliberately offers NO parameter to disable verification: there is no code
    path in this transport that turns it off.
    """
    ctx = ssl.create_default_context()
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


def _default_runner(request: HttpRequest) -> HttpResponse:
    """Perform a real HTTPS request via stdlib urllib with verified TLS.

    Never invoked when a `runner` is injected (offline tests). The bearer token
    lives only in the in-process header dict — there is no subprocess and thus no
    argv exposure. Any `ssl.SSLCertVerificationError` (an unverifiable chain)
    propagates to the caller, which redacts + wraps it.
    """
    req = urllib.request.Request(
        request.url,
        data=request.body,
        headers=dict(request.headers),
        method=request.method,
    )
    ctx = _build_tls_context()
    with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:  # noqa: S310 (https enforced below)
        body = resp.read()
        status = getattr(resp, "status", resp.getcode())
        headers = {k: v for k, v in resp.getheaders()}
    return HttpResponse(status=int(status), body=body, headers=headers)


class McpHttpTransport:
    """A thin MCP-over-HTTPS JSON-RPC client.

    Usage::

        t = McpHttpTransport(endpoint, token_provider=lambda: keychain.get_secret(ref))
        result = t.call_tool("list_goals", {})

    `call_tool` issues a single JSON-RPC `tools/call` request and returns the
    tool's structured result (a dict). All security invariants live here; the
    connector is transport-agnostic above this line.
    """

    def __init__(
        self,
        endpoint: str,
        *,
        token_provider: TokenProvider,
        runner: Optional[Runner] = None,
    ):
        if not endpoint:
            raise McpHttpError("McpHttpTransport requires an endpoint URL")
        # Enforce HTTPS up front — a plaintext endpoint would ship the bearer
        # token in the clear (fail-closed: never downgrade).
        if not str(endpoint).lower().startswith("https://"):
            raise McpHttpError(
                f"refusing non-HTTPS MCP endpoint {endpoint!r}: the bearer token "
                "must never travel over plaintext"
            )
        self.endpoint = endpoint
        self._token_provider = token_provider
        self._runner = runner or _default_runner
        self._next_id = 0

    # --- public API ---------------------------------------------------------

    def call_tool(self, name: str, args: dict) -> dict:
        """Call gateway tool `name` with `args`; return its structured result dict.

        Builds an MCP `tools/call` JSON-RPC request, fetches the bearer token from
        the keychain at THIS moment via `token_provider`, POSTs over verified TLS
        (or the injected runner), and unwraps the JSON-RPC envelope. Fail-closed:
        an auth refusal raises `McpAuthError`, any other failure `McpHttpError` —
        neither message ever contains the token.
        """
        self._next_id += 1
        rpc = {
            "jsonrpc": "2.0",
            "id": self._next_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": dict(args or {})},
        }
        body = json.dumps(rpc, ensure_ascii=False).encode("utf-8")

        # Fetch the token at call time. A keychain failure is fail-closed: it
        # propagates (the caller treats it as not-authenticated) and the token is
        # never substituted by a plaintext fallback.
        token = self._token_provider()
        headers = {
            "Content-Type": "application/json",
            # MCP StreamableHttp servers require the client to accept BOTH JSON and
            # the SSE stream; sending only application/json yields HTTP 406.
            "Accept": "application/json, text/event-stream",
            _AUTH_HEADER: f"Bearer {token}",
        }
        request = HttpRequest(method="POST", url=self.endpoint, body=body, headers=headers)

        try:
            resp = self._runner(request)
        except urllib.error.HTTPError as exc:  # non-2xx surfaced as an exception
            status = getattr(exc, "code", 0)
            if status in (401, 403):
                raise McpAuthError(
                    f"MCP endpoint refused authentication (HTTP {status})"
                ) from None
            raise McpHttpError(f"MCP HTTP error (status {status})") from None
        except urllib.error.URLError as exc:
            # Includes ssl.SSLCertVerificationError (an unverifiable chain) and
            # connection failures. Redact: surface only the reason string, which
            # never contains the token (it is in the header dict, not the URL).
            reason = getattr(exc, "reason", exc)
            raise McpHttpError(f"MCP transport failure: {reason}") from None
        except McpHttpError:
            raise
        except Exception as exc:  # defensive: never let a token-bearing frame escape
            raise McpHttpError(f"MCP transport failure: {type(exc).__name__}") from None

        return self._unwrap(resp, name)

    # --- response handling --------------------------------------------------

    def _unwrap(self, resp: HttpResponse, tool: str) -> dict:
        """Validate the HTTP status + JSON-RPC envelope; return the result dict."""
        if resp.status in (401, 403):
            raise McpAuthError(
                f"MCP endpoint refused authentication (HTTP {resp.status})"
            )
        if resp.status < 200 or resp.status >= 300:
            raise McpHttpError(f"MCP HTTP error (status {resp.status})")

        try:
            envelope = json.loads(resp.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise McpHttpError(f"MCP response was not valid JSON: {exc}") from None
        if not isinstance(envelope, dict):
            raise McpHttpError("MCP response envelope was not a JSON object")

        if "error" in envelope and envelope["error"] is not None:
            err = envelope["error"]
            code = err.get("code") if isinstance(err, dict) else None
            msg = err.get("message") if isinstance(err, dict) else str(err)
            # JSON-RPC auth conventions: -32001/-32002 or an explicit auth message.
            if code in (-32001, -32002) or (
                isinstance(msg, str) and "auth" in msg.lower()
            ):
                raise McpAuthError(f"MCP tool {tool!r} refused: {msg}")
            raise McpHttpError(f"MCP tool {tool!r} returned error: {msg}")

        result = envelope.get("result")
        coerced = self._coerce_result(result)
        # MCP tool-LEVEL error (distinct from a JSON-RPC protocol error above):
        # either the MCP-standard `isError: true`, or this gateway's
        # `{code, message}` error envelope. These MUST raise — otherwise the
        # connector treats a REJECTED call (e.g. an equip whose signature failed
        # C1 verification, or a non-allowlisted connector) as success and updates
        # its sidecar as if applied.
        is_err = isinstance(result, dict) and result.get("isError") is True
        code = coerced.get("code") if isinstance(coerced, dict) else None
        if is_err or (isinstance(code, str) and "message" in coerced):
            msg = str(coerced.get("message") or coerced.get("text") or code or "tool error")
            blob = f"{code or ''} {msg}".lower()
            if any(k in blob for k in ("auth", "not_allowed", "forbidden", "unauthor")):
                raise McpAuthError(f"MCP tool {tool!r} refused: {msg}")
            raise McpHttpError(f"MCP tool {tool!r} returned error: {msg}")
        return coerced

    @staticmethod
    def _coerce_result(result: Any) -> dict:
        """Normalize an MCP tool result into a plain dict.

        MCP tool results commonly arrive as `{"content": [{"type": "text",
        "text": "<json>"}], "structuredContent": {...}}`. Prefer
        `structuredContent` when present; else parse a single text content block
        as JSON; else return `{}` for an empty/None result. A bare dict result
        (a simplified gateway) is returned as-is.
        """
        if result is None:
            return {}
        if isinstance(result, dict):
            if isinstance(result.get("structuredContent"), dict):
                return result["structuredContent"]
            content = result.get("content")
            if isinstance(content, list) and content:
                block = content[0]
                if isinstance(block, dict) and "text" in block:
                    try:
                        parsed = json.loads(block["text"])
                        if isinstance(parsed, dict):
                            return parsed
                        return {"value": parsed}
                    except (json.JSONDecodeError, TypeError):
                        return {"text": block["text"]}
            # A plain structured dict with no MCP wrapper → return as-is.
            if "content" not in result and "structuredContent" not in result:
                return result
            return {}
        # A non-dict result (list/scalar) — wrap so callers always get a dict.
        return {"value": result}


def is_https(endpoint: str) -> bool:
    """True iff `endpoint` is an https:// URL (a cheap pre-check for the CLI)."""
    return str(endpoint or "").lower().startswith("https://")
