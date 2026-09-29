import { describe, it, expect } from "vitest";
import { invoke } from "@/mocks/tauriCore";

// The mocked-Tauri backend (`src/mocks/tauriCore.ts`) is what every visual scene
// and every Playwright journey renders against. When it can produce a state the
// REAL CLI cannot, the app gets reviewed — and screenshotted — in a state no user
// will ever hit, and a genuine warning surface gets read as noise.
//
// `hub hook edit --script-source managed` SEEDS the script file
// (`hook_scripts.ensure_managed_script`), so a managed hook never exists without
// a body. The mock left `script_body` null on that switch, which `hook script
// show` reports as "the file is missing on disk" — a real state, but not one the
// managed switch can reach.

interface ScriptShow {
	path?: string;
	interpreter?: string;
	body?: string | null;
}

describe("mocked backend — a managed switch seeds a script body (F10)", () => {
	it("hook_edit → managed leaves a runnable 2-line stub, not a missing file", async () => {
		await invoke("hook_edit", {
			name: "notify-on-stop",
			scriptSource: "managed",
			scriptInterpreter: "bash",
		});
		const shown = await invoke<ScriptShow>("hook_script_show", {
			name: "notify-on-stop",
		});
		expect(shown.body).not.toBeNull();
		// Mirrors hook_scripts._STUBS["bash"] verbatim.
		expect(shown.body).toBe(
			"#!/usr/bin/env bash\n# notify-on-stop — managed hook script.\n",
		);
		expect(shown.path).toContain("/hooks/notify-on-stop/script.sh");
	});

	it("follows the interpreter the switch asked for", async () => {
		await invoke("hook_edit", {
			name: "lint-py",
			scriptSource: "managed",
			scriptInterpreter: "python3",
		});
		// `lint-py` is not in the seed store, so this is also the "edit an unknown
		// hook" no-op path: it must not invent one.
		expect(() => invoke("hook_script_show", { name: "lint-py" })).toThrow(
			/no managed script/,
		);

		await invoke("hook_new", {
			name: "lint-py",
			event: "PostToolUse",
			scriptSource: "managed",
			scriptInterpreter: "python3",
		});
		const shown = await invoke<ScriptShow>("hook_script_show", { name: "lint-py" });
		expect(shown.body).toBe(
			'#!/usr/bin/env python3\n"""lint-py — managed hook script."""\n',
		);
	});

	it("an EXPLICIT opt-in is the only way to reach the missing-body state", async () => {
		// The warning surface still needs a fixture; it just may not fall out of a
		// mock gap. `?hookScriptMissing=1` is that opt-in.
		window.history.replaceState({}, "", "/?hookScriptMissing=1");
		try {
			const shown = await invoke<ScriptShow>("hook_script_show", {
				name: "format-on-write",
			});
			expect(shown.body).toBeNull();
		} finally {
			window.history.replaceState({}, "", "/");
		}
	});

	it("the seed library is clean by default — doctor findings need `?hookDoctorFindings=1`", async () => {
		// A healthy-by-default mock library means the row badge / editor banner
		// only ever appear when a scene explicitly opts in, never as a mock gap.
		const clean = await invoke<{ findings: unknown[]; danger_count: number }>(
			"hook_doctor",
		);
		expect(clean.findings).toEqual([]);
		expect(clean.danger_count).toBe(0);

		window.history.replaceState({}, "", "/?hookDoctorFindings=1");
		try {
			const dirty = await invoke<{
				findings: { hook: string; severity: string }[];
				danger_count: number;
			}>("hook_doctor");
			expect(dirty.danger_count).toBe(1);
			const hooks = dirty.findings.map((f) => f.hook).sort();
			expect(hooks).toEqual(["format-on-write", "lsp-report", "notify-on-stop"]);
			const severities = new Set(dirty.findings.map((f) => f.severity));
			expect(severities).toEqual(new Set(["danger", "warning", "info"]));
		} finally {
			window.history.replaceState({}, "", "/");
		}
	});
});

// Pins the shapes documented on `HookShow`/`HookRow`/`HookDoctorFinding` in
// useHooks.ts — a mock that silently dropped/renamed a key would still "pass"
// any test that doesn't read that key back out.
interface BuiltinFile {
	name: string;
	path: string;
	body: string | null;
}
interface CommandScriptLocation {
	project: string | null;
	path: string;
	exists: boolean;
	body: string | null;
	reason: string | null;
}
interface HookShowShape {
	baked_command?: string | null;
	builtin?: { dir: string; files: BuiltinFile[] } | null;
	command_script?: {
		token: string;
		kind: "absolute" | "home" | "relative";
		locations: CommandScriptLocation[];
	} | null;
	repo_script_conversion?: { interpreter: string; path: string; args: string } | null;
}
interface DoctorFinding {
	hook: string;
	scope: string;
	harness: string;
	code: string;
	severity: string;
	explanation: string;
	detail: string;
}

