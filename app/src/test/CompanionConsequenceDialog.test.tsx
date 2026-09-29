import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CompanionConsequenceDialog } from "@/components/companions/CompanionConsequenceDialog";
import type { NeedsCompanions } from "@/lib/companions";

/**
 * A synthetic 3-harness payload (wave 1's follow-up note: the mock registry's
 * `buildCompanionItems` only ever produces claude-code + codex for the
 * fixture projects it knows, so the dialog's OWN tests build the payload by
 * hand rather than relying on it). Deliberately shaped so every harness has
 * BOTH a `will_write` item (feeding its summary) and a non-`will_write` item
 * (feeding its fold line) — the exact "7 rows" default shape the plan pins:
 * 3 harness summaries + 1 trust row (codex only, never folded) + 3 fold
 * lines. Counts land on the D6 fixture's own totals (5 agents, 3 hooks,
 * 2 rules) by construction, not by copying it.
 */
const PAYLOAD: NeedsCompanions = {
	skill: "orchestrate-advanced",
	project: "moon-base",
	items: [
		// claude-code — 3 write (2 agents, 1 hook), 1 folded (1 rule)
		{
			kind: "agent",
			name: "orch-researcher",
			harness: "claude-code",
			target: "~/.claude/agents/orch-researcher.md",
			verdict: "will_write",
			scope: "user",
		},
		{
			kind: "agent",
			name: "orch-planner",
			harness: "claude-code",
			target: "~/.claude/agents/orch-planner.md",
			verdict: "will_write",
			scope: "user",
		},
		{
			kind: "hook",
			name: "orch-scope-guard",
			harness: "claude-code",
			target: "<repo>/.claude/settings.local.json",
			verdict: "will_write",
			activation: "while-running",
		},
		{
			kind: "permission",
			name: "Bash(gh pr merge:*)",
			harness: "claude-code",
			target: "<repo>/.claude/settings.json",
			verdict: "already_present",
			rule_kind: "ask",
		},
		// codex — 1 trust (pinned), 2 write (1 agent, 1 rule), 2 folded (2 hooks,
		// same reason — one fold line, not two)
		{
			kind: "trust",
			name: "trust_level",
			harness: "codex",
			target: "~/.codex/config.toml",
			verdict: "will_write",
			reason: "Codex runs a project's committed config.toml and hooks once trusted",
		},
		{
			kind: "agent",
			name: "orch-implementer",
			harness: "codex",
			target: "~/.codex/agents/orch-implementer.toml",
			verdict: "will_write",
			scope: "user",
		},
		{
			kind: "permission",
			name: "Bash(git push --force:*)",
			harness: "codex",
			target: "<repo>/.codex/rules/skill-hub.rules",
			verdict: "will_write",
			rule_kind: "deny",
		},
		{
			kind: "hook",
			name: "orch-report-guard",
			harness: "codex",
			target: "<repo>",
			verdict: "unsupported",
			activation: "while-running",
			reason: "Codex skips project-attached hooks",
		},
		{
			kind: "hook",
			name: "orch-unit-brief",
			harness: "codex",
			target: "<repo>",
			verdict: "unsupported",
			activation: "while-running",
			reason: "Codex skips project-attached hooks",
		},
		// pi — 1 write (1 agent), 1 folded (1 agent)
		{
			kind: "agent",
			name: "orch-reviewer",
			harness: "pi",
			target: "~/.pi/agents/orch-reviewer.md",
			verdict: "will_write",
			scope: "user",
		},
		{
			kind: "agent",
			name: "orch-griller",
			harness: "pi",
			target: "~/.pi/agents/orch-griller.md",
			verdict: "unsupported",
			scope: "user",
			reason: "no sub-agent definitions",
		},
	],
};

function renderDialog(overrides: Partial<React.ComponentProps<typeof CompanionConsequenceDialog>> = {}) {
	return render(
		<CompanionConsequenceDialog
			open
			payload={PAYLOAD}
			onConfirm={vi.fn()}
			onClose={vi.fn()}
			{...overrides}
		/>,
	);
}

