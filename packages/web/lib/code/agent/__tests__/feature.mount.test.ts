// The editor's agent verbs against stubbed store actions: Cmd-L adds a pending
// quote to the linked session's composer and flashes the range, Cmd-L with no
// link asks for a session first, and Cmd-K's send leaves a "sent" marker that
// the session's finished turn takes down. Nothing reaches a real session.
import { installEditorDom } from "../../../../components/code/__tests__/editorDom";

installEditorDom();

const { afterAll, beforeEach, describe, expect, it } = await import("bun:test");
const { EditorSelection, EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { featureBase } = await import("../../features");
const { useInboxStore } = await import("../../../../store/inboxStore");
const { useVaultStore } = await import("../../../../store/vaultStore");
const { useAgentStore } = await import("../agentStore");
const { addSentMark, agentMarks, agentMarksExtension } = await import("../editorMarks");
const { agentKeys, checkSentTurns, openInlineInstruction, quoteSelection, selectedRange, watchTurn } = await import("../feature");
const { codeBuffers } = await import("../../buffers");
const { instructionMessage, sendInstruction } = await import("../compose");

const inboxBefore = useInboxStore.getState();
const vaultBefore = useVaultStore.getState();
afterAll(() => {
  useInboxStore.setState(inboxBefore as never, true);
  useVaultStore.setState(vaultBefore as never, true);
});

const quotes: Array<[string, Record<string, unknown>]> = [];
const sends: unknown[][] = [];

beforeEach(() => {
  quotes.length = 0;
  sends.length = 0;
  useVaultStore.setState({ vaults: [{ id: "v", root: "/r/app", name: "app" }] } as never);
  useInboxStore.setState({
    sessions: { s1: { _id: "s1", title: "Fix the parser", agent_type: "claude_code", updated_at: 1 } },
    addReviewComment: (id: string, c: Record<string, unknown>) => quotes.push([id, c]),
    addOptimisticMessage: (id: string, text: string) => {
      sends.push(["optimistic", id, text]);
      return "client-1";
    },
    sendMessageWhenReady: (...args: unknown[]) => sends.push(["send", ...args]),
  } as never);
  useAgentStore.setState({ links: {}, picker: null, inline: null });
});

const MOD = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
const cmdL = () => new window.KeyboardEvent("keydown", { key: "l", keyCode: 76, ...MOD, bubbles: true, cancelable: true });

const DOC = ["import x", "", "function add(a, b) {", "  return a + b;", "}", "", "export {}"].join("\n");

const ctx = (path = "src/math.ts") => ({ vaultId: "v", path, languageId: "typescript", languageName: "TypeScript", sizeBytes: 1, largeFile: false });
const extensions = (path?: string) => [featureBase(ctx(path)), agentMarksExtension(), agentKeys];

let opened = 0;
/** An editor showing a real buffer, as the workspace mounts one. */
function mount(doc = DOC) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const buffer = codeBuffers.open({ vaultId: "v", path: `src/math${++opened}.ts`, content: doc, etag: "e1", extensions: () => extensions() });
  const view = new EditorView({ parent, state: buffer.state });
  buffer.view = view;
  return view;
}

describe("the range", () => {
  it("an empty selection is the cursor's line; a linewise drag stops above the line it ends on", () => {
    const view = mount();
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(4).from + 3) });
    expect(selectedRange(view, "/r/app")).toMatchObject({ absPath: "/r/app/src/math.ts", startLine: 4, endLine: 4, code: "  return a + b;", lang: "ts" });
    view.dispatch({ selection: EditorSelection.range(view.state.doc.line(3).from, view.state.doc.line(6).from) });
    const r = selectedRange(view, "/r/app")!;
    expect([r.startLine, r.endLine]).toEqual([3, 5]);
    expect(r.context.linesFrom).toBe(1);
  });
});

