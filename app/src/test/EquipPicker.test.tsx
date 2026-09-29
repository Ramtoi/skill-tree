import { describe, it, expect, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { EquipPicker, type EquipTarget } from "@/components/EquipPicker";
import { useAppStore } from "@/store";
import { estimateTokens } from "@/lib/estimateTokens";
import { formatProspectiveSkillLine } from "@/lib/usageGuidance";
import { makeDeferred } from "./helpers";
import { makeQueryClient } from "./helpers";
import { invoke } from "@tauri-apps/api/core";

function wrap(ui: React.ReactElement) {
	return render(<MemoryRouter><QueryClientProvider client={makeQueryClient()}>{ui}</QueryClientProvider></MemoryRouter>);
}

const baseTargets: EquipTarget[] = [
	{ id: "alpha", name: "alpha", state: "off" },
	{ id: "beta", name: "beta", state: "on" },
	{
		id: "gamma",
		name: "gamma",
		state: "via-bundle",
		providedBy: [{ name: "android", href: "/bundle/android" }],
	},
	{ id: "delta", name: "delta", state: "off", disabledReason: "affinity mismatch" },
];

function renderPicker(
	over: Partial<React.ComponentProps<typeof EquipPicker>> = {},
) {
	const onToggle = vi.fn().mockResolvedValue(undefined);
	const onClose = vi.fn();
	wrap(
		<EquipPicker
			subject={{ kind: "skill", name: "myskill" }}
			targets={baseTargets}
			onToggle={onToggle}
			onClose={onClose}
			{...over}
		/>,
	);
	return { onToggle, onClose };
}

describe("EquipPicker", () => {
	it("uses the same primary prospective cost text as Available", async () => {
		const document = { name: "myskill", description: "A real picker test document" };
		vi.mocked(invoke).mockResolvedValue(document as never);
		useAppStore.setState({
			harnesses: [{
				id: "claude-code",
				label: "Claude Code",
				installed: true,
				on_globally: true,
				used_by_projects: [],
				project_skills_dir: ".claude/skills",
			}],
		});
		const line = formatProspectiveSkillLine({ ...document, projectSkillsDir: ".claude/skills" });
		const cost = `~${estimateTokens(line)} tokens`;
		renderPicker({
			targets: [{ id: "alpha", name: "alpha", state: "off", meta: <span className="equip-path">path</span> }],
		});
		// The document read is viewport-gated in production; jsdom has no observer.
		await waitFor(() => expect(screen.getByText(cost)).toBeInTheDocument());
	});
	it("optimistically reflects a toggle and calls onToggle(target, next)", async () => {
		const { onToggle } = renderPicker();
		const box = screen.getByRole("checkbox", { name: /Equip myskill alpha/ });
		expect(box).not.toBeChecked();
		fireEvent.click(box);
		expect(box).toBeChecked(); // optimistic, before promise settles
		await waitFor(() =>
			expect(onToggle).toHaveBeenCalledWith(
				expect.objectContaining({ id: "alpha" }),
				"on",
			),
		);
	});

	it("reverts the row when onToggle rejects", async () => {
		const onToggle = vi.fn().mockRejectedValue(new Error("boom"));
		renderPicker({ onToggle });
		const box = screen.getByRole("checkbox", { name: /Equip myskill alpha/ });
		fireEvent.click(box);
		expect(box).toBeChecked(); // optimistic
		// While pending the checkbox yields to a spinner (R7); re-query once
		// it's back rather than holding a reference to the removed node.
		await waitFor(() =>
			expect(
				screen.getByRole("checkbox", { name: /Equip myskill alpha/ }),
			).not.toBeChecked(),
		); // reverted on reject
	});

	it("renders via-bundle rows read-only with a provider link (no toggle)", () => {
		renderPicker();
		const opt = screen.getByRole("option", { name: /gamma/ });
		expect(within(opt).queryByRole("checkbox")).toBeNull();
		const link = within(opt).getByRole("link", { name: "android" });
		expect(link).toHaveAttribute("href", "/bundle/android");
	});

	it("disables an ineligible target and shows its reason", () => {
		renderPicker();
		const box = screen.getByRole("checkbox", { name: "Equip myskill delta" });
		expect(box).toBeDisabled();
		expect(screen.getByText(/affinity mismatch/)).toBeInTheDocument();
	});

	it("filters the target list by search", () => {
		renderPicker();
		fireEvent.change(screen.getByPlaceholderText("Filter…"), {
			target: { value: "bet" },
		});
		expect(screen.getByRole("option", { name: /beta/ })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: /alpha/ })).toBeNull();
	});

	it("keyboard: ArrowDown then Enter toggles the roving row", async () => {
		const { onToggle } = renderPicker();
		const input = screen.getByPlaceholderText("Filter…");
		fireEvent.keyDown(input, { key: "ArrowDown" }); // active 0 → 1 (beta)
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() =>
			expect(onToggle).toHaveBeenCalledWith(
				expect.objectContaining({ id: "beta" }),
				"off",
			),
		);
	});

	it("Escape closes the popover", () => {
		const { onClose } = renderPicker({ variant: "popover" });
		const input = screen.getByPlaceholderText("Filter…");
		fireEvent.keyDown(input, { key: "Escape" });
		expect(onClose).toHaveBeenCalled();
	});

	it("inline: names its listbox with listLabel and hides the search under the threshold", () => {
		renderPicker({ variant: "inline", filterThreshold: 8, listLabel: "Projects" });
		expect(screen.getByRole("listbox", { name: "Projects" })).toBeInTheDocument();
		expect(screen.queryByPlaceholderText("Filter…")).toBeNull();
	});

	it("inline: Space on a row's checkbox never toggles the hovered row instead", async () => {
		const { onToggle } = renderPicker({ variant: "inline", filterThreshold: 8 });
		// The roving index rests on row 0 (alpha); the user tabs to beta's box.
		const box = screen.getByRole("checkbox", { name: "Unequip myskill beta" });
		box.focus();
		fireEvent.keyDown(box, { key: " " });
		fireEvent.keyDown(box, { key: "Enter" });
		expect(onToggle).not.toHaveBeenCalledWith(expect.objectContaining({ id: "alpha" }), expect.anything());
	});

	it("blast radius: a visible line in the popover, the row's title inline", () => {
		const targets: EquipTarget[] = [
			{ id: "a", name: "a", state: "on", blastRadius: "2 projects lose this skill" },
		];
		renderPicker({ variant: "popover", targets });
		expect(screen.getByText("2 projects lose this skill")).toBeInTheDocument();
	});

	it("blast radius inline rides in the option's title only", () => {
		const targets: EquipTarget[] = [
			{ id: "a", name: "a", state: "on", blastRadius: "2 projects lose this skill" },
		];
		renderPicker({ variant: "inline", targets });
		expect(screen.queryByText("2 projects lose this skill")).toBeNull();
		expect(document.querySelector("#equip-opt-a")).toHaveAttribute(
			"title",
			"2 projects lose this skill",
		);
	});
});

