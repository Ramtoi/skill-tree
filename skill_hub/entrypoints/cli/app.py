"""`hub app` / `hub dashboard` — Skill Tree native app dev/build shortcuts.

Thin wrappers around the Tauri toolchain (`npm run tauri dev|build`) plus the
macOS `/Applications` install step. Carved out of `hub.py` (S5 slice — see
`hub_cli/__init__.py` for the module contract this file implements (`NAME`,
`register`, `dispatch`).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

from skill_hub import hub_core
from skill_hub.hub_core import (
    BOLD,
    DIM,
    GREEN,
    RED,
    YELLOW,
    c,
)

NAME = "app"

p_app = None


def register(sub) -> None:
    global p_app

    # app
    p_app = sub.add_parser("app", help="Skill Tree app development/build shortcuts")
    app_sub = p_app.add_subparsers(dest="app_cmd")
    app_sub.required = True
    app_sub.add_parser("dev", help="Run Skill Tree in Tauri dev mode")
    p_app_build = app_sub.add_parser(
        "build", help="Build the production Skill Tree app"
    )
    p_app_build.add_argument(
        "--install",
        action="store_true",
        help="On macOS, copy the built app to /Applications",
    )
    p_app_build.add_argument(
        "--no-updater",
        action="store_true",
        help="Skip signed updater artifacts (auto-skipped when "
        "TAURI_SIGNING_PRIVATE_KEY is unset; use for local installs)",
    )


def dispatch(args) -> None:
    if args.app_cmd == "dev":
        cmd_app_dev(args)
    elif args.app_cmd == "build":
        cmd_app_build(args)


# ─────────────────────────────────────────────────────────────────────────────
# hub dashboard
# ─────────────────────────────────────────────────────────────────────────────


def _app_dir() -> Path:
    """Dev-mode app source dir (lives alongside hub.py in the repo checkout)."""
    return hub_core.code_home() / "app"


def _app_env() -> dict[str, str]:
    """Env for subprocesses (Tauri dev/build). Pass both data home and code home."""
    env = {
        **os.environ,
        "SKILL_HUB_HOME": str(hub_core.data_home()),
        "SKILL_HUB_CODE": str(hub_core.code_home()),
    }
    # Drop legacy var so subprocesses do not pick it up
    env.pop("SKILL_HUB_DIR", None)
    return env


def _find_app_binary() -> Optional[Path]:
    app_dir = _app_dir()
    import platform

    system = platform.system()
    if system == "Darwin":
        binary_candidates = [
            app_dir
            / "src-tauri"
            / "target"
            / "release"
            / "Skill Tree.app"
            / "Contents"
            / "MacOS"
            / "Skill Tree",
            app_dir
            / "src-tauri"
            / "target"
            / "debug"
            / "Skill Tree.app"
            / "Contents"
            / "MacOS"
            / "Skill Tree",
            app_dir / "src-tauri" / "target" / "release" / "skill-tree",
            app_dir / "src-tauri" / "target" / "debug" / "skill-tree",
        ]
    elif system == "Windows":
        binary_candidates = [
            app_dir / "src-tauri" / "target" / "release" / "Skill Tree.exe",
            app_dir / "src-tauri" / "target" / "debug" / "Skill Tree.exe",
        ]
    else:
        binary_candidates = [
            app_dir / "src-tauri" / "target" / "release" / "skill-tree",
            app_dir / "src-tauri" / "target" / "debug" / "skill-tree",
        ]
    return next((p for p in binary_candidates if p.exists()), None)


def cmd_app_dev(_args):
    app_dir = _app_dir()
    print(f"{c('Starting Skill Tree in dev mode', BOLD)} (Vite HMR + Tauri)")
    try:
        subprocess.run(
            ["npm", "run", "tauri", "dev"],
            cwd=str(app_dir),
            env=_app_env(),
        )
    except KeyboardInterrupt:
        print("\nDev server stopped.")


def cmd_app_build(args):
    app_dir = _app_dir()
    print(f"{c('Building Skill Tree production app', BOLD)}")
    cmd = ["npm", "run", "tauri", "build"]
    # Updater artifacts (`.app.tar.gz` + `.sig`) must be SIGNED, which requires
    # TAURI_SIGNING_PRIVATE_KEY (set in CI). For a local build/install that key
    # is absent and `tauri build` aborts after bundling the .app — breaking
    # `hub app build --install`. When the key is missing, build WITHOUT updater
    # artifacts so the local install succeeds; CI (with the key) still produces
    # the signed updater payload. Pass `--no-updater` to force-skip explicitly.
    no_updater = getattr(args, "no_updater", False) or not os.environ.get(
        "TAURI_SIGNING_PRIVATE_KEY"
    )
    if no_updater:
        print(
            f"{c('·', DIM)} no TAURI_SIGNING_PRIVATE_KEY — building without "
            "updater artifacts (fine for local install)"
        )
        cmd += ["--", "--config", '{"bundle":{"createUpdaterArtifacts":false}}']
    subprocess.run(
        cmd,
        cwd=str(app_dir),
        env=_app_env(),
        check=True,
    )

    if getattr(args, "install", False):
        import platform

        if platform.system() != "Darwin":
            print(f"{c('Install step currently supported on macOS only.', YELLOW)}")
            return
        built_app = (
            app_dir
            / "src-tauri"
            / "target"
            / "release"
            / "bundle"
            / "macos"
            / "Skill Tree.app"
        )
        installed_app = Path("/Applications/Skill Tree.app")
        if not built_app.exists():
            print(f"{c('Built app bundle not found after build.', RED)}")
            sys.exit(1)
        # Gate the install on the bundled-Python smoke test — never copy an
        # unvalidated .app to /Applications (an over-trimmed or unsigned runtime
        # would brick the app on a machine with no system Python).
        smoke = hub_core.code_home() / "scripts" / "smoke-test-bundle.sh"
        if smoke.exists():
            print(f"{c('Validating bundled Python runtime', BOLD)}")
            result = subprocess.run(
                ["bash", str(smoke), str(built_app)],
                check=False,
            )
            if result.returncode != 0:
                print(
                    f"{c('Bundle smoke test failed — refusing to install.', RED)}"
                )
                sys.exit(1)
        if installed_app.exists():
            shutil.rmtree(installed_app)
        shutil.copytree(built_app, installed_app)
        print(f"{c('Installed updated app to /Applications/Skill Tree.app', GREEN)}")


def cmd_dashboard(args):
    if getattr(args, "dev", False):
        cmd_app_dev(args)
        return

    binary = _find_app_binary()

    if binary is None:
        app_dir = _app_dir()
        print(f"{c('Skill Tree binary not found.', BOLD)}")
        print("Build it first with:")
        print("  hub app build")
        print("Or build + install on macOS with:")
        print("  hub app build --install")
        print("Or launch in dev mode with:")
        print("  hub app dev")
        print(f"  (manual equivalent: cd {app_dir} && npm run tauri build)")
        sys.exit(1)

    try:
        subprocess.run([str(binary)], env=_app_env())
    except KeyboardInterrupt:
        pass
