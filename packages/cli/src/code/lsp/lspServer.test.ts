// /lsp/ws and /lsp/servers end to end over a standalone loopback server, with a
// fake language server (fixtures/fakeLanguageServer.ts) found through the real
// detection path. Never touches the daemon running on this machine.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as net from "net";
import { EventEmitter } from "events";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import type { LspServersResponse } from "@codecast/shared/contracts";
import { pollUntil } from "../../test-helpers/pollUntil.js";
import { addVault } from "../../vault/vaultRegistry.js";
import { attachLspServer, handleLspHttp, type LspServerOptions, type LspTuning } from "./lspServer.js";
import { LspInstance, type LspInstanceHost } from "./lspInstance.js";
import { clearLspDetectionCache, lspServerInfo, type LspServerSpec } from "./registry.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const ORIGIN = "http://localhost:3000";
const FIXTURE = path.join(import.meta.dir, "fixtures", "fakeLanguageServer.ts");
/** Tests that start server processes fail on a hang, not on a loaded machine. */
const PROCESS_TEST_MS = 20_000;

let base = "";
let configDir = "";
let root = "";
let vaultId = "";
let binDir = "";
let server: http.Server;
let handle: { close(): void } | null = null;
let port = 0;
const logs: string[] = [];
const sockets: Array<{ terminate(): void }> = [];

function specs(): LspServerSpec[] {
  return [
    { id: "fake", name: "Fake", languages: ["fakelang"], bins: ["fake-lsp"], args: [], dirs: [binDir], install: "Install fake", initializationOptions: async () => ({ fromDaemon: { a: 1, b: 1 } }) },
    { id: "missing", name: "Missing", languages: ["nolang"], bins: ["no-such-language-server-xyz"], args: [], install: "Install missing" },
  ];
}

function opts(tuning: LspTuning = {}): LspServerOptions {
  return { token: TOKEN, log: (m) => logs.push(m), configDir, lsp: { servers: specs(), restartBaseMs: 10, ...tuning } };
}

