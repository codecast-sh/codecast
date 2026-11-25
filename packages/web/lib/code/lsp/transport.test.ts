import { afterEach, describe, expect, test } from "bun:test";
import type { LspServerInfo } from "@codecast/shared/contracts";
import { LspWebSocketTransport, type LspConnectionState } from "./transport";
import { configureLspPool, disposeLspPool, getLspClient, subscribeLspState, sweepIdleLspClients, type LspPoolState } from "./pool";

class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  static get last(): FakeWebSocket {
    return FakeWebSocket.all[FakeWebSocket.all.length - 1];
  }
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
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  say(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  json(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const endpoint = { port: 4321, token: "tok", deviceId: "d", tmux: true };
const server: LspServerInfo = { id: "typescript", name: "TypeScript", languages: ["typescript"], available: true, command: "/bin/tsls" };
const ready = { type: "ready", server, root_uri: "file:///repo" };
const WS = FakeWebSocket as unknown as new (url: string) => WebSocket;
const tick = () => new Promise((r) => setTimeout(r, 0));

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 2));
  if (!check()) throw new Error(`${what} timed out`);
}

function transport(overrides: Partial<ConstructorParameters<typeof LspWebSocketTransport>[0]> = {}) {
  const t = new LspWebSocketTransport({ vaultId: "v1", server: "typescript", endpoint: () => endpoint, WebSocket: WS, retryInitialMs: 5, retryMaxMs: 20, ...overrides });
  const states: LspConnectionState["status"][] = [];
  t.onState((s) => states.push(s.status));
  return { t, states };
}

afterEach(() => {
  FakeWebSocket.all = [];
  disposeLspPool();
});

