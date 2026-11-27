// The agent integration inside the editor chunk: the marks extension, the
// Cmd-L / Cmd-K keys, the status bar chip's host, and the commands
// (agent.quoteSelection, agent.inlineInstruction, agent.newSession,
// agent.nextEdit / prevEdit, agent.pickSession, agent.dismissEdits), and the
// edits status item (how many agent edits the buffer holds, in the writer's
// color: a press steps to the next, its × clears them).
// Registered once from the editor core (editorHost.registerCoreFeatures).
//
// The linked session is resolved by AgentLayer (components/code/agent), which
// the Files workspace mounts; these commands read its answer from agentStore.

import { EditorSelection, Prec, type EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { useInboxStore, sessionWorkState, type InboxSession } from "../../../store/inboxStore";
import { useCodeStore } from "../../../store/codeStore";
import { codeBuffers, currentState, updateBuffer } from "../buffers";
import { registerCodeCommands, type CodeCommandContext } from "../commands";
import { featureContext, focusedEditorView, nameStatusItem, registerEditorFeature, registerStatusItem, type StatusItemView } from "../features";
import { inlineDraft, useAgentStore, joinRoot } from "./agentStore";
import { codeQuoteComment, fenceLang, newSessionText, sendInstruction, type CodeRange } from "./compose";
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
  setSentState,
  stepAgentEdit,
  type SentMark,
} from "./editorMarks";
import { composeInVault, sessionRow, vaultRootOf, writerNow } from "./live";
import { blameSessionBases, sessionColor, sessionGitRefs, sessionShortTitle, UNKNOWN_WRITER_COLOR } from "./sessions";
import { addGitDiffTargets, type GitDiffTarget } from "../git";
import { blameHunksOf } from "../blame";
import { useDiffViewerStore } from "../../../store/diffViewerStore";

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

/** Leave vim's visual mode after acting on its selection. An ex command
 *  (`:'<,'>Ask`) has left visual mode already, but its range is still the
 *  editor's selection: normal mode gets a cursor on the range's first line. */
function leaveVisual(view: EditorView): void {
  if (!view.scrollDOM.classList.contains("cm-vimMode")) return;
  void import("@replit/codemirror-vim").then(({ getCM, Vim }) => {
    const cm = getCM(view);
    if (cm?.state.vim?.visualMode) Vim.exitVisualMode(cm as never);
    else if (cm?.state.vim && !view.state.selection.main.empty) {
      const line = view.state.doc.lineAt(view.state.selection.main.from);
      view.dispatch({ selection: EditorSelection.cursor(line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0)) });
    }
  });
}

// ── the link ───────────────────────────────────────────────────────────────

function viewFor(ctx: CodeCommandContext): EditorView | null {
  const v = ctx.view ?? focusedEditorView();
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
 *  (null: the box asks on Enter), with `text` already typed (`:Ask fix this`). */
export function openInlineInstruction(view: EditorView, sessionId: string | null = null, text = ""): boolean {
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
      holder.apply({ effects: [setInlineSpot.of(null), addSentMark.of(sentMark(spot, target, clientId))] });
      watchTurn(target, clientId);
      if (holder.state === view.state) view.focus();
    },
    onClose: () => {
      const holder = spotHolder(view, id);
      holder?.apply({ effects: setInlineSpot.of(null) });
      if (holder?.state === view.state) view.focus();
    },
  });
  if (text) inlineDraft(id).text = text;
  view.dispatch({ effects: setInlineSpot.of({ id, pos: to, from, to }) });
  leaveVisual(view);
  return true;
}

/** The marker for a range sent to `target` as message `clientId`. */
function sentMark(range: { from: number; to: number }, target: string, clientId: string): SentMark {
  const row = sessionRow(target);
  return { from: range.from, to: range.to, key: clientId, sessionId: target, color: sessionColor(row ?? target), label: sessionShortTitle(row), state: "queued" };
}

/** Send `text` about the range to `sessionId` now, with no box: `:Ask fix
 *  this` typed whole on the command line. The marker and its turn watch are
 *  the box's own (sentMark, watchTurn). */
export function askNow(view: EditorView, sessionId: string, text: string): boolean {
  const vaultId = vaultOf(view);
  const root = vaultId ? vaultRootOf(vaultId) : null;
  const range = root ? selectedRange(view, root) : null;
  if (!range) return false;
  const clientId = sendInstruction(useInboxStore.getState(), sessionId, range, text);
  if (!clientId) return false;
  view.dispatch({ effects: addSentMark.of(sentMark(lineBounds(view, range), sessionId, clientId)) });
  watchTurn(sessionId, clientId);
  leaveVisual(view);
  return true;
}

