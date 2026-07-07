import { useEffect, useRef } from "react";
import { useAppStore } from "@/store";
import type { KeyBinding, KeymapCtx } from "@/lib/keymap";

/** ~1.2s window to complete a two-key chord before the prefix is dropped. */
export const CHORD_TIMEOUT_MS = 1200;

function isTypingContext(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    el.isContentEditable ||
    el.getAttribute("role") === "textbox"
  );
}

/**
 * The single chord handler (ux-command-layer D2). Installs one window keydown
 * listener implementing an idle → pending(prefix) → dispatch/cancel state
 * machine over `KEYMAP`. Honors the typing guard (`when` default
 * `"not-typing"`), a ~1.2s pending timeout, case-sensitive second keys
 * (`⇧p` vs `p`), and surfaces the pending prefix on the shared store for the
 * StatusBar indicator + aria-live region.
 */
export function useChords(keymap: KeyBinding[], ctx: KeymapCtx) {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const setChordPending = useAppStore.getState().setChordPending;

    const clearPending = () => {
      pendingRef.current = null;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      setChordPending(null);
    };

    const armPending = (prefix: string) => {
      pendingRef.current = prefix;
      setChordPending(prefix);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(clearPending, CHORD_TIMEOUT_MS);
    };

    const allowedWhileTyping = (b: KeyBinding) => b.when === "always";

    function onKey(e: KeyboardEvent) {
      // While the first-run tips tour is open the page stays interactive, but
      // its own coach-mark keys own the keyboard — never dispatch a chord (`g l`,
      // `?`, `c s`, …) underneath it. Mirror how single-key handlers gate on
      // `paletteOpen`. TipsTour captures Arrow/Enter/Esc itself; this covers the
      // rest so nothing leaks into the chord state machine.
      if (useAppStore.getState().tipsOpen) {
        if (pendingRef.current) clearPending();
        return;
      }
      // A lone modifier keydown (Shift held to type the second key of a
      // shift-qualified chord like `g ⇧p`) must NOT cancel a pending prefix.
      if (
        e.key === "Shift" ||
        e.key === "Control" ||
        e.key === "Alt" ||
        e.key === "Meta"
      ) {
        return;
      }
      // Modifier chords (⌘K, ⌘S, …) are owned by App.tsx/screens — never ours.
      if (e.metaKey || e.ctrlKey || e.altKey) {
        clearPending();
        return;
      }
      const typing = isTypingContext();

      // ── Pending: this is the second key of a chord ──
      if (pendingRef.current) {
        const prefix = pendingRef.current;
        const match = keymap.find(
          (b) => b.keys.length === 2 && b.keys[0] === prefix && b.keys[1] === e.key,
        );
        clearPending();
        if (match && (!typing || allowedWhileTyping(match))) {
          e.preventDefault();
          match.run(ctxRef.current);
        } else {
          // No match: swallow the stray second key, do not re-dispatch it.
          e.preventDefault();
        }
        return;
      }

      // ── Idle: single-key bindings dispatch immediately ──
      const single = keymap.find(
        (b) => b.keys.length === 1 && b.keys[0] === e.key,
      );
      if (single && (!typing || allowedWhileTyping(single))) {
        e.preventDefault();
        single.run(ctxRef.current);
        return;
      }

      // ── Idle: does this key begin a multi-key chord? ──
      const prefixBindings = keymap.filter(
        (b) => b.keys.length > 1 && b.keys[0] === e.key,
      );
      if (prefixBindings.length > 0) {
        // Prefix keys inherit the (default) not-typing guard.
        const anyAllowed = prefixBindings.some(
          (b) => !typing || allowedWhileTyping(b),
        );
        if (!anyAllowed) return;
        e.preventDefault();
        armPending(e.key);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // keymap is a module constant; ctx is read via ctxRef so the listener is stable.
  }, [keymap]);
}
