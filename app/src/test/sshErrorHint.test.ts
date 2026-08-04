import { describe, it, expect } from "vitest";
import { sshErrorHint } from "@/lib/sshErrorHint";

describe("sshErrorHint", () => {
	it("maps timeouts / no-route to an unreachable hint (wake-box)", () => {
		expect(sshErrorHint("ssh: connect: Operation timed out").recovery).toBe(
			"wake-box",
		);
		expect(sshErrorHint("No route to host").recovery).toBe("wake-box");
		expect(sshErrorHint("Connection refused").recovery).toBe("wake-box");
		expect(sshErrorHint("ssh: Could not resolve hostname box").recovery).toBe(
			"wake-box",
		);
	});

	it("maps a changed host key to a re-pin hint", () => {
		const r = sshErrorHint("Host key verification failed.");
		expect(r.recovery).toBe("re-pin");
		expect(r.hint).toMatch(/host key changed/i);
		expect(
			sshErrorHint("host key for 'x' does not match the pinned fingerprint")
				.recovery,
		).toBe("re-pin");
	});

	it("maps publickey / permission-denied to an install-key hint", () => {
		expect(sshErrorHint("Permission denied (publickey).").recovery).toBe(
			"install-key",
		);
		expect(sshErrorHint("Authentication failed").recovery).toBe("install-key");
	});

	it("maps a missing Hermes install to install-hermes", () => {
		expect(
			sshErrorHint(
				"connected, but ~/.hermes not found — is Hermes installed on this box?",
			).recovery,
		).toBe("install-hermes");
	});

	it("returns no hint for empty / unrecognized detail", () => {
		expect(sshErrorHint("").hint).toBe("");
		expect(sshErrorHint(null).recovery).toBe("none");
		expect(sshErrorHint("some totally unrelated string").hint).toBe("");
	});

	it("prefers the host-key match over the generic key match (order-sensitive)", () => {
		// A mismatch message also mentions "key" — it must classify as re-pin,
		// not install-key.
		expect(
			sshErrorHint("Host key verification failed (publickey)").recovery,
		).toBe("re-pin");
	});
});
