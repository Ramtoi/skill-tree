import { describe, it, expect } from "vitest";
import { classifyRemoteHealth } from "@/lib/remoteHealth";

describe("classifyRemoteHealth", () => {
	it("ready → ok tone, no alert", () => {
		const v = classifyRemoteHealth({ ok: true, detail_kind: "ready" });
		expect(v.tone).toBe("ok");
		expect(v.alert).toBe(false);
	});

	it("home_missing → NEUTRAL 'not set up' (never red/amber), alert banner", () => {
		const v = classifyRemoteHealth({
			ok: false,
			reachable: true,
			authenticated: true,
			ready: false,
			detail_kind: "home_missing",
			detail: "connected, but ~/.hermes not found — is Hermes installed on this box?",
		});
		expect(v.tone).toBe("neutral");
		expect(v.label).toBe("not set up");
		expect(v.alert).toBe(true);
		// The box IS authenticated — offering "install key" would be a dead end;
		// recovery is "none" (banner shows only the hint + Re-check).
		expect(v.recovery).toBe("none");
	});

	it("auth_failed → RED error", () => {
		const v = classifyRemoteHealth({
			ok: false,
			reachable: true,
			authenticated: false,
			detail_kind: "auth_failed",
			detail: "Permission denied (publickey).",
		});
		expect(v.tone).toBe("error");
		expect(v.label).toBe("auth failed");
		expect(v.recovery).toBe("install-key");
	});

	it("host_key_mismatch → RED error with a re-pin recovery", () => {
		const v = classifyRemoteHealth({
			ok: false,
			reachable: true,
			detail_kind: "host_key_mismatch",
			detail: "host key does not match the pinned fingerprint",
		});
		expect(v.tone).toBe("error");
		expect(v.recovery).toBe("re-pin");
	});

	it("unreachable → NEUTRAL (never red), wake-box recovery", () => {
		const v = classifyRemoteHealth({
			ok: false,
			reachable: false,
			detail_kind: "unreachable",
			detail: "Operation timed out",
		});
		expect(v.tone).toBe("neutral");
		expect(v.label).toBe("unreachable");
		expect(v.recovery).toBe("wake-box");
	});

	it("undefined → checking neutral", () => {
		expect(classifyRemoteHealth(undefined).label).toBe("checking…");
	});
});
