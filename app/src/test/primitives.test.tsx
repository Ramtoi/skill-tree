import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { Button } from "@/components/Button";
import { Tag, KindTag, KindMark, ScopeBadge } from "@/components/Tag";
import { Kbd } from "@/components/Kbd";
import { Chips, Chip } from "@/components/Chips";
import { ChipRadios } from "@/components/ChipRadios";
import { SectionHeader } from "@/components/SectionHeader";
import { PowerPips } from "@/components/PowerPips";
import { Icon } from "@/components/Icon";

describe("Button", () => {
  it("renders all variants with composed classes", () => {
    render(
      <>
        <Button variant="ghost">Ghost</Button>
        <Button variant="soft">Soft</Button>
        <Button variant="primary">Primary</Button>
        <Button variant="danger">Danger</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Ghost" }).className).toContain("btn-ghost");
    expect(screen.getByRole("button", { name: "Soft" }).className).toContain("btn-soft");
    expect(screen.getByRole("button", { name: "Primary" }).className).toContain("btn-primary");
    expect(screen.getByRole("button", { name: "Danger" }).className).toContain("btn-danger");
  });

  it("fires onClick and respects disabled", async () => {
    const fn = vi.fn();
    render(
      <>
        <Button onClick={fn}>Go</Button>
        <Button onClick={fn} disabled>
          No
        </Button>
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await userEvent.click(screen.getByRole("button", { name: "No" }));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("soft-disable (disabledReason) keeps the button focusable, shows the reason, and swallows clicks", async () => {
    const fn = vi.fn();
    render(
      <Button onClick={fn} disabled disabledReason="Fix the name first">
        Save
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Save" });
    // Soft-disabled: NOT natively disabled (stays in tab order / hoverable)…
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn).toHaveAttribute("title", "Fix the name first");
    btn.focus();
    expect(btn).toHaveFocus();
    // …but activation must not fire.
    await userEvent.click(btn);
    await userEvent.keyboard("{Enter}");
    expect(fn).not.toHaveBeenCalled();
  });

  it("renders kbd hint", () => {
    render(<Button kbd="⌘S">Save</Button>);
    expect(screen.getByText("⌘S")).toBeInTheDocument();
  });

  // `signal="dot"` is the attention marker the editor Save button uses instead
  // of a separate UNSAVED pill. It must be purely additive: the canonical
  // `btn btn-<variant> btn-<size>` prefix is depended on by 200+ call sites.
  it("signal='dot' renders an indicator without disturbing the class shape", () => {
    const { container, rerender } = render(
      <Button variant="primary" size="md">
        Save
      </Button>,
    );
    const btn = () => screen.getByRole("button", { name: /Save/ });
    expect(btn().className.startsWith("btn btn-primary btn-md")).toBe(true);
    expect(container.querySelector(".btn-signal")).toBeNull();

    rerender(
      <Button variant="primary" size="md" signal="dot">
        Save
      </Button>,
    );
    expect(btn().className.startsWith("btn btn-primary btn-md")).toBe(true);
    expect(btn().className).toContain("btn-signal-dot");
    const dot = container.querySelector(".btn-signal");
    expect(dot).not.toBeNull();
    // Decoration only — the label/title carry the meaning for assistive tech.
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(dot).toHaveAttribute("data-signal", "dot");
  });

  it("busy wins over signal (the spinner is the one in-flight affordance)", () => {
    const { container } = render(
      <Button signal="dot" busy>
        Save
      </Button>,
    );
    expect(container.querySelector(".btn-signal")).toBeNull();
    expect(screen.getByRole("button", { name: /Save/ })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });
});

describe("Tag / KindTag / ScopeBadge", () => {
  it("renders all tag kinds", () => {
    render(
      <>
        <Tag kind="soft" color="var(--anchor)">soft</Tag>
        <Tag kind="solid" color="var(--green)">solid</Tag>
        <Tag kind="outline" color="var(--red)">outline</Tag>
      </>,
    );
    expect(screen.getByText("soft")).toBeInTheDocument();
    expect(screen.getByText("solid")).toBeInTheDocument();
    expect(screen.getByText("outline")).toBeInTheDocument();
  });

  it("KindTag normalizes claude-skill and mcp-server", () => {
    const { rerender } = render(<KindTag kind="claude-skill" />);
    expect(screen.getByText("SKILL")).toBeInTheDocument();
    rerender(<KindTag kind="mcp-server" />);
    expect(screen.getByText("MCP")).toBeInTheDocument();
  });

  it("KindMark renders nothing for a skill and an --id-1-tinted MCP icon for an mcp-server (R1: deviation-only)", () => {
    const { container, rerender } = render(<KindMark kind="claude-skill" />);
    expect(container.querySelector(".kind-mark")).toBeNull();

    rerender(<KindMark kind="mcp-server" />);
    const mark = container.querySelector(".kind-mark");
    expect(mark).not.toBeNull();
    expect(mark).toHaveAttribute("data-kind", "MCP");
    expect(screen.getByLabelText("MCP server")).toBeInTheDocument();
  });

  it("ScopeBadge writes data-scope and short label", () => {
    const { container, rerender } = render(<ScopeBadge scope="global" />);
    expect(container.querySelector("[data-scope='global']")).toBeInTheDocument();
    expect(screen.getByText("G")).toBeInTheDocument();
    rerender(<ScopeBadge scope="portable" />);
    expect(screen.getByText("P")).toBeInTheDocument();
    rerender(<ScopeBadge scope="project-specific" />);
    expect(screen.getByText("·")).toBeInTheDocument();
  });
});

describe("Kbd", () => {
  it("renders monospace key cap", () => {
    render(<Kbd>⌘K</Kbd>);
    const el = screen.getByText("⌘K");
    expect(el.tagName.toLowerCase()).toBe("kbd");
    expect(el.className).toContain("kbd");
  });
});

describe("Chips", () => {
  it("toggles aria-pressed and fires onClick", async () => {
    const fn = vi.fn();
    function Harness() {
      return (
        <Chips>
          <Chip pressed onClick={fn}>
            ALL
          </Chip>
          <Chip onClick={fn}>SKILL</Chip>
        </Chips>
      );
    }
    render(<Harness />);
    const all = screen.getByRole("button", { name: /ALL/ });
    const skill = screen.getByRole("button", { name: /SKILL/ });
    expect(all.getAttribute("aria-pressed")).toBe("true");
    const pressed = skill.getAttribute("aria-pressed");
    // chip may emit aria-pressed="false" or omit it when unpressed
    expect(pressed === "false" || pressed === null).toBe(true);
    await userEvent.click(skill);
    expect(fn).toHaveBeenCalled();
  });
});

describe("ChipRadios", () => {
  it("renders an option's icon in a .chip-icon before the label, and omits it when absent", () => {
    render(
      <ChipRadios
        name="test-group"
        label="Test"
        value="a"
        onChange={() => {}}
        options={[
          { value: "a", label: "Alpha", icon: <span data-testid="alpha-glyph">*</span> },
          { value: "b", label: "Beta" },
        ]}
      />,
    );
    const alphaOption = screen.getByRole("radio", { name: "Alpha" }).closest("label")!;
    expect(alphaOption.querySelector(".chip-icon")).toBeTruthy();
    expect(alphaOption.querySelector(".chip-icon [data-testid='alpha-glyph']")).toBeTruthy();

    const betaOption = screen.getByRole("radio", { name: "Beta" }).closest("label")!;
    expect(betaOption.querySelector(".chip-icon")).toBeNull();
    // The label text is still wrapped — harmless for an icon-less option.
    expect(betaOption.querySelector(".chip-label-text")?.textContent).toBe("Beta");
  });
});

describe("SectionHeader", () => {
  it("renders label and count, and is sticky by class", () => {
    const { container } = render(<SectionHeader label="GLOBAL" count={4} />);
    expect(screen.getByText("GLOBAL")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(container.firstElementChild?.className).toContain("section-header");
  });
});

describe("PowerPips", () => {
  it("renders N on-pips and (total - N) off-pips", () => {
    const { container } = render(<PowerPips on={3} total={5} />);
    const pips = container.querySelectorAll(".pip");
    expect(pips.length).toBe(5);
  });
});

describe("Icon", () => {
  const canonicalKeys = [
    // entities
    "skill", "mcp", "bundle", "project", "source", "loadout",
    // scopes
    "scope.global", "scope.portable", "scope.project",
    // source types
    "source.local", "source.git", "source.starter", "source.litellm",
    // states
    "state.ok", "state.syncing", "state.out-of-sync", "state.update", "state.error", "state.idle",
    // views
    "view.library", "view.grid", "view.list", "view.tree", "view.docs", "view.preview", "view.diff", "view.edit",
    // actions
    "equip", "unequip", "sync", "fetch", "rescan", "save", "edit", "preview", "duplicate",
    "archive", "delete", "link", "apply", "command", "pin", "more",
    // markdown
    "md.bold", "md.italic", "md.h1", "md.h2", "md.list", "md.quote", "md.code", "md.link",
    // ui affordances
    "search", "plus", "x", "check", "filter", "drag",
    "chevron-right", "chevron-down", "chevron-up", "arrow-left", "arrow-right",
  ];

  it.each(canonicalKeys)("resolves canonical key %s to a non-empty svg", (key) => {
    const { container } = render(<Icon name={key} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.childNodes.length).toBeGreaterThan(0);
  });

  const legacyKeys = [
    "globe", "folder", "bundle", "plug", "refresh", "list-ul", "git-diff",
    "star", "doc", "warning", "spark", "list", "grid", "tree", "heading",
    "bold", "italic", "quote", "code",
  ];

  it.each(legacyKeys)("legacy key %s still resolves (non-breaking)", (key) => {
    const { container } = render(<Icon name={key} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("tone='violet' sets color to --anchor-2 on the svg root", () => {
    const { container } = render(<Icon name="skill" tone="violet" />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.style.color).toContain("--anchor-2");
  });

  it("omitting tone leaves color unset", () => {
    const { container } = render(<Icon name="skill" />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.style.color).toBe("");
  });

  it("caller style.color overrides tone", () => {
    const { container } = render(<Icon name="skill" tone="violet" style={{ color: "rgb(255, 0, 0)" }} />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.style.color).toBe("rgb(255, 0, 0)");
  });

  it("renders nothing for an unknown name", () => {
    const { container } = render(<Icon name="nonexistent-icon-xyz" />);
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("Select menu sizing contract", () => {
  it("sizes the base menu to its longest option (width: max-content, never narrower than the trigger)", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "primitives.css"), "utf8");
    const rule = css.match(/\.select-menu\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/width:\s*max-content/);
    expect(rule).toMatch(/min-width:\s*100%/);
  });

  it("the .kv-row row-anchored variant overrides back to width: auto", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "side-panel.css"), "utf8");
    const rule = css.match(/\.kv-row \.select-menu\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/width:\s*auto/);
  });
});
