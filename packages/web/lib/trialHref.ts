// Where a trial lives: /trial opened on one trial project, in the workspace that
// project lives in (`ws`, a workspace key), so a Trial tag on a team's decision
// lands on that trial even while the app sits on Personal. `card` opens one
// card; `tab` opens one list (Failed, Stopped, ...); `from` is the /line address the
// link was pressed on, so the page leads back to that very item. TrialReviewPage reads these back (trialAddress).
export type TrialAddress = { ws: string | null; project: string | null; card: string | null; from: string | null };

export function trialHref(to: { workspace?: string | null; project?: string | null; card?: string | null; tab?: string | null; from?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (to.workspace) q.set("ws", to.workspace);
  if (to.project) q.set("project", to.project);
  if (to.card) q.set("card", to.card);
  if (to.tab) q.set("tab", to.tab);
  const from = lineFrom(to.from);
  if (from) q.set("from", from);
  const s = q.toString();
  return s ? `/trial?${s}` : "/trial";
}

export function trialAddress(search: { get(key: string): string | null } | null | undefined): TrialAddress {
  return { ws: search?.get("ws") || null, project: search?.get("project") || null, card: search?.get("card") || null, from: lineFrom(search?.get("from")) };
}

/** A back address is only ever a /line page of this app: anything else (another origin, another route) is dropped. */
export function lineFrom(path: string | null | undefined): string | null {
  return path && /^\/line(?:[/?#]|$)/.test(path) ? path : null;
}

const LINE_VIEW_NAME: Record<string, string> = { foryou: "Decisions", inbox: "Decisions", problems: "Problems", runs: "Problems", timeline: "Problems", line: "Line", sources: "Line", process: "Line", graph: "Line", notebook: "Line", chat: "Line" };

/** The back link's words: the /line view it returns to, by the nav's own name (Decisions without a view). */
export function lineFromName(from: string): string {
  const view = new URLSearchParams(from.split("?")[1] ?? "").get("view");
  return (view && LINE_VIEW_NAME[view]) || "Decisions";
}

/** The `ws` an address names, when it is a workspace the viewer is in (their own, or a team they belong to); else
 *  null and the app's active workspace holds. A key for anything else grants nothing and reads nothing. */
export function ownWorkspace(ws: string | null, viewerId: string | null, teamIds: ReadonlyArray<string>): string | null {
  if (!ws) return null;
  if (ws.startsWith("user:")) return viewerId && ws === `user:${viewerId}` ? ws : null;
  if (ws.startsWith("team:")) return teamIds.includes(ws.slice(5)) ? ws : null;
  return null;
}
