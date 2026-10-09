"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { settingsOnMap } from "../../../lib/line/lineMapUrl";
import { useWatchEffect } from "../../../hooks/useWatchEffect";

// /line/settings: the line's settings live on its map now (line-map.md LX1).
// Every link in (lineSettingsHref) lands on the map with the matching panel
// open: a station's panel for ?station=, else the line's settings panel at
// the ?section= it names.
export default function LineSettingsRoute() {
  const router = useRouter();
  const search = useSearchParams();
  const to = settingsOnMap(search);
  useWatchEffect(() => { router.replace(to); }, [router, to]);
  return null;
}
