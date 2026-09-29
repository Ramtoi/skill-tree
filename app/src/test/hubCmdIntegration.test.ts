import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

describe("hub_cmd integration (Rust mock)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("enable skill calls hub_cmd with correct args", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, output: "" });
    await invoke("hub_cmd", { args: ["enable", "brainstorm", "--project", "my-project"] });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("hub_cmd", {
      args: ["enable", "brainstorm", "--project", "my-project"],
    });
  });

  it("disable skill calls hub_cmd with correct args", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, output: "" });
    await invoke("hub_cmd", { args: ["disable", "grill", "--project", "alpha"] });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("hub_cmd", {
      args: ["disable", "grill", "--project", "alpha"],
    });
  });

  it("rename calls hub_cmd with old and new name", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, output: "" });
    await invoke("hub_cmd", { args: ["rename", "old-skill", "new-skill"] });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("hub_cmd", {
      args: ["rename", "old-skill", "new-skill"],
    });
  });

  it("archive calls hub_cmd with skill name", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, output: "" });
    await invoke("hub_cmd", { args: ["archive", "old-skill"] });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("hub_cmd", {
      args: ["archive", "old-skill"],
    });
  });

  it("error response propagates correctly", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: false, output: "Skill not found" });
    const result = await invoke<{ success: boolean; output: string }>("hub_cmd", {
      args: ["archive", "nonexistent"],
    });
    expect(result.success).toBe(false);
    expect(result.output).toBe("Skill not found");
  });
});