describe("CompanionConsequenceDialog", () => {
	it("renders exactly 7 rows by default: 3 summaries + 1 trust row + 3 folded lines", () => {
		renderDialog();
		// `Modal` portals into `document.body` (COMPONENTS.md's overlay system),
		// so the rendered rows live OUTSIDE RTL's `container` — query the
		// document, the same way `screen` already does.
		const rows = document.querySelectorAll(
			".companion-harness-summary, .companion-trust-row, .companion-folded-line",
		);
		expect(rows).toHaveLength(7);
		expect(document.querySelectorAll(".companion-harness-summary")).toHaveLength(3);
		expect(document.querySelectorAll(".companion-trust-row")).toHaveLength(1);
		expect(document.querySelectorAll(".companion-folded-line")).toHaveLength(3);
		// Neither harness's item list is on screen yet — every disclosure starts
		// collapsed (W7's "default view", the very thing that keeps 7 rows
		// legible at 520px with no scroll; the pixel-level claim is proved by
		// the `companion-consequence-dialog` visual scene, not jsdom layout).
		expect(screen.queryByText("orch-researcher")).not.toBeInTheDocument();
	});

	it("orders the codex group header → trust row → fold line (A2/C7), trust row has no fold control", () => {
		renderDialog();
		const codexToggle = screen.getByTestId("side-section-companion-codex");
		const codexGroup = codexToggle.closest(".companion-harness-group");
		expect(codexGroup).not.toBeNull();

		const children = Array.from(codexGroup!.children);
		const headerIndex = children.findIndex((c) =>
			c.classList.contains("side-panel-section-head-row"),
		);
		const trustIndex = children.findIndex((c) => c.classList.contains("companion-trust-row"));
		const foldIndex = children.findIndex((c) => c.classList.contains("companion-folded-line"));
		expect(headerIndex).toBeGreaterThanOrEqual(0);
		// The trust row reads as attached to the group ONLY if it renders below
		// the CODEX header, never above it (the defect this test pins).
		expect(trustIndex).toBeGreaterThan(headerIndex);
		expect(foldIndex).toBeGreaterThan(trustIndex);

		const trustRow = children[trustIndex] as HTMLElement;
		expect(within(trustRow).queryByRole("button")).not.toBeInTheDocument();

		// Only ONE trust row anywhere, and it lives in the codex group.
		expect(document.querySelectorAll(".companion-trust-row")).toHaveLength(1);
	});

	it("carries the fold reason in words", () => {
		renderDialog();
		expect(
			screen.getByText("2 hooks not written — Codex skips project-attached hooks"),
		).toBeInTheDocument();
		expect(screen.getByText("1 rule not written — already there")).toBeInTheDocument();
		expect(
			screen.getByText("1 agent not written — no sub-agent definitions"),
		).toBeInTheDocument();
	});

	it("expanding a harness summary reveals its write-item list", () => {
		renderDialog();
		expect(screen.queryByText("orch-researcher")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
		expect(screen.getByText("orch-researcher")).toBeInTheDocument();
		expect(screen.getByText("orch-planner")).toBeInTheDocument();
		expect(screen.getByText("orch-scope-guard")).toBeInTheDocument();
		// The folded rule never joins the expanded write-item list.
		expect(screen.queryByText("Bash(gh pr merge:*)")).not.toBeInTheDocument();
	});

	it("shows both action labels", () => {
		renderDialog();
		expect(screen.getByRole("button", { name: "Equip with companions" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Equip skill only" })).toBeInTheDocument();
	});

	it("never uses the warn (amber) channel outside the trust row", () => {
		renderDialog();
		fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
		fireEvent.click(screen.getByRole("button", { name: "Codex" }));
		fireEvent.click(screen.getByRole("button", { name: "Pi" }));
		const warnBadges = document.querySelectorAll('.status-badge[data-channel="warn"]');
		expect(warnBadges.length).toBeGreaterThan(0);
		for (const badge of Array.from(warnBadges)) {
			expect(badge.closest(".companion-trust-row")).not.toBeNull();
		}
	});

	it("calls onConfirm / onClose from the dialog's two actions", () => {
		const onConfirm = vi.fn();
		const onClose = vi.fn();
		renderDialog({ onConfirm, onClose });
		fireEvent.click(screen.getByRole("button", { name: "Equip with companions" }));
		expect(onConfirm).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "Equip skill only" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("renders nothing when closed", () => {
		renderDialog({ open: false });
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	// Review S-2: a project-less plan_provision (W-4) has no target to name.
	// A `null` target must never reach `PathText` (which expects a real path
	// string) — it renders a neutral "no file" wording instead.
	it("renders a neutral 'no file' wording for a null target instead of crashing", () => {
		const payload: NeedsCompanions = {
			skill: "orchestrate-advanced",
			project: "moon-base",
			items: [
				{
					kind: "agent",
					name: "orch-implementer",
					harness: "claude-code",
					target: null,
					verdict: "will_write",
					scope: "user",
				},
			],
		};
		expect(() => renderDialog({ payload })).not.toThrow();
		fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
		expect(screen.getByText("orch-implementer")).toBeInTheDocument();
		expect(screen.getByText("no file")).toBeInTheDocument();
	});
});
