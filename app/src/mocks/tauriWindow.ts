// ─── Mock stub for @tauri-apps/api/window ────────────────────────────────────
// Used ONLY by the responsive-screenshot harness (vite alias gated behind
// VISUAL_MOCK=1). App.tsx calls getCurrentWindow() on mount to wire a
// fullscreen listener; outside Tauri the real module throws, so we stub the
// minimal surface the app touches: isFullscreen / onResized / setFullscreen.

type Unlisten = () => void;

function makeWindow() {
  return {
    async isFullscreen(): Promise<boolean> {
      return false;
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
