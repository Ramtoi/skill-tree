import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { HarnessGlyph } from "../harness/HarnessGlyph";
import { harnessLabel } from "../harness/harnessRegistry";
import { TIER_META, type PermissionTier } from "@/lib/permissionTiers";
import { filtersEqual, type HarnessFilter } from "@/lib/permissionHarnessFilter";
import { scopeLabel, type NormalizedPermissions, type RiskFinding, type Rule, type RuleKind, type Scope } from "@/types/permissions";

// Rule-kind chip metadata + the local filter type — PermissionsEditor re-imports these three rather than owning a second copy.
export const KINDS: RuleKind[] = ["allow", "deny", "ask"];
export type PermissionFilter = "all" | RuleKind | "hooks";

export const KIND_META: Record<RuleKind | "hooks", { label: string; accent: string; icon: "check" | "x" | "eye" | "hook"; help: string }> = {
	allow: { label: "ALLOW", accent: "var(--green)", icon: "check", help: "Auto-approved, never prompts" },
	deny: { label: "DENY", accent: "var(--red)", icon: "x", help: "Always blocked, no override" },
	ask: { label: "ASK", accent: "var(--amber)", icon: "eye", help: "Prompts the user before running" },
	hooks: { label: "HOOKS", accent: "var(--anchor)", icon: "hook", help: "Shell commands fired on tool events" },
};

