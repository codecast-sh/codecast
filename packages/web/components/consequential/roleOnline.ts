// Bringing a role online, as the review's data (ConsequentialSwitch
// SwitchLedger), and any ledger as plain lines for a surface that can only
// show text (the phone's native alert). Its own file with no imports beyond
// types, so the mobile bundle can read it.
import type { SwitchLedger } from "./ConsequentialSwitch";

/** A role's standing session started on its host's machine; with its own switch on, it then starts work unasked. */
export function roleOnlineLedger(r: { handle: string; name: string; host: string; startsOnItsOwn: boolean; sessionsPerDay: number }): SwitchLedger {
  return {
    name: `Bring @${r.handle} online`,
    subject: r.name,
    shift: ["Offline", "Online"],
    figures: [
      { value: "1", label: "session now", tone: "warn" },
      r.startsOnItsOwn ? { value: String(r.sessionsPerDay), label: "a day, unasked", tone: "warn" } : { value: "0", label: "unasked" },
    ],
    rows: [
      { k: "Runs on", v: `${r.host}'s machine` },
      r.startsOnItsOwn ? { k: "Starts work", v: "On its own", tone: "warn" } : { k: "Starts work", v: "When asked", tone: "ok" },
    ],
    stop: "Pause or retire",
    confirm: "Bring online",
    keep: "Keep offline",
  };
}

/** A ledger as short lines: the figures, then each row, then how to stop. */
export function ledgerLines(l: SwitchLedger): string[] {
  return [
    ...l.figures.map((f) => `${f.value} ${f.label}`),
    ...l.rows.map((r) => `${r.k}: ${r.v}`),
    ...(l.stop ? [`To stop: ${l.stop}`] : []),
  ];
}
