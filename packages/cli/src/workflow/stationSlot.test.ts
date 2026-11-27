import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileSlot } from "../lockFile.js";
import { machineMemoryProbe } from "../watcherMemory.js";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
import { parseWorkflowFile, parseWorkflowSource, validateWorkflow } from "./parser.js";
import { runWorkflow } from "./runner.js";
import { NO_SLOT, withStationSlot } from "./stationSlot.js";
import { machineSlotDir } from "../machineSlot.js";
import type { WorkflowNode } from "./types.js";

isolateCodecastDirEachTest("cast-station-slot-");

const node = (over: Partial<WorkflowNode> = {}): WorkflowNode => ({ id: "local_ci", label: "Local CI", shape: "parallelogram", type: "command", script: "true", machine_slot: "local_ci", timeout: 20, ...over });

const realProbe = machineMemoryProbe.read;
let logs: string[] = [];
const realLog = console.log;
beforeEach(() => {
  logs = [];
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  machineMemoryProbe.read = () => null;
  process.env.CAST_LOCAL_CI_MAX = "2";
});
afterEach(() => {
  console.log = realLog;
  machineMemoryProbe.read = realProbe;
  delete process.env.CAST_LOCAL_CI_MAX;
});

/** Both of local_ci's places, held by this (live) process until released. */
async function fillSlots(): Promise<() => void> {
  const held = [await acquireFileSlot(machineSlotDir("local_ci"), 2), await acquireFileSlot(machineSlotDir("local_ci"), 2)];
  return () => held.forEach((r) => r());
}

