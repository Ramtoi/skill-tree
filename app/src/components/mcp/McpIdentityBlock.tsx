import { SectionHeader } from "@/components/SectionHeader";
import { Field } from "@/components/Field";
import { ChipRadios } from "@/components/ChipRadios";
import { Button } from "@/components/Button";
import { PathText } from "@/components/PathText";
import { Tag } from "@/components/Tag";
import type { UseMcpDraft } from "@/hooks/useMcpDraft";
import type { McpTransport } from "@/lib/mcpContract";

export interface McpIdentityBlockProps {
	draft: UseMcpDraft;
	readOnly: boolean;
}

/** CONNECTION — transport · endpoint or command (design §4.2). */
export function McpIdentityBlock({ draft, readOnly }: McpIdentityBlockProps) {
	const { spec, original, set, errors } = draft;
	const transport: McpTransport = spec.transport ?? "stdio";
	const originalTransport: McpTransport = original.transport ?? "stdio";
	const isRemote = transport === "http" || transport === "sse";
	const transportChanged = transport !== originalTransport;

	const args = spec.args ?? [];

	function setArg(i: number, value: string) {
		const next = [...args];
		next[i] = value;
		set({ args: next });
	}

	function removeArg(i: number) {
		set({ args: args.filter((_, idx) => idx !== i) });
	}

	function addArg() {
		set({ args: [...args, ""] });
	}

	return (
		<div className="mcp-block" data-block="connection">
			<SectionHeader label="CONNECTION" />

			<Field label="transport">
				{readOnly ? (
					<Tag>{transport === "sse" ? "SSE (deprecated)" : transport === "http" ? "Remote (HTTP)" : "Local (stdio)"}</Tag>
				) : (
					<ChipRadios<McpTransport>
						name="mcp-transport"
						label="Transport"
						value={transport}
						onChange={(next) => set({ transport: next })}
						options={[
							{ value: "stdio", label: "Local (stdio)" },
							{ value: "http", label: "Remote (HTTP)" },
							// SSE only ever appears once it is already the value — a
							// deprecated shape the panel never lets anyone opt back INTO.
							...(transport === "sse"
								? [
										{
											value: "sse" as const,
											label: <span className="mcp-transport-deprecated">SSE (deprecated)</span>,
										},
									]
								: []),
						]}
					/>
				)}
			</Field>

			{transportChanged && !readOnly && (
				<div className="mcp-block-note">
					{originalTransport === "stdio"
						? "Your command is kept until you save."
						: "Your connection details are kept until you save."}
				</div>
			)}

			{isRemote ? (
				<Field label="endpoint" error={errors.url} full>
					{readOnly ? (
						<span className="kv-static text-mono">{spec.url || "—"}</span>
					) : (
						<input
							type="text"
							className="text-mono"
							placeholder="https://mcp.example.com/mcp"
							value={spec.url ?? ""}
							onChange={(e) => set({ url: e.target.value })}
						/>
					)}
				</Field>
			) : (
				<Field label="command">
					{readOnly ? (
						<span className="kv-static text-mono">{spec.command || "python3 (default)"}</span>
					) : (
						<input
							type="text"
							className="text-mono"
							placeholder="python3 (default)"
							value={spec.command ?? ""}
							onChange={(e) => set({ command: e.target.value })}
						/>
					)}
				</Field>
			)}

			{isRemote && spec.url && !urlLooksValid(spec.url) && (
				<div className="mcp-block-note" data-tone="warn">
					That does not look like a URL.
				</div>
			)}

			{!isRemote && (
				<Field label="arguments" full>
					<div className="mcp-arg-list">
						{args.length === 0 && <div className="mcp-block-note">No arguments.</div>}
						{args.map((a, i) => (
							<div className="mcp-arg-row" key={i}>
								{readOnly ? (
									<span className="kv-static text-mono">{a}</span>
								) : (
									<>
										<input
											type="text"
											className="text-mono"
											value={a}
											onChange={(e) => setArg(i, e.target.value)}
										/>
										<Button
											variant="ghost"
											size="sm"
											icon="x"
											aria-label={`Remove argument ${i + 1}`}
											onClick={() => removeArg(i)}
										/>
									</>
								)}
							</div>
						))}
						{!readOnly && (
							<Button variant="ghost" size="sm" icon="plus" onClick={addArg}>
								Add argument
							</Button>
						)}
					</div>
				</Field>
			)}

			{!isRemote && (
				<Field label="working dir">
					{spec.cwd ? (
						readOnly ? (
							<PathText path={spec.cwd} className="kv-static text-mono" />
						) : (
							<input
								type="text"
								className="text-mono"
								value={spec.cwd}
								onChange={(e) => set({ cwd: e.target.value })}
							/>
						)
					) : readOnly ? (
						<span className="mcp-block-note">Inherited from the harness.</span>
					) : (
						<input
							type="text"
							className="text-mono"
							placeholder="inherited from the harness"
							value=""
							onChange={(e) => set({ cwd: e.target.value || undefined })}
						/>
					)}
				</Field>
			)}

			<Field label="timeout">
				{readOnly ? (
					<span className="kv-static text-mono">
						{spec.timeout_ms != null ? `${spec.timeout_ms} ms` : "harness default"}
					</span>
				) : (
					<input
						type="number"
						className="text-mono"
						placeholder="harness default"
						value={spec.timeout_ms ?? ""}
						onChange={(e) =>
							set({ timeout_ms: e.target.value === "" ? undefined : Number(e.target.value) })
						}
					/>
				)}
			</Field>
			{spec.timeout_ms != null && spec.timeout_ms < 1000 && (
				<div className="mcp-block-note">
					Claude Code ignores a timeout under 1000 ms.
				</div>
			)}
		</div>
	);
}

function urlLooksValid(value: string): boolean {
	try {
		return !!new URL(value);
	} catch {
		return false;
	}
}
