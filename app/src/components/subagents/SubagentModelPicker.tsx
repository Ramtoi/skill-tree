import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { Select } from "@/components/Select";
import { MODEL_ALIASES, type SubagentHarness } from "@/lib/subagents";

// Known choices, not a validation allowlist. Keep arbitrary model IDs intact.
// Codex choices seeded from the installed catalog (2026-09-17), plus older IDs.
const CODEX_MODELS = [
	"gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
	"gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-spark",
];

export function SubagentModelPicker({ harness, value, onChange, label = "Model" }: {
	harness: SubagentHarness;
	value: string;
	onChange: (value: string) => void;
	label?: string;
}) {
	const models = harness === "codex" ? CODEX_MODELS : MODEL_ALIASES.filter((m) => m !== "inherit");
	const known = value === "" || models.some((m) => m === value);
	const [customMode, setCustomMode] = useState<boolean | null>(null);
	const custom = customMode ?? !known;
	const control = useRef<HTMLDivElement>(null);
	const focusAfterToggle = useRef(false);
	useLayoutEffect(() => {
		if (!focusAfterToggle.current) return;
		control.current?.querySelector<HTMLElement>('input, [role="combobox"]')?.focus();
		focusAfterToggle.current = false;
	}, [custom]);
	const options = [
		{ value: "", label: "inherit" },
		...models.map((model) => ({ value: model, label: model })),
		...(!known ? [{ value, label: value, hint: "Custom model" }] : []),
	];
	return <div className="subagent-model-picker" ref={control}>
		{custom ? <input
			className="kv-input"
			aria-label={label}
			placeholder="inherit from session"
			value={value}
			onChange={(event) => {
				setCustomMode(true);
				onChange(event.target.value);
			}}
		/> : <Select value={value} options={options} label={label} title={value || "Inherit from session"} onChange={onChange} />}
		<Button size="sm" icon={custom ? "list" : "edit"}
			title={custom ? "Choose known model" : "Enter custom model"}
			onClick={() => {
				focusAfterToggle.current = true;
				setCustomMode(!custom);
			}}
		/>
	</div>;
}
