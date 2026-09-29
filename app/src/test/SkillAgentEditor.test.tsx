import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { Link, Route, Routes } from "react-router-dom";
import { SkillAgentEditor } from "@/screens/SkillAgentEditor";
import { makeDeferred, makeQueryClient, renderWithProviders } from "./helpers";
import { qk } from "@/lib/queryKeys";

const source = {
	ok: true,
	skill: "orchestrate-advanced",
	name: "orch-implementer",
	description: "Implement one unit.",
	body: "Shared prompt.",
	tier: "worker",
	hash: "hash-1",
	editable: true,
	harnesses: {
		"claude-code": { model: "sonnet" },
		codex: { model: "gpt-5.6-luna", model_reasoning_effort: "" },
	},
};

function mockHub(saveResponse?: unknown) {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd !== "hub_cmd") return undefined;
		const argv = (args as { args?: string[] })?.args ?? [];
		if (argv[2] === "agent") {
			const agent = argv[argv.indexOf("--agent") + 1];
			return { success: true, output: JSON.stringify(agent === "other" ? { ...source, name: "other", description: "Other source", body: "Other body", hash: "other-hash" } : source) };
		}
		if (argv[2] === "save-agent") return { success: true, output: JSON.stringify(saveResponse ?? { ...source, hash: "hash-2", reconcile: {} }) };
		return { success: true, output: "{}" };
	}) as never);
}

function renderEditor(client = makeQueryClient()) {
	return renderWithProviders(
		<Routes>
			<Route path="/skill/:name/agent/:agent" element={<><SkillAgentEditor /><Link to="/skill/orchestrate-advanced/agent/other">Switch agent</Link></>} />
			<Route path="/skill/:name" element={<div>Skill home</div>} />
		</Routes>,
		{ initialRoute: "/skill/orchestrate-advanced/agent/orch-implementer", client },
	);
}

beforeEach(() => mockHub());

