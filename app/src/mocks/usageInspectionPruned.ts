import type { InspectionChange, InspectionToolCall } from "@/features/usage/usageInspectionTypes";

/**
 * Wave-1 retention demo data: a retained request next to a pruned result, a
 * pruned input, two identical-hash calls (must still group), and a pruned
 * patch. Layered onto the base claude-code fixture session behind the
 * `usagePruned` query flag so the PR preview and e2e journey can reach it
 * without touching the shared inspection-session.json fixture.
 */
const RUN_ID = "a27867c5fd3bd4647578e0c4273ed65f72679dcdc4c426afc0b1f488752ed2fa";

export const PRUNED_DEMO_TOOL_CALLS: InspectionToolCall[] = [
  {
    id: "call:pruned-demo-retained-input",
    run_id: RUN_ID,
    ordinal: 100,
    at: "2026-09-07T12:05:00.000Z",
    tool: { name: "Bash", kind: "local" },
    operation: { signature: "op:1111111111111111111111111111111111111111111111111111111111111111", summary: "Runs a shell command", status: "available" },
    execution: "completed",
    input_parts: [{ kind: "invocation", status: "available", content_type: "application/json", bytes: 34, body_id: "body:pruned-demo-retained-input" }],
    result_parts: [{ kind: "tool_result_content", status: "pruned", content_type: "text/plain", bytes: 0, pruned_at: "2026-09-16T00:00:00.000Z" }],
    source_epoch: "<captured-epoch>",
    evidence: [],
  },
  {
    id: "call:pruned-demo-pruned-input",
    run_id: RUN_ID,
    ordinal: 101,
    at: "2026-09-07T12:05:02.000Z",
    tool: { name: "Edit", kind: "local" },
    operation: { signature: "op:2222222222222222222222222222222222222222222222222222222222222222", summary: "Updates a file", status: "available" },
    execution: "completed",
    input_parts: [{ kind: "invocation", status: "pruned", content_type: "application/json", bytes: 0, pruned_at: "2026-09-16T00:00:00.000Z" }],
    result_parts: [{ kind: "tool_result_content", status: "available", content_type: "text/plain", bytes: 12, body_id: "body:pruned-demo-retained-result" }],
    source_epoch: "<captured-epoch>",
    evidence: [],
  },
  {
    id: "call:pruned-demo-repeat-a",
    run_id: RUN_ID,
    ordinal: 102,
    at: "2026-09-07T12:05:04.000Z",
    tool: { name: "Read", kind: "local" },
    operation: { signature: "op:3333333333333333333333333333333333333333333333333333333333333333", summary: "Reads a repository file", status: "available" },
    execution: "completed",
    input_parts: [{ kind: "invocation", status: "available", content_type: "application/json", bytes: 20, body_id: "body:pruned-demo-repeat-a-input" }],
    result_parts: [{ kind: "tool_result_content", status: "available", content_type: "text/plain", bytes: 40, body_id: "body:pruned-demo-repeat-a-result" }],
    source_epoch: "<captured-epoch>",
    evidence: [],
  },
  {
    id: "call:pruned-demo-repeat-b",
    run_id: RUN_ID,
    ordinal: 103,
    at: "2026-09-07T12:05:06.000Z",
    tool: { name: "Read", kind: "local" },
    // Identical signature to the call above: repeated identical hashes must
    // still collapse into one group.
    operation: { signature: "op:3333333333333333333333333333333333333333333333333333333333333333", summary: "Reads a repository file", status: "available" },
    execution: "completed",
    input_parts: [{ kind: "invocation", status: "available", content_type: "application/json", bytes: 20, body_id: "body:pruned-demo-repeat-b-input" }],
    result_parts: [{ kind: "tool_result_content", status: "available", content_type: "text/plain", bytes: 40, body_id: "body:pruned-demo-repeat-b-result" }],
    source_epoch: "<captured-epoch>",
    evidence: [],
  },
];

export const PRUNED_DEMO_BODIES: Record<string, { content_type: string; text: string }> = {
  "body:pruned-demo-retained-input": { content_type: "application/json", text: "{\"command\":\"printf retained\"}" },
  "body:pruned-demo-retained-result": { content_type: "text/plain", text: "retained\n" },
  "body:pruned-demo-repeat-a-input": { content_type: "application/json", text: "{\"file_path\":\"demo.txt\"}" },
  "body:pruned-demo-repeat-a-result": { content_type: "text/plain", text: "demo file contents a\n" },
  "body:pruned-demo-repeat-b-input": { content_type: "application/json", text: "{\"file_path\":\"demo.txt\"}" },
  "body:pruned-demo-repeat-b-result": { content_type: "text/plain", text: "demo file contents b\n" },
};

export const PRUNED_DEMO_CHANGE: InspectionChange = {
  id: "<pruned-demo-change>",
  kind: "tool_patch",
  source: "<captured-epoch>",
  repository_id: null,
  revision_id: null,
  base_id: null,
  merge_base_id: null,
  captured_at: "2026-09-07T12:10:05.000Z",
  files: ["pruned-demo.txt"],
  patch: { kind: "invocation", status: "pruned", content_type: "application/json", bytes: 0, pruned_at: "2026-09-16T00:00:00.000Z" },
  attribution: "confirmed",
};
