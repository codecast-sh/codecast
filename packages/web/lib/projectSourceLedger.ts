import type { SwitchLedger } from "../components/consequential/ConsequentialSwitch";

/** The review an add opens: what it watches, where runs land, what each run gets. */
export function sourceLedger(r: { source: string; project: string; mainSession: string | null; channel: boolean; othersSession?: boolean }): SwitchLedger {
  return {
    ...(r.othersSession ? { blocked: "Main session is a teammate's" } : {}),
    name: "Add source",
    subject: r.project,
    shift: null,
    figures: [{ value: "1", label: r.channel ? "run per burst" : "run per event", tone: "warn" }],
    rows: [
      { k: "Watches", v: r.source },
      { k: "Runs in", v: r.mainSession ?? "New main session" },
      ...(r.channel ? [{ k: "A run gets", v: "Every line since the last" }, { k: "Skips", v: "Lines the session wrote" }] : []),
      { k: "Paused", v: "With the project", tone: "ok" as const },
    ],
    stop: "Pause or remove",
    confirm: `Watch ${r.source}`,
  };
}
