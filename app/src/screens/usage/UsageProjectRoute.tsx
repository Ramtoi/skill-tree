import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ScreenHeader } from "@/components/ScreenHeader";
import {
  backReturnOptions,
  fromNav,
  usageBackTarget,
  usageProjectBackTarget,
  useBackTarget,
} from "@/lib/backTarget";
import { UsageProjectArea } from "./UsageProjectArea";
import { ScanButton } from "./UsageScanAction";
import { useUsageWindow } from "./useUsageWindow";

export function UsageProjectRoute() {
  const { name = "" } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { window, setWindow } = useUsageWindow();
  const back = useBackTarget(usageBackTarget());

  return (
    <>
      <ScreenHeader
        title="Usage"
        back={{ label: back.label, onClick: () => navigate(back.path, backReturnOptions(back)) }}
        nameMono={name}
        crumbs={back.crumbs?.length === 2 ? back.crumbs : ["usage", name]}
        primary={<ScanButton />}
      />
      {/* Keyboard focus is required because this region owns the page scroll. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div className="main-body screen-pad project-usage-body" role="region" tabIndex={0} aria-label="Project usage content">
        <UsageProjectArea
          name={name}
          window={window}
          onWindowChange={setWindow}
          onOpenSession={(sessionId, harness) =>
            navigate(
              `/usage/session/${encodeURIComponent(sessionId)}?harness=${encodeURIComponent(harness)}`,
              fromNav({ ...usageProjectBackTarget(name), path: `${location.pathname}${location.search}`, restore: { ...location.state, usageWindow: window } }),
            )
          }
        />
      </div>
    </>
  );
}
