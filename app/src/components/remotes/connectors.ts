import type { ConnectorType } from "@/types";

// Registered connector types surfaced by the add-connector wizard. Only the
// connectors the hub framework ships are `available: true`; the single
// disabled placeholder card stands in for future/unknown types (D11). When a
// new Python connector is registered, add it here.
export const CONNECTOR_TYPES: ConnectorType[] = [
	{
		key: "hermes",
		label: "Hermes",
		description:
			"A self-improving agent box over SSH. Pushes skills, MCP servers, and SOUL/MEMORY/USER docs to a hub-owned dir — never touching the box's own skill library.",
		transport: "SSH",
		available: true,
	},
	{
		key: "__placeholder__",
		label: "More connectors",
		description:
			"MCP control-plane and worker-pool connectors land here as the framework grows.",
		transport: "—",
		available: false,
	},
];

export const CONNECTOR_LABELS: Record<string, string> = Object.fromEntries(
	CONNECTOR_TYPES.filter((c) => c.available).map((c) => [c.key, c.label]),
);

// Optional map of documented box fingerprints, keyed by host. Any entry is
// surfaced as a hint in the TOFU step so the user can eyeball-match what
// ssh-keyscan returns; never auto-pinned. Ships empty by default.
export const KNOWN_FINGERPRINTS: Record<string, string> = {};
