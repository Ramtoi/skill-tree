import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageModelsCard } from "@/screens/usage/UsageCompositionAndModels";
import type { ModelTotal } from "@/screens/usage/usageAggregate";

function model(modelName: string, total: number, costUsd: number, costKnown?: boolean): ModelTotal {
  return {
    modelName,
    tokens: { input: total, output: 0, cacheCreation: 0, cacheRead: 0, total },
    costUsd,
    ...(costKnown !== undefined ? { costKnown } : {}),
  };
}

describe("UsageModelsCard", () => {
  it("hovers back the exact token count its compacted sub rounds away", () => {
    // This is the ONE `HorizontalBarList` caller whose row carries a compacted
    // figure (`sub`: "29.5B tokens"), so it is the one that must pass
    // `titleText` — otherwise the row's title is only the cost, which was
    // never the rounded number.
    const { container } = render(
      <UsageModelsCard
        models={[model("claude-sonnet-5", 29_492_592_142, 6921.07)]}
        currency="USD"
        eurRate={0.86}
      />,
    );

    expect(screen.getByText("29.5B tokens")).toBeInTheDocument();
    const title = container.querySelector(".hbar-row")?.getAttribute("title") ?? "";
    expect(title).toContain("29,492,592,142 tokens");
    expect(title).toContain("6,921.07");
  });

  it("drops a model with neither tokens nor cost in range", () => {
    render(
      <UsageModelsCard
        models={[model("dead-model", 0, 0), model("live-model", 10, 1)]}
        currency="USD"
        eurRate={0.86}
      />,
    );
    expect(screen.queryByText("dead-model")).toBeNull();
    expect(screen.getByText("live-model")).toBeInTheDocument();
  });

  it("keeps a history-built model list's cost ranking: a null-cost (backfilled) model never outranks a priced one", () => {
    // The shape `scopeFromDaily` produces for a range with a backfilled
    // stretch — "Unknown model" carries real tokens but no cost. The card
    // demotes any unpriced model below every priced one (see the dedicated
    // ranking test below); with only one of each here, that is the same
    // order the incoming (already cost-sorted) list already had.
    const backfilled = model("Unknown model", 900_000, 0);
    const priced = model("claude-sonnet-5", 200, 4);
    render(<UsageModelsCard models={[priced, backfilled]} currency="USD" eurRate={0.86} />);

    const rows = screen.getAllByText(/Sonnet 5|Unknown model/).map((el) => el.textContent);
    expect(rows).toEqual(["Sonnet 5", "Unknown model"]);
    // The backfilled model is not dropped — it has real tokens even with 0 cost.
    expect(screen.getByText("Unknown model")).toBeInTheDocument();
  });

  it("renders a provider glyph and a display name for each model row", () => {
    const { container } = render(
      <UsageModelsCard models={[model("claude-sonnet-5", 200, 4)]} currency="USD" eurRate={0.86} />,
    );
    expect(screen.getByText("Sonnet 5")).toBeInTheDocument();
    expect(container.querySelector('[data-harness="claude-code"]')).toBeInTheDocument();
  });

  it("shows an unpriced tag instead of $0.00 for a model with tokens and no cost", () => {
    render(<UsageModelsCard models={[model("claude-opus-5", 5_000, 0)]} currency="USD" eurRate={0.86} />);
    expect(screen.getByText("unpriced")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    const row = screen.getByRole("listitem");
    expect(row).toHaveAttribute("title", "No price for this model in the current price table");
  });

  it("gives a backfilled-only model (costKnown: false) no unpriced tag — its cost gap already has its own explanation", () => {
    render(
      <UsageModelsCard
        models={[model("Unknown model", 900_000, 0, false)]}
        currency="USD"
        eurRate={0.86}
      />,
    );
    expect(screen.queryByText("unpriced")).not.toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("keeps the raw model id on hover", () => {
    render(<UsageModelsCard models={[model("claude-sonnet-5", 200, 4)]} currency="USD" eurRate={0.86} />);
    expect(screen.getByText("Sonnet 5").closest(".usage-model-name")).toHaveAttribute("title", "claude-sonnet-5");
  });

  it("ranks an unpriced model below every priced one and orders unpriced ones by tokens", () => {
    const cheap = model("gpt-5.4", 100, 1);
    const bigUnpriced = model("claude-opus-5", 5_000, 0);
    const smallUnpriced = model("claude-fable-5-1", 1_000, 0);
    const expensive = model("claude-sonnet-5", 300, 9);
    render(
      <UsageModelsCard
        models={[expensive, cheap, bigUnpriced, smallUnpriced]}
        currency="USD"
        eurRate={0.86}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    const names = rows.map((row) => row.querySelector(".usage-model-name")?.getAttribute("title"));
    expect(names).toEqual(["claude-sonnet-5", "gpt-5.4", "claude-opus-5", "claude-fable-5-1"]);
  });
});
