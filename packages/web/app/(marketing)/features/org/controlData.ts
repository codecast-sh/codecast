import type { IconKey } from "./icons";

/*
 * The control section's data: the org's History log (seeded with a day and a
 * half of changes from every door) and the lifecycle of one role, @social.
 * Sentences follow the app's History wording (orgLogEntryLine: Undid "...",
 * Applied again "...", "Taken back by <name>").
 */

export type Door = "proposal" | "settings" | "chart" | "cli" | "history";
export const DOOR_WORDS: Record<Door, string> = {
  proposal: "proposal", settings: "Settings", chart: "the chart", cli: "the command line", history: "History",
};

export type Actor = { kind: "person"; id: string } | { kind: "role"; id: string };

export type Life = { auto: boolean; paused: boolean; shape: "one" | "split" | "retired" };
export const LIFE_START: Life = { auto: true, paused: false, shape: "one" };

export type LastChange = { line: string; change?: [string, string] };

export type LifeChange = { [K in keyof Life]: { key: K; before: Life[K]; after: Life[K] } }[keyof Life];

export type LogEntry = {
  id: string;
  day: "Today" | "Yesterday";
  at: string;
  door: Door;
  /** "proposal op-12" style suffix for the door words. */
  doorRef?: string;
  actor: Actor;
  line: string;
  change?: [string, string];
  effects: string[];
  /** What taking it back changes, shown before the person confirms. */
  undoEffects?: string[];
  /** What an undo cannot take back. */
  cannot?: string[];
  gesture?: "undo" | "redo";
  undoneBy?: { name: string; at: string };
  /** The lifecycle field this entry set, so Undo and Redo move the strip too. */
  life?: LifeChange;
};

export const LOG_SEED: LogEntry[] = [
  {
    id: "e7", day: "Today", at: "11:40", door: "settings", actor: { kind: "person", id: "maya" },
    line: "Paid Ads lead: Starts work on its own", change: ["on", "off"],
    effects: ["New ad work waits for you to start it"],
    undoEffects: ["@paid-ads starts work in its area again"],
  },
  {
    id: "e6", day: "Today", at: "10:05", door: "proposal", doorRef: "op-12", actor: { kind: "person", id: "maya" },
    line: "Hired Head of Infrastructure under @eng", change: ["none", "active"],
    effects: ["12 sessions moved to @infra", "Weekly cost review started"],
    undoEffects: ["@infra retired", "12 sessions back with their starters", "Weekly cost review cancelled"],
    cannot: ["4 messages a role already sent stay sent."],
  },
  {
    id: "e5", day: "Today", at: "09:30", door: "cli", actor: { kind: "role", id: "people" },
    line: "Filed 3 sessions under @mobile", change: ["Leo Park", "@mobile"],
    effects: ["3 sessions left Leo's Needs You", "Each was told: You now report to Head of Mobile"],
    undoEffects: ["3 sessions back with Leo Park"],
    cannot: ["The work 3 sessions already did stays done."],
  },
  {
    id: "e4", day: "Today", at: "09:12", door: "chart", actor: { kind: "person", id: "leo" },
    line: "Moved Evals lead under @eng", change: ["Maya Chen", "@eng"],
    effects: ["@evals was told: You now report to Engineering lead"],
    undoEffects: ["@evals reports to Maya Chen again"],
  },
  {
    id: "e3", day: "Yesterday", at: "17:48", door: "settings", actor: { kind: "person", id: "maya" },
    line: "Daily limits for @paid-ads", change: ["none", "12 wakes, 400k tokens"],
    effects: [],
    undoEffects: ["@paid-ads has no daily limits"],
    cannot: ["3 wakes that already ran stay run."],
  },
  {
    id: "e2", day: "Yesterday", at: "15:20", door: "cli", actor: { kind: "person", id: "ines" },
    line: "Granted @paid-ads: spend up to $50 a day", change: ["none", "until Dec 8"],
    effects: [],
    undoEffects: ["@paid-ads may not spend"],
  },
  {
    id: "e1", day: "Yesterday", at: "11:02", door: "proposal", doorRef: "op-11", actor: { kind: "person", id: "maya" },
    line: "Retired Docs lead", change: ["active", "retired"],
    effects: ["Its area fell back to @eng", "2 open tasks moved up to @eng", "Knowledge handoff to @eng ran first"],
    undoEffects: ["Docs lead back with its area and 2 tasks"],
  },
];

// ---- The role whose lifecycle the strip drives -----------------------------

export type Seat = { handle: string; title: string; k: IconKey; areas: string[]; sessions: number[] };

export const SOCIAL: Seat = { handle: "@social", title: "Social lead", k: "share nodes", areas: ["Launch posts", "Community"], sessions: [0, 1, 2] };
export const HALVES: Seat[] = [
  { handle: "@launch-posts", title: "Launch posts lead", k: "megaphone", areas: ["Launch posts"], sessions: [0] },
  { handle: "@community", title: "Community lead", k: "dialogue bubbles", areas: ["Community"], sessions: [1, 2] },
];

export const SESSIONS: { title: string; state: "working" | "dormant" | "needs" }[] = [
  { title: "v2.3 launch thread", state: "working" },
  { title: "Weekly community digest", state: "dormant" },
  { title: "Reply to forum question", state: "needs" },
];

/** The dated "Where it stands" lines, copied into each new brief on a split or retire. */
export const WHERE_IT_STANDS: Record<string, string> = {
  "Launch posts": "Nov 6 · v2.3 thread drafted, posts Tue",
  Community: "Nov 7 · digest moved to Fridays",
};

/** The History entry each lifecycle press writes. */
export function lifeEntry(change: LifeChange): Omit<LogEntry, "id" | "day" | "at" | "actor" | "door"> {
  switch (change.key) {
    case "auto": return change.after
      ? { line: "Social lead: Starts work on its own", change: ["off", "on"], effects: ["@social starts sessions in its area"], undoEffects: ["@social recommends; you start the work"] }
      : { line: "Social lead: Starts work on its own", change: ["on", "off"], effects: ["New work in its area waits for you to start it"], undoEffects: ["@social starts work in its area again"] };
    case "paused": return change.after
      ? { line: "Paused @social", change: ["active", "paused"], effects: ["2 triggers held", "3 sessions told to stop at a safe point"], undoEffects: ["2 triggers run again"] }
      : { line: "Resumed @social", change: ["paused", "active"], effects: ["2 triggers run again"], undoEffects: ["2 triggers held"] };
    case "shape": return change.after === "split"
      ? { line: "Split @social into @launch-posts and @community", change: ["1 lead", "2 leads"], effects: ["Where it stands copied to both briefs, marked (from @social)", "3 sessions moved by area", "@social hands over the rest within 24h"], undoEffects: ["Both new leads retired", "@social back with its whole area"], cannot: ["Messages the new leads already sent stay sent."] }
      : change.after === "retired"
        ? { line: "Retired @social", change: ["active", "retired"], effects: ["Launch posts and Community fell back to @cmo", "3 sessions moved to @cmo", "Knowledge handoff to @cmo first, 24h"], undoEffects: ["@social back with its area and 3 sessions"] }
        : { line: "Restored @social", effects: [] };
  }
}
