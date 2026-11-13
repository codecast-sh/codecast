"use client";

import { useLocation } from "react-router";
import { useChatUnread } from "../hooks/useChatSync";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { PANE_EMBED, appDocumentTitle } from "../lib/browserPane";
import { pathLabel } from "../lib/pathLabel";
import { tabTitle } from "../lib/tabTitle";
import { activeWorkspaceKey } from "../lib/workspaceScope";
import { useInboxStore } from "../store/inboxStore";
import { teamMembersOf } from "../lib/activeTeam";

// The window title's one writer, as a leaf: the title moves with every
// session switch and every mention, and that must not re-render the shell.
// A navigation inside a tab (tabNavigate) writes the browser history
// directly, and react-router's location does not hear it; the active tab's
// path wakes this, so the render sees the address the window shows.
export function WindowTitle() {
  const routerLocation = useLocation();
  useInboxStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.path);
  useWindowTitle(typeof window === "undefined" ? routerLocation.pathname + routerLocation.search : window.location.pathname + window.location.search);
  return null;
}

// The window's OS title: the surface, then the specific thing it shows,
// "Codecast Chat | design", "Codecast Inbox | Fix the auth race". Window
// switchers (Mission Control, the Window menu, AltTab) list windows by this
// title, so the main window and every popped out one name what they show.
// One writer for the whole title: a second writer re-asserting its own part
// on a timer is how the title used to flicker between two names.
//
// Unread mentions lead it. Only mentions: an unread COUNT turns every busy
// afternoon into a number that never reaches zero, and being named is the one
// thing worth interrupting a different app for.
function useWindowTitle(path: string) {
  const { mentions } = useChatUnread();
  const title = useInboxStore((s) => {
    const label = pathLabel(path);
    // An inbox window titles by the session it is SHOWING (the store pointer);
    // the URL's ?s= deep link is the fallback inside tabTitle.
    const inboxish = path.startsWith("/inbox") || path.startsWith("/conversation");
    const sessionId = inboxish ? s.currentSessionId ?? undefined : undefined;
    // The same arguments the tab strip passes, so a tab and its window name a
    // goal, role, project or person the same way.
    const rest = tabTitle({ id: "window", path, sessionId, title: "", createdAt: 0 }, s.sessions, s.chatChannels, teamMembersOf(s), s.currentUser?._id, s.initiatives, activeWorkspaceKey(s.clientState.ui?.active_team_id, s.currentUser?._id), s);
    // An object on the Org screen sits on the Org surface once its name is
    // known ("Codecast Org | Win the private network"); its kind and handle
    // ("Goal in-1") stand in only until the store holds the row.
    const surface = path.startsWith("/org/") && rest !== label ? "Org" : label;
    return appDocumentTitle(surface, rest, PANE_EMBED);
  });
  useWatchEffect(() => {
    const lead = PANE_EMBED ? 0 : mentions;
    const next = lead > 0 ? `(${lead}) ${title}` : title;
    if (document.title !== next) document.title = next;
  }, [title, mentions]);
}
