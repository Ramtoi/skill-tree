import { useState } from "react";

import { Button } from "@/components/Button";
import { Tag } from "@/components/Tag";
import { Toggle } from "@/components/Toggle";
import { InfoBanner } from "@/components/InfoBanner";
import { StatusBadge } from "@/components/StatusBadge";
import { useBackupAuth, useBackupInit, useBackupNow } from "@/hooks/useBackup";
import { summarizeBackupResult } from "@/lib/backupContract";
import { useAppStore } from "@/store";

/**
 * The optional final step of a fresh setup (design §9): offer to back the new
 * hub up, then get out of the way.
 *
 * Deliberately **skippable without consequence** — it is the last screen of a
 * first run, the user has not built anything worth losing yet, and a mandatory
 * GitHub-credential step here would be the worst possible first impression. The
 * screen is reachable forever after via `g ⇧b` / the palette, and the copy says so.
 *
 * Three sub-states, in ladder order: credential → repo → first push.
 */
export function BootstrapBackupStep({
	onDone,
	onSkip,
}: {
	onDone: () => void;
	onSkip: () => void;
}) {
	const { data: auth, isLoading: authLoading } = useBackupAuth();
	const init = useBackupInit();
	const backupNow = useBackupNow();
	const addToast = useAppStore((s) => s.addToast);

	const [repo, setRepo] = useState("");
	const [create, setCreate] = useState(false);
	const [initialized, setInitialized] = useState(false);
	const [pushed, setPushed] = useState(false);

	const canCreate = auth?.create_method === "gh";
	const hasCredential = !!auth?.method;

	async function runInit() {
		try {
			const res = await init.mutateAsync({ repo: repo.trim(), create: create && canCreate });
			setInitialized(true);
			for (const w of (res?.warnings as string[] | undefined) ?? []) {
				addToast("info", w);
			}
			addToast("success", "Backup repo configured");
		} catch (e) {
			addToast("error", `Couldn't configure backup — ${e}`);
		}
	}

	async function runFirstPush() {
		try {
			const res = await backupNow.mutateAsync(undefined);
			setPushed(true);
			addToast(res.ok === false || res.error ? "error" : "success", summarizeBackupResult(res));
		} catch (e) {
			addToast("error", `Backup failed — ${e}`);
		}
	}

	return (
		<div data-testid="bootstrap-backup-step">
			<h1 style={{ fontSize: 22, margin: 0, color: "var(--fg-strong)" }}>Back up &amp; sync</h1>
			<p style={{ marginTop: 8, color: "var(--fg-mid)", lineHeight: 1.5 }}>
				Optional. Snapshot your hub to a private git repo so you can restore it on another
				machine. You can skip this and set it up any time from the Backup screen.
			</p>

			{/* ── 1. Credential ── */}
			<section style={{ marginTop: 24 }}>
				<div
					style={{
						fontSize: 11,
						textTransform: "uppercase",
						letterSpacing: 0.5,
						fontFamily: "var(--font-mono)",
						color: "var(--fg-mute)",
						marginBottom: 8,
					}}
				>
					1 · GitHub credential
				</div>
				{authLoading ? (
					<span style={{ fontSize: 12, color: "var(--fg-dim)" }}>Checking…</span>
				) : (
					<div style={{ display: "grid", gap: 4 }}>
						{(auth?.ladder ?? []).map((rung) => (
							<div
								key={rung.method}
								style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 12 }}
								data-testid={`bootstrap-rung-${rung.method}`}
							>
								<StatusBadge
									channel={rung.available ? "ok" : "neutral"}
									shape="dot"
									ariaLabel={rung.available ? "available" : "unavailable"}
								/>
								<span
									style={{ fontFamily: "var(--font-mono)", width: 34, color: "var(--fg-strong)" }}
								>
									{rung.method}
								</span>
								<span style={{ color: "var(--fg-mid)", flex: 1 }}>{rung.detail}</span>
								{rung.method === auth?.method && <Tag color="var(--violet)">will push</Tag>}
							</div>
						))}
					</div>
				)}
				{!authLoading && !hasCredential && (
					<InfoBanner style={{ marginTop: 12 }}>
						No GitHub credential found. You can still configure the repo — snapshots will
						commit locally, and you can add a token later from the Backup screen.
					</InfoBanner>
				)}
			</section>

			{/* ── 2. Repo ── */}
			<section style={{ marginTop: 24 }}>
				<div
					style={{
						fontSize: 11,
						textTransform: "uppercase",
						letterSpacing: 0.5,
						fontFamily: "var(--font-mono)",
						color: "var(--fg-mute)",
						marginBottom: 8,
					}}
				>
					2 · Repository
				</div>
				<div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
					<div style={{ flex: "1 1 300px", minWidth: 200 }}>
						<label
							htmlFor="bootstrap-repo"
							style={{ fontSize: 12, color: "var(--fg-mute)", display: "block", marginBottom: 6 }}
						>
							Private repo (owner/name)
						</label>
						<input
							id="bootstrap-repo"
							value={repo}
							spellCheck={false}
							placeholder="me/skill-hub-backup"
							onChange={(e) => setRepo(e.target.value)}
							style={{
								width: "100%",
								padding: "8px 10px",
								fontFamily: "var(--font-mono)",
								fontSize: 12,
								background: "var(--bg-0)",
								border: "1px solid var(--bg-3)",
								borderRadius: 6,
								color: "var(--fg-strong)",
							}}
						/>
					</div>
					<Button
						variant="primary"
						busy={init.isPending}
						disabled={!repo.trim()}
						disabledReason={!repo.trim() ? "Enter a repo first" : undefined}
						onClick={() => void runInit()}
						data-testid="bootstrap-backup-init"
					>
						{initialized ? "Reconfigure" : "Configure"}
					</Button>
				</div>
				{canCreate ? (
					<div style={{ marginTop: 10 }} data-testid="bootstrap-backup-create">
						{/* The app has ONE checkbox primitive (COMPONENTS.md §Toggle); a
						    raw input here would be the only unskinned box in the wizard. */}
						<Toggle
							checked={create}
							onChange={setCreate}
							ariaLabel="Create it on GitHub for me (private)"
							label={
								<span style={{ fontSize: 12, color: "var(--fg-mid)" }}>
									Create it on GitHub for me (private)
								</span>
							}
						/>
					</div>
				) : (
					<p style={{ fontSize: 11.5, color: "var(--fg-dim)", marginTop: 10, lineHeight: 1.5 }}>
						Creating a repo needs an authenticated <code>gh</code> CLI. Create an empty
						private repo in your browser first, then enter it above.
					</p>
				)}
			</section>

			{/* ── 3. First push ── */}
			{initialized && (
				<section style={{ marginTop: 24 }}>
					<div
						style={{
							fontSize: 11,
							textTransform: "uppercase",
							letterSpacing: 0.5,
							fontFamily: "var(--font-mono)",
							color: "var(--fg-mute)",
							marginBottom: 8,
						}}
					>
						3 · First snapshot
					</div>
					<Button
						icon="sync"
						busy={backupNow.isPending}
						onClick={() => void runFirstPush()}
						data-testid="bootstrap-backup-push"
					>
						{pushed ? "Back up again" : "Take the first snapshot"}
					</Button>
				</section>
			)}

			<div style={{ marginTop: 32, display: "flex", gap: 12 }}>
				<Button onClick={onSkip} data-testid="bootstrap-backup-skip">
					Skip for now
				</Button>
				<Button variant="primary" onClick={onDone} data-testid="bootstrap-backup-done">
					Done
				</Button>
			</div>
		</div>
	);
}