describe("Cmd-L", () => {
  it("adds a pending quote to the session's composer with the vault-absolute path, and flashes the range", () => {
    const view = mount();
    view.dispatch({ selection: EditorSelection.range(view.state.doc.line(3).from, view.state.doc.line(5).to) });
    expect(quoteSelection(view, "s1")).toBe(true);
    expect(quotes).toHaveLength(1);
    const [sid, c] = quotes[0];
    expect(sid).toBe("s1");
    expect(c).toMatchObject({ filePath: "/r/app/src/math.ts", fileLine: 5, blockIndex: 3, messageId: "file:/r/app/src/math.ts", body: "" });
    expect(String(c.quote).startsWith("/r/app/src/math.ts:L3-5\n```ts\nfunction add")).toBe(true);
    expect(c.anchorLines).toBeTruthy();
    expect(agentMarks(view.state).flashes.map((f) => f.kind)).toEqual(["quote"]);
  });

  it("with no linked session, the key asks for one first and quotes once it is picked", () => {
    const view = mount();
    view.contentDOM.dispatchEvent(cmdL());
    const picker = useAgentStore.getState().picker;
    expect(picker?.vaultId).toBe("v");
    expect(quotes).toHaveLength(0);
    picker!.then!("s1");
    expect(quotes.map((q) => q[0])).toEqual(["s1"]);
  });

  it("with a linked session, the key quotes straight away", () => {
    const view = mount();
    useAgentStore.getState().setLink("v", { sessionId: "s1", source: "folder" });
    view.contentDOM.dispatchEvent(cmdL());
    expect(useAgentStore.getState().picker).toBeNull();
    expect(quotes.map((q) => q[0])).toEqual(["s1"]);
  });
});

describe("Cmd-K", () => {
  it("opens the inline box under the range, and a send leaves a 'sent to' marker on it", () => {
    const view = mount();
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(4).from) });
    expect(openInlineInstruction(view)).toBe(true);
    const req = useAgentStore.getState().inline!;
    expect(req.range).toMatchObject({ startLine: 4, endLine: 4 });
    expect(agentMarks(view.state).inline?.id).toBe(req.id);

    // What the box does on Enter: one message through the store's send path.
    expect(sendInstruction(useInboxStore.getState() as never, "s1", req.range, "use checked addition")).toBe("client-1");
    const text = instructionMessage(req.range, "use checked addition");
    expect(sends).toEqual([
      ["optimistic", "s1", text],
      ["send", "s1", text, undefined, "client-1"],
    ]);
    req.onSent("s1", "client-1");
    const st = agentMarks(view.state);
    expect(st.inline).toBeNull();
    expect(st.sent).toHaveLength(1);
    expect(st.sent[0]).toMatchObject({ key: "client-1", sessionId: "s1", label: "Fix the parser" });
    expect(view.dom.querySelector(".cm-agentSentNote")?.textContent).toBe("sent to Fix the parser");
  });
});

describe("Cmd-K's target", () => {
  it("is the session linked when the box opened; with none, the box asks", () => {
    const view = mount();
    useAgentStore.getState().setLink("v", { sessionId: "s1", source: "folder" });
    view.contentDOM.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", keyCode: 75, ...MOD, bubbles: true, cancelable: true }));
    expect(useAgentStore.getState().inline?.sessionId).toBe("s1");
    // The folder link re-ranking afterwards does not move it.
    useAgentStore.getState().setLink("v", { sessionId: "s2", source: "folder" });
    expect(useAgentStore.getState().inline?.sessionId).toBe("s1");
    useAgentStore.getState().closeInline();

    useAgentStore.getState().setLink("v", { sessionId: null, source: "none" });
    view.contentDOM.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", keyCode: 75, ...MOD, bubbles: true, cancelable: true }));
    expect(useAgentStore.getState().inline?.sessionId).toBeNull();
    expect(useAgentStore.getState().picker).toBeNull();
  });
});

