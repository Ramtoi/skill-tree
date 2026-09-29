import { Disclosure } from "@/components/Disclosure";
import { Tag } from "@/components/Tag";
import { Icon } from "@/components/Icon";
import { consequenceCount, PRODUCT_NAME, type RestorePlan } from "@/lib/backupContract";

/** Shared restore details. Onboarding collapses item lists; the final dialog
 * keeps them expanded. Losses and blocking warnings remain visible in both.
 * Expanded lists retain exact commands and every external write target. */

function Group({
	title,
	tone,
	count,
	children,
	testId,
	collapsed = false,
	showCount = true,
}: {
	title: string;
	tone?: string;
	count: number;
	showCount?: boolean;
	children: React.ReactNode;
	testId: string;
	collapsed?: boolean;
}) {
	if (count === 0) return null;
	const heading = <>{title}{showCount ? ` (${count})` : ""}</>;
	if (collapsed) {
		return (
			<div data-testid={testId}>
				<Disclosure className="restore-preview-details" summary={heading}>{children}</Disclosure>
			</div>
		);
	}
	return (
		<section className="im-restore-consequences-1" data-testid={testId}>
			<div style={{ fontSize: 12, color: tone ?? "var(--fg-mid)", marginBottom: 6 }}>
				{heading}
			</div>
			{children}
		</section>
	);
}

/**
 * No `maxHeight` / inner `overflow`.
 *
 * A 220px scroll box inside a consent list hides items behind an edge with no
 * affordance, which is the same defect as clipping the dialog: the reader has
 * no way to know the group had more in it. The dialog body is now the ONE
 * scroller, and the confirm is gated on reaching its end — a nested scroller
 * would let items hide inside a region that gate cannot see.
 */
const listStyle: React.CSSProperties = {
	margin: 0,
	padding: 0,
	listStyle: "none",
	display: "grid",
	gap: 4,
};

const itemStyle: React.CSSProperties = {
	fontSize: 12,
	color: "var(--fg-mid)",
	display: "flex",
	gap: 8,
	alignItems: "baseline",
	minWidth: 0,
};

/** `overflowWrap: "anywhere"` rather than `wordBreak: "break-all"`: break-all
 *  breaks at the line edge unconditionally, so `git@github.com:me/skill-tree-
 *  backup.git` split as `…skill-tree-backu / p.git` even where the token would
 *  have fitted on the next line. `anywhere` only breaks a token that genuinely
 *  cannot fit, and still lets it shrink the container. */
const monoStyle: React.CSSProperties = {
	fontFamily: "var(--font-mono)",
	color: "var(--fg-strong)",
	overflowWrap: "anywhere",
};

/**
 * The detail line under an executable item.
 *
 * A hook's detail IS the command and a permission's is a pattern — identifiers,
 * shown verbatim in mono. A trust grant's detail is an English sentence ("has 1
 * translatable Bash rule(s); sync auto-grants Codex trust_level = trusted so
 * they load"), and setting prose in a mono code block bought nothing except a
 * mid-word break at `so t / hey load`. Same rule as everywhere else in this app
 * (COMPONENTS.md §Type): identifiers mono, prose sans.
 */
function ExecutableDetail({ kind, detail }: { kind: string; detail: string }) {
	const literal = kind === "hook" || kind === "permission";
	return (
		<code
			style={{
				display: "block",
				padding: "4px 8px",
				background: "var(--bg-0)",
				borderRadius: 4,
				fontFamily: literal ? "var(--font-mono)" : "var(--font-sans)",
				fontSize: literal ? 11.5 : 12,
				color: literal ? "var(--fg-strong)" : "var(--fg-mid)",
				lineHeight: 1.5,
				whiteSpace: literal ? "pre-wrap" : "normal",
				overflowWrap: "anywhere",
			}}
		>
			{detail}
		</code>
	);
}

