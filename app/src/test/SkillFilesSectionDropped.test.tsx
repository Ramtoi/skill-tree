import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SkillFilesSection } from "@/components/skillFiles/SkillFilesSection";
import { SKILL_MD } from "@/lib/skillFileTree";

describe("SkillFilesSection — dropped upstream", () => {
	it("renders the one honest line instead of the generic list error", () => {
		render(
			<SkillFilesSection
				listing={undefined}
				loading={false}
				error={null}
				activeRel={SKILL_MD}
				onSelect={vi.fn()}
				dirtyRels={new Set()}
				missingRels={new Set()}
				readOnly
				onAddFile={vi.fn()}
				storageKey="test:sections"
				dropped={{ refShort: "694fa30", lastSeenAt: "2026-06-10T21:59:34+02:00" }}
			/>,
		);
		expect(screen.getByTestId("skill-files-dropped")).toBeInTheDocument();
		expect(screen.getByText(/Files were dropped upstream at/)).toBeInTheDocument();
		expect(screen.getByText("694fa30")).toBeInTheDocument();
		expect(screen.queryByText(/Could not list this skill's files/)).toBeNull();
		expect(screen.queryByText(/Add file/)).toBeNull();
	});

	it("an error WITHOUT dropped still shows the generic list error", () => {
		render(
			<SkillFilesSection
				listing={undefined}
				loading={false}
				error={new Error("boom")}
				activeRel={SKILL_MD}
				onSelect={vi.fn()}
				dirtyRels={new Set()}
				missingRels={new Set()}
				readOnly={false}
				onAddFile={vi.fn()}
				storageKey="test:sections"
			/>,
		);
		expect(screen.getByText(/Could not list this skill's files/)).toBeInTheDocument();
		expect(screen.queryByTestId("skill-files-dropped")).toBeNull();
	});

	it("with no ref/date known, still renders the line with an em dash", () => {
		render(
			<SkillFilesSection
				listing={undefined}
				loading={false}
				error={null}
				activeRel={SKILL_MD}
				onSelect={vi.fn()}
				dirtyRels={new Set()}
				missingRels={new Set()}
				readOnly
				onAddFile={vi.fn()}
				storageKey="test:sections"
				dropped={{ refShort: null, lastSeenAt: null }}
			/>,
		);
		expect(screen.getByTestId("skill-files-dropped")).toHaveTextContent("—");
	});
});
