import { ScanButton } from "@/screens/usage/UsageScanAction";
import { usageAsOfLine } from "@/lib/usageProjectInsights";

export function LoadoutUsageHeader({ lastScanAt, now = new Date() }: { lastScanAt: string | null; now?: Date }) {
  return (
    <div className="loadout-usage-header" data-testid="loadout-usage-header">
      <span>{usageAsOfLine(lastScanAt, now)}</span>
      <ScanButton variant="ghost">{lastScanAt ? "Refresh" : "Scan"}</ScanButton>
    </div>
  );
}