export function RestoreConsequences({ plan, compact = false }: { plan: RestorePlan; compact?: boolean }) {
	const total = consequenceCount(plan);
	const worktree = plan.worktreeDefaults;
	const worktreeBaseIsHomeRelative =
		worktree.value?.base_dir === "~" || worktree.value?.base_dir.startsWith("~/");
	// Code hub itself imports and executes is a different consent from a command
	// hub hands to a harness, so the two are enumerated separately. Both come out
	// of the SAME `executableState` list the consent count is taken from, so
	// neither can go missing from the dialog.
	const codeDirs = plan.executableState.filter((e) => e.code);
	const executables = plan.executableState.filter((e) => !e.code);
	const references = plan.unverifiedReferences ?? [];

	return (
		<div data-testid="restore-consequences">
			{compact ? (
				<div className="im-restore-consequences-2">
					<strong>Review your backup</strong>
					{total === 0 && !plan.fatal && !plan.error && <p>No destructive changes detected.</p>}
				</div>
			) : <div className="im-restore-consequences-2">
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
			</div>}

			{worktree.value && (
				<Group title="Worktree defaults" count={1} showCount={false} testId="restore-worktree-defaults" collapsed={compact && !worktree.machineAbsolute}>
					<p style={{ ...itemStyle, margin: "0 0 8px", display: "block" }}>
						{worktree.status === "preserved"
							? "Preserved from this machine; the snapshot does not include these defaults."
							: worktree.status === "unchanged"
								? "Unchanged; the backup and this machine agree."
								: "Incoming from the backup; these defaults apply to newly registered projects."}
					</p>
					<dl style={{ ...listStyle, gap: 3 }}>
						<div style={itemStyle}>
							<dt>Directory mode</dt>
							<dd style={{ ...monoStyle, margin: 0 }}>
								{worktree.value.location === "shared-directory"
									? "Shared directory"
									: "Inside each project"}
							</dd>
						</div>
						<div style={itemStyle}>
							<dt>Base directory</dt>
							<dd style={{ ...monoStyle, margin: 0 }}>
								{worktree.value.base_dir}
								{worktree.value.location === "project-subdirectory" &&
									" (retained for shared-directory mode)"}
							</dd>
						</div>
						<div style={itemStyle}>
							<dt>Agent access default</dt>
							<dd style={{ margin: 0 }}>
								{worktree.value.access_enabled ? "Enabled" : "Off"}
							</dd>
						</div>
						<div style={itemStyle}>
							<dt>Backup inclusion</dt>
							<dd style={{ margin: 0 }}>
								{worktree.value.include_in_backup ? "Included" : "Not included"}
							</dd>
						</div>
					</dl>
					{worktree.machineAbsolute && !worktreeBaseIsHomeRelative && (
						<p
							role="note"
							style={{ ...itemStyle, margin: "8px 0 0", display: "block" }}
						>
							This base directory is outside HOME and will remain {worktree.machineAbsolute.value}.
							Review it before restoring.
						</p>
					)}
				</Group>
			)}

			{plan.unverified && (
				<div
					role="alert"
					data-testid="restore-unverified"
					data-trust-state={plan.trust.state}
					className="im-restore-consequences-3"
					style={compact && !plan.trust.hard ? { borderColor: "var(--amber)" } : undefined}
				>
					<strong className="im-restore-consequences-4" style={compact && !plan.trust.hard ? { color: "var(--amber)" } : undefined}>
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
					className="im-restore-consequences-5"
				>
					<strong className="im-restore-consequences-6">
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
							{e.detail && <span className="im-restore-consequences-7">{e.detail}</span>}
						</li>
					))}
				</ul>
			</Group>

			{/* Code hub LOADS — a connector or MCP server restored as source. Not a
			    command handed to an agent: a Python module this app imports into
			    its own process, which is a bigger thing to accept and is therefore
			    said plainly rather than folded into the list below. */}
			<Group
				title={compact ? "App code that will run" : "Code this app will import and execute"}
				tone="var(--amber)"
				count={codeDirs.length}
				testId="restore-code-dirs"
				collapsed={compact}
			>
				<p className="im-restore-consequences-8">
					Restored connector and MCP-server source. {PRODUCT_NAME} loads these itself — review the
					snapshot's origin before accepting.
				</p>
				<ul style={listStyle}>
					{codeDirs.map((e, i) => (
						<li
							key={`code-${e.kind}-${e.label}-${i}`}
							style={{ ...itemStyle, flexDirection: "column", alignItems: "stretch", gap: 2 }}
						>
							<span className="im-restore-consequences-9">
								<Tag color="var(--amber)" kind="outline">
									{e.kind}
								</Tag>
								<span style={monoStyle}>{e.label}</span>
								{/* An overwrite replaces code already on this machine — that is
								    the destructive half, so it carries the destructive colour. */}
								{e.action === "overwrite" ? (
									<Tag color="var(--red)">overwrites local code</Tag>
								) : (
									<span className="im-restore-consequences-10">new</span>
								)}
								{e.detail && <span className="im-restore-consequences-11">{e.detail}</span>}
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

			<Group title="Reference placements not covered by the signature" tone="var(--amber)"
				count={references.length} testId="restore-unverified-references">
				<p>The old snapshot signature covers file contents, but not these links. Review where each file will be copied.</p>
				<ul style={listStyle}>
					{references.map((reference) => <li key={reference.path} style={{ ...itemStyle, flexDirection: "column" }}>
						<span style={monoStyle}>{reference.path}</span>
						<span style={monoStyle}>Content from {reference.target}</span>
					</li>)}
				</ul>
			</Group>

			<Group
				title={compact ? "Commands and permissions" : "Executable state being installed"}
				tone="var(--amber)"
				count={executables.length}
				testId="restore-executable"
				collapsed={compact}
			>
				<p className="im-restore-consequences-12">
					These run on this machine. Commands are shown exactly as they will be installed.
				</p>
				<ul style={listStyle}>
					{executables.map((e, i) => (
						<li
							key={`${e.kind}-${e.label}-${i}`}
							style={{ ...itemStyle, flexDirection: "column", alignItems: "stretch", gap: 2 }}
						>
							<span className="im-restore-consequences-13">
								<Tag color="var(--amber)" kind="outline">
									{e.kind}
								</Tag>
								<span style={monoStyle}>{e.label}</span>
								{e.broken && <Tag color="var(--red)">script missing</Tag>}
							</span>
							{e.detail && <ExecutableDetail kind={e.kind} detail={e.detail} />}
						</li>
					))}
				</ul>
			</Group>

			{/* "the data home" is an internal term this UI never defines anywhere —
			    the heading has to say what the user will recognise, which is that
			    these files land in their harness folders, not in the library this
			    app manages. */}
			<Group
				title="Files replaced outside your library"
				/* A destructive consequence (files replaced outside the directory the
				   user thinks of as "the hub"), so it belongs in the same red as the
				   losses above — not in amber, which means provenance/risk severity. */
				tone="var(--red)"
				count={plan.outOfHomeTargets.length}
				testId="restore-out-of-home"
				collapsed={compact}
			>
				<p className="im-restore-consequences-14">
					Sub-agent definitions and global harness docs live in your harness folders
					(<span style={monoStyle}>~/.claude</span>, <span style={monoStyle}>~/.codex</span>, …),
					not inside {PRODUCT_NAME}.
				</p>
				<ul style={listStyle}>
					{plan.outOfHomeTargets.map((t) => (
						<li key={t.path} style={itemStyle}>
							<Tag kind="outline">{t.kind}</Tag>
							<span style={monoStyle}>{t.path}</span>
							{/* `sibling` means a local edit survived — say so, don't imply
							    the file was replaced. */}
							{t.action !== "write" && (
								<span className="im-restore-consequences-15">{t.action}</span>
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
								<span className="im-restore-consequences-16">→ {e.resolution}</span>
							)}
						</li>
					))}
				</ul>
			</Group>

			<Group
				title={compact ? "Projects needing a local folder" : "Projects that won't resolve here"}
				count={plan.unresolvedProjects.length}
				testId="restore-unresolved"
				collapsed={compact}
			>
				<p className="im-restore-consequences-17">
					Kept but quarantined — sync skips them until you point each at a real path.
				</p>
				<ul style={listStyle}>
					{plan.unresolvedProjects.map((e) => (
						<li key={e.name} style={itemStyle}>
							<span style={monoStyle}>{e.name}</span>
							<span className="im-restore-consequences-18">{e.path}</span>
						</li>
					))}
				</ul>
			</Group>

			<Group title={compact ? "Items needing attention" : "Warnings"} count={plan.warnings.length} testId="restore-warnings" collapsed={compact}>
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
				<Group title="Kept from this machine" count={1} showCount={false} testId="restore-retained-details" collapsed={compact}>
				<section className="im-restore-consequences-19" data-testid="restore-retained">

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
				</Group>
			)}

			<Group title="Next steps" count={plan.nextSteps.length} testId="restore-next-steps"
				collapsed={compact}>
				<p className="im-restore-consequences-21">
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
