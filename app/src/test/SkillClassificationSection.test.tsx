import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StrictMode, useState } from "react";
import { SkillClassificationSection } from "@/components/skillEditor/SkillClassificationSection";
import type { ClassificationContribution } from "@/lib/skillClassification";
import { renderWithProviders, makeDeferred } from "./helpers";

const direct = (value: string): ClassificationContribution => ({ value, provenance: "direct", contributors: ["child"] });

describe("SkillClassificationSection", () => {
	it("shows saved-only summaries and all canonical choices, including former-term search", async () => {
		const user = userEvent.setup();
		const update = vi.fn().mockResolvedValue(undefined);
		renderWithProviders(<SkillClassificationSection storageKey="classification" classification={{ classes: ["implementation"], outputs: ["PR"] }} update={update} />);
		expect(screen.getByLabelText("Saved classes")).toHaveTextContent("Build");
		expect(screen.getByLabelText("Saved outputs")).toHaveTextContent("PR");
		await user.click(screen.getByRole("button", { name: "Edit classes" }));
		expect(screen.getByRole("checkbox", { name: "Research" })).toHaveAccessibleDescription("Questions, discovery, diagnosis, and evidence gathering.");
		expect(screen.getByRole("checkbox", { name: "Coordination" })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await user.click(screen.getByRole("button", { name: "Edit outputs" }));
		await user.type(screen.getByRole("textbox", { name: "Search outputs" }), "regression evidence");
		expect(screen.getByRole("checkbox", { name: "Evidence" })).toBeInTheDocument();
		expect(screen.queryByRole("checkbox", { name: "Prompt" })).toBeNull();
	});

	it("preserves raw values, commas, and case-insensitive identity until Apply", async () => {
		const user = userEvent.setup();
		const update = vi.fn().mockResolvedValue(undefined);
		renderWithProviders(<SkillClassificationSection storageKey="classification" classification={{ classes: ["process"] }} update={update} />);
		await user.click(screen.getByRole("button", { name: "Edit classes" }));
		expect(screen.getByRole("checkbox", { name: "process" })).toBeChecked();
		await user.click(screen.getByRole("checkbox", { name: "Build" }));
		await user.click(screen.getByRole("button", { name: "Add custom" }));
		await user.type(screen.getByRole("textbox", { name: "Add class" }), "release, notes");
		await user.click(screen.getByRole("button", { name: "Add" }));
		expect(screen.getByRole("checkbox", { name: "release, notes" })).toBeChecked();
		expect(screen.getByLabelText("Saved classes")).toHaveTextContent("process");
		await user.click(screen.getByRole("button", { name: "Apply" }));
		await waitFor(() => expect(update).toHaveBeenCalledWith("classes", ["process", "implementation", "release, notes"]));
		// The saved summary remains the server baseline until the parent refreshes it.
		expect(screen.getByLabelText("Saved classes")).toHaveTextContent("process");
	});

	it("cancels and escapes without saving, restores Edit focus, and locks one pending write across fields", async () => {
		const user = userEvent.setup();
		const gate = makeDeferred<void>();
		const update = vi.fn(() => gate.promise);
		renderWithProviders(<SkillClassificationSection storageKey="classification" classification={{ classes: ["research"], outputs: ["plan"], interaction_style: "autonomous" }} update={update} />);
		await user.click(screen.getByRole("button", { name: "Edit classes" }));
		await user.click(screen.getByRole("checkbox", { name: "Build" }));
		await user.keyboard("{Escape}");
		expect(screen.getByRole("button", { name: "Edit classes" })).toHaveFocus();
		expect(update).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Edit classes" }));
		await user.click(screen.getByRole("checkbox", { name: "Build" }));
		await user.click(screen.getByRole("button", { name: "Apply" }));
		await waitFor(() => expect(screen.getByText(/Saving classes/)).toBeInTheDocument());
		expect(screen.getByRole("button", { name: "Edit outputs" })).toBeDisabled();
		expect(screen.getByRole("radio", { name: "autonomous" })).toBeDisabled();
		await act(async () => { gate.resolve(); await gate.promise; });
		await waitFor(() => expect(screen.getByRole("button", { name: "Edit classes" })).toHaveFocus());
	});

	it("retains a failed draft for Retry and leaves reference values inspection-only", async () => {
		const user = userEvent.setup();
		const update = vi.fn().mockRejectedValueOnce(new Error("write failed")).mockResolvedValueOnce(undefined);
		const inspect = vi.fn();
		const view = renderWithProviders(<SkillClassificationSection storageKey="classification" classification={{ outputs: ["plan"] }} outputs={[direct("review")]} update={update} onInspect={inspect} />);
		await user.click(screen.getByRole("button", { name: "Edit outputs" }));
		await user.click(screen.getByRole("checkbox", { name: "Evidence" }));
		await user.click(screen.getByRole("button", { name: "Apply" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("write failed"));
		expect(screen.getByRole("checkbox", { name: "Evidence" })).toBeChecked();
		view.rerender(<SkillClassificationSection storageKey="classification" classification={{ outputs: ["plan"] }} outputs={[direct("review")]} update={update} onInspect={inspect} readOnly />);
		expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
		view.rerender(<SkillClassificationSection storageKey="classification" classification={{ outputs: ["plan"] }} outputs={[direct("review")]} update={update} onInspect={inspect} />);
		await user.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
		await user.click(screen.getByRole("button", { name: /review, Direct reference/ }));
		expect(inspect).toHaveBeenCalledWith("outputs", "review");
		expect(screen.getByRole("button", { name: /review, Direct reference/ })).toBeInTheDocument();
	});

	it("preserves behavior enums and returns focus to the first radio after clear", async () => {
		const user = userEvent.setup();
		const update = vi.fn().mockResolvedValue(undefined);
		renderWithProviders(<SkillClassificationSection storageKey="classification" classification={{ interaction_style: "autonomous" }} update={update} />);
		await user.click(screen.getByText("Behavior"));
		await user.click(screen.getByRole("button", { name: "Clear interaction style" }));
		await waitFor(() => expect(update).toHaveBeenCalledWith("interaction_style", undefined));
		await waitFor(() => expect(screen.getByRole("radio", { name: "conversational" })).toHaveFocus());
	});

	// Finding A regression guard: the OLD `setTimeout(0)` fired against a
	// `fieldRef` snapshot taken before React committed `setPending(null)` —
	// racy on its own, and made worse here by a parent rerender landing
	// mid-flight (the "Clear" button unmounts once `value` drops, replaced
	// by the "Unset" span) between the click and the resolved commit.
	// `useFocusAfterCommit` must keep retrying across that rerender and
	// land focus on the first radio once it is actually enabled.
	it("returns focus to the first radio after Clear even when a rerender drops the value mid-flight", async () => {
		const user = userEvent.setup();
		const gate = makeDeferred<void>();
		const update = vi.fn(() => gate.promise);
		const view = renderWithProviders(<SkillClassificationSection storageKey="classification" classification={{ interaction_style: "autonomous" }} update={update} />);
		await user.click(screen.getByText("Behavior"));
		await user.click(screen.getByRole("button", { name: "Clear interaction style" }));
		expect(screen.getByRole("radio", { name: "autonomous" })).toBeDisabled();

		// The parent's own state update arrives before the write settles.
		view.rerender(<SkillClassificationSection storageKey="classification" classification={{}} update={update} />);
		expect(screen.queryByRole("button", { name: "Clear interaction style" })).toBeNull();

		await act(async () => { gate.resolve(); await gate.promise; });
		await waitFor(() => expect(screen.getByRole("radio", { name: "conversational" })).toHaveFocus());
	});

	it("keeps a dirty field draft when saved data refreshes", async () => {
		const user = userEvent.setup();
		const update = vi.fn().mockResolvedValue(undefined);
		const view = renderWithProviders(<SkillClassificationSection storageKey="classification" classification={{ classes: ["research"] }} update={update} />);
		await user.click(screen.getByRole("button", { name: "Edit classes" }));
		await user.click(screen.getByRole("checkbox", { name: "Build" }));
		view.rerender(<SkillClassificationSection storageKey="classification" classification={{ classes: ["planning"] }} update={update} />);
		expect(screen.getByRole("checkbox", { name: "Build" })).toBeChecked();
		await user.click(screen.getByRole("button", { name: "Apply" }));
		await waitFor(() => expect(update).toHaveBeenCalledWith("classes", ["research", "implementation"]));
	});

	it("keeps one raw row for a selected library value so it can be rechecked", async () => {
		const user = userEvent.setup();
		const update = vi.fn().mockResolvedValue(undefined);
		renderWithProviders(<SkillClassificationSection storageKey="classification" classification={{ classes: ["custom"] }} classSuggestions={["custom"]} update={update} />);
		await user.click(screen.getByRole("button", { name: "Edit classes" }));
		await user.type(screen.getByRole("textbox", { name: "Search classes" }), "custom");
		expect(screen.getAllByRole("checkbox", { name: "custom" })).toHaveLength(1);
		await user.click(screen.getByRole("checkbox", { name: "custom" }));
		expect(screen.getByRole("checkbox", { name: "custom" })).not.toBeChecked();
		await user.click(screen.getByRole("checkbox", { name: "custom" }));
		expect(screen.getByRole("checkbox", { name: "custom" })).toBeChecked();
	});

	it("keeps source metadata editable while page read-only locks classification", async () => {
		const user = userEvent.setup();
		const update = vi.fn().mockResolvedValue(undefined);
		const view = renderWithProviders(<SkillClassificationSection storageKey="classification" update={update} />);
		expect(screen.getByRole("button", { name: "Edit classes" })).toBeEnabled();
		view.rerender(<SkillClassificationSection storageKey="classification" update={update} readOnly />);
		expect(screen.getByRole("button", { name: "Edit classes" })).toBeDisabled();
		await user.click(screen.getByRole("button", { name: "Edit outputs" }));
		expect(update).not.toHaveBeenCalled();
	});

	it("keeps late completion from updating a keyed replacement and works in StrictMode", async () => {
		const user = userEvent.setup();
		const gate = makeDeferred<void>();
		const update = vi.fn(() => gate.promise);
		function Routed() {
			const [name, setName] = useState("first");
			return <><button type="button" onClick={() => setName("second")}>Switch skill</button><SkillClassificationSection key={name} storageKey="classification" classification={{ classes: ["research"] }} update={update} /></>;
		}
		const view = renderWithProviders(<StrictMode><Routed /></StrictMode>);
		await user.click(screen.getByRole("button", { name: "Edit classes" }));
		await user.click(screen.getByRole("checkbox", { name: "Build" }));
		await user.click(screen.getByRole("button", { name: "Apply" }));
		await user.click(screen.getByRole("button", { name: "Switch skill" }));
		await act(async () => { gate.resolve(); await gate.promise; });
		expect(screen.queryByText("Saved classes")).toBeNull();
		view.unmount();
	});

	it("keeps contribution inspection and graph retry available", async () => {
		const user = userEvent.setup();
		const inspect = vi.fn();
		const close = vi.fn();
		const retry = vi.fn();
		renderWithProviders(<SkillClassificationSection storageKey="classification" outputs={[direct("review")]} onInspect={inspect} inspection={{ field: "outputs", value: "review", contributors: ["child"], paths: [["root", "child"]], hasMore: false }} onCloseInspection={close} graphError={new Error("stale")} onRetryGraph={retry} />);
		expect(screen.getByLabelText("Contributors for review")).toHaveTextContent("root → child");
		await user.click(screen.getByRole("button", { name: "Close contribution" }));
		expect(close).toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(retry).toHaveBeenCalled();
		expect(inspect).not.toHaveBeenCalled();
	});
});
