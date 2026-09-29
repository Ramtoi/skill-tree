import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import {
	bundleDeleteLanded,
	bundleWarningText,
	bundleWriteLanded,
	cliErrorMessage,
	errText,
	parseAutoSyncTail,
	parseCmdPayload,
	runRegistryWrite,
	showBundleWarnings,
} from "@/lib/hubWrite";
import { HubCommandError } from "@/lib/hubCmd";

/** Payload first, then auto-sync chatter that CARRIES BRACES — the shape every
 *  `--json` verb actually emits. */
function withChatter(payload: object): string {
	return `${JSON.stringify(payload)}\nSyncing {example-app} → /Users/dev/{proj}\nwrote .claude/settings.json {ok}`;
}

beforeEach(() => {
	vi.mocked(invoke).mockReset();
});

describe("parseCmdPayload", () => {
	it("reads the payload line even when the chatter contains braces", () => {
		const p = parseCmdPayload<{ created?: boolean }>(
			withChatter({ bundle: { name: "b" }, created: true }),
		);
		expect(p?.created).toBe(true);
	});

	it("falls back to the tolerant parser for a pretty-printed payload", () => {
		const p = parseCmdPayload<{ ok?: boolean }>(
			'{\n  "ok": true\n}\ndone',
		);
		expect(p?.ok).toBe(true);
	});

	it("returns null when there is no payload at all", () => {
		expect(parseCmdPayload("Traceback: boom")).toBeNull();
		expect(parseCmdPayload("")).toBeNull();
	});
});

describe("parseAutoSyncTail", () => {
	const E = String.fromCharCode(27);
	const marker = `${E}[33m  ! auto-sync exited with rc 2 (doctor danger findings) — the mutation itself succeeded${E}[0m`;

	it("uses stdout when the marker is the only stderr line", () => {
		expect(
			parseAutoSyncTail({
				stdout: `${E}[31m✗ sync completed with danger findings${E}[0m\n`,
				stderr: marker,
			}),
		).toEqual({
			partial: true,
			headline: "✗ sync completed with danger findings",
		});
	});

	it("prefers a real stderr line after removing the marker", () => {
		expect(
			parseAutoSyncTail({
				stdout: "Syncing registry → agent folders\n",
				stderr: `${marker}\nerror: project is invalid\n`,
			}),
		).toEqual({ partial: true, headline: "error: project is invalid" });
	});

	it("ignores an ordinary stderr advisory and keeps the stdout sync failure", () => {
		const E = String.fromCharCode(27);
		const marker = `${E}[33m  ! auto-sync exited with rc 2 (doctor danger findings) — the mutation itself succeeded${E}[0m`;
		const result = parseAutoSyncTail({
			stdout: `${E}[31m✗ sync completed with danger findings${E}[0m\n`,
			stderr: `${E}[33m  ! unknown harness 'codex' is not installed${E}[0m\n${marker}\n`,
		});
		expect(result).toEqual({
			partial: true,
			headline: "✗ sync completed with danger findings",
		});
	});

	it("uses the exception detail carried by the marker", () => {
		expect(
			parseAutoSyncTail({
				stdout: "",
				stderr:
					"  ! auto-sync failed: permission denied — the mutation itself succeeded\n",
			}),
		).toEqual({ partial: true, headline: "permission denied" });
	});

	it("stays quiet when there is no partial-success marker", () => {
		expect(
			parseAutoSyncTail({ stdout: "✓ synced\n", stderr: "" }),
		).toEqual({ partial: false, headline: null });
	});
});

