import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileSlot } from "./lockFile.js";
import { listMachineSlots, machineSlotDir } from "./machineSlot.js";
import { CHILD_GRACE_MS, renderSlots } from "./slotCommand.js";
import { isolateCodecastDirEachTest } from "./test-helpers/codecastDir.js";
import { pollUntil } from "./test-helpers/pollUntil.js";

isolateCodecastDirEachTest("cast-slot-cmd-");

const cli = path.resolve(import.meta.dir, "index.ts");
// The real machine may be short of memory while the suite runs, which would hold every place: the CLI under test
// reads a machine with memory to spare, and the memory gate has its own test (workflow/stationSlot.test.ts).
const calm = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slot-calm-")), "calm.ts");
fs.writeFileSync(calm, `import { machineMemoryProbe } from ${JSON.stringify(path.resolve(import.meta.dir, "watcherMemory.ts"))};\nmachineMemoryProbe.read = () => null;\n`);
const slotRun = (...args: string[]) => Bun.spawn(["bun", "--preload", calm, cli, "slot", "run", ...args], { env: { ...process.env, CAST_LOCAL_CI_MAX: "1" }, stdout: "pipe", stderr: "pipe" });

test("a wait that runs out exits 75 and never runs the command", async () => {
  process.env.CAST_LOCAL_CI_MAX = "1";
  const held = await acquireFileSlot(machineSlotDir("local_ci"), 1, { what: "someone else" });
  try {
    const p = slotRun("--name", "local_ci", "--wait", "1s", "--", "sh", "-c", "echo ran");
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(err).toContain("all 1 local_ci slots on this machine stayed taken for 1s");
    expect(code).toBe(75);
    expect(out).not.toContain("ran");
    expect(err).toContain("cast: hint:");
  } finally {
    held();
    delete process.env.CAST_LOCAL_CI_MAX;
  }
}, 90_000);

test("the place is held while the command runs and given back when cast takes a signal", async () => {
  const p = slotRun("--name", "local_ci", "--", "sleep", "30");
  const holders = () => listMachineSlots().find((s) => s.name === "local_ci")!.running;
  await pollUntil(() => holders().length === 1, "cast slot run to take its place", { ms: 40_000 });
  expect(holders()[0]!.what).toBe("sleep 30");
  p.kill("SIGTERM");
  const code = await p.exited;
  // The command heard the signal too, and cast exits as it did (128 + SIGTERM).
  expect(code).toBe(143);
  expect(holders()).toEqual([]);
}, 90_000);

// The lock's own handler gave the place back on the signal, so a second holder could start while the command was still
// winding down.
test("on a signal the place is held until the command has ended", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slot-wind-"));
  const ready = path.join(dir, "ready");
  const ended = path.join(dir, "ended");
  const p = slotRun("--name", "local_ci", "--", "sh", "-c", `trap 'sleep 1; echo 1 > ${ended}; exit 0' TERM; echo 1 > ${ready}; while :; do sleep 0.1; done`);
  await pollUntil(() => fs.existsSync(ready), "the command to start", { ms: 40_000 });
  p.kill("SIGTERM");
  // The command takes a second to wind down, and holds its place through it.
  await Bun.sleep(400);
  expect(fs.existsSync(ended)).toBe(false);
  expect(listMachineSlots().find((s) => s.name === "local_ci")!.running).toHaveLength(1);
  expect(await p.exited).toBe(0);
  // cast ended only after the command did.
  expect(fs.existsSync(ended)).toBe(true);
  expect(listMachineSlots().find((s) => s.name === "local_ci")!.running).toEqual([]);
  fs.rmSync(dir, { recursive: true, force: true });
}, 90_000);

test("a command that ignores the signal is killed after the grace, and the place freed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slot-grace-"));
  const ready = path.join(dir, "ready");
  const p = slotRun("--name", "local_ci", "--", "sh", "-c", `trap '' TERM; echo 1 > ${ready}; while :; do sleep 0.1; done`);
  await pollUntil(() => fs.existsSync(ready), "the command to start", { ms: 40_000 });
  const at = Date.now();
  p.kill("SIGTERM");
  expect(await p.exited).toBe(128 + 9);
  expect(Date.now() - at).toBeGreaterThanOrEqual(CHILD_GRACE_MS - 500);
  expect(listMachineSlots().find((s) => s.name === "local_ci")!.running).toEqual([]);
  fs.rmSync(dir, { recursive: true, force: true });
}, 90_000);

test("ls shows each slot's load against its cap, its holders and its waiters", () => {
  const text = renderSlots([{ name: "local_ci", cap: 2, running: [{ pid: 4, at: 0, what: "Local CI of ct-7" }], waiting: [{ pid: 5, at: 60_000, what: "bun scripts/ci/local.ts" }] }], 3 * 60_000);
  expect(text).toContain("local_ci  1/2 running, 1 waiting");
  expect(text).toContain("3m  pid 4  Local CI of ct-7");
  expect(text).toContain("waiting 2m: pid 5  bun scripts/ci/local.ts");
});
