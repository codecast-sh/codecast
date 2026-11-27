// Contract 1 of docs/architecture/code-editor.md with everything on: the
// workspace shows a 5,000-line TypeScript file with vim (from a vimrc), a
// language server, the git gutter, session blame and the agent layer (a working
// session linked to the folder). Typing in insert mode, moving in normal mode,
// and the server publishing diagnostics and progress while the person types
// commit React zero times and write no store. Each keystroke's cost here is
// logged, not asserted: jsdom does no layout, so the browser number lives in
// perf/README.md ("Editor").
//
// Keystrokes are the transactions CodeMirror's input handling produces
// (userEvent "input.type") behind vim's insert mode, and vim's own key handler
// for normal mode; jsdom has no beforeinput for CodeMirror's DOM observer.
import { afterAll, expect, mock, test } from "bun:test";
import { installEditorDom, settle } from "./editorDom";

installEditorDom();
localStorage.setItem("codecast.code.blameGutter", "1");

const realPanels = { ...(await import("react-resizable-panels")) };
mock.module("react-resizable-panels", () => ({
  ...realPanels,
  Group: ({ children }: { children: unknown }) => children,
  Panel: ({ children }: { children: unknown }) => children,
  Separator: () => null,
}));
const realConvex = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...realConvex, useConvex: () => ({}) }));

const LINES = 5_000;
const lines: string[] = [];
for (let i = 0; i < LINES; i++) lines.push(i % 10 === 0 ? `export function f${i}(a: number) {` : i % 10 === 9 ? "}" : `  const v${i} = a + ${i}; // line ${i}`);
const text = lines.join("\n") + "\n";
const small = "export const small = 1;\n";
const base = text.replace("const v1 = a + 1;", "const v1 = a - 1;").replace("const v2001 =", "let v2001 =");

const calls = { status: 0, base: 0, blame: 0, vimrc: 0 };
const realClient = { ...(await import("../../../lib/code/daemonClient")) };
mock.module("../../../lib/code/daemonClient", () => ({
  ...realClient,
  fetchVimrcText: async () => {
    calls.vimrc++;
    return JSON.stringify({ sources: [{ path: "/home/test/.vimrc", content: 'let mapleader=","\nset relativenumber\nnoremap H ^\n' }], overlay: null });
  },
  fetchGitStatus: async () => {
    calls.status++;
    return { repo: true, branch: "main", head: "h1", ahead: 0, behind: 0, files: { "src/big.ts": "modified" } };
  },
  fetchGitBase: async (_ep: unknown, _v: string, path: string) => {
    calls.base++;
    return { path, ref: "HEAD", exists: true, content: base };
  },
  fetchBlame: async (_ep: unknown, _v: string, path: string) => {
    calls.blame++;
    const session = { id: "jx7aaaa", conversation_id: "a".repeat(32), title: "Big refactor", message_id: "m1" };
    return { path, hunks: [{ start: 1, end: LINES, sha: "a".repeat(40), author: "Ada", summary: "first", time: Date.now() - 3_600_000, session }] };
  },
}));

// The daemon's language server, behind /lsp/ws.
class FakeLspSocket {
  static all: FakeLspSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeLspSocket.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
      this.say({ type: "ready", server: SERVER, root_uri: "file:///tmp/repo" });
    }, 0);
  }
  send(data: string) {
    this.sent.push(data);
    const m = JSON.parse(data);
    if (m.method === "initialize") queueMicrotask(() => this.say({ jsonrpc: "2.0", id: m.id, result: { capabilities: { textDocumentSync: 2, hoverProvider: true } } }));
    else if (m.id !== undefined && m.method) queueMicrotask(() => this.say({ jsonrpc: "2.0", id: m.id, result: null }));
  }
  close() {}
  say(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  methods(): string[] {
    return this.sent.map((s) => JSON.parse(s).method ?? "");
  }
}
const SERVER = { id: "typescript", name: "TypeScript", languages: ["typescript"], available: true, command: "/bin/tsls" };
const realWebSocket = globalThis.WebSocket;
const realFetch = globalThis.fetch;
globalThis.WebSocket = FakeLspSocket as unknown as typeof WebSocket;
globalThis.fetch = (async (url: string) =>
  String(url).includes("/lsp/servers") ? new Response(JSON.stringify({ servers: [SERVER] })) : new Response("{}", { status: 404 })) as unknown as typeof fetch;

