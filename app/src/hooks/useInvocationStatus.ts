import { useQuery } from "@tanstack/react-query";
import { hubCmd, hubStreams } from "@/lib/hubCmd";
import { errorHeadline } from "@/lib/cliOutput";
import { parseCliJson } from "@/lib/skillPack";
import { qk } from "@/lib/queryKeys";
import type { InvocationStatus } from "@/lib/invocation";

/** Read-only native outcome query. No runtime probe or sync on render. */
export function useInvocationStatus(skill: string, project?: string, enabled = true) {
  return useQuery({
    queryKey: qk.invocation(skill, project),
    enabled: enabled && Boolean(skill),
    queryFn: async () => {
      const args = ["skill", "invocation", skill, "--json"];
      if (project) args.push("--project", project);
      const result = await hubCmd(args);
      if (!result.success) {
			throw new Error(errorHeadline(hubStreams(result), "Couldn't read invocation outcomes"));
		}
      return parseCliJson<InvocationStatus>(result.output);
    },
  });
}
