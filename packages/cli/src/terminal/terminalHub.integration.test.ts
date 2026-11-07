// The terminal server end to end: a real tmux server (a scratch one, under its
// own TMUX_TMPDIR, so the person's sessions are never touched), the real
// WebSocket endpoint, and a socket client that keeps its place the way the
// web client does. Covers a dropped socket resuming from its offset, the
// repaint when the offset fell out of the ring, controller and observer
// roles, an explicit takeover, a dropped controller reclaiming its seat, and
// an attach handing the agent's pane back its size.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { attachTerminalServer, type TerminalServerOptions } from "./terminalServer.js";
import { hasTmux } from "../tmux.js";
import { execFileSync } from "node:child_process";

const scratch = fs.mkdtempSync("/tmp/octerm-");
process.env.TMUX_TMPDIR = scratch;
process.env.CODECAST_TMUX_PER_SESSION = "0";
const TOKEN = "t".repeat(64);
const tmux = (...args: string[]) =>
  execFileSync("tmux", args, { env: { ...process.env, TMUX_TMPDIR: scratch }, encoding: "utf8" });

let server: http.Server;
let handle: { close(): void };
let port = 0;
const serverOpts: TerminalServerOptions = {
  token: TOKEN,
  log: () => {},
  hub: { ringBytes: 64 * 1024, controlHoldMs: 400, lingerMs: 5_000 },
};

beforeAll(async () => {
  if (!hasTmux()) return;
  // The server has to exist before a control client can attach to anything.
  tmux("new-session", "-d", "-s", "keepalive", "sleep 600");
  server = http.createServer((_req, res) => res.end());
  handle = attachTerminalServer(server, serverOpts);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  handle?.close();
  server?.close();
  try { tmux("kill-server"); } catch {}
  fs.rmSync(scratch, { recursive: true, force: true });
});

