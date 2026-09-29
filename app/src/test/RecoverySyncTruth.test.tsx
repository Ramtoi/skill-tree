import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SyncReportDrawer } from "@/components/SyncReportDrawer";
import { projectsInsights } from "@/lib/navInsights";
import type { SyncReportEnvelope } from "@/lib/syncFreshness";
import type { Registry } from "@/types";
import { makeQueryClient, mockSyncReport, primeRegistry, renderWithProviders } from "./helpers";

it("reports the restore incident as zero synced, thirteen unattached and two failed", async () => {
  const registry: Registry = { version: "1", skills: {}, bundles: {}, projects: {} };
  const envelope: SyncReportEnvelope = {
    report: {
      schema_version: 1, generated_at: new Date().toISOString(),
      registry_sha256: "current", registry_mtime: 0, ok: false, projects: {},
      global: {
        skipped: [], skills: { writes: 0, removed: 0 }, mcp: { writes: 0, removed: 0 },
        permissions: { ok: true, errors: [] }, remotes: { attempted: 0, alarming: 0 },
      },
    },
    registry_current: { sha256: "current", mtime: 0 },
  };
  for (let i = 0; i < 15; i++) {
    const name = `project-${i}`;
    const unattached = i < 13;
    registry.projects[name] = {
      path: `/historical/${name}`, bundles: [], enabled: [], path_unresolved: unattached,
    };
    envelope.report.projects[name] = {
      ts: envelope.report.generated_at, ok: unattached, writes: 0, removed: 0, affinity_skips: [],
      ...(unattached ? { quarantined: "path_unresolved" } : {}),
      errors: unattached ? [] : ["a", "b", "c", "d", "e"].flatMap((skill) => [
        { stage: "symlink", message: `source missing: /sources/${skill}` },
        { stage: "invocation", message: `source missing: /sources/${skill}`, skill },
      ]),
    };
  }
  const insights = projectsInsights(registry, envelope, []);
  expect(insights.tiles[0].value).toBe("0/15");
  expect(insights.tiles[0].title).toContain("13 unattached");
  expect(insights.tiles[0].title).toContain("2 failed");

  const client = makeQueryClient();
  primeRegistry(client, registry);
  mockSyncReport(envelope);
  client.setQueryData(["syncReport"], envelope);
  const { container } = renderWithProviders(<SyncReportDrawer open onClose={vi.fn()} />, { client });
  expect(await screen.findAllByText("no directory")).toHaveLength(13);
  expect(container.querySelectorAll('.fresh-dot[data-state="fresh"]')).toHaveLength(0);
  await userEvent.click(screen.getByText("project-13"));
  expect(screen.getAllByText(/^source missing: \/sources\//)).toHaveLength(5);
});
