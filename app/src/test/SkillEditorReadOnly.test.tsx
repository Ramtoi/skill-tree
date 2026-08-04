import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, sampleRegistry, primeRegistry, makeQueryClient } from "./helpers";
import { SkillEditor } from "@/screens/SkillEditor";

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

describe("SkillEditor — hybrid ownership", () => {
  it("renders the external source banner for an externally managed skill", async () => {
    renderEditor("/skill/android-compose-ui");
    await waitFor(() =>
      expect(screen.getByText(/Managed by external source/i)).toBeInTheDocument(),
    );
    expect(screen.getAllByText("Duplicate as local").length).toBeGreaterThan(0);
  });

  it("locks the markdown editor read-only for externally managed skills", async () => {
    const { container } = renderEditor("/skill/android-compose-ui");
    // CodeMirror owns the edit surface; read-only ⇒ a non-editable .cm-content.
    await waitFor(() =>
      expect(container.querySelector(".code-area--edit .cm-content")).toBeTruthy(),
    );
    const content = container.querySelector(
      ".code-area--edit .cm-content",
    ) as HTMLElement | null;
    expect(content).toBeTruthy();
    expect(content!.getAttribute("contenteditable")).toBe("false");
  });

  it("does NOT render the banner for a locally managed skill", async () => {
    renderEditor("/skill/brainstorm");
    await waitFor(() => screen.getAllByText("brainstorm").length > 0);
    expect(screen.queryByText(/Managed by external source/i)).toBeNull();
    expect(screen.queryByText(/Managed by Starter Pack/i)).toBeNull();
  });
});
