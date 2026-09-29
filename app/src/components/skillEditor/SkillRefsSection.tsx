import { useState } from "react";
import { Icon } from "@/components/Icon";
import { SidePanelSection } from "@/components/SidePanelSection";
import { Tag } from "@/components/Tag";
import { useSkillRefs, type SkillRefsHost, type SkillRefsView } from "@/hooks/useSkillRefs";
import type { SkillRefEdgeCount } from "@/lib/skillRefs";
import type { Registry } from "@/types";

export interface SkillRefsSectionProps {
	/** Same object the hook takes. The component calls `useSkillRefs` itself —
	 *  two calls per screen, deliberately, because the hook holds no state. */
	host: SkillRefsHost;
	/** The live editor buffer — outgoing counts move as the author types. */
	content: string;
	registry: Registry;
	/** `SidePanelSection` persistence-map key. Ignored when layout="strip". */
	storageKey?: string;
	/** "section" (default) — a `SidePanelSection` on an editor side panel.
	 *  "strip"            — the Agent Docs pane's editor-strip grammar
	 *                       (`.snip-strip*`), for a host with no side panel.
	 *                       In-memory collapse, default open, no persistence —
	 *                       identical to the `AppliedSnippetsStrip` beside it. */
	layout?: "section" | "strip";
}

/** One row: mono name, a dim mono count, click navigates with the skill as
 *  the back target. */
function RefRow({
	edge,
	testId,
	onOpen,
}: {
	edge: SkillRefEdgeCount;
	testId: string;
	onOpen: (name: string) => void;
}) {
	return (
		<button
			type="button"
			className="skill-ref-row"
			data-testid={testId}
			onClick={() => onOpen(edge.name)}
		>
			<span className="skill-ref-name">{edge.name}</span>
			<span className="skill-ref-count">{edge.count}×</span>
		</button>
	);
}

/** A `refs_ignore` target the body still mentions — struck, dim, tagged, and
 *  never itself navigable: there is no in-app editing of `refs_ignore` in
 *  this wave, CLI only. Only reachable with `host.self`. */
function IgnoredRow({ name }: { name: string }) {
	return (
		<div
			className="skill-ref-row skill-ref-row-ignored"
			title="Muted by hub set-meta --refs-ignore"
		>
			<span className="skill-ref-name">{name}</span>
			<Tag>ignored</Tag>
		</div>
	);
}

/** `a, b +2` — the first two names, then how many more. `0 out` when empty. */
function namesPreview(names: string[]): string {
	if (names.length === 0) return "0 out";
	const shown = names.slice(0, 2).join(", ");
	return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

/**
 * REFERENCES: shared across every host that can carry a skill reference — the
 * skill editor (`host.self` set — MENTIONS + MENTIONED BY, unchanged) and any
 * doc host (harness doc, snippet, project agent doc, sub-agent — `host.self`
 * absent, the section IS the mentions list, no sub-heads, no ignored rows,
 * `mentionedBy` always empty). One title, "References", on every host.
 * Entirely absent when there is nothing to show in either direction —
 * including no muted mentions.
 */
export function SkillRefsSection({
	host,
	content,
	registry,
	storageKey,
	layout = "section",
}: SkillRefsSectionProps) {
	const refs: SkillRefsView = useSkillRefs({ host, content, registry });
	const { mentions, mentionedBy, ignored } = refs;
	// In-memory collapse, default open, no persistence — identical to the
	// `AppliedSnippetsStrip` beside it. Unused (and harmless) for layout="section".
	const [collapsed, setCollapsed] = useState(false);

	if (mentions.length === 0 && mentionedBy.length === 0 && ignored.length === 0) {
		return null;
	}

	// One navigation path for every affordance: the hook's `onOpen` carries the
	// host's back target AND its `wrapNavigate` (a leave guard's bypass), so a
	// panel row behaves exactly like a ⌘-click or a Preview link.
	const openRef = refs.render.onOpen;

	const count = mentions.length + mentionedBy.length;

	if (layout === "strip") {
		return (
			<div
				className="snip-strip"
				data-testid="agent-docs-refs-strip"
				data-collapsed={collapsed || undefined}
			>
				<div className="snip-strip-head">
					<button
						type="button"
						className="snip-strip-toggle"
						data-testid="agent-docs-refs-toggle"
						aria-expanded={!collapsed}
						onClick={() => setCollapsed((c) => !c)}
					>
						<Icon name={collapsed ? "chevronRight" : "chevronDown"} size={11} />
						<Icon name="library" size={12} />
						<span className="snip-strip-title">References</span>
						<span className="snip-strip-count">{mentions.length}</span>
					</button>
				</div>
				{!collapsed && (
					<div className="snip-strip-body">
						<div className="snip-strip-list">
							{mentions.map((edge) => (
								<RefRow
									key={edge.name}
									edge={edge}
									testId={`skill-ref-row-out-${edge.name}`}
									onOpen={openRef}
								/>
							))}
						</div>
					</div>
				)}
			</div>
		);
	}

	// A skill can have zero counted mentions in either direction and still
	// show a row below — its only reference is a muted (`refs_ignore`) one.
	// "none" would read as "nothing here" while that row is visible, so the
	// summary names the muted count instead of collapsing to "none" (S5).
	// The collapsed summary NAMES the referenced skills (up to two, then +N)
	// so the list is readable without expanding; the section also opens by
	// default whenever it has entries (a persisted collapse still wins). A
	// doc host (`host.self` absent) can only ever render with mentions > 0
	// (mentionedBy and ignored are always empty for it), so its summary is
	// just the names — the muted/none branches are unreachable there.
	const summary = host.self
		? count === 0
			? ignored.length > 0
				? `${ignored.length} muted`
				: "none"
			: `${namesPreview(mentions.map((m) => m.name))} · ${mentionedBy.length} in`
		: namesPreview(mentions.map((m) => m.name));

	return (
		<SidePanelSection
			id="refs"
			title="References"
			count={count}
			summary={<span className="text-dim">{summary}</span>}
			storageKey={storageKey}
			defaultOpen={count > 0}
		>
			<div className="skill-refs-stack">
				{host.self && (
					<div className="equip-group">
						<span className="equip-group-name">Mentions</span>
						<span className="equip-group-count">{mentions.length}</span>
					</div>
				)}
				{mentions.length === 0 && ignored.length === 0 ? (
					<div className="text-dim">none</div>
				) : (
					<>
						{mentions.map((edge) => (
							<RefRow
								key={edge.name}
								edge={edge}
								testId={`skill-ref-row-out-${edge.name}`}
								onOpen={openRef}
							/>
						))}
						{ignored.map((name) => (
							<IgnoredRow key={name} name={name} />
						))}
					</>
				)}
				{host.self && (
					<>
						<div className="equip-group">
							<span className="equip-group-name">Mentioned by</span>
							<span className="equip-group-count">{mentionedBy.length}</span>
						</div>
						{mentionedBy.length === 0 ? (
							<div className="text-dim">none</div>
						) : (
							mentionedBy.map((edge) => (
								<RefRow
									key={edge.name}
									edge={edge}
									testId={`skill-ref-row-in-${edge.name}`}
									onOpen={openRef}
								/>
							))
						)}
					</>
				)}
			</div>
		</SidePanelSection>
	);
}
