// The workspace across buffer swaps: one EditorView showing buffers through
// setState (the editor's tab switch) must not reopen documents, must catch the
// server up on edits made while a buffer was off screen, and must close a
// document once its buffer is gone. Real LSPClient, fake transport.

import { afterEach, describe, expect, it } from "bun:test";
import { installEditorDom } from "../../../../components/code/__tests__/editorDom";

installEditorDom();

const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { history, undo } = await import("@codemirror/commands");
const { LSPClient } = await import("@codemirror/lsp-client");
const { CodecastWorkspace, MAX_DETACHED_DOCUMENTS } = await import("../workspace");
const { vaultFileUri } = await import("../uri");
const { applyWorkspaceEdit } = await import("../edits");
const { savedDocField } = await import("../../buffers");
const { formatDocument } = await import("../navigation");

type Msg = { id?: number; method?: string; params?: any; result?: any };
const ROOT = "/home/ada/repo";
const tick = () => new Promise((r) => setTimeout(r, 5));

function fakeTransport() {
  const sent: Msg[] = [];
  let handler: ((m: string) => void) | null = null;
  return {
    sent,
    notes: (method: string) => sent.filter((m) => m.method === method),
    /** Answer the latest request for `method`. */
    reply: (method: string, result: unknown) => {
      const m = sent.findLast((x) => x.method === method && x.id !== undefined)!;
      handler?.(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    },
    transport: {
      send(raw: string) {
        const m = JSON.parse(raw) as Msg;
        sent.push(m);
        if (m.method === "initialize")
          queueMicrotask(() => handler?.(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { capabilities: { textDocumentSync: 2, documentFormattingProvider: true } } })));
      },
      subscribe: (h: (m: string) => void) => (handler = h),
      unsubscribe: () => (handler = null),
    },
  };
}

interface FakeBuffer {
  key: string;
  path: string;
  state: InstanceType<typeof EditorState>;
  view: InstanceType<typeof EditorView> | null;
}

function setup() {
  const buffers = new Map<string, FakeBuffer>();
  const t = fakeTransport();
  const client = new LSPClient({
    rootUri: `file://${ROOT}`,
    workspace: (c) =>
      new CodecastWorkspace(
        c,
        {
        vaultId: "v",
        buffer: (path) => buffers.get(path) as never,
        applyToBuffer: (b: any, spec) => {
          if (b.view) b.view.dispatch(spec);
          else b.state = b.state.update(spec).state;
        },
          displayFile: async () => null,
        },
        `file://${ROOT}`,
      ),
  });
  client.connect(t.transport);
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent });
  const open = (path: string, doc: string) => {
    const b: FakeBuffer = { key: path, path, view: null, state: EditorState.create({ doc, extensions: [history(), savedDocField, client.plugin(vaultFileUri(ROOT, path), "typescript")] }) };
    buffers.set(path, b);
    return b;
  };
  let shown: FakeBuffer | null = null;
  // EditorHost.show, reduced to what the workspace sees.
  const show = (b: FakeBuffer) => {
    if (shown) {
      shown.state = view.state;
      shown.view = null;
    }
    view.setState(b.state);
    b.view = view;
    shown = b;
  };
  return { client, t, view, buffers, open, show, ws: client.workspace as InstanceType<typeof CodecastWorkspace> };
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

