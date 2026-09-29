import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { ResourceRow } from "@/components/ResourceRow";

describe("ResourceRow — detail slot", () => {
  it("uncontrolled: clicking the chevron flips aria-expanded false→true and reveals the detail node", async () => {
    render(
      <ResourceRow
        name="unslop"
        ariaLabel="unslop"
        detail={<span data-testid="body">Body</span>}
        detailLabel="unslop details"
      />,
    );
    const chevron = screen.getByRole("button", { name: "Show unslop details" });
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("body")).toBeNull();

    await userEvent.click(chevron);

    expect(chevron).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("body")).toBeInTheDocument();
  });

  it("controlled: with detailOpen+onDetailToggle, a click calls the handler and does not change aria-expanded on its own", async () => {
    const onDetailToggle = vi.fn();
    render(
      <ResourceRow
        name="unslop"
        ariaLabel="unslop"
        detail={<span>Body</span>}
        detailOpen={false}
        onDetailToggle={onDetailToggle}
        detailLabel="unslop details"
      />,
    );
    const chevron = screen.getByRole("button", { name: "Show unslop details" });

    await userEvent.click(chevron);

    expect(onDetailToggle).toHaveBeenCalledTimes(1);
    // Controlled: the prop never changed, so the row's own state didn't move.
    expect(chevron).toHaveAttribute("aria-expanded", "false");
  });

  it("aria-controls exists only while the panel is mounted; Enter on the chevron does not fire the row's onClick", async () => {
    const onClick = vi.fn();
    render(
      <ResourceRow
        name="unslop"
        ariaLabel="unslop"
        onClick={onClick}
        detail={<span>Body</span>}
        detailLabel="unslop details"
      />,
    );
    const chevron = screen.getByRole("button", { name: "Show unslop details" });
    expect(chevron).not.toHaveAttribute("aria-controls");

    await userEvent.click(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    const controlsId = chevron.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();
    expect(document.getElementById(controlsId!)).toBeInTheDocument();
    expect(onClick).not.toHaveBeenCalled();

    chevron.focus();
    await userEvent.keyboard("{Enter}");
    // Toggled back closed by the SAME Enter — never bubbled into the row.
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    expect(chevron).not.toHaveAttribute("aria-controls");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("passing exactly one of detailOpen / onDetailToggle logs a dev warning and falls back to uncontrolled", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <ResourceRow
        name="unslop"
        ariaLabel="unslop"
        detail={<span>Body</span>}
        detailOpen={false}
        detailLabel="unslop details"
      />,
    );
    expect(warnSpy).toHaveBeenCalled();

    const chevron = screen.getByRole("button", { name: "Show unslop details" });
    await userEvent.click(chevron);
    // Uncontrolled fallback: the row's own state flips despite the unpaired prop.
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    warnSpy.mockRestore();
  });

  it("a row given ariaLabel is named by it alone — not diluted by the chevron's own label", () => {
    render(
      <ResourceRow
        name="unslop"
        onClick={() => {}}
        ariaLabel="unslop"
        detail={<span>Body</span>}
        detailLabel="unslop details"
      />,
    );
    const row = screen.getByRole("button", { name: "unslop" });
    expect(row).not.toHaveAccessibleName("Show unslop details");
    // A name lookup for the row's own label matches exactly one button — the
    // chevron's separate "Show unslop details" name never folds into it.
    expect(screen.getAllByRole("button", { name: "unslop" })).toHaveLength(1);
  });

  it("tabIndex={-1} puts -1 on both the row root and the chevron (a roving wrapper owns the one tab stop)", () => {
    render(
      <ResourceRow
        name="unslop"
        onClick={() => {}}
        ariaLabel="unslop"
        tabIndex={-1}
        detail={<span>Body</span>}
        detailLabel="unslop details"
      />,
    );
    const row = screen.getByRole("button", { name: "unslop" });
    expect(row).toHaveAttribute("tabindex", "-1");
    const chevron = screen.getByRole("button", { name: "Show unslop details" });
    expect(chevron).toHaveAttribute("tabindex", "-1");
  });
});
