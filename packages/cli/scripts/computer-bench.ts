#!/usr/bin/env bun
/**
 * `cast computer` measured against an app that reports its own state.
 *
 *   bun scripts/computer-bench.ts run --label base --out /tmp/cc-bench/base.json
 *   bun scripts/computer-bench.ts compare /tmp/cc-bench/base.json /tmp/cc-bench/new.json
 *
 * `run` drives the helper installed at the fixed path (the grant is keyed to
 * it), so comparing two builds is install, run, install, run. Nothing here goes
 * through the CLI's argv: a command spends one to three seconds starting, which
 * would bury every number below.
 *
 * The fixture (computer-bench-fixture.swift) never activates and opens its
 * windows at the back. Whether an action landed is read from the file the
 * fixture writes, never from what the helper says it did; whether the helper
 * REPORTED the change is a separate column, because an agent acts on the
 * report.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { helperExecutablePath } from "../src/computer/helperApp.js";
import { readInstance } from "../src/computer/instance.js";
import { resolveElement } from "../src/computer/tree.js";
import { fixtureClient, fixtureStatus as status, launchFixture } from "../src/test-helpers/computerBenchFixture.js";
import type { ComputerActionMethod, ComputerActionResult, ComputerSnapshotResult } from "../src/computer/types.js";

const WORK = path.join(os.tmpdir(), "cc-bench");

type Row = {
  name: string;
  /** Milliseconds per sample, when the measure is a duration. */
  ms?: number[];
  /** Successes over attempts, when the measure is an outcome. */
  hits?: number;
  of?: number;
  note?: string;
  error?: string;
  /** Median milliseconds per helper phase, when the helper reports them. */
  phases?: Record<string, number>;
};

type Report = { label: string; at: string; load: number; helper: string; rows: Row[] };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : NaN;
};

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = performance.now();
  const value = await fn();
  return { ms: performance.now() - started, value };
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await sleep(25);
  }
  return check();
}

