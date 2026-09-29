import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import { mockWorktreeDefaults } from "@/mocks/worktreeDefaults";
import { AddProjectSheet } from "@/components/AddProjectSheet";
import { EditProjectPathDialog } from "@/components/EditProjectPathDialog";
import { RemoveProjectDialog } from "@/components/RemoveProjectDialog";
import { useAppStore } from "@/store";
import { orderStorageKey } from "@/lib/projectLoadoutOrder";
import { useLoadoutOrderStore } from "@/hooks/useProjectLoadoutOrder";
import { renderWithProviders } from "./helpers";

beforeEach(() => {
	useAppStore.setState({ mutating: false });
});

describe("AddProjectSheet", () => {
	it("derives slug from picked directory basename", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "read_registry") return { projects: {} };
      if (cmd === "hub_cmd") {
        const payload = mockWorktreeDefaults((args as { args: string[] }).args);
        return { success: payload.ok, output: JSON.stringify(payload) };
      }
			if (cmd === "pick_directory") return "/Users/u/Dev/My_Cool_Project";
			return undefined;
		});
		renderWithProviders(<AddProjectSheet open onClose={() => {}} />);

		await userEvent.click(screen.getByText("Browse…"));
		await waitFor(() => {
			const nameInput = screen.getByPlaceholderText(
				"kebab-case-name",
			) as HTMLInputElement;
			expect(nameInput.value).toBe("my-cool-project");
		});
	});

	it("disables the submit button while mutating", () => {
		useAppStore.setState({ mutating: true });
		renderWithProviders(<AddProjectSheet open onClose={() => {}} />);
		const submit = screen.getByRole("button", { name: "Add project" });
		expect(submit).toBeDisabled();
	});

	it("rejects invalid slug input", async () => {
		renderWithProviders(<AddProjectSheet open onClose={() => {}} />);
		const nameInput = screen.getByPlaceholderText("kebab-case-name");
		await userEvent.type(nameInput, "Bad Name");
		expect(
			screen.getByText(/must match \^\[a-z0-9-\]\+\$/),
		).toBeInTheDocument();
	});

	it("calls project_add_with_path on submit", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "read_registry") return { projects: {} };
      if (cmd === "hub_cmd") {
        const payload = mockWorktreeDefaults((args as { args: string[] }).args);
        return { success: payload.ok, output: JSON.stringify(payload) };
      }
			if (cmd === "pick_directory") return "/Users/u/Dev/alpha";
			return undefined;
		});
		renderWithProviders(<AddProjectSheet open onClose={() => {}} />);
		await userEvent.click(screen.getByText("Browse…"));
		await waitFor(() => {
			const nameInput = screen.getByPlaceholderText(
				"kebab-case-name",
			) as HTMLInputElement;
			expect(nameInput.value).toBe("alpha");
		});
    await waitFor(() => expect(screen.getByRole("button", { name: "Add project" })).toBeEnabled());
		await userEvent.click(screen.getByRole("button", { name: "Add project" }));
		await waitFor(() => {
			expect(vi.mocked(invoke)).toHaveBeenCalledWith("project_add_with_path", {
				name: "alpha",
				path: "/Users/u/Dev/alpha",
			});
		});
	});

	it("leaves the form idle when folder picking is cancelled", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "read_registry") return { projects: {} };
      if (cmd === "hub_cmd") {
        const payload = mockWorktreeDefaults((args as { args: string[] }).args);
        return { success: payload.ok, output: JSON.stringify(payload) };
      }
			if (cmd === "pick_directory") return null;
			return undefined;
		});
		renderWithProviders(<AddProjectSheet open onClose={() => {}} />);

		await userEvent.click(screen.getByText("Browse…"));

		await waitFor(() => {
			expect(vi.mocked(invoke)).toHaveBeenCalledWith("pick_directory");
		});
		expect(
			screen.getByText("Click Browse to choose a folder…"),
		).toBeInTheDocument();
		expect(screen.getByPlaceholderText("kebab-case-name")).toHaveValue("");
		expect(screen.getByRole("button", { name: "Add project" })).toBeDisabled();
	});
});

