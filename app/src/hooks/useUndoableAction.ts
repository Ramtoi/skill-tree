import { useCallback } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/components/Toast";

/**
 * A reversible edit expressed as a forward/inverse verb pair (ux-command-layer
 * D4). `useUndoableAction` runs `do()`, and on success pushes a success Toast
 * whose action slot runs `undo()`. The undo window is exactly the toast's
 * visible duration — there is no undo store and no multi-level stack.
 *
 * It wraps the *committed* verb pair, so it composes with change 3's optimistic
 * mutation hooks (which own cache state) rather than owning cache state itself.
 */
export interface UndoableAction<T = unknown> {
  /** Forward mutation (the verb the user asked for). */
  do: () => Promise<T>;
  /** Inverse mutation that restores the prior state. */
  undo: () => Promise<void>;
  /** Toast title, e.g. "Equipped android on rt-web". */
  label: string;
  /** Undo button label (default "Undo"). */
  undoLabel?: string;
  /** react-query keys invalidated after BOTH do() and undo(). */
  invalidate: QueryKey[];
}

export function useUndoableAction(): (a: UndoableAction) => Promise<void> {
  const toast = useToast();

  return useCallback(
    async (a: UndoableAction) => {
      const invalidateAll = async () => {
        await Promise.all(
          a.invalidate.map((key) =>
            queryClient.invalidateQueries({ queryKey: key }),
          ),
        );
      };

      // Forward. On failure the caller's own error handling (optimistic hooks)
      // surfaces the error; rethrow so the caller can react.
      await a.do();
      await invalidateAll();

      const runUndo = () => {
        void (async () => {
          try {
            await a.undo();
            await invalidateAll();
          } catch (err) {
            toast.error("Undo failed", String(err));
          }
        })();
      };

      toast.push({
        kind: "success",
        title: a.label,
        action: { label: a.undoLabel ?? "Undo", onClick: runUndo },
      });
    },
    [toast],
  );
}
