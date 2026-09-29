import { it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useUpdate } from "@/hooks/useUpdate";
import { useAppStore } from "@/store";
import { Processes } from "@/store/processes";

// `useUpdate` is guarded by `isTauri()` (an unexported `"__TAURI_INTERNALS__"
// in window` check), so it is a no-op in plain jsdom. `isTauri` itself isn't
// exported, so rather than mocking it directly, these tests set
// `window.__TAURI_INTERNALS__` — the exact condition the guard reads — to
// flip it true, the way a real Tauri webview would already have it.
//
// `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` are real
// Tauri IPC plugins: calling their real `check()`/`relaunch()` in jsdom would
// reach into the (mocked, minimal) `@tauri-apps/api/core` `invoke` and likely
// throw or return a shape the plugin's own code doesn't expect. Per the
// brief, they're mocked at the import boundary instead.
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

function enableTauri() {
	(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
}

afterEach(() => {
	delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
	vi.mocked(check).mockReset();
	vi.mocked(relaunch).mockReset();
	useAppStore.setState({ updateInfo: null, updateStatus: "idle", updateProgress: 0 });
});

it("is a no-op outside a Tauri runtime: mount never calls the plugin's check()", async () => {
	renderHook(() => useUpdate());
	// Give the mount effect a tick to have fired if it were going to.
	await Promise.resolve();
	expect(check).not.toHaveBeenCalled();
	expect(useAppStore.getState().updateStatus).toBe("idle");
});

it("checkForUpdate: an update is available sets updateInfo and status=available", async () => {
	enableTauri();
	vi.mocked(check).mockResolvedValue({
		version: "2.0.0",
		body: "Bug fixes.",
	} as never);

	const { result } = renderHook(() => useUpdate());

	await waitFor(() => expect(result.current.updateStatus).toBe("available"));
	expect(result.current.updateInfo).toEqual({ version: "2.0.0", notes: "Bug fixes." });
});

it("checkForUpdate: no update available sets updateInfo=null and status=idle", async () => {
	enableTauri();
	vi.mocked(check).mockResolvedValue(null as never);

	const { result } = renderHook(() => useUpdate());

	await waitFor(() => expect(check).toHaveBeenCalled());
	expect(result.current.updateStatus).toBe("idle");
	expect(result.current.updateInfo).toBeNull();
});

it("checkForUpdate: a rejected check degrades to status=idle instead of throwing", async () => {
	enableTauri();
	vi.mocked(check).mockRejectedValue(new Error("network down"));
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

	const { result } = renderHook(() => useUpdate());

	await waitFor(() => expect(check).toHaveBeenCalled());
	expect(result.current.updateStatus).toBe("idle");
	warn.mockRestore();
});

it("installUpdate: downloads, installs, relaunches, and reports 100% progress", async () => {
	enableTauri();
	const downloadAndInstall = vi.fn(async (onEvent: (e: unknown) => void) => {
		onEvent({ event: "Started", data: { contentLength: 100 } });
		onEvent({ event: "Progress", data: { chunkLength: 100 } });
		onEvent({ event: "Finished" });
	});
	vi.mocked(check).mockResolvedValue({
		version: "2.0.0",
		body: "notes",
		downloadAndInstall,
	} as never);
	vi.mocked(relaunch).mockResolvedValue(undefined as never);

	const { result } = renderHook(() => useUpdate());
	await waitFor(() => expect(result.current.updateStatus).toBe("available"));

	await act(async () => {
		await result.current.installUpdate();
	});

	expect(downloadAndInstall).toHaveBeenCalledTimes(1);
	expect(relaunch).toHaveBeenCalledTimes(1);
	expect(result.current.updateStatus).toBe("ready");
	expect(result.current.updateProgress).toBe(100);
});

it("installUpdate: a failed download reports the error and offers a retry, without relaunching", async () => {
	enableTauri();
	vi.mocked(check).mockResolvedValue({
		version: "2.0.0",
		body: "notes",
		downloadAndInstall: vi.fn().mockRejectedValue(new Error("disk full")),
	} as never);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

	const { result } = renderHook(() => useUpdate());
	await waitFor(() => expect(result.current.updateStatus).toBe("available"));

	await act(async () => {
		await result.current.installUpdate();
	});

	expect(result.current.updateStatus).toBe("error");
	expect(relaunch).not.toHaveBeenCalled();
	const proc = Processes.list().find((p) => p.target === "app:update");
	expect(proc?.status).toBe("error");
	expect(proc?.body).toBe("disk full");
	expect(proc?.retry).toBeTypeOf("function");
	warn.mockRestore();
});
