import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SubagentModelPicker } from "@/components/subagents/SubagentModelPicker";

function Picker({ initial = "", harness = "codex" }: { initial?: string; harness?: "codex" | "claude-code" }) {
	const [value, setValue] = useState(initial);
	return <SubagentModelPicker harness={harness} value={value} onChange={setValue} />;
}

describe("Subagent model picker", () => {
	it("selects a known model and preserves it through free-form mode", async () => {
		const user = userEvent.setup();
		render(<Picker />);
		await user.click(screen.getByRole("combobox", { name: "Model" }));
		await user.click(screen.getByRole("option", { name: "gpt-5.6-luna" }));
		await user.click(screen.getByRole("button", { name: "Enter custom model" }));
		const input = screen.getByRole("textbox", { name: "Model" });
		expect(input).toHaveValue("gpt-5.6-luna");
		expect(input).toHaveFocus();
		await user.clear(input);
		await user.type(input, "provider/future-model");
		await user.click(screen.getByRole("button", { name: "Choose known model" }));
		expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent("provider/future-model");
		await user.click(screen.getByRole("combobox", { name: "Model" }));
		await user.click(screen.getByRole("option", { name: "inherit" }));
		expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent("inherit");
	});
	it("keeps free-form editing active when clearing an unknown saved model", async () => {
		const user = userEvent.setup();
		render(<Picker initial="my-private-model" />);
		const input = screen.getByRole("textbox", { name: "Model" });
		expect(input).toHaveValue("my-private-model");
		await user.clear(input);
		expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("");
		await user.type(input, "next-model");
		expect(input).toHaveValue("next-model");
	});
	it("offers Claude aliases separately and supports keyboard selection", async () => {
		const user = userEvent.setup();
		render(<Picker harness="claude-code" initial="sonnet" />);
		screen.getByRole("combobox", { name: "Model" }).focus();
		await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
		expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent("opus");
		await user.click(screen.getByRole("combobox", { name: "Model" }));
		expect(screen.queryByRole("option", { name: /gpt-/ })).not.toBeInTheDocument();
	});
});
