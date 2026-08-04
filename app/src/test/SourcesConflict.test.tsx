import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, sampleRegistry, makeQueryClient } from "./helpers";
import { Sources } from "@/screens/Sources";

describe("Sources — per-conflict resolution", () => {
	let applyArgs: { args: string[]; decisions: Record<string, string> } | null;

	beforeEach(() => {
		applyArgs = null;
		vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
			if (cmd === "read_registry") return Promise.resolve(sampleRegistry);
			if (cmd === "source_add_apply") {
				applyArgs = args as { args: string[]; decisions: Record<string, string> };
				return Promise.resolve({
					ok: true,
					registered: ["code-review-2"],
					skipped: [],
					resolved: [
						{ name: "code-review", action: "suffix", final_name: "code-review-2" },
					],
					counts: { registered: 1 },
				});
			}
			if (cmd === "hub_cmd") {
				const a = (args as { args: string[] }).args;
				if (a[0] === "source" && a[1] === "list")
					return Promise.resolve({ success: true, output: '{"sources":[],"errors":[]}' });
				if (a[0] === "source" && a[1] === "add" && a.includes("--dry-run")) {
					return Promise.resolve({
						success: true,
						output: JSON.stringify({
							ok: true,
							counts: { new: 0, conflicts: 1, imported: 0, invalid: 0 },
							candidates: [
								{ name: "code-review", category: "CONFLICT", origin_path: "skills/code-review" },
							],
						}),
					});
				}
				return Promise.resolve({ success: true, output: "" });
			}
			return Promise.resolve(undefined);
		});
	});

	it("previews a conflict, resolves it as import-renamed, and applies suffix", async () => {
		renderWithProviders(<Sources />, {
			client: makeQueryClient(),
			initialRoute: "/?add=1",
		});

		// Fill URL + preview.
		fireEvent.change(screen.getByPlaceholderText("git@github.com:org/skills.git"), {
			target: { value: "git@github.com:org/pack.git" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Preview" }));

		// The conflict resolver surfaces the conflicting candidate.
		const row = await screen.findByTestId("conflict-code-review");
		expect(row).toBeInTheDocument();

		// Choose "Import renamed" (→ suffix) then apply.
		fireEvent.click(screen.getByRole("button", { name: "Import renamed" }));
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));

		await waitFor(() => expect(applyArgs).not.toBeNull());
		expect(applyArgs!.decisions).toEqual({ "code-review": "suffix" });
		// The resolved final name is shown after apply.
		expect(await screen.findByTestId("resolved-code-review")).toHaveTextContent(
			"code-review-2",
		);
	});

	it("defaults an untouched conflict to skip (keep-mine)", async () => {
		renderWithProviders(<Sources />, {
			client: makeQueryClient(),
			initialRoute: "/?add=1",
		});
		fireEvent.change(screen.getByPlaceholderText("git@github.com:org/skills.git"), {
			target: { value: "git@github.com:org/pack.git" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Preview" }));
		await screen.findByTestId("conflict-code-review");
		// Apply enabled only once a non-skip decision is chosen; choose replace.
		fireEvent.click(screen.getByRole("button", { name: "Take theirs" }));
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		await waitFor(() => expect(applyArgs).not.toBeNull());
		expect(applyArgs!.decisions["code-review"]).toBe("replace");
	});

	it("switches from entry to preview instead of stacking both steps", async () => {
		renderWithProviders(<Sources />, {
			client: makeQueryClient(),
			initialRoute: "/?add=1",
		});
		fireEvent.change(screen.getByPlaceholderText("git@github.com:org/skills.git"), {
			target: { value: "git@github.com:org/pack.git" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Preview" }));

		await screen.findByTestId("conflict-code-review");

		expect(screen.getAllByRole("dialog")).toHaveLength(1);
		expect(
			screen.queryByPlaceholderText("git@github.com:org/skills.git"),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Apply" })).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		expect(screen.getByRole("button", { name: "Apply" })).toHaveAttribute(
			"title",
			"Choose a conflict resolution or import at least one new skill.",
		);
	});
});
