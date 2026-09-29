import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { ProjectReviewProvider, useProjectReview } from "@/screens/project/ProjectReviewProvider";
import { qk } from "@/lib/queryKeys";
import type { UsageProjectPayload } from "@/features/usage/usageAnalyticsTypes";
import { makeQueryClient, renderWithProviders } from "./helpers";

function Consumer() {
  const review = useProjectReview();
  return <output data-testid="review">{review.finding?.id ?? "none"}:{review.activeAreas.join(",")}</output>;
}

const payload = {
  findings: [{
    id: "verify-1", kind: "verification", project: "moon-base", observation: "Verify docs",
    numbers: {}, moves: [], review: { area: "agent-docs", project: "moon-base", highlight: [], also: ["loadout"] },
  }],
} as unknown as UsageProjectPayload;

describe("ProjectReviewProvider", () => {
  it("resolves a deep-linked review from the shared 30-day project cache", async () => {
    const client = makeQueryClient();
    client.setQueryData(qk.usageProject("moon-base", 30), payload);
    renderWithProviders(
      <ProjectReviewProvider projectName="moon-base"><Consumer /></ProjectReviewProvider>,
      { client, initialRoute: "/project/moon-base?tab=agent-docs&review=verify-1" },
    );
    expect(await screen.findByTestId("review")).toHaveTextContent("verify-1:agent-docs,loadout");
  });

  it("stays inactive for an unknown review id", () => {
    const client = makeQueryClient();
    client.setQueryData(qk.usageProject("moon-base", 30), payload);
    renderWithProviders(
      <ProjectReviewProvider projectName="moon-base"><Consumer /></ProjectReviewProvider>,
      { client, initialRoute: "/project/moon-base?review=missing" },
    );
    expect(screen.getByTestId("review")).toHaveTextContent("none:");
  });
});
