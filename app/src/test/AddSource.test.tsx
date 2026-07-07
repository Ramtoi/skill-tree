import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, sampleRegistry, makeQueryClient } from "./helpers";
import { Sources } from "@/screens/Sources";
import type { Registry } from "@/types";

/** Registry where the id derived from `.../skills.git` (→ `skills`) is already
 *  taken, so the modal must offer a free variant instead. */
const registryWithSkillsSource: Registry = {
	...sampleRegistry,
	sources: {
		...sampleRegistry.sources,
		skills: {
			type: "git",
			name: "Skills",
			url: "git@github.com:someone/skills.git",
			branch: "main",
			path: "",
			status: "up-to-date",
			error: null,
		},
	},
};

function mockRegistry(reg: Registry) {
	vi.mocked(invoke).mockImplementation((cmd: string) => {
		if (cmd === "read_registry") return Promise.resolve(reg);
		if (cmd === "hub_cmd") return Promise.resolve({ success: true, output: "" });
		return Promise.resolve(undefined);
	});
}

function idInput(): HTMLInputElement {
	return screen.getByPlaceholderText("derived from URL") as HTMLInputElement;
}

describe("AddSourceModal — source-id derivation & collision", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("auto-fills the id field with the URL-derived slug", async () => {
		mockRegistry(sampleRegistry); // only `org-skills` configured → `skills` is free
		renderWithProviders(<Sources />, {
			client: makeQueryClient(),
			initialRoute: "/?add=1",
		});
		fireEvent.change(screen.getByPlaceholderText("git@github.com:org/skills.git"), {
			target: { value: "git@github.com:org/skills.git" },
		});
		await waitFor(() => expect(idInput().value).toBe("skills"));
		// A free id shows the confirming hint, not an error.
		expect(screen.getByTestId("source-id-hint")).toHaveTextContent("skills");
		expect(screen.queryByTestId("source-id-error")).toBeNull();
	});

	it("pre-fills a free variant when the derived id is already taken", async () => {
		mockRegistry(registryWithSkillsSource);
		renderWithProviders(<Sources />, {
			client: makeQueryClient(),
			initialRoute: "/?add=1",
		});
		fireEvent.change(screen.getByPlaceholderText("git@github.com:org/skills.git"), {
			target: { value: "git@github.com:org/skills.git" },
		});
		// Derived `skills` collides → the field pre-fills `skills-2`, which applies.
		await waitFor(() => expect(idInput().value).toBe("skills-2"));
		expect(screen.queryByTestId("source-id-error")).toBeNull();
		expect(screen.getByRole("button", { name: "Preview" })).not.toBeDisabled();
	});

	it("shows an inline error and blocks Preview when the typed id collides", async () => {
		mockRegistry(registryWithSkillsSource);
		renderWithProviders(<Sources />, {
			client: makeQueryClient(),
			initialRoute: "/?add=1",
		});
		fireEvent.change(screen.getByPlaceholderText("git@github.com:org/skills.git"), {
			target: { value: "git@github.com:org/other.git" },
		});
		await waitFor(() => expect(idInput().value).toBe("other"));
		// Manually type a colliding id.
		fireEvent.change(idInput(), { target: { value: "skills" } });
		expect(await screen.findByTestId("source-id-error")).toHaveTextContent(
			"already a source",
		);
		expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
	});

	it("blocks Preview for a reserved built-in id", async () => {
		mockRegistry(sampleRegistry);
		renderWithProviders(<Sources />, {
			client: makeQueryClient(),
			initialRoute: "/?add=1",
		});
		fireEvent.change(screen.getByPlaceholderText("git@github.com:org/skills.git"), {
			target: { value: "git@github.com:org/x.git" },
		});
		await waitFor(() => expect(idInput().value).toBe("x"));
		fireEvent.change(idInput(), { target: { value: "starter" } });
		expect(await screen.findByTestId("source-id-error")).toHaveTextContent("reserved");
		expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
	});

	it("re-arms auto-derivation when the id field is cleared", async () => {
		mockRegistry(sampleRegistry);
		renderWithProviders(<Sources />, {
			client: makeQueryClient(),
			initialRoute: "/?add=1",
		});
		const url = screen.getByPlaceholderText("git@github.com:org/skills.git");
		fireEvent.change(url, { target: { value: "git@github.com:org/alpha.git" } });
		await waitFor(() => expect(idInput().value).toBe("alpha"));
		// User edits the id, breaking the mirror…
		fireEvent.change(idInput(), { target: { value: "custom" } });
		fireEvent.change(url, { target: { value: "git@github.com:org/beta.git" } });
		expect(idInput().value).toBe("custom"); // stays put once touched
		// …clearing it re-arms derivation from the URL.
		fireEvent.change(idInput(), { target: { value: "" } });
		fireEvent.change(url, { target: { value: "git@github.com:org/gamma.git" } });
		await waitFor(() => expect(idInput().value).toBe("gamma"));
	});
});
