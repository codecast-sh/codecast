// The Activity page's view, as the address holds it, so a view can be
// sent: which tab (the path), whose work (`filter`, the param the sidebar and
// the palette already use), how it groups, and the filters. Pure; the hook
// (useActivityView) reads and writes it.
import type { ActivityGroupBy } from "./activityModel";

export type ActivityTab = "activity" | "messages";
export type ActivityScope = "team" | "my";

export type ActivityView = {
  tab: ActivityTab;
  scope: ActivityScope;
  group: ActivityGroupBy;
  /** Actor ids (lib/liveEntities feedActorId). Empty: everyone. */
  people: string[];
  project: string | null;
  /** Only what waits on someone. */
  needs: boolean;
  /** A workspace directory the sidebar scoped the feed to. */
  dir: string | null;
};

export const ACTIVITY_TAB_PATH: Record<ActivityTab, string> = { activity: "/team/activity", messages: "/feed" };

/** Where each tab starts when the address does not say: the team's sessions,
 *  and the viewer's own messages (the team's message stream is a firehose). */
export function defaultScope(tab: ActivityTab, hasTeam: boolean): ActivityScope {
  return tab === "activity" && hasTeam ? "team" : "my";
}

export function parseActivityView(params: URLSearchParams | null | undefined, opts: { tab: ActivityTab; hasTeam: boolean; savedGroup?: string | null }): ActivityView {
  const get = (k: string) => params?.get(k) ?? null;
  const filter = get("filter");
  const scope: ActivityScope = !opts.hasTeam ? "my" : filter === "my" ? "my" : filter === "team" ? "team" : defaultScope(opts.tab, opts.hasTeam);
  const groupParam = get("group") ?? opts.savedGroup ?? null;
  return {
    tab: opts.tab,
    scope,
    group: groupParam === "project" ? "project" : "person",
    people: (get("people") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    project: get("project") || null,
    needs: get("needs") === "1",
    dir: get("dir") || null,
  };
}

/** The query string for a view: only what differs from where the tab starts. */
export function activityViewQuery(view: ActivityView, hasTeam: boolean): string {
  const q = new URLSearchParams();
  if (hasTeam && view.scope !== defaultScope(view.tab, hasTeam)) q.set("filter", view.scope);
  if (view.dir) q.set("dir", view.dir);
  if (view.tab === "activity") {
    if (view.group === "project") q.set("group", "project");
    if (view.people.length > 0) q.set("people", view.people.join(","));
    if (view.project) q.set("project", view.project);
    if (view.needs) q.set("needs", "1");
  }
  return q.toString();
}

export function activityViewHref(view: ActivityView, hasTeam: boolean): string {
  const qs = activityViewQuery(view, hasTeam);
  return qs ? `${ACTIVITY_TAB_PATH[view.tab]}?${qs}` : ACTIVITY_TAB_PATH[view.tab];
}

/** Press a face: add the person to the filter, or take them out. */
export function togglePerson(people: readonly string[], id: string): string[] {
  return people.includes(id) ? people.filter((p) => p !== id) : [...people, id];
}
