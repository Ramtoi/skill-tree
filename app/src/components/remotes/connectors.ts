import type { CatalogConnector, ConnectorType } from "@/types";

// ─── Static OFFLINE FALLBACK ─────────────────────────────────────────────────
// The add-remote wizard normally derives its connector cards from the LIVE
// catalog (`hub remote connectors --json` via the `remote_connectors` Tauri
// command / `useConnectorCatalog`). This hand-maintained array is the fallback
// used ONLY when the catalog is unavailable — a catalog error or degraded mode
// (Python missing). In that case the wizard renders exactly this list, so the
// Remotes screen stays usable for the built-in Hermes connector. Keep the Hermes
// entry in sync with the Python built-in so the offline UI matches the live one.
export const CONNECTOR_TYPES: ConnectorType[] = [
  { key: "headless-loadouts", label: "Headless machine", description: "Follow selected project loadouts in confirmed checkouts.",
    transport: "SSH", available: true },
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

// ─── Live-catalog derivation ─────────────────────────────────────────────────
// Transport kinds the wizard knows how to onboard. Anything else renders the
// card as CLI-only (disabled + a "configure via CLI" note) rather than guessing
// a flow (design D7 / transport-aware-onboarding spec).
export function isKnownTransport(kind: string): boolean {
	return kind === "ssh" || kind === "https";
}

/** A wizard connector card. Unlike the static `ConnectorType`, it carries the
 *  `transportKind` used to branch the onboarding step list. */
export interface WizardCard {
  deploymentKind?: "artifacts" | "project-loadouts";
	key: string;
	label: string;
	description: string;
	/** Display badge, e.g. "SSH" / "HTTPS" / "—". */
	transport: string;
	/** Whether the card is selectable (starts a wizard flow). */
	available: boolean;
	/** Flow selector: "ssh" | "https" | "" (unknown/placeholder → CLI-only). */
	transportKind: string;
}

const CLI_ONLY_NOTE =
	" · This connector uses an unsupported transport — configure it via the CLI.";

const PLACEHOLDER_CARD =
	CONNECTOR_TYPES.find((c) => c.key === "__placeholder__") ?? CONNECTOR_TYPES[0];

/** Map one live catalog entry to a wizard card. Unknown transport kinds are
 *  shown disabled with a CLI-configuration note in the description slot. */
export function catalogToCard(c: CatalogConnector): WizardCard {
	// A malformed catalog entry (non-string transport_kind over IPC) must not
	// throw in render — treat it as an unknown transport instead.
	const kind = typeof c.transport_kind === "string" ? c.transport_kind : "";
	const known = isKnownTransport(kind);
	return {
		key: c.key,
		label: c.label,
		description: known ? c.description : c.description + CLI_ONLY_NOTE,
		transport: kind ? kind.toUpperCase() : "—",
		available: c.available && known,
		transportKind: kind,
    deploymentKind: c.deployment_kind ?? "artifacts",
	};
}

/** Map a static fallback `ConnectorType` to a wizard card, recovering a known
 *  `transportKind` from its display transport ("SSH" → "ssh"). */
export function staticToCard(c: ConnectorType): WizardCard {
	const kind = c.transport.toLowerCase();
	return {
		key: c.key,
		label: c.label,
		description: c.description,
		transport: c.transport,
		available: c.available,
		transportKind: isKnownTransport(kind) ? kind : "",
    deploymentKind: c.key === "headless-loadouts" ? "project-loadouts" : "artifacts",
	};
}

/** Derive the wizard's connector cards. With a non-empty live catalog: one card
 *  per registered connector, plus the static disabled placeholder appended. On
 *  no/empty catalog (error or degraded mode): the static fallback list. */
export function deriveWizardCards(
	catalog: CatalogConnector[] | null | undefined,
): WizardCard[] {
	if (catalog && catalog.length > 0) {
		return [...catalog.map(catalogToCard), staticToCard(PLACEHOLDER_CARD)];
	}
	return CONNECTOR_TYPES.map(staticToCard);
}

/** Label lookup (`key → label`) derived from the live catalog's available
 *  connectors, falling back to the static `CONNECTOR_LABELS`. */
export function deriveConnectorLabels(
	catalog: CatalogConnector[] | null | undefined,
): Record<string, string> {
	if (catalog && catalog.length > 0) {
		return Object.fromEntries(
			catalog.filter((c) => c.available).map((c) => [c.key, c.label]),
		);
	}
	return CONNECTOR_LABELS;
}

// Optional map of documented box fingerprints, keyed by host. Any entry is
// surfaced as a hint in the TOFU step so the user can eyeball-match what
// ssh-keyscan returns; never auto-pinned. Ships empty by default.
export const KNOWN_FINGERPRINTS: Record<string, string> = {};
