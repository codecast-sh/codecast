// The agent integration inside the editor chunk: the marks extension, the
// Cmd-L / Cmd-K keys, the status bar chip's host, and the commands
// (agent.quoteSelection, agent.inlineInstruction, agent.newSession,
// agent.nextEdit / prevEdit, agent.pickSession, agent.dismissEdits).
// Registered once from the editor core (editorHost.registerCoreFeatures).
//
// The linked session is resolved by AgentLayer (components/code/agent), which
// the Files workspace mounts; these commands read its answer from agentStore.

import { Prec } from "@codemirror/state";
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

/** Run `act` with the linked session; with none, the picker asks first. */
function withSession(view: EditorView, act: (sessionId: string) => void): boolean {
  const vaultId = vaultOf(view);
  if (!vaultId) return false;
  const st = useAgentStore.getState();
  const linked = st.links[vaultId]?.sessionId;
  if (linked) {
    act(linked);
    return true;
  }
  const chip = st.chips.find((c) => c.vaultId === vaultId && c.el.isConnected && view.dom.closest("[data-code-group]")?.contains(c.el));
  const rect = chip?.el.getBoundingClientRect();
  st.openPicker({ vaultId, anchor: rect ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null, then: act });
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

export function openInlineInstruction(view: EditorView): boolean {
  const vaultId = vaultOf(view);
  const root = vaultId ? vaultRootOf(vaultId) : null;
  const range = root ? selectedRange(view, root) : null;
  if (!vaultId || !range) return false;
  const { from, to } = lineBounds(view, range);
  const id = useAgentStore.getState().openInline({
    vaultId,
    range,
    onSent: (sessionId) => {
      const row = sessionRow(sessionId);
      const b = lineBounds(view, range);
      view.dispatch({ effects: [setInlineSpot.of(null), addSentMark.of({ ...b, sessionId, color: sessionColor(row ?? sessionId), label: sessionShortTitle(row) })] });
      watchTurn(sessionId);
      view.focus();
    },
    onClose: () => {
      if (agentMarks(view.state).inline?.id === id) view.dispatch({ effects: setInlineSpot.of(null) });
      view.focus();
    },
  });
  view.dispatch({ effects: setInlineSpot.of({ id, pos: to, from, to }) });
  leaveVisual(view);
  return true;
}

function newSession(view: EditorView): boolean {
  const vaultId = vaultOf(view);
  const root = vaultId ? vaultRootOf(vaultId) : null;
  const range = root ? selectedRange(view, root) : null;
  if (!root || !range) return false;
  useInboxStore.getState().openCompose(newSessionText(range), { projectPath: root });
  leaveVisual(view);
  return true;
}

// ── the sent marker ends with the session's turn ───────────────────────────

/** Sessions with a sent marker out, and whether each was seen working since. */
const watched = new Map<string, { seenWorking: boolean; since: number }>();
let unwatch: (() => void) | null = null;

function clearSentEverywhere(sessionId: string): void {
  for (const b of codeBuffers.all()) {
    if (agentMarks(currentState(b)).sent.some((s) => s.sessionId === sessionId)) updateBuffer(b, { effects: clearSentMarks.of(sessionId) });
  }
}

function checkTurns(): void {
  const s = useInboxStore.getState();
  for (const [id, w] of watched) {
    const row = s.sessions[id] as InboxSession | undefined;
    const working = !!row && sessionWorkState(row) === "working";
    if (working) w.seenWorking = true;
    // The turn this instruction started has ended (or never started within a
    // few minutes: an offline session, a refused send).
    else if (w.seenWorking || Date.now() - w.since > 10 * 60_000) {
      watched.delete(id);
      clearSentEverywhere(id);
    }
  }
  if (!watched.size) {
    unwatch?.();
    unwatch = null;
  }
}

function watchTurn(sessionId: string): void {
  watched.set(sessionId, { seenWorking: false, since: Date.now() });
  if (unwatch) return;
  let last: unknown = null;
  unwatch = useInboxStore.subscribe((s) => {
    if (s.sessions === last) return;
    last = s.sessions;
    checkTurns();
  });
}

// ── status bar chip ────────────────────────────────────────────────────────

function chipItem(view: EditorView): StatusItemView | null {
  const dom = document.createElement("span");
  dom.className = "cm-agent-chip";
  dom.style.display = "inline-flex";
  let vaultId = vaultOf(view);
  if (vaultId) useAgentStore.getState().addChip(dom, vaultId);
  return {
    dom,
    update(u: ViewUpdate) {
      const next = u.state.facet(featureContext)?.vaultId ?? null;
      if (next === vaultId) return;
      useAgentStore.getState().removeChip(dom);
      vaultId = next;
      if (vaultId) useAgentStore.getState().addChip(dom, vaultId);
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

const run = (fn: (view: EditorView) => boolean) => (view: EditorView) => fn(view);

const keys = Prec.high(
  keymap.of([
    { key: "Mod-l", preventDefault: true, run: run((v) => withSession(v, (id) => quoteSelection(v, id))) },
    { key: "Mod-k", preventDefault: true, run: run((v) => withSession(v, () => openInlineInstruction(v))) },
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
  registerEditorFeature(FEATURE, () => [agentMarksExtension(), keys, tracker], { needsVault: true });
  registerStatusItem({ id: "agent.link", side: "right", order: 5, priority: 60, needsVault: true, create: chipItem });
  watchConflicts();

  const withView = (fn: (view: EditorView, args: Record<string, unknown> | undefined) => boolean) => (args: Record<string, unknown> | undefined, ctx: CodeCommandContext) => {
    const view = viewFor(ctx);
    if (view) lastView = view;
    return view ? fn(view, args) : false;
  };
  registerCodeCommands({
    "agent.quoteSelection": withView((v) => withSession(v, (id) => quoteSelection(v, id))),
    "agent.inlineInstruction": withView((v) => withSession(v, () => openInlineInstruction(v))),
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
      useAgentStore.getState().openPicker({ vaultId, anchor: null });
      return true;
    }),
  });
}
