# Workspace slots — one layout system instead of N region implementations

## The problem, stated structurally

The layout is a stack of independently-declared two-pane `Group`s, each owned by
a different component:

```
Group [sidebar | main]                          DashboardLayout
  └ Group [right-content | session-list]         DashboardLayout
      └ Group [stage-page | stage-companion]     DashboardLayout
          └ Group [detail-list | detail-content] DetailSplitLayout
```

…plus further Groups inside the vault, the diff layouts, and the file tree.

No layer can see the whole arrangement. A full survey of the package found
**21 regions, 8 resizable Groups and 15 Panels**, and the same concerns
re-implemented region by region:

- **4 collapse idioms** for one intent: imperative `panelRef.collapse()` plus a
  CSS animation (sidebar), imperative collapse/expand (session rail), CSS
  translate with a `mounted` unmount lag (EdgePeek and CommentDock each run
  their own timer, 250ms and 240ms), inline `style={{width: open ? 320 : 0}}`
  (shortcuts panel), a `hidden` class (terminal), and plain conditional render
  (companion, diff, vault side).
- **3 drag-resize implementations**: react-resizable-panels, CommentDock's own
  mouse drag, TerminalPanel's own pointer drag — the latter two each hand-roll
  the same `document.body.style.cursor/userSelect` save and restore.
- **3 persistence backends** for "is this region open": `clientState.ui`, bare
  IDB meta keys, and raw `localStorage`.
- **9+ near-identical ✕ buttons** with no shared component. The session rail has
  **two** different closers for one panel.
- `SessionListPanel` and `Sidebar` are each mounted **three times** (split, hover
  peek, mobile drawer) with identical props; the two mobile drawers are
  copy-pasted backdrop markup.
- `InboxConversation` is **defined twice**, in GlobalSessionPanel and again in
  QueuePageClient with a different prop set.
- Only **2 of ~10** collapsible regions have a hover-peek path.

The drift this produces is already visible as dead and lying state:
`ClientLayouts.inbox` has no reader or writer; `closeCommentRail` has no
callers; `commentRailOpen`'s documented `null = auto` behavior was never
implemented; `pinned_surfaces["plans"]` is unreachable because the plans page
hard-codes a `w-[300px]` column instead of using `DetailSplitLayout`;
`TaskDetailContent variant="inline"` is unreachable; the file-tree tooltip
advertises key `b` while the registry binds `f`; the terminal's default height
is declared twice in two files.

Per region, the five concerns each get their own implementation:

| concern | sidebar | session rail | companion | list/detail | comment rail | terminal |
|---|---|---|---|---|---|---|
| open/closed flag | `ui.sidebar_collapsed` | `sidePanelOpen` + `sidePanelUserClosed` | `companionSessionId` | `ui.pinned_surfaces[surface]` | `commentRailOpen` | its own |
| sticky dismissal | — | `sidePanelUserClosed` | `companionDismissedFor` | — | — | — |
| size persistence | `layouts.dashboard` | `layouts.dashboard`/none | none | Group default | none | its own |
| collapse mechanism | imperative `panelRef.collapse()` + CSS anim | imperative `panelRef` effect | conditional render | conditional render | conditional render | conditional render |
| close affordance | header button | rail ✕ (added by hand) | companion ✕ (added by hand) | detail ✕ (via context) | its own | its own |

Every new region re-implements all five, slightly differently. That is why:

- the cap ("no more than two things beside each other") has to be re-enforced
  by hand in each place, and was missed in the version that produced the
  five column pileup;
- a "standard ✕ on every column" is a chore of adding buttons rather than a
  property of the system;
- the conversation-beside-a-page behavior has now been built three times
  (`ConversationColumn` → rail tab → `StageCompanion`), each time converging on
  roughly the same rule via a different mechanism;
- fixing one region's rule (a dismissal, an Esc handler, a hover peek) leaves
  the others inconsistent.

## The model

A **workspace** is a fixed, small set of **slots**. Each slot holds **at most one
pane**. The cap is structural — there is nowhere to put a third pane — rather
than a policy some code path has to remember.

```ts
type SlotId = "nav" | "list" | "primary" | "secondary" | "context" | "dock";

type Pane =
  | { kind: "nav" }
  | { kind: "page" }                          // whatever the route renders
  | { kind: "conversation"; id: string }
  | { kind: "sessionList" }
  | { kind: "comments"; conversationId: string }
  | { kind: "docDetail"; id: string }
  | { kind: "taskDetail"; id: string }
  | { kind: "diff" }
  | { kind: "terminal" };

type Slot = {
  pane: Pane | null;
  /** split = a real resizable column · overlay = peek over its neighbour · collapsed = thin edge */
  presentation: "split" | "overlay" | "collapsed";
  /** persisted per slot through the existing layouts bag */
  size?: number;
  /** the generalized sticky dismissal: what the user closed by hand, here */
  userClosed?: Pane | null;
};
```

