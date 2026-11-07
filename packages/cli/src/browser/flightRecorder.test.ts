import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { CdpClient, CdpEvent } from "./cdp.js";
import { askRecorder, concatList, encodeWindow, ffmpegArgs, flightPaths, FrameRing, parseSeconds, runRecorder } from "./flightRecorder.js";

const f = (at: number, size = 10) => ({ data: Buffer.alloc(size, at % 256), at });

describe("FrameRing", () => {
  test("drops frames past the retention but keeps the one showing at its edge", () => {
    const r = new FrameRing(1000);
    for (const at of [0, 400, 800, 1200, 2500]) r.push(f(at));
    // At 2500 the window opens at 1500: 1200 is what the screen showed then.
    expect(r.frames.map((x) => x.at)).toEqual([1200, 2500]);
    expect(r.bytes).toBe(20);
  });
  test("byte and count caps evict the oldest and count them", () => {
    const r = new FrameRing(60_000, 35, 100);
    for (const at of [0, 10, 20, 30]) r.push(f(at));
    expect(r.frames.map((x) => x.at)).toEqual([10, 20, 30]);
    expect(r.dropped).toBe(1);
    const c = new FrameRing(60_000, 1e9, 2);
    for (const at of [0, 10, 20]) c.push(f(at));
    expect(c.frames.length).toBe(2);
  });
  test("a window covers exactly the time asked, holding the last frame to now", () => {
    const r = new FrameRing(60_000);
    for (const at of [0, 1000, 5000]) r.push(f(at));
    const w = r.window(3000, 7000);
    // Window 4000..7000: frame 1000 shows until 5000, then 5000 until now.
    expect(w.map((p) => [p.frame.at, p.seconds])).toEqual([[1000, 1], [5000, 2]]);
    expect(w.reduce((s, p) => s + p.seconds, 0)).toBe(3);
  });
  test("a static page still fills the window from its one frame", () => {
    const r = new FrameRing(60_000);
    r.push(f(0));
    expect(r.window(30_000, 40_000).map((p) => p.seconds)).toEqual([30]);
    expect(r.coveredMs(40_000)).toBe(40_000);
  });
});

test("concat list repeats the last file and ffmpeg args make web mp4", () => {
  expect(concatList(["/a.jpg", "/b.jpg"], [0.5, 1])).toBe("ffconcat version 1.0\nfile '/a.jpg'\nduration 0.5000\nfile '/b.jpg'\nduration 1.0000\nfile '/b.jpg'\n");
  const args = ffmpegArgs("/l.txt", "/o.mp4");
  expect(args).toContain("+faststart");
  expect(args.at(-1)).toBe("/o.mp4");
});

test("parseSeconds bounds", () => {
  expect(parseSeconds(undefined, 60, 120)).toBe(60);
  expect(parseSeconds("90", 60, 120)).toBe(90);
  expect(() => parseSeconds("121", 60, 120)).toThrow(/1 to 120/);
  expect(() => parseSeconds("x", 60, 120)).toThrow();
});

test("flightPaths fits a unix socket and is per session", () => {
  const a = flightPaths("jx7ffys-very-long-session-key-real".repeat(3), "/tmp/f");
  expect(a.sock.length).toBeLessThan(100);
  expect(flightPaths("a", "/tmp/f").sock).not.toBe(flightPaths("b", "/tmp/f").sock);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** A real JPEG of one color, from ffmpeg itself. */
function jpeg(color: string, dir: string): Buffer {
  const out = path.join(dir, `${color}.jpg`);
  spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=${color}:s=64x48`, "-frames:v", "1", out]);
  return fs.readFileSync(out);
}

function duration(file: string): number {
  const p = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf-8" });
  return parseFloat(p.stdout);
}

describe.if(hasFfmpeg)("encoding", () => {
  test("encodeWindow writes an mp4 as long as the window, and a poster", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flight-"));
    const r = new FrameRing(60_000);
    r.push({ data: jpeg("red", dir), at: 0 });
    r.push({ data: jpeg("blue", dir), at: 1000 });
    const saved = await encodeWindow(r, 3, path.join(dir, "out"), 3000);
    expect(saved.frames).toBe(2);
    expect(fs.existsSync(saved.file)).toBe(true);
    expect(fs.readFileSync(saved.poster).equals(jpeg("blue", dir))).toBe(true);
    expect(duration(saved.file)).toBeGreaterThan(2.5);
    expect(fs.readdirSync(path.join(dir, "out")).sort()).toEqual(["flight.mp4", "poster.jpg"]);
  });

  test("the recorder buffers screencast frames, acks them, saves and stops over its socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flight-"));
    const frames = [jpeg("red", dir), jpeg("green", dir)];
    const sent: string[] = [];
    let handler: ((ev: CdpEvent) => void) | null = null;
    const conn: CdpClient = {
      send: async (method: string) => {
        sent.push(method);
        if (method === "Target.attachToTarget") return { sessionId: "S" } as any;
        if (method === "Page.startScreencast") {
          setTimeout(() => frames.forEach((d, i) => handler?.({ method: "Page.screencastFrame", sessionId: "S", params: { data: d.toString("base64"), sessionId: i + 1 } } as CdpEvent)), 20);
        }
        return {} as any;
      },
      on: (h) => {
        handler = h;
        return () => {};
      },
      waitFor: async () => ({}) as CdpEvent,
      close: () => sent.push("close"),
    };
    const p = flightPaths("test", path.join(dir, "rec"));
    const run = runRecorder({ cdp: "ws://x", targetId: "T", session: "test", url: "https://a.test/", seconds: 60, sock: p.sock, state: p.state }, async () => conn);
    let status: any = null;
    for (let i = 0; i < 50 && !status?.ok; i++) {
      await new Promise((r) => setTimeout(r, 50));
      status = await askRecorder(p.sock, { op: "status" }, 1000).catch(() => null);
    }
    await new Promise((r) => setTimeout(r, 100));
    status = await askRecorder(p.sock, { op: "status" });
    expect(status.status.frames).toBe(2);
    expect(sent.filter((m) => m === "Page.screencastFrameAck").length).toBe(2);
    expect((fs.statSync(p.sock).mode & 0o777).toString(8)).toBe("600");
    const saved = await askRecorder(p.sock, { op: "save", seconds: 5, dir: path.join(dir, "save") });
    expect(saved.ok).toBe(true);
    expect(fs.existsSync(saved.saved.file)).toBe(true);
    expect((await askRecorder(p.sock, { op: "stop" })).ok).toBe(true);
    await run;
    expect(sent).toContain("Page.stopScreencast");
    expect(fs.existsSync(p.sock)).toBe(false);
    expect(fs.existsSync(p.state)).toBe(false);
    expect(await askRecorder(p.sock, { op: "status" })).toBeNull();
  });
});
