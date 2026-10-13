// Where a trial lives: /trial opened on one trial project, in the workspace that
// project lives in (`ws`, a workspace key), so a Trial tag on a team's decision
// lands on that trial even while the app sits on Personal. `card` opens one
// card; `tab` opens one list (Failed, Stopped, ...). TrialReviewPage reads these back (trialAddress).
export type TrialAddress = { ws: string | null; project: string | null; card: string | null };

export function trialHref(to: { workspace?: string | null; project?: string | null; card?: string | null; tab?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (to.workspace) q.set("ws", to.workspace);
  if (to.project) q.set("project", to.project);
  if (to.card) q.set("card", to.card);
  if (to.tab) q.set("tab", to.tab);
  const s = q.toString();
  return s ? `/trial?${s}` : "/trial";
}

export function trialAddress(search: { get(key: string): string | null } | null | undefined): TrialAddress {
  return { ws: search?.get("ws") || null, project: search?.get("project") || null, card: search?.get("card") || null };
}

/** The `ws` an address names, when it is a workspace the viewer is in (their own, or a team they belong to); else
 *  null and the app's active workspace holds. A key for anything else grants nothing and reads nothing. */
export function ownWorkspace(ws: string | null, viewerId: string | null, teamIds: ReadonlyArray<string>): string | null {
  if (!ws) return null;
  if (ws.startsWith("user:")) return viewerId && ws === `user:${viewerId}` ? ws : null;
  if (ws.startsWith("team:")) return teamIds.includes(ws.slice(5)) ? ws : null;
  return null;
}
