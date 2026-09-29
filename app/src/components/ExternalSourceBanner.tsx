import { useNavigate } from "react-router-dom";
import { runHubCmd } from "@/lib/hubCmd";
import { errText } from "@/lib/hubWrite";
import type { Skill, SourceView } from "@/types";
import { LoadingButton } from "@/components/loading";
import { Plaque, type PlaqueAccent } from "./Plaque";
import { SourceChip } from "./SourceChip";
import { useToast } from "./Toast";
import { queryClient } from "@/lib/queryClient";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import { useState } from "react";

export interface ExternalSourceBannerProps {
  skill: Skill;
  source: SourceView;
}

/** The source strip at the top of the Skill Editor side panel for a skill an
 *  external source or the Starter Pack owns. It carries only what the header
 *  does not already say — the header has the source chip, the READ-ONLY pill
 *  and the primary Duplicate-as-local — so this is the checkout coordinates
 *  (url · branch · path · ref), one line on why the files are read-only, and
 *  the sync verbs (Check, and Sync update when one is waiting). Composes
 *  `Plaque` (`styles/side-panel.css` §Source banners), shared with
 *  `DroppedUpstreamBanner`. */
export function ExternalSourceBanner({ source, skill }: ExternalSourceBannerProps) {
  const toast = useToast();
  const navigate = useNavigate();
  const [working, setWorking] = useState(false);
  const isStarter = source.type === "starter" || skill.managed === "starter";
  const isExternal = source.type === "git" || skill.managed === "external";
  if (!isExternal && !isStarter) return null;

  const accent: PlaqueAccent = isStarter ? "amber" : "anchor";
  // A mono eyebrow, like every other label in the panel — the sentence it
  // replaced ("Managed by external source") only restated the READ-ONLY pill.
  const title = isStarter ? "Starter Pack" : "External source";

  async function runSource(verb: "check" | "sync") {
    if (!isExternal) return;
    setWorking(true);
    try {
      await runHubCmd(["source", verb, source.id, "--json"]);
      await invalidateRegistry(queryClient);
      await queryClient.invalidateQueries({ queryKey: qk.sources() });
      toast.success(`${verb === "check" ? "Checked" : "Synced"} ${source.name}`);
    } catch (err) {
      toast.error(`Couldn't ${verb} source`, errText(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Plaque
      className="external-source-banner"
      data-source={source.id}
      data-managed={isStarter ? "starter" : "external"}
      eyebrow={title}
      accent={accent}
      // The chip names the source and carries its status dot; it is also the
      // way to the Sources screen, so the panel needs no "Manage source" row.
      chip={
        <SourceChip
          compact
          source={source}
          onClick={() => navigate(`/sources?focus=${encodeURIComponent(source.id)}`)}
        />
      }
      actions={
        <>
          {isExternal && (
            <>
              <LoadingButton
                variant="ghost"
                size="sm"
                icon="fetch"
                onClick={() => void runSource("check")}
                loading={working}
                loadingLabel="Checking…"
                title="Check source for updates"
              >
                Check
              </LoadingButton>
              {source.status === "update-available" && (
                <LoadingButton
                  variant="soft"
                  size="sm"
                  icon="apply"
                  onClick={() => void runSource("sync")}
                  loading={working}
                  loadingLabel="Syncing…"
                >
                  Sync update
                </LoadingButton>
              )}
            </>
          )}
        </>
      }
    >
      {isExternal && source.type === "git" && (
        <div className="source-banner-meta">
          {source.url ?? "—"}
          {source.branch ? ` · ${source.branch}` : ""}
          {source.path ? ` · /${source.path}` : ""}
          {source.current_ref ? ` · ${source.current_ref.slice(0, 7)}` : ""}
        </div>
      )}
      <p className="source-banner-copy">
        Source sync owns these files. Edit them upstream, or on a local duplicate.
      </p>
    </Plaque>
  );
}
