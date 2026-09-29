import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import {
	renderWithProviders,
	primeRegistry,
	makeQueryClient,
	makeDeferred,
	type Deferred,
} from "./helpers";
import { SkillEditor } from "@/screens/SkillEditor";

interface SkillDoc {
	name: string;
	description: string;
	body: string;
}

const BODY_A = "AAA-body-of-brainstorm";
const BODY_B = "BBB-body-of-android";

function Harness() {
	const navigate = useNavigate();
	return (
		<>
			<button
				type="button"
				data-testid="go-b"
				onClick={() => navigate("/skill/rt-android-expert")}
			>
				go B
			</button>
			<Routes>
				<Route path="/skill/:name" element={<SkillEditor />} />
			</Routes>
		</>
	);
}

describe("SkillEditor — stale read-response race (B3-01)", () => {
	beforeEach(() => {
		// Reset per-name gates each test.
	});

	it("ignores a slow read for a skill the route has moved on from", async () => {
		// One deferred per skill name so we control resolution ordering.
		const gates: Record<string, Deferred<SkillDoc>> = {
			brainstorm: makeDeferred<SkillDoc>(),
			"rt-android-expert": makeDeferred<SkillDoc>(),
		};

		vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
			if (cmd === "read_skill_document") {
				const { name } = (args as { name: string }) ?? { name: "" };
				return gates[name].promise;
			}
			if (cmd === "hub_cmd") return Promise.resolve({ success: true, output: "" });
			if (cmd === "check_python") return Promise.resolve(true);
			return Promise.resolve(undefined);
		}) as never);

		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<Harness />, {
			client,
			initialRoute: "/skill/brainstorm",
		});

		// Navigate to skill B before A's read has resolved.
		fireEvent.click(screen.getByTestId("go-b"));

		// B resolves first, then A resolves LAST (the stale response).
		gates["rt-android-expert"].resolve({
			name: "rt-android-expert",
			description: "Android compose planner",
			body: BODY_B,
		});
		gates["brainstorm"].resolve({
			name: "brainstorm",
			description: "Brainstorm a feature with multiple experts.",
			body: BODY_A,
		});

		// The editor body must reflect B (the current route), never A's stale read.
		await waitFor(() => {
			const cm = document.querySelector(".cm-content") as HTMLElement | null;
			expect(cm?.textContent ?? "").toContain(BODY_B);
		});

		const cm = document.querySelector(".cm-content") as HTMLElement;
		expect(cm.textContent ?? "").not.toContain(BODY_A);
	});
});