describe("CodecastWorkspace", () => {
  it("opens a document once across tab switches", async () => {
    const s = setup();
    cleanup.push(() => s.view.destroy());
    const a = s.open("src/a.ts", "const a = 1;\n");
    const b = s.open("src/b.ts", "const b = 2;\n");
    s.show(a);
    s.show(b);
    s.show(a);
    s.show(b);
    await tick();
    const opened = s.t.notes("textDocument/didOpen").map((m) => m.params.textDocument.uri);
    expect(opened).toEqual([vaultFileUri(ROOT, "src/a.ts"), vaultFileUri(ROOT, "src/b.ts")]);
    expect(s.t.notes("textDocument/didClose")).toEqual([]);
    expect(s.ws.files.length).toBe(2);
    expect(s.ws.liveCount).toBe(1);
  });

  it("sends typing as incremental changes and off-screen edits on return", async () => {
    const s = setup();
    cleanup.push(() => s.view.destroy());
    const a = s.open("a.ts", "x".repeat(2000) + "\n");
    const b = s.open("b.ts", "let b;\n");
    s.show(a);
    await s.client.initializing;
    s.view.dispatch({ changes: { from: 0, insert: "y" } });
    s.client.sync();
    await tick();
    const typed = s.t.notes("textDocument/didChange").at(-1)!;
    expect(typed.params.contentChanges).toEqual([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: "y" }]);

    s.show(b);
    // A rename lands in a while it is off screen.
    a.state = a.state.update({ changes: { from: 0, to: 1, insert: "Z" } }).state;
    s.show(a);
    await tick();
    const caught = s.t.notes("textDocument/didChange").at(-1)!;
    expect(caught.params.textDocument.uri).toBe(vaultFileUri(ROOT, "a.ts"));
    expect(caught.params.contentChanges[0].text.startsWith("Zx")).toBe(true);
    expect(s.t.notes("textDocument/didOpen").length).toBe(2);
    // The plugin rebuilt on return starts from what the server now holds.
    s.view.dispatch({ changes: { from: 1, insert: "!" } });
    s.client.sync();
    await tick();
    expect(s.t.notes("textDocument/didChange").at(-1)!.params.contentChanges[0]).toMatchObject({ text: "!", range: { start: { line: 0, character: 1 } } });
  });

  it("closes a document once its buffer is gone, and caps detached ones", async () => {
    const s = setup();
    cleanup.push(() => s.view.destroy());
    const a = s.open("a.ts", "a\n");
    const b = s.open("b.ts", "b\n");
    s.show(a);
    s.show(b);
    s.buffers.delete("a.ts");
    await tick();
    expect(s.t.notes("textDocument/didClose").map((m) => m.params.textDocument.uri)).toEqual([vaultFileUri(ROOT, "a.ts")]);

    const many = Array.from({ length: MAX_DETACHED_DOCUMENTS + 3 }, (_, i) => s.open(`f${i}.ts`, `${i}\n`));
    for (const f of many) s.show(f);
    s.show(b);
    await tick();
    const detached = s.ws.files.filter((f) => f.views.size === 0).length;
    expect(detached).toBe(MAX_DETACHED_DOCUMENTS);
    // The oldest went first.
    expect(s.ws.getFile(vaultFileUri(ROOT, "f0.ts"))).toBeNull();
    expect(s.ws.getFile(vaultFileUri(ROOT, `f${many.length - 1}.ts`))).not.toBeNull();
  });

  it("never closes a detached document with unsaved changes to stay under the cap", async () => {
    const s = setup();
    cleanup.push(() => s.view.destroy());
    const dirty = s.open("dirty.ts", "x\n");
    s.show(dirty);
    s.view.dispatch({ changes: { from: 0, insert: "y" } });
    const many = Array.from({ length: MAX_DETACHED_DOCUMENTS + 3 }, (_, i) => s.open(`f${i}.ts`, `${i}\n`));
    for (const f of many) s.show(f);
    await tick();
    expect(s.ws.getFile(vaultFileUri(ROOT, "dirty.ts"))).not.toBeNull();
    expect(s.ws.getFile(vaultFileUri(ROOT, "f0.ts"))).toBeNull();
    expect(s.t.notes("textDocument/didClose").some((m) => m.params.textDocument.uri === vaultFileUri(ROOT, "dirty.ts"))).toBe(false);
  });

  it("skips an edit for an unsaved buffer the server never opened, and applies it to a clean one", async () => {
    const s = setup();
    cleanup.push(() => s.view.destroy());
    s.show(s.open("shown.ts", "foo;\n"));
    // Neither was ever shown, so the server computed its positions from disk.
    const dirty = s.open("dirty.ts", "foo();\n");
    dirty.state = dirty.state.update({ changes: { from: 0, insert: "// note\n" } }).state;
    const clean = s.open("clean.ts", "foo();\n");
    await tick();
    expect(s.ws.getFile(vaultFileUri(ROOT, "dirty.ts"))).toBeNull();
    const rename = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "bar" };
    const report = await applyWorkspaceEdit(
      { changes: { [vaultFileUri(ROOT, "dirty.ts")]: [rename], [vaultFileUri(ROOT, "clean.ts")]: [rename] } },
      target(s),
      { document: (u) => s.ws.getFile(u) },
    );
    expect(report.buffers).toEqual(["clean.ts"]);
    expect(report.skipped).toEqual([{ path: "dirty.ts", reason: "unsaved, not open in the server" }]);
    expect(dirty.state.doc.toString()).toBe("// note\nfoo();\n");
    expect(clean.state.doc.toString()).toBe("bar();\n");
  });

  it("finds a file by any encoding of its URI", async () => {
    const s = setup();
    cleanup.push(() => s.view.destroy());
    s.show(s.open("node_modules/@types/x.d.ts", "x\n"));
    await tick();
    expect(s.ws.getFile(`file://${ROOT}/node_modules/%40types/x.d.ts`)).not.toBeNull();
    expect(s.ws.getFile(`file://${ROOT}/node_modules/@types/x.d.ts`)).not.toBeNull();
  });

  it("applies a rename to the open file as one undoable step, and to an off-screen buffer", async () => {
    const s = setup();
    cleanup.push(() => s.view.destroy());
    const a = s.open("a.ts", "let foo = 1;\nfoo++;\n");
    const b = s.open("b.ts", "foo();\n");
    s.show(b);
    s.show(a);
    const writes: string[] = [];
    const report = await applyWorkspaceEdit(
      {
        changes: {
          [vaultFileUri(ROOT, "a.ts")]: [
            { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } }, newText: "bar" },
            { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: "bar" },
          ],
          [vaultFileUri(ROOT, "b.ts")]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "bar" }],
        },
      },
      {
        rootPath: ROOT,
        buffer: (p) => s.buffers.get(p) as never,
        applyToBuffer: (buf: any, spec) => (buf.view ? buf.view.dispatch(spec) : (buf.state = buf.state.update(spec).state)),
        read: async () => null,
        write: async (p) => void writes.push(p),
      },
      { userEvent: "rename" },
    );
    expect(report).toMatchObject({ buffers: ["a.ts", "b.ts"], written: [], conflicts: [] });
    expect(s.view.state.doc.toString()).toBe("let bar = 1;\nbar++;\n");
    expect(b.state.doc.toString()).toBe("bar();\n");
    undo(s.view);
    expect(s.view.state.doc.toString()).toBe("let foo = 1;\nfoo++;\n");
    expect(writes).toEqual([]);
  });

  const target = (s: ReturnType<typeof setup>) => ({
    rootPath: ROOT,
    buffer: (p: string) => s.buffers.get(p) as never,
    applyToBuffer: (buf: any, spec: any) => (buf.view ? buf.view.dispatch(spec) : (buf.state = buf.state.update(spec).state)),
    read: async () => null,
    write: async () => {},
  });
  const whole = (line: number, end: number, newText: string) => ({ range: { start: { line, character: 0 }, end: { line, character: end } }, newText });

  it("formats the file it was asked for, even after a tab switch before the reply", async () => {
    const s = setup();
    cleanup.push(() => s.view.destroy());
    const a = s.open("a.ts", "let  a=1\n");
    const b = s.open("b.ts", "let b=2\n");
    s.show(b);
    s.show(a);
    await s.client.initializing;
    const formatting = formatDocument(s.view)!;
    expect(formatting).not.toBeNull();
    await tick();
    // The person moves to b while the server works.
    s.show(b);
    s.t.reply("textDocument/formatting", [whole(0, 8, "let a = 1;")]);
    expect(await formatting).toBe(true);
    expect(s.view.state.doc.toString()).toBe("let b=2\n");
    expect(a.state.doc.toString()).toBe("let a = 1;\n");
    // Back on a: the edit is in its history.
    s.show(a);
    undo(s.view);
    expect(s.view.state.doc.toString()).toBe("let  a=1\n");
  });

  it("drops a format whose range the person typed into, and maps one they did not", async () => {
    const s = setup();
    cleanup.push(() => s.view.destroy());
    const a = s.open("a.ts", "let  a=1\nlet  b=2\n");
    s.show(a);
    await s.client.initializing;
    let formatting = formatDocument(s.view)!;
    await tick();
    s.view.dispatch({ changes: { from: 3, insert: "x" } });
    s.t.reply("textDocument/formatting", [whole(0, 8, "let a = 1;")]);
    expect(await formatting).toBe(false);
    expect(s.view.state.doc.toString()).toBe("letx  a=1\nlet  b=2\n");

    formatting = formatDocument(s.view)!;
    await tick();
    s.view.dispatch({ changes: { from: 0, insert: "// top\n" } });
    s.t.reply("textDocument/formatting", [whole(1, 8, "let b = 2;")]);
    expect(await formatting).toBe(true);
    expect(s.view.state.doc.toString()).toBe("// top\nletx  a=1\nlet b = 2;\n");
  });

  it("refuses a versioned edit for a document that moved past that version", async () => {
    const s = setup();
    cleanup.push(() => s.view.destroy());
    const a = s.open("a.ts", "foo\n");
    s.show(a);
    await s.client.initializing;
    const uri = vaultFileUri(ROOT, "a.ts");
    const before = s.ws.getFile(uri)!.version;
    s.view.dispatch({ changes: { from: 0, insert: "// \n" } });
    s.client.sync();
    const file = s.ws.getFile(uri)!;
    expect(file.version).toBeGreaterThan(before);
    const edit = (version: number) => ({ documentChanges: [{ textDocument: { uri, version }, edits: [whole(0, 3, "bar")] }] });
    const stale = await applyWorkspaceEdit(edit(before), target(s), { document: (u) => s.ws.getFile(u) });
    expect(stale.skipped.map((x) => x.path)).toEqual(["a.ts"]);
    expect(s.view.state.doc.toString()).toBe("// \nfoo\n");
    const fresh = await applyWorkspaceEdit(edit(file.version), target(s), { document: (u) => s.ws.getFile(u) });
    expect(fresh.buffers).toEqual(["a.ts"]);
    expect(s.view.state.doc.toString()).toBe("bar\nfoo\n");
  });
});
