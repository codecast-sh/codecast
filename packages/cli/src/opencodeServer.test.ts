// Coverage for the opencode rich-transport sidecar (opencodeServer.ts):
//  (1) parseListeningPort — reads the bound port off the server's announce line;
//  (2) parseSseFrames — the SSE frame decoder (buffering, CRLF, multi-`data:`,
//      comments/heartbeats, garbage) driven by fixtures shaped like real /event
//      output;
//  (3) mapOpencodeEvent — the event→work-state mapping, keyed off REAL event
//      payloads captured live from opencode 1.18.3 (session.status/idle/permission);
//  (4) the lifecycle state machine (spawn → announce → health → ready → SSE
//      work-state, ENOENT → binaryNotFound degrade, stop) with an injected fake
//      spawn + fetch — no real `opencode serve`;
//  (5) the fork/list HTTP helpers over a mock fetch.
//
// All event payloads here are synthetic in CONTENT (no transcript text) but real in
// SHAPE — copied from the discriminators and structures opencode's OpenAPI /doc and
// live /event stream emit.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import {
  parseListeningPort,
  parseSseFrames,
  mapOpencodeEvent,
  OpencodeServer,
  type OpencodeRawEvent,
} from "./opencodeServer.js";

// ── parseListeningPort ────────────────────────────────────────────────────────

describe("parseListeningPort", () => {
  test("reads the port from opencode's announce line", () => {
    expect(parseListeningPort("opencode server listening on http://127.0.0.1:41968")).toBe(41968);
  });
  test("handles an arbitrary hostname and https", () => {
    expect(parseListeningPort("listening on https://localhost:3000")).toBe(3000);
  });
  test("returns null for unrelated log lines", () => {
    expect(parseListeningPort("level=INFO message=bootstrapping")).toBeNull();
    expect(parseListeningPort("")).toBeNull();
  });
});

// ── parseSseFrames ────────────────────────────────────────────────────────────

describe("parseSseFrames", () => {
  test("decodes a single complete frame", () => {
    const buf = 'data: {"id":"evt_1","type":"session.idle","properties":{"sessionID":"ses_a"}}\n\n';
    const { events, rest } = parseSseFrames(buf);
    expect(rest).toBe("");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("session.idle");
  });

  test("decodes multiple frames and keeps a trailing partial in rest", () => {
    const buf =
      'data: {"type":"session.status","properties":{"sessionID":"ses_a","status":{"type":"busy"}}}\n\n' +
      'data: {"type":"session.idle","properties":{"sessionID":"ses_a"}}\n\n' +
      'data: {"type":"message.part.delta",';
    const { events, rest } = parseSseFrames(buf);
    expect(events.map((e) => e.type)).toEqual(["session.status", "session.idle"]);
    expect(rest).toBe('data: {"type":"message.part.delta",');
  });

  test("resumes across chunks: a partial frame completes on the next call", () => {
    const first = parseSseFrames('data: {"type":"session.idle",');
    expect(first.events).toHaveLength(0);
    const second = parseSseFrames(first.rest + '"properties":{"sessionID":"ses_a"}}\n\n');
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.type).toBe("session.idle");
  });

  test("ignores comments/heartbeats and concatenates multi-line data", () => {
    const buf = ':heartbeat\n\n' + 'data: {"type":\ndata: "session.idle","properties":{"sessionID":"ses_a"}}\n\n';
    const { events } = parseSseFrames(buf);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("session.idle");
  });

  test("normalizes CRLF frame delimiters", () => {
    const buf = 'data: {"type":"session.idle","properties":{"sessionID":"ses_a"}}\r\n\r\n';
    const { events, rest } = parseSseFrames(buf);
    expect(events).toHaveLength(1);
    expect(rest).toBe("");
  });

  test("drops unparseable payloads without throwing", () => {
    const buf = "data: not-json\n\n" + 'data: {"type":"session.idle","properties":{"sessionID":"ses_a"}}\n\n';
    const { events } = parseSseFrames(buf);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("session.idle");
  });
});

// ── mapOpencodeEvent ──────────────────────────────────────────────────────────

