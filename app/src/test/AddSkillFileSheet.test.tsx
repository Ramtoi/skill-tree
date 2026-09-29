import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { AddSkillFileSheet } from "@/components/skillFiles/AddSkillFileSheet";
import {
	absorbTypedPath,
	kindForRel,
	relForKind,
	SKILL_FILE_KIND_META,
} from "@/lib/skillFileKinds";

describe("skillFileKinds", () => {
	it("names the three Agent Skills folders and a free path", () => {
		expect(SKILL_FILE_KIND_META.reference.folder).toBe("references");
		expect(SKILL_FILE_KIND_META.script.folder).toBe("scripts");
		expect(SKILL_FILE_KIND_META.asset.folder).toBe("assets");
		expect(SKILL_FILE_KIND_META.other.folder).toBeNull();
	});

	it("derives the kind from a typed path and strips its folder", () => {
		expect(kindForRel("scripts/run.sh")).toBe("script");
		expect(kindForRel("deep/scripts/run.sh")).toBeNull();
		expect(absorbTypedPath("reference", "scripts/run.sh")).toEqual({ kind: "script", rest: "run.sh" });
		expect(absorbTypedPath("reference", "references/")).toEqual({ kind: "reference", rest: "" });
		expect(absorbTypedPath("other", "assets/a/b.png")).toEqual({ kind: "asset", rest: "a/b.png" });
		// An absolute path frees the kind so the validator can name the refusal.
		expect(absorbTypedPath("reference", "/etc/passwd")).toEqual({ kind: "other", rest: "/etc/passwd" });
		expect(absorbTypedPath("script", "deep/x.sh")).toEqual({ kind: "script", rest: "deep/x.sh" });
		expect(relForKind("asset", "logo.png")).toBe("assets/logo.png");
		expect(relForKind("other", "notes.md")).toBe("notes.md");
	});
});

describe("AddSkillFileSheet", () => {
	const created: Array<{ name: string; rel: string }> = [];
	beforeEach(() => {
		created.length = 0;
		vi.mocked(invoke).mockImplementation(async (cmd, args) => {
			if (cmd === "skill_file_create") {
				created.push(args as { name: string; rel: string });
				return { hash: "h" };
			}
			return null;
		});
	});

	function renderSheet() {
		const onCreated = vi.fn();
		const onClose = vi.fn();
		render(<AddSkillFileSheet open skillName="brainstorm" onClose={onClose} onCreated={onCreated} />);
		return { onCreated, onClose };
	}

	it("leads with the kind, Reference by default, and prefixes the path field", () => {
		renderSheet();
		const group = screen.getByRole("radiogroup", { name: "Kind" });
		expect(group).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "Reference" })).toBeChecked();
		expect(screen.getByTestId("skill-files-prefix")).toHaveTextContent("references/");
		expect(screen.getByTestId("skill-files-kind-consequence")).toHaveTextContent(/Read on demand/);
		expect(screen.getByTestId("skill-files-path")).toHaveAttribute("placeholder", "notes.md");
	});

	it("switching the kind swaps the prefix, the consequence and the placeholder", async () => {
		renderSheet();
		await userEvent.click(screen.getByRole("radio", { name: "Script" }));
		expect(screen.getByTestId("skill-files-prefix")).toHaveTextContent("scripts/");
		expect(screen.getByTestId("skill-files-kind-consequence")).toHaveTextContent(/Run by the agent/);
		expect(screen.getByTestId("skill-files-path")).toHaveAttribute("placeholder", "run.sh");
		expect(screen.getByTestId("skill-files-path")).toHaveFocus();
		await userEvent.click(screen.getByRole("radio", { name: "Other" }));
		expect(screen.queryByTestId("skill-files-prefix")).toBeNull();
		expect(screen.getByTestId("skill-files-path")).toHaveAttribute("placeholder", "references/notes.md");
	});

	it("creates <folder>/<name> for the chosen kind", async () => {
		const { onCreated } = renderSheet();
		await userEvent.click(screen.getByRole("radio", { name: "Asset" }));
		await userEvent.type(screen.getByTestId("skill-files-path"), "logo.png{Enter}");
		await waitFor(() => expect(created).toEqual([{ name: "brainstorm", rel: "assets/logo.png" }]));
		expect(onCreated).toHaveBeenCalledWith("assets/logo.png");
	});

	it("a pasted full path re-homes the kind chip instead of doubling the folder", async () => {
		const { onCreated } = renderSheet();
		const input = screen.getByTestId("skill-files-path");
		fireEvent.change(input, { target: { value: "scripts/deep/run.py" } });
		expect(screen.getByRole("radio", { name: "Script" })).toBeChecked();
		expect(input).toHaveValue("deep/run.py");
		await userEvent.click(screen.getByRole("button", { name: "Create file" }));
		await waitFor(() => expect(onCreated).toHaveBeenCalledWith("scripts/deep/run.py"));
	});

	it("refuses an empty name and an escaping name inline, on the input itself", async () => {
		renderSheet();
		await userEvent.click(screen.getByRole("button", { name: "Create file" }));
		// Under a prefix the field is a name, so the message says so.
		expect(await screen.findByRole("alert")).toHaveTextContent("Enter a file name.");
		const input = screen.getByTestId("skill-files-path");
		expect(input).toHaveAttribute("aria-invalid", "true");
		expect(input).toHaveAttribute("aria-describedby", "skill-files-path-error");
		// The wrapper never wears the control's ARIA.
		expect(input.parentElement).not.toHaveAttribute("aria-invalid");
		fireEvent.change(input, { target: { value: "../SKILL.md" } });
		await userEvent.click(screen.getByRole("button", { name: "Create file" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/stay inside/);
		expect(created).toEqual([]);
	});

	it("Backspace at the start of an empty name un-types the prefix", async () => {
		renderSheet();
		const input = screen.getByTestId("skill-files-path");
		expect(screen.getByRole("radio", { name: "Reference" })).toBeChecked();
		input.focus();
		fireEvent.keyDown(input, { key: "Backspace" });
		expect(screen.getByRole("radio", { name: "Other" })).toBeChecked();
		expect(input).toHaveValue("references/");
		expect(screen.queryByTestId("skill-files-prefix")).toBeNull();
		// Typing the slash back absorbs it again: the two directions agree.
		fireEvent.change(input, { target: { value: "scripts/" } });
		expect(screen.getByRole("radio", { name: "Script" })).toBeChecked();
		expect(input).toHaveValue("");
	});
});
