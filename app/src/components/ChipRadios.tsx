import type { ReactNode } from "react";
import { Spinner } from "./loading";

export interface ChipRadioOption<V extends string> {
	value: V;
	label: ReactNode;
	/** A leading glyph rendered before the label — decorative, so the
	 *  option's accessible name stays its `label` regardless of what
	 *  this holds. */
	icon?: ReactNode;
	/** Hover preview of what picking this does. */
	title?: string;
}

export interface ChipRadiosProps<V extends string> {
	/** The radio group's `name` — one per group on the page. */
	name: string;
	/** Accessible name of the group ("Triggering", "Kind"). */
	label: string;
	/** The checked value; `null` checks nothing (a conflicted state). */
	value: V | null;
	options: readonly ChipRadioOption<V>[];
	onChange: (value: V) => void;
	/** Notify a caller while a choice is being previewed without changing value. */
	onPreview?: (value: V | null) => void;
	disabled?: boolean;
	/** True marks the selected option busy; a value marks the requested option. */
	busy?: boolean | V;
	/** Hover text on the group itself (a fact that applies to every option,
	 *  not just one — rule 9). */
	title?: string;
	className?: string;
}

/**
 * One `.chips` row of real radio inputs: a chip per option, the chosen one a
 * lit slot. The input lies invisibly over its whole chip so a click, the
 * keyboard (arrows move between radios, as native radios do) and a test's
 * `check()` all land on the input itself. Used for a setting with a handful
 * of named values where every value should stay in view (the trigger mode,
 * a new file's kind) — a `Select` is for a longer or rarer choice.
 */
export function ChipRadios<V extends string>({
	name,
	label,
	value,
	options,
	onChange,
	onPreview,
	disabled,
	busy,
	title,
	className,
}: ChipRadiosProps<V>) {
	return (
		<div
			className={`chips chip-radios${className ? ` ${className}` : ""}`}
			role="radiogroup"
			aria-label={label}
			aria-disabled={disabled || !!busy || undefined}
			aria-busy={!!busy || undefined}
			title={title}
		>
			{options.map((opt) => {
				const active = value === opt.value;
				const pending = !!busy && (busy === true ? active : busy === opt.value);
				return (
					// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the label wraps the focusable radio and previews its choice.
					<label
						key={opt.value}
						className={`chip chip-radio${pending ? " is-loading" : ""}`}
						data-active={active || undefined}
						data-disabled={disabled || undefined}
						title={opt.title ?? (typeof opt.label === "string" ? opt.label : undefined)}
						onMouseEnter={() => onPreview?.(opt.value)}
						onMouseLeave={() => onPreview?.(null)}
					>
						<input
							type="radio"
							name={name}
							value={opt.value}
							className="chip-radio-input"
							checked={active}
							disabled={disabled || !!busy}
							aria-busy={pending || undefined}
							onFocus={() => onPreview?.(opt.value)}
							onBlur={() => onPreview?.(null)}
							onChange={() => onChange(opt.value)}
						/>
						<span className="chip-label">
							{pending ? <Spinner size={12} /> : opt.icon && (
								<span className="chip-icon" aria-hidden="true">
									{opt.icon}
								</span>
							)}
							<span className="chip-label-text">{opt.label}</span>
						</span>
					</label>
				);
			})}
		</div>
	);
}
