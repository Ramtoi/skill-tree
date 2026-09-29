import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { UsageSessionToolCalls } from "@/screens/usage/UsageSessionToolCalls";
import type { InspectionToolCall } from "@/features/usage/usageInspectionTypes";

function capturedCall(overrides: Partial<InspectionToolCall> & { id: string; signature: string; summary: string }): InspectionToolCall {
  return {
    run_id: "main",
    ordinal: 0,
    at: "2026-09-07T12:00:00.000Z",
    tool: { name: "Bash", kind: "local" },
    operation: { summary: overrides.summary, signature: overrides.signature, status: "available" },
    execution: "completed",
    input_parts: [],
    result_parts: [],
    source_epoch: "epoch",
    evidence: [],
    ...overrides,
  };
}

describe("UsageSessionToolCalls captured retention states", () => {
  it("names a retained request next to a pruned result, disabled with no retry", () => {
    const call = capturedCall({
      id: "call:1", signature: "op:aaa", summary: "Runs a shell command",
      input_parts: [{ kind: "invocation", status: "available", content_type: "application/json", bytes: 20, body_id: "body:1" }],
      result_parts: [{ kind: "tool_result_content", status: "pruned", content_type: "text/plain", bytes: 0, pruned_at: "2026-06-01T00:00:00.000Z" }],
    });
    render(<UsageSessionToolCalls calls={[call]} />);
    fireEvent.click(screen.getByRole("button", { name: /Runs a shell command/ }));
    expect(screen.getByRole("button", { name: /^Input: available/ })).toBeEnabled();
    const prunedResult = screen.getByRole("button", { name: /Result pruned/ });
    expect(prunedResult).toBeDisabled();
    expect(prunedResult).toHaveTextContent(new Date("2026-06-01T00:00:00.000Z").toLocaleDateString());
  });

  it("names a pruned input with its date, disabled", () => {
    const call = capturedCall({
      id: "call:2", signature: "op:bbb", summary: "Updates a file", tool: { name: "Edit", kind: "local" },
      input_parts: [{ kind: "invocation", status: "pruned", content_type: "application/json", bytes: 0, pruned_at: "2026-06-02T00:00:00.000Z" }],
      result_parts: [{ kind: "tool_result_content", status: "available", content_type: "text/plain", bytes: 12, body_id: "body:2" }],
    });
    render(<UsageSessionToolCalls calls={[call]} />);
    fireEvent.click(screen.getByRole("button", { name: /Updates a file/ }));
    const prunedInput = screen.getByRole("button", { name: /Input pruned/ });
    expect(prunedInput).toBeDisabled();
    expect(prunedInput).toHaveTextContent(new Date("2026-06-02T00:00:00.000Z").toLocaleDateString());
  });

  it("groups distinct signatures with an equal summary separately, and displays the summary not the hash", () => {
    const calls = [
      capturedCall({ id: "call:1", signature: "op:aaa", summary: "Runs a shell command" }),
      capturedCall({ id: "call:2", signature: "op:bbb", summary: "Runs a shell command", at: "2026-09-07T12:00:01.000Z" }),
    ];
    render(<UsageSessionToolCalls calls={calls} />);
    const toggles = screen.getAllByRole("button", { name: /Runs a shell command/ });
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) {
      expect(within(toggle).getByText("1 call")).toBeInTheDocument();
      expect(within(toggle).queryByText("op:aaa")).toBeNull();
      expect(within(toggle).queryByText("op:bbb")).toBeNull();
    }
  });

  it("still groups repeated identical signatures", () => {
    const calls = [
      capturedCall({ id: "call:1", signature: "op:aaa", summary: "Runs a shell command" }),
      capturedCall({ id: "call:2", signature: "op:aaa", summary: "Runs a shell command", at: "2026-09-07T12:00:01.000Z" }),
    ];
    render(<UsageSessionToolCalls calls={calls} />);
    expect(screen.getAllByRole("button", { name: /Runs a shell command/ })).toHaveLength(1);
    expect(screen.getByText("2 calls")).toBeInTheDocument();
  });
});

describe("UsageSessionToolCalls while later pages are still arriving", () => {
  it("shows the pages already read and says how much of the total is in", () => {
    const calls = [capturedCall({ id: "call:1", signature: "op:aaa", summary: "Runs a shell command" })];
    render(<UsageSessionToolCalls calls={calls} streaming={{ loaded: 500, total: 10665 }} />);
    expect(screen.getByRole("button", { name: /Runs a shell command/ })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("loading the rest, 500 of 10,665 read");
  });

  it("waits for the first page instead of claiming the session has no tool calls", () => {
    render(<UsageSessionToolCalls calls={[]} streaming={{ loaded: 0, total: 10665 }} />);
    expect(screen.queryByText("No tool calls were captured for this session.")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("loading the rest, 0 of 10,665 read");
  });

  it("still names a genuinely empty capture once nothing is streaming", () => {
    render(<UsageSessionToolCalls calls={[]} />);
    expect(screen.getByText("No tool calls were captured for this session.")).toBeVisible();
  });
});