async function run(args: string[]): Promise<void> {
  const label = flag(args, "label") ?? "run";
  const out = flag(args, "out") ?? path.join(WORK, `${label}.json`);
  const reps = Number(flag(args, "reps") ?? 9);
  const rows: Row[] = [];
  const helper = flag(args, "helper");
  const client = fixtureClient(helper);
  const phases: Record<string, Record<string, number[]>> = {};
  let phaseRow = "";
  const fixture = await launchFixture();
  const barren = await launchFixture(["--barren"]);
  const app = `pid:${fixture.pid}`;
  const form = { app, windowId: fixture.windows["Bench Form"], noScreenshot: true };
  const table = { app, windowId: fixture.windows["Bench Table"], noScreenshot: true };
  const canvas = { app, windowId: fixture.windows["Bench Canvas"], noScreenshot: true };
  const large = { app, windowId: fixture.windows["Bench Large"], noScreenshot: true };
  const trees: Record<string, string> = {};

  let roundTrips: number[] = [];
  const read = async (params: Record<string, unknown>) => {
    const result = (await client.getAppState({ ...params, timings: true })) as ComputerSnapshotResult & { walkRoundTrips?: number };
    if (result.walkRoundTrips !== undefined) roundTrips.push(result.walkRoundTrips);
    return result;
  };
  const act = async (method: ComputerActionMethod, params: Record<string, unknown>) => {
    const result = (await client.action(method, { ...params, timings: true })) as ComputerActionResult & { timingsMs?: Record<string, number> };
    for (const [phase, ms] of Object.entries(result.timingsMs ?? {})) ((phases[phaseRow] ??= {})[phase] ??= []).push(ms);
    return result;
  };
  const only = flag(args, "only");
  const measure = async (name: string, body: (row: Row) => Promise<void>) => {
    if (only && !new RegExp(only, "i").test(name)) return;
    const row: Row = { name };
    phaseRow = name;
    try {
      await body(row);
    } catch (err) {
      row.error = err instanceof Error ? err.message.split("\n")[0] : String(err);
    }
    const split = Object.entries(phases[name] ?? {}).map(([phase, ms]) => `${phase} ${median(ms).toFixed(0)}`);
    if (split.length) row.phases = Object.fromEntries(Object.entries(phases[name]!).map(([phase, ms]) => [phase, median(ms)]));
    rows.push(row);
    const value = row.ms ? `${median(row.ms).toFixed(0)} ms` : row.hits !== undefined ? `${row.hits}/${row.of}` : "";
    console.log(`  ${name.padEnd(46)} ${value.padEnd(10)} ${row.error ? `ERROR ${row.error}` : (row.note ?? "")}`);
    if (split.length) console.log(`  ${"".padEnd(46)} ${"".padEnd(10)} phases ms: ${split.join(", ")}`);
  };
  const reads = (name: string, params: Record<string, unknown>, count = reps) =>
    measure(name, async (row) => {
      row.ms = [];
      roundTrips = [];
      let last: ComputerSnapshotResult | undefined;
      for (let i = 0; i < count; i++) {
        const sample = await timed(() => read(params));
        row.ms.push(sample.ms);
        last = sample.value;
      }
      trees[name] = last!.snapshot.treeText;
      row.note = `${last!.snapshot.elementCount} elements, ${last!.snapshot.treeText.split("\n").length} lines${last!.snapshot.truncation?.truncated ? ", truncated" : ""}${roundTrips.length ? `, ${median(roundTrips)} AX round trips` : ""}`;
    });
  /** Close the sheet if one is up, through the helper, and wait for the app to agree. */
  const dismissSheet = async () => {
    if (status(fixture).sheetOpen !== true) return;
    const tree = (await read(form)).snapshot.treeText;
    await act("click", { ...form, elementIndex: resolveElement(tree, "Cancel") });
    await until(() => status(fixture).sheetOpen !== true);
  };

  try {
    // The first request also launches the helper; keep that out of the samples.
    await read(form);
    console.log(`\n${label}: helper ${helper ?? helperExecutablePath()}\n`);

    await reads("read: form window", form);
    await reads("read: form window with screenshot", { ...form, noScreenshot: false }, 5);
    await reads("read: 2000-row table", table);
    // What a read of a screen-sized window costs with its picture, and what
    // crosses the socket for it: the reply as JSON, picture included.
    const shotDir = path.join(WORK, "shots");
    const largeShot = { ...large, noScreenshot: false, screenshotDir: shotDir };
    await reads("read: large window", large, 5);
    for (const [name, params] of [
      ["read: large window with screenshot", largeShot],
      ["read: large window, 300x120 crop", { ...largeShot, crop: { x: 24, y: 24, width: 300, height: 120 } }],
    ] as const) {
      await measure(name, async (row) => {
        row.ms = [];
        let last: ComputerSnapshotResult | undefined;
        for (let i = 0; i < 5; i++) {
          const sample = await timed(() => read(params));
          row.ms.push(sample.ms);
          last = sample.value;
        }
        const shot = last!.screenshot;
        row.note = shot
          ? `${shot.width}x${shot.height} scale ${shot.scale}, reply ${(JSON.stringify(last).length / 1024).toFixed(0)} KB, picture ${((shot.bytes ?? 0) / 1024).toFixed(0)} KB`
          : `no screenshot: ${JSON.stringify(last!.screenshotStatus)}`;
      });
    }
    await reads("read: canvas window (pixels only)", canvas, 5);
    await measure("read: canvas text is in the tree", async (row) => {
      const tree = (await read(canvas)).snapshot.treeText;
      row.hits = Number(/CANVAS HELLO/i.test(tree)) + Number(/LAUNCH PROBE/i.test(tree));
      row.of = 2;
    });
    await measure("read: app with nothing to act on shows its text", async (row) => {
      const tree = (await read({ app: `pid:${barren.pid}`, noScreenshot: true })).snapshot.treeText;
      trees[row.name] = tree;
      row.hits = Number(/CANVAS HELLO/i.test(tree)) + Number(/LAUNCH PROBE/i.test(tree));
      row.of = 2;
    });
    await measure("click: pixel-only button by its text, background", async (row) => {
      const target = { app: `pid:${barren.pid}`, noScreenshot: true };
      const tree = (await read(target)).snapshot.treeText;
      const before = Number(status(barren).probeLaunches ?? 0);
      await act("click", { ...target, elementIndex: resolveElement(tree, "LAUNCH PROBE") });
      row.hits = Number(await until(() => Number(status(barren).probeLaunches ?? 0) === before + 1, 2_000));
      row.of = 1;
    });

    await measure("click: checkbox, until the result returns", async (row) => {
      row.ms = [];
      let landed = 0;
      let reported = 0;
      for (let i = 0; i < reps; i++) {
        const tree = (await read(form)).snapshot.treeText;
        const before = status(fixture).subscribe === true;
        const sample = await timed(() => act("click", { ...form, elementIndex: resolveElement(tree, "Subscribe") }));
        row.ms.push(sample.ms);
        if (await until(() => (status(fixture).subscribe === true) !== before, 2_000)) landed++;
        if (sample.value.snapshot.treeText !== sample.value.baselineTreeText) reported++;
      }
      row.note = `landed ${landed}/${reps}, change reported ${reported}/${reps}`;
    });
    await measure("click: two in a row on a fresh read (one agent turn)", async (row) => {
      row.ms = [];
      for (let i = 0; i < reps; i++) {
        const sample = await timed(async () => {
          const tree = (await read(form)).snapshot.treeText;
          const index = resolveElement(tree, "Subscribe");
          await act("click", { ...form, elementIndex: index });
          await act("click", { ...form, elementIndex: index });
        });
        row.ms.push(sample.ms);
      }
    });
    await measure("set-value: text field", async (row) => {
      row.ms = [];
      let verified = 0;
      for (let i = 0; i < reps; i++) {
        const tree = (await read(form)).snapshot.treeText;
        const sample = await timed(() => act("setValue", { ...form, elementIndex: resolveElement(tree, "field (settable) Name"), value: `Ada ${i}` }));
        row.ms.push(sample.ms);
        if (sample.value.action?.verification?.state === "verified") verified++;
      }
      row.note = `verified ${verified}/${reps}`;
    });
    await measure("press-key: Tab in a background window", async (row) => {
      row.ms = [];
      for (let i = 0; i < reps; i++) row.ms.push((await timed(() => act("pressKey", { ...form, key: "Tab" }))).ms);
    });
    await measure("click: label changed by the app's own setter", async (row) => {
      let reported = 0;
      for (let i = 0; i < 5; i++) {
        const tree = (await read(form)).snapshot.treeText;
        const result = await act("click", { ...form, elementIndex: resolveElement(tree, "Count quietly") });
        if (/counted \d+/.test(result.snapshot.treeText) && result.snapshot.treeText !== result.baselineTreeText) reported++;
      }
      row.hits = reported;
      row.of = 5;
    });

    for (const [button, name] of [
      ["Submit", "sheet opens at once"],
      ["Submit after 300ms", "sheet opens 0.3 s after the click"],
      ["Submit after 800ms", "sheet opens 0.8 s after the click"],
    ] as const) {
      await measure(`click: ${name}`, async (row) => {
        row.ms = [];
        let caught = 0;
        let lines = 0;
        for (let i = 0; i < 5; i++) {
          await dismissSheet();
          const tree = (await read(form)).snapshot.treeText;
          const sample = await timed(() => act("click", { ...form, elementIndex: resolveElement(tree, button, 1) }));
          row.ms.push(sample.ms);
          if (/Confirm/.test(sample.value.snapshot.treeText)) caught++;
          await until(() => status(fixture).sheetOpen === true, 3_000);
          await sleep(350);
          const open = (await read(form)).snapshot.treeText;
          lines = open.split("\n").length;
          trees["form with sheet open"] = open;
        }
        await dismissSheet();
        row.note = `sheet in the result ${caught}/5; tree with the sheet open is ${lines} lines`;
      });
    }

    await measure("stale: press a control a sheet now covers", async (row) => {
      let refused = 0;
      let named = 0;
      let pressed = 0;
      for (let i = 0; i < 5; i++) {
        await dismissSheet();
        const tree = (await read(form)).snapshot.treeText;
        const submit = resolveElement(tree, "Submit", 1);
        await act("click", { ...form, elementIndex: resolveElement(tree, "Arm sheet in 2s") });
        await until(() => status(fixture).sheetOpen === true, 3_000);
        await sleep(300);
        const before = Number(status(fixture).blockedPresses ?? 0);
        try {
          await act("click", { ...form, elementIndex: submit });
        } catch (err) {
          refused++;
          if (/opened after your last read/.test(String(err))) named++;
        }
        await sleep(150);
        if (Number(status(fixture).blockedPresses ?? 0) > before) pressed++;
      }
      await dismissSheet();
      row.hits = refused;
      row.of = 5;
      row.note = `refused ${refused}/5 (naming the sheet ${named}/5), pressed under the sheet ${pressed}/5`;
    });

    await measure("cursor: never drawn over a window that covers the target", async (row) => {
      const covered = Number(status(fixture).cursorWhileCovered ?? 0);
      row.hits = Number(covered === 0);
      row.of = 1;
      row.note = `cursor ticks over another app ${covered}`;
    });
    await measure("cursor: shown on a target window that is in view", async (row) => {
      const float = { app, windowId: fixture.windows["Bench Float"], noScreenshot: true };
      const before = Number(status(fixture).cursorWhileVisible ?? 0);
      for (let i = 0; i < 3; i++) {
        const tree = (await read(float)).snapshot.treeText;
        await act("click", { ...float, elementIndex: resolveElement(tree, "Float press") });
        await sleep(400);
      }
      const seen = Number(status(fixture).cursorWhileVisible ?? 0) - before;
      row.hits = Number(seen > 0);
      row.of = 1;
      row.note = `cursor ticks over the target ${seen}`;
    });
    await measure("background: the fixture never became active", async (row) => {
      const took = [...((status(fixture).activations as string[]) ?? []), ...((status(barren).activations as string[]) ?? [])];
      row.hits = Number(!(status(fixture).activations as string[] | undefined)?.length) + Number(!(status(barren).activations as string[] | undefined)?.length);
      row.of = 2;
      if (took.length) row.note = `took the front: ${took.join("; ")}`;
    });

    // Whatever else is running, read only: big real trees are where a walk costs.
    const apps = (await client.listApps()).apps;
    const wanted = args.includes("--live") ? ["com.apple.finder", "com.google.Chrome", "com.apple.Safari", "com.tinyspeck.slackmacgap", "com.apple.dt.Xcode", "com.apple.Terminal", "com.apple.systempreferences", "com.apple.mail", "com.microsoft.VSCode", "com.cron.electron"] : [];
    for (const bundleId of wanted) {
      const found = apps.find((a) => a.bundleId === bundleId);
      if (!found) continue;
      await reads(`read: ${found.name} (live, read only)`, { app: `pid:${found.pid}`, noScreenshot: true }, 3);
    }
  } finally {
    fixture.child.kill();
    barren.child.kill();
    client.shutdown();
    for (const f of [fixture.statusFile, barren.statusFile]) fs.rmSync(f, { force: true });
  }

  const report: Report = { label, at: new Date().toISOString(), load: os.loadavg()[0]!, helper: helper ?? String(readInstance()?.pid ?? ""), rows };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  const treeDir = out.replace(/\.json$/, ".trees");
  fs.mkdirSync(treeDir, { recursive: true });
  for (const [name, tree] of Object.entries(trees)) fs.writeFileSync(path.join(treeDir, `${name.replace(/[^a-z0-9]+/gi, "-")}.txt`), tree);
  console.log(`\nwrote ${out} and ${treeDir}/ (load ${report.load.toFixed(0)})`);
}

