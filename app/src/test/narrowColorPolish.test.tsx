import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { DriftBadge, humanizeAction } from "@/components/remotes/DriftBadge";
import { SnippetStatusBadge } from "@/components/snippets/SnippetStatusBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { TreeView } from "@/components/TreeView";
import type { Registry } from "@/types";

// ─── D1 amber-sweep invariant: no status/transitional consumer resolves to the
// amber `warn` channel; provenance still can. ──────────────────────────────────

function badgeEl(container: HTMLElement): HTMLElement {
	return container.querySelector(".status-badge") as HTMLElement;
}

describe("amber sweep — DriftBadge channels", () => {
	it.each([
		["remote-drifted", "neutral", "pulse"],
		["orphaned", "neutral", "pulse"],
		["missing", "neutral", "pulse"],
	])("%s → neutral+pulse, never amber/warn", (status, channel, motion) => {
		const { container } = render(<DriftBadge status={status as never} />);
		const el = badgeEl(container);
		expect(el.dataset.channel).toBe(channel);
		expect(el.dataset.channel).not.toBe("warn");
		expect(el.dataset.motion).toBe(motion);
	});

	it("conflict stays the error channel", () => {
		const { container } = render(<DriftBadge status={"conflict" as never} />);
		expect(badgeEl(container).dataset.channel).toBe("error");
	});

	it("in-sync / local-ahead keep their settled endpoints", () => {
		const { container: a } = render(<DriftBadge status={"in-sync" as never} />);
		expect(badgeEl(a).dataset.channel).toBe("ok");
		const { container: b } = render(<DriftBadge status={"local-ahead" as never} />);
		expect(badgeEl(b).dataset.channel).toBe("info");
	});
});

describe("amber sweep — SnippetStatusBadge channels", () => {
	it.each(["outdated", "modified"])(
		"%s → neutral ring + pulse (FreshnessBadge-stale), never warn",
		(status) => {
			const { container } = render(<SnippetStatusBadge status={status as never} />);
			const el = badgeEl(container);
			expect(el.dataset.channel).toBe("neutral");
			expect(el.dataset.channel).not.toBe("warn");
			expect(el.dataset.shape).toBe("ring");
			expect(el.dataset.motion).toBe("pulse");
		},
	);

	it("applied stays ok, orphaned stays neutral", () => {
		const { container: a } = render(<SnippetStatusBadge status={"applied" as never} />);
		expect(badgeEl(a).dataset.channel).toBe("ok");
		const { container: o } = render(<SnippetStatusBadge status={"orphaned" as never} />);
		expect(badgeEl(o).dataset.channel).toBe("neutral");
	});
});

describe("amber sweep — KEEP guard", () => {
	it("a genuine actionable warning still uses the amber warn channel", () => {
		// The affinity 'won't sync here' badge + RiskBadge warning are the two
		// legitimate amber/warn severity uses that survive the sweep.
		const { container } = render(
			<StatusBadge channel="warn">won't sync here</StatusBadge>,
		);
		expect(badgeEl(container).dataset.channel).toBe("warn");
	});
});

describe("humanizeAction", () => {
	it("maps skip verbs to phrases", () => {
		expect(humanizeAction("SKIP_remote_drifted")).toBe("skipped — remote changed");
		expect(humanizeAction("CREATE")).toBe("will create on the box");
	});
	it("falls back to a readable form for unknown verbs", () => {
		expect(humanizeAction("SKIP_something_new")).toBe("skipped — something new");
		expect(humanizeAction("")).toBe("");
	});
});

// ─── TreeView: bundle-provided skill click navigates; direct toggles ───────────

function LocationProbe() {
	const loc = useLocation();
	return <div data-testid="loc">{loc.pathname}</div>;
}

const treeRegistry = {
	version: "1",
	hub_path: "~",
	skills: {
		compose: {
			version: "1.0.0",
			description: "d",
			source: "",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
		},
		direct1: {
			version: "1.0.0",
			description: "d",
			source: "",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
		},
	},
	projects: {},
	bundles: {
		android: {
			description: "Android",
			icon: "🤖",
			scope: "project-specific",
			skills: ["compose"],
		},
	},
} as unknown as Registry;

const treeProject = {
	path: "/p",
	bundles: ["android"], // android applied → compose is bundle-provided
	enabled: ["direct1"], // direct1 is directly equipped
};

describe("TreeView — informative clicks", () => {
	it("clicking a bundle-provided skill navigates to the providing bundle (no dead-end)", () => {
		const onDisable = vi.fn();
		render(
			<MemoryRouter initialEntries={["/project/p"]}>
				<TreeView
					project={treeProject as never}
					projectName="p"
					registry={treeRegistry}
					onApplyBundle={vi.fn()}
					onRemoveBundle={vi.fn()}
					onEnableSkill={vi.fn()}
					onDisableSkill={onDisable}
				/>
				<LocationProbe />
			</MemoryRouter>,
		);
		fireEvent.click(screen.getByText("compose"));
		expect(screen.getByTestId("loc").textContent).toBe("/bundle/android");
		expect(onDisable).not.toHaveBeenCalled();
	});

	it("clicking a directly-equipped skill toggles it (no navigation)", () => {
		const onDisable = vi.fn();
		render(
			<MemoryRouter initialEntries={["/project/p"]}>
				<TreeView
					project={treeProject as never}
					projectName="p"
					registry={treeRegistry}
					onApplyBundle={vi.fn()}
					onRemoveBundle={vi.fn()}
					onEnableSkill={vi.fn()}
					onDisableSkill={onDisable}
				/>
				<LocationProbe />
			</MemoryRouter>,
		);
		fireEvent.click(screen.getByText("direct1"));
		expect(onDisable).toHaveBeenCalledWith("direct1");
		expect(screen.getByTestId("loc").textContent).toBe("/project/p");
	});
});
