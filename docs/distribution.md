# Distribution

How the `Skill Tree.app` ships, what lives where on a user's machine, and how to build it.

## Two homes

The app separates **code** from **data**:

| Home | What lives here | Resolution |
|---|---|---|
| **code_home** | `hub.py`, curated starter `skills/`, MCP server templates. Read-only on macOS due to bundle signing. | `$SKILL_HUB_CODE` env (dev) → `<App>.app/Contents/Resources/hub/` (packaged) → walk-up from `Path(__file__).parent` (dev fallback) |
| **data_home** | `registry.yaml` (with `bootstrap:` block), user-added `skills/`, `mcp-servers/`, `sources/<id>/worktree/` (external source caches), `_hub-backups/`, `.lock` | `$SKILL_HUB_HOME` → `$SKILL_HUB_DIR` (legacy, deprecated, one-shot warning) → `~/.skill-hub/` |

Both resolvers exist in both Python (`hub.py`) and Rust (`app/src-tauri/src/commands/mod.rs`) — they MUST agree about both homes.

## What ships inside the `.app` bundle

`tauri.conf.json` `bundle.resources` map:

```
hub.py            → Contents/Resources/hub/hub.py
vendor/**         → Contents/Resources/hub/vendor/   (generated; see below)
skills/**         → Contents/Resources/hub/skills/
mcp-servers/**    → Contents/Resources/hub/mcp-servers/
```

The bundled `skills/` is the **starter library** — when a user runs `hub bootstrap` they can adopt these (copy into `~/.skill-hub/skills/`) or leave them referenced read-only.

### Vendored Python dependencies

`hub.py` depends on **PyYAML** and **tomlkit** (both MIT-licensed). Rather than
require a system `pip install` on first launch (PEP 668 blocks `pip install
--user` on Homebrew/managed pythons, and a GUI app's resolved interpreter can
differ from the user's terminal one), these are **vendored into the bundle**:

- `scripts/vendor-deps.sh` populates `./vendor/` from `requirements.txt` at build
  time (wired into `tauri.conf.json` → `beforeBuildCommand`). `vendor/` is
  generated, not checked in (`.gitignore`d) — `requirements.txt` is the single
  source of truth for versions.
- The vendored copies are **pure-Python only** — `*.so` C extensions (PyYAML's
  optional `_yaml` speedup) are stripped, so one bundle is architecture-
  independent. `hub.py` uses only `safe_load`/`safe_dump`/`dump`/`YAMLError`,
  which work on the pure-Python loader.
- Each package's `LICENSE` is retained under its `*.dist-info/licenses/` (MIT's
  only redistribution obligation).
- `hub.py` prepends `vendor/` (resolved next to the file) to `sys.path` before
  `import yaml`, so a clean interpreter with no site-packages deps still runs.

### Bundled Python runtime

macOS ships **no** `python3` without the Xcode Command Line Tools, so a
downloaded `.app` on a non-developer machine would otherwise hit the full-screen
`PythonError` gate. The app therefore **ships its own CPython**:

