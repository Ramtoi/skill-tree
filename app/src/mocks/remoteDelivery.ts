import type { RemoteDeliveryReply } from "@/lib/remoteDelivery";
import type { Machine } from "@/lib/headlessMachines";
const KEY = "st:mock:remote-delivery";
export function mockRemoteDelivery(args: string[]): RemoteDeliveryReply {
  const saved = localStorage.getItem(KEY);
  const reply: RemoteDeliveryReply = saved ? JSON.parse(saved) : {
    ok: true, settings: { publish_on_sync: true }, last_run: null, error: null,
  };
  if (args[2] === "set") reply.settings.publish_on_sync = args[args.indexOf("--publish-on-sync") + 1] === "true";
  if (args[2] === "run") {
    const machines = JSON.parse(localStorage.getItem("st:mock:machines") || "{}") as Record<string, Machine>;
    reply.last_run = { at: new Date().toISOString(), results: Object.values(machines).map(machine => ({
      id: machine.id,
      state: !machine.sync_enabled ? "paused" : machine.delivery?.error?.code ?? "applied",
      message: machine.sync_enabled ? machine.delivery?.error?.message ?? null : null,
    })) };
  }
  if (args[2] !== "show") localStorage.setItem(KEY, JSON.stringify(reply));
  return reply;
}