describe("SkillAgentEditor", () => {
	it("loads shared prompt and the two labeled harness configurations", async () => {
		renderEditor();
		expect(await screen.findByRole("combobox", { name: "Claude Code model" })).toHaveTextContent("sonnet");
		expect(screen.getByRole("combobox", { name: "Codex model" })).toHaveTextContent("gpt-5.6-luna");
		expect(screen.getByRole("combobox", { name: "Codex reasoning effort" })).toBeInTheDocument();
	});

	it("keeps the draft when a source save is rejected", async () => {
		const user = userEvent.setup();
		mockHub({ ok: false, error: "source agent changed on disk", conflict: true });
		renderEditor();
		const description = await screen.findByRole("textbox", { name: "Description" });
		await user.clear(description);
		await user.type(description, "Draft description");
		await user.click(screen.getByRole("button", { name: /Save/ }));
		await waitFor(() => expect(description).toHaveValue("Draft description"));
	});

	it("uses the loaded hash when a refetch arrives after a draft edit", async () => {
		const user = userEvent.setup();
		const client = makeQueryClient();
		renderEditor(client);
		const description = await screen.findByRole("textbox", { name: "Description" });
		await user.clear(description);
		await user.type(description, "Draft description");
		client.setQueryData(qk.skillAgent(source.skill, source.name), { ...source, hash: "hash-external", body: "External update" });
		await user.click(screen.getByRole("button", { name: /Save/ }));
		await waitFor(() => expect(screen.getByRole("button", { name: /^Saved/ })).toBeInTheDocument());
		const saveCall = vi.mocked(invoke).mock.calls.find(([, args]) => {
			const argv = (args as { args?: string[] })?.args ?? [];
			return argv[2] === "save-agent";
		});
		expect(saveCall).toBeDefined();
		const argv = (saveCall?.[1] as { args: string[] }).args;
		const body = JSON.parse(argv[argv.indexOf("--json-body") + 1]) as { expected_hash: string };
		expect(body.expected_hash).toBe("hash-1");
	});

	it("guards the header Back action while the draft is dirty", async () => {
		const user = userEvent.setup();
		renderEditor();
		const description = await screen.findByRole("textbox", { name: "Description" });
		await user.type(description, " changed");
		await user.click(screen.getByRole("button", { name: /Back to/ }));
		expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();
		expect(screen.queryByText("Skill home")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Keep editing" }));
		expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("Implement one unit. changed");
		await user.click(screen.getByRole("button", { name: /Back to/ }));
		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		expect(await screen.findByText("Skill home")).toBeInTheDocument();
	});

	it("locks the body and configuration controls while saving", async () => {
		const user = userEvent.setup();
		const gate = makeDeferred();
		mockHub();
		const base = vi.mocked(invoke).getMockImplementation();
		vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
			const argv = (args as { args?: string[] })?.args ?? [];
			if (cmd === "hub_cmd" && argv[2] === "save-agent") return gate.promise;
			return base?.(cmd as never, args as never);
		}) as never);
		renderEditor();
		const description = await screen.findByRole("textbox", { name: "Description" });
		await user.type(description, " changed");
		await user.click(screen.getByRole("button", { name: /Save/ }));
		await waitFor(() => expect(screen.getByRole("button", { name: /Saving/ })).toBeInTheDocument());
		expect(description).toHaveAttribute("readonly");
		expect(screen.queryByRole("combobox", { name: "Claude Code model" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Bold/ })).not.toBeInTheDocument();
		const body = document.querySelector(".doc-editor-body .cm-content");
		expect(body).toHaveAttribute("contenteditable", "false");
		gate.resolve({ success: true, output: JSON.stringify({ ...source, hash: "hash-2", reconcile: {} }) });
		await waitFor(() => expect(screen.getByRole("button", { name: /^Saved/ })).toBeInTheDocument());
	});

	it("does not apply a late save response after leaving for another agent", async () => {
		const user = userEvent.setup();
		const gate = makeDeferred();
		const client = makeQueryClient();
		client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity, staleTime: 0 } });
		for (const harness of ["claude-code", "codex"] as const) {
			client.setQueryData(qk.subagents.one("user", null, source.name, harness), { name: source.name });
			client.setQueryData(qk.subagents.one("user", null, "other", harness), { name: "other" });
		}
		mockHub();
		const base = vi.mocked(invoke).getMockImplementation();
		vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
			const argv = (args as { args?: string[] })?.args ?? [];
			if (cmd === "hub_cmd" && argv[2] === "save-agent") return gate.promise;
			return base?.(cmd as never, args as never);
		}) as never);
		renderEditor(client);
		const description = await screen.findByRole("textbox", { name: "Description" });
		await user.type(description, " changed");
		await user.click(screen.getByRole("button", { name: /Save/ }));
		await waitFor(() => expect(screen.getByRole("button", { name: /Saving/ })).toBeInTheDocument());
		const saveCall = vi.mocked(invoke).mock.calls.find(([, args]) => {
			const argv = (args as { args?: string[] })?.args ?? [];
			return argv[2] === "save-agent";
		});
		expect(saveCall).toBeDefined();
		const saveArgs = (saveCall?.[1] as { args: string[] }).args;
		const saveBody = JSON.parse(saveArgs[saveArgs.indexOf("--json-body") + 1]) as { description: string };
		expect(saveBody.description).toBe("Implement one unit. changed");
		await user.click(screen.getByRole("link", { name: "Switch agent" }));
		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		const otherDescription = await screen.findByRole("textbox", { name: "Description" });
		await waitFor(() => expect(otherDescription).toHaveValue("Other source"));
		gate.resolve({ success: true, output: JSON.stringify({ ...source, hash: "hash-2", reconcile: {} }) });
		await waitFor(() => expect(client.getQueryData(qk.skillAgent(source.skill, source.name))).toMatchObject({ hash: "hash-2" }));
		expect(otherDescription).toHaveValue("Other source");
		for (const harness of ["claude-code", "codex"] as const) {
			expect(client.getQueryState(qk.subagents.one("user", null, source.name, harness))?.isInvalidated).toBe(true);
			expect(client.getQueryState(qk.subagents.one("user", null, "other", harness))?.isInvalidated).toBe(false);
		}
	});
});