describe("a station's machine slot", () => {
  test("admits at most the cap of contenders across processes, and the one over it runs when a place frees", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slot-contenders-"));
    const log = path.join(dir, "log");
    const script = path.join(dir, "contender.ts");
    fs.writeFileSync(script, `
      import * as fs from "node:fs";
      import { machineMemoryProbe } from ${JSON.stringify(path.resolve(import.meta.dir, "../watcherMemory.ts"))};
      import { withStationSlot } from ${JSON.stringify(path.resolve(import.meta.dir, "stationSlot.ts"))};
      machineMemoryProbe.read = () => null;
      const node = { id: "local_ci", label: "Local CI", shape: "parallelogram", type: "command", script: "true", machine_slot: "local_ci", timeout: 60 };
      const outcome = await withStationSlot(node, {}, async () => {
        fs.appendFileSync(${JSON.stringify(log)}, "start " + Date.now() + "\\n");
        await Bun.sleep(1500);
        fs.appendFileSync(${JSON.stringify(log)}, "end " + Date.now() + "\\n");
        return "success";
      });
      process.stdout.write(outcome);
    `);
    const env = { ...process.env, CAST_LOCAL_CI_MAX: "2" };
    const procs = [0, 1, 2].map(() => Bun.spawn(["bun", script], { env, stdout: "pipe", stderr: "pipe" }));
    const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
    await Promise.all(procs.map((p) => p.exited));
    expect(outs.map((o) => o.trim().split("\n").pop())).toEqual(["success", "success", "success"]);
    // The one over the cap said it waited, and why.
    expect(outs.filter((o) => o.includes("waiting to run Local CI: all 2 local_ci slots on this machine are taken"))).toHaveLength(1);
    // Walk the starts and ends in time order: never more than two inside at once, and two did run side by side.
    const events = fs.readFileSync(log, "utf-8").trim().split("\n").map((l) => l.split(" ")).map(([k, t]) => ({ k, t: Number(t) }));
    expect(events.filter((e) => e.k === "start")).toHaveLength(3);
    let inside = 0, most = 0;
    for (const e of events.sort((a, b) => a.t - b.t || (a.k === "end" ? -1 : 1))) {
      inside += e.k === "start" ? 1 : -1;
      most = Math.max(most, inside);
    }
    expect(most).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  test("a place whose holder died is taken at once", async () => {
    const dir = machineSlotDir("local_ci");
    fs.mkdirSync(dir, { recursive: true });
    for (const i of [0, 1]) fs.writeFileSync(path.join(dir, `slot-${i}.lock`), JSON.stringify({ pid: 999_999, at: Date.now() }));
    let ran = false;
    const outcome = await withStationSlot(node({ timeout: 2 }), {}, async () => { ran = true; return "success"; });
    expect(outcome).toBe("success");
    expect(ran).toBe(true);
  });

  test("a station that waits its timeout without a place ends no_slot, saying why, and never runs", async () => {
    const release = await fillSlots();
    const context: Record<string, string> = { "local_ci.exit_code": "1" };
    let ran = false;
    const outcome = await withStationSlot(node({ timeout: 1 }), context, async () => { ran = true; return "success"; });
    release();
    expect(outcome).toBe(NO_SLOT);
    expect(ran).toBe(false);
    expect(context["local_ci.output"]).toBe("Local CI did not run: all 2 local_ci slots on this machine stayed taken for 1s (no_slot).");
    // A stale exit code from an earlier visit must not route this one.
    expect(context["local_ci.exit_code"]).toBeUndefined();
    expect(logs.join("\n")).toContain("waiting to run Local CI: all 2 local_ci slots on this machine are taken");
  });

  test("a machine short of memory admits nothing, even with every place free", async () => {
    machineMemoryProbe.read = () => ({ availableBytes: 0, swapUsedBytes: 0, swapTotalBytes: 0, pressureLevel: 4 });
    const context: Record<string, string> = {};
    const outcome = await withStationSlot(node({ timeout: 1 }), context, async () => "success");
    expect(outcome).toBe(NO_SLOT);
    expect(context["local_ci.output"]).toContain("the machine stayed short of memory");
  });

  test("the wait spends none of the station's timeout: its clock starts when it holds a place", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "slot-clock-"));
    // Waits ~1.5s for a place, then runs 1.5s: 3s in all against a 2s timeout, which only the script's own time counts.
    const g = parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
      ci [shape=parallelogram, machine_slot="local_ci", timeout=2, script="sleep 1.5; echo ran"]
      exit [shape=Msquare]
      start -> ci
      ci -> exit [condition="outcome = success"]
    }`, root);
    const release = await fillSlots();
    setTimeout(release, 1500);
    expect(await runWorkflow(g, { cwd: root })).toBe("completed");
    expect(logs.join("\n")).toContain("waiting to run ci");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("the flow routes no_slot like any outcome", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "slot-route-"));
    const g = parseWorkflowSource(`digraph g {
      start [shape=Mdiamond]
      ci [shape=parallelogram, machine_slot="local_ci", timeout=1, script="echo ran-ci"]
      left [shape=parallelogram, script="echo left-to-ci"]
      exit [shape=Msquare]
      start -> ci
      ci -> exit [condition="outcome = success"]
      ci -> left [condition="outcome = no_slot"]
      left -> exit
    }`, root);
    const release = await fillSlots();
    try {
      expect(await runWorkflow(g, { cwd: root })).toBe("completed");
    } finally {
      release();
    }
    const said = logs.join("\n");
    expect(said).toContain("left-to-ci");
    expect(said).not.toContain("ran-ci");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("machine_slot= in a flow", () => {
  const graph = (attrs: string) => parseWorkflowSource(`digraph g {
    start [shape=Mdiamond]
    s [${attrs}]
    exit [shape=Msquare]
    start -> s -> exit
  }`);

  test("names a slot of this machine's caps, on a command station", () => {
    expect(validateWorkflow(graph(`shape=parallelogram, script="true", machine_slot="local_ci"`))).toEqual([]);
    expect(validateWorkflow(graph(`shape=parallelogram, script="true", machine_slot="local_cii"`))).toEqual([`s [machine_slot="local_cii"]: local_cii names no machine slot; the slots: local_ci`]);
    // The typecheck watchers' count is a machine cap, but not one a station takes a place in.
    expect(validateWorkflow(graph(`shape=parallelogram, script="true", machine_slot="check"`))).toEqual([`s [machine_slot="check"]: check names no machine slot; the slots: local_ci`]);
    expect(validateWorkflow(graph(`prompt="Do it", machine_slot="local_ci"`))).toEqual([`s [machine_slot="local_ci"]: only a command station (shape=parallelogram) takes a machine slot`]);
  });

  test("Codecast's change flow runs Local CI in local_ci, and a wait that runs out goes on to the pull request", () => {
    const g = parseWorkflowFile(path.resolve(import.meta.dir, "../../../../.codecast/flows/change.cast"));
    expect(validateWorkflow(g)).toEqual([]);
    expect(g.nodes.get("local_ci")!.machine_slot).toBe("local_ci");
    const out = g.edges.filter((e) => e.from === "local_ci").map((e) => `${e.condition} -> ${e.to}`).sort();
    expect(out).toEqual(["outcome = failure -> local_ci_fix", "outcome = no_slot -> pr", "outcome = success -> pr"]);
  });

  test("a placed station writes routes only for its other outcomes", () => {
    const files: Record<string, string> = {
      "/r/base.cast": `digraph base { start [shape=Mdiamond] a [shape=parallelogram, script="true"] exit [shape=Msquare] start -> a -> exit }`,
      "/r/ok.cast": `digraph v { graph [extends="base.cast"] n [before="a", shape=parallelogram, script="true", machine_slot="local_ci"] n -> exit [condition="outcome = no_slot"] }`,
      "/r/bad.cast": `digraph v { graph [extends="base.cast"] n [before="a", shape=parallelogram, script="true"] n -> exit [condition="outcome = success"] }`,
    };
    const read = (abs: string) => files[abs] ?? null;
    const ok = parseWorkflowFile("/r/ok.cast", { read });
    expect(ok.edges.filter((e) => e.from === "n").map((e) => `${e.condition} -> ${e.to}`).sort()).toEqual(["outcome = no_slot -> exit", "outcome = success -> a"]);
    expect(() => parseWorkflowFile("/r/bad.cast", { read })).toThrow("n is placed with before= and also routed here");
  });
});
