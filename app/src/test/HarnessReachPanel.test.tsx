import { useState } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HarnessReachPanel } from "@/components/HarnessReachPanel";
import type { HookCapabilitiesCache } from "@/hooks/useHooks";

// D1 collapsed TWO lists that looked like the same thing (the "reach for
// <event>" badges and the "harness affinity" chips) into one row per harness.
// The merge is only safe if BOTH meanings survive intact: the toggle still
// writes affinity with the empty=all semantics, and the status still tells the
// truth per verdict AND per event.

const CAPS: HookCapabilitiesCache = {
	schema_version: 1,
	probed_at: "2026-07-14T00:00:00Z",
	harnesses: {
		"claude-code": {
			harness_id: "claude-code",
			verdict: "supported",
			reason: "Claude Code is installed; command hooks are supported.",
			extra: {},
		},
		codex: {
			harness_id: "codex",
			verdict: "feature_off",
			reason: "the hooks feature is off — run `codex features enable hooks`.",
			extra: {},
		},
		opencode: {
			harness_id: "opencode",
			verdict: "unsupported",
			reason: "plugins are not hub-managed.",
			extra: {},
		},
		pi: {
			harness_id: "pi",
			verdict: "not_installed",
			reason: "pi is not installed on this machine.",
			extra: {},
		},
	},
};

const INSTALLED = ["claude-code", "codex", "opencode"];

function Harness({
	initial = [] as string[],
	event = "PostToolUse",
	caps = CAPS as HookCapabilitiesCache | null,
	installed = INSTALLED,
	readOnly = false,
}) {
	const [affinity, setAffinity] = useState<string[]>(initial);
	return (
		<>
			<HarnessReachPanel
				installed={installed}
				affinity={affinity}
				onChange={setAffinity}
				capabilities={caps}
				event={event}
				readOnly={readOnly}
			/>
			<div data-testid="affinity">{affinity.join(",")}</div>
		</>
	);
}

const affinity = () => screen.getByTestId("affinity").textContent;

// Rows are `MultiSelectList` options (side-panels wave 4 steer): the
// accessible name of a `role="option"` row is computed from ALL its text,
// including the status badge's own words ("will fire" / "excluded" / …), so
// a query must anchor on the harness name with `\b` rather than match it
// exactly — "Claude Code" alone would never match "Claude Code will fire".
function row(name: string) {
	return screen.getByRole("option", { name: new RegExp(`^${name}\\b`) });
}