const until = async (what: string, ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

/** A socket client that keeps its place the way termSessions.ts does. */
class View {
  ws!: WebSocket;
  json: Array<Record<string, any>> = [];
  /** Everything written to the terminal since the last ready, seeds included. */
  screen = "";
  /** Only the bytes that count toward the offset (no seeds). */
  stream = "";
  offset = 0;
  streamId = "";
  private seedLeft = 0;

  constructor(private hello: Record<string, unknown>, private origin = `http://localhost:${port}`) {}

  open(extra: Record<string, unknown> = {}): Promise<this> {
    this.json = [];
    this.screen = "";
    this.stream = "";
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/term/ws`, { headers: { Origin: this.origin } });
    this.ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        const msg = JSON.parse(data.toString());
        this.json.push(msg);
        if (msg.type === "offset") this.offset = msg.offset;
        if ((msg.type === "ready" || msg.type === "reseed") && typeof msg.offset === "number") {
          this.offset = msg.offset;
          this.seedLeft = msg.seedBytes ?? 0;
        }
        if (msg.stream) this.streamId = msg.stream;
        return;
      }
      const text = (data as Buffer).toString("utf8");
      this.screen += text;
      if (this.seedLeft > 0) {
        this.seedLeft = 0;
        return;
      }
      this.stream += text;
      this.offset += (data as Buffer).length;
    });
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => {
        this.ws.send(JSON.stringify({ type: "hello", token: TOKEN, cols: 100, rows: 30, ...this.hello, ...extra }));
        resolve(this);
      });
      // Refused upgrades surface as an error before open; later ones are a
      // dropped socket, which the tests look at through the messages.
      this.ws.on("error", reject);
    });
  }

  resume(): Promise<this> {
    return this.open({ resume: { stream: this.streamId, offset: this.offset } });
  }

  last(type: string) {
    return [...this.json].reverse().find((m) => m.type === type);
  }

  ready() {
    return until("replay_complete", () => !!this.last("replay_complete"));
  }

  type(text: string) {
    this.ws.send(Buffer.from(text));
  }

  send(obj: Record<string, unknown>) {
    this.ws.send(JSON.stringify(obj));
  }

  /** A dropped connection: no close frame, the way a sleeping phone goes. */
  drop() {
    this.ws.terminate();
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

const pane = (name: string) => tmux("capture-pane", "-p", "-t", name);

describe.skipIf(!hasTmux())("terminal server against a scratch tmux", () => {
  it("resumes a dropped socket from its offset, with no repaint and nothing doubled", async () => {
    const name = "cast-term-resume";
    const a = await new View({ mode: "create", name, viewId: "view-aaaaaaaa" }).open();
    await a.ready();
    const ready = a.last("ready")!;
    expect(ready.role).toBe("controller");
    expect(ready.offset).toBe(0);
    // A brand-new shell streams from its first byte: no seed.
    expect(ready.seedBytes).toBe(0);

    a.type("echo BEFORE-$((6*7))\r");
    await until("first output", () => a.stream.includes("BEFORE-42"));
    // Output that lands while the socket is gone.
    a.type("sleep 0.6; echo AFTER-$((7*7))\r");
    await until("command echo", () => a.stream.includes("sleep 0.6"));
    const before = a.stream;
    const at = a.offset;
    a.drop();
    await until("output while away", () => pane(name).includes("AFTER-49"));

    await a.resume();
    await a.ready();
    const back = a.last("ready")!;
    expect(back.resumed).toBe(true);
    expect(back.truncated).toBeUndefined();
    expect(back.offset).toBe(at);
    expect(back.seedBytes).toBe(0);
    expect(back.role).toBe("controller");
    // The replay is exactly what was missed: the missed line, and none of
    // what this view had already shown.
    expect(a.stream).toContain("AFTER-49");
    expect(a.stream).not.toContain("BEFORE-42");
    expect(a.json.findIndex((m) => m.type === "replay_complete")).toBeGreaterThan(a.json.findIndex((m) => m.type === "ready"));
    expect(Buffer.byteLength(before) + Buffer.byteLength(a.stream)).toBe(a.offset);

    // And live output still flows after the replay.
    a.type("echo LIVE-$((8*8))\r");
    await until("live output", () => a.stream.includes("LIVE-64"));
    a.send({ type: "kill" });
    await until("exit", () => !!a.last("exit"));
  }, 30_000);

  it("repaints from a fresh capture when the offset fell out of the ring", async () => {
    const name = "cast-term-truncate";
    const a = await new View({ mode: "create", name, viewId: "view-bbbbbbbb" }).open();
    await a.ready();
    a.type("sleep 0.5; seq 1 30000; echo DONE-$((5*5))\r");
    await until("command echo", () => a.stream.includes("seq 1 30000"));
    a.drop();
    await until("flood while away", () => pane(name).includes("DONE-25"));

    await a.resume();
    await a.ready();
    const back = a.last("ready")!;
    expect(back.truncated).toBe(true);
    expect(back.resumed).toBeUndefined();
    expect(back.seedBytes).toBeGreaterThan(0);
    expect(a.screen).toContain("DONE-25");

    // A stream id from some other hub (a restarted daemon) is a repaint too.
    a.drop();
    await a.open({ resume: { stream: "abcdef012345", offset: 10 } });
    await a.ready();
    expect(a.last("ready")!.truncated).toBe(true);
    a.send({ type: "kill" });
    await until("exit", () => !!a.last("exit"));
  }, 30_000);

  it("keeps one controller: observers' input is refused until they take over", async () => {
    const name = "cast-term-roles";
    const a = await new View({ mode: "create", name, viewId: "view-cccccccc" }).open();
    await a.ready();
    const b = await new View({ mode: "create", name, viewId: "view-dddddddd" }).open();
    await b.ready();
    const bReady = b.last("ready")!;
    expect(bReady.role).toBe("observer");
    expect(bReady.readOnly).toBe(true);
    expect(bReady.controlledElsewhere).toBe(true);
    expect(bReady.canControl).toBe(true);
    await until("a sees two viewers", () => a.last("role")?.viewers === 2);

    b.type("echo FROM-B-$((2*3))\r");
    await Bun.sleep(400);
    expect(pane(name)).not.toContain("FROM-B");

    a.type("echo FROM-A-$((3*3))\r");
    await until("observer sees controller output", () => b.stream.includes("FROM-A-9"));

    // The controller resizes its shell: the observer is repainted at the new
    // size; the controller, which chose it, only steps past the repaint.
    a.send({ type: "resize", cols: 70, rows: 18 });
    await until("observer reseeded", () => b.json.some((m) => m.type === "reseed" && m.cols === 70 && m.rows === 18));
    await until("controller stepped past it", () => !!a.last("offset"));
    expect(a.json.some((m) => m.type === "reseed")).toBe(false);
    expect(a.offset).toBeGreaterThanOrEqual(a.last("offset")!.offset);

    b.send({ type: "takeover" });
    await until("b promoted", () => b.last("role")?.role === "controller");
    await until("a demoted", () => a.last("role")?.role === "observer");
    expect(a.last("role")!.reason).toBe("taken");

    a.type("echo STALE-A-$((4*4))\r");
    b.type("echo NOW-B-$((5*6))\r");
    await until("b's input lands", () => pane(name).includes("NOW-B-30"));
    expect(pane(name)).not.toContain("STALE-A");
    b.send({ type: "kill" });
    await until("both exit", () => !!a.last("exit") && !!b.last("exit"));
  }, 30_000);

  it("holds a dropped controller's seat for its own reconnect", async () => {
    const name = "cast-term-hold";
    const a = await new View({ mode: "create", name, viewId: "view-eeeeeeee" }).open();
    await a.ready();
    const b = await new View({ mode: "create", name, viewId: "view-ffffffff" }).open();
    await b.ready();
    a.drop();
    await until("b hears the seat is held", () => b.last("role")?.viewers === 1);
    expect(b.last("role")!.controlledElsewhere).toBe(true);
    await a.resume();
    await a.ready();
    expect(a.last("ready")!.role).toBe("controller");
    expect(a.last("ready")!.resumed).toBe(true);

    // Past the hold, the seat goes to the view still here.
    a.drop();
    await Bun.sleep(150);
    expect(b.last("role")!.role).toBe("observer");
    await until("b seated once the hold ends", () => b.last("role")?.role === "controller", 3000);

    // A clean close (a closed tab, a reload) is not held: the seat frees at
    // once, so a reloaded page with a new view id is not locked out.
    const c = await new View({ mode: "create", name, viewId: "view-cccc0000" }).open();
    await c.ready();
    expect(c.last("ready")!.role).toBe("observer");
    b.ws.close(1000);
    await until("seat passed on at once", () => c.last("role")?.role === "controller", 300);
    c.send({ type: "kill" });
    await until("exit", () => !!c.last("exit"));
  }, 30_000);

  it("an attach sizes the agent's pane only while it controls, and gives the size back", async () => {
    const name = "cast-term-attach";
    tmux("new-session", "-d", "-s", name, "-x", "120", "-y", "40", "sleep 600");
    const size = () => tmux("display-message", "-p", "-t", name, "#{window_width}x#{window_height}").trim();
    try {
      const watcher = await new View({ mode: "attach", target: name, viewId: "view-gggggggg" }).open();
      await watcher.ready();
      expect(watcher.last("ready")!.role).toBe("observer");
      expect(watcher.last("ready")!.canControl).toBe(false);
      watcher.send({ type: "takeover" });
      watcher.send({ type: "resize", cols: 90, rows: 20 });
      await Bun.sleep(300);
      expect(watcher.last("role")?.role).not.toBe("controller");
      expect(size()).toBe("120x40");

      const driver = await new View({ mode: "attach", target: name, interactive: true, viewId: "view-hhhhhhhh" }).open();
      await driver.ready();
      expect(driver.last("ready")!.role).toBe("controller");
      // The hello's size is a pre-layout guess and must not touch the pane.
      expect(size()).toBe("120x40");
      driver.send({ type: "resize", cols: 90, rows: 20 });
      await until("pane sized to the controller", () => size() === "90x20");
      // The watcher is repainted at the new geometry.
      await until("watcher reseeded", () => watcher.json.some((m) => m.type === "reseed" && m.cols === 90 && m.rows === 20));

      // An attach never kills the agent's session, from any seat.
      driver.send({ type: "kill" });
      watcher.send({ type: "kill" });
      await Bun.sleep(300);
      expect(() => tmux("has-session", "-t", name)).not.toThrow();
      expect(driver.last("exit")).toBeUndefined();

      driver.drop();
      // Held for the reconnect, then handed back.
      await Bun.sleep(150);
      expect(size()).toBe("90x20");
      await until("size handed back", () => size() === "120x40", 3000);
      watcher.close();
    } finally {
      try { tmux("kill-session", "-t", name); } catch {}
    }
  }, 30_000);

  it("keeps auth as strict as before: token and origin", async () => {
    const bad = await new View({ mode: "create", name: "cast-term-auth", token: "x".repeat(64) }).open();
    await until("refusal", () => !!bad.last("error"));
    expect(bad.last("error")!.message).toBe("forbidden");
    const noToken = await new View({ mode: "create", name: "cast-term-auth", token: undefined }).open();
    await until("refusal", () => !!noToken.last("error"));
    expect(() => tmux("has-session", "-t", "cast-term-auth")).toThrow();

    const evil = new View({ mode: "create", name: "cast-term-auth" }, "https://evil.example");
    // The upgrade is refused before any hello is read.
    await expect(evil.open()).rejects.toThrow();
  }, 15_000);
});
