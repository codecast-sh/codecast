// A station's processes never outlive it: not past its timeout, not past a
// cancel, not past its runner (stationProcs.ts).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pollUntil } from "../test-helpers/pollUntil.js";
import { isolateCodecastDir, type IsolatedCodecastDir } from "../test-helpers/codecastDir.js";
import { executeCommand } from "./commandStation";
import { KILL_IF_SAME, reapDeadRunnerStations, stationRecordDir } from "./stationProcs";
import { snapshotProcessTable } from "../processTable.js";
import type { WorkflowNode } from "./types";

let home: IsolatedCodecastDir;
let tmp = "";
beforeAll(() => { home = isolateCodecastDir(); });
afterAll(() => home.restore());

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidsIn = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map(Number) : []);
const strays: number[] = [];
// The production grace between TERM and KILL is 10 s; these cases need only see the KILL come.
const graceMs = 500;
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

describe("a station that will not end on its own", () => {
  test("is gone entirely after its timeout, setsid and TERM-ignoring children included, and the run moves on", async () => {
    const { node, started } = nastyStation("slow", { timeout: 2 });
    const ctx: Record<string, string> = {};
    expect(await executeCommand(node, ctx, tmp, { graceMs })).toBe("failure");
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
    expect(await executeCommand(node, ctx, tmp, { ended, everyMs: 100, graceMs })).toBe("failure");
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
      `await executeCommand(${JSON.stringify(node)} as any, {}, ${JSON.stringify(tmp)}, { graceMs: ${graceMs} });`,
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

  test("leaves a pid alone once it names another process, and KILLs it while it is the same one", async () => {
    const proc = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
    strays.push(proc.pid);
    await new Promise((r) => setTimeout(r, 1_100));
    const row = snapshotProcessTable().find((p) => p.pid === proc.pid)!;
    const killIfSame = (identity: string) => Bun.spawnSync(["sh", "-c", KILL_IF_SAME, "sh", "0", String(proc.pid), identity], { env: { ...process.env, LANG: "C", LC_ALL: "C" } });
    killIfSame(`${row.pgid} Thu Jan  1 00:00:00 1970`.replace(/\s+/g, " "));
    killIfSame(`${Number(row.pgid) + 1} ${row.startedAt}`);
    expect(alive(proc.pid)).toBe(true);
    killIfSame(`${row.pgid} ${row.startedAt}`);
    expect(await proc.exited).toBe(137);
  });

  test("ends at the next station any runner starts when its runner was SIGKILLed", async () => {
    const { node, started } = nastyStation("killed");
    const runner = runnerScript(node);
    await pollUntil(() => started().length === 4 && fs.existsSync(path.join(stationRecordDir(), `${runner.pid}.json`)), "the station starting and its record", { ms: 15_000 });
    runner.kill("SIGKILL");
    await runner.exited;
    expect(started().filter(alive)).toHaveLength(4);
    expect(await reapDeadRunnerStations(undefined, graceMs)).toHaveLength(1);
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
    expect(await executeCommand(node, ctx, tmp, { graceMs })).toBe("success");
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
