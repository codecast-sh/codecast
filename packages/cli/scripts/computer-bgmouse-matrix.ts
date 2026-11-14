#!/usr/bin/env bun
/**
 * Background mouse input, app by app: does a press posted to a window in the
 * back land, while the human's front app and pointer stay exactly theirs?
 *
 *   bun scripts/computer-bgmouse-matrix.ts run [--technique skylight|activate|pid]
 *       [--stamp screen|local|none] [--rows fixture,swiftui,...] [--reps 3] [--out f.json]
 *   bun scripts/computer-bgmouse-matrix.ts compare a.json b.json ...
 *
 * Every row asserts three things per press, each read from outside the helper:
 * the press landed (the app's own status file, its DOM over CDP, or its
 * accessibility tree), the frontmost app never changed (an observer process
 * records every activation, not just the before and after), and the real
 * pointer never moved (sampled every 10 ms, so a warp and restore shows).
 *
 * It drives the INSTALLED helper, so run it under the helper slot lock. The
 * apps it opens are its own: fixtures it builds, TextEdit and Preview on its
 * own files, a Finder window on its own folder, and Chrome and VS Code as
 * separate instances on throwaway profiles. A row whose target app is in
 * front when it starts is skipped, since that measures nothing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

import type { ComputerClient } from "../src/computer/client.js";
import type { ComputerActionResult, ComputerSnapshotResult } from "../src/computer/types.js";
import { buildSwift, flag, launchFixture, makeClient, sleep, status, until, WORK, type Fixture } from "./computer-fixture.js";

type Sample = { landed: boolean; frontKept: boolean; cursorKept: boolean; path?: string; error?: string };
type Row = { name: string; samples: Sample[]; note?: string; skipped?: string };
type Report = { label: string; technique: string; stamp: string; at: string; load: number; rows: Row[] };

type Observation = { front: number; cursor: [number, number]; moved: number; activations: number[] };

/** The observer process: one JSON line per mark, covering the time since the last. */
async function startObserver() {
  const child = spawn(buildSwift("computer-desktop-observer.swift"), [], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout! });
  const waiting: ((line: string) => void)[] = [];
  lines.on("line", (line) => waiting.shift()?.(line));
  await new Promise<void>((resolve) => waiting.push(() => resolve()));
  return {
    mark: () =>
      new Promise<Observation>((resolve) => {
        waiting.push((line) => resolve(JSON.parse(line) as Observation));
        child.stdin!.write("\n");
      }),
    stop: () => child.kill(),
  };
}

/** One app under test: where to press, and how many presses it has seen. */
type Subject = {
  pid: number;
  params: Record<string, unknown>;
  /** A window-local point, read fresh before each press. */
  point: () => Promise<{ x: number; y: number }>;
  count: () => Promise<number>;
  /** How many the count moves per press (a marker typed after it, a toggle). */
  expect?: number;
  afterPress?: () => Promise<void>;
  cleanup: () => Promise<void>;
};

type Context = { client: ComputerClient; read: (p: Record<string, unknown>) => Promise<ComputerSnapshotResult> };

const tmpFile = (name: string, contents: string | Buffer) => {
  const file = path.join(WORK, name);
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
};

function elementLine(tree: string, pattern: RegExp): number | undefined {
  for (const line of tree.split("\n")) {
    const match = /^\s*(\d+) (.*)$/.exec(line);
    if (match && pattern.test(match[2]!)) return Number(match[1]);
  }
  return undefined;
}

function frameOf(snapshot: ComputerSnapshotResult, index: number) {
  const frame = snapshot.snapshot.elements?.find((e) => e.index === index);
  if (!frame) throw new Error(`element ${index} has no frame`);
  return frame;
}

const centerOf = (frame: { x: number; y: number; width: number; height: number }) => ({
  x: Math.round(frame.x + frame.width / 2),
  y: Math.round(frame.y + frame.height / 2),
});

function pidsOf(pattern: string): number[] {
  const out = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout;
  return out.split("\n").filter(Boolean).map(Number);
}

