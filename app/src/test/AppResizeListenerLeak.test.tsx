import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "@/App";
import { makeQueryClient } from "./helpers";

// Controllable window stub: `onResized` returns a promise we resolve on demand
// (after unmount) so we can assert the async-cleanup guard tears the listener
// down. `vi.hoisted` shares the deferred with the hoisted `vi.mock` factory.
const winMock = vi.hoisted(() => {
	let resolveOnResized!: (fn: () => void) => void;
	const onResizedPromise = new Promise<() => void>((res) => {
		resolveOnResized = res;
	});
	const unlisten = vi.fn();
	return {
		onResizedPromise,
		unlisten,
		resolve: () => resolveOnResized(unlisten),
	};
});

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		isFullscreen: () => Promise.resolve(false),
		onResized: () => winMock.onResizedPromise,
		setFullscreen: () => Promise.resolve(),
	}),
}));

describe("AppShell — onResized listener leak (B3-05)", () => {
	it("tears down the resize listener if onResized resolves after unmount", async () => {
		const client = makeQueryClient();
		const { unmount } = render(
			<QueryClientProvider client={client}>
				<App />
			</QueryClientProvider>,
		);

		// Unmount BEFORE onResized's promise resolves (effect cleanup runs while
		// `unlisten` is still undefined in the un-guarded version → leak).
		unmount();
		expect(winMock.unlisten).not.toHaveBeenCalled();

		// Now the listener registers post-cleanup; the guard must immediately
		// invoke the returned unlisten instead of leaking it.
		winMock.resolve();
		await winMock.onResizedPromise;
		// Flush the microtask that runs the `.then` callback.
		await Promise.resolve();

		expect(winMock.unlisten).toHaveBeenCalledTimes(1);
	});
});