- `scripts/fetch-python-runtime.sh` downloads a pinned, checksum-verified
  [python-build-standalone](https://github.com/astral-sh/python-build-standalone)
  `install_only_stripped` CPython for the build-target arch, trims it (stdlib
  `test/`, `idlelib/`, `tkinter/`+tcl/tk, `ensurepip/`, `turtledemo/`,
  non-interpreter `bin/` entries), ad-hoc signs the interpreter + dylibs, and
  writes `runtime-manifest.json`. Wired into `beforeBuildCommand` after
  vendor-deps. Output `python-runtime/` is `.gitignore`d — the version + SHA256
  pins in the script are the source of truth.
- `tauri.conf.json` bundles it to `Contents/Resources/python/`.
- **Interpreter resolution** (`app/src-tauri/src/commands/hub.rs`,
  `detect_python`): `SKILL_TREE_PYTHON` env override → bundled interpreter
  (`Contents/Resources/python/bin/python3`) → system `$PATH`/known dirs. A
  missing/damaged bundle falls through to the system probe, so this is purely
  additive. Resolution is cached for the process lifetime (the override is
  start-time only).
- **Validation** (`scripts/smoke-test-bundle.sh`, npm `test:bundle`): runs the
  bundled interpreter hermetically against `hub.py` (`version`, an import probe,
  `selfcheck --json`), checks the ad-hoc signature and arch, and prints the
  on-disk size (~60 MB uncompressed; ~15–25 MB added to the compressed
  download). Both install paths — `hub app build --install` and
  `scripts/rebuild-skill-tree-app.sh` — gate on it before copying to
  `/Applications`.
- **To bump the runtime**: change `PY_VERSION` / `PBS_RELEASE` / the two SHA256s
  in `fetch-python-runtime.sh` (checksums from the release's `SHA256SUMS`) and
  `EXPECT_PY_VERSION` in `smoke-test-bundle.sh`. Nothing else changes.
- **Known limitation**: hub-written MCP config entries hardcode
  `command: "python3"` (incl. the skill-hub control-plane server), so
  hub-registered MCP servers still need a system Python on the target machine.
  Making the app self-contained does not cover them — a follow-up would point
  those entries at a resolvable interpreter.
- **Quarantine / Gatekeeper** (verified behavior on Apple Silicon):
  - The bundled interpreter **must be ad-hoc signed** (the fetch script does this).
    An *unsigned* nested executable is `SIGKILL`ed on exec even after the user
    approves the app bundle — proven by test. Ad-hoc signing is load-bearing, not
    cosmetic.
  - Once the user opens the app the normal way (right-click → **Open**, which
    clears Gatekeeper's assessment on the bundle root), the ad-hoc-signed nested
    interpreter execs fine — even while it still carries its own `quarantine`
    xattr. So no *new* first-run step is introduced beyond opening the unsigned
    app itself.
  - The README's documented first-install workaround must be the **recursive**
    form — `xattr -dr com.apple.quarantine "/Applications/Skill Tree.app"`. A
    non-recursive `xattr -d` on just the `.app` leaves the nested interpreter
    quarantined; combined with a *directly* exec'd nested binary that would be a
    kill. The `-dr` form strips it everywhere.
- **Signing caveat**: the app ships unsigned. A future full code-signing effort
  (Developer ID + notarization) must sign the embedded runtime members too
  (`codesign --deep`, or sign each dylib/interpreter explicitly).

## Build & install (macOS)

```bash
hub app build --install   # Builds release, copies .app into /Applications, replaces any existing copy
hub app build             # Builds release only (artifact in app/src-tauri/target/release/bundle/macos/)
hub app dev               # Vite HMR + Tauri dev (uses repo as code_home, ~/.skill-hub/ as data_home)
```

First launch flow on a clean machine:

1. Tauri resolves `code_home()` → `<App>.app/Contents/Resources/hub/`.
2. App runs `runtime_preflight` (gate). It resolves a Python interpreter
   (searching `$PATH` then `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`,
   since Finder-launched apps get a truncated `$PATH`), checks it is ≥
   `MIN_PYTHON`, then runs the registry-free `hub selfcheck --json`. It returns
   `{ ok, reason: none|no-python|python-too-old|hub-unrunnable, detail, python }`.
   `hub-unrunnable` carries the self-check's stderr verbatim. Any non-`ok`
   result routes to the runtime-status error screen — never to the library.
3. App calls `bootstrap_check` → shells out to bundled `hub.py bootstrap --dry-run --json`.
   A failed `bootstrap_check` also routes to the error screen (not the library).
4. If runtime is healthy and no `bootstrap.completed_at` in registry →
   `BootstrapWizard` renders instead of the library.
5. Wizard surfaces:
   - Legacy data home detection (`~/Dev/.skill-hub/` → migrate)
   - Importable skills from `~/.claude/skills/`, `~/.codex/skills/`, `~/.pi/agent/skills/`
   - Conflict resolution (Skip / Replace / Register-with-suffix)
6. On "Initialize Skill Hub" the wizard runs `bootstrap_run` → migration → import → sync → write `bootstrap.completed_at`.

## Upgrade path (existing developer install)

A developer running from `~/Dev/.skill-hub/` (the legacy layout) keeps working — `data_home()` falls back to it transparently with a one-shot deprecation warning. To upgrade in place:

```bash
hub migrate-home   # Moves registry.yaml + skills/ + mcp-servers/ + _hub-backups/ into ~/.skill-hub/
                   # Rewrites source: paths, leaves LEGACY-MOVED.txt at the old location.
```

Migration is non-destructive: same-named entries at the destination are left alone (both copies remain, warning printed); cross-filesystem moves fall back from `os.replace` to `shutil.move`.

## Starter skill set

The starter library bundled into `Contents/Resources/hub/skills/` should be the smallest useful subset of the dev repo's `skills/`. Recommended initial set (subject to revision):

- `brainstorm` — multi-agent ideation
- `grill` — adversarial critique
- `skill-creator` — author new skills
- `openspec-*` — full OpenSpec workflow (11 skills)
- `frontend-design`, `webapp-testing` — web bundle
- `motion-architect` — animation planning
- `ux-screen-tests` — UX contract tests

Personal or project-specific skills (anything under a maintainer's data home, e.g. `~/.skill-hub/skills/`) should NOT be shipped — those are author-private.

## Signing & notarization

_Placeholder._ For unsigned distribution: users will see a Gatekeeper warning the first time they open the app; right-click → Open bypasses it. For signed distribution we need a Developer ID Application certificate; see `tauri-signer` docs.

## External source cache

When a user adds an external Git source, the checkout lives under
`<data_home>/sources/<source-id>/worktree/`. Each source's cache is owned and
maintained by `hub source check` / `hub source sync` / `hub source remove`.

- **Survives app updates** — the cache is user data, not bundled into the
  read-only code home.
- **Cleanup ordering** — destructive operations (remove, keep-local) only
  delete the cache **after** the registry mutation has been written
  successfully (atomic ordering per design D7). A failed registry write leaves
  the cache intact for retry.
- **Untrusted input** — repos are treated as untrusted: configured subpaths,
  discovered candidate paths, and copy destinations are normalized and
  constrained under the intended root. Absolute paths, `..` traversal, and
  symlink escapes are rejected.
- **No credentials in registry** — Git auth is via the user's SSH keys /
  credential helpers; `registry.yaml` only records `auth: system-git`.

## Lock & concurrency

`<data_home>/.lock` is acquired (POSIX `fcntl.flock` / Windows `msvcrt.locking`) for the duration of destructive operations:

- `hub migrate-home`
- `hub bootstrap` (apply phase)
- `hub project remove` (clean)
- `hub project edit-path`

The lock is process-scoped — a crashed process releases it automatically via fd close. The Tauri UI mirrors this with the Zustand `mutating` flag, disabling destructive actions until the in-flight command returns.

## Harness model & the Codex ↔ Pi shared dir

A "harness" is a coding runtime that consumes the skills Skill Hub syncs
(Claude Code, Codex, Pi — and any future entries added to `harnesses.py`).
Each harness declares its own on-disk contract: where project-local symlinks
go, where global symlinks go, and which MCP file (if any) it reads.

| Harness | Project skills dir | Global skills dir | MCP file |
|---|---|---|---|
| `claude-code` | `.claude/skills/` | `~/.claude/skills/` | `.mcp.json` |
| `codex` | `.agents/skills/` | `~/.agents/skills/` | `.codex/config.toml` `[mcp_servers.*]` |
| `pi` | `.agents/skills/` | `~/.pi/agent/skills/` | `.mcp.json` (shared with claude-code) |

Two consequences:

- **Codex and Pi share `.agents/skills/`**. Enabling one effectively populates
  the dir that the other also reads. The Skill Tree app surfaces this with a
  one-time pairing UX — when you toggle one, the other auto-enables; when you
  disable one while the other is still on, a dialog asks whether you want to
  leave the partner on (default) or disable both.
- **Pi reads `.mcp.json`** per its docs, so Skill Hub writes that file once
  per project when either claude-code or pi is in the effective set. We
  never write `.pi/mcp.json` (an optional Pi-only override the user can
  create themselves) — but we warn if it exists, since it shadows `.mcp.json`.

## Environment variable cheatsheet

| Var | Purpose | Status |
|---|---|---|
| `SKILL_HUB_HOME` | Override data_home | canonical |
| `SKILL_HUB_CODE` | Override code_home (dev) | dev-only |
| `SKILL_HUB_DIR` | Legacy data_home alias | deprecated; one-shot warning; will be removed in a follow-up change |