describe("mapOpencodeEvent", () => {
  const ev = (type: string, properties: Record<string, unknown> = {}): OpencodeRawEvent => ({
    id: "evt_x",
    type,
    properties,
  });

  test("session.status busy → working", () => {
    const m = mapOpencodeEvent(ev("session.status", { sessionID: "ses_a", status: { type: "busy" } }));
    expect(m?.workState).toBe("working");
    expect(m?.sessionId).toBe("ses_a");
  });

  test("session.status retry → working (still active)", () => {
    expect(mapOpencodeEvent(ev("session.status", { sessionID: "ses_a", status: { type: "retry" } }))?.workState).toBe(
      "working",
    );
  });

  test("session.status idle → idle", () => {
    expect(mapOpencodeEvent(ev("session.status", { sessionID: "ses_a", status: { type: "idle" } }))?.workState).toBe(
      "idle",
    );
  });

  test("session.idle → idle (turn complete)", () => {
    expect(mapOpencodeEvent(ev("session.idle", { sessionID: "ses_a" }))?.workState).toBe("idle");
  });

  test("session.error → idle (turn ended)", () => {
    expect(mapOpencodeEvent(ev("session.error", { sessionID: "ses_a" }))?.workState).toBe("idle");
  });

  test("permission.asked → permission_blocked; replied → working", () => {
    expect(mapOpencodeEvent(ev("permission.asked", { sessionID: "ses_a" }))?.workState).toBe("permission_blocked");
    expect(mapOpencodeEvent(ev("permission.v2.asked", { sessionID: "ses_a" }))?.workState).toBe("permission_blocked");
    expect(mapOpencodeEvent(ev("permission.replied", { sessionID: "ses_a" }))?.workState).toBe("working");
  });

  test("content/metadata events carry sessionId but no workState", () => {
    const delta = mapOpencodeEvent(
      ev("message.part.delta", { sessionID: "ses_a", messageID: "msg_1", partID: "prt_1", field: "text", delta: "x" }),
    );
    expect(delta?.sessionId).toBe("ses_a");
    expect(delta?.workState).toBeUndefined();
    expect(mapOpencodeEvent(ev("session.updated", { sessionID: "ses_a" }))?.workState).toBeUndefined();
    expect(mapOpencodeEvent(ev("server.connected"))?.sessionId).toBeUndefined();
  });

  test("rejects malformed input", () => {
    expect(mapOpencodeEvent({ type: 123 } as unknown as OpencodeRawEvent)).toBeNull();
  });
});

// ── lifecycle + HTTP (injected spawn/fetch) ───────────────────────────────────

/** A fake ChildProcess whose stdout is a real Readable so readline works. */
function makeFakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = (_sig?: string) => {
    if (child.exitCode === null) child.exitCode = 0;
    return true;
  };
  return child;
}

const announce = "opencode server listening on http://127.0.0.1:45999";

/** A fetch stand-in routing by URL: healthy /global/health, an SSE /event body
 *  emitting the given frames then closing, and JSON for fork/list. */
