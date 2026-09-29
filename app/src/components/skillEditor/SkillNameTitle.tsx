import { InlineName } from "@/components/InlineName";
import { SLUG_RE } from "@/lib/paletteVerbs";
import type { Registry } from "@/types";

export interface SkillNameTitleProps {
	/** The draft name (the editor's staged metadata). */
	name: string;
	/** The name on disk — the route. */
	savedName: string;
	registry: Registry;
	onChange: (next: string) => void;
}

/**
 * The skill editor's title: the name edits where it is read, as a project's
 * does. The rename is only STAGED here — ⌘S writes it, and may refuse while
 * a sibling file is unsaved — so the header's state slot wears `RenamedPill`
 * until it lands.
 */
export function SkillNameTitle({ name, savedName, registry, onChange }: SkillNameTitleProps) {
	return (
		<InlineName
			value={name}
			label="Skill name"
			commitOnBlur
			onSave={onChange}
			validate={(next) =>
				!SLUG_RE.test(next)
					? "Use lowercase letters, numbers and hyphens"
					: next !== savedName && next in (registry.skills ?? {})
						? "A skill with this name already exists"
						: null
			}
		/>
	);
}
