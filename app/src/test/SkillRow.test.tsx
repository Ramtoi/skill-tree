import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillRow } from "@/components/SkillRow";
import { renderWithProviders, sampleRegistry } from "./helpers";
import { estimateSkillBodies } from "@/lib/skillBodyTokens";

describe("SkillRow (new API)", () => {
  it("renders the skill name (mono) and description, with no kind mark for a plain skill", () => {
    const onClick = vi.fn();
    const { container } = renderWithProviders(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={onClick}
      />,
    );
    expect(screen.getByText("brainstorm")).toBeInTheDocument();
    expect(
      screen.getByText("Brainstorm a feature with multiple experts."),
    ).toBeInTheDocument();
    // R1: a plain skill's kind is the silent default — no word, no mark.
    expect(screen.queryByText("SKILL")).toBeNull();
    expect(container.querySelector(".kind-mark")).toBeNull();
  });

  it("fires onClick when the row is activated", async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={onClick}
      />,
    );
    await userEvent.click(screen.getByText("brainstorm"));
    expect(onClick).toHaveBeenCalled();
  });

  it("renders a kind mark for mcp-server skills", () => {
    const { container } = renderWithProviders(
      <SkillRow
        name="fs-mcp"
        skill={sampleRegistry.skills["fs-mcp"]}
        registry={sampleRegistry}
        onClick={() => {}}
      />,
    );
    expect(
      container.querySelector('.kind-mark[data-kind="MCP"]'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("MCP server")).toBeInTheDocument();
  });

	it("shows version", () => {
    renderWithProviders(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
	});

	it("offers equipment reach even when classification is unset", () => {
		const { container } = renderWithProviders(<SkillRow name="brainstorm" skill={{ ...sampleRegistry.skills.brainstorm, description: "" }} registry={sampleRegistry} classification={{ classes: [], outputs: [] }} onClick={() => {}} />);
		expect(container.querySelector('[title="Show brainstorm details"]')).toBeInTheDocument();
	});

	it("adds expanded classification detail when outputs or facts are set", () => {
		const { container } = renderWithProviders(<SkillRow name="brainstorm" skill={{ ...sampleRegistry.skills.brainstorm, classification: { outputs: ["plan"], maturity: "confident" } }} registry={sampleRegistry} classification={{ classes: [], outputs: [{ value: "plan", provenance: "assigned", contributors: [] }] }} onClick={() => {}} />);
		expect(container.querySelector('[title="Show brainstorm details"]')).toBeInTheDocument();
	});

  it("a `badges` prop replaces the default cluster, not merges with it", () => {
    const { container } = renderWithProviders(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={() => {}}
        badges={<span data-testid="custom-badge">custom</span>}
      />,
    );
    expect(screen.getByTestId("custom-badge")).toBeInTheDocument();
    expect(container.querySelector(".equipped-pip")).toBeNull();
    expect(screen.queryByText("v1.0.0")).toBeNull();
  });

  it("an `actions` prop replaces the default cluster, even when onPreview/onEdit/onOpenEquipPicker are also passed", () => {
    renderWithProviders(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={() => {}}
        onPreview={() => {}}
        onEdit={() => {}}
        onOpenEquipPicker={() => {}}
        actions={<button>Pull</button>}
      />,
    );
    expect(screen.getByText("Pull")).toBeInTheDocument();
    expect(screen.queryByTitle("Preview")).toBeNull();
    expect(screen.queryByTitle("Edit")).toBeNull();
    expect(screen.queryByTitle("Equip on…")).toBeNull();
  });

  it("a `detail` prop replaces the auto-built bundle/harness detail, not merges with it", async () => {
    const { container } = renderWithProviders(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={() => {}}
        ariaLabel="brainstorm"
        bundleNames={["a"]}
        detail={<span data-testid="custom-detail" />}
      />,
    );
    // The disclosure defaults to closed — open it, then assert the custom
    // body renders and the auto `.skill-row-detail` body does not.
    await userEvent.click(screen.getByTitle("Show brainstorm details"));
    expect(screen.getByTestId("custom-detail")).toBeInTheDocument();
    expect(container.querySelector(".skill-row-detail")).toBeNull();
  });

  it("`dataset` lands as data-* attrs and `className` is appended, not replacing, `skill-row`", () => {
    const { container } = renderWithProviders(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={() => {}}
        dataset={{ drift: "needs-resolve" }}
        className="remote-unit"
      />,
    );
    const row = container.querySelector(".resource-row")!;
    expect(row.getAttribute("data-drift")).toBe("needs-resolve");
    expect(row.classList.contains("resource-row")).toBe(true);
    expect(row.classList.contains("skill-row")).toBe(true);
    expect(row.classList.contains("remote-unit")).toBe(true);
  });

  it("`bundleNames` renders membership in the disclosure, with no bundle Tag", async () => {
    const { container } = renderWithProviders(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={() => {}}
        bundleNames={["a", "b", "c"]}
      />,
    );
    await userEvent.click(screen.getByTitle("Show brainstorm details"));
    expect(screen.getByText("a, b, c")).toBeInTheDocument();
    expect(container.querySelector(".tag")).toBeNull();
  });

  it("renders a source chip in the disclosure when the caller passes one", async () => {
    const { container, rerender } = renderWithProviders(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={() => {}}
      />,
    );
    expect(container.querySelector(".source-chip")).toBeNull();

    rerender(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={() => {}}
        source={<span className="source-chip">Org Skills</span>}
      />,
    );
    await userEvent.click(screen.getByTitle("Show brainstorm details"));
    expect(container.querySelector(".source-chip")).toBeInTheDocument();
  });

  it("shows the interaction style and cached body token estimate", async () => {
    const { container } = renderWithProviders(
      <SkillRow
        name="brainstorm"
        skill={{ ...sampleRegistry.skills.brainstorm, classification: { interaction_style: "conversational" } }}
        registry={sampleRegistry}
        bodyTokens={2}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText("conversational")).toBeInTheDocument();
    const tokenFact = container.querySelector(".skill-body-tokens")!;
    expect(tokenFact).toHaveTextContent("~2 tokens");
    expect(tokenFact.getAttribute("title")).toContain("Excludes frontmatter");
  });

  it("keeps zero distinct from an unavailable body estimate and makes unknown mode explicit", async () => {
    renderWithProviders(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText("tokens unavailable")).toBeInTheDocument();
    expect(screen.getByText("Unspecified")).toBeInTheDocument();
  });

  it("estimates UTF-8 corpus bodies while preserving missing and empty states", () => {
    expect(estimateSkillBodies(undefined)).toEqual({});
    expect(estimateSkillBodies({ skills: { missing: "", unicode: "éééé" }, snippets: {} })).toEqual({ missing: 0, unicode: 2 });
    expect(estimateSkillBodies({ skills: {}, snippets: {} }).brainstorm).toBeUndefined();
  });

  it("puts source, membership, and working mode behind the disclosure", async () => {
    const { container } = renderWithProviders(
      <SkillRow
        name="brainstorm"
        skill={{ ...sampleRegistry.skills.brainstorm, classification: { working_mode: "delegator" } }}
        registry={sampleRegistry}
        bundleNames={["android"]}
        source={<span>Org Skills</span>}
        onClick={() => {}}
      />,
    );
    expect(screen.queryByText("android")).toBeNull();
    await userEvent.click(screen.getByTitle("Show brainstorm details"));
    expect(screen.getByText("android")).toBeInTheDocument();
    expect(screen.getByText("Org Skills")).toBeInTheDocument();
    expect(container.querySelector(".skill-working-mode")).toHaveTextContent("delegator");
    expect(container.querySelector(".skill-row-detail")).toBeInTheDocument();
  });
});


