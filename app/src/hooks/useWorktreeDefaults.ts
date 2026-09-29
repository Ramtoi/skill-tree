import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hubCmd, hubStreams } from "@/lib/hubCmd";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import { parseWorktreeDefaults, type WorktreeDefaults } from "@/lib/worktreeDefaults";

async function command(args: string[]) {
  const response = await hubCmd(["project", "worktree-defaults", ...args, "--json"]);
  const reply = parseWorktreeDefaults(hubStreams(response).stdout);
  if (!response.success) throw new Error(reply.error?.message ?? "Could not save worktree defaults.");
  return reply;
}

export function useWorktreeDefaults(enabled = true) {
  return useQuery({
    enabled,
    queryKey: qk.worktreeDefaults(), queryFn: () => command(["show"]),
    retry: false, refetchOnWindowFocus: false,
  });
}

export function useSaveWorktreeDefaults() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (defaults: WorktreeDefaults) => command(["set", "--config-json", JSON.stringify(defaults)]),
    onSuccess: async (reply) => {
      client.setQueryData(qk.worktreeDefaults(), reply);
      await Promise.all([
        client.invalidateQueries({ queryKey: qk.worktreeDefaultsAll() }),
        invalidateRegistry(client),
      ]);
    },
  });
}

/** Delay typed previews and never present an older request as the current path. */
export function useWorktreePreview(name: string, path: string, defaults?: WorktreeDefaults, enabled = true) {
  const serialized = JSON.stringify({ name, path, defaults });
  const [settled, setSettled] = useState(serialized);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(serialized), 250);
    return () => clearTimeout(timer);
  }, [serialized]);
  const current = settled === serialized;
  const query = useQuery({
    queryKey: qk.worktreePreview(name, path, defaults ? JSON.stringify(defaults) : null),
    queryFn: async () => {
      const reply = await command(["preview", "--name", name, "--path", path,
        ...(defaults ? ["--config-json", JSON.stringify(defaults)] : [])]);
      if (!reply.preview || typeof reply.preview.path !== "string" ||
        typeof reply.preview.access_enabled !== "boolean") throw new Error("The backend returned no worktree preview.");
      return reply.preview;
    },
    enabled: enabled && current && !!name && !!path,
    retry: false, refetchOnWindowFocus: false,
  });
  return { ...query, current, data: current ? query.data : undefined };
}
