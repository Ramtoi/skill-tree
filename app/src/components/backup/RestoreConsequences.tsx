import { Tag } from "@/components/Tag";
import { Icon } from "@/components/Icon";
import { consequenceCount, type RestorePlan } from "@/lib/backupContract";

/**
 * The enumerated consequences of a restore (design §5).
 *
 * Shared verbatim by the Backup screen's danger-zone ConfirmDialog and the
 * BootstrapWizard's restore path, so a first-run restore and a mid-life restore
 * disclose exactly the same things. Three rules hold everywhere:
 *
 * 1. **What the target LOSES leads.** A restore's real cost is the entries on
 *    this machine that disappear — that goes first, not last.
 * 2. **Hook commands are shown verbatim.** They are arbitrary code that will run
 *    on this machine; summarizing them would defeat the consent.
 * 3. **Writes outside the data home are named individually.** Sub-agent files
 *    and global harness docs land in `~/.claude`, `~/.codex`, … — outside the
 *    directory the user thinks of as "the hub".
 */

function Group({
	title,
	tone,
	count,
	children,
	testId,
}: {
	title: string;
	tone?: string;
	count: number;
	children: React.ReactNode;
	testId: string;
}) {
	if (count === 0) return null;
	return (
		<section style={{ marginTop: 14 }} data-testid={testId}>
			<div
				style={{
					fontSize: 11,
					textTransform: "uppercase",
					letterSpacing: 0.5,
					fontFamily: "var(--font-mono)",
					color: tone ?? "var(--fg-mute)",
					marginBottom: 6,
				}}
			>
				{title} ({count})
			</div>
			{children}
		</section>
	);
}

const listStyle: React.CSSProperties = {
	margin: 0,
	padding: 0,
	listStyle: "none",
	display: "grid",
	gap: 4,
	maxHeight: 220,
	overflow: "auto",
};

const itemStyle: React.CSSProperties = {
	fontSize: 12,
	color: "var(--fg-mid)",
	display: "flex",
	gap: 8,
	alignItems: "baseline",
	minWidth: 0,
};

const monoStyle: React.CSSProperties = {
	fontFamily: "var(--font-mono)",
	color: "var(--fg-strong)",
	wordBreak: "break-all",
};

