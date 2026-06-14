import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useAppStore } from "@/store";
import type { RecentItem } from "@/types";

function parsePath(pathname: string): RecentItem | null {
  if (pathname === "/" || pathname === "") return null;
  if (pathname === "/permissions") {
    return { type: "source", name: "permissions" };
  }
  const m = pathname.match(/^\/(skill|project|bundle)\/(.+)$/);
  if (!m) return null;
  const type = m[1] as RecentItem["type"];
  const name = decodeURIComponent(m[2]);
  return { type, name };
}

export function useTrackRecent() {
  const location = useLocation();
  const addRecentlyVisited = useAppStore((s) => s.addRecentlyVisited);

  useEffect(() => {
    const item = parsePath(location.pathname);
    if (item) addRecentlyVisited(item);
  }, [location.pathname, addRecentlyVisited]);
}
