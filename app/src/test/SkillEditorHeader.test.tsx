import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import {
	renderWithProviders,
	sampleRegistry,
	primeRegistry,
	makeQueryClient,
} from "./helpers";
import { SkillEditor } from "@/screens/SkillEditor";
import { readAppCss } from "./readAppCss";

function setupSkillDocMock() {
	vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
		if (cmd === "read_skill_document") {
			const { name } = (args as { name: string }) ?? { name: "" };
			return {
				name,
				description: sampleRegistry.skills[name]?.description ?? "",
				body: `# ${name}\nHello`,
			};
		}
		if (cmd === "check_python") return true;
		if (cmd === "hub_cmd") return { success: true, output: "{}" };
		return undefined;
	});
}

function renderEditor(initialRoute: string) {
	const client = makeQueryClient();
	primeRegistry(client);
	return renderWithProviders(
		<Routes>
			<Route path="/skill/:name" element={<SkillEditor />} />
		</Routes>,
		{ client, initialRoute },
	);
}

beforeEach(setupSkillDocMock);

// A8: the editor header's `.scope-glyph` span is retired in favor of the
// shared `ScopeBadge` gem; `KindTag` is retired in favor of `KindMark`.
describe("SkillEditor header — ScopeBadge replaces .scope-glyph", () => {
	it("renders .scope-badge and no .scope-glyph", async () => {
		const { container } = renderEditor("/skill/rt-android-expert");
		await waitFor(() =>
			expect(screen.getAllByText("rt-android-expert").length).toBeGreaterThan(0),
		);
		const badge = container.querySelector(".scope-badge");
		expect(badge).not.toBeNull();
		expect(badge?.getAttribute("data-scope")).toBe("portable");
		expect(container.querySelector(".scope-glyph")).toBeNull();
	});

	it("app CSS declares no .scope-glyph rule", () => {
		const css = readAppCss();
		expect(css).not.toMatch(/\.scope-glyph/);
	});
});
