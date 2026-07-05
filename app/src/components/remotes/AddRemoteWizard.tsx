import { useRef, useState } from "react";
import { invoke } from "@/lib/ipc";

import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Sheet } from "@/components/Modal";
import { Toggle } from "@/components/Toggle";
import { useToast } from "@/components/Toast";
import type { HubResult, RemoteDiffPlan } from "@/types";
import { CONNECTOR_TYPES, KNOWN_FINGERPRINTS } from "./connectors";

interface Props {
	onClose: () => void;
	onCreated: (id: string) => void;
}

type Step = 1 | 2 | 3 | 4 | 5;

interface HostKeyResult {
	fingerprint: string | null;
	detail: string;
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Add-connector wizard (D11). Progressive disclosure: pick type → endpoint →
 *  TOFU host-key confirm → credentials/ssh-copy-id (confirmed) → health check.
 *  Only the host-key step gates further progress; the box write (copy-id) is
 *  explicitly confirmed. */
export function AddRemoteWizard({ onClose, onCreated }: Props) {
	const toast = useToast();
	const [step, setStep] = useState<Step>(1);

	// Step 1
	const [connector, setConnector] = useState<string | null>(null);
	// Step 2
	const [id, setId] = useState("");
	const [sshHost, setSshHost] = useState("");
	// Step 3
	const [fetching, setFetching] = useState(false);
	const [liveFpr, setLiveFpr] = useState<string | null>(null);
	const [fprDetail, setFprDetail] = useState("");
	const [pinned, setPinned] = useState(false);
	// Step 4
	const [copyIdConfirmed, setCopyIdConfirmed] = useState(false);
	const [copyingId, setCopyingId] = useState(false);
	const [copyIdDone, setCopyIdDone] = useState(false);
	// Step 5
	const [creating, setCreating] = useState(false);
	// True between a successful `remote add` and the onCreated hand-off, so the
	// catch path can tell "probe failed" apart from "add failed".
	const registeredRef = useRef(false);
	const [health, setHealth] = useState<"idle" | "checking" | "ok" | "fail">(
		"idle",
	);
	const [healthDetail, setHealthDetail] = useState("");

	const idValid = ID_RE.test(id);
	const hostHint = sshHost.includes("@") ? sshHost.split("@")[1] : sshHost;
	const knownFpr = KNOWN_FINGERPRINTS[hostHint] ?? null;

	async function fetchHostKey() {
		setFetching(true);
		setLiveFpr(null);
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

	async function createAndCheck() {
		setCreating(true);
		setHealth("checking");
		try {
			// Register the remote with the pinned fingerprint.
			const add = await invoke<HubResult>("remote_add", {
				id,
				connector,
				sshHost,
				hostKey: liveFpr,
				home: null,
				noSync: false,
				bundles: [],
				enabled: [],
			});
			if (!add.success) {
				setHealth("fail");
				setHealthDetail(add.output.trim());
				toast.error("Could not register remote", add.output.trim());
				return;
			}
			registeredRef.current = true;
			// Health check (reachable + auth + host-key match) via the diff command.
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
			// Registered regardless; hand control to the detail page.
			onCreated(id);
			registeredRef.current = false;
		} catch (e) {
			setHealth("fail");
			setHealthDetail(String(e));
			if (registeredRef.current) {
				// The add succeeded — only the health probe failed. Don't strand
				// the persisted remote behind a failed wizard (a retry would hit
				// a duplicate id): hand off to the detail page and say so.
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

	const canNext: Record<Step, boolean> = {
		1: connector !== null,
		2: idValid && sshHost.trim().length > 0,
		3: pinned && liveFpr !== null,
		4: copyIdConfirmed,
		5: true,
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
						step {step} / 5
					</span>
				</span>
			}
			footer={
				<>
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<span className="modal-foot-spacer" />
					{step > 1 && (
						<Button
							variant="ghost"
							icon="arrow-left"
							disabled={creating}
							onClick={() => setStep((s) => (s - 1) as Step)}
						>
							Back
						</Button>
					)}
					{step < 5 ? (
						<Button
							variant="primary"
							icon="arrow-right"
							disabled={!canNext[step]}
							onClick={() => setStep((s) => (s + 1) as Step)}
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
					{/* ── Step 1: pick connector type ── */}
					{step === 1 && (
						<div className="remote-wizard-step">
							<p className="remote-wizard-lede">
								Pick a connector type. Only the connectors the hub ships are
								selectable — future types appear as a placeholder.
							</p>
							<div className="remote-connector-cards">
								{CONNECTOR_TYPES.map((c) => (
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
											<Icon
												name={c.available ? "remote" : "plus"}
												size={18}
											/>
											<span className="remote-connector-card-name">
												{c.label}
											</span>
											{c.available ? (
												<span className="remote-connector-transport text-mono">
													{c.transport}
												</span>
											) : (
												<span className="remote-connector-soon">soon</span>
											)}
										</div>
										<p className="remote-connector-card-desc">
											{c.description}
										</p>
									</button>
								))}
							</div>
						</div>
					)}

					{/* ── Step 2: endpoint ── */}
					{step === 2 && (
						<div className="remote-wizard-step">
							<p className="remote-wizard-lede">
								Name the remote and point it at the box over SSH (uses your
								ssh-agent + <span className="text-mono">~/.ssh/config</span>{" "}
								alias — no key is stored by the app).
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

					{/* ── Step 3: TOFU host-key confirmation ── */}
					{step === 3 && (
						<div className="remote-wizard-step">
							<p className="remote-wizard-lede">
								Trust-on-first-use: fetch the box's host-key fingerprint,
								confirm it, and pin it. A future mismatch is a hard fail.
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
								{liveFpr && (
									<code className="remote-fpr text-mono">{liveFpr}</code>
								)}
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

					{/* ── Step 4: credentials / one-time box-key setup ── */}
					{step === 4 && (
						<div className="remote-wizard-step">
							<p className="remote-wizard-lede">
								One-time box setup. This is the{" "}
								<strong>single intentional write to the box</strong>: it
								appends your SSH public key to{" "}
								<span className="text-mono">{sshHost}</span>'s authorized_keys
								so the connector can log in directly (no sudo).
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
										The <span className="text-mono">{connector}</span> user can
										log in to the box (key installed, or already authorized).
									</span>
								}
							/>
						</div>
					)}

					{/* ── Step 5: health check ── */}
					{step === 5 && (
						<div className="remote-wizard-step">
							<p className="remote-wizard-lede">
								Register the remote with the pinned key and run a health check
								(reachable + auth + host-key match) before marking it ready.
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
