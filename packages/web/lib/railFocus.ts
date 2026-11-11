// The rail's More group (components/sidebar/SidebarNav.tsx).
//
// Six daily surfaces lead the rail for everyone: Inbox, Decisions, Chat,
// Tasks, Docs and Calls. Every other page sits under More, folded until the
// person opens it; the choice is kept in client_state.ui.rail_everything.
// Only the rail narrows: every page stays reachable from More, search, the
// palette and links, so nothing here redirects or hides a page.
//
// Imports nothing: the marketing hero draws the rail too.

/** Whether More is folded now: until the person opens it (rail_everything). */
export function railFolded(everything: boolean | undefined): boolean {
  return everything !== true;
}
