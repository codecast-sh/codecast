/**
 * `cast sim`: iOS simulators for agents, the same on a laptop and a cloud Mac.
 *
 * A session acquires one simulator from the machine's pool (sim/pool.ts), and
 * every per-device verb then targets it by default: boot, install, launch,
 * screenshot into the thread, the accessibility tree, tap, type, swipe and the
 * hardware buttons. The daemon shuts down pool simulators nobody holds
 * (sim/reap.ts), and `cast hosts setup` provisions a cloud Mac (sim/provision.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import type { PublishDeps } from "../castApi.js";
import { fmt, icons } from "../colors.js";
import { commandGroup } from "../commandGroups.js";
import { inlineImageMarker } from "../inlineImage.js";
import { spawnSync } from "../proc.js";
import { agentTempPath } from "../tempFiles.js";
import { acquire, heldByCaller, lockDir, poolStatus, readPool, releaseLock, writePool, type PoolEntry } from "./pool.js";
import { axe, axeBin, boot, bundleIdOf, DEFAULT_POOL_SIZE, ensurePool, hasSimctl, listDevices, listRuntimes, screenshot, shutdown, simctl, why } from "./simctl.js";
import { describeUi, findElements, formatElement, formatTree, screenPoints, type UiElement } from "./ui.js";

const OK = fmt.success(icons.check);

function die(msg: string, hint?: string): never {
  console.error(`${fmt.error(icons.cross)} ${msg}`);
  if (hint) console.error(fmt.muted(`  ${hint}`));
  process.exit(1);
}

function attempt<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    die((err as Error).message);
  }
}

/** The device a per-device verb acts on: --udid, else the one this session holds. */
function target(udid?: string): string {
  if (udid) return udid;
  const held = heldByCaller();
  if (held) return held.udid;
  die("this session holds no simulator", "cast sim acquire  (or pass --udid)");
}

function stateLine(e: PoolEntry, booted: Map<string, string>): string {
  const dev = booted.get(e.udid) ?? "missing";
  const lock =
    e.state === "held" ? `held by ${e.owner ?? "pid"} ${e.pid}${e.session ? ` (session ${e.session.slice(0, 8)})` : ""}` :
    e.state === "stale" ? `stale (holder ${e.pid} exited; acquirable)` : "free";
  return `${String(e.index).padEnd(2)} ${e.state === "held" ? "LOCKED" : e.state === "stale" ? "STALE " : "FREE  "}  ${e.udid}  ${e.name.padEnd(16)} ${dev.padEnd(9)} ${fmt.muted(lock)}`;
}

function parseNum(v: string, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) die(`${name} must be a number`);
  return n;
}

function readTextArg(text: string | undefined): string {
  if (text === "-" || text === undefined) return fs.readFileSync(0, "utf-8").replace(/\n$/, "");
  return text;
}

/** Screenshot, scaled to points when the screen size is known, so a position read off it is the coordinate a tap takes. */
function takeShot(udid: string, out?: string): { file: string; scaled: boolean; points?: { width: number; height: number } } {
  const file = path.resolve(out ?? agentTempPath("sim", `sim-${udid.slice(0, 8)}-${Date.now()}.png`));
  screenshot(udid, file);
  if (!axeBin()) return { file, scaled: false };
  let points: { width: number; height: number } | undefined;
  try { points = screenPoints(describeUi(udid).elements); } catch { return { file, scaled: false }; }
  if (!points) return { file, scaled: false };
  const r = spawnSync("sips", ["-z", String(Math.round(points.height)), String(Math.round(points.width)), file], { stdio: "ignore" });
  return { file, scaled: r.status === 0, points };
}

