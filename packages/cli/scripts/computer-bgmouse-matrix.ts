#!/usr/bin/env bun
/**
 * Background mouse input, app by app: does a press posted to a window in the
 * back land, while the human's front app and pointer stay exactly theirs?
 *
 *   bun scripts/computer-bgmouse-matrix.ts run [--technique skylight|activate|pid]
 *       [--stamp screen|local|none] [--rows fixture,swiftui,...]  [--reps 3] [--out f.json] [--helper <exe>]
 *   bun scripts/computer-bgmouse-matrix.ts compare a.json b.json ...
 *   bun scripts/computer-bgmouse-matrix.ts focus [--cases alive,killed,stopped]
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
import { readInstance } from "../src/computer/instance.js";
import type { ComputerActionResult, ComputerSnapshotResult } from "../src/computer/types.js";
import { buildFixture, fixtureClient, fixtureStatus as status, launchFixture, scriptSource, type Fixture } from "../src/test-helpers/computerBenchFixture.js";

const WORK = path.join(os.tmpdir(), "cc-bench");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await sleep(25);
  }
  return check();
}

type Sample = { landed: boolean; frontKept: boolean; cursorKept: boolean; path?: string; error?: string };
type Row = { name: string; samples: Sample[]; note?: string; skipped?: string; /** Apps that came to the front while the row set up: a setup bug. */ setupActivated?: number[] };
type Report = { label: string; technique: string; stamp: string; at: string; load: number; rows: Row[] };

type Observation = { front: number; cursor: [number, number]; moved: number; activations: number[] };

