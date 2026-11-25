// A buffer off screen keeps its language server's plugin in its saved state.
// When the pool disposes that idle client, the buffer must come back attached
// to a fresh client (its document reopened there), not to the dead one, and the
// reattach must settle: one factory run per shown state, no loop. Real feature
// path (features.ts registry, feature.ts lspExtension, pool, workspace) over a
// fake daemon socket.

import { afterAll, expect, it } from "bun:test";
import { installEditorDom } from "../../../../components/code/__tests__/editorDom";

installEditorDom();

const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { attachFeatureHost, featureBase, reconfigureEditorFeature, registerEditorFeature, syncEditorFeatures } = await import("../../features");
const { activateLsp, lspExtension } = await import("../feature");
const { configureLspPool, disposeLspPool, sweepIdleLspClients } = await import("../pool");

class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
    const m = JSON.parse(data);
    if (m.method === "initialize") queueMicrotask(() => this.say({ jsonrpc: "2.0", id: m.id, result: { capabilities: { textDocumentSync: 2 } } }));
  }
  close() {
    this.closed = true;
  }
  say(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  methods(): string[] {
    return this.sent.map((s) => JSON.parse(s)).map((m) => m.method ?? m.type);
  }
}

const ROOT = "/home/ada/repo";
const server = { id: "typescript", name: "TypeScript", languages: ["typescript"], available: true, command: "/bin/tsls" };
const realFetch = globalThis.fetch;
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 2));
  if (!check()) throw new Error(`${what} timed out`);
};

afterAll(() => {
  globalThis.fetch = realFetch;
  disposeLspPool();
  configureLspPool({});
});

it("a buffer whose idle client was disposed reattaches to a fresh one when shown, once", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ servers: [server] }))) as unknown as typeof fetch;
  activateLsp();
  const buffers = new Map<string, { view: null; state: unknown }>([
    ["a.ts", { view: null, state: EditorState.create({ doc: "const a = 1;\n" }) }],
    ["notes.md", { view: null, state: EditorState.create({ doc: "# notes\n" }) }],
  ]);
  configureLspPool({
    endpoint: () => ({ port: 1, token: "t", deviceId: "d", tmux: true }),
    idleMs: 1000,
    transport: { WebSocket: FakeWebSocket as unknown as new (url: string) => WebSocket, retryInitialMs: 5 },
    workspaceHost: (vaultId) => ({ vaultId, buffer: (p) => buffers.get(p) as never, applyToBuffer: () => {}, displayFile: async () => null }),
    reattach: () => reconfigureEditorFeature("lsp"),
  });
  let runs = 0;
  const off = registerEditorFeature("lsp", (ctx) => {
    runs++;
    return lspExtension(ctx);
  });
  const ctx = (path: string, languageId: string) => ({ vaultId: "v", path, languageId, languageName: null, sizeBytes: 10, largeFile: false });
  const view = new EditorView({ parent: document.body });
  const release = attachFeatureHost(view);
  const show = (state: InstanceType<typeof EditorState>) => {
    view.setState(state);
    syncEditorFeatures(view);
  };
  const ready = (ws: FakeWebSocket) => {
    ws.readyState = 1;
    ws.onopen?.();
    ws.say({ type: "ready", server, root_uri: `file://${ROOT}` });
  };

  show(EditorState.create({ doc: "const a = 1;\n", extensions: featureBase(ctx("a.ts", "typescript")) }));
  await until(() => FakeWebSocket.all.length === 1, "first socket");
  const first = FakeWebSocket.all[0];
  ready(first);
  await until(() => first.methods().includes("textDocument/didOpen"), "didOpen on the first client");

  // Off to a file with no server; a.ts keeps its plugin in the saved state.
  const savedA = view.state;
  show(EditorState.create({ doc: "# notes\n", extensions: featureBase(ctx("notes.md", "markdown")) }));
  await new Promise((r) => setTimeout(r, 20));
  const now = Date.now();
  sweepIdleLspClients(now);
  sweepIdleLspClients(now + 1000);
  expect(first.closed).toBe(true);
  await new Promise((r) => setTimeout(r, 20));
  const runsBefore = runs;

  show(savedA);
  await until(() => FakeWebSocket.all.length === 2, "a fresh socket");
  const second = FakeWebSocket.all[1];
  ready(second);
  await until(() => second.methods().includes("textDocument/didOpen"), "didOpen on the fresh client");
  await new Promise((r) => setTimeout(r, 50));
  // One run for a.ts shown again; nothing keeps re-running.
  expect(runs - runsBefore).toBe(1);
  expect(FakeWebSocket.all.length).toBe(2);
  expect(second.methods().filter((m) => m === "textDocument/didOpen").length).toBe(1);

  release();
  view.destroy();
  off();
});
