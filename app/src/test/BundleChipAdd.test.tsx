import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { BundleChipAdd } from "@/components/BundleChip";

// A7: BundleChipAdd's menu rows are `ResourceRow role="menuitem"`, not the
// old inline-styled `<button className="avail-skill">`.

describe("BundleChipAdd menu", () => {
	const options = [
		{ name: "android", icon: "🤖", color: "var(--id-2)", count: 3 },
		{ name: "openspec", icon: "📐", color: "var(--id-5)", count: 5 },
	];

	it("renders each option as a role=menuitem ResourceRow", async () => {
		const onPick = vi.fn();
		render(<BundleChipAdd available={options} onPick={onPick} />);

		await userEvent.click(screen.getByRole("button", { name: "Apply bundle" }));

		const item = screen.getByRole("menuitem", { name: /android/ });
		expect(item.classList.contains("resource-row")).toBe(true);
	});

	it("clicking a row calls onPick with its name and closes the menu", async () => {
		const onPick = vi.fn();
		render(<BundleChipAdd available={options} onPick={onPick} />);

		await userEvent.click(screen.getByRole("button", { name: "Apply bundle" }));
		await userEvent.click(screen.getByRole("menuitem", { name: /openspec/ }));

		expect(onPick).toHaveBeenCalledWith("openspec");
		expect(screen.queryByRole("menuitem")).toBeNull();
	});

	it("a mousedown outside the menu closes it and fires onClose", async () => {
		const onPick = vi.fn();
		const onClose = vi.fn();
		render(<BundleChipAdd available={options} onPick={onPick} onClose={onClose} />);

		await userEvent.click(screen.getByRole("button", { name: "Apply bundle" }));
		expect(screen.getByRole("menu")).toBeInTheDocument();

		await userEvent.click(document.body);

		expect(screen.queryByRole("menu")).toBeNull();
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onPick).not.toHaveBeenCalled();
	});
});
