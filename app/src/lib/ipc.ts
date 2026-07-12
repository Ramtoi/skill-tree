// ─── Canonical Tauri IPC wrapper ─────────────────────────────────────────────
// The ONE place the app talks to the Tauri command bridge. It wraps the real
// `@tauri-apps/api/core` `invoke` and maintains a global in-flight counter in
// the Zustand store so the StatusBar can surface a subtle activity indicator
// whenever ANY command is pending (the UI can finally paint during long ops —
// see openspec/changes/ui-responsiveness M4).
//
// Every other frontend module MUST import `invoke` from here, never from
// `@tauri-apps/api/core` directly. This is the sanctioned exception and is
// enforced by `src/test/ipcImportGuard.test.ts` (which allowlists exactly this
// file, plus `src/test/**` and `src/mocks/**`).
//
// Call signature is identical to the real `invoke` — this is a drop-in.
//
// eslint-disable-next-line no-restricted-imports -- this module IS the wrapper
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";

/** Wrapped `invoke`. Increments the in-flight counter before the call and
 *  decrements it once the promise settles (resolve OR reject). Declared as a
 *  hoisted `function` so the store↔ipc import cycle stays safe. */
export function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  useAppStore.getState().beginInFlight();
  // `Promise.resolve(...)` normalizes the return (the real `invoke` is always a
  // promise; test mocks sometimes return a plain value) so `.finally` is safe;
  // the try/catch guarantees the counter is decremented even on a sync throw.
  let pending: Promise<T>;
  try {
    // Preserve call arity — forward the 2nd arg only when the caller passed one
    // (so `invoke("cmd")` stays a single-arg call, matching mock assertions and
    // the real bridge's own default handling).
    pending = Promise.resolve(
      args === undefined ? tauriInvoke<T>(cmd) : tauriInvoke<T>(cmd, args),
    );
  } catch (err) {
    useAppStore.getState().endInFlight();
    return Promise.reject(err);
  }
  return pending.finally(() => {
    useAppStore.getState().endInFlight();
  });
}
