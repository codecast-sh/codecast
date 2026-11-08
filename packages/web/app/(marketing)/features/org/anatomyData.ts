/*
 * The anatomy section's data: the parts of a role a reader can point at, and
 * one illustrative day of the Release Captain. Times are hours on a 24-hour
 * clock; everything here is invented for the page.
 */

export type AnatomyTab = "brief" | "charter" | "sessions" | "triggers" | "settings";
export type PartId = "area" | "charter" | "brief" | "triggers" | "switch" | "limits" | "perms";

export type Part = { id: PartId; name: string; tab?: AnatomyTab; says: string };

/** The callouts, numbered in this order on the page and on the mock. */
export const PARTS: Part[] = [
  { id: "area", name: "Area", says: "the projects and plans it answers for" },
  { id: "charter", name: "Charter (yours)", tab: "charter", says: "written by people, read only to the role" },
  { id: "brief", name: "Brief (its own)", tab: "brief", says: "its own memory, at most 12,000 characters" },
  { id: "triggers", name: "Triggers", tab: "triggers", says: "its area check, and workers needing input" },
  { id: "switch", name: "Starts work on its own", tab: "settings", says: "starts sessions and answers decisions itself" },
  { id: "limits", name: "Limits", tab: "settings", says: "daily caps, none until you set one" },
  { id: "perms", name: "Permissions outside codecast", tab: "settings", says: "spend, publish, write, connect, granted by a person" },
];

export const partNo = (id: PartId): number => PARTS.findIndex((p) => p.id === id) + 1;

export type DayKind = "check" | "skip" | "needs" | "maya" | "brief";
export type Worker = { title: string; from: number; to: number; lane: number };
export type DayMark = { h: number; kind: DayKind; label: string; line: string; row: number; worker?: Worker };

export const clock = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

export const dur = (w: Worker) => {
  const m = Math.round((w.to - w.from) * 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

/** One Thursday of the Release Captain. Its check runs every 6 hours behind a precheck on new merges. */
export const DAY: DayMark[] = [
  { h: 3, kind: "skip", label: "check skipped", row: 0, line: "Precheck found nothing merged overnight. No run." },
  { h: 9, kind: "check", label: "check", row: 0, line: "6 PRs merged since 4.11. It starts a worker to cut 4.12.", worker: { title: "Cut release 4.12", from: 9.1, to: 10.3, lane: 1 } },
  { h: 10 + 40 / 60, kind: "needs", label: "needs input", row: 1, line: "Its worker asks about a flaky iOS test. It answers: rerun twice, then quarantine.", worker: { title: "Quarantine flaky test", from: 10.8, to: 11.6, lane: 0 } },
  { h: 13 + 20 / 60, kind: "maya", label: "message from Maya", row: -1, line: "Maya: hold 4.12 until the checkout fix lands. It holds the release.", },
  { h: 15, kind: "check", label: "check", row: 0, line: "The checkout fix merged. It starts a worker to rebuild 4.12.", worker: { title: "Rebuild with fix", from: 15.1, to: 16.2, lane: 0 } },
  { h: 16.5, kind: "brief", label: "brief +1 line", row: 1, line: "Its brief gains a line: Nov 5 · 4.12 rebuilt with the checkout fix; ships Monday." },
  { h: 21, kind: "skip", label: "check skipped", row: 0, line: "Precheck: nothing new since 15:00. No run." },
];
