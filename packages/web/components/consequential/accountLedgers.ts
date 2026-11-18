import type { SwitchLedger } from "./ConsequentialSwitch";
import { plural } from "./lineStartLedger";

/** One of your accounts opened to machines the pool keeps it off (the blocked banner's wait lane): their parked sessions move onto it. */
export function openAccountLedger(r: { email: string; percent: number | null; machines: string[]; lineHosts: boolean; sessions?: number; resumesIn?: string | null }): SwitchLedger {
  return {
    name: "Open account",
    subject: `${r.email} → ${r.lineHosts ? "line hosts" : r.machines.length === 1 ? r.machines[0] : "these machines"}`,
    shift: ["Kept off", "Open"],
    figures: [
      ...(r.sessions ? [{ value: String(r.sessions), label: r.sessions === 1 ? "session moves onto it" : "sessions move onto it" }] : []),
      ...(r.percent != null ? [{ value: `${Math.round(r.percent)}%`, label: "of its limit used" }] : []),
    ],
    rows: [
      { k: "Machines", v: plural(r.machines.length, "machine"), list: r.machines },
      ...(r.lineHosts ? [{ k: "Line work", v: "Spends it too", tone: "warn" as const }] : []),
      ...(r.resumesIn ? [{ k: "Without it", v: `Waits ${r.resumesIn}` }] : []),
      { k: "Undo", v: "Settings › Claude accounts" },
    ],
    confirm: `Open to ${plural(r.machines.length, "machine")}`,
    keep: "Keep waiting",
  };
}