const React = await import("react");
const { act, Profiler } = React;
const { createRoot } = await import("react-dom/client");
const { EditorView } = await import("@codemirror/view");
const { getCM, Vim } = await import("@replit/codemirror-vim");
const { useVaultStore } = await import("../../../store/vaultStore");
const { useInboxStore } = await import("../../../store/inboxStore");
const { useCodeStore } = await import("../../../store/codeStore");
const { useGitStatusStore } = await import("../../../lib/code/git/status");
const { useAgentStore } = await import("../../../lib/code/agent/agentStore");
const { codeBuffers } = await import("../../../lib/code/buffers");
const { emptyWorkspace, openTab } = await import("../../../lib/code/workspace/model");
const { workspaceActions } = await import("../../../lib/code/workspace/controller");
const { disposeLspPool } = await import("../../../lib/code/lsp/pool");
const { CodeWorkspace } = await import("../workspace/CodeWorkspace");
await import("../CodeFileView");

const VAULT = "vault-all-features";
const ROOT = "/tmp/repo";
for (const old of codeBuffers.all()) codeBuffers.close(old.key);
useVaultStore.setState({
  activeVaultId: VAULT,
  isRemote: false,
  endpoint: { port: 1, token: "t" } as any,
  vaults: [{ id: VAULT, root: ROOT, name: "repo" }] as any,
  files: { "src/big.ts": { path: "src/big.ts", mtime: 1, size: text.length }, "src/small.ts": { path: "src/small.ts", mtime: 1, size: small.length } } as any,
  bodies: { "src/big.ts": { content: text, mtime: 1, etag: "e1" }, "src/small.ts": { content: small, mtime: 1, etag: "e2" } },
});
const inboxBefore = useInboxStore.getState();
useInboxStore.setState({
  sessions: {
    s1: { _id: "s1", title: "Big refactor", agent_type: "claude_code", project_path: ROOT, git_root: ROOT, status: "working", updated_at: Date.now(), last_activity_at: Date.now() },
  },
} as never);
useCodeStore.setState({ dirty: {}, conflicts: {}, workspaces: { [VAULT]: openTab(emptyWorkspace(), "src/big.ts") } });

afterAll(() => {
  globalThis.WebSocket = realWebSocket;
  globalThis.fetch = realFetch;
  disposeLspPool();
  useInboxStore.setState(inboxBefore as never, true);
  globalThis.localStorage?.removeItem("codecast.code.blameGutter");
});

const host = document.createElement("div");
host.style.width = "1200px";
host.style.height = "800px";
document.body.append(host);
let commits = 0;
const root = createRoot(host);

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300 && !check(); i++) await act(settle);
  if (!check()) throw new Error(`timed out waiting for ${what}`);
};