// R7/R8/R9 — the shared in-flight/settled vocabulary (COMPONENTS.md
// §In-flight and settled state, DESIGN.md §5.8).
describe("EquipPicker — in-flight and settled state", () => {
	it("pending: aria-busy, a spinner in the badges column, and no checkbox", async () => {
		const gate = makeDeferred<void>();
		renderPicker({ onToggle: () => gate.promise });
		const box = screen.getByRole("checkbox", { name: /Equip myskill alpha/ });
		fireEvent.click(box);

		const opt = document.getElementById("equip-opt-alpha");
		expect(opt).toHaveAttribute("aria-busy", "true");
		expect(opt?.querySelector(".lds-spinner")).not.toBeNull();
		expect(within(opt as HTMLElement).queryByRole("checkbox")).toBeNull();

		// Settle it so nothing is left in flight when the test exits.
		gate.resolve();
		await act(async () => {
			await gate.promise;
		});
	});

	it("settled: shows `synced` once the write resolves, then clears it after the 2.4s hold and restores the checkbox", async () => {
		vi.useFakeTimers();
		try {
			const gate = makeDeferred<void>();
			renderPicker({ onToggle: () => gate.promise });
			const box = screen.getByRole("checkbox", { name: /Equip myskill alpha/ });
			fireEvent.click(box);

			gate.resolve();
			// Flush the microtask the `await onToggle(...)` continuation runs on.
			await act(async () => {
				await gate.promise;
			});

			const opt = document.getElementById("equip-opt-alpha") as HTMLElement;
			expect(opt).toHaveAttribute("data-settled", "true");
			expect(opt).not.toHaveAttribute("aria-busy");
			expect(within(opt).getByText("synced")).toBeInTheDocument();
			// Pending cleared with the same `finally` as the settle — the
			// checkbox is back immediately, alongside the settled word.
			expect(within(opt).getByRole("checkbox")).toBeInTheDocument();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(2400);
			});

			const settledOpt = document.getElementById("equip-opt-alpha") as HTMLElement;
			expect(settledOpt).not.toHaveAttribute("data-settled");
			expect(within(settledOpt).queryByText("synced")).toBeNull();
			expect(within(settledOpt).getByRole("checkbox")).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejection: no `synced`, no aria-busy, and the checkbox is restored to its prior state", async () => {
		const onToggle = vi.fn().mockRejectedValue(new Error("boom"));
		renderPicker({ onToggle });
		const box = screen.getByRole("checkbox", { name: /Equip myskill alpha/ });
		fireEvent.click(box);

		await waitFor(() => {
			expect(document.getElementById("equip-opt-alpha")).not.toHaveAttribute(
				"aria-busy",
			);
		});

		const opt = document.getElementById("equip-opt-alpha") as HTMLElement;
		expect(opt).not.toHaveAttribute("data-settled");
		expect(within(opt).queryByText("synced")).toBeNull();
		const restored = within(opt).getByRole("checkbox", { name: /Equip myskill alpha/ });
		expect(restored).not.toBeChecked();
	});
});
