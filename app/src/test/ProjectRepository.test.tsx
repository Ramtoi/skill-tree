import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { AddProjectSheet } from "@/components/AddProjectSheet";
import { ProjectRepositoryDialog } from "@/components/ProjectRepositoryDialog";
import { parseProjectRepository } from "@/lib/projectRepository";
import { deferredInvoke, renderWithProviders } from "./helpers";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

beforeEach(() => {
  localStorage.clear();
});

describe("project repository contract", () => {
  it("parses path-only and inspected repository envelopes", () => {
    expect(parseProjectRepository(JSON.stringify({
      ok: true, project: "app", repository: null, inspection: null, error: null,
    })).repository).toBeNull();
    const reply = parseProjectRepository(JSON.stringify({
      ok: true,
      project: "app",
      repository: null,
      inspection: {
        project_path: "/tmp/app",
        git_root: "/tmp/app",
        association: { url: "git@github.com:org/app.git", remote: "origin", subdirectory: "." },
        is_worktree: false,
      },
      error: null,
    }));
    expect(reply.inspection?.association.remote).toBe("origin");
    expect(() => parseProjectRepository(JSON.stringify({ ok: true, project: "app", repository: { url: 1 }, error: null }))).toThrow();
  });

  it("offers detection after add and lets Skip preserve the path-only project", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const fallback = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "pick_directory") return "/Users/dev/projects/new-settings-project";
      if (cmd === "read_registry") return { projects: {} };
      return fallback(cmd, args);
    });
    renderWithProviders(<><AddProjectSheet open onClose={onClose} /><LocationProbe /></>);
    await user.click(screen.getByText("Browse…"));
    await waitFor(() => expect(screen.getByPlaceholderText("kebab-case-name")).toHaveValue("new-settings-project"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add project" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Add project" }));
    expect(await screen.findByRole("dialog", { name: "Connect repository for new-settings-project" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByTestId("location")).toHaveTextContent("/project/new-settings-project");
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("hub_cmd", expect.objectContaining({
      args: expect.arrayContaining(["project", "repository", "set"]),
    }));
  });

  it.each(["connect", "escape"])("opens the created workspace after offer %s", async (exit) => {
    const user = userEvent.setup();
    const fallback = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "pick_directory") return "/tmp/new-project";
      if (cmd === "read_registry") return { projects: {} };
      return fallback(cmd, args);
    });
    renderWithProviders(<><AddProjectSheet open onClose={() => {}} /><LocationProbe /></>);
    await user.click(screen.getByText("Browse…"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add project" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Add project" }));
    await screen.findByRole("dialog", { name: "Connect repository for new-project" });
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    if (exit === "connect") {
      await user.click(screen.getByRole("button", { name: "Detect repository" }));
      await user.click(await screen.findByRole("button", { name: "Connect repository" }));
    } else {
      await user.click(screen.getByRole("textbox", { name: "Git remote" }));
      await user.keyboard("{Escape}");
    }
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/project/new-project"));
  });

  it("stays in place after registration failure or cancellation before creation", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const fallback = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "pick_directory") return "/tmp/new-project";
      if (cmd === "read_registry") return { projects: {} };
      if (cmd === "project_add_with_path") throw new Error("Registration failed");
      return fallback(cmd, args);
    });
    renderWithProviders(<><AddProjectSheet open onClose={onClose} /><LocationProbe /></>);
    await user.click(screen.getByText("Browse…"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add project" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Add project" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add project" })).toBeEnabled());
    expect(screen.queryByRole("dialog", { name: /Connect repository/ })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
  });

  it("keeps Add usable after detection failure and offers retry or Skip", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const fallback = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "pick_directory") return "/Users/dev/projects/new-settings-project";
      if (cmd === "read_registry") return { projects: {} };
      if (cmd === "hub_cmd" && (args as { args?: string[] }).args?.[0] === "project" &&
        (args as { args?: string[] }).args?.[1] === "repository" &&
        (args as { args?: string[] }).args?.[2] === "inspect") {
        return { success: true, output: JSON.stringify({
          ok: false, project: "new-settings-project", repository: null, inspection: null,
          error: { code: "not_a_repository", message: "That folder is not a Git repository." },
        }) };
      }
      return fallback(cmd, args);
    });
    renderWithProviders(<><AddProjectSheet open onClose={onClose} /><LocationProbe /></>);
    await user.click(screen.getByText("Browse…"));
    await waitFor(() => expect(screen.getByPlaceholderText("kebab-case-name")).toHaveValue("new-settings-project"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add project" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.click(await screen.findByRole("button", { name: "Detect repository" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not a Git repository");
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("inspects before explicit connect and sends the selected remote", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(<ProjectRepositoryDialog open projectName="app" onClose={onClose} mode="offer" />);
    const remote = screen.getByRole("textbox", { name: "Git remote" });
    await user.clear(remote);
    await user.type(remote, "upstream");
    await user.click(screen.getByRole("button", { name: "Detect repository" }));
    expect(await screen.findByText("Detected checkout")).toBeInTheDocument();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("hub_cmd", {
      args: ["project", "repository", "inspect", "app", "--remote", "upstream", "--json"],
    });
    await user.click(screen.getByRole("button", { name: "Connect repository" }));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("hub_cmd", {
      args: ["project", "repository", "set", "app", "--remote", "upstream", "--json"],
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("surfaces disconnect errors without losing the saved association", async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "hub_cmd") {
        const argv = (args as { args?: string[] }).args ?? [];
        if (argv[0] === "project" && argv[1] === "repository" && argv[2] === "show") {
          return { success: true, output: JSON.stringify({ ok: true, project: "app", repository: {
            url: "https://github.com/org/app.git", remote: "origin", subdirectory: ".",
          }, inspection: null, error: null }) };
        }
        if (argv[0] === "project" && argv[1] === "repository" && argv[2] === "clear") {
          return { success: true, output: JSON.stringify({ ok: false, project: "app", repository: null, inspection: null,
            error: { code: "git_failed", message: "Could not disconnect repository." } }) };
        }
      }
      return undefined;
    });
    renderWithProviders(<ProjectRepositoryDialog open projectName="app" onClose={() => {}} />);
    expect(await screen.findByText("https://github.com/org/app.git")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not disconnect repository");
    expect(screen.getByText("https://github.com/org/app.git")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry disconnect" })).toBeEnabled();
  });

  it("reopens a cached association with its saved non-origin remote", async () => {
    const user = userEvent.setup();
    function Session() {
      const [open, setOpen] = useState(true);
      return <>
        <button onClick={() => setOpen(true)}>Reopen repository</button>
        <ProjectRepositoryDialog open={open} projectName="app" onClose={() => setOpen(false)} />
      </>;
    }
    renderWithProviders(<Session />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Detect repository" })).toBeEnabled());
    const remote = screen.getByRole("textbox", { name: "Git remote" });
    await user.clear(remote);
    await user.type(remote, "upstream");
    await user.click(screen.getByRole("button", { name: "Detect repository" }));
    await user.click(await screen.findByRole("button", { name: "Connect repository" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Reopen repository" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Git remote" })).toHaveValue("upstream"));
    await user.click(screen.getByRole("button", { name: "Detect current checkout" }));
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("hub_cmd", {
      args: ["project", "repository", "inspect", "app", "--remote", "upstream", "--json"],
    });
  });

  it("keeps Escape from dismissing while repository detection is busy", async () => {
    const user = userEvent.setup();
    const gate = deferredInvoke((cmd, args) => cmd === "hub_cmd" &&
      (args as { args?: string[] })?.args?.[2] === "inspect");
    renderWithProviders(<ProjectRepositoryDialog open projectName="app" onClose={() => {}} mode="offer" />);
    await user.click(screen.getByRole("button", { name: "Detect repository" }));
    expect(screen.getByRole("button", { name: "Detect repository" })).toHaveAttribute("aria-busy", "true");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Connect repository for app" })).toBeInTheDocument();
    gate.resolve({ success: true, output: JSON.stringify({
      ok: true, project: "app", repository: {
        url: "https://github.com/example-org/app.git", remote: "origin", subdirectory: ".",
      }, inspection: {
        project_path: "/tmp/app", git_root: "/tmp/app",
        association: { url: "https://github.com/example-org/app.git", remote: "origin", subdirectory: "." },
        is_worktree: false,
      }, error: null,
    }) });
    expect(await screen.findByText("Detected checkout")).toBeInTheDocument();
  });
});