describe("the sent marker", () => {
  const sentLines = (state: InstanceType<typeof EditorState>) => agentMarks(state).sent.map((x) => [state.doc.lineAt(x.from).number, state.doc.lineAt(x.to).number]);

  it("lands on the lines the box was opened on, even after an edit above them", () => {
    const view = mount();
    view.dispatch({ selection: EditorSelection.range(view.state.doc.line(3).from, view.state.doc.line(5).to) });
    openInlineInstruction(view, "s1");
    // An agent edit lands above while the person types the instruction.
    view.dispatch({ changes: { from: 0, insert: "// header\n// more\n" } });
    useAgentStore.getState().inline!.onSent("s1", "c-a");
    expect(sentLines(view.state)).toEqual([[5, 7]]);
    expect(view.state.sliceDoc(agentMarks(view.state).sent[0].from, view.state.doc.lineAt(agentMarks(view.state).sent[0].from).to)).toBe("function add(a, b) {");
  });

  it("goes to the buffer that holds the box when the view has moved to another file", () => {
    const view = mount();
    const buffer = codeBuffers.all().find((b) => b.view === view)!;
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(4).from) });
    openInlineInstruction(view, "s1");
    const req = useAgentStore.getState().inline!;
    // The person switches the editor to another file, as the workspace does.
    buffer.state = view.state;
    buffer.view = null;
    view.setState(EditorState.create({ doc: "other", extensions: extensions("src/other.ts") }));
    req.onSent("s1", "c-b");
    expect(agentMarks(view.state).sent).toEqual([]);
    expect(agentMarks(buffer.state).inline).toBeNull();
    expect(sentLines(buffer.state)).toEqual([[4, 4]]);
  });

  it("outlasts the turn already running when it was sent, and ends with the turn that read it", () => {
    const view = mount();
    const buffer = codeBuffers.all().find((b) => b.view === view)!;
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(4).from) });
    openInlineInstruction(view, "s1");
    const t0 = Date.now();
    const busy = { _id: "s1", title: "Fix the parser", agent_type: "claude_code", updated_at: t0, agent_status: "working", is_idle: false, is_connected: true, last_heartbeat: t0 };
    const idle = { ...busy, agent_status: "idle", is_idle: true };
    const pending = { s1: [{ _id: "c-q", _clientId: "c-q", role: "user", content: "x", timestamp: t0, _isQueued: true }] };
    useInboxStore.setState({ sessions: { s1: busy }, pendingMessages: pending, messages: {} } as never);
    useAgentStore.getState().inline!.onSent("s1", "c-q");
    const state = () => useInboxStore.getState() as never;

    // The earlier turn ends with the instruction still queued: the marker stays.
    useInboxStore.setState({ sessions: { s1: idle } } as never);
    checkSentTurns(state(), t0 + 1000);
    expect(agentMarks(buffer.view!.state).sent).toHaveLength(1);

    // It is delivered and its turn runs, then ends: the marker goes.
    useInboxStore.setState({ sessions: { s1: busy }, pendingMessages: {}, messages: { s1: [{ _id: "m1", role: "user", client_id: "c-q", timestamp: t0 + 2000 }] } } as never);
    checkSentTurns(state(), t0 + 2000);
    expect(agentMarks(buffer.view!.state).sent).toHaveLength(1);
    useInboxStore.setState({ sessions: { s1: idle } } as never);
    checkSentTurns(state(), t0 + 3000);
    expect(agentMarks(buffer.view!.state).sent).toEqual([]);
  });

  it("a second instruction to the same session keeps its own marker", () => {
    const view = mount();
    const t0 = Date.now();
    const l2 = view.state.doc.line(2);
    const l6 = view.state.doc.line(6);
    view.dispatch({ effects: [addSentMark.of({ from: l2.from, to: l2.to, key: "k1", sessionId: "s1", color: "c", label: "x" }), addSentMark.of({ from: l6.from, to: l6.to, key: "k2", sessionId: "s1", color: "c", label: "x" })] });
    const idle = { _id: "s1", agent_type: "claude_code", updated_at: t0, agent_status: "idle", is_idle: true };
    useInboxStore.setState({ sessions: { s1: idle }, pendingMessages: { s1: [{ _id: "k2", _clientId: "k2", role: "user", content: "x", timestamp: t0 }] }, messages: {} } as never);
    watchTurn("s1", "k1", t0);
    watchTurn("s1", "k2", t0);
    // k1 was delivered (no pending row) and its quick turn passed unseen.
    checkSentTurns(useInboxStore.getState() as never, t0 + 1000);
    checkSentTurns(useInboxStore.getState() as never, t0 + 2 * 60_000);
    expect(agentMarks(view.state).sent.map((x) => x.key)).toEqual(["k2"]);
  });
});