describe("HarnessReachPanel — affinity semantics", () => {
	afterEach(cleanup);

	it("empty affinity means ALL: every row reads selected, with the copy to match", () => {
		render(<Harness />);
		for (const label of ["Claude Code", "Codex", "opencode"]) {
			expect(row(label)).toHaveAttribute("aria-selected", "true");
		}
		expect(screen.getByText(/Runs on every effective harness/)).toBeInTheDocument();
	});

	it("turning one off writes an EXPLICIT list of the rest (never an empty=all lie)", () => {
		render(<Harness />);
		fireEvent.click(row("Codex"));
		// Empty affinity would mean "all harnesses", so narrowing has to
		// materialise the survivors.
		expect(affinity()).toBe("claude-code,opencode");
		expect(screen.getByText(/Narrowed/)).toBeInTheDocument();
	});

	it("turning the LAST one off falls back to empty (= all), not a hook that runs nowhere", () => {
		render(<Harness initial={["claude-code"]} />);
		fireEvent.click(row("Claude Code"));
		expect(affinity()).toBe("");
		expect(screen.getByText(/Runs on every effective harness/)).toBeInTheDocument();
	});

	it("never drops a targeted harness that isn't installed here", () => {
		// `pi` is in the affinity but not installed on this machine. Toggling an
		// unrelated row must not quietly rewrite the definition to exclude it.
		render(<Harness initial={["pi"]} />);
		expect(row("Pi")).toHaveAttribute("aria-selected", "true");
		fireEvent.click(row("Claude Code"));
		expect(affinity()?.split(",").sort()).toEqual(["claude-code", "pi"]);
	});

	it("locks the row — with the reason — when there is only ONE installed harness", () => {
		// Turning the only harness off empties the affinity, which the model reads
		// back as "unrestricted": the row springs straight back to selected,
		// nothing changed, and the user is told nothing. There is no narrowing to
		// express with one harness, so the control says so instead of faking an
		// action.
		render(<Harness installed={["claude-code"]} />);
		const toggle = row("Claude Code");
		expect(toggle).toHaveAttribute("aria-selected", "true");
		expect(toggle).toHaveAttribute("aria-disabled", "true");
		expect(toggle).toHaveAttribute(
			"title",
			expect.stringContaining("only installed harness"),
		);
		fireEvent.click(toggle);
		expect(affinity()).toBe("");
		// …and the panel copy explains the state rather than inviting the dead click.
		expect(
			screen.getByText(/Runs on Claude Code — the only installed harness/),
		).toBeInTheDocument();
		expect(screen.queryByText(/Turn one off to narrow it/)).toBeNull();
	});

	it("still allows narrowing when a second row exists (one installed + one targeted elsewhere)", () => {
		// The lock is about having nothing to narrow TO — not about the count of
		// installed harnesses alone. A hook scoped to a harness this machine lacks
		// still has two real rows, and both stay actionable.
		render(<Harness installed={["claude-code"]} initial={["claude-code", "pi"]} />);
		const claude = row("Claude Code");
		expect(claude).not.toHaveAttribute("aria-disabled");
		fireEvent.click(claude);
		expect(affinity()).toBe("pi");
	});

	it("readOnly disables every row and ignores clicks", () => {
		render(<Harness initial={["claude-code"]} readOnly />);
		const toggle = row("Codex");
		expect(toggle).toHaveAttribute("aria-disabled", "true");
		fireEvent.click(toggle);
		expect(affinity()).toBe("claude-code");
	});
});

describe("HarnessReachPanel — reach status", () => {
	afterEach(cleanup);

	it("maps each verdict to its own honest status word", () => {
		render(<Harness />);
		expect(screen.getByLabelText("Claude Code: supported")).toHaveTextContent(
			"will fire",
		);
		// feature_off is NOT amber and NOT "will fire" — it is written but inert.
		expect(screen.getByLabelText("Codex: feature_off")).toHaveTextContent("hooks off");
		expect(screen.getByLabelText("opencode: unsupported")).toHaveTextContent(
			"unsupported",
		);
	});

	it("carries the probe's reason as the row tooltip", () => {
		render(<Harness />);
		expect(screen.getByLabelText("Codex: feature_off")).toHaveAttribute(
			"title",
			expect.stringContaining("hooks feature is off"),
		);
	});

	it("downgrades a reachable harness when the SELECTED event is unsupported there", () => {
		// SessionEnd is claude-only; codex must not claim reach for it.
		render(<Harness event="SessionEnd" />);
		expect(screen.getByLabelText("Claude Code: supported")).toHaveTextContent(
			"will fire",
		);
		expect(screen.getByLabelText("Codex: event unsupported")).toHaveTextContent(
			"event unsupported",
		);
	});

	it("an EXCLUDED harness reads 'excluded' even when the probe says supported", () => {
		// Affinity wins over capability: hub never writes the hook there, so
		// "will fire" would be a straight lie.
		render(<Harness initial={["codex"]} />);
		expect(screen.getByLabelText("Claude Code: excluded")).toHaveTextContent(
			"excluded",
		);
	});

	it("a never-probed cache degrades to 'reach unknown' with the fix in the tooltip", () => {
		render(<Harness caps={null} />);
		const badge = screen.getAllByLabelText(/reach unknown/)[0];
		expect(badge).toHaveTextContent("reach unknown");
		expect(badge).toHaveAttribute(
			"title",
			"Run `hub sync` to probe hook capability per harness.",
		);
	});

	it("renders nothing but an honest note when no harness is installed", () => {
		render(<Harness installed={[]} />);
		expect(screen.getByText("no harnesses installed")).toBeInTheDocument();
	});
});
