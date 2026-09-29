import { useRef, useState } from "react";
import { Button } from "@/components/Button";
import { EquipPicker } from "@/components/EquipPicker";
import { NewSkillSheet } from "@/components/NewSkillSheet";
import { Popover } from "@/components/Popover";
import { FILTER_THRESHOLD } from "@/lib/navRules";
import type { BundleLensState } from "./BundleLens";

const ADD_SKILLS_POPOVER_WIDTH = 340;

/** The primary "Add skills" control. Each mounted instance owns its picker
 * and create-sheet state, so the header and empty state cannot fight over an
 * anchor. */
export function BundleAddSkillsButton({
  lens,
  variant = "primary",
}: {
  lens: BundleLensState;
  variant?: "primary" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  return (
    <>
      <span ref={anchorRef} className="popover-anchor-inline">
        <Button
          variant={variant}
          icon="plus"
          data-testid="bundle-add-skills"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          Add skills
        </Button>
      </span>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        label={`Add skills to ${lens.bundleName}`}
        width={ADD_SKILLS_POPOVER_WIDTH}
      >
        <EquipPicker
          variant="inline"
          filterThreshold={FILTER_THRESHOLD}
          subject={{ kind: "bundle", name: lens.bundleName }}
          targets={lens.addSkillsTargets}
          onToggle={lens.onAddSkillsToggle}
          listLabel="Skills"
          searchPlaceholder="Filter skills…"
          emptyLabel="No skills registered."
          footer={
            <Button
              variant="ghost"
              size="sm"
              icon="plus"
              className="bundle-create-skill"
              onClick={() => {
                setOpen(false);
                setCreateOpen(true);
              }}
            >
              Create new skill
            </Button>
          }
        />
      </Popover>
      <NewSkillSheet
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          // `Modal` restores focus to its opener, but the opener here is the
          // "Create new skill" button inside the Add skills popover, which is
          // already unmounted (the popover closed first, above) by the time
          // this sheet closes — focus would otherwise fall to `body`.
          // `Button` doesn't forward a ref, so reach the rendered element via
          // the anchor span that already wraps it (same pattern as
          // `BundlePlaybook`'s `addRef`).
          anchorRef.current
            ?.querySelector<HTMLButtonElement>("button")
            ?.focus({ preventScroll: true });
        }}
        addToBundle={{ name: lens.bundleName, addSkill: lens.addCreatedSkill }}
      />
    </>
  );
}