describe("LspWebSocketTransport", () => {
  test("says hello with the endpoint's token, then relays JSON-RPC both ways", async () => {
    const { t, states } = transport();
    await until(() => FakeWebSocket.all.length === 1, "socket");
    const ws = FakeWebSocket.last;
    expect(ws.url).toBe("ws://127.0.0.1:4321/lsp/ws");
    ws.open();
    const hello = ws.json()[0];
    expect(hello).toEqual({ type: "hello", token: "tok", vault: "v1", server: "typescript", acks: true, client: expect.any(String) });

    expect(() => t.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}')).toThrow(/starting/);
    t.send('{"jsonrpc":"2.0","method":"initialized"}'); // a notification is dropped, not thrown

    ws.say(ready);
    expect(t.state).toMatchObject({ status: "ready", rootUri: "file:///repo", server: { id: "typescript" } });
    const got: string[] = [];
    t.subscribe((m) => got.push(m));
    const message = '{"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{"type":"not a control frame"}}';
    ws.onmessage?.({ data: message });
    expect(got).toEqual([message]);
    t.send('{"jsonrpc":"2.0","id":2,"method":"x"}');
    expect(ws.sent.at(-1)).toBe('{"jsonrpc":"2.0","id":2,"method":"x"}');
    expect(states).toEqual(["starting", "ready"]);
    t.dispose();
    expect(ws.closed).toBe(true);
  });

  test("reconnects with backoff after a drop and goes ready again", async () => {
    const { t, states } = transport();
    await until(() => FakeWebSocket.all.length === 1, "socket");
    FakeWebSocket.last.open();
    FakeWebSocket.last.say(ready);
    FakeWebSocket.last.drop();
    expect(t.state.status).toBe("starting");
    await until(() => FakeWebSocket.all.length === 2, "reconnect");
    FakeWebSocket.last.open();
    FakeWebSocket.last.say(ready);
    expect(states).toEqual(["starting", "ready", "starting", "ready"]);
    t.dispose();
  });

  test("a crash restart reports restarting, then ready; giving up is final until retry", async () => {
    const { t, states } = transport();
    await until(() => FakeWebSocket.all.length === 1, "socket");
    const ws = FakeWebSocket.last;
    ws.open();
    ws.say(ready);
    ws.say({ type: "exit", code: 1, restarting: true, reason: "boom" });
    expect(t.state).toMatchObject({ status: "restarting", reason: "boom" });
    ws.say(ready);
    ws.say({ type: "exit", code: null, signal: "SIGSEGV", restarting: false });
    ws.drop();
    expect(t.state).toMatchObject({ status: "crashed", reason: "killed by SIGSEGV" });
    await new Promise((r) => setTimeout(r, 40));
    expect(FakeWebSocket.all.length).toBe(1);
    t.retry();
    await until(() => FakeWebSocket.all.length === 2, "manual retry");
    expect(states).toEqual(["starting", "ready", "restarting", "ready", "crashed", "starting"]);
    t.dispose();
  });

  test("unavailable carries the install hint and stops reconnecting", async () => {
    const { t } = transport();
    await until(() => FakeWebSocket.all.length === 1, "socket");
    FakeWebSocket.last.open();
    FakeWebSocket.last.say({ type: "unavailable", server: "typescript", reason: "not installed", install_hint: "npm i -g typescript-language-server" });
    FakeWebSocket.last.drop();
    expect(t.state).toEqual({ status: "unavailable", reason: "not installed", installHint: "npm i -g typescript-language-server" });
    await new Promise((r) => setTimeout(r, 40));
    expect(FakeWebSocket.all.length).toBe(1);
    t.dispose();
  });

  test("acks what it has read every 256K chars, counting every frame", async () => {
    const { t } = transport();
    await until(() => FakeWebSocket.all.length === 1, "socket");
    const ws = FakeWebSocket.last;
    ws.open();
    ws.say(ready);
    const big = JSON.stringify({ jsonrpc: "2.0", method: "x", params: { pad: "y".repeat(100 * 1024) } });
    for (let i = 0; i < 7; i++) ws.onmessage?.({ data: big });
    const acks = ws.json().filter((m) => m.type === "ack");
    // ~100K a message: 256K more is read after the 3rd and again after the 6th.
    const upTo = (n: number) => JSON.stringify(ready).length + big.length * n;
    expect(acks.map((a) => a.chars)).toEqual([upTo(3), upTo(6)]);
    t.dispose();
  });

  test("a request met by silence marks the connection unresponsive; anything heard clears it", async () => {
    const { t } = transport({ responseDeadlineMs: 20 });
    await until(() => FakeWebSocket.all.length === 1, "socket");
    const ws = FakeWebSocket.last;
    ws.open();
    ws.say(ready);
    // A notification expects nothing back.
    t.send('{"jsonrpc":"2.0","method":"textDocument/didChange","params":{}}');
    await new Promise((r) => setTimeout(r, 40));
    expect(t.state.unresponsive).toBeUndefined();
    t.send('{"jsonrpc":"2.0","id":7,"method":"textDocument/prepareRename","params":{}}');
    await until(() => t.state.unresponsive === true, "unresponsive");
    expect(t.state.status).toBe("ready");
    ws.say({ jsonrpc: "2.0", id: 7, result: null });
    expect(t.state.unresponsive).toBeUndefined();
    t.dispose();
  });

  test("only the request's own response settles it: notifications and other answers do not", async () => {
    const { t } = transport({ responseDeadlineMs: 20 });
    await until(() => FakeWebSocket.all.length === 1, "socket");
    const ws = FakeWebSocket.last;
    ws.open();
    ws.say(ready);
    t.send('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
    ws.say({ jsonrpc: "2.0", result: { capabilities: {} }, id: 1 }); // id last
    t.send('{"jsonrpc":"2.0","id":2,"method":"textDocument/hover","params":{}}');
    t.send('{"jsonrpc":"2.0","id":3,"method":"textDocument/definition","params":{}}');
    ws.say({ jsonrpc: "2.0", id: 3, result: [] });
    // The server keeps talking, and even sends a request of its own with id 2.
    const chatter = setInterval(() => {
      ws.say({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///a", diagnostics: [] } });
      ws.say({ jsonrpc: "2.0", method: "workspace/configuration", params: { items: [] }, id: 2 });
    }, 5);
    try {
      await until(() => t.state.unresponsive === true, "unresponsive while chattering");
    } finally {
      clearInterval(chatter);
    }
    ws.say({ jsonrpc: "2.0", id: 2, result: null });
    expect(t.state.unresponsive).toBeUndefined();
    t.dispose();
  });

  test("a cold server gets longer for its first answer, and open progress holds the chip", async () => {
    const { t } = transport({ responseDeadlineMs: 20 });
    await until(() => FakeWebSocket.all.length === 1, "socket");
    const ws = FakeWebSocket.last;
    ws.open();
    ws.say(ready);
    t.send('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
    await new Promise((r) => setTimeout(r, 45));
    expect(t.state.unresponsive).toBeUndefined(); // 4x grace before any answer
    ws.say({ jsonrpc: "2.0", id: 1, result: {} });
    ws.say({ jsonrpc: "2.0", method: "$/progress", params: { token: "load", value: { kind: "begin", title: "Loading" } } });
    t.send('{"jsonrpc":"2.0","id":2,"method":"textDocument/hover","params":{}}');
    await new Promise((r) => setTimeout(r, 60));
    expect(t.state.unresponsive).toBeUndefined();
    ws.say({ jsonrpc: "2.0", method: "$/progress", params: { token: "load", value: { kind: "end" } } });
    await until(() => t.state.unresponsive === true, "unresponsive after progress ends");
    t.dispose();
  });

  test("Restart on an unresponsive socket replaces it with a fresh hello", async () => {
    const { t } = transport({ responseDeadlineMs: 10 });
    await until(() => FakeWebSocket.all.length === 1, "socket");
    const first = FakeWebSocket.last;
    first.open();
    first.say(ready);
    t.send('{"jsonrpc":"2.0","id":1,"method":"textDocument/hover","params":{}}');
    await until(() => t.state.unresponsive === true, "unresponsive");
    expect(t.restartServer()).toBe(true);
    // No restart frame into a socket that stopped answering.
    expect(first.json().some((m) => m.type === "restart")).toBe(false);
    expect(first.closed).toBe(true);
    await until(() => FakeWebSocket.all.length === 2, "new socket");
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.json()[0]).toMatchObject({ type: "hello", fresh: true });
    FakeWebSocket.last.say(ready);
    expect(t.state).toMatchObject({ status: "ready" });
    expect(t.state.unresponsive).toBeUndefined();
    t.dispose();
  });

  test("a restart frame the daemon never answers falls back to a fresh socket", async () => {
    const { t } = transport({ restartWatchdogMs: 10 });
    await until(() => FakeWebSocket.all.length === 1, "socket");
    const first = FakeWebSocket.last;
    first.open();
    first.say(ready);
    expect(t.restartServer()).toBe(true);
    expect(first.json().some((m) => m.type === "restart")).toBe(true);
    await until(() => FakeWebSocket.all.length === 2, "fresh socket after the watchdog");
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.json()[0]).toMatchObject({ fresh: true, client: first.json()[0].client });
    // A later reconnect is an ordinary one.
    FakeWebSocket.last.say(ready);
    FakeWebSocket.last.drop();
    await until(() => FakeWebSocket.all.length === 3, "reconnect");
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.json()[0].fresh).toBeUndefined();
    t.dispose();
  });

  test("a restart the daemon answers keeps the socket", async () => {
    const { t } = transport({ restartWatchdogMs: 10 });
    await until(() => FakeWebSocket.all.length === 1, "socket");
    const ws = FakeWebSocket.last;
    ws.open();
    ws.say(ready);
    t.restartServer();
    ws.say({ type: "exit", code: null, signal: "SIGTERM", restarting: true, reason: "restarted" });
    ws.say(ready);
    await new Promise((r) => setTimeout(r, 40));
    expect(FakeWebSocket.all.length).toBe(1);
    t.dispose();
  });

  test("with no daemon it reports offline and keeps looking", async () => {
    let ep: typeof endpoint | null = null;
    const { t, states } = transport({ endpoint: () => ep });
    await until(() => t.state.status === "offline", "offline");
    ep = endpoint;
    await until(() => FakeWebSocket.all.length === 1, "socket once a daemon appears");
    expect(states[0]).toBe("starting");
    expect(states.filter((s) => s === "offline").length).toBe(1);
    t.dispose();
  });
});

describe("LSP client pool", () => {
  const realFetch = globalThis.fetch;

  function setup() {
    globalThis.fetch = (async (url: string) => {
      expect(String(url)).toContain("/lsp/servers?vault=v1");
      return new Response(JSON.stringify({ servers: [server, { id: "rust-analyzer", name: "rust-analyzer", languages: ["rust"], available: false, install_hint: "rustup component add rust-analyzer" }] }));
    }) as typeof fetch;
    configureLspPool({ endpoint: () => endpoint, idleMs: 1000, transport: { WebSocket: WS, retryInitialMs: 5 } });
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
    configureLspPool({});
  });

  /** Answer the client's initialize on the given socket. */
  function answerInitialize(ws: FakeWebSocket) {
    const init = ws.json().findLast((m) => m.method === "initialize");
    ws.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: init.id, result: { capabilities: { textDocumentSync: 1 } } }) });
    return init;
  }

  test("one shared client per server, initialized on every ready", async () => {
    setup();
    const states: LspPoolState["status"][] = [];
    const unsubscribe = subscribeLspState("v1", "typescript", (s) => states.push(s.status));
    const first = getLspClient("v1", "typescript");
    await until(() => FakeWebSocket.all.length === 1, "socket");
    const ws = FakeWebSocket.last;
    ws.open();
    ws.say(ready);
    const client = await first;
    expect(client).not.toBeNull();
    expect(await getLspClient("v1", "typescript")).toBe(client);
    expect(FakeWebSocket.all.length).toBe(1);

    const init = answerInitialize(ws);
    expect(init.params.rootUri).toBe("file:///repo");
    await client!.initializing;
    await tick();
    expect(states.at(-1)).toBe("ready");
    expect(ws.json().filter((m) => m.method === "initialized").length).toBe(1);

    // Crash restart: the same client initializes again on the next ready.
    ws.say({ type: "exit", code: 1, restarting: true });
    expect(states.at(-1)).toBe("restarting");
    ws.say(ready);
    expect(ws.json().filter((m) => m.method === "initialize").length).toBe(2);
    answerInitialize(ws);
    await client!.initializing;
    await tick();
    expect(states.at(-1)).toBe("ready");
    unsubscribe();
  });

  test("going unresponsive and back keeps the client connected, with no second initialize", async () => {
    setup();
    configureLspPool({ endpoint: () => endpoint, idleMs: 1000, transport: { WebSocket: WS, retryInitialMs: 5, responseDeadlineMs: 15 } });
    const seen: LspPoolState[] = [];
    subscribeLspState("v1", "typescript", (s) => seen.push(s));
    const pending = getLspClient("v1", "typescript");
    await until(() => FakeWebSocket.all.length === 1, "socket");
    const ws = FakeWebSocket.last;
    ws.open();
    ws.say(ready);
    const client = (await pending)!;
    answerInitialize(ws);
    await client.initializing;
    await tick();
    void client.request("textDocument/hover", {}).catch(() => {});
    await until(() => seen.at(-1)?.unresponsive === true, "unresponsive");
    expect(seen.at(-1)?.status).toBe("ready");
    // A notification proves nothing; the hover's own answer does.
    ws.say({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: "alive" } });
    expect(seen.at(-1)?.unresponsive).toBe(true);
    const hover = ws.json().find((m) => m.method === "textDocument/hover");
    ws.say({ jsonrpc: "2.0", id: hover.id, result: null });
    expect(seen.at(-1)?.unresponsive).toBeUndefined();
    expect(ws.json().filter((m) => m.method === "initialize").length).toBe(1);
  });

  test("a language with no installed server gets null and its install hint", async () => {
    setup();
    expect(await getLspClient("v1", "rust")).toBeNull();
    const seen: LspPoolState[] = [];
    subscribeLspState("v1", "rust", (s) => seen.push(s));
    await until(() => seen.length === 1, "state");
    expect(seen[0]).toMatchObject({ status: "unavailable", serverId: "rust-analyzer", installHint: "rustup component add rust-analyzer" });
    expect(FakeWebSocket.all.length).toBe(0);
  });

  test("a server that failed before its first client is asked about again, and swept meanwhile", async () => {
    setup();
    const first = getLspClient("v1", "typescript");
    await until(() => FakeWebSocket.all.length === 1, "socket");
    FakeWebSocket.last.open();
    FakeWebSocket.last.say({ type: "unavailable", server: "typescript", reason: "crashed 4 times in 5 minutes; try again in 30s" });
    expect(await first).toBeNull();

    const second = getLspClient("v1", "typescript");
    await until(() => FakeWebSocket.all.length === 2, "a fresh socket on the next ask");
    FakeWebSocket.last.open();
    FakeWebSocket.last.say(ready);
    expect(await second).not.toBeNull();

    // A failed entry nobody asks about again does not live forever.
    disposeLspPool();
    const third = getLspClient("v1", "typescript");
    await until(() => FakeWebSocket.all.length === 3, "socket");
    const ws = FakeWebSocket.last;
    ws.open();
    ws.say({ type: "unavailable", server: "typescript", reason: "nope" });
    await third;
    const now = Date.now();
    sweepIdleLspClients(now);
    sweepIdleLspClients(now + 1000);
    expect(ws.closed).toBe(true);
  });

  test("a client with no open files is disposed after the idle period", async () => {
    setup();
    const pending = getLspClient("v1", "typescript");
    await until(() => FakeWebSocket.all.length === 1, "socket");
    const ws = FakeWebSocket.last;
    ws.open();
    ws.say(ready);
    await pending;
    const now = Date.now();
    sweepIdleLspClients(now);
    sweepIdleLspClients(now + 999);
    expect(ws.closed).toBe(false);
    sweepIdleLspClients(now + 1000);
    expect(ws.closed).toBe(true);
  });

  test("disposing an idle client tells editors to reattach and drops what it published", async () => {
    setup();
    let reattached = 0;
    const down: unknown[] = [];
    configureLspPool({ endpoint: () => endpoint, idleMs: 1000, transport: { WebSocket: WS, retryInitialMs: 5 }, reattach: () => reattached++, onClientDown: (c) => down.push(c) });
    const pending = getLspClient("v1", "typescript");
    await until(() => FakeWebSocket.all.length === 1, "socket");
    FakeWebSocket.last.open();
    FakeWebSocket.last.say(ready);
    const client = await pending;
    const now = Date.now();
    sweepIdleLspClients(now);
    sweepIdleLspClients(now + 1000);
    await tick();
    expect(down).toEqual([client]);
    expect(reattached).toBe(1);
    // The next ask is a fresh client, not the disposed one.
    const next = getLspClient("v1", "typescript");
    await until(() => FakeWebSocket.all.length === 2, "a fresh socket");
    FakeWebSocket.last.open();
    FakeWebSocket.last.say(ready);
    expect(await next).not.toBe(client);
  });

  test("a crash drops what the server published; a retried failure and a newly installed server reattach", async () => {
    let installed = false;
    globalThis.fetch = (async () => new Response(JSON.stringify({ servers: [{ ...server, available: installed }] }))) as unknown as typeof fetch;
    let reattached = 0;
    const down: unknown[] = [];
    configureLspPool({ endpoint: () => endpoint, transport: { WebSocket: WS, retryInitialMs: 5 }, serversTtlMs: 0, reattach: () => reattached++, onClientDown: (c) => down.push(c) });
    expect(await getLspClient("v1", "typescript")).toBeNull();
    installed = true;
    const pending = getLspClient("v1", "typescript");
    await until(() => reattached === 1, "reattach on a newly installed server");
    await until(() => FakeWebSocket.all.length === 1, "socket");
    FakeWebSocket.last.open();
    FakeWebSocket.last.say(ready);
    const client = await pending;
    FakeWebSocket.last.say({ type: "exit", code: 1, restarting: true });
    expect(down).toEqual([client]);

    // A server that failed before it had a client: Try again lets editors ask anew.
    disposeLspPool();
    await tick();
    reattached = 0;
    installed = true;
    const failing = getLspClient("v1", "typescript");
    await until(() => FakeWebSocket.all.length === 2, "socket");
    FakeWebSocket.last.open();
    FakeWebSocket.last.say({ type: "unavailable", server: "typescript", reason: "nope" });
    expect(await failing).toBeNull();
    const { retryLsp } = await import("./pool");
    retryLsp("v1", "typescript");
    await tick();
    expect(reattached).toBe(1);
  });

  test("Restart while the hello goes unanswered reconnects with a fresh hello", async () => {
    setup();
    const { restartLsp } = await import("./pool");
    void getLspClient("v1", "typescript");
    await until(() => FakeWebSocket.all.length === 1, "socket");
    const first = FakeWebSocket.last;
    first.open(); // hello sent, never answered: still starting
    restartLsp("v1", "typescript");
    expect(first.closed).toBe(true);
    await until(() => FakeWebSocket.all.length === 2, "fresh socket");
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.json()[0]).toMatchObject({ type: "hello", fresh: true });
  });
});