export function RestoreConsequences({ plan }: { plan: RestorePlan }) {
	const total = consequenceCount(plan);
	// Code hub itself imports and executes is a different consent from a command
	// hub hands to a harness, so the two are enumerated separately. Both come out
	// of the SAME `executableState` list the consent count is taken from, so
	// neither can go missing from the dialog.
	const codeDirs = plan.executableState.filter((e) => e.code);
	const executables = plan.executableState.filter((e) => !e.code);

	return (
		<div data-testid="restore-consequences">
			<div style={{ fontSize: 12.5, color: "var(--fg-mid)", lineHeight: 1.55 }}>
				Restoring{" "}
				<span style={monoStyle}>{plan.source || "the snapshot"}</span>
				{plan.mode ? (
					<>
						{" "}
						{/* The mode is an IDENTIFIER, not a severity — amber is reserved
						    for provenance/risk, and tinting a value with it reads as a
						    warning about the wrong thing. */}
						in <Tag kind="outline">{plan.mode}</Tag> mode
					</>
				) : null}
				{total === 0
					? " — no destructive consequences detected."
					: ` — ${total} consequence${total === 1 ? "" : "s"} listed below.`}
			</div>

			{plan.unverified && (
				<div
					role="alert"
					data-testid="restore-unverified"
					data-trust-state={plan.trust.state}
					style={{
						marginTop: 12,
						padding: 10,
						border: "1px solid var(--red)",
						borderRadius: 6,
						fontSize: 12,
						color: "var(--fg-mid)",
						lineHeight: 1.5,
					}}
				>
					<strong style={{ color: "var(--red)" }}>
						<Icon name="warning" size={12} />{" "}
						{plan.trust.hard ? "Refusing this snapshot." : "Unverified snapshot."}
					</strong>{" "}
					{/* The CLI's own sentence, verbatim — it names the key ids and the
					    exact remedy, and re-wording it would lose both. */}
					{plan.trust.detail ||
						"This snapshot isn't signed by a key this machine already trusts. Only continue if you know where it came from."}
				</div>
			)}

			{!plan.treeDigestOk && (
				<div
					role="alert"
					data-testid="restore-integrity-failed"
					style={{
						marginTop: 12,
						padding: 10,
						border: "1px solid var(--red)",
						borderRadius: 6,
						fontSize: 12,
						color: "var(--fg-mid)",
						lineHeight: 1.5,
					}}
				>
					<strong style={{ color: "var(--red)" }}>
						<Icon name="warning" size={12} /> Snapshot integrity check failed.
					</strong>{" "}
					The recorded tree digest does not match the files on disk — the snapshot is
					incomplete or has been altered. It cannot be restored.
				</div>
			)}

			<Group
				title="Entries this machine loses"
				tone="var(--red)"
				count={plan.lostEntries.length}
				testId="restore-lost"
			>
				<ul style={listStyle}>
					{plan.lostEntries.map((e, i) => (
						<li key={`${e.kind}-${e.name}-${i}`} style={itemStyle}>
							<Tag kind="outline">{e.kind}</Tag>
							<span style={monoStyle}>{e.name}</span>
							{e.detail && <span style={{ color: "var(--fg-dim)" }}>{e.detail}</span>}
						</li>
					))}
				</ul>
			</Group>

			{/* Code hub LOADS — a connector or MCP server restored as source. Not a
			    command handed to an agent: a Python module this app imports into
			    its own process, which is a bigger thing to accept and is therefore
			    said plainly rather than folded into the list below. */}
			<Group
				title="Code this app will import and execute"
				tone="var(--amber)"
				count={codeDirs.length}
				testId="restore-code-dirs"
			>
				<p style={{ fontSize: 11.5, color: "var(--fg-mute)", margin: "0 0 8px", lineHeight: 1.5 }}>
					Restored connector and MCP-server source. Hub loads these itself — review the
					snapshot's origin before accepting.
				</p>
				<ul style={listStyle}>
					{codeDirs.map((e, i) => (
						<li
							key={`code-${e.kind}-${e.label}-${i}`}
							style={{ ...itemStyle, flexDirection: "column", alignItems: "stretch", gap: 2 }}
						>
							<span style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
								<Tag color="var(--amber)" kind="outline">
									{e.kind}
								</Tag>
								<span style={monoStyle}>{e.label}</span>
								{/* An overwrite replaces code already on this machine — that is
								    the destructive half, so it carries the destructive colour. */}
								{e.action === "overwrite" ? (
									<Tag color="var(--red)">overwrites local code</Tag>
								) : (
									<span style={{ color: "var(--fg-dim)" }}>new</span>
								)}
								{e.detail && <span style={{ color: "var(--fg-dim)" }}>{e.detail}</span>}
							</span>
							{e.files && e.files.length > 0 && (
								<span
									style={{ ...monoStyle, fontSize: 11.5, color: "var(--fg-mute)" }}
									data-testid="code-dir-files"
								>
									{e.files.length} file{e.files.length === 1 ? "" : "s"} · {e.files.join(", ")}
								</span>
							)}
						</li>
					))}
				</ul>
			</Group>

			<Group
				title="Executable state being installed"
				tone="var(--amber)"
				count={executables.length}
				testId="restore-executable"
			>
				<p style={{ fontSize: 11.5, color: "var(--fg-mute)", margin: "0 0 8px", lineHeight: 1.5 }}>
					These run on this machine. Commands are shown exactly as they will be installed.
				</p>
				<ul style={listStyle}>
					{executables.map((e, i) => (
						<li
							key={`${e.kind}-${e.label}-${i}`}
							style={{ ...itemStyle, flexDirection: "column", alignItems: "stretch", gap: 2 }}
						>
							<span style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
								<Tag color="var(--amber)" kind="outline">
									{e.kind}
								</Tag>
								<span style={monoStyle}>{e.label}</span>
								{e.broken && <Tag color="var(--red)">script missing</Tag>}
							</span>
							{e.detail && (
								<code
									style={{
										display: "block",
										padding: "4px 8px",
										background: "var(--bg-0)",
										borderRadius: 4,
										fontFamily: "var(--font-mono)",
										fontSize: 11.5,
										color: "var(--fg-strong)",
										whiteSpace: "pre-wrap",
										wordBreak: "break-all",
									}}
								>
									{e.detail}
								</code>
							)}
						</li>
					))}
				</ul>
			</Group>

			<Group
				title="Writes outside the data home"
				/* A destructive consequence (files replaced outside the directory the
				   user thinks of as "the hub"), so it belongs in the same red as the
				   losses above — not in amber, which means provenance/risk severity. */
				tone="var(--red)"
				count={plan.outOfHomeTargets.length}
				testId="restore-out-of-home"
			>
				<ul style={listStyle}>
					{plan.outOfHomeTargets.map((t) => (
						<li key={t.path} style={itemStyle}>
							<Tag kind="outline">{t.kind}</Tag>
							<span style={monoStyle}>{t.path}</span>
							{/* `sibling` means a local edit survived — say so, don't imply
							    the file was replaced. */}
							{t.action !== "write" && (
								<span style={{ color: "var(--fg-dim)" }}>{t.action}</span>
							)}
						</li>
					))}
				</ul>
			</Group>

			<Group title="Conflicts" count={plan.conflicts.length} testId="restore-conflicts">
				<ul style={listStyle}>
					{plan.conflicts.map((e, i) => (
						<li key={`${e.kind}-${e.name}-${i}`} style={itemStyle}>
							<Tag kind="outline">{e.kind}</Tag>
							<span style={monoStyle}>{e.name}</span>
							{e.resolution && (
								<span style={{ color: "var(--fg-dim)" }}>→ {e.resolution}</span>
							)}
						</li>
					))}
				</ul>
			</Group>

			<Group
				title="Projects that won't resolve here"
				count={plan.unresolvedProjects.length}
				testId="restore-unresolved"
			>
				<p style={{ fontSize: 11.5, color: "var(--fg-mute)", margin: "0 0 8px", lineHeight: 1.5 }}>
					Kept but quarantined — sync skips them until you point each at a real path.
				</p>
				<ul style={listStyle}>
					{plan.unresolvedProjects.map((e) => (
						<li key={e.name} style={itemStyle}>
							<span style={monoStyle}>{e.name}</span>
							<span style={{ color: "var(--fg-dim)" }}>{e.path}</span>
						</li>
					))}
				</ul>
			</Group>

			<Group title="Warnings" count={plan.warnings.length} testId="restore-warnings">
				<ul style={listStyle}>
					{plan.warnings.map((w, i) => (
						<li key={i} style={itemStyle}>
							{w}
						</li>
					))}
				</ul>
			</Group>

			{/* The reassuring half, and the one thing a "replace" reader most wants
			    to know: what SURVIVES. Kept last so it never softens the losses. */}
			{(plan.retainedFiles > 0 || plan.auditLedgersNote) && (
				<section style={{ marginTop: 14 }} data-testid="restore-retained">
					<div
						style={{
							fontSize: 11,
							textTransform: "uppercase",
							letterSpacing: 0.5,
							fontFamily: "var(--font-mono)",
							color: "var(--fg-mute)",
							marginBottom: 6,
						}}
					>
						Kept from this machine
					</div>
					{plan.retainedFiles > 0 && (
						<p style={{ ...itemStyle, margin: 0 }}>
							<span style={monoStyle}>{plan.retainedFiles}</span> file
							{plan.retainedFiles === 1 ? "" : "s"} the snapshot doesn't carry are left in
							place.
						</p>
					)}
					{/* The CLI's own sentence about append-only ledgers — verbatim. */}
					{plan.auditLedgersNote && (
						<p style={{ ...itemStyle, margin: "4px 0 0" }} data-testid="restore-audit-note">
							{plan.auditLedgersNote}
						</p>
					)}
				</section>
			)}

			<Group title="Next steps" count={plan.nextSteps.length} testId="restore-next-steps">
				<p style={{ fontSize: 11.5, color: "var(--fg-mute)", margin: "0 0 8px", lineHeight: 1.5 }}>
					Restore materializes files but deliberately does <strong>not</strong> sync. Run these
					in order afterwards.
				</p>
				<ol style={{ ...listStyle, listStyle: "decimal", paddingLeft: 18 }}>
					{plan.nextSteps.map((sstep, i) => (
						<li key={i} style={{ ...itemStyle, ...monoStyle, display: "list-item" }}>
							{sstep}
						</li>
					))}
				</ol>
			</Group>
		</div>
	);
}