describe("mocked backend — hook_show / hook_doctor pin the documented shapes", () => {
	it("hook_show carries baked_command + builtin.{dir, files[].{name, path, body}}", async () => {
		const shown = await invoke<HookShowShape>("hook_show", { name: "lsp-report" });
		expect(typeof shown.baked_command).toBe("string");
		expect(shown.baked_command).toContain("lsp_report.py");

		expect(shown.builtin).not.toBeNull();
		expect(typeof shown.builtin!.dir).toBe("string");
		expect(shown.builtin!.files.length).toBeGreaterThan(0);
		for (const f of shown.builtin!.files) {
			expect(typeof f.name).toBe("string");
			expect(typeof f.path).toBe("string");
			expect(f.body === null || typeof f.body === "string").toBe(true);
		}

		// A user hook carries no built-in source.
		const userShown = await invoke<HookShowShape>("hook_show", {
			name: "notify-on-stop",
		});
		expect(userShown.builtin).toBeNull();
	});

	it("a python3 managed/repo script bakes the absolute bundled interpreter, not 'bash'", async () => {
		await invoke("hook_new", {
			name: "lint-py-fidelity",
			event: "PostToolUse",
			scriptSource: "managed",
			scriptInterpreter: "python3",
		});
		const shown = await invoke<HookShowShape>("hook_show", {
			name: "lint-py-fidelity",
		});
		expect(shown.baked_command).toContain(
			"/Applications/Skill Tree.app/Contents/Resources/python/bin/python3",
		);
		expect(shown.baked_command).not.toMatch(/^bash /);
	});

	it("a bash managed script still bakes plain 'bash'", async () => {
		const shown = await invoke<HookShowShape>("hook_show", {
			name: "format-on-write",
		});
		expect(shown.baked_command).toMatch(/^bash /);
	});

	it("a hook_doctor finding carries hook/scope/harness/code/severity/explanation/detail", async () => {
		window.history.replaceState({}, "", "/?hookDoctorFindings=1");
		try {
			const dirty = await invoke<{ findings: DoctorFinding[] }>("hook_doctor");
			expect(dirty.findings.length).toBeGreaterThan(0);
			for (const f of dirty.findings) {
				expect(typeof f.hook).toBe("string");
				expect(typeof f.scope).toBe("string");
				expect(typeof f.harness).toBe("string");
				expect(typeof f.code).toBe("string");
				expect(["danger", "warning", "info"]).toContain(f.severity);
				expect(typeof f.explanation).toBe("string");
				expect(typeof f.detail).toBe("string");
			}
		} finally {
			window.history.replaceState({}, "", "/");
		}
	});

	it("hook_show carries command_script + repo_script_conversion for the lint-on-edit seed hook", async () => {
		const shown = await invoke<HookShowShape>("hook_show", { name: "lint-on-edit" });

		expect(shown.command_script).not.toBeNull();
		expect(shown.command_script!.token).toBe("scripts/lint.sh");
		expect(shown.command_script!.kind).toBe("relative");
		const locs = shown.command_script!.locations;
		expect(locs.map((l) => l.project)).toEqual(["example-app", "moon-base"]);
		const example = locs.find((l) => l.project === "example-app")!;
		expect(example.exists).toBe(true);
		expect(example.body).toContain("eslint --fix");
		const moon = locs.find((l) => l.project === "moon-base")!;
		expect(moon.exists).toBe(false);
		expect(moon.body).toBeNull();
		expect(moon.reason).toBeNull();

		expect(shown.repo_script_conversion).toEqual({
			interpreter: "bash",
			path: "scripts/lint.sh",
			args: "--fix",
		});
	});

	it("every other seed hook carries null command_script + repo_script_conversion", async () => {
		for (const name of ["lsp-report", "notify-on-stop", "format-on-write"]) {
			const shown = await invoke<HookShowShape>("hook_show", { name });
			expect(shown.command_script ?? null).toBeNull();
			expect(shown.repo_script_conversion ?? null).toBeNull();
		}
	});
});
