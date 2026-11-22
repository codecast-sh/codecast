// A station's processes never outlive it: not past its timeout, not past a
// cancel, not past its runner (stationProcs.ts).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pollUntil } from "../test-helpers/pollUntil.js";
import { isolateCodecastDir, type IsolatedCodecastDir } from "../test-helpers/codecastDir.js";
import { executeCommand } from "./commandStation";
import { parseProcs, reapDeadRunnerStations, stationProcs, stationRecordDir } from "./stationProcs";
import type { WorkflowNode } from "./types";

let home: IsolatedCodecastDir;
let tmp = "";
beforeAll(() => { home = isolateCodecastDir(); });
afterAll(() => home.restore());

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidsIn = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map(Number) : []);
const strays: number[] = [];
afterEach(() => {
  for (const pid of strays.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

// The script that leaked on Union's machines, in small: a child that ignores
// TERM, a `set -m` job (a group of its own, as proof-tree.sh runs its command)
// and a setsid grandchild that ignores TERM; the last two hold the station's
// output pipe, so `close` never fires while they live. All four pids land in `pids`.
function nastyStation(id: string, extra: Partial<WorkflowNode> = {}): { node: WorkflowNode; pids: string; started: () => number[] } {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "station-procs-"));
  const pids = path.join(tmp, "pids");
  const inner = path.join(tmp, "nasty.sh");
  fs.writeFileSync(inner, [
    `echo $$ >> ${pids}`,
    `( trap '' TERM; while :; do sleep 1; done ) & echo $! >> ${pids}`,
    `set -m`,
    `( trap '' TERM; exec sleep 600 ) & echo $! >> ${pids}`,
    `set +m`,
    `perl -MPOSIX -e 'POSIX::setsid(); $SIG{TERM}="IGNORE"; sleep 600' & echo $! >> ${pids}`,
    `echo started`,
    `wait`,
  ].join("\n"));
  const node = { id, label: id, type: "command", script: `bash ${inner}`, timeout: 600, ...extra } as WorkflowNode;
  const started = () => { const p = pidsIn(pids); strays.push(...p.filter((x) => !strays.includes(x))); return p; };
  return { node, pids, started };
}

describe("a station's process tree", () => {
  test("is its group, every descendant, and every group a descendant left for", () => {
    // 100 is the station's group; 103 left it with setsid, 104 is 103's child; 105 sits in 100 under init; 200 is unrelated.
    const procs = parseProcs([
      `${process.pid} 1 ${process.pid} 01:00`,
      "100 1 100 05:00", "101 100 100 04:59", "102 101 100 1-02:03:04",
      "103 101 103 04:58", "104 103 103 04:57", "105 1 100 04:56", "200 1 200 10:00",
    ].join("\n"));
    expect(stationProcs(100, procs).sort()).toEqual([100, 101, 102, 103, 104, 105]);
    expect(procs.find((p) => p.pid === 102)!.elapsedS).toBe(93_784);
  });
});

describe("a station that will not end on its own", () => {
  test("is gone entirely after its timeout, setsid and TERM-ignoring children included, and the run moves on", async () => {
    const { node, started } = nastyStation("slow", { timeout: 2 });
    const ctx: Record<string, string> = {};
    expect(await executeCommand(node, ctx, tmp)).toBe("failure");
    expect(ctx["slow.exit_code"]).toBe("124");
    expect(ctx["slow.output"]).toContain("timed out after 2s");
    expect(started()).toHaveLength(4);
    await pollUntil(() => !started().some(alive), "every station process ending", { ms: 15_000 });
  }, 60_000);

  test("is gone entirely once its run ends on the server, long before its timeout", async () => {
    const { node, started } = nastyStation("cancelled");
    const ctx: Record<string, string> = {};
    const t0 = Date.now();
    const ended = async () => started().length === 4;
    expect(await executeCommand(node, ctx, tmp, { ended, everyMs: 100 })).toBe("failure");
    expect(Date.now() - t0).toBeLessThan(120_000);
    expect(ctx["cancelled.output"]).toContain("stopped: the run ended");
    expect(["143", "137"]).toContain(ctx["cancelled.exit_code"]);
    await pollUntil(() => !started().some(alive), "every station process ending", { ms: 15_000 });
  }, 60_000);
});

describe("a station whose runner goes", () => {
  const runnerScript = (node: WorkflowNode) => {
    const file = path.join(tmp, "runner.ts");
    fs.writeFileSync(file, [
      `import { stopRunOnSignals } from ${JSON.stringify(path.join(import.meta.dir, "runner.ts"))};`,
      `import { executeCommand } from ${JSON.stringify(path.join(import.meta.dir, "commandStation.ts"))};`,
      `stopRunOnSignals({} as any);`,
      `await executeCommand(${JSON.stringify(node)} as any, {}, ${JSON.stringify(tmp)});`,
    ].join("\n"));
    return Bun.spawn([process.execPath, file], { cwd: tmp, stdout: "ignore", stderr: "ignore", env: { ...process.env } });
  };

  test("ends with a runner stopped by SIGTERM, TERM-ignoring and setsid processes included", async () => {
    const { node, started } = nastyStation("poll");
    const runner = runnerScript(node);
    await pollUntil(() => started().length === 4, "the station's processes starting", { ms: 15_000 });
    runner.kill("SIGTERM");
    expect(await runner.exited).toBe(143);
    await pollUntil(() => !started().some(alive), "every station process ending", { ms: 30_000 });
    expect(fs.existsSync(path.join(stationRecordDir(), `${runner.pid}.json`))).toBe(false);
  }, 60_000);

  test("ends at the next station any runner starts when its runner was SIGKILLed", async () => {
    const { node, started } = nastyStation("killed");
    const runner = runnerScript(node);
    await pollUntil(() => started().length === 4 && fs.existsSync(path.join(stationRecordDir(), `${runner.pid}.json`)), "the station starting and its record", { ms: 15_000 });
    runner.kill("SIGKILL");
    await runner.exited;
    expect(started().filter(alive)).toHaveLength(4);
    expect(await reapDeadRunnerStations()).toHaveLength(1);
    await pollUntil(() => !started().some(alive), "every station process ending", { ms: 30_000 });
    expect(fs.existsSync(path.join(stationRecordDir(), `${runner.pid}.json`))).toBe(false);
  }, 60_000);
});

describe("a station that ends on its own", () => {
  test("takes the background jobs it left in its group with it", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "station-procs-"));
    const pids = path.join(tmp, "pids");
    const node = { id: "leaves", type: "command", script: `sleep 600 >/dev/null 2>&1 & echo $! > ${pids}; echo done` } as WorkflowNode;
    const ctx: Record<string, string> = {};
    expect(await executeCommand(node, ctx, tmp)).toBe("success");
    strays.push(...pidsIn(pids));
    expect(ctx["leaves.output"]).toBe("done");
    await pollUntil(() => !pidsIn(pids).some(alive), "the left job ending", { ms: 15_000 });
  }, 30_000);

  test("is flagged when it prints nothing past its bound, and not cut off", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "station-procs-"));
    const node = { id: "quiet", type: "command", script: "sleep 2; exit 3", silent: 1 } as WorkflowNode;
    const ctx: Record<string, string> = {};
    expect(await executeCommand(node, ctx, tmp, { everyMs: 100 })).toBe("failure");
    expect(ctx["quiet.exit_code"]).toBe("3");
    expect(ctx["quiet.output"]).toContain("printed nothing for");
  }, 30_000);
});