describe("EditProjectPathDialog", () => {
	it("renders current path and disables submit until new path is picked", () => {
		renderWithProviders(
			<EditProjectPathDialog
				open
				onClose={() => {}}
				projectName="alpha"
				currentPath="/Users/u/Dev/old"
			/>,
		);
		expect(screen.getByText("/Users/u/Dev/old")).toBeInTheDocument();
		const submit = screen.getByRole("button", { name: "Update path" });
		expect(submit).toBeDisabled();
	});

	it("calls project_edit_path with new path", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd: string) => {
			if (cmd === "pick_directory") return "/Users/u/Dev/new";
			return undefined;
		});
		renderWithProviders(
			<EditProjectPathDialog
				open
				onClose={() => {}}
				projectName="alpha"
				currentPath="/Users/u/Dev/old"
			/>,
		);
		await userEvent.click(screen.getByText("Browse…"));
		await waitFor(() => {
			expect(
				screen.getByText("Update path").closest("button"),
			).not.toBeDisabled();
		});
		await userEvent.click(screen.getByRole("button", { name: "Update path" }));
		await waitFor(() => {
			expect(vi.mocked(invoke)).toHaveBeenCalledWith("project_edit_path", {
				name: "alpha",
				newPath: "/Users/u/Dev/new",
			});
		});
	});

  it("moves personal order to the canonical saved path, not the picked symlink", async () => {
    const from = "/Users/u/Dev/old";
    const picked = "/Users/u/Dev/alias";
    const canonical = "/Volumes/work/project";
    const order = JSON.stringify({ version: 1, sections: [{ kind: "direct" }] });
    useLoadoutOrderStore.setState({ values: {}, edits: {} });
    localStorage.setItem(orderStorageKey(from), order);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "pick_directory") return picked;
      if (cmd === "read_registry") return { projects: { alpha: { path: canonical } } };
      return undefined;
    });
    const close = vi.fn();
    renderWithProviders(<EditProjectPathDialog open onClose={close} projectName="alpha" currentPath={from} />);
    await userEvent.click(screen.getByText("Browse…"));
    await userEvent.click(screen.getByRole("button", { name: "Update path" }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(localStorage.getItem(orderStorageKey(canonical))).toBe(order);
    expect(localStorage.getItem(orderStorageKey(picked))).toBeNull();
    expect(localStorage.getItem(orderStorageKey(from))).toBeNull();
  });

  it("preserves the old order and reports partial success if the saved path cannot be read", async () => {
    const from = "/Users/u/Dev/old";
    const order = JSON.stringify({ version: 1, sections: [{ kind: "direct" }] });
    useLoadoutOrderStore.setState({ values: {}, edits: {} });
    useAppStore.setState({ toasts: [] });
    localStorage.setItem(orderStorageKey(from), order);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "pick_directory") return "/Users/u/Dev/alias";
      if (cmd === "read_registry") throw new Error("Read unavailable");
      return undefined;
    });
    const close = vi.fn();
    renderWithProviders(<EditProjectPathDialog open onClose={close} projectName="alpha" currentPath={from} />);
    await userEvent.click(screen.getByText("Browse…"));
    await userEvent.click(screen.getByRole("button", { name: "Update path" }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(localStorage.getItem(orderStorageKey(from))).toBe(order);
    expect(useAppStore.getState().toasts.some(toast => toast.title.includes("personal loadout order could not be moved"))).toBe(true);
  });

	it("keeps update disabled when folder picking is cancelled", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd: string) => {
			if (cmd === "pick_directory") return null;
			return undefined;
		});
		renderWithProviders(
			<EditProjectPathDialog
				open
				onClose={() => {}}
				projectName="alpha"
				currentPath="/Users/u/Dev/old"
			/>,
		);

		await userEvent.click(screen.getByText("Browse…"));

		await waitFor(() => {
			expect(vi.mocked(invoke)).toHaveBeenCalledWith("pick_directory");
		});
		expect(
			screen.getByText("Click Browse to choose a folder…"),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Update path" })).toBeDisabled();
	});
});

describe("RemoveProjectDialog", () => {
	it("fetches and renders removal plan when opened", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd: string) => {
			if (cmd === "project_remove_preview") {
				return {
					project: "alpha",
					project_path: "/Users/u/Dev/alpha",
					removed_symlinks: ["/Users/u/Dev/alpha/.claude/skills/brainstorm"],
					removed_mcp_entries: [
						{ file: "/Users/u/Dev/alpha/.mcp.json", name: "code-reviewer" },
					],
					removed_empty_dirs: [],
					warnings: [],
				};
			}
			return undefined;
		});
		renderWithProviders(
			<RemoveProjectDialog open onClose={() => {}} projectName="alpha" />,
		);
		expect(
			await screen.findByText(
				/\/Users\/u\/Dev\/alpha\/\.claude\/skills\/brainstorm/,
			),
		).toBeInTheDocument();
		expect(screen.getByText(/code-reviewer/)).toBeInTheDocument();
	});

	it("disables Remove while mutating", () => {
		useAppStore.setState({ mutating: true });
		vi.mocked(invoke).mockImplementation(async (cmd: string) => {
			if (cmd === "project_remove_preview") {
				return {
					project: "alpha",
					project_path: "/Users/u/Dev/alpha",
					removed_symlinks: [],
					removed_mcp_entries: [],
					removed_empty_dirs: [],
					warnings: [],
				};
			}
			return undefined;
		});
		renderWithProviders(
			<RemoveProjectDialog open onClose={() => {}} projectName="alpha" />,
		);
		const submit = screen.getByRole("button", { name: "Remove project" });
		expect(submit).toBeDisabled();
	});

	it("calls project_remove_clean on confirm", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd: string) => {
			if (cmd === "project_remove_preview") {
				return {
					project: "alpha",
					project_path: "/Users/u/Dev/alpha",
					removed_symlinks: [],
					removed_mcp_entries: [],
					removed_empty_dirs: [],
					warnings: [],
				};
			}
			return undefined;
		});
		renderWithProviders(
			<RemoveProjectDialog open onClose={() => {}} projectName="alpha" />,
		);
		await waitFor(() => {
			expect(
				screen.getByText("Remove project").closest("button"),
			).not.toBeDisabled();
		});
		await userEvent.click(
			screen.getByRole("button", { name: "Remove project" }),
		);
		await waitFor(() => {
			expect(vi.mocked(invoke)).toHaveBeenCalledWith("project_remove_clean", {
				name: "alpha",
			});
		});
	});
});
