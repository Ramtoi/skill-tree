import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ResourceRow } from "@/components/ResourceRow";
import { SkillRow } from "@/components/SkillRow";
import { SkillCard } from "@/components/SkillCard";
import { sampleRegistry } from "./helpers";

describe("ResourceRow — excerpt slot", () => {
  it("renders .resource-excerpt when `excerpt` is passed", () => {
    const { container } = render(
      <ResourceRow name="unslop" excerpt={<span data-testid="ex-body">in content marker</span>} />,
    );
    expect(container.querySelector(".resource-excerpt")).toBeInTheDocument();
    expect(screen.getByTestId("ex-body")).toBeInTheDocument();
  });

  it("renders no .resource-excerpt element when `excerpt` is omitted", () => {
    const { container } = render(<ResourceRow name="unslop" />);
    expect(container.querySelector(".resource-excerpt")).toBeNull();
  });

  it("m5: aria-describedby on the root points at the excerpt element", () => {
    const { container } = render(
      <ResourceRow
        name="unslop"
        ariaLabel="unslop"
        onClick={() => {}}
        excerpt={<span data-testid="ex-body">in content marker</span>}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    const describedbyId = root.getAttribute("aria-describedby");
    expect(describedbyId).toBeTruthy();
    const excerptEl = document.getElementById(describedbyId!);
    expect(excerptEl).not.toBeNull();
    expect(excerptEl).toHaveClass("resource-excerpt");
  });

  it("no aria-describedby when there is no excerpt", () => {
    const { container } = render(<ResourceRow name="unslop" onClick={() => {}} ariaLabel="unslop" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).not.toHaveAttribute("aria-describedby");
  });

  it("excerpt and detail can both be open at once, excerpt preceding the detail panel in the DOM", () => {
    const { container } = render(
      <ResourceRow
        name="unslop"
        ariaLabel="unslop"
        excerpt={<span data-testid="ex-body">in content marker</span>}
        detail={<span data-testid="detail-body">Detail</span>}
        detailOpen
        onDetailToggle={() => {}}
        detailLabel="unslop details"
      />,
    );
    const excerpt = container.querySelector(".resource-excerpt");
    const detail = container.querySelector(".resource-detail");
    expect(excerpt).toBeInTheDocument();
    expect(detail).toBeInTheDocument();
    // DOM order: excerpt comes before the detail panel (grid-row 2 vs 3).
    expect(
      excerpt!.compareDocumentPosition(detail!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("card layout renders the excerpt after the description line", () => {
    const { container } = render(
      <ResourceRow
        layout="card"
        name="unslop"
        desc="A description"
        excerpt={<span data-testid="ex-body">in content marker</span>}
      />,
    );
    const desc = container.querySelector(".resource-desc")!;
    const excerpt = container.querySelector(".resource-excerpt")!;
    expect(desc.compareDocumentPosition(excerpt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("SkillRow — nameNode / excerpt pass-through", () => {
  it("renders nameNode in place of the plain name string when given", () => {
    const { container } = render(
      <SkillRow
        name="brainstorm"
        nameNode={<mark data-testid="marked-name">brainstorm</mark>}
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={() => {}}
      />,
    );
    expect(screen.getByTestId("marked-name")).toBeInTheDocument();
    // `title` still carries the plain string regardless of nameNode.
    expect(container.querySelector('.resource-name[title="brainstorm"]')).toBeInTheDocument();
  });

  it("falls back to the plain name string when nameNode is omitted", () => {
    render(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText("brainstorm")).toBeInTheDocument();
  });

  it("forwards `excerpt` to ResourceRow", () => {
    const { container } = render(
      <SkillRow
        name="brainstorm"
        excerpt={<span data-testid="ex-body">in content marker</span>}
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={() => {}}
      />,
    );
    expect(container.querySelector(".resource-excerpt")).toBeInTheDocument();
    expect(screen.getByTestId("ex-body")).toBeInTheDocument();
  });

  it("renders descNode in place of the plain description string when given (M2)", () => {
    render(
      <SkillRow
        name="brainstorm"
        descNode={<mark data-testid="marked-desc">Brainstorm</mark>}
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={() => {}}
      />,
    );
    expect(screen.getByTestId("marked-desc")).toBeInTheDocument();
  });

  it("falls back to the plain description string when descNode is omitted", () => {
    render(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText(sampleRegistry.skills.brainstorm.description!)).toBeInTheDocument();
  });
});

describe("SkillCard — nameNode / excerpt pass-through", () => {
  it("renders nameNode in place of the plain name string, and forwards excerpt", () => {
    const { container } = render(
      <SkillCard
        name="brainstorm"
        nameNode={<mark data-testid="marked-name">brainstorm</mark>}
        excerpt={<span data-testid="ex-body">in content marker</span>}
        scope="global"
      />,
    );
    expect(screen.getByTestId("marked-name")).toBeInTheDocument();
    expect(container.querySelector('[title="brainstorm"]')).toBeInTheDocument();
    expect(container.querySelector(".resource-excerpt")).toBeInTheDocument();
    expect(screen.getByTestId("ex-body")).toBeInTheDocument();
  });

  it("falls back to the plain name string when nameNode is omitted", () => {
    render(<SkillCard name="brainstorm" scope="global" />);
    expect(screen.getByText("brainstorm")).toBeInTheDocument();
  });

  it("renders descNode in place of the plain description string when given (M2)", () => {
    render(
      <SkillCard
        name="brainstorm"
        description="Spin up a team of experts"
        descNode={<mark data-testid="marked-desc">Spin up a team</mark>}
        scope="global"
      />,
    );
    expect(screen.getByTestId("marked-desc")).toBeInTheDocument();
  });
});