export function newSession(view: EditorView): boolean {
  const vaultId = vaultOf(view);
  const root = vaultId ? vaultRootOf(vaultId) : null;
  const range = root ? selectedRange(view, root) : null;
  if (!vaultId || !range || !composeInVault(vaultId, newSessionText(range))) return false;
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

/** Apply an effect to every buffer holding the sent message's marker. */
function forSentMark(clientId: string, effect: () => TransactionSpec["effects"]): void {
  for (const b of codeBuffers.all()) {
    if (agentMarks(currentState(b)).sent.some((s) => s.key === clientId)) updateBuffer(b, { effects: effect() });
  }
}

const clearSentEverywhere = (clientId: string) => forSentMark(clientId, () => clearSentMarks.of(clientId));

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
    if (working) {
      if (!w.seenWorking) forSentMark(clientId, () => setSentState.of({ key: clientId, state: "working" }));
      w.seenWorking = true;
    } else if (w.seenWorking || now - w.deliveredAt > QUICK_TURN_MS) {
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

// ── agent edits status item ───────────────────────────────────────────────

/** How many agent edits the buffer holds, as a bar in the latest writer's
 *  color and a count. A press steps to the next; × clears them all. Hidden
 *  while there are none. Rewritten only when the count or color changes, so
 *  typing (which maps the edits) writes nothing. */
export function editsItem(view: EditorView): StatusItemView | null {
  const dom = document.createElement("span");
  dom.className = "cm-agent-edits";
  dom.hidden = true;
  const next = document.createElement("button");
  next.type = "button";
  next.className = "cm-agent-editsNext";
  const bar = document.createElement("span");
  bar.className = "cm-agent-editsBar";
  const count = document.createTextNode("0");
  next.append(bar, count);
  next.onclick = () => {
    stepAgentEdit(view, 1);
    view.focus();
  };
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "cm-agent-editsClear";
  clear.title = "Clear agent edits";
  clear.setAttribute("aria-label", "Clear agent edits");
  clear.textContent = "×";
  clear.onclick = () => {
    view.dispatch({ effects: dismissAgentEdits.of("all") });
    view.focus();
  };
  dom.append(next, clear);
  let shown = "";
  const render = (state: EditorState) => {
    const { edits } = agentMarks(state);
    const color = edits.length ? edits.reduce((a, b) => (b.from > a.from ? b : a)).color : "";
    const sig = `${edits.length}|${color}`;
    if (sig === shown) return;
    shown = sig;
    dom.hidden = edits.length === 0;
    count.nodeValue = String(edits.length);
    nameStatusItem(next, `${edits.length} agent edits, go to next`, "Next agent edit");
    dom.style.setProperty("--agent-c", color);
  };
  render(view.state);
  return { dom, update: (u) => void (agentMarks(u.startState).edits !== agentMarks(u.state).edits && render(u.state)) };
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
      else if ((now.kind === "stale" || now.kind === "merge") && before?.kind !== "stale" && before?.kind !== "merge") {
        const [vaultId, path] = key.split("\u0000");
        agent.setConflictWriter(key, writerNow(vaultId, path));
      }
    }
  });
}

// ── registration ───────────────────────────────────────────────────────────

/** Cmd-L and Cmd-K, and Alt-F6 / Shift-Alt-F6 to step through agent edits,
 *  beside the git hunk pair on Alt-F5 (vim has ]a / [a). Cmd-Alt-arrows stay
 *  the workspace's focus moves. Exported for mount tests. */
export const agentKeys = Prec.high(
  keymap.of([
    { key: "Mod-l", preventDefault: true, run: quoteToLinked },
    { key: "Mod-k", preventDefault: true, run: (v) => openInlineInstruction(v, linkedOf(v)) },
    { key: "Alt-F6", preventDefault: true, run: (v) => stepAgentEdit(v, 1) },
    { key: "Shift-Alt-F6", preventDefault: true, run: (v) => stepAgentEdit(v, -1) },
  ]),
);

/**
 * The diff picker's session refs: the linked session's base (the parent of
 * its first commit, from the changes the diff panel holds for it: the same
 * refs the panel's Edit opens, sessionGitRefs) and the base of every other
 * session the file's blame names, each in the session's color. A session
 * that has committed nothing stands on HEAD, which the picker lists already.
 */
export function sessionDiffTargets(vaultId: string, state: EditorState): GitDiffTarget[] {
  const out: GitDiffTarget[] = [];
  const target = (id: string, ref: string, title?: string): GitDiffTarget => {
    const row = sessionRow(id);
    return { ref, label: `${row ? sessionShortTitle(row) : (title ?? "Session")} base`, color: sessionColor(row ?? id) };
  };
  const linked = useAgentStore.getState().links[vaultId]?.sessionId ?? null;
  const panel = useDiffViewerStore.getState();
  if (linked && panel.conversationId === linked) {
    const { base } = sessionGitRefs(panel.changes);
    if (base && base !== "HEAD") out.push(target(linked, base));
  }
  for (const [id, b] of blameSessionBases(blameHunksOf(state))) if (id !== linked) out.push(target(id, b.ref, b.title));
  return out;
}

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
  registerEditorFeature(FEATURE, () => [agentMarksExtension(), agentKeys], { needsVault: true });
  registerStatusItem({ id: "agent.link", side: "right", order: 5, priority: 60, needsVault: true, create: chipItem });
  registerStatusItem({ id: "agent.edits", side: "right", order: 4, priority: 65, needsVault: true, create: (v) => (hasAgentMarks(v.state) ? editsItem(v) : null) });
  watchConflicts();
  addGitDiffTargets(({ vaultId, state }) => sessionDiffTargets(vaultId, state));

  const withView = (fn: (view: EditorView, args: Record<string, unknown> | undefined) => boolean) => (args: Record<string, unknown> | undefined, ctx: CodeCommandContext) => {
    const view = viewFor(ctx);
    return view ? fn(view, args) : false;
  };
  registerCodeCommands({
    "agent.quoteSelection": withView(quoteToLinked),
    // With the instruction already typed (`:Ask fix this`) and a session
    // linked, it goes at once; otherwise the box opens with it filled in.
    "agent.inlineInstruction": withView((v, args) => {
      const text = typeof args?.text === "string" ? args.text : "";
      const linked = linkedOf(v);
      if (text.trim() && linked) return askNow(v, linked, text);
      return openInlineInstruction(v, linked, text);
    }),
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