function makeFetch(opts: { eventFrames?: string; forkId?: string; sessions?: unknown[] } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/global/health")) {
      return { ok: true, status: 200, json: async () => ({ healthy: true, version: "1.18.3" }) } as Response;
    }
    if (url.endsWith("/event")) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (opts.eventFrames) controller.enqueue(new TextEncoder().encode(opts.eventFrames));
          controller.close();
        },
      });
      return { ok: true, status: 200, body } as unknown as Response;
    }
    if (url.includes("/fork")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: opts.forkId ?? "ses_forked", title: "x (fork #1)" }),
      } as Response;
    }
    if (url.endsWith("/session")) {
      return { ok: true, status: 200, json: async () => opts.sessions ?? [] } as Response;
    }
    return { ok: false, status: 404, text: async () => "not found" } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function once(emitter: EventEmitter, event: string, timeoutMs = 2000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

describe("OpencodeServer lifecycle", () => {
  test("spawn → announce → health → ready, then SSE drives a workState, then stop", async () => {
    const child = makeFakeChild();
    const frames =
      'data: {"type":"session.status","properties":{"sessionID":"ses_a","status":{"type":"busy"}}}\n\n' +
      'data: {"type":"session.idle","properties":{"sessionID":"ses_a"}}\n\n';
    const { fetchImpl } = makeFetch({ eventFrames: frames });

    const server = new OpencodeServer({
      log: () => {},
      spawnFn: (() => child) as any,
      fetchImpl,
      healthTimeoutMs: 1000,
    });

    const workStates: [string, string][] = [];
    server.on("workState", (sid: string, st: string) => workStates.push([sid, st]));

    const ready = once(server, "ready");
    server.start();
    // Emit the announce line the way the real server does (async, on stdout).
    child.stdout.write(announce + "\n");

    const [port] = await ready;
    expect(port).toBe(45999);
    expect(server.running).toBe(true);
    expect(server.port).toBe(45999);
    expect(server.baseUrl).toBe("http://127.0.0.1:45999");

    // The SSE stream (busy then idle) should have driven two work-state emissions.
    await new Promise((r) => setTimeout(r, 50));
    expect(workStates).toEqual([
      ["ses_a", "working"],
      ["ses_a", "idle"],
    ]);

    server.stop();
    expect(server.running).toBe(false);
  });

  test("ENOENT on spawn → binaryNotFound, binaryMissing, no restart", async () => {
    const child = makeFakeChild();
    const { fetchImpl } = makeFetch();
    const server = new OpencodeServer({
      log: () => {},
      spawnFn: (() => child) as any,
      fetchImpl,
    });

    const notFound = once(server, "binaryNotFound");
    server.start();
    // Real spawn surfaces a missing binary via an async 'error' event with ENOENT.
    const err: any = new Error("spawn opencode ENOENT");
    err.code = "ENOENT";
    child.emit("error", err);

    const [bin] = await notFound;
    expect(bin).toBe("opencode");
    expect(server.binaryMissing).toBe(true);
    expect(server.running).toBe(false);
  });

  test("degrade: health never becomes healthy → error, not running", async () => {
    const child = makeFakeChild();
    // fetch that never reports healthy
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/global/health")) return { ok: false, status: 503, json: async () => ({}) } as Response;
      return { ok: false, status: 404, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    const server = new OpencodeServer({
      log: () => {},
      spawnFn: (() => child) as any,
      fetchImpl,
      healthTimeoutMs: 300,
    });

    const errored = once(server, "error");
    server.start();
    child.stdout.write(announce + "\n");

    const [e] = await errored;
    expect((e as Error).message).toContain("health check timed out");
    expect(server.running).toBe(false);
    // The never-healthy child must be KILLED, not left running (ct-39150 leak fix):
    // fake child.kill() sets exitCode, so a leaked process would still read null.
    expect(child.exitCode).not.toBeNull();
    server.stop();
  });
});

describe("OpencodeServer HTTP helpers", () => {
  async function readyServer(fetchImpl: typeof fetch) {
    const child = makeFakeChild();
    const server = new OpencodeServer({ log: () => {}, spawnFn: (() => child) as any, fetchImpl, healthTimeoutMs: 1000 });
    const ready = once(server, "ready");
    server.start();
    child.stdout.write(announce + "\n");
    await ready;
    return server;
  }

  test("fork posts to /session/:id/fork with the messageID and returns the new id", async () => {
    const { fetchImpl, calls } = makeFetch({ forkId: "ses_new123" });
    const server = await readyServer(fetchImpl);

    const forked = await server.fork("ses_parent", { messageID: "msg_cut" });
    expect(forked.id).toBe("ses_new123");

    const forkCall = calls.find((c) => c.url.includes("/fork"));
    expect(forkCall?.url).toContain("/session/ses_parent/fork");
    expect(forkCall?.init?.method).toBe("POST");
    expect(JSON.parse(String(forkCall?.init?.body))).toEqual({ messageID: "msg_cut" });

    server.stop();
  });

  test("fork WITHOUT a messageID sends an empty body (at-tip = full fork)", async () => {
    const { fetchImpl, calls } = makeFetch({ forkId: "ses_tip" });
    const server = await readyServer(fetchImpl);

    const forked = await server.fork("ses_parent");
    expect(forked.id).toBe("ses_tip");

    const forkCall = calls.find((c) => c.url.includes("/fork"));
    expect(forkCall?.url).toContain("/session/ses_parent/fork");
    // No messageID → empty JSON body, so opencode forks the full session (the tip).
    expect(JSON.parse(String(forkCall?.init?.body))).toEqual({});

    server.stop();
  });

  test("fork passes a directory override as a query param", async () => {
    const { fetchImpl, calls } = makeFetch({ forkId: "ses_new" });
    const server = await readyServer(fetchImpl);
    await server.fork("ses_parent", { directory: "/tmp/x y" });
    const forkCall = calls.find((c) => c.url.includes("/fork"));
    expect(forkCall?.url).toContain("directory=%2Ftmp%2Fx%20y");
    server.stop();
  });

  test("listSessions returns the project-scoped list", async () => {
    const { fetchImpl } = makeFetch({ sessions: [{ id: "ses_1" }, { id: "ses_2" }] });
    const server = await readyServer(fetchImpl);
    const list = await server.listSessions();
    expect(list.map((s) => s.id)).toEqual(["ses_1", "ses_2"]);
    server.stop();
  });
});

// Sidecar lifetime hardening (security critic): `opencode serve` binds 127.0.0.1 with
// NO auth, so a live instance is an unauthenticated local HTTP surface. It must NOT
// live "forever after the first fork" (idle self-teardown) and must NOT survive a hard
// daemon exit (stop on the crash/exit path). A fresh fake child per spawn lets restart
// be observed cleanly.
describe("OpencodeServer sidecar lifetime hardening", () => {
  function multiSpawn() {
    const children: any[] = [];
    const spawnFn = (() => {
      const c = makeFakeChild();
      children.push(c);
      return c;
    }) as any;
    return { children, spawnFn };
  }

  test("stops itself after the idle timeout and emits idleStopped — no lingering serve", async () => {
    const { children, spawnFn } = multiSpawn();
    const { fetchImpl } = makeFetch();
    const server = new OpencodeServer({ log: () => {}, spawnFn, fetchImpl, healthTimeoutMs: 1000, idleTimeoutMs: 120 });

    const ready = once(server, "ready");
    const idleStopped = once(server, "idleStopped");
    server.start();
    children[0].stdout.write(announce + "\n");
    await ready;
    expect(server.running).toBe(true);

    await idleStopped; // fires ~120ms after ready with no fork activity
    expect(server.running).toBe(false);
    // The serve child was actually reaped, not left running unauthenticated.
    expect(children[0].exitCode).not.toBeNull();
  });

  test("start() after a stop respawns a fresh serve child (lazy restart on the next fork)", async () => {
    const { children, spawnFn } = multiSpawn();
    const { fetchImpl } = makeFetch({ forkId: "ses_reborn" });
    // idleTimeoutMs 0 disables the idle timer so this test is purely about restart.
    const server = new OpencodeServer({ log: () => {}, spawnFn, fetchImpl, healthTimeoutMs: 1000, idleTimeoutMs: 0 });

    const firstReady = once(server, "ready");
    server.start();
    children[0].stdout.write(announce + "\n");
    await firstReady;
    server.stop(); // as the idle timeout / crash path would leave it
    expect(server.running).toBe(false);

    // ensureOpencodeServer re-start()s a stopped instance (or builds a fresh one after
    // idleStopped) — either way start() must respawn and forks must work again.
    const secondReady = once(server, "ready");
    server.start();
    children[children.length - 1].stdout.write(announce + "\n");
    await secondReady;
    expect(server.running).toBe(true);
    expect(children.length).toBe(2); // a genuinely fresh child was spawned
    const forked = await server.fork("ses_parent");
    expect(forked.id).toBe("ses_reborn");
    server.stop();
  });

  test("stop() on the crash/exit path synchronously reaps the child (no orphaned serve)", async () => {
    const child = makeFakeChild();
    const { fetchImpl } = makeFetch();
    const server = new OpencodeServer({ log: () => {}, spawnFn: (() => child) as any, fetchImpl, healthTimeoutMs: 1000, idleTimeoutMs: 0 });
    const ready = once(server, "ready");
    server.start();
    child.stdout.write(announce + "\n");
    await ready;
    expect(server.running).toBe(true);

    // The daemon's uncaughtException handler and its process "exit" handler both call
    // opencodeServerInstance?.stop(); assert stop() reaps the child so a hard daemon
    // exit can't orphan a live unauthenticated serve.
    server.stop();
    expect(server.running).toBe(false);
    expect(child.exitCode).not.toBeNull();
  });
});
