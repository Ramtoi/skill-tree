// ─── Mock stub for @tauri-apps/plugin-opener ─────────────────────────────────
// Visual-harness only (VISUAL_MOCK=1 vite alias). These are only invoked from
// user click handlers (open path / reveal in finder), so no-ops are fine — we
// only need them to not call the real Tauri IPC bridge.

export async function openPath(_path: string, _openWith?: string): Promise<void> {}
export async function revealItemInDir(_path: string): Promise<void> {}
export async function openUrl(_url: string, _openWith?: string): Promise<void> {}
