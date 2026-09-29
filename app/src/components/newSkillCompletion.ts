import type { NavigateFunction } from "react-router-dom";
import { bundleBackTarget, fromNav } from "@/lib/backTarget";
import { errorDetail } from "@/lib/cliOutput";
import { trackProcess } from "@/lib/trackProcess";
import type { useToast } from "./Toast";

export interface AddToBundleTarget {
  name: string;
  addSkill: (skillName: string) => Promise<void>;
}

export interface NewSkillCompletion {
  createdName: string;
  standaloneTitle: string;
  bundleVerb: "Created" | "Registered";
  body?: string;
  focusMcp?: boolean;
}

interface CompleteNewSkillOptions extends NewSkillCompletion {
  addToBundle?: AddToBundleTarget;
  toast: ReturnType<typeof useToast>;
  onClose: () => void;
  navigate: NavigateFunction;
}

/** Process target for a bundle addition that follows a skill creation,
 *  `<verb>:<subject>:<object>` (design.md Decisions #3). Exported so the
 *  pending member row can read the same target from the process store: the
 *  Library derives its whole pending set at once through
 *  `useRunningTargets(prefix)` in `SkillLibrary.tsx`, not per row. */
export function bundleAddTarget(bundle: string, skill: string): string {
  return `bundle-add:${bundle}:${skill}`;
}

/** Turns a rejected `addSkill` into an error whose `headline` already names
 *  what landed and what failed, forwarding any command log lines the
 *  original error carried — today that's always `[]`: `addSkill` is
 *  `useBundleMembership.add`, whose write runs through `runRegistryWrite`,
 *  which throws a plain `Error` with no `logLines` of its own. The forward
 *  stays here anyway so a future error shape that does carry output (or a
 *  different `addSkill` implementation) doesn't have to touch this function
 *  to have it show up. `trackProcess`'s own `errorDetail(err)` read
 *  (`cliOutput.ts`) picks both straight off this object, so the card's Retry
 *  failure body reads `<Created|Registered> "<skill>". Couldn't add it to
 *  "<bundle>": <headline>` without duplicating the composition logic. */
function bundleAddFailure(
  bundleVerb: "Created" | "Registered",
  createdName: string,
  bundleName: string,
  err: unknown,
): Error & { headline: string; logLines: string[] } {
  const { headline, logLines } = errorDetail(err);
  const composedHeadline = `${bundleVerb} "${createdName}". Couldn't add it to "${bundleName}": ${headline}`;
  return Object.assign(new Error(composedHeadline), {
    headline: composedHeadline,
    logLines,
  });
}

/** Runs the bundle addition as a tracked process, and owns the ONE success
 *  toast for it end to end. Called once right after the sheet closes, and
 *  again from the card's own Retry — which must never re-create the skill
 *  (design.md Decisions #5): `addSkill` is `useBundleMembership.add`, which
 *  recomputes its csv from the latest registry cache at dequeue time. Each
 *  call starts a fresh card under the same target.
 *
 *  The success toast lives HERE, not in a `.then()` the caller attaches to
 *  the first call's promise — a Retry starts a brand-new promise chain that
 *  caller never sees, so attaching the toast there would mean a Retry that
 *  succeeds shows no toast and no Open action, leaving Open reachable only
 *  through the row itself. Every call — first attempt and every retry —
 *  pushes its own toast on success and swallows its own failure: the card
 *  already failed with a Retry action, and `useBundleMembership` already
 *  pushed its own "Couldn't update bundle" toast (Decisions #7), so there is
 *  nothing else to report and nothing to leave as an unhandled rejection. */
interface RunBundleAdditionOptions {
  addToBundle: AddToBundleTarget;
  createdName: string;
  bundleVerb: "Created" | "Registered";
  toast: ReturnType<typeof useToast>;
  navigate: NavigateFunction;
  body: string | undefined;
  focusMcp: boolean;
}

function runBundleAddition({
  addToBundle,
  createdName,
  bundleVerb,
  toast,
  navigate,
  body,
  focusMcp,
}: RunBundleAdditionOptions): Promise<void> {
  return trackProcess(
    {
      title: `Adding ${createdName} to ${addToBundle.name}`,
      body: "writing bundle · syncing projects",
      kind: "local",
      target: bundleAddTarget(addToBundle.name, createdName),
    },
    () =>
      addToBundle.addSkill(createdName).catch((err: unknown) => {
        throw bundleAddFailure(bundleVerb, createdName, addToBundle.name, err);
      }),
    {
      successBody: `${createdName} is in ${addToBundle.name}`,
      retry: () => {
        // Belt-and-suspenders: the `.catch` below already keeps this
        // function's own returned promise from ever rejecting, but the
        // Retry button calls this closure fire-and-forget — guard it
        // directly too so a future change to the chain below can't turn a
        // failed retry into an unhandled rejection.
        void runBundleAddition({ addToBundle, createdName, bundleVerb, toast, navigate, body, focusMcp }).catch(
          () => {},
        );
      },
    },
  )
    .then(() => {
      // Decisions #6/#7 + design.md Wording: the Open action is the main way
      // back to a skill created from inside a bundle, so it stays up long
      // enough to act on (`success`/`error` default durations live in
      // `Toast.tsx`'s `DEFAULT_DURATION`, tuned for a plain notice, not an
      // action the user has to notice and click).
      toast.push({
        kind: "success",
        title: `${bundleVerb} "${createdName}" and added it to "${addToBundle.name}"`,
        body,
        duration: 7000,
        action: {
          label: "Open",
          onClick: () => {
            navigate(
              `/skill/${encodeURIComponent(createdName)}`,
              fromNav(bundleBackTarget(addToBundle.name)),
            );
            // A server registered from a bundle behaves like the standalone
            // MCP path: focus the panel once the navigated-to editor's
            // registry refresh makes it available.
            if (focusMcp) focusMcpPanelWhenReady();
          },
        },
      });
    })
    .catch(() => {
      // Decisions #7: the card already failed with a Retry action, and
      // `useBundleMembership` already pushed its own "Couldn't update
      // bundle" toast. Nothing else to report — swallow so this rejection
      // is never unhandled.
    });
}

export async function completeNewSkill({
  createdName,
  standaloneTitle,
  bundleVerb,
  body,
  focusMcp = false,
  addToBundle,
  toast,
  onClose,
  navigate,
}: CompleteNewSkillOptions) {
  if (addToBundle) {
    // Decisions #1/#2: the skill exists and the registry query has already
    // refetched by the time a caller gets here. Close now — the route stays
    // on the bundle — and track the addition as its own process so it
    // reports through the tray and the status bar instead of a toast from an
    // already-closed dialog.
    onClose();
    void runBundleAddition({ addToBundle, createdName, bundleVerb, toast, navigate, body, focusMcp });
    return;
  }
  toast.success(standaloneTitle, body);
  onClose();
  navigate(`/skill/${encodeURIComponent(createdName)}`, undefined);
  if (focusMcp) focusMcpPanelWhenReady();
}

/** Poll for the freshly-navigated skill editor's MCP panel and focus its
 * heading after the registry refresh makes the panel available. */
function focusMcpPanelWhenReady(maxFrames = 40) {
  let frames = 0;
  function tick() {
    const el = document.querySelector('[data-testid="mcp-panel"]') as HTMLElement | null;
    if (el) {
      el.focus();
      return;
    }
    frames += 1;
    if (frames < maxFrames) window.requestAnimationFrame(tick);
  }
  window.requestAnimationFrame(tick);
}
