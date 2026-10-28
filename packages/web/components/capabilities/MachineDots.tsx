"use client";

import { isBroken, type FleetGridRow } from "./fleetRows";
import type { CapabilityDevice } from "./kinds";

/**
 * Where a capability is, as one square per machine in a fixed order. A
 * machine that has it is a quiet filled square; one missing it is a yellow
 * outline; red is switched on and never downloaded; a dashed square has not
 * reported. Every row on the page uses the same order, so a column of gaps is
 * one machine falling behind.
 */
export function MachineDots({ row, devices }: { row: FleetGridRow | undefined; devices: CapabilityDevice[] }) {
  if (devices.length === 0) return null;
  const text = label(row, devices);
  return (
    <span className="inline-flex items-center gap-[3px]" aria-label={text} title={text}>
      {devices.map((d) => {
        const cell = row?.byDevice[d.deviceId];
        // Having it is the quiet case; what needs a look is what stands out.
        const tone =
          !cell || cell.status === "unknown"
            ? "border border-dashed border-sol-border"
            : !cell.present
              ? "border border-sol-yellow"
              : isBroken(cell)
                ? "bg-sol-red"
                : !cell.enabled
                  ? "border border-sol-text-dim"
                  : "bg-sol-text-dim opacity-40";
        return <span key={d.deviceId} className={`h-[7px] w-[7px] rounded-[2px] ${tone}`} />;
      })}
    </span>
  );
}

function label(row: FleetGridRow | undefined, devices: CapabilityDevice[]): string {
  if (!row) return `On none of ${devices.length} machines`;
  const missing = devices.filter((d) => {
    const c = row.byDevice[d.deviceId];
    return c && c.status !== "unknown" && !c.present;
  });
  const broken = devices.filter((d) => {
    const c = row.byDevice[d.deviceId];
    return c && isBroken(c);
  });
  const parts = [`On ${row.activeCount} of ${devices.length} machines`];
  if (missing.length) parts.push(`missing on ${missing.map((d) => d.name).join(", ")}`);
  if (broken.length) parts.push(`not downloaded on ${broken.map((d) => d.name).join(", ")}`);
  return parts.join(" · ");
}
