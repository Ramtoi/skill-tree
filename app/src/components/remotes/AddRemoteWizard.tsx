import { useMemo, useRef, useState } from "react";
import { invoke } from "@/lib/ipc";

import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Sheet } from "@/components/Modal";
import { Toggle } from "@/components/Toggle";
import { useToast } from "@/components/Toast";
import { useAppStore } from "@/store";
import { useConnectorCatalog } from "@/hooks/useConnectorCatalog";
import type { HubResult, RemoteDiffPlan } from "@/types";
import {
	deriveWizardCards,
	KNOWN_FINGERPRINTS,
	type WizardCard,
} from "./connectors";

interface Props {
	onClose: () => void;
	onCreated: (id: string) => void;
}

// Step identity is a KEY, not a number: the concrete step list is computed from
// the selected connector's transport kind (transport-aware-onboarding). SSH keeps
// today's 5-step TOFU flow byte-for-byte; HTTPS collapses the host-key steps into
// a single endpoint+token step.
type StepKey =
	| "connector"
	| "endpoint"
	| "hostkey"
	| "credentials"
	| "endpoint-token"
	| "health";

/** Compute the ordered step list for a transport kind. Unknown/absent kinds fall
 *  back to the SSH flow (the pre-selection default, so the counter reads "/ 5"
 *  before a connector is picked — unknown-transport connectors are never
 *  selectable, so this branch only ever renders as SSH or HTTPS). */
function stepsFor(transportKind: string): StepKey[] {
	if (transportKind === "https") {
		return ["connector", "endpoint-token", "health"];
	}
	return ["connector", "endpoint", "hostkey", "credentials", "health"];
}

