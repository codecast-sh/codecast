// New-session composers (ComposeView), hosted by ComposeHost. Every "New
// Session" affordance opens one. A composer is either the center MODAL (at most
// one, behind a backdrop, owns the keyboard) or DOCKED along the bottom edge
// (any number, non-modal, each collapsible to its title bar). Moving between
// the two is a change of `mode` on the same instance: the host keeps the same
// ComposeView mounted, so the deferred stub, the draft and the pickers carry
// over untouched.
//
// `initialQuery` pre-fills the composer (e.g. doc-review "New agent").
// `context` lets a caller seed the new session's project when there's no
// current conversation to inherit it from — doc review passes the doc's own
// project so the new agent spawns where the doc lives (without it ComposeView
// falls back to currentConversation/recents, which are empty on the docs page →
// a pathless start the daemon defaults to $HOME). `stubId` is the deferred
// session stub the mounted ComposeView reports back, so the slice can tell an
// empty composer from one holding a draft. Ephemeral UI state (raw set), like
// the palette toggle.
import type { DraftImageRow } from "../lib/draftImages";
import { flushDraftWrite } from "../lib/pendingDraftWrites";
import { isConvexId } from "../lib/entityLinks";

/** `agentType` starts the composer on that agent rather than the default
 *  (the empty inbox's "Ask the assistant" start). `linkedTask` binds the
 *  session it creates to that task, and `start` maps it to a priority's
 *  milestone and binds it to a plan (a compose link, hooks/useComposeLink). */
export type ComposeContext = {
  projectPath?: string;
  /** The machine the session starts on, stamped on the stub as a pick (the
   *  code editor's folder on a cloud host or another Mac runs there). */
  deviceId?: string;
  gitRoot?: string;
  agentType?: string;
  linkedTask?: { _id: string; short_id: string; title?: string; status?: string };
  start?: SessionStart;
};

/** What a new session is born linked to besides its task: createSession's
 *  own args, by short id, each checked by the server against the starter. */
export type SessionStart = { priority?: string; priority_step?: string; plan?: string };
export type ComposeInstance = {
  id: number;
  mode: "modal" | "dock";
  collapsed: boolean;
  initialQuery?: string;
  context?: ComposeContext;
  stubId?: string;
};

export type ComposeSliceState = {
  composes: ComposeInstance[];
  composeNonce: number;
  openCompose: (initialQuery?: string, context?: ComposeContext, opts?: { dock?: boolean }) => void;
  /** No id closes the modal. */
  closeCompose: (id?: number) => void;
  bindComposeStub: (id: number, stubId: string) => void;
  /** Modal → dock. No id docks the modal. */
  dockCompose: (id?: number) => void;
  /** Dock → modal; a modal already up trades places with it. */
  expandCompose: (id: number) => void;
  setComposeCollapsed: (id: number, collapsed: boolean) => void;
  /** The dock shortcut: minimize the modal when one is up, else open a docked composer. */
  toggleComposeDock: () => void;
};

/** A composer opened for a task (a compose link) is born bound to it: the
 *  create carries the stub's _linkedObject (createSessionFromStub), and the
 *  server links the session and makes it the task's owner in the same
 *  transaction, as the task list's start does. active_task is the new
 *  session's task badge (header, sidebar) from its first optimistic paint, as
 *  ContextChatInput sets it; the composer itself draws no task chip. */
export function bindComposeTask(
  store: { syncRecord: (field: string, id: string, record: any) => void },
  stubId: string,
  task: NonNullable<ComposeContext["linkedTask"]>,
): void {
  const activeTask = { _id: task._id, short_id: task.short_id, title: task.title, status: task.status };
  store.syncRecord("sessions", stubId, { _linkedObject: { type: "task", id: task._id }, active_task: activeTask });
  store.syncRecord("conversations", stubId, { active_task_id: task._id, active_task: activeTask });
}

/** A composer opened from a milestone's Start: the stub keeps what the create
 *  links (createSessionFromStub), so a heal that re-issues it links the same. */
export function bindComposeStart(
  store: { syncRecord: (field: string, id: string, record: any) => void },
  stubId: string,
  start: SessionStart,
): void {
  store.syncRecord("sessions", stubId, { _start: start });
}

