import { describe, it, expect } from "vitest";
import { invoke } from "@/mocks/tauriCore";
import { parseHubJson } from "@/lib/cloud";
import { parseCliJson } from "@/lib/skillPack";
import type { GlobalDocStatusRow } from "@/hooks/useGlobalDocStatus";

// The mocked-Tauri backend (`src/mocks/tauriCore.ts`) is what every visual
// scene and every Playwright journey for global-doc sharing renders against.
// If it can answer in a shape the REAL `hub harness doc …` never emits, the
// screenshots and the journeys both certify a screen no user will ever see.
//
// NOTE ON STATE: `docSharingState` is module-level and these calls MUTATE it.
// Vitest gives each test FILE its own module registry, so the mutation cannot
// reach another suite; inside this file the order below is deliberate.

interface HubOut {
	success: boolean;
	output: string;
}

const hub = (args: string[]) => invoke<HubOut>("hub_cmd", { args });

const STATES = [
	"missing",
	"standalone",
	"source",
	"follows",
	"broken",
	"external",
];

async function status(): Promise<GlobalDocStatusRow[]> {
	const res = await hub(["harness", "doc", "status", "--json"]);
	expect(res.success).toBe(true);
	return parseHubJson<GlobalDocStatusRow[]>(res.output);
}

describe("mocked backend — `hub harness doc status` shape", () => {
	it("answers a top-level array of well-formed rows", async () => {
		const rows = await status();
		expect(rows.length).toBeGreaterThan(0);
		for (const r of rows) {
			expect(STATES).toContain(r.state);
			expect(typeof r.harness).toBe("string");
			expect(typeof r.label).toBe("string");
			expect(typeof r.path).toBe("string");
			expect(Array.isArray(r.followers)).toBe(true);
			// `bytes` belongs to a REAL file only — a link has none of its own.
			if (r.state === "follows" || r.state === "missing") {
				expect(r.bytes).toBeNull();
			} else if (r.state === "standalone" || r.state === "source") {
				expect(typeof r.bytes).toBe("number");
			}
			// `source` is derived, never asserted: it means somebody follows me.
			expect(r.state === "source").toBe(r.followers.length > 0);
		}
	});

	it("never emits a chain — a follower's source is always a real file", async () => {
		const rows = await status();
		const byId = new Map(rows.map((r) => [r.harness, r]));
		for (const r of rows.filter((x) => x.state === "follows")) {
			const src = byId.get(r.follows ?? "");
			expect(src, `${r.harness} follows an unknown harness`).toBeDefined();
			expect(["standalone", "source"]).toContain(src!.state);
			expect(src!.followers).toContain(r.harness);
		}
	});
});

describe("mocked backend — link/unlink answer the real CLI's shapes", () => {
	it("linking onto a harness that has its own file is a FAILING call whose stdout still carries the conflict", async () => {
		// This is the exit-2 contract: a non-zero exit with the payload on
		// stdout. The Rust bridge concatenates stdout first (see
		// `commands/hub.rs::combine_streams`), so the frontend can parse it.
		const res = await hub([
			"harness",
			"doc",
			"link",
			"opencode",
			"--to",
			"claude-code",
			"--json",
		]);
		expect(res.success).toBe(false);
		const payload = parseCliJson<{
			error: string;
			harness: string;
			existing_bytes: number;
			preview: string;
		}>(res.output);
		expect(payload.error).toBe("conflict");
		expect(payload.harness).toBe("opencode");
		expect(payload.existing_bytes).toBeGreaterThan(0);
		expect(payload.preview.length).toBeGreaterThan(0);
	});

	it("a decision links it, and the status scan agrees on the next read", async () => {
		const res = await hub([
			"harness",
			"doc",
			"link",
			"opencode",
			"--to",
			"claude-code",
			"--on-conflict",
			"replace",
			"--json",
		]);
		expect(res.success).toBe(true);
		expect(parseCliJson<{ changed: boolean }>(res.output).changed).toBe(true);

		const rows = await status();
		const oc = rows.find((r) => r.harness === "opencode")!;
		expect(oc.state).toBe("follows");
		expect(oc.follows).toBe("claude-code");
		expect(oc.bytes).toBeNull();
		expect(rows.find((r) => r.harness === "claude-code")!.followers).toContain(
			"opencode",
		);
	});

	it("a follower reads the SOURCE's bytes through global_doc_read", async () => {
		const doc = await invoke<{
			path: string;
			resolved_path: string;
			is_link: boolean;
			content: string;
		}>("global_doc_read", { harnessId: "opencode" });
		expect(doc.is_link).toBe(true);
		expect(doc.path).toContain("opencode");
		expect(doc.resolved_path).toContain(".claude/CLAUDE.md");
		expect(doc.content).toContain("Global instructions");
	});

	it("unlinking hands the file back with the shared text in it", async () => {
		const res = await hub(["harness", "doc", "unlink", "opencode", "--json"]);
		expect(res.success).toBe(true);
		const payload = parseCliJson<{ changed: boolean; bytes: number }>(
			res.output,
		);
		expect(payload.changed).toBe(true);
		expect(payload.bytes).toBeGreaterThan(0);
		const rows = await status();
		expect(rows.find((r) => r.harness === "opencode")!.state).toBe("standalone");
	});

	it("unlinking something that follows nothing is a refusal, not a silent no-op", async () => {
		const res = await hub(["harness", "doc", "unlink", "opencode", "--json"]);
		expect(res.success).toBe(false);
		expect(parseCliJson<{ error: string }>(res.output).error).toBe(
			"not_a_follower",
		);
	});

	it("refuses a self-link", async () => {
		const res = await hub([
			"harness",
			"doc",
			"link",
			"codex",
			"--to",
			"codex",
			"--json",
		]);
		expect(res.success).toBe(false);
		expect(parseCliJson<{ error: string }>(res.output).error).toBe(
			"same_harness",
		);
	});
});
