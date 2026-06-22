# Contributing

Skill Tree is alpha, and this repository is a **published mirror** of a project
developed privately. That shapes how to get involved:

- **Issues and discussion are very welcome** — bug reports, feature ideas, and
  questions all help.
- **Pull requests are not the primary flow right now.** Development happens in a
  private upstream repository and is mirrored here on each release, so direct
  merges into this repo would be overwritten by the next publish. If you have a
  change you'd like to land, please open an issue first so we can pull it in
  upstream and credit you.

Expect the architecture to keep moving for a while.

## Prerequisites

- Python 3.11+
- Node 20+ / npm
- Rust stable (for the Tauri desktop app)

## Setup

```bash
git clone https://github.com/Ramtoi/skill-tree.git
cd skill-tree
python3 -m pip install -r requirements.txt pytest
cd app && npm ci && cd ..
python3 hub.py bootstrap     # creates ~/.skill-hub/ — safe to re-run
```

## Running tests

Both suites should be green. CI runs both on every push to `master` and every
pull request.

```bash
# Python — hub.py internals
python3 -m pytest tests/ -v

# Frontend + CLI contract — desktop app
cd app && npm run test -- --run
```

The Python suite uses a `tmp_data_home` fixture (see `tests/conftest.py`) so
no test touches your real `~/.skill-hub/`. The frontend suite mocks the Tauri
`invoke` bridge globally (see `app/src/test/setup.ts`).

## Running the app

```bash
hub app dev                  # Vite + Tauri hot reload
hub app build --install      # macOS only — copies into /Applications
```

## NOTICE and attribution

If you add a runtime dependency whose license requires attribution (e.g. some
BSD-3/MIT crates ship `NOTICE` files of their own), update the repo's
`NOTICE` file accordingly. Most JavaScript/Rust deps don't require this when
distributing source.

## Where things live

| Area | Path |
|---|---|
| CLI entry point | `hub.py` |
| Harness adapters | `harnesses.py`, `mcp_adapters.py` |
| Permissions | `permissions.py`, `permission_adapters.py`, `permission_presets.py` |
| Agent docs / snippets | `agent_docs.py`, `snippets.py` |
| Desktop app (React) | `app/src/` |
| Desktop app (Rust/Tauri) | `app/src-tauri/` |
| Python tests | `tests/` |
| Frontend tests | `app/src/test/` |
| Architecture docs | `CLAUDE.md`, `DESIGN.md`, `COMPONENTS.md`, `docs/` |
