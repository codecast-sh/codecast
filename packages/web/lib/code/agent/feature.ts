// The agent integration inside the editor chunk: the marks extension, the
// Cmd-L / Cmd-K keys, the status bar chip's host, and the commands
// (agent.quoteSelection, agent.inlineInstruction, agent.newSession,
// agent.nextEdit / prevEdit, agent.pickSession, agent.dismissEdits).
// Registered once from the editor core (editorHost.registerCoreFeatures).
//
// The linked session is resolved by AgentLayer (components/code/agent), which
// the Files workspace mounts; these commands read its answer from agentStore.

import { Prec, type EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { useInboxStore, sessionWorkState, type InboxSession } from "../../../store/inboxStore";
import { useCodeStore } from "../../../store/codeStore";
import { codeBuffers, currentState, updateBuffer } from "../buffers";
import { registerCodeCommands, type CodeCommandContext } from "../commands";
import { featureContext, registerEditorFeature, registerStatusItem, type StatusItemView } from "../features";
import { useAgentStore, joinRoot } from "./agentStore";
import { codeQuoteComment, fenceLang, newSessionText, type CodeRange } from "./compose";
import {
  QUOTE_FLASH_MS,
  addFlash,
  addSentMark,
  agentMarks,
  agentMarksExtension,
  clearSentMarks,
  dismissAgentEdits,
  hasAgentMarks,
  setAgentMarkHooks,
  setInlineSpot,
  stepAgentEdit,
} from "./editorMarks";
import { sessionRow, vaultRootOf, writerNow } from "./live";
import { sessionColor, sessionShortTitle, UNKNOWN_WRITER_COLOR } from "./sessions";

const FEATURE = "agent";
/** Lines of context kept around a quoted range for its comment anchor. */
const ANCHOR_CONTEXT = 3;

// ── the range ──────────────────────────────────────────────────────────────

/** The selection, or the cursor's line when it is empty, as whole lines. */
export function selectedRange(view: EditorView, root: string): CodeRange | null {
  const ctx = view.state.facet(featureContext);
  if (!ctx) return null;
  const { doc, selection } = view.state;
  const sel = selection.main;
  const first = doc.lineAt(sel.from);
  // A selection ending at the start of a line (a linewise drag) stops above it.
  const last = doc.lineAt(sel.to > sel.from && doc.lineAt(sel.to).from === sel.to ? sel.to - 1 : sel.to);
  const code = sel.empty ? first.text : doc.sliceString(sel.from, sel.to);
  const from = Math.max(1, first.number - ANCHOR_CONTEXT);
  const to = Math.min(doc.lines, last.number + ANCHOR_CONTEXT);
  const lines: string[] = [];
  for (let n = from; n <= to; n++) lines.push(doc.line(n).text);
  return {
    absPath: joinRoot(root, ctx.path),
    startLine: first.number,
    endLine: Math.max(first.number, last.number),
    code,
    lang: fenceLang(ctx.path),
    context: { linesFrom: from, lines },
  };
}

function lineBounds(view: EditorView, r: CodeRange) {
  const doc = view.state.doc;
  return { from: doc.line(Math.min(r.startLine, doc.lines)).from, to: doc.line(Math.min(r.endLine, doc.lines)).to };
}

/** Leave vim's visual mode after acting on its selection. */
function leaveVisual(view: EditorView): void {
  if (!view.scrollDOM.classList.contains("cm-vimMode")) return;
  void import("@replit/codemirror-vim").then(({ getCM, Vim }) => {
    const cm = getCM(view);
    if (cm?.state.vim?.visualMode) Vim.exitVisualMode(cm as never);
  });
}

// ── the link ───────────────────────────────────────────────────────────────

let lastView: EditorView | null = null;

function viewFor(ctx: CodeCommandContext): EditorView | null {
  const v = ctx.view ?? (lastView?.dom.isConnected ? lastView : null);
  return v && hasAgentMarks(v.state) ? v : null;
}

const vaultOf = (view: EditorView) => view.state.facet(featureContext)?.vaultId ?? null;

/** The folder's linked session, read once: the inline box pins it. */
function linkedOf(view: EditorView): string | null {
  const vaultId = vaultOf(view);
  return vaultId ? (useAgentStore.getState().links[vaultId]?.sessionId ?? null) : null;
}

/** Where the picker hangs for this editor: its status chip. */
function chipAnchor(view: EditorView, vaultId: string) {
  const chip = useAgentStore.getState().chips.find((c) => c.vaultId === vaultId && c.el.isConnected && view.dom.closest("[data-code-group]")?.contains(c.el));
  const rect = chip?.el.getBoundingClientRect();
  return rect ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null;
}

/** Quote to the linked session; with none, the picker asks first. */
function quoteToLinked(view: EditorView): boolean {
  const vaultId = vaultOf(view);
  if (!vaultId) return false;
  const st = useAgentStore.getState();
  const linked = st.links[vaultId]?.sessionId;
  const act = (id: string) => quoteSelection(view, id);
  if (linked) {
    act(linked);
    return true;
  }
  st.openPicker({ vaultId, anchor: chipAnchor(view, vaultId), then: act, action: "quote", newSession: () => newSession(view) });
  return true;
}

// ── verbs ──────────────────────────────────────────────────────────────────

export function quoteSelection(view: EditorView, sessionId: string): boolean {
  const vaultId = vaultOf(view);
  const root = vaultId ? vaultRootOf(vaultId) : null;
  const range = root ? selectedRange(view, root) : null;
  if (!range) return false;
  useInboxStore.getState().addReviewComment(sessionId, codeQuoteComment(range));
  const { from, to } = lineBounds(view, range);
  view.dispatch({ effects: addFlash.of({ from, to, color: sessionColor(sessionRow(sessionId) ?? sessionId), kind: "quote", until: Date.now() + QUOTE_FLASH_MS }) });
  leaveVisual(view);
  return true;
}

/** The editor state holding an inline spot, and how to update it: the view
 *  the box opened in while it still shows that buffer, else the buffer that
 *  holds the spot now (switched away, or shown in another split). */
function spotHolder(view: EditorView, id: number): { state: EditorState; apply(spec: TransactionSpec): void } | null {
  if (agentMarks(view.state).inline?.id === id) return { state: view.state, apply: (spec) => view.dispatch(spec) };
  for (const b of codeBuffers.all()) {
    const state = currentState(b);
    if (agentMarks(state).inline?.id === id) return { state, apply: (spec) => updateBuffer(b, spec) };
  }
  return null;
}

/** Open the inline instruction box under the range, aimed at `sessionId`
 *  (null: the box asks on Enter). */
export function openInlineInstruction(view: EditorView, sessionId: string | null = null): boolean {
  const vaultId = vaultOf(view);
  const root = vaultId ? vaultRootOf(vaultId) : null;
  const range = root ? selectedRange(view, root) : null;
  if (!vaultId || !range) return false;
  const { from, to } = lineBounds(view, range);
  const id = useAgentStore.getState().openInline({
    vaultId,
    sessionId,
    range,
    onSent: (target, clientId) => {
      const holder = spotHolder(view, id);
      if (!holder) return;
      // The spot's range has mapped through every edit since the box opened
      // (an agent edit above it, the person's typing).
      const spot = agentMarks(holder.state).inline!;
      const row = sessionRow(target);
      const mark = { from: spot.from, to: spot.to, key: clientId, sessionId: target, color: sessionColor(row ?? target), label: sessionShortTitle(row) };
      holder.apply({ effects: [setInlineSpot.of(null), addSentMark.of(mark)] });
      watchTurn(target, clientId);
      if (holder.state === view.state) view.focus();
    },
    onClose: () => {
      const holder = spotHolder(view, id);
      holder?.apply({ effects: setInlineSpot.of(null) });
      if (holder?.state === view.state) view.focus();
    },
  });
  view.dispatch({ effects: setInlineSpot.of({ id, pos: to, from, to }) });
  leaveVisual(view);
  return true;
}

export function newSession(view: EditorView): boolean {
  const vaultId = vaultOf(view);
  const root = vaultId ? vaultRootOf(vaultId) : null;
  const range = root ? selectedRange(view, root) : null;
  if (!root || !range) return false;
  useInboxStore.getState().openCompose(newSessionText(range), { projectPath: root });
  leaveVisual(view);
  return true;
}

// ── the sent marker ends with the turn that read it ────────────────────────
//
// Keyed by the sent message's client id, not the session: a session already
// mid-turn reads a queued instruction only later, and two instructions to one
// session each keep their own marker. The message has reached the agent once
// its echo is in the transcript (or the store retired its pending bubble,
// which it does on the echo); the marker ends when the session next stops
// working after that.

interface SentWatch {
  sessionId: string;
  since: number;
  deliveredAt: number | null;
  seenWorking: boolean;
}

/** A send never delivered (offline, refused) stops being watched after this. */
const UNDELIVERED_MS = 30 * 60_000;
/** A turn so short no working state was seen still ends the marker. */
const QUICK_TURN_MS = 60_000;

const watched = new Map<string, SentWatch>();
let unwatch: (() => void) | null = null;

function clearSentEverywhere(clientId: string): void {
  for (const b of codeBuffers.all()) {
    if (agentMarks(currentState(b)).sent.some((s) => s.key === clientId)) updateBuffer(b, { effects: clearSentMarks.of(clientId) });
  }
}

type InboxState = ReturnType<typeof useInboxStore.getState>;

/** The agent has the message: its echo is in the transcript, or its pending
 *  bubble is gone (retired on the echo). */
export function sentDelivered(s: Pick<InboxState, "messages" | "pendingMessages">, sessionId: string, clientId: string): boolean {
  if ((s.messages[sessionId] ?? []).some((m) => m.client_id === clientId && !m._isOptimistic && !m._isQueued)) return true;
  return !(s.pendingMessages[sessionId] ?? []).some((m) => m._clientId === clientId || m._id === clientId);
}

/** One pass over the watched sends. Exported for tests. */
export function checkSentTurns(s: InboxState = useInboxStore.getState(), now = Date.now()): void {
  for (const [clientId, w] of watched) {
    // A session created a moment ago may have been re-keyed to its real id.
    const sid = s.resolveLiveSessionId?.(w.sessionId) ?? w.sessionId;
    if (w.deliveredAt === null) {
      if (sentDelivered(s, sid, clientId)) w.deliveredAt = now;
      else {
        if (now - w.since > UNDELIVERED_MS) {
          watched.delete(clientId);
          clearSentEverywhere(clientId);
        }
        continue;
      }
    }
    const row = s.sessions[sid] as InboxSession | undefined;
    const working = !!row && sessionWorkState(row, now) === "working";
    if (working) w.seenWorking = true;
    else if (w.seenWorking || now - w.deliveredAt > QUICK_TURN_MS) {
      watched.delete(clientId);
      clearSentEverywhere(clientId);
    }
  }
  if (!watched.size) {
    unwatch?.();
    unwatch = null;
  }
}

export function watchTurn(sessionId: string, clientId: string, now = Date.now()): void {
  watched.set(clientId, { sessionId, since: now, deliveredAt: null, seenWorking: false });
  if (unwatch) return;
  unwatch = useInboxStore.subscribe((s, prev) => {
    if (s.sessions === prev.sessions && s.messages === prev.messages && s.pendingMessages === prev.pendingMessages) return;
    checkSentTurns(s);
  });
}

// ── status bar chip ────────────────────────────────────────────────────────

function chipItem(view: EditorView): StatusItemView | null {
  const dom = document.createElement("span");
  dom.className = "cm-agent-chip";
  dom.style.display = "inline-flex";
  let vaultId = vaultOf(view);
  const start = () => newSession(view);
  if (vaultId) useAgentStore.getState().addChip(dom, vaultId, start);
  return {
    dom,
    update(u: ViewUpdate) {
      const next = u.state.facet(featureContext)?.vaultId ?? null;
      if (next === vaultId) return;
      useAgentStore.getState().removeChip(dom);
      vaultId = next;
      if (vaultId) useAgentStore.getState().addChip(dom, vaultId, start);
    },
    destroy: () => useAgentStore.getState().removeChip(dom),
  };
}

// ── a disk change waiting on unsaved edits: who wrote it ──────────────────

function watchConflicts(): void {
  useCodeStore.subscribe((s, prev) => {
    if (s.conflicts === prev.conflicts) return;
    const agent = useAgentStore.getState();
    for (const key of new Set([...Object.keys(s.conflicts), ...Object.keys(prev.conflicts)])) {
      const now = s.conflicts[key];
      const before = prev.conflicts[key];
      if (now === before) continue;
      if (!now) agent.setConflictWriter(key, null);
      else if (now.kind === "stale" && before?.kind !== "stale" && before?.kind !== "merge") {
        const [vaultId, path] = key.split("\u0000");
        agent.setConflictWriter(key, writerNow(vaultId, path));
      }
    }
  });
}

// ── registration ───────────────────────────────────────────────────────────

/** Cmd-L and Cmd-K. Exported for mount tests. */
export const agentKeys = Prec.high(
  keymap.of([
    { key: "Mod-l", preventDefault: true, run: quoteToLinked },
    { key: "Mod-k", preventDefault: true, run: (v) => openInlineInstruction(v, linkedOf(v)) },
  ]),
);

const tracker = EditorView.domEventHandlers({
  focus: (_e, view) => {
    lastView = view;
    return false;
  },
});

let registered = false;

export function registerAgentFeature(): void {
  if (registered) return;
  registered = true;
  setAgentMarkHooks({
    writerOf: (vaultId, path) => writerNow(vaultId, path),
    colorOf: (id) => (id ? sessionColor(sessionRow(id) ?? id) : UNKNOWN_WRITER_COLOR),
    labelOf: (id) => (id ? sessionShortTitle(sessionRow(id)) : "an agent (session unknown)"),
    mountInline: (id, host) => useAgentStore.getState().setInlineHost(id, host),
  });
  registerEditorFeature(FEATURE, () => [agentMarksExtension(), agentKeys, tracker], { needsVault: true });
  registerStatusItem({ id: "agent.link", side: "right", order: 5, priority: 60, needsVault: true, create: chipItem });
  watchConflicts();

  const withView = (fn: (view: EditorView, args: Record<string, unknown> | undefined) => boolean) => (args: Record<string, unknown> | undefined, ctx: CodeCommandContext) => {
    const view = viewFor(ctx);
    if (view) lastView = view;
    return view ? fn(view, args) : false;
  };
  registerCodeCommands({
    "agent.quoteSelection": withView(quoteToLinked),
    "agent.inlineInstruction": withView((v) => openInlineInstruction(v, linkedOf(v))),
    "agent.newSession": withView((v) => newSession(v)),
    "agent.nextEdit": withView((v) => stepAgentEdit(v, 1)),
    "agent.prevEdit": withView((v) => stepAgentEdit(v, -1)),
    "agent.dismissEdits": withView((v) => {
      if (!agentMarks(v.state).edits.length) return false;
      v.dispatch({ effects: dismissAgentEdits.of("all") });
      return true;
    }),
    "agent.pickSession": withView((v) => {
      const vaultId = vaultOf(v);
      if (!vaultId) return false;
      useAgentStore.getState().openPicker({ vaultId, anchor: chipAnchor(v, vaultId), newSession: () => newSession(v) });
      return true;
    }),
  });
}