export function cssEscape(s: string): string {
	const w = window as unknown as { CSS?: { escape?: (s: string) => string } };
	return w.CSS?.escape ? w.CSS.escape(s) : s.replace(/"/g, '\\"');
}

/** Serialize the current draft to a permissions.toml string and copy it. */
export async function copyPermissionsToml(
	scope: Scope,
	draft: NormalizedPermissions,
): Promise<void> {
	const q = (s: string) => JSON.stringify(s);
	const arr = (rules: Rule[]) => `[${rules.map((r) => q(r.pattern)).join(", ")}]`;
	const lines: string[] = [`# permissions — ${scopeLabel(scope)}`];
	lines.push(`allow = ${arr(draft.allow)}`);
	lines.push(`deny = ${arr(draft.deny)}`);
	lines.push(`ask = ${arr(draft.ask)}`);
	if (draft.sandbox_mode) lines.push(`sandbox_mode = ${q(draft.sandbox_mode)}`);
	if (draft.approval_policy)
		lines.push(`approval_policy = ${q(draft.approval_policy)}`);
	if (draft.project_trust !== null && draft.project_trust !== undefined)
		lines.push(`project_trust = ${draft.project_trust}`);
	if (draft.additional_dirs.length)
		lines.push(
			`additional_dirs = [${draft.additional_dirs.map(q).join(", ")}]`,
		);
	try {
		await navigator.clipboard.writeText(lines.join("\n") + "\n");
	} catch {
		/* clipboard unavailable (e.g. test env) — no-op */
	}
}

/**
 * Header-subline per-kind counts (`●4 allow · ●3 deny · ●2 ask`). This is the
 * stat hero's at-a-glance read compressed into the header band — the hero
 * itself is gone (it duplicated the toolbar filter chips control-for-control).
 */
export function PermSublineCounts({
	counts,
}: {
	counts: Record<RuleKind, number>;
}) {
	return (
		<span className="perm-subline-counts">
			{KINDS.map((k, i) => (
				<span key={k} className="perm-subline-kind" data-kind={k}>
					{i > 0 && <span className="sep">·</span>}
					<span
						className="dot"
						style={{ background: KIND_META[k].accent }}
						aria-hidden
					/>
					{counts[k]} {k}
				</span>
			))}
		</span>
	);
}

/**
 * One risk-tier group (Read & inspect / Build & package / Network & destructive
 * / Other). Rules of any kind that classify into this tier live here; the tier
 * accent tints the section, while each row keeps its own kind color + switcher.
 */
export function TierSection({
	tier,
	totalCount,
	onAdd,
	children,
}: {
	tier: PermissionTier;
	totalCount: number;
	onAdd: () => void;
	children: ReactNode;
}) {
	const meta = TIER_META[tier];
	return (
		<section
			className="perm-section perm-tier-section"
			data-tier={tier}
			style={{ "--accent": meta.accent } as CSSProperties}
		>
			<header className="perm-section-head">
				<span className="perm-section-bullet" />
				<span className="perm-section-label">{meta.label}</span>
				<span className="perm-tier-caption">{meta.caption}</span>
				<span className="perm-section-count">{totalCount}</span>
				<span className="perm-section-spacer" />
				<button
					type="button"
					className="perm-section-add"
					onClick={onAdd}
					aria-label={`Add rule to ${meta.label}`}
				>
					<Icon name="plus" size={10} />
					Add
				</button>
			</header>
			<div className="perm-section-rows">{children}</div>
		</section>
	);
}


/**
 * Segmented control above the rule list: `All · Common · <installed harness…>`.
 * Always shows All + Common; per-harness tabs only for installed harnesses.
 * Drives the same capability data the affinity chips read (no second matrix).
 * Lives at the top of the permissions side panel (`PermissionsSidePanel`),
 * full-width — it is the screen's one harness selector, and it drives both
 * the rule list filter and which side-panel view renders. A harness tab is
 * glyph-only (the name lives in `title` + `aria-label`; the harness view's
 * own HARNESS fact row is what names the active mode on screen).
 */
export function HarnessFilterTabs({
	installed,
	labels,
	filter,
	onFilter,
}: {
	installed: string[];
	labels?: Record<string, string>;
	filter: HarnessFilter;
	onFilter: (f: HarnessFilter) => void;
}) {
	const tabs: {
		key: string;
		label: ReactNode;
		value: HarnessFilter;
		title?: string;
		ariaLabel?: string;
	}[] = [
		{ key: "all", label: "All", value: "all" },
		{
			key: "common",
			label: "Common",
			value: "common",
			title:
				"Rules expressible on every installed harness — the portable core",
		},
		...installed.map((id) => {
			const name = labels?.[id] ?? harnessLabel(id);
			return {
				key: `harness:${id}`,
				label: (
					<span className="perm-harness-tab-inner">
						<HarnessGlyph id={id} label={name} size={14} decorative />
					</span>
				),
				value: { harness: id } as HarnessFilter,
				title: name,
				ariaLabel: name,
			};
		}),
	];
	return (
		<div
			className="perm-harness-tabs"
			role="group"
			aria-label="Harness view and rule filter"
		>
			{tabs.map((t) => (
				<button
					key={t.key}
					type="button"
					className="perm-harness-tab"
					data-tab={t.key}
					aria-pressed={filtersEqual(filter, t.value)}
					aria-label={t.ariaLabel}
					title={t.title}
					onClick={() => onFilter(t.value)}
				>
					{t.label}
				</button>
			))}
		</div>
	);
}

export function PermissionsRiskBanner({
	risks,
	severity,
	onOpenDoctor,
}: {
	risks: RiskFinding[];
	severity: "danger" | "warning" | null;
	onOpenDoctor: () => void;
}) {
	const first = risks.slice(0, 2);
	const remaining = Math.max(risks.length - first.length, 0);
	return (
		<div className="perm-risk-banner" data-severity={severity ?? "warning"}>
			<Icon name="warning" size={14} />
			<div className="perm-risk-body">
				<strong>
					{risks.length} risk{risks.length === 1 ? "" : "s"} flagged
				</strong>
				<span className="perm-risk-sep"> — </span>
				{first.map((r, i) => (
					<span key={`${r.code}:${r.detail}:${i}`} className="perm-risk-item">
						<code>{r.detail || r.code}</code>
						<span className="perm-risk-code" data-severity={r.severity}>
							{r.code}
						</span>
						{i < first.length - 1 && <span className="perm-risk-sep"> · </span>}
					</span>
				))}
				{remaining > 0 && (
					<span className="perm-risk-more"> · +{remaining} more</span>
				)}
			</div>
			<button
				type="button"
				className="perm-risk-action"
				onClick={onOpenDoctor}
			>
				Open doctor →
			</button>
		</div>
	);
}

/**
 * Project-only "Shared ⇄ Personal" tier switcher. Shared = the committed
 * `permissions` block (`.claude/settings.json`); Personal = the uncommitted
 * `permissions_local` block (`.claude/settings.local.json`). When Personal is
 * active a caption makes the uncommitted nature explicit. Uses neutral
 * section-chrome tokens (no brand violet, no semantic accent).
 */
export function TierToggle({
	personal,
	onChange,
}: {
	personal: boolean;
	onChange: (next: boolean) => void;
}) {
	return (
		<div className="perm-tier-toggle">
			<div
				className="perm-tier-seg"
				role="group"
				aria-label="Permission tier"
			>
				<button
					type="button"
					className="perm-tier-seg-btn"
					data-active={!personal}
					aria-pressed={!personal}
					onClick={() => onChange(false)}
				>
					<Icon name="globe" size={12} />
					Shared
				</button>
				<button
					type="button"
					className="perm-tier-seg-btn"
					data-active={personal}
					aria-pressed={personal}
					onClick={() => onChange(true)}
				>
					<Icon name="pin" size={12} />
					Personal
				</button>
			</div>
			<span className="perm-tier-caption-text">
				{personal
					? "personal · not committed · .claude/settings.local.json"
					: "shared · committed · .claude/settings.json"}
			</span>
		</div>
	);
}

export function PermissionsToolbar({
	search,
	filter,
	riskCount,
	riskSeverity,
	onSearch,
	onFilter,
	onAddRule,
	onDoctor,
	onOpenPresets,
	onOpenImport,
	onOpenMcp,
}: {
	search: string;
	filter: PermissionFilter;
	riskCount: number;
	riskSeverity: "danger" | "warning" | null;
	onSearch: (s: string) => void;
	onFilter: (f: PermissionFilter) => void;
	onAddRule: (k: RuleKind) => void;
	onDoctor: () => void;
	onOpenPresets: () => void;
	onOpenImport: () => void;
	onOpenMcp?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!open) return;
		function onDoc(e: MouseEvent) {
			if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
		}
		function onEsc(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", onDoc);
		document.addEventListener("keydown", onEsc);
		return () => {
			document.removeEventListener("mousedown", onDoc);
			document.removeEventListener("keydown", onEsc);
		};
	}, [open]);

	// Doctor is the one icon square whose label has to survive twice over: as the
	// tooltip AND as the accessible name (its pip is visible children, so
	// Button's title→aria-label fallback doesn't fire for it).
	const doctorLabel =
		riskCount > 0
			? `Doctor — ${riskCount} finding${riskCount === 1 ? "" : "s"}`
			: "Doctor";

	// Counts live in the header subline's colored-dot summary now, so the chips
	// carry the label alone — the same number twice, 20px apart, was buying
	// nothing and costing the row ~70px of the width it needs to stay one line.
	const chips: { key: PermissionFilter; label: string }[] = [
		{ key: "all", label: "ALL" },
		{ key: "allow", label: "ALLOW" },
		{ key: "deny", label: "DENY" },
		{ key: "ask", label: "ASK" },
	];

	const addItems: Array<{
		key: "allow" | "deny" | "ask";
		label: string;
		hint: string;
		accent: string;
	}> = [
		{
			key: "allow",
			label: "Allow rule",
			hint: "auto-approve a pattern",
			accent: KIND_META.allow.accent,
		},
		{
			key: "deny",
			label: "Deny rule",
			hint: "block a pattern",
			accent: KIND_META.deny.accent,
		},
		{
			key: "ask",
			label: "Ask rule",
			hint: "gate behind prompt",
			accent: KIND_META.ask.accent,
		},
	];

	return (
		<div className="perm-toolbar">
			{/* Two wrap units: when the row runs out, the ACTIONS group drops to a
			    second line as a whole, right-aligned — never an orphaned button at
			    the left margin under the search field. */}
			<div className="perm-toolbar-filters">
				<div className="perm-search">
					<Icon name="search" size={12} />
					<input
						aria-label="Search permissions"
						value={search}
						onChange={(e) => onSearch(e.target.value)}
						placeholder="Search rules & patterns…"
					/>
					{search && (
						<button
							type="button"
							className="perm-icon-btn"
							aria-label="Clear search"
							onClick={() => onSearch("")}
						>
							<Icon name="x" size={11} />
						</button>
					)}
				</div>
				<div className="perm-filter-chips">
					{chips.map((c) => (
						<button
							key={c.key}
							type="button"
							aria-pressed={filter === c.key}
							onClick={() => onFilter(c.key)}
						>
							{c.label}
						</button>
					))}
				</div>
			</div>
			<div className="perm-toolbar-actions">
				{/* Occasional actions collapse to 32×32 icon squares: they are
				    detours, not the work, and at full width they were shoving the
				    filter group onto a second line. The label survives as the
				    `title` tooltip AND as the accessible name — sr-only for Doctor,
				    which needs visible children for its pip, and `title`-derived
				    (Button's ariaLabel fallback) for the childless two. */}
				<div className="perm-toolbar-tools">
					<Button
						variant="ghost"
						icon="warning"
						className="perm-tool-btn"
						title={doctorLabel}
						onClick={onDoctor}
					>
						<span className="sr-only">{doctorLabel}</span>
						{riskCount > 0 && (
							<span
								className="perm-doctor-pip"
								data-severity={riskSeverity ?? "warning"}
								aria-hidden="true"
							>
								{riskCount}
							</span>
						)}
					</Button>
					<Button
						variant="ghost"
						icon="spark"
						className="perm-tool-btn"
						title="Presets"
						onClick={onOpenPresets}
					/>
					<Button
						variant="ghost"
						icon="duplicate"
						className="perm-tool-btn"
						title="Import"
						onClick={onOpenImport}
					/>
				</div>
				<div className="perm-add-menu" ref={menuRef}>
					<Button
						variant="primary"
						icon="plus"
						className="perm-add-primary"
						onClick={() => onAddRule("allow")}
					>
						Add allow
					</Button>
					{/* The caret borrows the primary's own `btn btn-primary` skin
					    instead of re-mixing violet by hand, so the two halves are
					    one control by construction; geometry-only overrides live in
					    `.perm-add-primary` / `.perm-add-caret`. */}
					<button
						type="button"
						className="btn btn-primary btn-md perm-add-caret"
						aria-label="Choose permission type"
						aria-haspopup="menu"
						aria-expanded={open}
						onClick={() => setOpen((v) => !v)}
					>
						<Icon name="chevronDown" size={10} />
					</button>
					{open && (
						<div className="perm-add-popover">
							{addItems.map((item) => (
								<button
									key={item.key}
									type="button"
									className="perm-add-menu-item"
									onClick={() => {
										onAddRule(item.key);
										setOpen(false);
									}}
								>
									<span
										className="perm-add-menu-dot"
										style={{ background: item.accent }}
									/>
									<div>
										<div className="lbl">
											Add {item.key}
										</div>
										<div className="hint">{item.hint}</div>
									</div>
								</button>
							))}
							{onOpenMcp && (
								<button type="button" className="perm-add-menu-item" onClick={() => { onOpenMcp(); setOpen(false); }}>
									<span className="perm-add-menu-dot" style={{ background: "var(--ctx)" }} />
									<div><div className="lbl">MCP permissions</div><div className="hint">set decisions for registered servers</div></div>
								</button>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
