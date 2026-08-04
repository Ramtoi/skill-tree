import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { ImportMergeDialog } from "@/components/ImportMergeDialog";
import type { ImportCandidateSet } from "@/types/permissions";

const CANDIDATES: ImportCandidateSet = {
	scope_kind: "global",
	project: null,
	merged: [
		{
			pattern: "Bash(npm:*)",
			kind: "allow",
			harnesses: null,
			sources: [
				{ harness: "claude-code", source: "settings.json" },
				{ harness: "codex", source: "default.rules" },
			],
		},
	],
	conflicts: [
		{
			pattern: "Bash(git:*)",
			options: { allow: ["claude-code"], ask: ["codex"] },
		},
	],
	un_importable: [
		{
			source: "default.rules",
			harness: "codex",
			reason: "uses match/not_match argument constraints",
			file: "/x/default.rules",
		},
	],
};

describe("ImportMergeDialog", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("renders candidates, conflicts, and un-importable rows", async () => {
		vi.mocked(invoke).mockResolvedValue(CANDIDATES);
		render(
			<ImportMergeDialog
				open
				scope={{ kind: "global" }}
				onClose={() => {}}
				onApplied={() => {}}
			/>,
		);
		expect(
			await screen.findByTestId("import-merged-row"),
		).toBeInTheDocument();
		expect(screen.getByText("Bash(npm:*)")).toBeInTheDocument();
		expect(screen.getByTestId("import-conflict-row")).toBeInTheDocument();
		expect(screen.getByText("Bash(git:*)")).toBeInTheDocument();
		// Un-importable shown read-only with its reason.
		const unimp = screen.getByTestId("import-unimportable-row");
		expect(unimp).toHaveTextContent(/match\/not_match/);
		expect(unimp).toHaveTextContent("read-only");
	});

	it("applies decisions with the chosen actions", async () => {
		vi.mocked(invoke).mockImplementation((cmd: string) => {
			if (cmd === "permissions_import_candidates")
				return Promise.resolve(CANDIDATES);
			return Promise.resolve({ imported: 1, dropped: 0, kept: 0 });
		});
		const onApplied = vi.fn();
		render(
			<ImportMergeDialog
				open
				scope={{ kind: "global" }}
				onClose={() => {}}
				onApplied={onApplied}
			/>,
		);
		await screen.findByTestId("import-merged-row");
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));

		await waitFor(() => expect(onApplied).toHaveBeenCalled());
		const applyCall = vi
			.mocked(invoke)
			.mock.calls.find((c) => c[0] === "permissions_import_apply");
		expect(applyCall).toBeTruthy();
		const payload = applyCall?.[1] as { decisions: unknown[] };
		// merged npm imported + conflict "both" → 2 decisions for git (allow+ask).
		expect(payload.decisions).toContainEqual(
			expect.objectContaining({
				pattern: "Bash(npm:*)",
				action: "import",
				kind: "allow",
			}),
		);
		const gitDecisions = payload.decisions.filter(
			(d) => (d as { pattern: string }).pattern === "Bash(git:*)",
		);
		expect(gitDecisions).toHaveLength(2);
	});
});
