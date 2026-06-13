import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type {
  AdoptionRequired,
  Capabilities,
  DoctorReport,
  PermissionsShow,
  PermissionsShowGlobal,
  RiskSchemaEntry,
  Scope,
} from "@/types/permissions";

/** React-Query scope key matching the spec. */
export const permissionsKey = (scope: Scope) =>
  scope.kind === "global"
    ? (["permissions", "global"] as const)
    : (["permissions", "project", scope.name] as const);

/**
 * Lazy permissions fetch. `enabled` defaults to `false` — callers must flip
 * it true via the `mounted` param once the section actually renders, per the
 * "no upfront fetch" requirement.
 */
export function usePermissions(scope: Scope, mounted: boolean) {
  return useQuery({
    queryKey: permissionsKey(scope),
    queryFn: () => invoke<PermissionsShow>("permissions_show", { scope }),
    enabled: mounted,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });
}

/** Convenience selector pulling the global-only `adoption_required` field. */
export function getAdoptionRequired(
  data: PermissionsShow | undefined,
): AdoptionRequired {
  if (!data) return null;
  const g = data as PermissionsShowGlobal;
  return g.adoption_required ?? null;
}

export function usePermissionCapabilities() {
  return useQuery({
    queryKey: ["permissions", "capabilities"] as const,
    queryFn: () => invoke<Capabilities>("permissions_capabilities"),
    staleTime: 60 * 60_000, // capabilities change with app upgrade only
    refetchOnWindowFocus: false,
  });
}

export function usePermissionsDoctor(mounted: boolean) {
  return useQuery({
    queryKey: ["permissions", "doctor"] as const,
    queryFn: () => invoke<DoctorReport>("permissions_doctor"),
    enabled: mounted,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function usePermissionRisksSchema() {
  return useQuery({
    queryKey: ["permissions", "risks-schema"] as const,
    queryFn: () => invoke<RiskSchemaEntry[]>("permissions_risks_schema"),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
