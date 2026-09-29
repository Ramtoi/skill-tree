import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";

import {
  DescriptionMeter,
  descriptionFieldClass,
} from "@/components/DescriptionMeter";
import {
  CLOUD_DESCRIPTION_MAX,
  SPEC_DESCRIPTION_MAX,
  TRIGGER_TRUNCATION_CAP,
  descriptionLengthState,
} from "@/lib/descriptionLimits";

const CLOUD_NOTE = "Over claude.ai's 200-char limit.";
const TRUNCATE_NOTE =
  "Claude Code truncates at 250 when deciding to trigger; claude.ai caps at 200.";
const SPEC_NOTE =
  "Exceeds the Agent Skills spec limit of 1024. Codex refuses to load it.";

const chars = (n: number) => "x".repeat(n);
const meter = () => document.querySelector(".desc-meter") as HTMLElement;

describe("descriptionLengthState", () => {
  it("stays ok up to the claude.ai limit", () => {
    expect(descriptionLengthState(0)).toEqual({ tier: "ok", note: null });
    expect(descriptionLengthState(CLOUD_DESCRIPTION_MAX)).toEqual({
      tier: "ok",
      note: null,
    });
  });

  it("warns about claude.ai between 201 and 250", () => {
    expect(descriptionLengthState(CLOUD_DESCRIPTION_MAX + 1)).toEqual({
      tier: "cloud",
      note: CLOUD_NOTE,
    });
    expect(descriptionLengthState(TRIGGER_TRUNCATION_CAP)).toEqual({
      tier: "cloud",
      note: CLOUD_NOTE,
    });
  });

  it("warns about trigger truncation between 251 and 1024", () => {
    expect(descriptionLengthState(TRIGGER_TRUNCATION_CAP + 1)).toEqual({
      tier: "truncate",
      note: TRUNCATE_NOTE,
    });
    expect(descriptionLengthState(SPEC_DESCRIPTION_MAX)).toEqual({
      tier: "truncate",
      note: TRUNCATE_NOTE,
    });
  });

  it("flags the spec limit past 1024", () => {
    expect(descriptionLengthState(SPEC_DESCRIPTION_MAX + 1)).toEqual({
      tier: "spec",
      note: SPEC_NOTE,
    });
  });
});

describe("DescriptionMeter", () => {
  it("renders the count against the claude.ai limit", () => {
    render(<DescriptionMeter value={chars(42)} />);
    expect(screen.getByText("42 / 200")).toBeInTheDocument();
  });

  it("shows no note at or below 200", () => {
    render(<DescriptionMeter value={chars(CLOUD_DESCRIPTION_MAX)} />);
    expect(meter()).toHaveAttribute("data-tier", "ok");
    expect(document.querySelector(".desc-meter-note")).toBeNull();
  });

  it("shows the claude.ai note at 201", () => {
    render(<DescriptionMeter value={chars(CLOUD_DESCRIPTION_MAX + 1)} />);
    expect(meter()).toHaveAttribute("data-tier", "cloud");
    expect(screen.getByText(CLOUD_NOTE)).toBeInTheDocument();
  });

  it("stays on the claude.ai note at 250", () => {
    render(<DescriptionMeter value={chars(TRIGGER_TRUNCATION_CAP)} />);
    expect(meter()).toHaveAttribute("data-tier", "cloud");
    expect(screen.getByText(CLOUD_NOTE)).toBeInTheDocument();
  });

  it("shows the truncation note at 251", () => {
    render(<DescriptionMeter value={chars(TRIGGER_TRUNCATION_CAP + 1)} />);
    expect(meter()).toHaveAttribute("data-tier", "truncate");
    expect(screen.getByText(TRUNCATE_NOTE)).toBeInTheDocument();
  });

  it("stays on the truncation note at 1024", () => {
    render(<DescriptionMeter value={chars(SPEC_DESCRIPTION_MAX)} />);
    expect(meter()).toHaveAttribute("data-tier", "truncate");
    expect(screen.getByText(TRUNCATE_NOTE)).toBeInTheDocument();
  });

  it("shows the spec note past 1024", () => {
    render(<DescriptionMeter value={chars(SPEC_DESCRIPTION_MAX + 1)} />);
    expect(meter()).toHaveAttribute("data-tier", "spec");
    expect(screen.getByText(SPEC_NOTE)).toBeInTheDocument();
  });
});

describe("descriptionFieldClass", () => {
  it("tints nothing while the description is in budget", () => {
    expect(descriptionFieldClass(chars(CLOUD_DESCRIPTION_MAX))).toBe("");
  });

  it("tints amber for both warn tiers", () => {
    expect(descriptionFieldClass(chars(CLOUD_DESCRIPTION_MAX + 1))).toBe(
      "field-desc-warn",
    );
    expect(descriptionFieldClass(chars(TRIGGER_TRUNCATION_CAP))).toBe(
      "field-desc-warn",
    );
    expect(descriptionFieldClass(chars(TRIGGER_TRUNCATION_CAP + 1))).toBe(
      "field-desc-warn",
    );
    expect(descriptionFieldClass(chars(SPEC_DESCRIPTION_MAX))).toBe(
      "field-desc-warn",
    );
  });

  it("tints red only past the spec limit", () => {
    expect(descriptionFieldClass(chars(SPEC_DESCRIPTION_MAX + 1))).toBe(
      "field-desc-over",
    );
  });
});

describe("DescriptionMeter muted", () => {
  it("renders the count alone, tier-neutral, when muted", () => {
    render(
      <DescriptionMeter value={chars(SPEC_DESCRIPTION_MAX + 1)} muted />,
    );
    expect(meter()).toHaveAttribute("data-tier", "ok");
    expect(document.querySelector(".desc-meter-note")).toBeNull();
    expect(
      screen.getByText(`${SPEC_DESCRIPTION_MAX + 1} / ${CLOUD_DESCRIPTION_MAX}`),
    ).toBeInTheDocument();
  });

  it("still shows the tier and note when not muted", () => {
    render(<DescriptionMeter value={chars(SPEC_DESCRIPTION_MAX + 1)} />);
    expect(meter()).toHaveAttribute("data-tier", "spec");
    expect(screen.getByText(SPEC_NOTE)).toBeInTheDocument();
  });
});

// CLOUD_DESCRIPTION_MAX is a hand-kept mirror of DESCRIPTION_MAX in
// skill_hub/infrastructure/filesystem/cloud_targets.py. Pin them together so a
// backend bump fails here instead of silently teaching the UI a stale limit.
// Repo root is resolved the same way
// cliContract.test.ts locates hub.py: vitest runs with cwd = app/.
describe("cloud limit drift", () => {
  it("matches DESCRIPTION_MAX in cloud_targets.py", () => {
    const repoRoot = path.resolve(process.cwd(), "..");
    const src = fs.readFileSync(
      path.join(
        repoRoot,
        "skill_hub",
        "infrastructure",
        "filesystem",
        "cloud_targets.py",
      ),
      "utf8",
    );
    expect(src).toContain(`DESCRIPTION_MAX = ${CLOUD_DESCRIPTION_MAX}`);
  });
});
