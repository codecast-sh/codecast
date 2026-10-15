// Every machine's current load, by device id (lib/hostLoad), from the resource
// reports already in the store. Re-derived once a minute: reports land about
// as often, and a load older than HOST_LOAD_STALE_MS drops out.
import { useMemo } from "react";
import { hostLoadOf, type HostLoad } from "../lib/hostLoad";
import { useCoarseNow } from "./useCoarseNow";
import { useMachineResourceRows } from "./useResourceMonitor";

export function useHostLoads(): ReadonlyMap<string, HostLoad> {
  const rows = useMachineResourceRows();
  const now = useCoarseNow(60_000);
  return useMemo(() => {
    const loads = new Map<string, HostLoad>();
    for (const r of rows) {
      const load = hostLoadOf(r, now);
      if (load) loads.set(r.device_id, load);
    }
    return loads;
  }, [rows, now]);
}
