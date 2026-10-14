import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { mirrorProcessInvocation, mirrorProcessSnapshot, sameMirrorProcess, startMirrorProcess, type MirrorProcessIdentity } from "./process";

const modulePath = path.join(import.meta.dir, "process.ts");
const fixtures: Array<{ root: string; controllers: ReturnType<typeof startMirrorProcess>[]; children: ChildProcess[]; identities: MirrorProcessIdentity[]; extraGroups: number[] }> = [];
const cleanupReceipts: unknown[] = [];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = () => {
  const f = { root: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mirror-process-"))), controllers: [] as ReturnType<typeof startMirrorProcess>[], children: [] as ChildProcess[], identities: [] as MirrorProcessIdentity[], extraGroups: [] as number[] };
  fixtures.push(f);
  return f;
};
const waitFor = async (fn: () => boolean | Promise<boolean>, timeout = 10_000) => {
  const end = performance.now() + timeout;
  while (!await fn()) { if (performance.now() >= end) throw new Error("fixture condition timed out"); await pause(20); }
};
const capture = async (f: ReturnType<typeof fixture>) => { f.identities = await mirrorProcessSnapshot(1_000); };
function start(f: ReturnType<typeof fixture>, program: string, opts: Partial<Parameters<typeof startMirrorProcess>[0]> = {}) {
  const log: string[] = [];
  const controller = startMirrorProcess({ shouldRun: () => true, log: (s) => log.push(s), delayMs: 0, invocation: { command: process.execPath, args: [program] }, ...opts,
    spawnChild: (command, args, options) => { const child = spawn(command, args, options); f.children.push(child); return child; },
  });
  f.controllers.push(controller);
  return { controller, log };
}
const assertGone = (pid: number) => {
  let code: string | undefined;
  try { process.kill(pid, 0); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
  expect(code).toBe("ESRCH");
};

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await Promise.all(f.controllers.map((controller) => controller.stop().catch(() => {})));
    for (const pid of [...f.children.map((child) => child.pid!), ...f.extraGroups]) {
      const child = f.children.find((child) => child.pid === pid);
      const rows = await mirrorProcessSnapshot(1_000);
      const group = rows.filter((row) => row.pgid === pid);
      if (!group.length) continue;
      const leader = group.find((row) => row.pid === pid && row.ppid === process.pid);
      const owned = leader && child?.exitCode === null && child?.signalCode === null || group.every((row) => f.identities.some((known) => sameMirrorProcess(row, known)));
      if (!owned) throw new Error(`fixture cleanup unknown; retained ${f.root}`);
      try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await waitFor(async () => {
      const rows = await mirrorProcessSnapshot(1_000);
      return [...f.children.map((child) => child.pid!), ...f.extraGroups].every((pid) => !rows.some((row) => row.pgid === pid));
    });
    fs.rmSync(f.root, { recursive: true, force: true });
    const groups = [...f.children.map((child) => child.pid!).filter(Boolean), ...f.extraGroups];
    cleanupReceipts.push({ root: f.root, groups, identities: f.identities.filter((row) => groups.includes(row.pgid)), groupsAbsent: true, rootRemoved: !fs.existsSync(f.root) });
    if (process.env.MIRROR_TEST_RECEIPT) fs.writeFileSync(process.env.MIRROR_TEST_RECEIPT, JSON.stringify(cleanupReceipts, null, 2), { mode: 0o600 });
  }
});

test("stop cancels delayed startup and joins real child close and TERM-resistant descendants", async () => {
  const f = fixture();
  const marker = path.join(f.root, "pids");
  const program = path.join(f.root, "main.js");
  fs.writeFileSync(program, `const fs=require('node:fs'); const child=require('node:child_process').spawn('/bin/sh',['-c',"trap '' TERM; exec sleep 60"],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid])); process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),50)); setInterval(()=>{},1000);`);
  const delayed = start(f, program, { delayMs: 50 }).controller;
  await delayed.stop();
  await pause(80);
  expect(fs.existsSync(marker)).toBe(false);
  const { controller } = start(f, program);
  await waitFor(() => fs.existsSync(marker));
  await controller.settled();
  await capture(f);
  const [pid, descendant] = JSON.parse(fs.readFileSync(marker, "utf8"));
  const stopping = controller.stop();
  expect(controller.stop()).toBe(stopping);
  await stopping;
  assertGone(pid); assertGone(descendant); assertGone(-pid);
});

