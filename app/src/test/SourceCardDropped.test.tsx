import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SourceCard } from "@/screens/sources/SourceCard";
import type { DroppedSkill, SourceView } from "@/types";

const SOURCE: SourceView = {
	id: "design-system",
	type: "git",
	name: "Design System",
	builtin: false,
	status: "up-to-date",
	enabled: true,
	skill_count: 3,
	url: "git@github.com:acme/design-system.git",
};

function row(overrides: Partial<DroppedSkill> = {}): DroppedSkill {
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

describe("SourceCard — dropped upstream block", () => {
	it("renders nothing when there are no dropped skills", () => {
		render(<SourceCard source={SOURCE} registry={undefined} detailOpen />);
		expect(screen.queryByTestId(`source-dropped-${SOURCE.id}`)).toBeNull();
		expect(screen.queryByTestId(`source-dropped-count-${SOURCE.id}`)).toBeNull();
	});

	it("shows the block, the head count, and per-row actions in order", () => {
		const rows = [
			row({ name: "ds-tokens", reason: "deleted" }),
			row({
				name: "diagnose",
				reason: "renamed",
				successor: { path: "skills/engineering/diagnosing-bugs", name: "diagnosing-bugs", registered_as: "diagnosing-bugs", similarity: 96 },
			}),
		];
		render(<SourceCard source={SOURCE} registry={undefined} detailOpen dropped={rows} />);

		expect(screen.getByTestId(`source-dropped-count-${SOURCE.id}`)).toHaveTextContent("2");
		const block = screen.getByTestId(`source-dropped-${SOURCE.id}`);
		expect(within(block).getByText("Dropped upstream · 2")).toBeInTheDocument();
		expect(within(block).getByText("ds-tokens")).toBeInTheDocument();
		expect(within(block).getByText("deleted")).toBeInTheDocument();
		expect(within(block).getByText("renamed → diagnosing-bugs")).toBeInTheDocument();
		expect(within(block).getByRole("button", { name: /Forget all 2/ })).toBeInTheDocument();
		// The renamed row offers Open successor; the deleted one does not.
		expect(within(block).getAllByRole("button", { name: "Open successor" })).toHaveLength(1);
		expect(within(block).getAllByRole("button", { name: "Forget" })).toHaveLength(2);
	});

	it("Forget all calls onForgetAllDropped with every row", async () => {
		const onForgetAllDropped = vi.fn();
		const rows = [row({ name: "a" }), row({ name: "b" })];
		render(
			<SourceCard
				source={SOURCE}
				registry={undefined}
				detailOpen
				dropped={rows}
				onForgetAllDropped={onForgetAllDropped}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: /Forget all 2/ }));
		expect(onForgetAllDropped).toHaveBeenCalledWith(rows);
	});

	it("a row's action calls onDroppedAction with the action and the row", async () => {
		const onDroppedAction = vi.fn();
		const rows = [row({ name: "ds-tokens" })];
		render(
			<SourceCard
				source={SOURCE}
				registry={undefined}
				detailOpen
				dropped={rows}
				onDroppedAction={onDroppedAction}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Forget" }));
		expect(onDroppedAction).toHaveBeenCalledWith("forget", rows[0]);
	});

	it("droppedBusy disables every row action and Forget all", () => {
		const rows = [row({ name: "ds-tokens" })];
		render(<SourceCard source={SOURCE} registry={undefined} detailOpen dropped={rows} droppedBusy />);
		expect(screen.getByRole("button", { name: /Forget all/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Forget" })).toBeDisabled();
	});
});