describe("SkillRow compact insight", () => {
  it("shows labelled metadata without relocating the description or repeating interaction style", async () => {
    const inspect = vi.fn();
    const skill = { ...sampleRegistry.skills.brainstorm, classification: { classes: ["design"], outputs: ["plan"], working_mode: "delegator" as const, maturity: "trusted" as const, interaction_style: "conversational" as const } };
    const { container } = renderWithProviders(<SkillRow name="brainstorm" skill={skill} registry={sampleRegistry} onClick={() => {}} onClassificationInspect={inspect} />);
    await userEvent.click(screen.getByTitle("Show brainstorm details"));
    const detail = container.querySelector(".skill-row-detail")!;
    expect(detail).not.toHaveTextContent(skill.description);
    expect(container.querySelector(".resource-desc")).toHaveTextContent(skill.description);
    expect(detail).toHaveTextContent("Use for");
    expect(detail).toHaveTextContent("Produces");
    expect(detail).toHaveTextContent("Maturity");
    expect(detail).not.toHaveTextContent("conversational");
    await userEvent.click(screen.getByRole("button", { name: "plan, Assigned" }));
    expect(inspect).toHaveBeenCalledWith("outputs", "plan");
  });

  it("bounds long classification lists and leaves the rest available through a summary", async () => {
    const skill = { ...sampleRegistry.skills.brainstorm, classification: { classes: ["a", "b", "c", "d", "e", "f"] } };
    const { container } = renderWithProviders(<SkillRow name="brainstorm" skill={skill} registry={sampleRegistry} onClick={() => {}} />);
    await userEvent.click(screen.getByTitle("Show brainstorm details"));
    expect(container.querySelectorAll(".skill-row-detail .classification-value")).toHaveLength(4);
    expect(screen.getByText("+2")).toHaveAttribute("title", "e, f");
  });
});


it("shows actual equipment and reference statistics without inventing usage counts", async () => {
  const { container } = renderWithProviders(<SkillRow name="brainstorm" skill={sampleRegistry.skills.brainstorm} registry={sampleRegistry} equippedCount={3} referenceStats={{ outgoing: ["review"], incoming: ["build", "fix"] }} onClick={() => {}} />);
  await userEvent.click(screen.getByTitle("Show brainstorm details"));
  const stats = container.querySelector(".skill-detail-stats")!;
  expect(stats).toHaveTextContent("Equipped projects3");
  expect(stats).toHaveTextContent("References1skills");
  expect(stats).toHaveTextContent("Referenced by2skills");
  expect(container.querySelector('[title="build, fix"]')).toBeInTheDocument();
});