interface HostKeyResult {
	fingerprint: string | null;
	detail: string;
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HTTPS_RE = /^https:\/\/.+/i;

/** Add-connector wizard. Progressive disclosure with a transport-aware step
 *  sequence derived from the live connector catalog. `ssh` → pick type →
 *  endpoint → TOFU host-key confirm → credentials/ssh-copy-id → health. `https`
 *  → pick type → endpoint & token (https-only, keychain-backed) → health. */
export function AddRemoteWizard({ onClose, onCreated }: Props) {
	const toast = useToast();

	// ── Connector cards from the live catalog, with a static offline fallback ──
	const degradedMode = useAppStore((s) => s.degradedMode);
	const catalog = useConnectorCatalog(!degradedMode);
	// Use live cards only when the catalog resolved cleanly; on error / degraded
	// mode / still-loading we render exactly today's static list.
	const useLive =
		!degradedMode && !catalog.isError && Array.isArray(catalog.data);
	const cards: WizardCard[] = useMemo(
		() => deriveWizardCards(useLive ? catalog.data : null),
		[useLive, catalog.data],
	);

	// Step 1
	const [connector, setConnector] = useState<string | null>(null);
	const selectedCard = cards.find((c) => c.key === connector) ?? null;
	const transportKind = selectedCard?.transportKind ?? "ssh";
	const steps = stepsFor(transportKind);

	const [stepIndex, setStepIndex] = useState(0);
	// Clamp the index if the step list shrank (e.g. SSH → HTTPS selection).
	const clampedIndex = Math.min(stepIndex, steps.length - 1);
	const stepKey = steps[clampedIndex];
	const isLast = clampedIndex === steps.length - 1;

	// Step 2 (shared)
	const [id, setId] = useState("");
	// SSH endpoint
	const [sshHost, setSshHost] = useState("");
	// HTTPS endpoint + token (token lives only until submit — never persisted).
	const [endpoint, setEndpoint] = useState("");
	const [token, setToken] = useState("");
	// Step 3 (ssh TOFU)
	const [fetching, setFetching] = useState(false);
	const [liveFpr, setLiveFpr] = useState<string | null>(null);
	const [fprDetail, setFprDetail] = useState("");
	const [pinned, setPinned] = useState(false);
	// Step 4 (ssh credentials)
	const [copyIdConfirmed, setCopyIdConfirmed] = useState(false);
	const [copyingId, setCopyingId] = useState(false);
	const [copyIdDone, setCopyIdDone] = useState(false);
	// Health step
	const [creating, setCreating] = useState(false);
	// True between a successful `remote add` and the onCreated hand-off, so the
	// catch path can tell "probe failed" apart from "add failed".
	const registeredRef = useRef(false);
	const [health, setHealth] = useState<"idle" | "checking" | "ok" | "fail">(
		"idle",
	);
	const [healthDetail, setHealthDetail] = useState("");

	const idValid = ID_RE.test(id);
	const endpointTrim = endpoint.trim();
	const endpointValid = HTTPS_RE.test(endpointTrim);
	const hostHint = sshHost.includes("@") ? sshHost.split("@")[1] : sshHost;
	const knownFpr = KNOWN_FINGERPRINTS[hostHint] ?? null;

	async function fetchHostKey() {
		setFetching(true);
		setLiveFpr(null);
		// A re-fetch invalidates any earlier confirmation: the user must re-confirm
		// the (possibly different) fingerprint before it can be pinned (TOFU).
		setPinned(false);
		try {
			const res = await invoke<HostKeyResult>("remote_fetch_host_key", {
				host: sshHost,
			});
			setLiveFpr(res.fingerprint);
			setFprDetail(res.detail);
		} catch (e) {
			setFprDetail(String(e));
		} finally {
			setFetching(false);
		}
	}

	async function runCopyId() {
		setCopyingId(true);
		try {
			const res = await invoke<HubResult>("remote_setup_key", {
				sshHost,
			});
			if (res.success) {
				setCopyIdDone(true);
				toast.success("Box key installed", res.output.trim() || undefined);
			} else {
				toast.error("ssh-copy-id failed", res.output.trim());
			}
		} catch (e) {
			toast.error("ssh-copy-id failed", String(e));
		} finally {
			setCopyingId(false);
		}
	}

	/** Shared tail: health-probe the just-registered remote, then hand off. */
	async function probeAndHandoff() {
		registeredRef.current = true;
		const diff = await invoke<RemoteDiffPlan>("remote_diff", { id });
		const healthy = diff.actions !== undefined || diff.ok === true;
		if (healthy) {
			setHealth("ok");
			toast.success(`Remote ${id} ready`);
		} else {
			setHealth("fail");
			setHealthDetail(diff.detail ?? "health check failed");
			toast.push({
				kind: "info",
				title: `Remote ${id} registered`,
				body: "Health check did not pass yet — finish credential setup and re-check from its detail page.",
			});
		}
		onCreated(id);
		registeredRef.current = false;
	}

	async function createAndCheck() {
		setCreating(true);
		setHealth("checking");
		try {
			// Transport-aware registration. HTTPS carries an endpoint + a keychain
			// token reference (the raw token accompanies it so the CLI can store it
			// — never written to the registry or persisted in UI state).
			const addArgs =
				transportKind === "https"
					? {
							id,
							connector,
							endpoint: endpointTrim,
							tokenRef: `skill-hub:${id}-token`,
							token,
							noSync: false,
							bundles: [],
							enabled: [],
						}
					: {
							id,
							connector,
							sshHost,
							hostKey: liveFpr,
							home: null,
							noSync: false,
							bundles: [],
							enabled: [],
						};
			const add = await invoke<HubResult>("remote_add", addArgs);
			if (!add.success) {
				setHealth("fail");
				setHealthDetail(add.output.trim());
				toast.error("Could not register remote", add.output.trim());
				return;
			}
			await probeAndHandoff();
		} catch (e) {
			setHealth("fail");
			setHealthDetail(String(e));
			if (registeredRef.current) {
				// The add succeeded — only the health probe failed. Don't strand the
				// persisted remote behind a failed wizard (a retry would hit a
				// duplicate id): hand off to the detail page and say so.
				toast.push({
					kind: "info",
					title: `Remote ${id} registered`,
					body: "Health check failed — verify connectivity from its detail page.",
				});
				registeredRef.current = false;
				onCreated(id);
			} else {
				toast.error("Failed to create remote", String(e));
			}
		} finally {
			setCreating(false);
		}
	}

	const canNext: Record<StepKey, boolean> = {
		connector: connector !== null,
		endpoint: idValid && sshHost.trim().length > 0,
		hostkey: pinned && liveFpr !== null,
		credentials: copyIdConfirmed,
		"endpoint-token": idValid && endpointValid && token.trim().length > 0,
		health: true,
	};

	return (
		<Sheet
			open
			side="right"
			onClose={onClose}
			dismissable={!creating}
			aria-label="Add a remote"
			className="remote-wizard"
			title={
				<span className="remote-wizard-title">
					<Icon name="remote" size={14} />
					<span>Add a remote</span>
					<span className="remote-wizard-steps text-mono text-dim">
						step {clampedIndex + 1} / {steps.length}
					</span>
				</span>
			}
			footer={
				<>
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<span className="modal-foot-spacer" />
					{clampedIndex > 0 && (
						<Button
							variant="ghost"
							icon="arrow-left"
							disabled={creating}
							onClick={() => setStepIndex((s) => Math.max(0, s - 1))}
						>
							Back
						</Button>
					)}
					{!isLast ? (
						<Button
							variant="primary"
							icon="arrow-right"
							disabled={!canNext[stepKey]}
							onClick={() => setStepIndex((s) => s + 1)}
						>
							Next
						</Button>
					) : (
						<Button
							variant="primary"
							icon="check"
							disabled={creating}
							onClick={() => void createAndCheck()}
						>
							{creating ? "Creating…" : "Create remote"}
						</Button>
					)}
				</>
			}
		>
			<div className="remote-wizard-body">
				{/* ── Step: pick connector type ── */}
				{stepKey === "connector" && (
					<div className="remote-wizard-step">
						<p className="remote-wizard-lede">
							Pick a connector type. Cards come from the live connector
							registry; unsupported-transport and future types appear disabled.
						</p>
						<div className="remote-connector-cards">
							{cards.map((c) => (
								<button
									key={c.key}
									type="button"
									className="remote-connector-card"
									data-selected={connector === c.key || undefined}
									data-disabled={!c.available || undefined}
									disabled={!c.available}
									onClick={() => c.available && setConnector(c.key)}
								>
									<div className="remote-connector-card-head">
										<Icon name={c.available ? "remote" : "plus"} size={18} />
										<span className="remote-connector-card-name">
											{c.label}
										</span>
										{c.available ? (
											<span className="remote-connector-transport text-mono">
												{c.transport}
											</span>
										) : c.key === "__placeholder__" ? (
											<span className="remote-connector-soon">soon</span>
										) : (
											<span className="remote-connector-soon">CLI</span>
										)}
									</div>
									<p className="remote-connector-card-desc">{c.description}</p>
								</button>
							))}
						</div>
					</div>
				)}

				{/* ── Step: SSH endpoint (id + host) ── */}
				{stepKey === "endpoint" && (
					<div className="remote-wizard-step">
						<p className="remote-wizard-lede">
							Name the remote and point it at the box over SSH (uses your
							ssh-agent + <span className="text-mono">~/.ssh/config</span> alias
							— no key is stored by the app).
						</p>
						<label className="remote-field">
							<span>Remote id</span>
							<input
								className="remote-input text-mono"
								placeholder="hermes-main"
								value={id}
								onChange={(e) => setId(e.target.value.trim())}
							/>
							{id.length > 0 && !idValid && (
								<span className="remote-field-err">
									lowercase letters, digits, single dashes
								</span>
							)}
						</label>
						<label className="remote-field">
							<span>SSH host / alias</span>
							<input
								className="remote-input text-mono"
								placeholder="hermes@moon-base"
								value={sshHost}
								onChange={(e) => setSshHost(e.target.value.trim())}
							/>
						</label>
					</div>
				)}

				{/* ── Step: HTTPS endpoint & token ── */}
				{stepKey === "endpoint-token" && (
					<div className="remote-wizard-step">
						<p className="remote-wizard-lede">
							Name the remote, point it at its HTTPS endpoint, and supply a
							bearer token. The token is stored under an OS-keychain reference —
							it never lands in the registry.
						</p>
						<label className="remote-field">
							<span>Remote id</span>
							<input
								className="remote-input text-mono"
								placeholder="workers-prod"
								value={id}
								onChange={(e) => setId(e.target.value.trim())}
							/>
							{id.length > 0 && !idValid && (
								<span className="remote-field-err">
									lowercase letters, digits, single dashes
								</span>
							)}
						</label>
						<label className="remote-field">
							<span>Endpoint URL</span>
							<input
								className="remote-input text-mono"
								placeholder="https://workers.example.com"
								value={endpoint}
								onChange={(e) => setEndpoint(e.target.value.trim())}
							/>
							{endpointTrim.length > 0 && !endpointValid && (
								<span className="remote-field-err">
									Endpoint must start with{" "}
									<span className="text-mono">https://</span> — the token must
									never travel in the clear.
								</span>
							)}
						</label>
						<label className="remote-field">
							<span>Bearer token</span>
							<input
								className="remote-input text-mono"
								type="password"
								placeholder="paste token"
								autoComplete="off"
								value={token}
								onChange={(e) => setToken(e.target.value)}
							/>
							<span className="text-dim">
								Written to your OS keychain as{" "}
								<span className="text-mono">
									skill-hub:{id || "<id>"}-token
								</span>
								.
							</span>
						</label>
					</div>
				)}

				{/* ── Step: TOFU host-key confirmation (ssh only) ── */}
				{stepKey === "hostkey" && (
					<div className="remote-wizard-step">
						<p className="remote-wizard-lede">
							Trust-on-first-use: fetch the box's host-key fingerprint, confirm
							it, and pin it. A future mismatch is a hard fail.
						</p>
						<div className="remote-tofu">
							<Button
								variant="soft"
								icon="fetch"
								disabled={fetching}
								onClick={() => void fetchHostKey()}
							>
								{fetching ? "Scanning…" : "Fetch host key"}
							</Button>
							{liveFpr && <code className="remote-fpr text-mono">{liveFpr}</code>}
							{!liveFpr && fprDetail && (
								<span className="remote-field-err">{fprDetail}</span>
							)}
						</div>
						{knownFpr && (
							<div className="remote-tofu-known">
								<Icon name="shield" size={11} />
								<span>
									Documented fingerprint for{" "}
									<span className="text-mono">{hostHint}</span>:{" "}
									<code className="text-mono">{knownFpr}</code>
									{liveFpr &&
										(liveFpr === knownFpr ? (
											<strong className="match"> · matches ✓</strong>
										) : (
											<strong className="nomatch"> · DOES NOT MATCH</strong>
										))}
								</span>
							</div>
						)}
						{liveFpr && (
							<Toggle
								className="remote-confirm"
								checked={pinned}
								onChange={setPinned}
								label="I confirm this fingerprint and pin it to the registry."
							/>
						)}
					</div>
				)}

				{/* ── Step: credentials / one-time box-key setup (ssh only) ── */}
				{stepKey === "credentials" && (
					<div className="remote-wizard-step">
						<p className="remote-wizard-lede">
							One-time box setup. This is the{" "}
							<strong>single intentional write to the box</strong>: it appends
							your SSH public key to{" "}
							<span className="text-mono">{sshHost}</span>'s authorized_keys so
							the connector can log in directly (no sudo).
						</p>
						<div className="remote-copyid">
							<Button
								variant="soft"
								icon="link"
								disabled={copyingId || copyIdDone}
								onClick={() => void runCopyId()}
							>
								{copyIdDone
									? "Key installed ✓"
									: copyingId
										? "Installing…"
										: "Run ssh-copy-id (one-time)"}
							</Button>
							<span className="text-dim">
								Or run it yourself:{" "}
								<code className="text-mono">ssh-copy-id {sshHost}</code>
							</span>
						</div>
						<Toggle
							className="remote-confirm"
							checked={copyIdConfirmed}
							onChange={setCopyIdConfirmed}
							ariaLabel="Confirm the connector user can log in to the box"
							label={
								<span>
									The <span className="text-mono">{connector}</span> user can log
									in to the box (key installed, or already authorized).
								</span>
							}
						/>
					</div>
				)}

				{/* ── Step: health check ── */}
				{stepKey === "health" && (
					<div className="remote-wizard-step">
						<p className="remote-wizard-lede">
							Register the remote and run a health check (reachable + auth
							{transportKind === "https" ? "" : " + host-key match"}) before
							marking it ready.
						</p>
						<div className="remote-summary">
							<div className="remote-summary-row">
								<span>id</span>
								<span className="text-mono">{id}</span>
							</div>
							<div className="remote-summary-row">
								<span>connector</span>
								<span className="text-mono">{connector}</span>
							</div>
							{transportKind === "https" ? (
								<>
									<div className="remote-summary-row">
										<span>endpoint</span>
										<span className="text-mono">{endpointTrim}</span>
									</div>
									<div className="remote-summary-row">
										<span>token</span>
										<span className="text-mono">
											{token ? "keychain ref" : "—"}
										</span>
									</div>
								</>
							) : (
								<>
									<div className="remote-summary-row">
										<span>host</span>
										<span className="text-mono">{sshHost}</span>
									</div>
									<div className="remote-summary-row">
										<span>host-key</span>
										<span className="text-mono">
											{liveFpr ? "pinned" : "—"}
										</span>
									</div>
								</>
							)}
						</div>
						{health !== "idle" && (
							<div className="remote-health-result" data-state={health}>
								<Icon
									name={
										health === "ok"
											? "state.ok"
											: health === "fail"
												? "warning"
												: "state.syncing"
									}
									size={13}
								/>
								<span>
									{health === "checking" && "Checking connection…"}
									{health === "ok" && "Healthy — remote is ready."}
									{health === "fail" &&
										`Not ready: ${healthDetail || "see detail page"}`}
								</span>
							</div>
						)}
					</div>
				)}
			</div>
		</Sheet>
	);
}
