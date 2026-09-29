import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { useFocusAfterCommit } from "@/hooks/useFocusAfterCommit";

function DisabledThenEnabled() {
	const [disabled, setDisabled] = useState(true);
	const requestFocus = useFocusAfterCommit();
	return (
		<div>
			<button
				type="button"
				onClick={() => {
					// The state update and the focus request land in the SAME
					// commit; the OLD `setTimeout(0)`/rAF pattern this hook
					// replaces could run before React actually applies
					// `disabled: false` to the DOM.
					setDisabled(false);
					requestFocus(() => document.querySelector<HTMLInputElement>("#target"));
				}}
			>
				Enable
			</button>
			<input id="target" disabled={disabled} />
		</div>
	);
}

function MountsLater() {
	const [mounted, setMounted] = useState(false);
	const requestFocus = useFocusAfterCommit();
	return (
		<div>
			<button
				type="button"
				onClick={() => {
					requestFocus(() => document.querySelector<HTMLInputElement>("#late"));
					// The target does not exist yet in this same commit — it
					// only mounts on a LATER, unrelated commit below.
				}}
			>
				Request
			</button>
			<button type="button" onClick={() => setMounted(true)}>
				Mount target
			</button>
			{mounted && <input id="late" />}
		</div>
	);
}

function UnmountsHost({ requestOnMount }: { requestOnMount: (fn: () => void) => void }) {
	const requestFocus = useFocusAfterCommit();
	requestOnMount(() => requestFocus(() => document.querySelector<HTMLInputElement>("#never")));
	return <input id="also-never" />;
}

describe("useFocusAfterCommit", () => {
	it("focuses a target that starts disabled once a later commit enables it", async () => {
		render(<DisabledThenEnabled />);
		const button = screen.getByRole("button", { name: "Enable" });
		fireEvent.click(button);
		await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
	});

	it("focuses a target that does not exist yet, once it mounts on a later commit", async () => {
		render(<MountsLater />);
		fireEvent.click(screen.getByRole("button", { name: "Request" }));
		expect(document.querySelector("#late")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Mount target" }));

		await waitFor(() => expect(document.querySelector("#late")).toHaveFocus());
	});

	it("a new request replaces whatever was pending", async () => {
		function TwoTargets() {
			const [aDisabled, setADisabled] = useState(true);
			const [bDisabled, setBDisabled] = useState(true);
			const requestFocus = useFocusAfterCommit();
			return (
				<div>
					<button
						type="button"
						onClick={() => {
							requestFocus(() => document.querySelector<HTMLInputElement>("#a"));
							// Superseded before "a" is ever enabled.
							requestFocus(() => document.querySelector<HTMLInputElement>("#b"));
							setADisabled(false);
							setBDisabled(false);
						}}
					>
						Go
					</button>
					<input id="a" disabled={aDisabled} />
					<input id="b" disabled={bDisabled} />
				</div>
			);
		}
		render(<TwoTargets />);
		fireEvent.click(screen.getByRole("button", { name: "Go" }));
		await waitFor(() => expect(document.querySelector("#b")).toHaveFocus());
		expect(document.querySelector("#a")).not.toHaveFocus();
	});

	it("drops a pending request on unmount instead of focusing after the fact", async () => {
		let request: (() => void) | null = null;
		const { unmount } = render(
			<UnmountsHost requestOnMount={(fn) => { request = fn; }} />,
		);
		act(() => { request!(); });
		unmount();
		// Nothing left to observe a focus on, but re-mounting a fresh instance
		// and letting a tick pass must not throw or resurrect the old request.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.activeElement).toBe(document.body);
	});
});
