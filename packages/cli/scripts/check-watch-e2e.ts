#!/usr/bin/env bun
/**
 * `cast check` answers about the files on disk, proven against real tsc
 * watchers in throwaway git trees (ct-62781: an Implement round looped on
 * "has no exported member" for exports present on disk).
 *
 *   bun packages/cli/scripts/check-watch-e2e.ts
 *
 * Each scenario asks through `checkProject` with watchers started as
 * `check-watch` processes, then compares the answer with a one-off tsc:
 *
 * - during-a-pass: a file changes back while tsc is checking the previous
 *   change, and the ask lands then. The pass in flight read the old file.
 * - held-replace: `git checkout` swaps a file to the base and back while
 *   another process holds the swapped-out copy open, as the line's red
 *   station does around a reproduction run. The file is reached by import
 *   from outside the program's include globs (Union's mobile app reaching
 *   ../backend), so only its own watch covers it. On Linux that watch never
 *   reports the held copy gone, and later asks (a `touch` included) still
 *   answer about the old file.
 *
 * E2E_ONLY runs one scenario by name.
 * E2E_HEAVY sizes the slow file (default 12000 functions) for a slower machine.
 * CHECK_MODULE names the check module to run (default ../src/check.ts), so an
 * older check.ts can be run for comparison. TS_DIR names the TypeScript to
 * use (default: the one this repo installs). State lives in a temp
 * CODECAST_DIR; nothing outside the temp trees is touched.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const checkModule = path.resolve(process.env.CHECK_MODULE ?? path.join(import.meta.dir, "../src/check.ts"));
const check = (await import(checkModule)) as typeof import("../src/check.ts");

if (process.argv[2] === "--watcher") {
  const [root, name, tsconfig] = process.argv.slice(3);
  await check.runWatcher(root, name, tsconfig);
  process.exit(0);
}

const tsDir = process.env.TS_DIR ?? path.dirname(Bun.resolveSync("typescript/package.json", import.meta.dir));
process.env.CODECAST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "check-e2e-home-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const watchers: ChildProcess[] = [];

/** A git tree with this repo's TypeScript installed, on branch `fix` over `main`. */
function makeTree(base: Record<string, string>, fix: Record<string, string>): { root: string; git: (...a: string[]) => void; put: (f: string, t: string) => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "check-e2e-")));
  const git = (...a: string[]) => {
    const r = spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
    if (r.status) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  };
  const put = (f: string, t: string) => {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), t);
  };
  fs.mkdirSync(path.join(root, "node_modules/.bin"), { recursive: true });
  fs.symlinkSync(tsDir, path.join(root, "node_modules/typescript"));
  fs.symlinkSync("../typescript/bin/tsc", path.join(root, "node_modules/.bin/tsc"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  put(".gitignore", "node_modules\n");
  put("app/tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ["*.ts"] }));
  for (const [f, t] of Object.entries(base)) put(f, t);
  git("add", "-A");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "fix");
  for (const [f, t] of Object.entries(fix)) put(f, t);
  git("add", "-A");
  git("commit", "-qm", "fix");
  return { root, git, put };
}

const project = { name: "app", tsconfig: "app/tsconfig.json" };
const start = (root: string) => {
  const dir = check.watchDir(root, project.name);
  fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(check.logPath(dir), "a");
  const child = spawn(process.execPath, [import.meta.path, "--watcher", root, project.name, project.tsconfig], { stdio: ["ignore", log, log], env: process.env });
  watchers.push(child);
};
const ask = async (root: string) => (await check.checkProject(project, root, { start, budgetMs: 600_000, maxWatchers: 8 })).errors;
const fresh = (root: string) => (spawnSync(process.execPath, [path.join(tsDir, "bin/tsc"), "--noEmit", "--pretty", "false", "-p", project.tsconfig], { cwd: root, encoding: "utf8" }).stdout.match(/error TS/g) ?? []).length;
const passing = (root: string) => !!check.readWatchState(check.watchDir(root, project.name))?.inProgress;

/** Many exported functions, so checking the file takes the checker a few seconds (E2E_HEAVY sets how many, for a slower machine). */
const heavy = Array.from({ length: Number(process.env.E2E_HEAVY ?? 12_000) }, (_, i) => `export function f${i}<T extends { a: number }>(v: T): T & { b${i}: string } { return { ...v, b${i}: String(v.a + ${i}) }; }`).join("\n");

const results: string[] = [];
const report = (name: string, said: number, truth: number, extra = "") => {
  results.push(`${name}: cast check said ${said}, a one-off tsc says ${truth}${extra} → ${said === truth ? "ok" : "STALE"}`);
};

async function duringAPass(): Promise<void> {
  const withY = `${heavy}\nexport const y = 2;\n`;
  const { root, put } = makeTree({ "lib/a.ts": withY, "app/b.ts": "import { y } from '../lib/a';\nexport const z = y;\n" }, { "app/c.ts": "export {};\n" });
  await ask(root);
  put("lib/a.ts", `${heavy}\n`);
  const deadline = Date.now() + 30_000;
  while (!passing(root) && Date.now() < deadline) await sleep(20);
  await sleep(300);
  put("lib/a.ts", withY);
  const said = await ask(root);
  if (process.env.E2E_DEBUG) {
    const dir = check.watchDir(root, project.name);
    console.log(check.readWatchState(dir), check.filesNotAsChecked?.(dir), fs.readFileSync(check.logPath(dir), "utf8").slice(-1500));
  }
  report("during-a-pass", said, fresh(root));
}

async function heldReplace(): Promise<void> {
  // The branch drops `old` and adds `y`, so a program mixing the two sides
  // reports a missing export whichever way it is mixed.
  const { root, git } = makeTree(
    { "lib/a.ts": "export const x = 1;\nexport const old = 0;\n", "app/b.ts": "import { x, old } from '../lib/a';\nexport const z = x + old;\n" },
    { "lib/a.ts": "export const x = 1;\nexport const y = 2;\n", "app/b.ts": "import { x, y } from '../lib/a';\nexport const z = x + y;\n" },
  );
  await ask(root);
  // Something has the branch's copy open while the tree goes to the base and back.
  const holder = spawn("sh", ["-c", "exec 3< lib/a.ts; sleep 600"], { cwd: root, stdio: "ignore" });
  await sleep(300);
  git("checkout", "-q", "--detach", "main");
  await sleep(2_000);
  const onBase = await ask(root);
  const baseTruth = fresh(root);
  git("checkout", "-q", "fix");
  await sleep(2_000);
  const said = await ask(root);
  fs.utimesSync(path.join(root, "lib/a.ts"), new Date(), new Date());
  await sleep(2_000);
  const afterTouch = await ask(root);
  holder.kill();
  report("held-replace, on the base", onBase, baseTruth);
  report("held-replace, back on the branch", said, fresh(root), `; after a touch it said ${afterTouch}`);
}

const only = process.env.E2E_ONLY;
try {
  if (!only || only === "during-a-pass") await duringAPass();
  if (!only || only === "held-replace") await heldReplace();
} finally {
  for (const w of watchers) w.kill("SIGTERM");
}
console.log(`${os.platform()} · ${path.basename(checkModule)}\n${results.map((r) => `  ${r}`).join("\n")}`);
process.exit(results.every((r) => r.endsWith("ok")) ? 0 : 1);
