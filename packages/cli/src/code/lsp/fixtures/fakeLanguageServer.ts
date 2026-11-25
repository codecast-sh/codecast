// A language server small enough to reason about, for the /lsp/ws tests. It
// speaks Content-Length JSON-RPC on stdio, answers initialize with what it was
// sent, publishes a diagnostic once initialized, and crashes on request.

import { writeFileSync } from "fs";
import { LspFrameReader, encodeLspFrame } from "../framing.js";

type Msg = { id?: number | string; method?: string; params?: any; result?: any; error?: any };

const state = { initialize: 0, initialized: 0, open: new Set<string>(), cancelled: [] as unknown[] };
const waiting = new Map<string, (msg: Msg) => void>();
let nextId = 0;

const send = (msg: object): void => {
  process.stdout.write(encodeLspFrame(JSON.stringify({ jsonrpc: "2.0", ...msg })));
};
const reply = (id: Msg["id"], result: unknown) => send({ id, result });

function handle(msg: Msg): void {
  if (msg.method === undefined && msg.id !== undefined) {
    waiting.get(String(msg.id))?.(msg);
    return;
  }
  switch (msg.method) {
    case "initialize": {
      state.initialize++;
      const answer = () => reply(msg.id, { capabilities: { textDocumentSync: 1 }, serverInfo: { name: "fake" }, pid: process.pid, params: msg.params });
      const delayMs = msg.params?.initializationOptions?.delayMs;
      if (delayMs) return void setTimeout(answer, delayMs);
      return answer();
    }
    case "initialized":
      state.initialized++;
      return send({ method: "textDocument/publishDiagnostics", params: { uri: "file:///fake.ts", diagnostics: [{ message: "fake diagnostic" }] } });
    case "textDocument/didOpen":
      state.open.add(msg.params.textDocument.uri);
      return;
    case "textDocument/didClose":
      state.open.delete(msg.params.textDocument.uri);
      return;
    case "$/cancelRequest":
      state.cancelled.push(msg.params.id);
      return;
    case "fake/echo":
      return reply(msg.id, msg.params);
    case "fake/stats":
      return reply(msg.id, { pid: process.pid, initialize: state.initialize, initialized: state.initialized, open: [...state.open], cancelled: state.cancelled });
    case "fake/flood": {
      // A burst bigger than any socket buffer, as a full semantic tokens pass
      // over a big project produces. The answer puts its id last, the way
      // gopls orders its fields.
      const { count = 0, bytes = 0, answerBytes = 0, delayMs = 0 } = msg.params;
      const chunk = "x".repeat(bytes);
      setTimeout(() => {
        for (let i = 0; i < count; i++) send({ method: "fake/flooded", params: { i, chunk } });
        process.stdout.write(encodeLspFrame(`{"jsonrpc":"2.0","result":{"chunk":"${"y".repeat(answerBytes)}"},"id":${JSON.stringify(msg.id)}}`));
      }, delayMs);
      return;
    }
    case "fake/stall":
      // Stop reading input for a while, as a server busy in one long request
      // does; answered first so the caller knows it has begun.
      reply(msg.id, { stalled: true });
      process.stdin.pause();
      return void setTimeout(() => process.stdin.resume(), msg.params?.ms ?? 1000);
    case "fake/never":
      return; // answered by nobody: the detach path cancels it
    case "fake/ask": {
      const id = `ask-${++nextId}`;
      waiting.set(id, (answer) => reply(msg.id, answer));
      return send({ id, method: "workspace/configuration", params: { items: [{ section: "fake" }] } });
    }
    case "fake/crash":
      process.stderr.write("boom: magic crash\n");
      process.exit(3);
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `no ${msg.method}` } });
  }
}

const reader = new LspFrameReader({
  message: (json) => handle(JSON.parse(json)),
  oversize: () => {},
  error: () => process.exit(2),
});
process.stdin.on("data", (chunk: Buffer) => reader.push(chunk));
process.stdin.on("end", () => process.exit(0));
process.stderr.write("fake language server up\n");
if (process.env.FAKE_LSP_PIDFILE) writeFileSync(process.env.FAKE_LSP_PIDFILE, String(process.pid));
