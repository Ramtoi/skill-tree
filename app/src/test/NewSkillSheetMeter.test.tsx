import { describe, it, expect, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";
import { renderWithProviders, primeRegistry } from "./helpers";
import { NewSkillSheet } from "@/components/NewSkillSheet";
import { queryClient } from "@/lib/queryClient";

// description-meter.journey.spec.ts: "new skill sheet: description meter
// warns over 200 chars" — `NewSkillSheet.tsx` renders `DescriptionMeter`
// against its own `description` state and moves from `data-tier="ok"` to
// `"cloud"` once the field crosses claude.ai's 200-char limit.

function installInvoke() {
	vi.mocked(invoke).mockImplementation((async (cmd: string) => {
		if (cmd === "read_registry") return queryClient.getQueryData(["registry"]);
		return undefined;
	}) as never);
}

function renderSheet() {
	primeRegistry(queryClient);
	renderWithProviders(<NewSkillSheet open onClose={() => {}} />, {
		client: queryClient,
	});
}

beforeEach(() => {
	queryClient.clear();
	installInvoke();
});

describe("NewSkillSheet — description meter", () => {
	it("starts at data-tier=ok and escalates to cloud past 200 characters", () => {
		renderSheet();

		const meter = document.querySelector(".desc-meter") as HTMLElement;
		expect(meter).not.toBeNull();
		expect(meter).toHaveAttribute("data-tier", "ok");
		expect(meter).toHaveTextContent("0 / 200");

		const description = screen.getByPlaceholderText("One-line description…");
		fireEvent.change(description, { target: { value: "x".repeat(210) } });

		expect(meter).toHaveAttribute("data-tier", "cloud");
		expect(
			meter.querySelector(".desc-meter-note"),
		).toHaveTextContent("Over claude.ai's 200-char limit.");
	});
});
