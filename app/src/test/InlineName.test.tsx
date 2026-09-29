import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InlineName } from "@/components/InlineName";

const slug = (next: string) =>
	/^[a-z0-9-]+$/.test(next) ? null : "Use lowercase letters, numbers and hyphens";

describe("InlineName", () => {
	it("rests as the plain name and opens a field on click", async () => {
		render(<InlineName value="agent-scope" label="Project name" onSave={vi.fn()} />);

		const rest = screen.getByRole("button", { name: "Rename project name: agent-scope" });
		expect(rest).toHaveTextContent("agent-scope");
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

		await userEvent.click(rest);

		const field = screen.getByRole("textbox", { name: "Project name" });
		expect(field).toHaveValue("agent-scope");
		expect(field).toHaveFocus();
		// Untouched: nothing to save, so no Save button competes for the eye.
		expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
	});

	it("shows Save only once the draft differs and Enter commits it", async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		render(<InlineName value="alpha" label="Project name" onSave={onSave} validate={slug} />);
		await userEvent.click(screen.getByRole("button", { name: /rename/i }));

		const field = screen.getByRole("textbox");
		await userEvent.clear(field);
		await userEvent.type(field, "alpha-two");
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

		await userEvent.keyboard("{Enter}");
		expect(onSave).toHaveBeenCalledWith("alpha-two");
		await waitFor(() =>
			expect(screen.queryByRole("textbox")).not.toBeInTheDocument(),
		);
	});

	it("saves from the Save button without the blur cancelling first", async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		render(<InlineName value="alpha" label="Project name" onSave={onSave} validate={slug} />);
		await userEvent.click(screen.getByRole("button", { name: /rename/i }));
		await userEvent.type(screen.getByRole("textbox"), "-two");

		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(onSave).toHaveBeenCalledWith("alpha-two");
	});

	it("holds Save back and marks the field while the draft is invalid", async () => {
		const onSave = vi.fn();
		render(<InlineName value="alpha" label="Project name" onSave={onSave} validate={slug} />);
		await userEvent.click(screen.getByRole("button", { name: /rename/i }));

		const field = screen.getByRole("textbox");
		await userEvent.type(field, " Beta");
		expect(field).toHaveAttribute("aria-invalid", "true");
		const save = screen.getByRole("button", { name: "Save" });
		expect(save).toHaveAttribute("aria-disabled", "true");
		expect(save).toHaveAttribute("title", "Use lowercase letters, numbers and hyphens");

		await userEvent.click(save);
		await userEvent.keyboard("{Enter}");
		expect(onSave).not.toHaveBeenCalled();
	});

	it("restores the name on Escape and on leaving the field", async () => {
		const onSave = vi.fn();
		render(<InlineName value="alpha" label="Project name" onSave={onSave} />);

		await userEvent.click(screen.getByRole("button", { name: /rename/i }));
		await userEvent.type(screen.getByRole("textbox"), "-x");
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /rename/i })).toHaveTextContent("alpha");

		await userEvent.click(screen.getByRole("button", { name: /rename/i }));
		await userEvent.type(screen.getByRole("textbox"), "-y");
		fireEvent.blur(screen.getByRole("textbox"));
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		expect(onSave).not.toHaveBeenCalled();
	});

	it("keeps the draft open when the save is rejected", async () => {
		const onSave = vi.fn().mockRejectedValue(new Error("nope"));
		render(<InlineName value="alpha" label="Project name" onSave={onSave} validate={slug} />);
		await userEvent.click(screen.getByRole("button", { name: /rename/i }));
		await userEvent.type(screen.getByRole("textbox"), "-two");
		await userEvent.keyboard("{Enter}");

		await waitFor(() => expect(onSave).toHaveBeenCalled());
		expect(screen.getByRole("textbox")).toHaveValue("alpha-two");
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
	});

	it("commitOnBlur: leaving the field commits a valid draft instead of restoring", async () => {
		const onSave = vi.fn();
		render(
			<>
				<InlineName value="0.3.0" label="Version" onSave={onSave} commitOnBlur placeholder="none" />
				<button type="button">Save document</button>
			</>,
		);
		await userEvent.click(screen.getByRole("button", { name: /rename version/i }));
		const field = screen.getByRole("textbox", { name: "Version" });
		await userEvent.clear(field);
		await userEvent.type(field, "0.4.0");
		// A click elsewhere (the screen's own Save button) blurs the field first.
		await userEvent.click(screen.getByRole("button", { name: "Save document" }));
		expect(onSave).toHaveBeenCalledWith("0.4.0");
		await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
	});

	it("commitOnBlur: an unchanged or invalid draft still restores on blur", async () => {
		const onSave = vi.fn();
		render(
			<>
				<InlineName value="alpha" label="Project name" onSave={onSave} validate={slug} commitOnBlur />
				<button type="button">Elsewhere</button>
			</>,
		);
		await userEvent.click(screen.getByRole("button", { name: /rename/i }));
		const field = screen.getByRole("textbox");
		await userEvent.clear(field);
		await userEvent.type(field, "Not A Slug");
		await userEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /rename/i })).toHaveTextContent("alpha");
	});

	it("renders the placeholder dim when the value is empty", () => {
		render(<InlineName value="" label="Upstream" onSave={vi.fn()} placeholder="none" />);
		const rest = screen.getByRole("button", { name: /rename upstream/i });
		expect(rest).toHaveTextContent("none");
		expect(rest.querySelector(".inline-name-text")).toHaveAttribute("data-empty", "true");
	});
});