test("one monotonic deadline covers a withheld close event and repeated stop", async () => {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid: undefined, exitCode: null, signalCode: null });
  const controller = startMirrorProcess({ shouldRun: () => true, log: () => {}, delayMs: 0, stopTimeoutMs: 80, snapshot: async () => [], spawnChild: () => child });
  await pause(10);
  const begin = performance.now();
  const stopping = controller.stop();
  const failed = expect(stopping).rejects.toThrow(/timed out/);
  await pause(40);
  expect(controller.stop()).toBe(stopping);
  await failed;
  expect(performance.now() - begin).toBeLessThan(250);
  child.emit("close", 0, null);
});

for (const failure of ["identity", "probe"] as const) test(`${failure} failure refuses group signals and reports cleanup unconfirmed`, async () => {
  const f = fixture();
  const marker = path.join(f.root, "pid");
  const program = path.join(f.root, "main.js");
  fs.writeFileSync(program, `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)); setInterval(()=>{},1000);`);
  let fail = false;
  const { controller } = start(f, program, { snapshot: async (timeout) => {
    if (fail && failure === "probe") throw new Error("identity probe unavailable");
    const rows = await mirrorProcessSnapshot(timeout);
    return fail ? rows.map((row) => ({ ...row, started: "replaced identity" })) : rows;
  } });
  await waitFor(() => fs.existsSync(marker));
  await controller.settled();
  await capture(f);
  fail = true;
  await expect(controller.stop()).rejects.toThrow(failure === "probe" ? /probe unavailable/ : /identity unknown or replaced/);
  expect(process.kill(Number(fs.readFileSync(marker, "utf8")), 0)).toBe(true);
});

test("late enable and child crash retry without overlap or restart after stop", async () => {
  const f = fixture();
  const marker = path.join(f.root, "runs");
  const program = path.join(f.root, "main.js");
  fs.writeFileSync(program, `require('node:fs').appendFileSync(${JSON.stringify(marker)},String(process.pid)+'\\n'); setTimeout(()=>process.exit(1),30);`);
  let enabled = false;
  const { controller, log } = start(f, program, { shouldRun: () => enabled, retryMs: 30 });
  await pause(70);
  expect(fs.existsSync(marker)).toBe(false);
  enabled = true;
  await waitFor(() => fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim().split("\n").length >= 2).catch((error) => { throw new Error(`${error.message}: ${log.join("; ")}`); });
  await capture(f);
  await controller.stop();
  const saved = fs.readFileSync(marker, "utf8");
  await pause(100);
  expect(fs.readFileSync(marker, "utf8")).toBe(saved);
  for (const pid of saved.trim().split("\n").map(Number)) assertGone(pid);
});