`primary` is always occupied (it is the route's content). Everything else is
optional and swappable.

## One set of operations

```ts
show(slot, pane)            // replaces whatever was there — this IS the cap
hide(slot, { remember })    // remember:true records userClosed (the ✕)
toggle(slot, pane?)
promote(slot)               // move this slot's pane into `primary`
setPresentation(slot, p)    // peek ⇄ pin ⇄ collapsed
resize(slot, size)
```

Everything the app currently does becomes a call to one of these:

| today | becomes |
|---|---|
| pin a doc detail | `setPresentation("secondary", "split")` |
| unpin (peek) | `setPresentation("secondary", "overlay")` |
| open a session beside a task | `show("secondary", { kind: "conversation", id })` |
| close the companion | `hide("secondary", { remember: true })` |
| collapse the sidebar | `setPresentation("nav", "collapsed")` |
| toggle the session rail | `toggle("context", { kind: "sessionList" })` |
| comment rail | `show("context", { kind: "comments", conversationId })` |
| toggle the terminal | `toggle("dock", { kind: "terminal" })` |
| ⤢ on a companion | `promote("secondary")` |

Note the comment rail and the session list now *share* the `context` slot, so
they can no longer both occupy the right edge — a real bug class removed by the
shape of the model rather than by a new conditional.

## One renderer

`<WorkspaceStage>` lays the slots out in a single flat `Group` (nav | list |
primary | secondary | context) with the dock beneath, and `<Slot>` renders one
slot with the standard chrome every column should have had all along:

- title
- ⤢ promote (when the pane can occupy `primary`)
- ✕ close
- the resize handle and persisted size
- overlay vs split presentation, including the slide-in animation
- collapsed → thin hover-peek edge (today's `EdgePeek`, generalized)

Because the chrome lives in `<Slot>`, "every column closes the same way" is
true by construction. Escape closes the topmost `overlay` slot — one handler,
not one per component.

## What this deletes

- `companionSessionId`, `companionDismissedFor`, and the mirror effect
- `sidePanelOpen`, `sidePanelUserClosed` (become `context` slot state)
- `ui.pinned_surfaces` (becomes `secondary.presentation`)
- the two imperative `panelRef.collapse()/expand()` effects and their
  animation bookkeeping
- the per-component ✕ buttons and Esc handlers
- three nested `Group`s in `DashboardLayout`, and the nesting in
  `DetailSplitLayout`

## Status — landed 2026-08-08 (plan pl-285)

All shell regions now run on the slot model. What is live:

| region | slot | replaces |
|---|---|---|
| left sidebar | `nav` (presentation) | `ui.sidebar_collapsed` scattered writes → `setNavCollapsed` |
| task/doc list + detail | `primary` (presentation) | `ui.pinned_surfaces[surface]` — one arrangement, not per surface |
| conversation companion | `secondary` | `companionSessionId` + `companionDismissedFor` + mirror effect |
| session list | `context` | `sidePanelOpen` + `sidePanelUserClosed` |
| comment rail | `context` (shares the edge) | `commentRailOpen` |
| terminal | `dock` | shell toggle; `panelPrefs` stays the persistence owner |

Deleted outright: `sidePanelOpen`, `sidePanelUserClosed`, `commentRailOpen`,
`companionSessionId`, `companionDismissedFor`, `pinned_surfaces`, and two dead
`CLIENT_SYNC_REGISTRY` entries. Per-tab state now snapshots one arrangement
instead of a flag per region. The arrangement persists through
`ui.workspace` (in `CRITICAL_UI_KEYS`, so the shell paints the right layout on
first frame); subject-bearing panes are deliberately not persisted.

**Device-local is now data, not an exception** (`SLOT_PERSISTENCE`). Each slot
declares `"shared"` or `"device"`; the dock is `"device"`, so the terminal's
arrangement never leaves this browser profile — the property that used to
justify a private localStorage store is expressed IN the model. `panelPrefs.ts`
is reduced to a single height constant; `TerminalPanel`/`TerminalDock` read the
dock slot for both open state and height, inheriting the legacy
`cast_term_panel` key once on first boot. A shared arrangement synced from
another device cannot switch a terminal on here (tested).

**Shared chrome is adopted**, not merely available: the session rail (whose two
separate closers collapsed into one), the comment rail, the doc detail, and the
companion all render `SlotChrome`. Panes that close by navigating pass an
`onClose` override, so the affordance is identical either way.

**Plans joined the list surfaces.** Its hand-rolled `w-[300px]` column is gone;
it uses `DetailSplitLayout` like docs and tasks, which is also what made the
previously unreachable plans pin state reachable.

**Still hand-rolled** (page-local rails, each a candidate for a generic
`pageRail` pane in the `context` slot): workflows' `w-72` run panel and `w-52`
rail, tasks' `w-44` hidden-columns rail, crosstalk's split, ReviewView's
`w-64`, the vault's three panes, and the message-level comment rails.

## Migration (incremental, behavior-preserving)

1. **Model** — `store/workspace.ts`: slot state, operations, selectors. No UI
   change; nothing consumes it yet.
2. **Renderer** — `components/workspace/{WorkspaceStage,Slot}.tsx`, rendering
   the same visual result from slot state.
3. **Migrate region by region**, each a self-contained change that keeps the
   current look: `context` (session list + comment rail) → `secondary`
   (detail peek/pin + conversation companion, which unify) → `nav` → `dock`.
4. **Delete** the one-off flags and effects as each region lands.
5. **Route → slots**: a small map from the current route to the default slot
   assignment, so "what the screen shows" is derived rather than accumulated.

Simple view stays orthogonal: it is styling (`.simple-view` + `data-sv-*`
hooks) and does not participate in slot state.
