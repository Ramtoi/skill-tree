import { describe, it, expect, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, makeQueryClient, sampleRegistry } from "./helpers";
import { SkillEditor } from "@/screens/SkillEditor";

// description-meter.journey.spec.ts: "skill editor: description meter
// escalates and never blocks ⌘S" — a 260-character description escalates
// the meter past the truncation tier, and ⌘S still writes the save (the
// meter is purely informational and never disables the save path).

/** Override read_registry / read_skill_document while chaining every other
 *  command to the default setup.ts implementation, the same pattern
 *  SkillEditorReliability.test.tsx uses. */
function overrideInvoke(
	handlers: Record<string, (args?: unknown) => Promise<unknown>>,
) {
	const mock = vi.mocked(invoke);
	const prev = mock.getMockImplementation();
	mock.mockImplementation(((cmd: string, args?: unknown) => {
		const h = handlers[cmd];
		if (h) return h(args);
		return prev ? prev(cmd as never, args as never) : Promise.resolve(undefined);
	}) as never);
}

function renderEditor(route = "/skill/brainstorm") {
	return renderWithProviders(
		<Routes>
			<Route path="/skill/:name" element={<SkillEditor />} />
			<Route path="/" element={<div>LIBRARY HOME</div>} />
		</Routes>,
		{ client: makeQueryClient(), initialRoute: route },
	);
}

describe("SkillEditor — description meter never blocks save", () => {
	it("a 260-character description escalates the meter and ⌘S still saves", async () => {
		overrideInvoke({
			read_registry: () => Promise.resolve(sampleRegistry),
			read_skill_document: () =>
				Promise.resolve({
					name: "brainstorm",
					description: "Init",
					body: "Body",
				}),
		});

		const { container } = renderEditor();

		await waitFor(() =>
			expect(
				document.querySelector(".cm-content")?.textContent ?? "",
			).toContain("Body"),
		);

		// The description field is the side panel's own textarea — CodeArea
		// (CodeMirror) never renders a plain <textarea> element, so this is
		// unambiguous (SkillEditorReliability.test.tsx's debounced-counter
		// test relies on the same fact).
		const description = container.querySelector("textarea") as HTMLTextAreaElement;
		expect(description).not.toBeNull();

		const longDescription = "x".repeat(260);
		fireEvent.change(description, { target: { value: longDescription } });

		const meter = document.querySelector(".desc-meter") as HTMLElement;
		expect(meter).toHaveAttribute("data-tier", "truncate");
		expect(meter).toHaveTextContent(
			"Claude Code truncates at 250 when deciding to trigger; claude.ai caps at 200.",
		);

		fireEvent.keyDown(window, { key: "s", metaKey: true });

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"save_skill_full",
				expect.objectContaining({
					document: expect.objectContaining({ description: longDescription }),
					meta: expect.objectContaining({ description: longDescription }),
				}),
			),
		);
	});
});
