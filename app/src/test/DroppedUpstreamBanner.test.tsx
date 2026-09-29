import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DroppedUpstreamBanner } from "@/components/DroppedUpstreamBanner";
import type { DroppedSkill } from "@/types";

function dropped(overrides: Partial<DroppedSkill> = {}): DroppedSkill {
	return {
		name: "diagnose",
		source: "design-system",
		source_name: "Design System",
		path: "skills/engineering/diagnose",
		ref: "abc1234",
		ref_short: "abc1234",
		last_seen_at: "2026-07-05T09:12:00+02:00",
		reason: "deleted",
		successor: null,
		equipped: { projects: [], bundles: [], remotes: [], cloud: [] },
		recoverable: true,
		skill_md: null,
		...overrides,
	};
}

describe("DroppedUpstreamBanner", () => {
	it("deleted: primary is Forget, no Open successor offered", () => {
		render(<DroppedUpstreamBanner dropped={dropped()} onAction={vi.fn()} busy={false} />);
		expect(screen.getByRole("button", { name: "Forget" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Open successor" })).toBeNull();
		expect(screen.getByText(/Deleted upstream/)).toBeInTheDocument();
	});

	it("renamed with a registered successor: primary is Open successor, Forget moves to overflow", () => {
		render(
			<DroppedUpstreamBanner
				dropped={dropped({
					reason: "renamed",
					successor: {
						path: "skills/engineering/diagnosing-bugs",
						name: "diagnosing-bugs",
						registered_as: "diagnosing-bugs", similarity: 96,
					},
				})}
				onAction={vi.fn()}
				busy={false}
			/>,
		);
		expect(screen.getByRole("button", { name: "Open successor" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Forget" })).toBeInTheDocument();
		// The successor's name and its registry key are the same string here —
		// "registered as diagnosing-bugs" would just repeat "diagnosing-bugs".
		expect(screen.getByText("Renamed upstream to diagnosing-bugs (in your library)")).toBeInTheDocument();
	});

	it("renamed with a DIFFERENT registered key: keeps the two-part 'registered as' form", () => {
		render(
			<DroppedUpstreamBanner
				dropped={dropped({
					reason: "renamed",
					successor: {
						path: "skills/engineering/diagnosing-bugs",
						name: "diagnosing-bugs",
						registered_as: "diagnosing-bugs-local",
						similarity: 96,
					},
				})}
				onAction={vi.fn()}
				busy={false}
			/>,
		);
		expect(
			screen.getByText("Renamed upstream to diagnosing-bugs · registered as diagnosing-bugs-local"),
		).toBeInTheDocument();
	});

	it("renamed WITHOUT a registered successor: primary falls back to Forget (Keep as local is never primary)", () => {
		render(
			<DroppedUpstreamBanner
				dropped={dropped({
					reason: "renamed",
					successor: { path: "skills/x", name: "x", registered_as: null, similarity: 40 },
					recoverable: true,
				})}
				onAction={vi.fn()}
				busy={false}
			/>,
		);
		expect(screen.queryByRole("button", { name: "Open successor" })).toBeNull();
		expect(screen.getByRole("button", { name: "Forget" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Keep as local" })).toBeInTheDocument();
	});

	it("clicking an action calls onAction with that action", async () => {
		const onAction = vi.fn();
		render(<DroppedUpstreamBanner dropped={dropped({ recoverable: true })} onAction={onAction} busy={false} />);
		await userEvent.click(screen.getByRole("button", { name: "Keep as local" }));
		expect(onAction).toHaveBeenCalledWith("keep-local");
	});

	it("a below-confidence rename guess shows a hedge line, and Forget stays primary", () => {
		render(
			<DroppedUpstreamBanner
				dropped={dropped({
					reason: "deleted",
					successor: null,
					possible_successor: {
						path: "skills/design-tokens-v2",
						name: "design-tokens-v2",
						registered_as: null,
						similarity: 62,
					},
				})}
				onAction={vi.fn()}
				busy={false}
			/>,
		);
		expect(screen.getByText(/Possibly renamed to design-tokens-v2 \(62% similar\)/)).toBeInTheDocument();
		// registered_as is null → no Open link, and the primary is still Forget.
		expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
		expect(screen.getByRole("button", { name: "Forget" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Open successor" })).toBeNull();
	});

	it("a hedge with a REGISTERED candidate shows a plain Open link, still never primary", async () => {
		const onOpenPossibleSuccessor = vi.fn();
		render(
			<DroppedUpstreamBanner
				dropped={dropped({
					reason: "deleted",
					successor: null,
					possible_successor: {
						path: "skills/design-tokens-v2",
						name: "design-tokens-v2",
						registered_as: "design-tokens-v2",
						similarity: 78,
					},
				})}
				onAction={vi.fn()}
				onOpenPossibleSuccessor={onOpenPossibleSuccessor}
				busy={false}
			/>,
		);
		expect(screen.getByRole("button", { name: "Forget" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Open" }));
		expect(onOpenPossibleSuccessor).toHaveBeenCalledWith("design-tokens-v2");
	});

	it("busy disables every action", () => {
		render(
			<DroppedUpstreamBanner
				dropped={dropped({ recoverable: true })}
				onAction={vi.fn()}
				busy
			/>,
		);
		expect(screen.getByRole("button", { name: /Forget/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Keep as local" })).toBeDisabled();
	});
});
