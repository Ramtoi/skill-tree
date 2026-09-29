import { it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { FeedbackDialog } from "@/components/FeedbackDialog";
import { useAppStore } from "@/store";
import { feedbackTransport } from "@/lib/feedbackTransport";
import type { FeedbackContext } from "@/lib/feedbackContext";

// No test renders `FeedbackDialog` today. These are new component-level
// checks (no journey exercised these validation paths) that give the
// validation and service-failure surfaces a vitest regression home, per
// unit A4 item 3.

vi.mock("@/lib/feedbackTransport", () => ({ feedbackTransport: vi.fn() }));

const CONTEXT: FeedbackContext = { screen: "library", tab: "none", appVersion: "1.0.0", os: "linux" };

function openDialog(overrides: Partial<ReturnType<typeof useAppStore.getState>> = {}) {
	useAppStore.setState({
		feedbackOpen: true,
		feedbackMessage: "",
		feedbackContext: CONTEXT,
		feedbackPhase: "draft",
		feedbackResult: null,
		feedbackRetryAt: 0,
		...overrides,
	});
}

beforeEach(() => {
	vi.mocked(feedbackTransport).mockReset();
});

it("shows the Field error for a whitespace-only message (messageError's empty case)", async () => {
	openDialog();
	renderWithProviders(<FeedbackDialog context={CONTEXT} />);

	const textarea = screen.getByLabelText("Message");
	fireEvent.change(textarea, { target: { value: "   " } });

	const alert = await screen.findByText("Enter a message before you send.");
	expect(alert).toBeVisible();
	expect(alert.closest(".field-error")).toHaveAttribute("role", "alert");

	// The Send control stays disabled while the message can't be sent.
	expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

it("shows the Field error for a message past the 4,000 character limit (messageError's too-short-of-a-limit case)", async () => {
	openDialog();
	renderWithProviders(<FeedbackDialog context={CONTEXT} />);

	const textarea = screen.getByLabelText("Message");
	fireEvent.change(textarea, { target: { value: "a".repeat(4001) } });

	const alert = await screen.findByText("Keep your message to 4,000 characters or fewer.");
	expect(alert).toBeVisible();
	expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

it("shows the role=alert service validation error when the transport reports a validation failure", async () => {
	openDialog({ feedbackMessage: "Something broke and I want to report it." });
	vi.mocked(feedbackTransport).mockResolvedValue({ kind: "validation" });
	renderWithProviders(<FeedbackDialog context={CONTEXT} />);

	// The message passes local validation, so the Field carries no error and
	// Send is enabled — only the SERVICE round trip rejects it.
	expect(screen.queryByText("Enter a message before you send.")).not.toBeInTheDocument();
	const sendButton = screen.getByRole("button", { name: "Send" });
	expect(sendButton).not.toBeDisabled();

	fireEvent.click(sendButton);

	await waitFor(() => expect(feedbackTransport).toHaveBeenCalledTimes(1));
	const alert = await screen.findByText(
		"The service could not accept this message. Check your message before you try again.",
	);
	expect(alert).toBeVisible();
	expect(alert).toHaveAttribute("role", "alert");
	expect(alert).toHaveClass("feedback-error");
	// The draft is kept, not cleared, on a failed send.
	expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(
		"Something broke and I want to report it.",
	);
});
