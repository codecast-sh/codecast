"use client";

// The Modern rail's Ops count: what is wrong in the running product now, the same
// number the Ops Overview tab and the palette's Ops row wear (opsBadge over
// useOpsAttention, one health reading on one coarse clock). Store reads only;
// the workspace's Ops lists are fed in every window (DashboardLayout). A leaf
// of its own, so a change to the lists re-renders this pill, not the rail.

import { memo, useMemo } from "react";
import { useOpsAttention } from "../ops/useOpsAttention";
import { useSourceHealthMap } from "../ops/useSourceHealth";
import { opsBadge } from "../ops/opsHomeModel";
import { NavCount } from "./navPrimitives";

export const OpsRailCount = memo(function OpsRailCount() {
  const items = useOpsAttention(useSourceHealthMap());
  const { n, words } = useMemo(() => opsBadge(items), [items]);
  if (!n) return null;
  return (
    <span title={words}>
      <NavCount n={n} tone="bg-sol-red text-white" kind="alert" />
    </span>
  );
});
