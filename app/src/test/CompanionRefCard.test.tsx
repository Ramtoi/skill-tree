// D8 — the companion hover card: `SkillRefCard`'s shape (kind, name,
// description, an optional onOpen button) plus the per-harness glyph row.
// Purely presentational: every description is already resolved by the
// caller, including a ref hook's (from the hooks library) — this suite
// covers all four description shapes plan 2's test task names, the glyph
// row, and the onOpen/no-onOpen button contract.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CompanionRefCard } from "@/components/companions/CompanionRefCard";

describe("CompanionRefCard", () => {
	it("shows an agent's frontmatter description", () => {
		render(
			<CompanionRefCard
				kind="agent"
				name="orch-implementer"
				description="Implements the plan."
				harnesses={[]}
			/>,
		);
		expect(screen.getByText("AGENT")).toBeInTheDocument();
		expect(screen.getByText("orch-implementer")).toBeInTheDocument();
		expect(screen.getByText("Implements the plan.")).toBeInTheDocument();
	});

	it("shows an inline hook's '<event> · <command>'", () => {
		render(
			<CompanionRefCard
				kind="hook"
				name="orch-scope-guard"
				description="PreToolUse · scripts/scope-guard.sh"
				harnesses={[]}
			/>,
		);
		expect(screen.getByText("HOOK")).toBeInTheDocument();
		expect(screen.getByText("PreToolUse · scripts/scope-guard.sh")).toBeInTheDocument();
	});

	it("shows a ref hook's description, resolved from the hooks library by the caller", () => {
		render(
			<CompanionRefCard
				kind="hook"
				name="lint-report"
				description="PostToolUse · scripts/lint.sh"
				harnesses={[]}
			/>,
		);
		expect(screen.getByText("PostToolUse · scripts/lint.sh")).toBeInTheDocument();
	});

	it("shows a rule's '<kind> · <pattern>'", () => {
		render(
			<CompanionRefCard
				kind="permission"
				name="Bash(git push --force:*)"
				description="deny · Bash(git push --force:*)"
				harnesses={[]}
			/>,
		);
		expect(screen.getByText("RULE")).toBeInTheDocument();
		expect(screen.getByText("deny · Bash(git push --force:*)")).toBeInTheDocument();
	});

	it("falls back to 'No description.' when none is given", () => {
		render(<CompanionRefCard kind="agent" name="orch-implementer" harnesses={[]} />);
		expect(screen.getByText("No description.")).toBeInTheDocument();
	});

	it("renders the per-harness glyph row, one glyph per harness in state order", () => {
		render(
			<CompanionRefCard
				kind="agent"
				name="orch-implementer"
				harnesses={[
					{ harness: "claude-code", state: "provisioned" },
					{ harness: "codex", state: "unsupported", reason: "no sub-agent definitions" },
				]}
			/>,
		);
		const glyphs = document.querySelectorAll(".companion-glyph");
		expect(glyphs).toHaveLength(2);
		expect(glyphs[0]).toHaveAttribute("data-harness", "claude-code");
		expect(glyphs[0]).toHaveAttribute("data-state", "lit");
		expect(glyphs[1]).toHaveAttribute("data-harness", "codex");
		expect(glyphs[1]).toHaveAttribute("data-state", "unsupported");
		expect(glyphs[1].querySelector(".sr-only")?.textContent).toContain(
			"no sub-agent definitions",
		);
	});

	it("omits a glyph entirely for a 'missing'/'stale' state (Risk 3 — no meaningful presence to show)", () => {
		render(
			<CompanionRefCard
				kind="hook"
				name="ghost-hook"
				harnesses={[{ harness: "claude-code", state: "missing" }]}
			/>,
		);
		expect(document.querySelector(".companion-glyph")).toBeNull();
	});

	it("renders the name as a real button and calls onOpen when clicked", () => {
		const onOpen = vi.fn();
		render(
			<CompanionRefCard kind="hook" name="orch-scope-guard" harnesses={[]} onOpen={onOpen} />,
		);
		const btn = screen.getByRole("button", { name: "orch-scope-guard" });
		btn.click();
		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it("without onOpen, the name renders as plain (non-interactive) text", () => {
		render(<CompanionRefCard kind="hook" name="orch-scope-guard" harnesses={[]} />);
		expect(screen.queryByRole("button", { name: "orch-scope-guard" })).toBeNull();
		expect(screen.getByText("orch-scope-guard")).toBeInTheDocument();
	});

	it("shows the ⌘-click hint only when showHint is set", () => {
		render(
			<CompanionRefCard
				kind="agent"
				name="orch-implementer"
				harnesses={[]}
				showHint
				onOpen={() => {}}
			/>,
		);
		expect(screen.getByText("⌘-click to open")).toBeInTheDocument();
	});
});
