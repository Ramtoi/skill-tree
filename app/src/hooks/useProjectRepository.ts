import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hubCmd, hubStreams } from "@/lib/hubCmd";
import { invalidateRegistry } from "@/lib/invalidate";
import { qk } from "@/lib/queryKeys";
import {
  parseProjectRepository,
  projectRepositoryError,
  type ProjectRepositoryReply,
} from "@/lib/projectRepository";

async function command(args: string[], fallback: string): Promise<ProjectRepositoryReply> {
  const response = await hubCmd(["project", "repository", ...args, "--json"]);
  const reply = parseProjectRepository(hubStreams(response).stdout);
  if (!response.success || !reply.ok) throw projectRepositoryError(reply, fallback);
  return reply;
}

export function useProjectRepository(project: string, enabled = true) {
  return useQuery({
    enabled: enabled && !!project,
    queryKey: qk.projectRepository(project),
    queryFn: () => command(["show", project], "Could not read the project repository."),
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useInspectProjectRepository() {
  return useMutation({
    mutationFn: ({ project, remote }: { project: string; remote: string }) =>
      command(["inspect", project, "--remote", remote], "Could not inspect the project repository."),
  });
}

export function useSetProjectRepository() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ project, remote }: { project: string; remote: string }) =>
      command(["set", project, "--remote", remote], "Could not connect the project repository."),
    onSuccess: async (reply, variables) => {
      client.setQueryData(qk.projectRepository(variables.project), reply);
      await Promise.all([
        client.invalidateQueries({ queryKey: qk.projectRepository(variables.project) }),
        invalidateRegistry(client),
      ]);
    },
  });
}

export function useClearProjectRepository() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (project: string) =>
      command(["clear", project], "Could not disconnect the project repository."),
    onSuccess: async (reply, project) => {
      client.setQueryData(qk.projectRepository(project), reply);
      await Promise.all([
        client.invalidateQueries({ queryKey: qk.projectRepository(project) }),
        invalidateRegistry(client),
      ]);
    },
  });
}
