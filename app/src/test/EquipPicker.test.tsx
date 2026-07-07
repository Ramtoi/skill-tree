import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { EquipPicker, type EquipTarget } from "@/components/EquipPicker";

function wrap(ui: React.ReactElement) {
	return render(<MemoryRouter>{ui}</MemoryRouter>);
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
		await waitFor(() => expect(box).not.toBeChecked()); // reverted on reject
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
});