describe("cliErrorMessage", () => {
	it("prefers the first entry of an `errors` list", () => {
		expect(
			cliErrorMessage('{"bundle": null, "errors": ["unknown skill: ghost"]}'),
		).toBe("unknown skill: ghost");
	});

	it("reads the source verbs' single `error` string", () => {
		expect(
			cliErrorMessage('{"ok": false, "error": "git fetch failed"}\naborted'),
		).toBe("git fetch failed");
	});

	it("falls back to the raw text only when the payload says nothing", () => {
		expect(cliErrorMessage("boom")).toBe("boom");
		expect(cliErrorMessage("   ")).toBe("the command failed");
	});

	// ── Shared with the sync failure surface (lib/cliOutput) ─────────────────
	// The payload branches above are hubWrite's own contract. The FALLBACK is
	// not: it routes through the same extractor the sync card uses, so a bundle
	// write and a sync failure can never disagree about what "the error" is.
	it("strips ANSI from the fallback instead of dumping raw bytes", () => {
		const E = String.fromCharCode(27);
		expect(cliErrorMessage(`${E}[1m${E}[31mboom: bad thing${E}[0m`)).toBe(
			"boom: bad thing",
		);
	});

	it("prefers stderr over stdout chatter when the streams are supplied", () => {
		const stdout = "Syncing registry → agent folders\n✓ example-app: 6 skills\n";
		const stderr = "unknown source: ghost\n";
		expect(
			cliErrorMessage(stdout + stderr, { stdout, stderr }),
		).toBe("unknown source: ghost");
	});

	it("never falls back to a green success tick", () => {
		// `cmd_enable`-shaped stdout: the tick is printed BEFORE the auto-sync
		// that failed. Dumping `output.trim()` used to headline it.
		const stdout = [
			"✓ enabled 'design-an-interface' for 'example-app'.",
			"Syncing registry → agent folders",
			"no such project: 'ghost-app'",
		].join("\n");
		const msg = cliErrorMessage(stdout, { stdout, stderr: "" });
		expect(msg).toBe("no such project: 'ghost-app'");
		expect(msg).not.toContain("✓");
	});
});

describe("errText", () => {
	it("unwraps a HubCommandError to its headline, not its class name", () => {
		const E = String.fromCharCode(27);
		const stderr = `${E}[31mSkill registry validation failed:${E}[0m\n  - qa-2 clashes\n`;
		const err = new HubCommandError(
			{ success: false, output: stderr, stdout: "", stderr },
			["bundle", "new", "b"],
		);
		// `String(err)` — what this used to be — yields "HubCommandError: …".
		expect(errText(err)).toBe("Skill registry validation failed: qa-2 clashes");
		expect(errText(err)).not.toContain("HubCommandError");
	});

	it("still degrades a plain Error and a non-Error throw", () => {
		expect(errText(new Error("plain"))).toBe("plain");
		expect(errText("a string")).toBe("a string");
	});
});

describe("bundleWriteLanded", () => {
	it("accepts a created / changed payload that carries the bundle", () => {
		expect(bundleWriteLanded({ bundle: { name: "b" }, created: true })).toBe(true);
		expect(bundleWriteLanded({ bundle: { name: "b" }, changed: true })).toBe(true);
		// `changed: false` still means the registry pass completed.
		expect(bundleWriteLanded({ bundle: { name: "b" }, changed: false })).toBe(
			true,
		);
	});

	it("rejects a refusal payload even when it carries an outcome flag", () => {
		// A refusal is `bundle: null` — an outcome flag alone must never be read
		// as "the write landed, this is only a sync warning".
		expect(bundleWriteLanded({ bundle: null, changed: false })).toBe(false);
		expect(bundleWriteLanded({ changed: false })).toBe(false);
		expect(bundleWriteLanded({})).toBe(false);
	});
});

describe("bundle warnings", () => {
	it("joins the lines verbatim, dropping empties", () => {
		expect(
			bundleWarningText({
				warnings: ["dropped 1 skill", "  ", "scope: global follows a source"],
			}),
		).toBe("dropped 1 skill · scope: global follows a source");
		expect(bundleWarningText({ warnings: [] })).toBe("");
		expect(bundleWarningText({})).toBe("");
		expect(bundleWarningText(null)).toBe("");
	});

	it("pushes one lingering info toast, and stays silent with nothing to say", () => {
		const toast = { push: vi.fn() };
		showBundleWarnings(toast, { warnings: [] });
		showBundleWarnings(toast, null);
		expect(toast.push).not.toHaveBeenCalled();

		showBundleWarnings(toast, { warnings: ["only one"] });
		expect(toast.push).toHaveBeenCalledWith({
			kind: "info",
			title: "Bundle warning",
			// Errors' dwell time: a warning outlives a status blip.
			body: "only one",
			duration: 6000,
		});

		showBundleWarnings(toast, { warnings: ["a", "b"] });
		expect(toast.push).toHaveBeenLastCalledWith(
			expect.objectContaining({ title: "Bundle warnings", body: "a · b" }),
		);
	});
});

