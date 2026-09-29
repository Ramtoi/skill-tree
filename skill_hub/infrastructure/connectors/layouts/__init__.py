"""On-disk layout helpers — the formats Hub emits / reads on a remote.

- `agentskills` — a `SKILL.md` skill-directory tree (the agentskills.io format
  Hub already emits locally), with a stable content sha.
- `yaml_mcp`    — merge-preserving edits of a `mcp_servers:` mapping in a YAML
  doc (ruamel.yaml round-trip when available, PyYAML fallback otherwise).

These are generic framework helpers usable by any connector; they operate on a
provided filesystem abstraction or local paths so they are unit-testable without
a real remote (design.md §9: shared generic infra, not connector cross-import).
"""