test("5,000 lines with vim, LSP, git gutter, blame and agent: typing costs React and every store nothing", async () => {
  await act(async () => {
    root.render(
      <Profiler id="ws" onRender={() => commits++}>
        <CodeWorkspace
          vaultId={VAULT}
          vaultRoot={ROOT}
          urlPath="src/big.ts"
          urlLine={null}
          treeOpen={false}
          onNavigate={() => {}}
          onToggleTree={() => {}}
          renderNote={() => null}
        />
      </Profiler>,
    );
  });
  const viewEl = () => host.querySelector(".cm-editor") as HTMLElement | null;
  await until(() => !!viewEl(), "the editor");
  const view = EditorView.findFromDOM(viewEl()!)!;
  // Every feature on before a key is typed.
  await until(() => !!getCM(view), "vim");
  await until(() => !!host.querySelector(".cm-git-gutter") && calls.base > 0, "the git gutter");
  await until(() => !!host.querySelector(".cm-blame-gutter") && calls.blame > 0, "the blame gutter");
  await until(() => FakeLspSocket.all.some((ws) => ws.methods().includes("textDocument/didOpen")), "the language server");
  await until(() => useAgentStore.getState().links[VAULT]?.sessionId === "s1", "the linked session");
  expect(view.state.doc.lines).toBe(LINES + 1);
  const lsp = FakeLspSocket.all.find((ws) => ws.methods().includes("textDocument/didOpen"))!;
  const cm = getCM(view)!;

  // Into insert mode on line 2, and the first keystroke flips the buffer dirty.
  await act(async () => {
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
    Vim.handleKey(cm, "i", "user");
  });
  const typeChar = (ch: string) => {
    const pos = view.state.selection.main.head;
    view.dispatch({ changes: { from: pos, insert: ch }, selection: { anchor: pos + 1 }, userEvent: "input.type" });
  };
  await act(async () => typeChar("x"));
  await act(settle);

  const writes = { vault: 0, code: 0, git: 0, agent: 0, inbox: 0 };
  const offs = [
    useVaultStore.subscribe(() => writes.vault++),
    useCodeStore.subscribe(() => writes.code++),
    useGitStatusStore.subscribe(() => writes.git++),
    useAgentStore.subscribe(() => writes.agent++),
    useInboxStore.subscribe(() => writes.inbox++),
  ];
  const commitsBefore = commits;
  const uri = "file:///tmp/repo/src/big.ts";
  const times: number[] = [];

  await act(async () => {
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      typeChar(String.fromCharCode(97 + (i % 26)));
      times.push(performance.now() - t);
      if (i % 10 === 9) {
        // The server answers typing with diagnostics and progress, as tsserver does.
        lsp.say({ jsonrpc: "2.0", method: "$/progress", params: { token: "t1", value: { kind: "report", message: `${i}` } } });
        lsp.say({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: { uri, diagnostics: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } }, severity: 1, message: `e${i}` }] },
        });
      }
    }
    // Normal mode: out of insert, motions, back in.
    Vim.handleKey(cm, "<Esc>", "user");
    for (const key of ["j", "j", "w", "b", "k", "$", "0", "j"]) Vim.handleKey(cm, key, "user");
    Vim.handleKey(cm, "i", "user");
    for (let i = 0; i < 20; i++) typeChar("y");
  });
  await act(settle);

  for (const off of offs) off();
  times.sort((x, y) => x - y);
  console.log(`[typing, all features, 5k lines, jsdom] median ${times[100].toFixed(2)}ms p95 ${times[190].toFixed(2)}ms per keystroke`);
  expect(commits - commitsBefore).toBe(0);
  expect(writes).toEqual({ vault: 0, code: 0, git: 0, agent: 0, inbox: 0 });
  expect(view.state.doc.line(2).text.startsWith("x")).toBe(true);
  // The server hears the typing (incremental sync, on the client's own clock).
  await until(() => lsp.methods().includes("textDocument/didChange"), "didChange");
  await act(async () => root.unmount());
});

test("a warm tab switch shows the other file in the same task; the 5,000-line buffer comes back as it was", async () => {
  useCodeStore.setState({ workspaces: { [VAULT]: openTab(openTab(emptyWorkspace(), "src/small.ts"), "src/big.ts") } });
  const again = createRoot(host);
  await act(async () => {
    again.render(
      <CodeWorkspace vaultId={VAULT} vaultRoot={ROOT} urlPath="src/big.ts" urlLine={null} treeOpen={false} onNavigate={() => {}} onToggleTree={() => {}} renderNote={() => null} />,
    );
  });
  await until(() => !!host.querySelector(".cm-editor .cm-line"), "the editor");
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  await act(async () => {
    workspaceActions.activate(VAULT, "g1", "src/small.ts");
    await settle();
  });
  const times: number[] = [];
  for (let i = 0; i < 10; i++) {
    for (const path of ["src/big.ts", "src/small.ts"]) {
      const t = performance.now();
      await act(async () => workspaceActions.activate(VAULT, "g1", path));
      // Same task: the view already holds the file, before any frame or timer.
      expect(view.state.doc.lines).toBe(path === "src/small.ts" ? 2 : LINES + 1);
      times.push(performance.now() - t);
    }
  }
  times.sort((x, y) => x - y);
  console.log(`[tab switch, all features, jsdom] median ${times[10].toFixed(2)}ms max ${times[19].toFixed(2)}ms`);
  expect(view.state.doc.lines).toBe(2);
  expect(EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)).toBe(view);
  await act(async () => again.unmount());
});
