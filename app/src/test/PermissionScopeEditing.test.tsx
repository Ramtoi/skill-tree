import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MemoryRouter } from "react-router-dom";

import { PermissionsEditor } from "@/components/PermissionsEditor";
import { PermissionRow } from "@/components/PermissionRow";
import { makeQueryClient } from "./helpers";
import type {
	Capabilities,
	NormalizedPermissions,
	PermissionsShowGlobal,
	Rule,
} from "@/types/permissions";

const EMPTY: NormalizedPermissions = {
	allow: [],
	deny: [],
	ask: [],
	hooks: [],
	sandbox_mode: null,
	approval_policy: null,
	project_trust: null,
	additional_dirs: [],
	extras: {},
	_unmanaged: [],
};

const CAPS: Capabilities = {
	"claude-code": [
		"tool_allowlist",
		"tool_denylist",
		"tool_ask",
		"hooks",
		"additional_directories",
	],
};

/** Wire a basic invoke mock. `show` is returned for the active scope; an
 *  optional `globalShow` is returned for the implicit global fetch project
 *  scope makes for inheritance notes. */
function wire({
	show,
	globalShow,
	capabilities = CAPS,
}: {
	show: NormalizedPermissions | PermissionsShowGlobal;
	globalShow?: NormalizedPermissions;
	capabilities?: Capabilities;
}) {
	const setPayloads: { scope: unknown; payload: NormalizedPermissions }[] = [];
	vi.mocked(invoke).mockImplementation(
		async (cmd: string, args?: unknown): Promise<unknown> => {
			switch (cmd) {
				case "permissions_show": {
					const a = args as { scope: { kind: string } };
					if (a.scope.kind === "global" && globalShow) return globalShow;
					return show;
				}
				case "permissions_capabilities":
					return capabilities;
				case "permissions_risks_schema":
					return [];
				case "permissions_validate":
					return { ok: true, error: null };
				case "permissions_doctor":
					return { findings: [], danger_count: 0 };
				case "permissions_set": {
					const a = args as { scope: unknown; payload: NormalizedPermissions };
					setPayloads.push({ scope: a.scope, payload: a.payload });
					return { changed: true, normalized: a.payload };
				}
				default:
					return undefined;
			}
		},
	);
	return { setPayloads };
}

function renderEditor(props: React.ComponentProps<typeof PermissionsEditor>) {
	const client = makeQueryClient();
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<PermissionsEditor {...props} />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("Permissions global-scope editability (read-only leak fix)", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("renders a global-origin rule as EDITABLE in the global view (pattern not disabled, delete present)", async () => {
		wire({
			show: {
				...EMPTY,
				allow: [{ pattern: "Bash(npm:*)", kind: "allow", origin: "global" }],
			},
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 2 });
		const input = (await screen.findByLabelText("Pattern")) as HTMLInputElement;
		// The bug: this used to be disabled because origin === "global".
		expect(input.disabled).toBe(false);
		// And a delete control is present (it was hidden when locked).
		expect(
			screen.getByRole("button", { name: "Delete rule" }),
		).toBeInTheDocument();
	});

	it("hides the 'via global' badge and the promote button in the global view", async () => {
		wire({
			show: {
				...EMPTY,
				allow: [{ pattern: "Bash(npm:*)", kind: "allow", origin: "global" }],
			},
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 2 });
		await screen.findByLabelText("Pattern");
		expect(screen.queryByText("via global")).toBeNull();
		expect(screen.queryByRole("button", { name: /Copy to project/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /Promote/ })).toBeNull();
	});

	it("keeps a global-origin rule READ-ONLY with the badge in a project view (no regression)", async () => {
		wire({
			show: {
				...EMPTY,
				allow: [{ pattern: "Bash(npm:*)", kind: "allow", origin: "global" }],
			},
			globalShow: EMPTY,
		});
		renderEditor({ scope: { kind: "project", name: "alpha" }, projectCount: 1 });
		const input = (await screen.findByLabelText("Pattern")) as HTMLInputElement;
		expect(input.disabled).toBe(true);
		expect(screen.getByText("via global")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Copy to project/ }),
		).toBeInTheDocument();
	});

	it("lets the user change a rule's kind via the switcher (allow → deny) in the global view", async () => {
		wire({
			show: {
				...EMPTY,
				allow: [{ pattern: "Bash(npm:*)", kind: "allow", origin: "global" }],
			},
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findByLabelText("Pattern");
		// The ALLOW button is pressed; click DENY.
		const denyBtn = screen.getByRole("button", { name: "Set kind DENY" });
		fireEvent.click(denyBtn);
		// After the move the row's kind switch reflects DENY as the active kind.
		await waitFor(() => {
			const pressedDeny = screen.getByRole("button", { name: "Set kind DENY" });
			expect(pressedDeny.getAttribute("aria-pressed")).toBe("true");
		});
		// The row's container now advertises the deny kind.
		const row = screen.getByLabelText("Pattern").closest(".permission-row");
		expect(row?.getAttribute("data-kind")).toBe("deny");
	});
});

describe("PermissionRow kind switcher (unit)", () => {
	const rule: Rule = { pattern: "Bash(npm:*)", kind: "allow", origin: "project" };

	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("fires onChangeKind with the new kind", () => {
		const onChangeKind = vi.fn();
		render(
			<PermissionRow
				rule={rule}
				scopeKind="global"
				installedHarnesses={["claude-code"]}
				capabilities={CAPS}
				onChangeKind={onChangeKind}
				onChange={() => {}}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Set kind ASK" }));
		expect(onChangeKind).toHaveBeenCalledWith("ask");
	});

	it("offers a Move-to-global affordance on a project-owned rule in the project view", () => {
		const onDemote = vi.fn();
		render(
			<PermissionRow
				rule={rule}
				scopeKind="project"
				installedHarnesses={["claude-code"]}
				capabilities={CAPS}
				onDemote={onDemote}
			/>,
		);
		const move = screen.getByRole("button", { name: /Move to global/ });
		fireEvent.click(move);
		expect(onDemote).toHaveBeenCalled();
	});
});
