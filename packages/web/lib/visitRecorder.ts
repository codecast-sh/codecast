// Every place that comes on screen enters the recents list (header menu,
// Ctrl+Tab, palette): the active tab's page and each pane of its split, the
// moment it appears. One observer of what is shown, rather than a record call
// in each navigation primitive, so no way of getting somewhere (a link, a tab
// switch, back/forward, a pane opened beside, a canonicalizing replace) can
// skip it.
import { useInboxStore, type RecentVisit } from "../store/inboxStore";
import { leavesOf } from "../store/stageSplit";
import { inboxTabSessionId, pathLabel } from "./pathLabel";
import { paneSessionId } from "./stage";
import { isNonTabRoute } from "./tabRoutes";

type Shown = { focused: string | null; paths: string[] };

/** What the active tab shows: every pane's path, and the focused one. */
export function shownPaths(st: { tabs: any[]; activeTabId: string | null }): Shown {
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  if (!tab) return { focused: null, paths: [] };
  const paths = tab.layout ? leavesOf(tab.layout).map((l) => l.path) : [tab.path];
  return { focused: tab.path ?? null, paths: paths.filter(Boolean) };
}

/** The visit a shown path stands for: a session (a pane's /conversation/<id>,
 *  the inbox's ?s=<id>), a page, or nothing for routes outside the shell. */
export function visitForPath(path: string): Omit<RecentVisit, "ts"> | null {
  const sid = paneSessionId(path) ?? inboxTabSessionId(path);
  if (sid) {
    const st = useInboxStore.getState();
    const title = st.sessions[sid]?.title ?? st.conversations[sid]?.title;
    return { kind: "session", key: sid, label: title || undefined };
  }
  const clean = path.split("#")[0];
  if (isNonTabRoute(clean)) return null;
  return { kind: "page", key: `page:${clean}`, path: clean, label: pathLabel(clean) };
}

/** Panes that appeared since `prev`, then the focused path when it changed,
 *  in the order to record them (the focused one lands on top). */
export function newlyShown(prev: Shown, next: Shown): string[] {
  const before = new Set(prev.paths);
  const out = next.paths.filter((p) => !before.has(p) && p !== next.focused);
  if (next.focused && next.focused !== prev.focused) out.push(next.focused);
  return out;
}

/** Start recording; returns the unsubscribe. The first pass records what is
 *  already on screen (a deep link or a restored tab is a visit too). */
export function startVisitRecorder(): () => void {
  let prev: Shown = { focused: null, paths: [] };
  const run = () => {
    const st = useInboxStore.getState();
    const next = shownPaths(st);
    const fresh = newlyShown(prev, next);
    prev = next;
    for (const path of fresh) {
      const visit = visitForPath(path);
      if (visit) st.recordRecentVisit(visit);
    }
  };
  run();
  let lastTabs = useInboxStore.getState().tabs;
  let lastActive = useInboxStore.getState().activeTabId;
  return useInboxStore.subscribe((st) => {
    if (st.tabs === lastTabs && st.activeTabId === lastActive) return;
    lastTabs = st.tabs;
    lastActive = st.activeTabId;
    run();
  });
}
