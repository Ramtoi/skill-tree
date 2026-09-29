import { hubCmd, hubStreams } from "./hubCmd";
import { parseCliJson } from "./skillPack";

export interface DeliveryRun {
  at: string;
  results: { id: string; state: string; message: string | null }[];
}
export interface RemoteDeliveryReply {
  ok: boolean;
  settings: { publish_on_sync: boolean };
  last_run: DeliveryRun | null;
  error: { code: string; message: string } | null;
}

export async function remoteDeliveryCommand(args: string[]): Promise<RemoteDeliveryReply> {
  const result = await hubCmd(["remote", "delivery", ...args, "--json"]);
  const reply = parseCliJson<RemoteDeliveryReply>(hubStreams(result).stdout);
  if (!result.success || !reply.ok) throw new Error(reply.error?.message ?? "Could not update remote delivery.");
  if (typeof reply.settings?.publish_on_sync !== "boolean" ||
    (reply.last_run !== null && (typeof reply.last_run?.at !== "string" || !Array.isArray(reply.last_run.results) ||
      !reply.last_run.results.every(row => typeof row.id === "string" && typeof row.state === "string" &&
        (row.message === null || typeof row.message === "string"))))) {
    throw new Error("The backend returned invalid delivery settings.");
  }
  return reply;
}