/** The draft content held for a compose stub, or null when there is none worth
 *  keeping. MessageInput persists text and pasted images (blob previews
 *  included) into drafts[id] synchronously as they change. */
export function composeDraftContent(
  state: { drafts: Record<string, any> },
  id: string | null | undefined,
): { text: string; images: DraftImageRow[] } | null {
  if (!id) return null;
  const d = state.drafts[id];
  const text = typeof d?.draft_message === "string" ? d.draft_message.trim() : "";
  const images = Array.isArray(d?.draft_image_storage_ids) ? (d.draft_image_storage_ids as DraftImageRow[]) : [];
  return text || images.length > 0 ? { text, images } : null;
}

/** The newest kept compose draft no open composer holds: a local stub
 *  (never created on the server) flagged _hasDraft with content in it. An
 *  empty composer reopens onto it, so dismissing never loses what was typed. */
export function findKeptComposeDraft(state: {
  sessions: Record<string, any>;
  drafts: Record<string, any>;
  pendingSessionCreates: Record<string, unknown>;
  composes: ComposeInstance[];
}): string | null {
  const held = new Set(state.composes.map((c) => c.stubId).filter(Boolean));
  let best: { id: string; at: number } | null = null;
  for (const [id, row] of Object.entries(state.sessions)) {
    if (!row?._hasDraft || isConvexId(id) || held.has(id) || state.pendingSessionCreates[id]) continue;
    if (!composeDraftContent(state, id)) continue;
    const at = row.updated_at ?? row.started_at ?? 0;
    if (!best || at > best.at) best = { id, at };
  }
  return best?.id ?? null;
}

export function createComposeSlice(set: any, get: any): ComposeSliceState {
  const patch = (id: number, fields: Partial<ComposeInstance>) =>
    set({ composes: (get().composes as ComposeInstance[]).map((c) => (c.id === id ? { ...c, ...fields } : c)) });
  // A modal making way for another: one holding a draft steps down to the dock,
  // an empty one goes (its unmount abandons the empty stub).
  const displaceModal = (list: ComposeInstance[]): ComposeInstance[] =>
    list.flatMap((c) =>
      c.mode !== "modal" ? [c]
        : (flushDraftWrite(c.stubId), composeDraftContent(get(), c.stubId)) ? [{ ...c, mode: "dock" as const, collapsed: true }]
        : []);
  return {
    composes: [],
    composeNonce: 0,
    openCompose: (initialQuery, context, opts) => {
      const id = get().composeNonce + 1;
      const dock = !!opts?.dock;
      // Two open docks fit beside each other on a laptop; a third opening
      // folds the oldest open one to its title bar.
      const open = (get().composes as ComposeInstance[]).filter((c) => c.mode === "dock" && !c.collapsed);
      const fold = dock && open.length >= 2 ? open[0].id : null;
      const rest = dock
        ? (get().composes as ComposeInstance[]).map((c) => (c.id === fold ? { ...c, collapsed: true } : c))
        : displaceModal(get().composes);
      set({ composeNonce: id, composes: [...rest, { id, mode: dock ? "dock" : "modal", collapsed: false, initialQuery, context }] });
    },
    closeCompose: (id) =>
      set({ composes: (get().composes as ComposeInstance[]).filter((c) => (id == null ? c.mode !== "modal" : c.id !== id)) }),
    bindComposeStub: (id, stubId) => patch(id, { stubId }),
    dockCompose: (id) => {
      const target = (get().composes as ComposeInstance[]).find((c) => (id == null ? c.mode === "modal" : c.id === id));
      if (target) patch(target.id, { mode: "dock", collapsed: false });
    },
    expandCompose: (id) =>
      set({
        composes: displaceModal(get().composes).map((c) => (c.id === id ? { ...c, mode: "modal" as const, collapsed: false } : c)),
      }),
    setComposeCollapsed: (id, collapsed) => patch(id, { collapsed }),
    toggleComposeDock: () => {
      if ((get().composes as ComposeInstance[]).some((c) => c.mode === "modal")) get().dockCompose();
      else get().openCompose(undefined, undefined, { dock: true });
    },
  };
}