test("actual supervisor death closes the lifetime pipe and retires sender with descendants", async () => {
  const f = fixture();
  const marker = path.join(f.root, "pids");
  const sender = path.join(f.root, "sender.ts");
  fs.writeFileSync(sender, `import {watchMirrorParent} from ${JSON.stringify(modulePath)}; import {spawn} from 'node:child_process'; import fs from 'node:fs'; const child=spawn('/bin/sh',['-c',"trap '' TERM; exec sleep 60"],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid])); watchMirrorParent(()=>new Promise(()=>{}),(s)=>fs.writeFileSync(${JSON.stringify(marker + ".lost")},s),100); setInterval(()=>{},1000);`);
  const supervisor = path.join(f.root, "supervisor.ts");
  fs.writeFileSync(supervisor, `import {startMirrorProcess} from ${JSON.stringify(modulePath)}; startMirrorProcess({shouldRun:()=>true,log:console.error,delayMs:0,invocation:{command:process.execPath,args:[${JSON.stringify(sender)}]}}); setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [supervisor], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  f.children.push(child);
  let stderr = "";
  child.stderr!.on("data", (s) => { stderr += s; });
  await waitFor(() => fs.existsSync(marker));
  const [senderPid, descendantPid] = JSON.parse(fs.readFileSync(marker, "utf8"));
  f.extraGroups.push(senderPid);
  await capture(f);
  child.kill("SIGKILL");
  await waitFor(async () => !(await mirrorProcessSnapshot(1_000)).some((row) => row.pgid === senderPid));
  assertGone(senderPid); assertGone(descendantPid); assertGone(-senderPid);
  expect(fs.readFileSync(marker + ".lost", "utf8"), stderr).toContain("supervisor pipe closed");
});

test("actual runner retains parent-death cleanup after TERM while its tick is still held", async () => {
  const f = fixture();
  const marker = path.join(f.root, "pids");
  const fixtureHome = path.join(f.root, "home");
  fs.mkdirSync(path.join(fixtureHome, ".codecast"), { recursive: true });
  fs.writeFileSync(path.join(fixtureHome, ".codecast/config.json"), JSON.stringify({ user_id: "fixture" }));
  const sender = path.join(f.root, "sender.ts");
  const runner = path.join(import.meta.dir, "runner.ts");
  fs.writeFileSync(sender, `import {runStandaloneMirror} from ${JSON.stringify(runner)}; import {spawn} from 'node:child_process'; import fs from 'node:fs'; void runStandaloneMirror({listHosts:async()=>{ const child=spawn('/bin/sh',['-c',"trap '' TERM; exec sleep 60"],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid])); return await new Promise(()=>{}); },log:(message)=>fs.appendFileSync(${JSON.stringify(marker + ".trace")},message+'\\n')}); process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(marker + ".term")},'held')); fs.writeFileSync(${JSON.stringify(marker + ".ready")},'ready');`);
  const supervisor = path.join(f.root, "supervisor.ts");
  fs.writeFileSync(supervisor, `import {startMirrorProcess} from ${JSON.stringify(modulePath)}; startMirrorProcess({shouldRun:()=>true,log:console.error,delayMs:0,invocation:{command:process.execPath,args:[${JSON.stringify(sender)}]}}); setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [supervisor], { detached: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, HOME: fixtureHome, CODECAST_DIR: path.join(fixtureHome, ".codecast"), CODECAST_NO_AUTO_UPDATE: "1" } });
  f.children.push(child);
  let stderr = "";
  child.stderr!.on("data", (s) => { stderr += s; });
  await waitFor(() => fs.existsSync(marker) && fs.existsSync(marker + ".ready"));
  const [senderPid, descendantPid] = JSON.parse(fs.readFileSync(marker, "utf8"));
  f.extraGroups.push(senderPid);
  await capture(f);
  const senderIdentity = f.identities.find((row) => row.pid === senderPid)!;
  expect(senderIdentity.pgid).toBe(senderPid);
  expect((await mirrorProcessSnapshot(1_000)).some((row) => sameMirrorProcess(row, senderIdentity))).toBe(true);
  process.kill(senderPid, "SIGTERM");
  await waitFor(() => fs.existsSync(marker + ".term"));
  expect(process.kill(senderPid, 0)).toBe(true);
  child.kill("SIGKILL");
  await waitFor(async () => !(await mirrorProcessSnapshot(1_000)).some((row) => row.pgid === senderPid), 5_000);
  assertGone(senderPid); assertGone(descendantPid); assertGone(-senderPid);
  const trace = fs.readFileSync(marker + ".trace", "utf8");
  expect(trace, stderr).toContain("supervisor pipe closed");
  cleanupReceipts.push({ control: "actual runner TERM then supervisor death", senderPid, descendantPid, trace, termHandled: true, heldTickReleased: false, groupAbsentBeforeFixtureCleanup: true });
}, 15_000);

test("source, built and compiled invocations run with the repaired launchd PATH", async () => {
  const f = fixture();
  for (const extension of ["ts", "js"]) {
    const root = path.join(f.root, extension);
    fs.mkdirSync(root);
    const marker = path.join(root, "received.json");
    const main = path.join(root, `main.${extension}`);
    fs.writeFileSync(main, `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),path:process.env.PATH,noUpdate:process.env.CODECAST_NO_AUTO_UPDATE})); setInterval(()=>{},1000);`);
    const invocation = mirrorProcessInvocation(process.execPath, path.join(root, `daemon.${extension}`));
    const prior = process.env.PATH;
    process.env.PATH = "/bin";
    const { controller } = start(f, main, { invocation });
    try {
      await waitFor(() => fs.existsSync(marker));
      const seen = JSON.parse(fs.readFileSync(marker, "utf8"));
      expect(seen.args).toEqual(["cloud", "mirror-run"]);
      expect(seen.path).toContain("/.local/bin");
      expect(seen.noUpdate).toBe("1");
      await capture(f);
      await controller.stop();
    } finally { process.env.PATH = prior; }
  }
  const marker = path.join(f.root, "compiled.json");
  const main = path.join(f.root, "main.ts");
  fs.writeFileSync(main, `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2))); setInterval(()=>{},1000);`);
  const executable = path.join(f.root, "cast-fixture");
  const built = Bun.spawn([process.execPath, "build", main, "--compile", "--outfile", executable], { stdout: "ignore", stderr: "pipe" });
  expect(await built.exited, await new Response(built.stderr).text()).toBe(0);
  const { controller } = start(f, main, { invocation: mirrorProcessInvocation(executable, "/$bunfs/root/main.js") });
  await waitFor(() => fs.existsSync(marker));
  expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual(["cloud", "mirror-run"]);
  await capture(f);
  await controller.stop();
});