/** The main process of an app started with `marker` in its arguments (not a helper). */
function mainPid(marker: string): number | undefined {
  for (const pid of pidsOf(marker)) {
    const args = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).stdout;
    if (!args.includes("--type=") && !args.includes("Helper")) return pid;
  }
  return undefined;
}

/** Calls `expression` in the first page target a DevTools port lists. */
async function cdpEvaluate(port: number, expression: string, pick: (t: { type: string; url: string }) => boolean = (t) => t.type === "page") {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const target = targets.find(pick);
  if (!target) throw new Error(`no page on DevTools port ${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  try {
    const reply = await new Promise<{ result?: { result?: { value?: unknown } } }>((resolve) => {
      ws.onmessage = (m) => resolve(JSON.parse(String(m.data)));
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
    return reply.result?.result?.value;
  } finally {
    ws.close();
  }
}

const HIT_RECORDER = `(() => {
  if (!window.__hits) {
    window.__hits = [];
    document.addEventListener("mousedown", (e) => window.__hits.push([e.clientX, e.clientY, e.isTrusted]), true);
  }
  return window.__hits.length;
})()`;

async function fixtureCanvas(): Promise<Subject> {
  const fixture = await launchFixture();
  return {
    pid: fixture.pid,
    params: { app: `pid:${fixture.pid}`, windowId: fixture.windows["Bench Canvas"] },
    // The canvas fills the top 120 points of the 200 point content.
    point: async () => ({ x: 210, y: 90 }),
    count: async () => Number(status(fixture).canvasClicks ?? 0),
    cleanup: async () => void fixture.child.kill(),
  };
}

async function swiftui(zone: "button" | "tap", ctx: Context): Promise<Subject> {
  const fixture: Fixture = await launchFixture("computer-swiftui-fixture.swift");
  const params = { app: `pid:${fixture.pid}`, windowId: fixture.windows["SwiftUI Probe"] };
  return {
    pid: fixture.pid,
    params,
    point: async () => {
      const snapshot = await ctx.read({ ...params, noScreenshot: true });
      const index = elementLine(snapshot.snapshot.treeText, /^button Probe Button/);
      if (index === undefined) throw new Error("no Probe Button in the tree");
      const button = frameOf(snapshot, index);
      // The tap zone sits 16 points under the button, 90 tall.
      return zone === "button" ? centerOf(button) : { x: Math.round(button.x + button.width / 2), y: Math.round(button.y + button.height + 16 + 45) };
    },
    count: async () => Number(status(fixture)[zone === "button" ? "buttonPresses" : "taps"] ?? 0),
    cleanup: async () => void fixture.child.kill(),
  };
}

/** TextEdit: a press under the last line moves the insertion point to the
 *  end, which a marker typed after it proves (typing reaches a background
 *  window already). The file is saved back unchanged. */
async function textedit(ctx: Context): Promise<Subject> {
  const original = Array.from({ length: 6 }, (_, i) => `line ${i + 1} of the background press test`).join("\n");
  const file = tmpFile("bg-textedit.txt", original);
  spawnSync("open", ["-g", "-a", "TextEdit", file]);
  let pid = 0;
  let params: Record<string, unknown> = {};
  await until(async () => {
    pid = mainPid("TextEdit.app/Contents/MacOS/TextEdit") ?? 0;
    if (!pid) return false;
    const listed = await ctx.client.listWindows({ app: `pid:${pid}` }).catch(() => undefined);
    const window = listed?.windows.find((w) => w.title?.includes("bg-textedit"));
    if (window) params = { app: `pid:${pid}`, windowId: window.id };
    return !!window;
  }, 60_000);
  if (!params.windowId) throw new Error("TextEdit never showed bg-textedit.txt");
  const textArea = async () => {
    const snapshot = await ctx.read({ ...params, noScreenshot: true });
    const index = elementLine(snapshot.snapshot.treeText, /^text area/);
    if (index === undefined) throw new Error("no text area");
    return { snapshot, index, frame: frameOf(snapshot, index) };
  };
  const markers = async () => {
    const { snapshot } = await textArea();
    const tail = snapshot.snapshot.treeText.split("\n").find((l) => /^\s*\d+ text area/.test(l)) ?? "";
    return (tail.match(/test@/g) ?? []).length;
  };
  const reset = async () => {
    const { index } = await textArea();
    await ctx.client.action("setValue", { ...params, elementIndex: index, value: original });
    // The insertion point goes to the start, where a marker would show the press missed.
    await ctx.client.action("hotkey", { ...params, key: "cmd+up" });
  };
  return {
    pid,
    params,
    point: async () => {
      await reset();
      const { frame } = await textArea();
      return { x: Math.round(frame.x + frame.width - 40), y: Math.round(frame.y + frame.height - 30) };
    },
    count: markers,
    afterPress: async () => {
      await ctx.client.action("typeText", { ...params, text: "@" });
    },
    cleanup: async () => {
      await reset().catch(() => {});
      await ctx.client.action("hotkey", { ...params, key: "cmd+s" }).catch(() => {});
      await sleep(500);
      await ctx.client.action("hotkey", { ...params, key: "cmd+w" }).catch(() => {});
    },
  };
}

/** A Chromium page (Chrome or an Electron app) on a throwaway profile,
 *  read back over DevTools. */
async function chromium(kind: "chrome" | "vscode", ctx: Context): Promise<Subject> {
  const port = kind === "chrome" ? 9333 : 9334;
  const profile = path.join(WORK, `${kind}-profile`);
  fs.mkdirSync(profile, { recursive: true });
  const page = tmpFile("bg-page.html", `<!doctype html><title>bg page</title><body style="margin:0"><button id="b" style="width:100vw;height:100vh;font-size:40px">PRESS</button></body>`);
  const appArgs =
    kind === "chrome"
      ? ["-a", "Google Chrome", "--args", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", "--new-window", `file://${page}`]
      : ["-a", "Visual Studio Code", "--args", `--user-data-dir=${profile}`, `--extensions-dir=${profile}-ext`, `--remote-debugging-port=${port}`, "--new-window", "--skip-welcome", "--disable-workspace-trust", page];
  spawnSync("open", ["-n", "-g", ...appArgs]);
  let pid = 0;
  await until(() => !!(pid = mainPid(`user-data-dir=${profile}`) ?? 0), 60_000);
  if (!pid) throw new Error(`${kind} did not start`);
  const pick = kind === "chrome" ? (t: { type: string; url: string }) => t.type === "page" && t.url.startsWith("file:") : (t: { type: string; url: string }) => t.type === "page" && t.url.includes("workbench");
  await until(async () => (await cdpEvaluate(port, HIT_RECORDER, pick).catch(() => undefined)) !== undefined, 60_000);
  let params: Record<string, unknown> = { app: `pid:${pid}` };
  await until(async () => {
    const listed = await ctx.client.listWindows({ app: `pid:${pid}` }).catch(() => undefined);
    const window = listed?.windows.find((w) => (w.bounds?.width ?? 0) > 300);
    if (window) params = { app: `pid:${pid}`, windowId: window.id };
    return !!window;
  }, 30_000);
  return {
    pid,
    params,
    point: async () => {
      const snapshot = await ctx.read({ ...params, noScreenshot: true });
      const { width, height } = snapshot.snapshot.window.bounds;
      return { x: Math.round(width / 2), y: Math.round(height / 2) };
    },
    count: async () => Number((await cdpEvaluate(port, HIT_RECORDER, pick).catch(() => -1)) ?? -1),
    cleanup: async () => {
      process.kill(pid, "SIGTERM");
      await until(() => pidsOf(`user-data-dir=${profile}`).length === 0, 10_000);
    },
  };
}

const ROWS: Record<string, (ctx: Context) => Promise<Subject>> = {
  fixture: () => fixtureCanvas(),
  "swiftui-button": (ctx) => swiftui("button", ctx),
  "swiftui-tap": (ctx) => swiftui("tap", ctx),
  textedit: (ctx) => textedit(ctx),
  chrome: (ctx) => chromium("chrome", ctx),
  vscode: (ctx) => chromium("vscode", ctx),
};

async function run(args: string[]): Promise<void> {
  const technique = flag(args, "technique") ?? "skylight";
  const stamp = flag(args, "stamp") ?? "screen";
  const reps = Number(flag(args, "reps") ?? 3);
  const label = flag(args, "label") ?? `${technique}-${stamp}`;
  const out = flag(args, "out") ?? path.join(WORK, `bgmouse-${label}.json`);
  const names = (flag(args, "rows") ?? Object.keys(ROWS).join(",")).split(",");
  const client = makeClient();
  const ctx: Context = { client, read: (p) => client.getAppState(p) as Promise<ComputerSnapshotResult> };
  const observer = await startObserver();
  const rows: Row[] = [];
  try {
    for (const name of names) {
      const row: Row = { name, samples: [] };
      rows.push(row);
      let subject: Subject | undefined;
      try {
        subject = await ROWS[name]!(ctx);
        for (let i = 0; i < reps; i++) {
          const point = await subject.point();
          const before = await subject.count();
          const start = await observer.mark();
          if (start.front === subject.pid) {
            row.skipped = "the target app was frontmost";
            break;
          }
          const sample: Sample = { landed: false, frontKept: false, cursorKept: false };
          try {
            const result = (await client.action("click", {
              ...subject.params,
              ...point,
              mouse: true,
              cursor: false,
              noScreenshot: true,
              backgroundMouse: technique,
              backgroundStamp: stamp,
            })) as ComputerActionResult;
            sample.path = String(result.action?.path ?? "");
          } catch (err) {
            sample.error = err instanceof Error ? err.message.split("\n")[0] : String(err);
          }
          const end = await observer.mark();
          await subject.afterPress?.();
          sample.landed = await until(async () => (await subject!.count()) >= before + (subject!.expect ?? 1), 3_000);
          sample.frontKept = end.front === start.front && end.activations.length === 0;
          sample.cursorKept = end.moved < 1;
          row.samples.push(sample);
          await sleep(300);
        }
      } catch (err) {
        row.note = `setup: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
      } finally {
        await subject?.cleanup().catch(() => {});
      }
      console.log(`  ${line(row)}`);
    }
  } finally {
    observer.stop();
    client.shutdown();
  }
  const report: Report = { label, technique, stamp, at: new Date().toISOString(), load: os.loadavg()[0]!, rows };
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${out} (load ${report.load.toFixed(0)})`);
}

function cell(row: Row | undefined): string {
  if (!row) return "-";
  if (row.skipped) return `skipped: ${row.skipped}`;
  if (!row.samples.length) return row.note ?? "no samples";
  const n = row.samples.length;
  const count = (key: "landed" | "frontKept" | "cursorKept") => row.samples.filter((s) => s[key]).length;
  const errors = [...new Set(row.samples.map((s) => s.error).filter(Boolean))];
  return `landed ${count("landed")}/${n}, front kept ${count("frontKept")}/${n}, pointer kept ${count("cursorKept")}/${n}${errors.length ? `, error: ${errors[0]!.slice(0, 80)}` : ""}`;
}

const line = (row: Row) => `${row.name.padEnd(16)} ${cell(row)}`;

function compare(files: string[]): void {
  const reports = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as Report);
  const names = [...new Set(reports.flatMap((r) => r.rows.map((row) => row.name)))];
  console.log(`| App | ${reports.map((r) => `${r.label} (load ${r.load.toFixed(0)})`).join(" | ")} |`);
  console.log(`|---|${reports.map(() => "---").join("|")}|`);
  for (const name of names) console.log(`| ${name} | ${reports.map((r) => cell(r.rows.find((row) => row.name === name))).join(" | ")} |`);
}

const [verb, ...rest] = process.argv.slice(2);
if (verb === "run") await run(rest);
else if (verb === "compare" && rest.length >= 1) compare(rest);
else {
  console.log("usage: bun scripts/computer-bgmouse-matrix.ts run [--technique skylight|activate|pid] [--stamp screen|local|none] [--rows a,b] [--reps n] [--out f.json]\n       bun scripts/computer-bgmouse-matrix.ts compare <a.json> [b.json ...]");
  process.exit(1);
}
