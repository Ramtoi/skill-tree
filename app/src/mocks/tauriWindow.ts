// ─── Mock stub for @tauri-apps/api/window ────────────────────────────────────
// Used ONLY by the responsive-screenshot harness (vite alias gated behind
// VISUAL_MOCK=1). App.tsx calls getCurrentWindow() on mount to wire a
// fullscreen listener; outside Tauri the real module throws, so we stub the
// minimal surface the app touches: isFullscreen / onResized / setFullscreen.

import { sceneFlag } from "./scenes";

type Unlisten = () => void;

/** Scene opt-in via the typed registry in `./scenes` (e.g.
 *  `/?fullscreen=1#/hooks`). macOS fullscreen is a real layout mode — the
 *  traffic lights auto-hide and the header band changes shape — and it was
 *  previously unreachable from the harness, so every rendered frame was
 *  windowed. */
function sceneFullscreen(): boolean {
  return sceneFlag("fullscreen");
}

function makeWindow() {
  return {
    async isFullscreen(): Promise<boolean> {
      return sceneFullscreen();
    },
    async setFullscreen(_v: boolean): Promise<void> {
      /* no-op in the visual harness */
    },
    async onResized(_cb: (e: unknown) => void): Promise<Unlisten> {
      return () => {};
    },
    async onMoved(_cb: (e: unknown) => void): Promise<Unlisten> {
      return () => {};
    },
    async listen(_event: string, _cb: (e: unknown) => void): Promise<Unlisten> {
      return () => {};
    },
    async once(_event: string, _cb: (e: unknown) => void): Promise<Unlisten> {
      return () => {};
    },
    async emit(_event: string, _payload?: unknown): Promise<void> {},
    async theme(): Promise<string> {
      return "dark";
    },
    async scaleFactor(): Promise<number> {
      return 2;
    },
  };
}

export function getCurrentWindow() {
  return makeWindow();
}

export function getCurrent() {
  return makeWindow();
}

// `WebviewWindow` is occasionally referenced; provide a no-op-ish shim.
export class WebviewWindow {
  label: string;
  constructor(label: string) {
    this.label = label;
  }
}
