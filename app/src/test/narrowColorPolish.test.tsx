import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { DriftBadge, humanizeAction } from "@/components/remotes/DriftBadge";
import { SnippetStatusBadge } from "@/components/snippets/SnippetStatusBadge";
import { StatusBadge } from "@/components/StatusBadge";

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
		// `channel` is always "neutral" here (never "warn"), so the equality
		// check above already entails a separate `not.toBe("warn")`.
		expect(el.dataset.channel).toBe(channel);
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
			// "neutral" already rules out "warn"; a separate not.toBe is entailed.
			expect(el.dataset.channel).toBe("neutral");
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
