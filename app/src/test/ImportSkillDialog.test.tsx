import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { ImportSkillDialog } from "@/components/ImportSkillDialog";
import type { SkillPackPreview } from "@/lib/skillPack";

const PATH = "/Users/dev/Downloads/shared-widget.skillpack";

function preview(over: Partial<SkillPackPreview> = {}): SkillPackPreview {
	return {
		valid: true,
		errors: [],
		name: "shared-widget",
		version: "1.4.0",
		description: "A shared widget skill exported from another install.",
		type: "claude-skill",
		scope: "portable",
		files: [
			{ path: "SKILL.md", bytes: 2417 },
			{ path: "reference.md", bytes: 8140 },
			{ path: "scripts/build.py", bytes: 1032 },
		],
		collision: false,
		existing: null,
		...over,
	};
}

function setup(over: Partial<SkillPackPreview> | null = {}) {
	const onClose = vi.fn();
	const onImported = vi.fn();
	render(
		<ImportSkillDialog
			open
			filePath={PATH}
			preview={over === null ? null : preview(over)}
			onClose={onClose}
			onImported={onImported}
		/>,
	);
	return { onClose, onImported };
}

// Anchored both ends so it never collides with the "Import under a different
// name…" link, which is also a button.
const confirmBtn = () =>
	screen.getByRole("button", { name: /^(Import|Importing…)$/ });

beforeEach(() => cleanup());

describe("ImportSkillDialog", () => {
	it("previews the pack: identity, version, description, and every file with a size", () => {
		setup();
		expect(screen.getByText("shared-widget")).toBeInTheDocument();
		expect(screen.getByText("v1.4.0")).toBeInTheDocument();
		expect(screen.getByText(/A shared widget skill/)).toBeInTheDocument();
		expect(screen.getByText(PATH)).toBeInTheDocument();

		const files = screen.getByTestId("import-pack-files");
		expect(files.querySelectorAll("li")).toHaveLength(3);
		expect(screen.getByText("scripts/build.py")).toBeInTheDocument();
		// Sizes are humanised, not raw bytes.
		expect(screen.getByText("2.4 KB")).toBeInTheDocument();
		expect(screen.getByText("1.0 KB")).toBeInTheDocument();
		expect(confirmBtn()).toBeEnabled();
	});

	it("refuses an invalid pack: lists the CLI's errors and blocks confirm", () => {
		setup({ valid: false, errors: ["missing SKILL.md", "unknown format_version"] });
		expect(screen.getByTestId("import-pack-errors")).toBeInTheDocument();
		expect(screen.getByText("missing SKILL.md")).toBeInTheDocument();
		expect(screen.getByText("unknown format_version")).toBeInTheDocument();
		expect(confirmBtn()).toBeDisabled();
	});

	it("blocks confirm while the preview has not resolved", () => {
		setup(null);
		expect(screen.getByText("Reading pack…")).toBeInTheDocument();
		expect(confirmBtn()).toBeDisabled();
	});

	it("on collision, requires a valid slug override before confirm unlocks", async () => {
		setup({ collision: true, existing: { version: "1.0.0" } });
		expect(screen.getByTestId("import-pack-collision")).toBeInTheDocument();
		// A collision cannot be confirmed as-is — the CLI would refuse the write.
		expect(confirmBtn()).toBeDisabled();

		const input = screen.getByLabelText("Import as name");
		await userEvent.type(input, "Bad Name");
		expect(input).toHaveAttribute("aria-invalid", "true");
		expect(confirmBtn()).toBeDisabled();

		await userEvent.clear(input);
		await userEvent.type(input, "shared-widget-2");
		expect(input).not.toHaveAttribute("aria-invalid");
		expect(confirmBtn()).toBeEnabled();
	});

	it("an optional (non-collision) override must still be a legal slug", async () => {
		setup();
		await userEvent.click(
			screen.getByRole("button", { name: /different name/ }),
		);
		const input = screen.getByLabelText("Import as name");
		await userEvent.clear(input);
		await userEvent.type(input, "NOPE_Caps");
		expect(confirmBtn()).toBeDisabled();
	});

	it("confirm runs `skill import <path> --json` and reports the imported name", async () => {
		vi.mocked(invoke).mockImplementation((async () => ({
			success: true,
			output: JSON.stringify({ imported: "shared-widget", files: 3 }),
		})) as never);
		const { onClose, onImported } = setup();

		await userEvent.click(confirmBtn());

		await waitFor(() => expect(onImported).toHaveBeenCalledWith("shared-widget"));
		expect(invoke).toHaveBeenCalledWith("hub_cmd", {
			args: ["skill", "import", PATH, "--json"],
		});
		expect(onClose).toHaveBeenCalled();
	});

	it("confirm forwards the override as --name", async () => {
		vi.mocked(invoke).mockImplementation((async () => ({
			success: true,
			output: JSON.stringify({ imported: "shared-widget-2", files: 3 }),
		})) as never);
		const { onImported } = setup({ collision: true, existing: null });

		await userEvent.type(
			screen.getByLabelText("Import as name"),
			"shared-widget-2",
		);
		await userEvent.click(confirmBtn());

		await waitFor(() =>
			expect(onImported).toHaveBeenCalledWith("shared-widget-2"),
		);
		expect(invoke).toHaveBeenCalledWith("hub_cmd", {
			args: ["skill", "import", PATH, "--json", "--name", "shared-widget-2"],
		});
	});

	it("tolerates stderr noise before the JSON payload", async () => {
		vi.mocked(invoke).mockImplementation((async () => ({
			success: true,
			output:
				"warning: SKILL_HUB_DIR is deprecated\nsyncing…\n" +
				JSON.stringify({ imported: "shared-widget", files: 3 }),
		})) as never);
		const { onImported } = setup();

		await userEvent.click(confirmBtn());
		await waitFor(() => expect(onImported).toHaveBeenCalledWith("shared-widget"));
	});

	it("surfaces a failed apply in-dialog and keeps the dialog open", async () => {
		vi.mocked(invoke).mockImplementation((async () => ({
			success: false,
			output: "error: destination already exists",
		})) as never);
		const { onClose, onImported } = setup();

		await userEvent.click(confirmBtn());

		await waitFor(() =>
			expect(
				screen.getByText(/destination already exists/),
			).toBeInTheDocument(),
		);
		expect(onImported).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		// Recoverable: the user can fix the name and retry.
		expect(confirmBtn()).toBeEnabled();
	});
});