/** The observer process: one JSON line per mark, covering the time since the last. */
async function startObserver() {
  const child = spawn(buildFixture(scriptSource("computer-desktop-observer.swift")), [], { stdio: ["pipe", "pipe", "inherit"] });
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
  /** Presses per action, for a target that needs a double press. */
  clickCount?: number;
  /** A drag to this offset from the point, or a scroll, instead of a click. */
  gesture?: { kind: "drag"; dx: number; dy: number } | { kind: "scroll"; direction: "up" | "down" };
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
    document.addEventListener("mousedown", (e) => window.__hits.push([e.clientX, e.clientY, e.isTrusted, e.button, Date.now()]), true);
  }
  return window.__hits.length;
})()`;
const HIT_LOG = "JSON.stringify(window.__hits ?? [])";

/** The bench fixture's 2000-row table: a wheel scroll moves its scroll bar,
 *  which the tree reports. Each scroll goes down; it never reaches the end. */
async function fixtureScroll(ctx: Context): Promise<Subject> {
  const fixture = await launchFixture();
  const params = { app: `pid:${fixture.pid}`, windowId: fixture.windows["Bench Table"] };
  const position = async () => Number(/scroll bar ([\d.]+)/.exec((await ctx.read({ ...params, noScreenshot: true })).snapshot.treeText)?.[1] ?? 0);
  let last = 0;
  let moves = 0;
  return {
    pid: fixture.pid,
    params,
    point: async () => {
      last = await position();
      return { x: 200, y: 160 };
    },
    count: async () => {
      const now = await position();
      if (now > last + 1e-6) {
        moves++;
        last = now;
      }
      return moves;
    },
    gesture: { kind: "scroll", direction: "down" },
    cleanup: async () => void fixture.child.kill(),
  };
}

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

async function swiftui(zone: "button" | "tap" | "drag", ctx: Context): Promise<Subject> {
  const fixture: Fixture = await launchFixture([], scriptSource("computer-swiftui-fixture.swift"));
  const params = { app: `pid:${fixture.pid}`, windowId: fixture.windows["SwiftUI Probe"] };
  return {
    pid: fixture.pid,
    params,
    point: async () => {
      const snapshot = await ctx.read({ ...params, noScreenshot: true });
      // The tap zone has no element; its label is read from the pixels.
      const pattern = { button: /^button.*Probe Button/, tap: /^visible text TAP ZONE/, drag: /^visible text DRAG ZONE/ }[zone];
      const index = elementLine(snapshot.snapshot.treeText, pattern);
      if (index === undefined) throw new Error(`no ${zone} in the tree`);
      return centerOf(frameOf(snapshot, index));
    },
    count: async () => Number(status(fixture)[{ button: "buttonPresses", tap: "taps", drag: "drags" }[zone]] ?? 0),
    ...(zone === "drag" ? { gesture: { kind: "drag" as const, dx: 70, dy: 0 } } : {}),
    cleanup: async () => void fixture.child.kill(),
  };
}

/** A document opened at the back in a stock app. Closing presses the
 *  window's close button (answering a save sheet with don't save), and quits
 *  the app only when this run launched it. */
async function openDocument(ctx: Context, app: string, executable: string, file: string): Promise<{ pid: number; params: Record<string, unknown>; close: () => Promise<void> }> {
  const wasRunning = mainPid(executable) !== undefined;
  spawnSync("open", ["-g", "-a", app, file]);
  let pid = 0;
  let params: Record<string, unknown> = {};
  const title = path.basename(file);
  await until(async () => {
    pid = mainPid(executable) ?? 0;
    if (!pid) return false;
    const listed = await ctx.client.listWindows({ app: `pid:${pid}` }).catch(() => undefined);
    const window = listed?.windows.find((w) => w.title?.includes(title));
    if (!window) return false;
    params = { app: `pid:${pid}`, windowId: window.id };
    // Listed by the window server is not yet readable: wait for the app to answer.
    return !!(await ctx.read({ ...params, noScreenshot: true }).catch(() => undefined))?.snapshot.treeText.includes("standard window");
  }, 90_000);
  if (!params.windowId) throw new Error(`${app} never showed ${title}`);
  const press = async (pattern: RegExp) => {
    const tree = (await ctx.read({ ...params, noScreenshot: true })).snapshot.treeText;
    const index = elementLine(tree, pattern);
    if (index === undefined) return false;
    await ctx.client.action("click", { ...params, elementIndex: index, cursor: false, noScreenshot: true });
    return true;
  };
  return {
    pid,
    params,
    close: async () => {
      await press(/^close button/).catch(() => false);
      await sleep(400);
      await press(/^button (Don.t Save|Delete|Revert)/).catch(() => false);
      if (!wasRunning) {
        await sleep(400);
        process.kill(pid, "SIGTERM");
        await until(() => mainPid(executable) === undefined, 15_000);
      }
    },
  };
}

/** TextEdit: a press under the last line moves the insertion point to the
 *  end, which a marker typed after it proves (typing reaches a background
 *  window already). */
async function textedit(ctx: Context): Promise<Subject> {
  const original = Array.from({ length: 6 }, (_, i) => `line ${i + 1} of the background press test`).join("\n");
  const doc = await openDocument(ctx, "TextEdit", "TextEdit.app/Contents/MacOS/TextEdit", tmpFile("bg-textedit.txt", original));
  const { params } = doc;
  const textArea = async () => {
    const snapshot = await ctx.read({ ...params, noScreenshot: true });
    const index = elementLine(snapshot.snapshot.treeText, /^text (entry )?area/);
    if (index === undefined) throw new Error("no text area");
    return { snapshot, index, frame: frameOf(snapshot, index) };
  };
  return {
    pid: doc.pid,
    params,
    point: async () => {
      const { index, frame } = await textArea();
      await ctx.client.action("setValue", { ...params, elementIndex: index, value: original });
      // The insertion point goes to the start, where a marker would show the press missed.
      await ctx.client.action("hotkey", { ...params, key: "cmd+up" });
      return { x: Math.round(frame.x + frame.width - 40), y: Math.round(frame.y + frame.height - 30) };
    },
    count: async () => {
      const tree = (await textArea()).snapshot.snapshot.treeText;
      return (tree.split("\n").find((l) => /^\s*\d+ text area/.test(l))?.match(/test@/g) ?? []).length;
    },
    afterPress: async () => {
      await ctx.client.action("typeText", { ...params, text: "@" });
    },
    cleanup: doc.close,
  };
}

/** Finder: a double press on a folder icon opens it in the same window,
 *  which the window title then names. The folders nest, so each press goes
 *  one deeper and nothing needs resetting. */
async function finder(ctx: Context): Promise<Subject> {
  const root = path.join(WORK, "bg-finder");
  fs.rmSync(root, { recursive: true, force: true });
  let dir = root;
  for (let depth = 1; depth <= 8; depth++) fs.mkdirSync((dir = path.join(dir, `depth-${depth}`)), { recursive: true });
  const doc = await openDocument(ctx, "Finder", "Finder.app/Contents/MacOS/Finder", root);
  const { params } = doc;
  const depth = async () => {
    const title = (await ctx.read({ ...params, noScreenshot: true })).snapshot.window.title;
    return Number(/depth-(\d+)/.exec(title)?.[1] ?? 0);
  };
  return {
    pid: doc.pid,
    params,
    clickCount: 2,
    point: async () => {
      const snapshot = await ctx.read({ ...params, noScreenshot: true });
      const index = elementLine(snapshot.snapshot.treeText, /^image depth-\d+/);
      if (index === undefined) throw new Error("no folder icon");
      return centerOf(frameOf(snapshot, index));
    },
    count: depth,
    cleanup: doc.close,
  };
}

/** Preview: a toolbar toggle a press flips, and a form field on the page a
 *  press focuses. */
async function preview(part: "toolbar" | "page", ctx: Context): Promise<Subject> {
  const doc = await openDocument(ctx, "Preview", "Preview.app/Contents/MacOS/Preview", tmpFile("bg-form.pdf", formPdf()));
  const { params } = doc;
  const read = () => ctx.read({ ...params, noScreenshot: true });
  const find = async (pattern: RegExp, what: string) => {
    const snapshot = await read();
    const index = elementLine(snapshot.snapshot.treeText, pattern);
    if (index === undefined) throw new Error(`no ${what}`);
    return { snapshot, index };
  };
  if (part === "toolbar") {
    const toggleOn = async () => Number(/Rectangular Selection, Value: 1/.test((await read()).snapshot.treeText));
    return {
      pid: doc.pid,
      params,
      point: async () => {
        // Back to the text tool through accessibility, so each press starts from Value 0.
        const text = await find(/^toggle button Text Selection/, "Text Selection tool");
        await ctx.client.action("click", { ...params, elementIndex: text.index, cursor: false, noScreenshot: true });
        if (!(await until(async () => (await toggleOn()) === 0, 3_000))) throw new Error("Rectangular Selection stayed on");
        const { snapshot, index } = await find(/^toggle button Rectangular Selection/, "Rectangular Selection toggle");
        return centerOf(frameOf(snapshot, index));
      },
      count: toggleOn,
      cleanup: doc.close,
    };
  }
  const fieldFocused = async () => Number(/focused UI element is \d+ text field/.test((await read()).snapshot.treeText));
  return {
    pid: doc.pid,
    params,
    point: async () => {
      if (await fieldFocused()) await ctx.client.action("pressKey", { ...params, key: "escape" });
      if (!(await until(async () => (await fieldFocused()) === 0, 3_000))) throw new Error("the form field kept focus");
      const { snapshot, index } = await find(/^text field/, "form field on the page");
      return centerOf(frameOf(snapshot, index));
    },
    count: fieldFocused,
    cleanup: doc.close,
  };
}

const ELECTRON = path.join(import.meta.dir, "../../../node_modules/.bun/electron@44.3.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

/** A Chromium page read back over DevTools: Chrome as its own instance on a
 *  throwaway profile, or an Electron app of our own. Neither may take the
 *  front while it starts: Chrome starts with no window and opens the page as
 *  a background window over DevTools; the Electron window shows inactive. */
async function chromium(kind: "chrome" | "electron", ctx: Context, mode: "click" | "scroll" = "click"): Promise<Subject> {
  const port = kind === "chrome" ? 9333 : 9334;
  const profile = path.join(WORK, `${kind}-profile`);
  fs.mkdirSync(profile, { recursive: true });
  const page =
    mode === "click"
      ? tmpFile("bg-page.html", `<!doctype html><title>bg page</title><body style="margin:0"><button id="b" style="width:100vw;height:100vh;font-size:40px">PRESS</button></body>`)
      : tmpFile("bg-tall.html", `<!doctype html><title>bg tall</title><body style="margin:0"><div style="height:40000px;background:linear-gradient(#fff,#88f)">TALL</div></body>`);
  let pid = 0;
  let child: ReturnType<typeof spawn> | undefined;
  if (kind === "chrome") {
    child = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
      `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", "--no-startup-window",
    ], { stdio: "ignore" });
    await until(async () => !!(await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => undefined)), 60_000);
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: `file://${page}`, newWindow: true, background: true } }));
    await new Promise((resolve) => (ws.onmessage = resolve));
    ws.close();
  } else {
    child = spawn(ELECTRON, [path.join(import.meta.dir, "computer-electron-fixture.cjs"), String(port), page], { stdio: "ignore" });
  }
  pid = child.pid!;
  const pick = (t: { type: string; url: string }) => t.type === "page" && t.url.startsWith("file:");
  await until(async () => (await cdpEvaluate(port, mode === "click" ? HIT_RECORDER : "window.scrollY", pick).catch(() => undefined)) !== undefined, 60_000);
  let params: Record<string, unknown> = { app: `pid:${pid}` };
  await until(async () => {
    const listed = await ctx.client.listWindows({ app: `pid:${pid}` }).catch(() => undefined);
    const window = listed?.windows.find((w) => w.width > 300);
    if (window) params = { app: `pid:${pid}`, windowId: window.id };
    return !!window;
  }, 30_000);
  if (!params.windowId) throw new Error(`${kind} showed no window`);
  return {
    pid,
    params,
    point: async () => {
      const { width, height } = (await ctx.read({ ...params, noScreenshot: true })).snapshot.window;
      return { x: Math.round(width / 2), y: Math.round(height / 2) };
    },
    ...(mode === "scroll" ? { gesture: { kind: "scroll" as const, direction: "down" as const } } : {}),
    count: async () => {
      for (let attempt = 0; ; attempt++) {
        const value = await cdpEvaluate(port, mode === "click" ? HIT_RECORDER : "Math.floor(window.scrollY / 10)", pick).catch((err) => (attempt < 4 ? undefined : Promise.reject(err)));
        if (typeof value === "number") return value;
        await sleep(250);
      }
    },
    cleanup: async () => {
      if (process.env.BGMOUSE_DEBUG) console.log(`    ${kind} hits: ${await cdpEvaluate(port, HIT_LOG, pick).catch(String)}`);
      child?.kill("SIGTERM");
      await until(() => pidsOf(`user-data-dir=${profile}`).length === 0 && pidsOf("computer-electron-fixture").length === 0, 10_000);
    },
  };
}

