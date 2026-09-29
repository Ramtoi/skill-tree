import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Registry } from "@/types";
import { qk } from "@/lib/queryKeys";
import { changePlaybook, type PlaybookOp } from "@/lib/bundlePlaybook";
import { bundleWriteLanded, errText, runRegistryWrite, type BundleCmdPayload } from "@/lib/hubWrite";
import { invalidateRegistry } from "@/lib/invalidate";
import { useToast } from "@/components/Toast";

export function useBundlePlaybook(name: string, enqueue: (write: () => Promise<void>) => Promise<void>) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState(0);

  function mutate(op: PlaybookOp, label: string, offerUndo = true): Promise<void> {
    setPending((n) => n + 1);
    return enqueue(async () => {
      const bundle = queryClient.getQueryData<Registry>(qk.registry())?.bundles[name];
      if (!bundle) throw new Error("This bundle no longer exists.");
      const { sections, inverse } = changePlaybook(bundle, op);
      if (!inverse) return;
      const setLayout = (playbook: typeof bundle.playbook) => queryClient.setQueryData<Registry>(qk.registry(), (cur) =>
        cur?.bundles[name] ? { ...cur, bundles: { ...cur.bundles, [name]: { ...cur.bundles[name], playbook } } } : cur);
      setLayout(sections);
      try {
        const { warning } = await runRegistryWrite<BundleCmdPayload>(
          ["bundle", "update", name, "--playbook", JSON.stringify(sections), "--json"], bundleWriteLanded);
        await invalidateRegistry(queryClient);
        if (warning) toast.info("Saved arrangement", warning);
        if (offerUndo) toast.push({ kind: "success", title: label, duration: 7000,
          action: { label: "Undo", onClick: () => { void mutate(inverse, "Undid arrangement", false).catch(() => {}); } } });
      } catch (error) {
        setLayout(bundle.playbook);
        throw error;
      }
    }).catch((error: unknown) => {
      toast.error("Couldn't save arrangement", errText(error));
      throw error;
    }).finally(() => setPending((n) => n - 1));
  }
  return { mutate, pending: pending > 0 };
}