describe("bundleDeleteLanded", () => {
	it("lands only when the CLI names what it removed", () => {
		expect(bundleDeleteLanded({ deleted: "b" })).toBe(true);
		expect(bundleDeleteLanded({ deleted: null })).toBe(false);
		// A dry-run reports nothing deleted — never treat it as a landed write.
		expect(
			bundleDeleteLanded({ deleted: null, dry_run: true, would_unassign: ["p"] }),
		).toBe(false);
	});
});

describe("runRegistryWrite", () => {
	// `stdout`/`stderr` are optional: the bridge sends them, older doubles don't.
	function mockOnce(reply: {
		success: boolean;
		output: string;
		stdout?: string;
		stderr?: string;
	}) {
		vi.mocked(invoke).mockImplementation((async () => reply) as never);
	}

	it("returns the payload with no warning on a clean run", async () => {
		mockOnce({ success: true, output: withChatter({ bundle: {}, created: true }) });
		const { payload, warning } = await runRegistryWrite<{ created?: boolean }>(
			["bundle", "new", "b", "--json"],
			() => true,
		);
		expect(payload?.created).toBe(true);
		expect(warning).toBeNull();
	});

	it("reports a landed write with a non-zero exit as a warning", async () => {
		mockOnce({
			success: false,
			output: withChatter({
				bundle: { name: "b" },
				created: true,
				errors: ["doctor: 1 danger finding"],
			}),
		});
		const { payload, warning } = await runRegistryWrite(
			["bundle", "new", "b", "--json"],
			bundleWriteLanded,
		);
		expect(payload).not.toBeNull();
		expect(warning).toBe("doctor: 1 danger finding");
	});

	it("throws the concise message — never the raw log — on a real failure", async () => {
		mockOnce({
			success: false,
			output: withChatter({ bundle: null, errors: ["unknown bundle: b"] }),
		});
		await expect(
			runRegistryWrite(["bundle", "update", "b", "--json"], bundleWriteLanded),
		).rejects.toThrow("unknown bundle: b");
	});

	it("carries the bridge's stdout/stderr split into the fallback message", async () => {
		// No JSON payload at all — the command died before printing one. The
		// message must come from stderr, not from the stdout sync chatter, and
		// must be ANSI-free.
		const E = String.fromCharCode(27);
		const stdout = "Syncing registry → agent folders\n✓ example-app: 6 skills\n";
		const stderr = `${E}[31mregistry lock is held by pid 4242${E}[0m\n`;
		mockOnce({ success: false, output: stdout + stderr, stdout, stderr });

		await expect(
			runRegistryWrite(["bundle", "new", "b", "--json"], bundleWriteLanded),
		).rejects.toThrow("registry lock is held by pid 4242");
	});

	it("still works against a bridge that only sends `output`", async () => {
		// Older payloads (and every pre-existing test double) carry no split.
		mockOnce({ success: false, output: "no such bundle: ghost" });
		await expect(
			runRegistryWrite(["bundle", "update", "b", "--json"], bundleWriteLanded),
		).rejects.toThrow("no such bundle: ghost");
	});

	it("throws even when a failure payload carries an outcome flag", async () => {
		mockOnce({
			success: false,
			output: withChatter({
				bundle: null,
				changed: false,
				errors: ["bundle 'b' follows source 'org-skills'"],
			}),
		});
		await expect(
			runRegistryWrite(["bundle", "update", "b", "--json"], bundleWriteLanded),
		).rejects.toThrow("bundle 'b' follows source 'org-skills'");
	});
});