/** A one-page PDF with one text form field, written by hand. */
function formPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DA (/Helv 14 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R] /Resources << /Font << /Helv 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (probe) /Rect [100 600 460 650] /F 4 /P 3 0 R /DA (/Helv 14 Tf 0 g) /MK << /BG [0.9 0.9 1] /BC [0 0 0] >> >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const content = "BT /Helv 18 Tf 100 680 Td (Background press probe) Tj ET";
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const ROWS: Record<string, (ctx: Context) => Promise<Subject>> = {
  fixture: () => fixtureCanvas(),
  "swiftui-button": (ctx) => swiftui("button", ctx),
  "swiftui-tap": (ctx) => swiftui("tap", ctx),
  "swiftui-drag": (ctx) => swiftui("drag", ctx),
  "fixture-scroll": (ctx) => fixtureScroll(ctx),
  "chrome-scroll": (ctx) => chromium("chrome", ctx, "scroll"),
  textedit: (ctx) => textedit(ctx),
  finder: (ctx) => finder(ctx),
  "preview-toolbar": (ctx) => preview("toolbar", ctx),
  "preview-page": (ctx) => preview("page", ctx),
  chrome: (ctx) => chromium("chrome", ctx),
  electron: (ctx) => chromium("electron", ctx),
};

async function run(args: string[]): Promise<void> {
  const technique = flag(args, "technique") ?? "skylight";
  const stamp = flag(args, "stamp") ?? "screen";
  const reps = Number(flag(args, "reps") ?? 3);
  const label = flag(args, "label") ?? `${technique}-${stamp}`;
  const out = flag(args, "out") ?? path.join(WORK, `bgmouse-${label}.json`);
  const names = (flag(args, "rows") ?? Object.keys(ROWS).join(",")).split(",");
  const client = fixtureClient(flag(args, "helper"));
  const ctx: Context = { client, read: (p) => client.getAppState(p) as Promise<ComputerSnapshotResult> };
  const observer = await startObserver();
  const rows: Row[] = [];
  try {
    for (const name of names) {
      const row: Row = { name, samples: [] };
      rows.push(row);
      let subject: Subject | undefined;
      try {
        await observer.mark();
        subject = await ROWS[name]!(ctx);
        const setup = await observer.mark();
        if (setup.activations.length) row.setupActivated = setup.activations;
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
            const gesture = subject.gesture;
            const method = gesture?.kind ?? "click";
            const shape =
              gesture?.kind === "drag"
                ? { toX: point.x + gesture.dx, toY: point.y + gesture.dy }
                : gesture?.kind === "scroll"
                  ? { direction: gesture.direction, pages: 1 }
                  : { ...(subject.clickCount ? { clickCount: subject.clickCount } : {}), mouse: true };
            const result = (await client.action(method, {
              ...subject.params,
              ...point,
              ...shape,
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
          sample.landed = await until(async () => (await subject!.count()) >= before + 1, 3_000);
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

/** The bundle id of a running app, read from LaunchServices. */
function bundleOf(pid: number): string | undefined {
  const out = spawnSync("lsappinfo", ["info", "-only", "bundleid", String(pid)], { encoding: "utf8" }).stdout;
  return /"CFBundleIdentifier"="([^"]+)"/.exec(out)?.[1];
}

/**
 * Round 4: the focus shield must never swallow the human's own app switch.
 * While an `activate` press holds its shield up, Finder is brought to the
 * front from outside the helper (LaunchServices, the way a Dock click goes),
 * with the helper alive, killed, or stopped. Each case says whether the
 * switch landed and how long it took, then gives the front back to the app
 * that had it. This moves the human's screen for about a second per case.
 */
async function focusTest(args: string[]): Promise<void> {
  const cases = (flag(args, "cases") ?? "alive,killed,stopped").split(",");
  const observer = await startObserver();
  const results: Record<string, unknown>[] = [];
  try {
    for (const scenario of cases) {
      const client = fixtureClient(flag(args, "helper"));
      const fixture = await launchFixture([], scriptSource("computer-swiftui-fixture.swift"));
      const params = { app: `pid:${fixture.pid}`, windowId: fixture.windows["SwiftUI Probe"], noScreenshot: true, cursor: false };
      const result: Record<string, unknown> = { scenario };
      try {
        const snapshot = (await client.getAppState(params)) as ComputerSnapshotResult;
        const index = elementLine(snapshot.snapshot.treeText, /^visible text TAP ZONE/);
        const point = centerOf(frameOf(snapshot, index!));
        const human = (await observer.mark()).front;
        const humanBundle = bundleOf(human);
        if (!humanBundle) throw new Error(`no bundle id for the front app ${human}`);
        const helperPid = readInstance()?.pid;
        const press = client
          .action("click", { ...params, ...point, mouse: true, backgroundMouse: "activate", backgroundHoldMs: 1_200 })
          .then((r) => (r as ComputerActionResult).action?.verification as Record<string, unknown> | undefined)
          .catch((err: unknown) => ({ error: String(err).split("\n")[0] }));
        await sleep(350);
        if (scenario === "killed" && helperPid) process.kill(helperPid, "SIGKILL");
        if (scenario === "stopped" && helperPid) process.kill(helperPid, "SIGSTOP");
        const started = Date.now();
        spawnSync("open", ["-b", "com.apple.finder"]);
        const finder = mainPid("Finder.app/Contents/MacOS/Finder");
        const switched = await until(async () => (await observer.mark()).front === finder, 5_000);
        result.switched = switched;
        result.switchMs = Date.now() - started;
        if (scenario === "stopped" && helperPid) process.kill(helperPid, "SIGCONT");
        spawnSync("open", ["-b", humanBundle]);
        result.returned = await until(async () => (await observer.mark()).front === human, 5_000);
        result.press = await press;
        result.landed = Number(status(fixture).taps ?? 0) > 0;
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
      } finally {
        fixture.child.kill();
        client.shutdown();
      }
      results.push(result);
      console.log(`  ${JSON.stringify(result)}`);
      await sleep(1_000);
    }
  } finally {
    observer.stop();
  }
  const out = flag(args, "out") ?? path.join(WORK, "bgmouse-focus.json");
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), load: os.loadavg()[0], results }, null, 2));
  console.log(`\nwrote ${out}`);
}

function cell(row: Row | undefined): string {
  if (!row) return "-";
  if (row.skipped) return `skipped: ${row.skipped}`;
  if (!row.samples.length) return row.note ?? "no samples";
  const n = row.samples.length;
  const count = (key: "landed" | "frontKept" | "cursorKept") => row.samples.filter((s) => s[key]).length;
  const routes = new Map<string, number>();
  for (const s of row.samples) {
    const route = s.error ? (s.landed ? "refused but landed" : "refused") : s.path || "?";
    routes.set(route, (routes.get(route) ?? 0) + 1);
  }
  const errors = [...new Set(row.samples.map((s) => s.error).filter(Boolean))];
  const setup = row.setupActivated ? `SETUP ACTIVATED ${row.setupActivated.join(",")}; ` : "";
  return `${setup}landed ${count("landed")}/${n}, front kept ${count("frontKept")}/${n}, pointer kept ${count("cursorKept")}/${n} [${[...routes].map(([r, c]) => `${r} ${c}`).join(", ")}]${errors.length ? ` (${errors[0]!.slice(0, 70)})` : ""}${row.note ? ` ${row.note}` : ""}`;
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
else if (verb === "focus") await focusTest(rest);
else if (verb === "compare" && rest.length >= 1) compare(rest);
else {
  console.log("usage: bun scripts/computer-bgmouse-matrix.ts run [--technique skylight|activate|pid] [--stamp screen|local|none] [--rows a,b] [--reps n] [--out f.json]\n       bun scripts/computer-bgmouse-matrix.ts compare <a.json> [b.json ...]");
  process.exit(1);
}