function cell(row: Row | undefined): string {
  if (!row) return "-";
  if (row.error) return `error: ${row.error.slice(0, 60)}`;
  const parts: string[] = [];
  if (row.ms?.length) parts.push(`${median(row.ms).toFixed(0)} ms`);
  if (row.hits !== undefined) parts.push(`${row.hits}/${row.of}`);
  if (row.note) parts.push(row.note);
  return parts.join("; ");
}

function compare(files: string[]): void {
  const reports = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as Report);
  const names = [...new Set(reports.flatMap((r) => r.rows.map((row) => row.name)))];
  console.log(`| Measure | ${reports.map((r) => `${r.label} (load ${r.load.toFixed(0)})`).join(" | ")} | Change |`);
  console.log(`|---|${reports.map(() => "---").join("|")}|---|`);
  for (const name of names) {
    const found = reports.map((r) => r.rows.find((row) => row.name === name));
    const first = found[0]?.ms?.length ? median(found[0].ms) : NaN;
    const last = found.at(-1)?.ms?.length ? median(found.at(-1)!.ms!) : NaN;
    const change = Number.isFinite(first) && Number.isFinite(last) && last > 0 ? `${(first / last).toFixed(1)}x` : "";
    console.log(`| ${name} | ${found.map(cell).join(" | ")} | ${change} |`);
  }
}

const [verb, ...rest] = process.argv.slice(2);
if (verb === "run") await run(rest);
else if (verb === "compare" && rest.length >= 2) compare(rest);
else {
  console.log("usage: bun scripts/computer-bench.ts run --label <name> [--out <file.json>] [--reps <n>] [--live] [--only <regex>] [--helper <exe>]\n       bun scripts/computer-bench.ts compare <a.json> <b.json>");
  process.exit(1);
}
