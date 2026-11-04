// The sidebar Ops row's count: what pages a person right now (alerting
// watches, regressed and escalating issues, sources down), read through the same
// attention list and source health the Ops home draws, so the badge is always
// the sum of those tiles on the home. It is an "alert" count, so every visual
// style keeps it red as it does Chat's mentions, never the pale volume tint.
import { useMemo } from "react";
import { NavCount } from "../sidebar/navPrimitives";
import { opsBadge } from "./opsHomeModel";
import { useOpsAttention } from "./useOpsAttention";
import { useSourceHealthMap } from "./useSourceHealth";

export function OpsNavBadge() {
  const health = useSourceHealthMap();
  const items = useOpsAttention(health);
  const { n, words } = useMemo(() => opsBadge(items), [items]);
  return n > 0 ? <span className="flex flex-shrink-0" title={words} data-ops-badge={n}><NavCount n={n} tone="bg-sol-red text-white" kind="alert" /></span> : null;
}
