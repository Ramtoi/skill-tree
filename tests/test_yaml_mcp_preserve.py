"""Comment- and format-preservation guarantees for the Hermes config.yaml edit
path (`connectors/layouts/yaml_mcp.py`).

Regression coverage for the D14-critical bug: the PyYAML *write* fallback
stripped every comment and reformatted the user's whole `config.yaml`. These
tests assert the WRITE path is a ruamel round-trip that preserves comments,
unicode (literal, not `\\uXXXX`-escaped), key order and unrelated keys — and
that the lossy PyYAML write fallback is GONE (writes fail closed without ruamel).
"""

from __future__ import annotations

import builtins

import pytest

from connectors.layouts import yaml_mcp


def _has_ruamel() -> bool:
    try:
        import ruamel.yaml  # noqa: F401

        return True
    except Exception:
        return False


requires_ruamel = pytest.mark.skipif(
    not _has_ruamel(), reason="ruamel.yaml not importable"
)


# A realistic Hermes config.yaml: >=15 comments (full-line + inline), a unicode
# block-folded scalar, skills.external_dirs: [], and an existing mcp_servers map.
FIXTURE = """\
# ============================================================
# Hermes agent configuration                         (line 1)
# DO NOT hand-edit while the gateway is running        (line 2)
# ============================================================
version: 1            # config schema version          (line 3)
model: gpt-5          # default model for the agent     (line 4)

# --- persona ------------------------------------------------ (line 5)
kawaii: >-
  hello from hermes (◕‿◕) stay shiny 🔥 keep being awesome
# the line above is intentionally unicode + block-folded (line 6)

# --- skills -------------------------------------------------- (line 7)
skills:
  # external dirs are scanned in place; in-home wins on collision (line 8)
  external_dirs: []
  # curator may add categories below                            (line 9)
  guard_agent_created: false   # agent self-edits its own tree  (line 10)

# --- mcp servers --------------------------------------------- (line 11)
mcp_servers:
  # the box's own pre-existing server — MUST survive our edits  (line 12)
  weather:
    command: weather-mcp          # binary on PATH               (line 13)
    args:
      - --units
      - metric
    env:
      WEATHER_API_KEY: "abc-123"  # do not strip these quotes    (line 14)

# --- telemetry ----------------------------------------------- (line 15)
telemetry:
  enabled: true   # keep me unchanged                            (line 16)
"""


def _count_comments(text: str) -> int:
    n = 0
    for line in text.splitlines():
        if "#" in line:
            n += 1
    return n


@requires_ruamel
def test_add_external_dir_preserves_comments_unicode_and_keys():
    before_comments = _count_comments(FIXTURE)
    assert before_comments >= 15

    new_dir = "/home/hermes/.hermes/skill-hub"
    out = yaml_mcp.merge_external_dir(FIXTURE, new_dir)

    # external_dirs gained the new entry.
    assert yaml_mcp.read_external_dirs(out) == [new_dir]

    # Comment count is unchanged; every comment line still present verbatim.
    assert _count_comments(out) == before_comments
    for line in FIXTURE.splitlines():
        if "(line " in line:  # every commented marker line survives
            assert line in out, f"lost comment line: {line!r}"

    # Unicode value byte-identical and LITERAL — never \\uXXXX-escaped.
    assert "(◕‿◕)" in out
    assert "🔥" in out
    assert "\\u" not in out

    # Unrelated keys / values are untouched.
    assert "WEATHER_API_KEY" in out
    assert '"abc-123"' in out  # quoting style preserved
    assert "telemetry" in out and "enabled: true" in out
    assert "guard_agent_created: false" in out

    # The pre-existing mcp server is fully intact.
    servers = yaml_mcp.read_mcp_servers(out)
    assert servers["weather"]["command"] == "weather-mcp"
    assert servers["weather"]["args"] == ["--units", "metric"]


@requires_ruamel
def test_add_external_dir_is_idempotent_byte_stable():
    new_dir = "/home/hermes/.hermes/skill-hub"
    once = yaml_mcp.merge_external_dir(FIXTURE, new_dir)
    twice = yaml_mcp.merge_external_dir(once, new_dir)
    assert once == twice  # re-add is a byte-stable no-op


@requires_ruamel
def test_merge_mcp_server_preserves_existing_and_comments():
    before_comments = _count_comments(FIXTURE)

    out = yaml_mcp.merge_mcp_servers(
        FIXTURE,
        upserts={
            "skill-hub-test": {
                "command": "skill-hub-mcp",
                "args": ["--stdio"],
                "env": {"HUB_TOKEN": "xyz"},
            }
        },
    )

    servers = yaml_mcp.read_mcp_servers(out)
    # New server present.
    assert servers["skill-hub-test"]["command"] == "skill-hub-mcp"
    # Existing server preserved.
    assert servers["weather"]["command"] == "weather-mcp"
    assert servers["weather"]["args"] == ["--units", "metric"]

    # Comments + unrelated keys preserved.
    assert _count_comments(out) == before_comments
    assert "telemetry" in out and "enabled: true" in out
    assert "(◕‿◕)" in out and "🔥" in out
    assert "\\u" not in out


@requires_ruamel
def test_roundtrip_no_logical_change_preserves_comments():
    # Merging an already-present external dir leaves the document byte-stable.
    new_dir = "/home/hermes/.hermes/skill-hub"
    out = yaml_mcp.merge_external_dir(FIXTURE, new_dir)
    # A second merge of the same path is a no-op → comments fully intact.
    again = yaml_mcp.merge_external_dir(out, new_dir)
    assert again == out
    assert _count_comments(again) == _count_comments(FIXTURE)


def test_write_fails_closed_without_ruamel(monkeypatch):
    """A WRITE with ruamel unimportable must RAISE, never silently strip."""
    real_import = builtins.__import__

    def _no_ruamel(name, *args, **kwargs):
        if name == "ruamel.yaml" or name.startswith("ruamel"):
            raise ImportError("simulated: ruamel.yaml unavailable")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _no_ruamel)

    with pytest.raises(yaml_mcp.YamlBackendUnavailable):
        yaml_mcp.merge_mcp_servers(FIXTURE, upserts={"x": {"command": "y"}})
    with pytest.raises(yaml_mcp.YamlBackendUnavailable):
        yaml_mcp.merge_external_dir(FIXTURE, "/home/hermes/.hermes/skill-hub")


def test_read_still_works_without_ruamel_via_pyyaml(monkeypatch):
    """Reads MAY fall back to PyYAML (no reformatting involved)."""
    real_import = builtins.__import__

    def _no_ruamel(name, *args, **kwargs):
        if name == "ruamel.yaml" or name.startswith("ruamel"):
            raise ImportError("simulated: ruamel.yaml unavailable")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _no_ruamel)

    # PyYAML is vendored, so reads still resolve.
    servers = yaml_mcp.read_mcp_servers(FIXTURE)
    assert servers["weather"]["command"] == "weather-mcp"
    assert yaml_mcp.read_external_dirs(FIXTURE) == []
