import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Snippets } from "@/screens/Snippets";
import { useAppStore } from "@/store";
import type { SnippetInfo } from "@/types/snippets";
import { renderWithProviders, sampleRegistry } from "./helpers";

const LIB: SnippetInfo[] = [
	{
		name: "validation-procedure",
		description: "Validation steps to run at the end of a task.",
		tags: ["workflow", "quality"],
		version: 2,
		created: "",
		updated: "today",
		hash: "aaa111bbb222",
		usage: { count: 2, summary: "outdated", outdated_count: 1 },
	},
	{
		name: "documentation-style",
		description: "House rules for writing docs.",
		tags: ["docs"],
		version: 1,
		created: "",
		updated: "1w ago",
		hash: "ccc333ddd444",
		usage: { count: 0, summary: "none", outdated_count: 0 },
	},
];

const SHOW_VALIDATION = {
	...LIB[0],
	body: "## Validation\n\n1. Build.\n",
	usage: {
		count: 2,
		summary: "outdated" as const,
		outdated_count: 1,
		locations: [
			{
				project: "demo",
				rel: "AGENTS.md",
				path: "/p/AGENTS.md",
				snippet: "validation-procedure",
				version: "2",
				applied_sha: "aaa111bbb222",
				status: "applied" as const,
			},
			{
				project: "other",
				rel: "AGENTS.md",
				path: "/o/AGENTS.md",
				snippet: "validation-procedure",
				version: "1",
				applied_sha: "000999888777",
				status: "outdated" as const,
			},
		],
	},
};

function mockSnippetBackend() {
	vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
		switch (cmd) {
			case "snippets_list":
				return LIB;
			case "snippet_show":
				return SHOW_VALIDATION;
			case "snippet_status":
				return { locations: SHOW_VALIDATION.usage.locations, damaged: [] };
			case "snippet_new":
				return { ...LIB[1], name: (args as { name: string }).name };
			case "snippet_update":
				return {
					action: "update-everywhere",
					snippet: "validation-procedure",
					refreshed: [{}],
					skipped: [SHOW_VALIDATION.usage.locations[0]],
				};
			case "snippet_delete":
				return { deleted: "validation-procedure", orphaned_blocks: [] };
			case "read_registry":
				return sampleRegistry;
			default:
				return undefined;
		}
	});
}

describe("Snippets screen", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
		mockSnippetBackend();
	});

	it("lists snippets and narrows by search", async () => {
		renderWithProviders(<Snippets />);
		expect(await screen.findByText("validation-procedure")).toBeInTheDocument();
		expect(screen.getByText("documentation-style")).toBeInTheDocument();

		fireEvent.change(
			screen.getByPlaceholderText("Search names, descriptions, body…"),
			{ target: { value: "house rules" } },
		);
		expect(screen.queryByText("validation-procedure")).not.toBeInTheDocument();
		expect(screen.getByText("documentation-style")).toBeInTheDocument();
	});

	it("narrows by tag chip filter", async () => {
		renderWithProviders(<Snippets />);
		await screen.findByText("validation-procedure");
		fireEvent.click(screen.getByRole("button", { name: "docs" }));
		expect(screen.queryByText("validation-procedure")).not.toBeInTheDocument();
		expect(screen.getByText("documentation-style")).toBeInTheDocument();
	});

	it("shows scan-derived applied locations with status badges", async () => {
		renderWithProviders(<Snippets />);
		fireEvent.click(await screen.findByText("validation-procedure"));
		expect(await screen.findByText(/Applied to/)).toBeInTheDocument();
		expect(screen.getByText("demo")).toBeInTheDocument();
		expect(screen.getByText("other")).toBeInTheDocument();
		expect(screen.getByTitle("applied")).toBeInTheDocument();
		expect(screen.getByTitle("outdated")).toBeInTheDocument();
	});

	it("update everywhere reports skipped modified blocks", async () => {
		renderWithProviders(<Snippets />);
		fireEvent.click(await screen.findByText("validation-procedure"));
		const btn = await screen.findByTitle("Refresh every outdated location");
		fireEvent.click(btn);
		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith(
				"snippet_update",
				expect.objectContaining({ name: "validation-procedure", all: true }),
			);
		});
		await waitFor(() => {
			const msgs = useAppStore
				.getState()
				.toasts.map((t) => `${t.title} ${t.body ?? ""}`);
			expect(
				msgs.some((m) => m.includes("1 modified block skipped")),
			).toBe(true);
		});
	});

	it("creates a snippet via the inline form", async () => {
		renderWithProviders(<Snippets />);
		await screen.findByText("validation-procedure");
		fireEvent.click(screen.getAllByRole("button", { name: /New snippet/ })[0]);
		fireEvent.change(screen.getByPlaceholderText("e.g. validation-procedure"), {
			target: { value: "review-checklist" },
		});
		fireEvent.click(screen.getByRole("button", { name: /Create snippet/ }));
		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith(
				"snippet_new",
				expect.objectContaining({ name: "review-checklist" }),
			);
		});
	});

	it("rejects invalid names in the create form", async () => {
		renderWithProviders(<Snippets />);
		await screen.findByText("validation-procedure");
		fireEvent.click(screen.getAllByRole("button", { name: /New snippet/ })[0]);
		fireEvent.change(screen.getByPlaceholderText("e.g. validation-procedure"), {
			target: { value: "Bad Name!" },
		});
		expect(
			screen.getByText(/Use lowercase kebab-case/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Create snippet/ }),
		).toBeDisabled();
	});

	it("guarded delete lists affected files and warns about orphaning", async () => {
		renderWithProviders(<Snippets />);
		fireEvent.click(await screen.findByText("validation-procedure"));
		fireEvent.click(await screen.findByRole("button", { name: /Delete snippet/ }));
		const modal = await screen.findByText(/Delete validation-procedure\?/);
		expect(modal).toBeInTheDocument();
		const dialog = document.querySelector(".modal") as HTMLElement;
		expect(within(dialog).getByText(/read as/)).toBeInTheDocument();
		// Both affected files listed in the confirm dialog.
		const dialogFiles = document.querySelectorAll(".snip-delete-file");
		expect(dialogFiles.length).toBe(2);

		fireEvent.click(
			screen.getByRole("button", { name: /Delete · leave 2 orphaned/ }),
		);
		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith("snippet_delete", {
				name: "validation-procedure",
				force: true,
			});
		});
	});

	it("shows empty states for no library and no matches", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd: string) =>
			cmd === "snippets_list"
				? []
				: cmd === "read_registry"
					? sampleRegistry
					: undefined,
		);
		renderWithProviders(<Snippets />);
		expect(await screen.findByText("No snippets yet")).toBeInTheDocument();
	});
});