/** Restart the routes with different tuning. */
function remount(tuning: LspTuning = {}): void {
  handle?.close();
  handle = attachLspServer(server, opts(tuning));
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-server-"));
  configDir = path.join(base, ".codecast");
  root = path.join(base, "project");
  binDir = path.join(base, "bin");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(binDir);
  const shim = path.join(binDir, "fake-lsp");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  vaultId = addVault(configDir, root, "LSP Test").id;
  clearLspDetectionCache();

  server = http.createServer((req, res) => {
    if (handleLspHttp(req, res, opts())) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  handle?.close();
  handle = null;
});

afterAll(() => {
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(base, { recursive: true, force: true });
});

interface Client {
  ws: WebSocket;
  frames: any[];
  closed: { code: number; reason: string } | null;
  next(match: (f: any) => boolean, what: string): Promise<any>;
  request(method: string, params?: unknown): Promise<any>;
  notify(method: string, params?: unknown): void;
}

let reqSeq = 0;

async function open(hello: Record<string, unknown> | null = { server: "fake" }, origin = ORIGIN): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/lsp/ws`, { headers: { Origin: origin } });
  sockets.push(ws);
  const client: Client = {
    ws,
    frames: [],
    closed: null,
    async next(match, what) {
      let found: any;
      await pollUntil(() => {
        const i = client.frames.findIndex(match);
        if (i < 0) return false;
        found = client.frames.splice(i, 1)[0];
        return true;
      }, what);
      return found;
    },
    request(method, params) {
      const id = ++reqSeq;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return client.next((f) => f.id === id && f.method === undefined, `reply to ${method}`);
    },
    notify(method, params) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
  };
  ws.on("error", () => {});
  ws.on("message", (raw) => client.frames.push(JSON.parse(raw.toString())));
  ws.on("close", (code, reason) => (client.closed = { code, reason: reason.toString() }));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  if (hello) ws.send(JSON.stringify({ type: "hello", token: TOKEN, vault: vaultId, ...hello }));
  return client;
}

/** A WebSocket client over a raw TCP socket, so a test can stop reading the
 *  way a busy tab does (bun's client cannot pause). It acks what it reads, as
 *  the web transport does. */
async function openRaw(): Promise<{ socket: net.Socket; frames: any[]; send(obj: object): void }> {
  const socket = net.connect(port, "127.0.0.1");
  sockets.push({ terminate: () => socket.destroy() });
  const frames: any[] = [];
  let received = 0;
  let acked = 0;
  let buf = Buffer.alloc(0);
  let upgraded = false;
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      upgraded = true;
      buf = buf.subarray(end + 4);
    }
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) [len, at] = [buf.readUInt16BE(2), 4];
      else if (len === 127) [len, at] = [Number(buf.readBigUInt64BE(2)), 10];
      if (buf.length < at + len) return;
      const text = buf.subarray(at, at + len).toString("utf8");
      buf = buf.subarray(at + len);
      frames.push(JSON.parse(text));
      received += text.length;
      if (received - acked >= 256 * 1024) send({ type: "ack", chars: (acked = received) });
    }
  });
  function send(obj: object): void {
    const body = Buffer.from(JSON.stringify(obj));
    const head = body.length < 126 ? Buffer.from([0x81, 0x80 | body.length]) : Buffer.from([0x81, 0x80 | 126, body.length >> 8, body.length & 0xff]);
    // A zero mask leaves the payload as is.
    socket.write(Buffer.concat([head, Buffer.alloc(4), body]));
  }
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(
    `GET /lsp/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.alloc(16, 1).toString("base64")}\r\nOrigin: ${ORIGIN}\r\n\r\n`,
  );
  await pollUntil(() => upgraded, "upgrade");
  return { socket, frames, send };
}

async function initialize(c: Client): Promise<any> {
  const reply = await c.request("initialize", { capabilities: {}, rootUri: null, initializationOptions: { fromDaemon: { b: 2 }, fromClient: true } });
  c.notify("initialized", {});
  return reply.result;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("GET /lsp/servers", () => {
  test("lists each server with availability, its command or an install hint", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/lsp/servers?vault=${vaultId}`, { headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LspServersResponse;
    const byId = Object.fromEntries(body.servers.map((s) => [s.id, s]));
    expect(byId.fake).toMatchObject({ available: true, command: path.join(binDir, "fake-lsp"), running: false, languages: ["fakelang"] });
    expect(byId.missing).toMatchObject({ available: false, install_hint: "Install missing" });
  });

  test("refuses a request without the bearer", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/lsp/servers?vault=${vaultId}`, { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(403);
  });
});

describe("WS /lsp/ws", () => {
  test("refuses a foreign origin at the handshake", async () => {
    remount();
    // node's ws reports the 403; bun's reports the connection ending.
    await expect(open(null, "https://evil.example")).rejects.toThrow(/403|Connection ended/);
    expect(logs.some((l) => l.includes("Rejected WS from origin https://evil.example"))).toBe(true);
  });

  test("refuses a bad token", async () => {
    remount();
    const c = await open({ server: "fake", token: "nope" });
    await pollUntil(() => c.closed !== null, "close");
    expect(c.closed!.code).toBe(4000);
    expect(c.frames).toContainEqual({ type: "error", message: "forbidden" });
  });

  test("closes a socket that never says hello", async () => {
    remount({ helloTimeoutMs: 50 });
    const c = await open(null);
    await pollUntil(() => c.closed !== null, "close");
    expect(c.closed!.reason).toBe("hello timeout");
  });

  test("reports a missing server as unavailable with its install hint", async () => {
    remount();
    const c = await open({ language: "nolang" });
    const frame = await c.next((f) => f.type === "unavailable", "unavailable");
    expect(frame).toMatchObject({ server: "missing", install_hint: "Install missing" });
    await pollUntil(() => c.closed !== null, "close");
  });

  test("relays JSON-RPC both ways and fills in what the browser cannot know", async () => {
    remount();
    const c = await open({ language: "fakelang" });
    const ready = await c.next((f) => f.type === "ready", "ready");
    expect(ready.server).toMatchObject({ id: "fake", running: true });
    // The real path: the temp dir sits behind a symlink on macOS (/var ->
    // /private/var), and servers report canonical paths.
    expect(ready.root_uri).toBe(`file://${fs.realpathSync(root)}`);

    const result = await initialize(c);
    expect(result.params.processId).toBe(process.pid);
    expect(result.params.rootUri).toBe(ready.root_uri);
    expect(result.params.workspaceFolders).toEqual([{ uri: ready.root_uri, name: "project" }]);
    // The client's options win over the daemon's defaults, key by key.
    expect(result.params.initializationOptions).toEqual({ fromDaemon: { a: 1, b: 2 }, fromClient: true });

    const diag = await c.next((f) => f.method === "textDocument/publishDiagnostics", "diagnostics");
    expect(diag.params.diagnostics[0].message).toBe("fake diagnostic");

    // Large and multi-byte: crosses many pipe chunks with characters split between them.
    const text = "héllo 🌍 日本 ".repeat(40_000);
    expect((await c.request("fake/echo", { text })).result.text).toBe(text);

    // A request from the server reaches the browser, and its answer goes back.
    const ask = c.request("fake/ask");
    const configRequest = await c.next((f) => f.method === "workspace/configuration", "server request");
    c.ws.send(JSON.stringify({ jsonrpc: "2.0", id: configRequest.id, result: [{ tabSize: 2 }] }));
    expect((await ask).result.result).toEqual([{ tabSize: 2 }]);

    const res = await fetch(`http://127.0.0.1:${port}/lsp/servers?vault=${vaultId}`, { headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}` } });
    const body = (await res.json()) as LspServersResponse;
    expect(body.servers.find((s) => s.id === "fake")?.running).toBe(true);
  }, PROCESS_TEST_MS);

  test("a reload inside the grace period reattaches to the warm process", async () => {
    remount({ graceMs: 30_000 });
    const first = await open();
    await first.next((f) => f.type === "ready", "ready");
    const { pid } = await initialize(first);
    first.notify("textDocument/didOpen", { textDocument: { uri: "file:///a.ts", languageId: "fakelang", version: 1, text: "" } });
    first.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "fake/never" }));
    await pollUntil(async () => (await first.request("fake/stats")).result.open.length === 1, "didOpen");
    first.ws.close();

    const second = await open();
    await second.next((f) => f.type === "ready", "ready again");
    const again = await initialize(second);
    expect(again.pid).toBe(pid);
    // Same id as the cancelled request: renamed on the wire, answered as 7.
    second.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "fake/stats" }));
    const stats = (await second.next((f) => f.id === 7, "stats")).result;
    expect(stats).toMatchObject({ pid, initialize: 1, initialized: 1, open: [], cancelled: [7] });
  }, PROCESS_TEST_MS);

  test("a burst past the socket buffer keeps the relay flowing", async () => {
    remount();
    const c = await open();
    await c.next((f) => f.type === "ready", "ready");
    await initialize(c);
    // 24 MB of notifications plus a 5 MB answer: past every high-water mark,
    // and an answer too big for the daemon to parse just to read its id.
    const flood = await c.request("fake/flood", { count: 24, bytes: 1024 * 1024, answerBytes: 5 * 1024 * 1024 });
    expect(flood.result.chunk.length).toBe(5 * 1024 * 1024);
    expect(c.frames.filter((f) => f.method === "fake/flooded")).toHaveLength(24);
    expect((await c.request("fake/echo", { after: true })).result).toEqual({ after: true });
  }, PROCESS_TEST_MS);

  test("a tab that stops reading through a burst gets everything once it catches up", async () => {
    remount();
    const c = await openRaw();
    c.send({ type: "hello", token: TOKEN, vault: vaultId, server: "fake", acks: true });
    await pollUntil(() => c.frames.some((f) => f.type === "ready"), "ready");
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
    await pollUntil(() => c.frames.some((f) => f.id === 1), "initialize");
    c.socket.pause();
    c.send({ jsonrpc: "2.0", id: 2, method: "fake/flood", params: { count: 40, bytes: 1024 * 1024 } });
    // Long enough for the whole burst to reach the daemon and stall there.
    await new Promise((r) => setTimeout(r, 1500));
    c.socket.resume();
    await pollUntil(() => c.frames.some((f) => f.id === 2), "flood answer", { ms: 20_000 });
    expect(c.frames.filter((f) => f.method === "fake/flooded")).toHaveLength(40);
    c.send({ jsonrpc: "2.0", id: 3, method: "fake/echo", params: { after: true } });
    await pollUntil(() => c.frames.some((f) => f.id === 3), "answer after the burst", { ms: 10_000 });
  }, PROCESS_TEST_MS * 2);

  test("a big late answer to a request whose editor left is dropped, not handed to the next one", async () => {
    remount({ graceMs: 30_000 });
    const first = await open();
    await first.next((f) => f.type === "ready", "ready");
    await initialize(first);
    first.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "fake/flood", params: { answerBytes: 5 * 1024 * 1024, delayMs: 400 } }));
    await first.request("fake/stats");
    first.ws.close();

    const second = await open();
    await second.next((f) => f.type === "ready", "ready again");
    await initialize(second);
    // Same id as the orphan: renamed on the wire, and the stale 5 MB answer
    // to the old 9 must not resolve it.
    second.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "fake/flood", params: { delayMs: 800 } }));
    const answer = await second.next((f) => f.id === 9, "answer to 9");
    expect(answer.result.chunk).toBe("");
    expect((await second.request("fake/echo", { after: true })).result).toEqual({ after: true });
    expect(second.frames.some((f) => f.id === 9)).toBe(false);
  }, PROCESS_TEST_MS);

  test("an initialize answered after its editor left reaches the next editor once", async () => {
    remount({ graceMs: 30_000 });
    const first = await open();
    await first.next((f) => f.type === "ready", "ready");
    first.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 101, method: "initialize", params: { capabilities: {}, initializationOptions: { delayMs: 400 } } }));
    await first.request("fake/stats");
    first.ws.close();

    const second = await open();
    await second.next((f) => f.type === "ready", "ready again");
    second.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 102, method: "initialize", params: { capabilities: {} } }));
    expect((await second.next((f) => f.id === 102, "initialize answer")).result.pid).toBeNumber();
    expect((await second.request("fake/stats")).result.initialize).toBe(1);
    expect(second.frames.some((f) => f.id === 101)).toBe(false);
  }, PROCESS_TEST_MS);

  test("an instance disposed while its process spawns kills that process", async () => {
    const pidFile = path.join(base, "spawned.pid");
    const host: LspInstanceHost = { log: () => {}, allowRestart: () => false, restartDelayMs: () => 0, parked: () => {}, gone: () => {} };
    const launch = { command: process.execPath, args: [FIXTURE], env: { ...process.env, FAKE_LSP_PIDFILE: pidFile } };
    const inst = new LspInstance("k", vaultId, root, `file://${root}`, lspServerInfo(specs()[0], process.execPath), launch, host);
    const starting = inst.start();
    inst.dispose();
    await expect(starting).rejects.toThrow(/closed while starting/);
    // Killed at spawn it never gets to write its pid; if it did, it must be gone.
    await new Promise((r) => setTimeout(r, 500));
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : 0;
    if (pid) await pollUntil(() => !alive(pid), "process killed");
    expect(inst.alive).toBe(false);
  }, PROCESS_TEST_MS);

  test("a process with no socket dies when the grace period ends", async () => {
    remount({ graceMs: 100 });
    const c = await open();
    await c.next((f) => f.type === "ready", "ready");
    const { pid } = await initialize(c);
    c.ws.close();
    await pollUntil(() => !alive(pid), "grace kill", { ms: 5000 });
  }, PROCESS_TEST_MS);

  test("a crash restarts the server and the client initializes again", async () => {
    remount();
    const c = await open();
    await c.next((f) => f.type === "ready", "ready");
    const { pid } = await initialize(c);

    const crash = await c.request("fake/crash");
    expect(crash.error.message).toBe("language server exited");
    const exit = await c.next((f) => f.type === "exit", "exit");
    expect(exit).toMatchObject({ code: 3, restarting: true, reason: "boom: magic crash" });
    await c.next((f) => f.type === "ready", "ready after restart");
    const fresh = await initialize(c);
    expect(fresh.pid).not.toBe(pid);
  }, PROCESS_TEST_MS);

  test("a server that keeps crashing is given up on, and refused until the window passes", async () => {
    remount({ maxRestarts: 1 });
    const c = await open();
    await c.next((f) => f.type === "ready", "ready");
    await initialize(c);
    await c.request("fake/crash");
    expect((await c.next((f) => f.type === "exit", "first exit")).restarting).toBe(true);
    await c.next((f) => f.type === "ready", "restarted");
    await initialize(c);
    await c.request("fake/crash");
    expect((await c.next((f) => f.type === "exit", "second exit")).restarting).toBe(false);
    await pollUntil(() => c.closed !== null, "close");
    expect(c.closed!.code).toBe(4002);

    const retry = await open();
    const refused = await retry.next((f) => f.type === "unavailable", "refused");
    expect(refused.reason).toMatch(/crashed 2 times/);
  }, PROCESS_TEST_MS);

  test("a restart asked for by the browser starts a fresh process without counting a crash", async () => {
    remount({ maxRestarts: 0 });
    const c = await open();
    await c.next((f) => f.type === "ready", "ready");
    const { pid } = await initialize(c);
    for (const round of [1, 2]) {
      c.ws.send(JSON.stringify({ type: "restart" }));
      const exit = await c.next((f) => f.type === "exit", `exit ${round}`);
      expect(exit).toMatchObject({ restarting: true, reason: "restarted" });
      await c.next((f) => f.type === "ready", `ready after restart ${round}`);
      const fresh = await initialize(c);
      expect(fresh.pid).not.toBe(pid);
      await pollUntil(() => !alive(pid), "old process gone");
    }
    // maxRestarts 0 would have given up on a crash; two asked-for restarts did not.
    expect(c.closed).toBeNull();
  }, PROCESS_TEST_MS);

  test("a cancel for a request renamed on the wire reaches the server under the wire id", async () => {
    remount({ graceMs: 30_000 });
    const first = await open();
    await first.next((f) => f.type === "ready", "ready");
    await initialize(first);
    first.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "fake/never" }));
    await first.request("fake/stats");
    first.ws.close();

    const second = await open();
    await second.next((f) => f.type === "ready", "ready again");
    await initialize(second);
    // 5 is still an orphan in flight, so this 5 is renamed on the way in.
    second.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "fake/never" }));
    second.notify("$/cancelRequest", { id: 5 });
    const stats = (await second.request("fake/stats")).result;
    // The orphan's cancel (5, from the detach) and this one, under its wire id.
    expect(stats.cancelled[0]).toBe(5);
    expect(stats.cancelled[1]).toMatch(/^codecast-\d+$/);
  }, PROCESS_TEST_MS);

  test("a server that stops reading keeps the socket flowing, and a Restart behind its backlog still lands", async () => {
    // A socket that honors pause() the way node's ws does (the npm build
    // bundles it): while paused, frames wait, including the Restart.
    class PausableSocket extends EventEmitter {
      readyState: number = WebSocket.OPEN;
      sent: any[] = [];
      paused = false;
      private waiting: string[] = [];
      send(data: string) {
        this.sent.push(JSON.parse(data));
      }
      close() {
        this.readyState = WebSocket.CLOSED;
      }
      pause() {
        this.paused = true;
      }
      resume() {
        this.paused = false;
        for (const t of this.waiting.splice(0)) this.emit("message", Buffer.from(t), false);
      }
      deliver(obj: object) {
        const t = JSON.stringify(obj);
        if (this.paused) this.waiting.push(t);
        else this.emit("message", Buffer.from(t), false);
      }
    }
    const host: LspInstanceHost = { log: (m) => logs.push(m), allowRestart: () => true, restartDelayMs: () => 0, parked: () => {}, gone: () => {} };
    const launch = { command: process.execPath, args: [FIXTURE], env: { ...process.env } };
    const inst = new LspInstance("k-pause", vaultId, root, `file://${root}`, lspServerInfo(specs()[0], process.execPath), launch, host);
    await inst.start();
    const ws = new PausableSocket();
    inst.attach(ws as unknown as WebSocket, { acks: true });
    const reply = (id: number) => pollUntil(() => ws.sent.some((f) => f.id === id), `reply ${id}`);
    ws.deliver({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
    await reply(1);
    ws.deliver({ jsonrpc: "2.0", id: 2, method: "fake/stall", params: { ms: 60_000 } });
    await reply(2);
    // Far more than a pipe holds: the writes back up behind the stalled server.
    const text = "z".repeat(512 * 1024);
    for (let i = 0; i < 12; i++) ws.deliver({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: `file:///big${i}.ts`, languageId: "fakelang", version: 1, text } } });
    await pollUntil(() => inst.stdinQueued > 0, "backlog");
    expect(ws.paused).toBe(false);
    ws.deliver({ type: "restart" });
    await pollUntil(() => ws.sent.some((f) => f.type === "exit"), "exit after restart");
    expect(ws.sent.find((f) => f.type === "exit")).toMatchObject({ restarting: true, reason: "restarted" });
    await pollUntil(() => ws.sent.filter((f) => f.type === "ready").length === 2, "ready after restart");
    expect(inst.stdinQueued).toBe(0);
    inst.dispose();
  }, PROCESS_TEST_MS);

  test("a server that lets its input back up past the cap is killed and restarted", async () => {
    remount({ stdinMaxQueued: 2 * 1024 * 1024 });
    const c = await open();
    await c.next((f) => f.type === "ready", "ready");
    const { pid } = await initialize(c);
    await c.request("fake/stall", { ms: 60_000 });
    const text = "z".repeat(512 * 1024);
    for (let i = 0; i < 12; i++) c.notify("textDocument/didOpen", { textDocument: { uri: `file:///big${i}.ts`, languageId: "fakelang", version: 1, text } });
    const exit = await c.next((f) => f.type === "exit", "exit");
    expect(exit.restarting).toBe(true);
    expect(logs.some((l) => l.includes("stopped reading its input"))).toBe(true);
    await c.next((f) => f.type === "ready", "ready after the kill");
    expect((await initialize(c)).pid).not.toBe(pid);
    await pollUntil(() => !alive(pid), "old process gone");
  }, PROCESS_TEST_MS);

  test("a fresh hello never reattaches, and kills only the processes its client held", async () => {
    remount({ graceMs: 30_000 });
    // Parked when the fresh hello arrives.
    const a = await open({ server: "fake", client: "tab-1" });
    await a.next((f) => f.type === "ready", "ready a");
    const { pid: pidA } = await initialize(a);
    a.ws.close();
    const b = await open({ server: "fake", fresh: true, client: "tab-1" });
    await b.next((f) => f.type === "ready", "ready b");
    const { pid: pidB } = await initialize(b);
    expect(pidB).not.toBe(pidA);
    await pollUntil(() => !alive(pidA), "parked process killed");

    // Another window, attached throughout.
    const other = await open({ server: "fake", fresh: true, client: "tab-2" });
    await other.next((f) => f.type === "ready", "ready other");
    const { pid: pidOther } = await initialize(other);

    // Still attached when the fresh hello arrives (the old socket's close comes later).
    const c = await open({ server: "fake", fresh: true, client: "tab-1" });
    await c.next((f) => f.type === "ready", "ready c");
    const { pid: pidC } = await initialize(c);
    expect(pidC).not.toBe(pidB);
    expect(alive(pidB)).toBe(true);
    b.ws.close();
    await pollUntil(() => !alive(pidB), "replaced process killed when its socket closed", { ms: 5000 });
    // The other window's process was never this client's: when its socket
    // goes it parks for the grace period, as does the fresh one.
    other.ws.close();
    c.ws.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pidOther)).toBe(true);
    expect(alive(pidC)).toBe(true);
  }, PROCESS_TEST_MS);

  test("closing the routes kills every server", async () => {
    remount();
    const c = await open();
    await c.next((f) => f.type === "ready", "ready");
    const { pid } = await initialize(c);
    handle!.close();
    handle = null;
    await pollUntil(() => !alive(pid), "server killed");
  }, PROCESS_TEST_MS);
});