function pick(elements: UiElement[], query: string, nth?: number): UiElement {
  const hits = findElements(elements, query);
  if (!hits.length) die(`nothing on screen matches "${query}"`, "cast sim ui  to see the elements");
  if (nth !== undefined) {
    const hit = hits[nth - 1];
    if (!hit) die(`only ${hits.length} element(s) match "${query}"`);
    return hit;
  }
  if (hits.length > 1) {
    console.error(`${hits.length} elements match "${query}"; pass --nth <n>:`);
    hits.slice(0, 12).forEach((h, i) => console.error(`  ${formatElement({ ...h, depth: 0 }, i + 1)}`));
    process.exit(1);
  }
  return hits[0];
}

function axeOrDie(args: string[]): string {
  const r = axe(args);
  if (!r.ok) die(why(r));
  return r.stdout;
}

export function registerSimCommand(program: Command, deps: PublishDeps): void {
  const sim = program
    .command("sim")
    .description(commandGroup("sim").description)
    .addHelpText("after", `
A session acquires one pool simulator and every other verb targets it:

  cast sim acquire               # takes a free simulator, boots it, prints its UDID
  cast sim install path/To.app   # then: cast sim launch <bundle-id>
  cast sim shot                  # screenshot into the thread (points: a pixel is a tap coordinate)
  cast sim ui                    # the accessibility tree, each element with its tap point
  cast sim tap --label "Sign in" # or -x 120 -y 640
  cast sim release               # done; the daemon shuts idle simulators down`);

  sim
    .command("list", { isDefault: true })
    .alias("ls")
    .description("The pool: each simulator, its lock and whether it is booted")
    .option("-q, --quiet", "Only the acquirable UDIDs (free or stale)")
    .option("--json", "Machine-readable")
    .action((o: { quiet?: boolean; json?: boolean }) => {
      const status = poolStatus();
      if (o.quiet) { for (const e of status) if (e.state !== "held") console.log(e.udid); return; }
      const booted = new Map<string, string>();
      if (hasSimctl()) for (const d of attempt(listDevices)) booted.set(d.udid, d.state);
      if (o.json) { console.log(JSON.stringify(status.map((e) => ({ ...e, device: booted.get(e.udid) ?? null })), null, 2)); return; }
      if (!status.length) { console.log(fmt.muted("  no pool yet: `cast sim acquire` creates one")); return; }
      for (const e of status) console.log(stateLine(e, booted));
      const mine = heldByCaller(status);
      if (mine) console.log(fmt.muted(`  this session holds ${mine.name} (${mine.udid})`));
    });

  sim
    .command("acquire [index]")
    .description("Take a free pool simulator for this session and boot it; prints the UDID")
    .option("--no-boot", "Take the lock only")
    .action((index: string | undefined, o: { boot: boolean }) => {
      const mine = heldByCaller();
      if (mine) {
        if (o.boot) attempt(() => boot(mine.udid));
        console.error(fmt.muted(`this session already holds ${mine.name}`));
        console.log(mine.udid);
        return;
      }
      const pool = attempt(() => ensurePool());
      const got = acquire({ pool, preferred: index === undefined ? undefined : parseInt(index, 10) });
      if (!got) die("every simulator in the pool is in use", "cast sim list  shows who holds each; try again in a few minutes");
      if (got.reclaimed) console.error(fmt.muted(`reclaimed a stale lock (holder ${got.reclaimed} exited)`));
      if (o.boot) {
        console.error(fmt.muted(`booting ${got.device.name}…`));
        try { boot(got.device.udid); } catch (err) { releaseLock(got.device.udid); die((err as Error).message); }
      }
      console.log(got.device.udid);
    });

  sim
    .command("release [udid]")
    .description("Give the simulator back to the pool (default: the one this session holds)")
    .option("--shutdown", "Shut it down too")
    .action((udid: string | undefined, o: { shutdown?: boolean }) => {
      const id = udid ?? heldByCaller()?.udid;
      if (!id) die("this session holds no simulator");
      if (o.shutdown) shutdown(id);
      if (!releaseLock(id)) die(`simulator ${id} was not locked`);
      console.log(`Released simulator ${id}`);
    });

  sim
    .command("boot [udid]")
    .description("Boot a simulator and wait until it is ready")
    .action((udid?: string) => { const id = target(udid); attempt(() => boot(id)); console.log(`${OK} ${id} booted`); });

  sim
    .command("shutdown [udid]")
    .description("Shut a simulator down")
    .action((udid?: string) => { const id = target(udid); if (!shutdown(id)) die(`could not shut down ${id}`); console.log(`${OK} ${id} shut down`); });

  sim
    .command("install <app>")
    .description("Install an .app build (a simulator build) and print its bundle id")
    .option("--udid <udid>", "Target simulator")
    .option("--launch", "Launch it after installing")
    .action((app: string, o: { udid?: string; launch?: boolean }) => {
      const id = target(o.udid);
      const abs = path.resolve(app);
      if (!fs.existsSync(abs)) die(`no such app: ${abs}`);
      const r = simctl(["install", id, abs], { timeoutMs: 600_000 });
      if (!r.ok) die(`install failed: ${why(r)}`);
      const bundle = bundleIdOf(abs);
      console.log(`${OK} installed ${path.basename(abs)}${bundle ? ` (${bundle})` : ""}`);
      if (o.launch && bundle) {
        const l = simctl(["launch", id, bundle]);
        if (!l.ok) die(`launch failed: ${why(l)}`);
        console.log(`${OK} launched ${bundle} (${l.stdout.trim().split(":").pop()?.trim()})`);
      }
    });

  sim
    .command("launch <bundleId> [args...]")
    .description("Launch an installed app (terminating a running copy first)")
    .option("--udid <udid>", "Target simulator")
    .action((bundle: string, args: string[], o: { udid?: string }) => {
      const r = simctl(["launch", "--terminate-running-process", target(o.udid), bundle, ...args]);
      if (!r.ok) die(`launch failed: ${why(r)}`);
      console.log(`${OK} launched ${bundle} (pid ${r.stdout.trim().split(":").pop()?.trim()})`);
    });

  sim
    .command("terminate <bundleId>")
    .description("Stop a running app")
    .option("--udid <udid>", "Target simulator")
    .action((bundle: string, o: { udid?: string }) => {
      const r = simctl(["terminate", target(o.udid), bundle]);
      if (!r.ok) die(`terminate failed: ${why(r)}`);
      console.log(`${OK} terminated ${bundle}`);
    });

  sim
    .command("open <url>")
    .description("Open a URL (a deep link, or a page in Safari) on the simulator")
    .option("--udid <udid>", "Target simulator")
    .action((url: string, o: { udid?: string }) => {
      const r = simctl(["openurl", target(o.udid), url]);
      if (!r.ok) die(`openurl failed: ${why(r)}`);
      console.log(`${OK} opened ${url}`);
    });

  sim
    .command("shot")
    .description("Screenshot the simulator into the thread (scaled to points: a pixel position is a tap coordinate)")
    .option("--udid <udid>", "Target simulator")
    .option("-o, --out <file>", "Write the PNG here")
    .option("--share", "Also upload it and print a ![alt](url) that renders anywhere")
    .option("--alt <text>", "Caption for --share")
    .option("--json", "Machine-readable")
    .action(async (o: { udid?: string; out?: string; share?: boolean; alt?: string; json?: boolean }) => {
      const id = target(o.udid);
      const shot = attempt(() => takeShot(id, o.out));
      let url: string | undefined;
      if (o.share) {
        const { uploadOne } = await import("../imageCommand.js");
        const img = await uploadOne(deps, shot.file, o.alt || "simulator screenshot");
        url = img.url;
        if (!o.json) console.log(img.markdown);
      }
      if (o.json) { console.log(JSON.stringify({ udid: id, file: shot.file, points: shot.points ?? null, scaled: shot.scaled, url: url ?? null })); return; }
      console.log(inlineImageMarker(shot.file));
      console.log(fmt.muted(`  ${shot.file}${shot.points ? `  ${shot.points.width}x${shot.points.height} points` : "  device pixels"}`));
    });

  sim
    .command("ui")
    .alias("describe-ui")
    .description("The accessibility tree: each element's type, label and tap point")
    .option("--udid <udid>", "Target simulator")
    .option("-f, --find <text>", "Only elements whose label, value or id matches")
    .option("--all", "Include unnamed layout containers")
    .option("--json", "axe's raw JSON")
    .action((o: { udid?: string; find?: string; all?: boolean; json?: boolean }) => {
      const { raw, elements } = attempt(() => describeUi(target(o.udid)));
      if (o.json) { console.log(JSON.stringify(raw, null, 2)); return; }
      if (o.find) { findElements(elements, o.find).forEach((e, i) => console.log(formatElement({ ...e, depth: 0 }, i + 1))); return; }
      for (const line of o.all ? elements.map((e) => formatElement(e)) : formatTree(elements)) console.log(line);
    });

  sim
    .command("tap")
    .description("Tap a point (-x -y, in points) or an element by its label, value or id")
    .option("--udid <udid>", "Target simulator")
    .option("-x <x>", "X in points")
    .option("-y <y>", "Y in points")
    .option("-l, --label <text>", "The element to tap, by label, value or id")
    .option("--nth <n>", "Which match, when several elements match --label")
    .option("--shot", "Screenshot into the thread after the tap")
    .action(async (o: { udid?: string; x?: string; y?: string; label?: string; nth?: string; shot?: boolean }) => {
      const id = target(o.udid);
      let x: number, y: number, what: string;
      if (o.label) {
        const el = pick(attempt(() => describeUi(id)).elements, o.label, o.nth ? parseInt(o.nth, 10) : undefined);
        ({ x, y } = el.center);
        what = formatElement({ ...el, depth: 0 });
      } else {
        if (o.x === undefined || o.y === undefined) die("pass -x and -y, or --label");
        x = parseNum(o.x, "-x"); y = parseNum(o.y, "-y");
        what = `${x},${y}`;
      }
      axeOrDie(["tap", "-x", String(x), "-y", String(y), "--udid", id]);
      console.log(`${OK} tapped ${what}`);
      if (o.shot) { await new Promise((r) => setTimeout(r, 600)); console.log(inlineImageMarker(attempt(() => takeShot(id)).file)); }
    });

  sim
    .command("type [text]")
    .description("Type text into the focused field (- or no argument reads stdin)")
    .option("--udid <udid>", "Target simulator")
    .action((text: string | undefined, o: { udid?: string }) => {
      const body = readTextArg(text);
      axeOrDie(["type", body, "--udid", target(o.udid)]);
      console.log(`${OK} typed ${body.length} character(s)`);
    });

  sim
    .command("swipe")
    .description("Swipe between two points, or scroll the screen by direction")
    .option("--udid <udid>", "Target simulator")
    .option("--direction <dir>", "up | down | left | right (the content moves the other way)")
    .option("--start-x <n>").option("--start-y <n>").option("--end-x <n>").option("--end-y <n>")
    .option("--duration <s>", "Seconds")
    .action((o: { udid?: string; direction?: string; startX?: string; startY?: string; endX?: string; endY?: string; duration?: string }) => {
      const id = target(o.udid);
      let pts: number[];
      if (o.direction) {
        const size = screenPoints(attempt(() => describeUi(id)).elements) ?? { width: 390, height: 844 };
        const cx = Math.round(size.width / 2), cy = Math.round(size.height / 2);
        const dy = Math.round(size.height * 0.3), dx = Math.round(size.width * 0.35);
        const dirs: Record<string, number[]> = { up: [cx, cy + dy, cx, cy - dy], down: [cx, cy - dy, cx, cy + dy], left: [cx + dx, cy, cx - dx, cy], right: [cx - dx, cy, cx + dx, cy] };
        pts = dirs[o.direction] ?? die("--direction is up, down, left or right");
      } else {
        if ([o.startX, o.startY, o.endX, o.endY].some((v) => v === undefined)) die("pass --start-x --start-y --end-x --end-y, or --direction");
        pts = [parseNum(o.startX!, "--start-x"), parseNum(o.startY!, "--start-y"), parseNum(o.endX!, "--end-x"), parseNum(o.endY!, "--end-y")];
      }
      axeOrDie(["swipe", "--start-x", String(pts[0]), "--start-y", String(pts[1]), "--end-x", String(pts[2]), "--end-y", String(pts[3]), ...(o.duration ? ["--duration", o.duration] : []), "--udid", id]);
      console.log(`${OK} swiped ${pts[0]},${pts[1]} → ${pts[2]},${pts[3]}`);
    });

  sim
    .command("button <name>")
    .description("Press a hardware button: home, lock, side-button, siri, apple-pay")
    .option("--udid <udid>", "Target simulator")
    .action((name: string, o: { udid?: string }) => {
      axeOrDie(["button", name, "--udid", target(o.udid)]);
      console.log(`${OK} pressed ${name}`);
    });

  sim
    .command("axe <args...>")
    .description("Run any other axe verb against this session's simulator (key, gesture, touch, record-video…)")
    .option("--udid <udid>", "Target simulator")
    .allowUnknownOption()
    .action((args: string[], o: { udid?: string }) => {
      process.stdout.write(axeOrDie([...args, "--udid", target(o.udid)]));
    });

  sim
    .command("reap")
    .description("Shut down pool simulators nobody holds or uses (the daemon runs this every few minutes)")
    .option("--grace <secs>", "Orphan age before shutdown", "600")
    .action(async (o: { grace: string }) => {
      const { reapIdleSimulators } = await import("./reap.js");
      const r = reapIdleSimulators({ graceSecs: parseInt(o.grace, 10), log: (m) => console.log(`[${new Date().toISOString().slice(0, 19).replace("T", " ")}] ${m}`) });
      if (!r.reaped.length && !r.struck.length && !r.cleared.length) console.log(fmt.muted("  nothing to reap"));
    });

  sim
    .command("pool")
    .description("Show or set this machine's pool (~/.codecast/sim/pool.json)")
    .option("--set <devices>", "Comma-separated UDID or UDID=Name entries")
    .option("--create <n>", `Create n codecast iPhones (default ${DEFAULT_POOL_SIZE}) when there is no pool`)
    .action((o: { set?: string; create?: string }) => {
      if (o.set) {
        const devices = o.set.split(",").map((s) => s.trim()).filter(Boolean).map((e) => { const [udid, ...n] = e.split("="); return { udid, name: n.join("=") || udid }; });
        writePool(devices);
      } else if (o.create) {
        attempt(() => ensurePool(parseInt(o.create!, 10)));
      }
      for (const d of readPool()) console.log(`${d.udid}  ${d.name}`);
      console.log(fmt.muted(`  locks in ${lockDir()}`));
    });

  sim
    .command("doctor")
    .description("What this machine has for simulators: Xcode, runtimes, axe, pool")
    .action(() => {
      const xcode = spawnSync("xcode-select", ["-p"], { encoding: "utf-8" }).stdout?.trim();
      console.log(`xcode:    ${xcode || "none"}${hasSimctl() ? "" : "  (no simctl: install Xcode)"}`);
      if (hasSimctl()) {
        const rts = attempt(listRuntimes).filter((r) => r.available);
        console.log(`runtimes: ${rts.map((r) => r.name).join(", ") || "none (xcodebuild -downloadPlatform iOS)"}`);
      }
      console.log(`axe:      ${axeBin() ?? "missing (brew install cameroncooke/axe/axe)"}`);
      console.log(`pool:     ${readPool().length} simulator(s), locks in ${lockDir()}`);
    });
}
