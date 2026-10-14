// A machine's load at a glance, from its own last resource report
// (machine_resources): free memory, pressure and how many agents run there.
// What a placement strip and a machine chip show beside a host's name.
import type { MachineResourceSnapshot } from "@codecast/shared/contracts";

/** A report older than this says nothing about the machine now. */
export const HOST_LOAD_STALE_MS = 5 * 60_000;

export type HostLoad = { freeGb: number; totalGb: number; agents: number; tight: boolean; at: number };

const GB = 1024 ** 3;

export function hostLoadOf(row: { received_at: number; snapshot: MachineResourceSnapshot } | undefined, now: number): HostLoad | null {
  if (!row || now - row.received_at > HOST_LOAD_STALE_MS) return null;
  const s = row.snapshot.sample;
  const agents = row.snapshot.groups.find((g) => g.kind === "agent")?.processCount ?? 0;
  const freeGb = s.memoryAvailable / GB;
  // The same bar a placement uses (cli cloud/hostHeadroom): pressure, or under 4 GB free.
  const tight = s.pressure === "elevated" || s.pressure === "critical" || freeGb < 4;
  return { freeGb, totalGb: s.memoryTotal / GB, agents, tight, at: row.received_at };
}

export function formatHostLoad(l: HostLoad): string {
  return `${l.freeGb < 10 ? l.freeGb.toFixed(1) : Math.round(l.freeGb)} of ${Math.round(l.totalGb)} GB free · ${l.agents} agent${l.agents === 1 ? "" : "s"}`;
}
