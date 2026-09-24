/**
 * A `new Worker` only works in the compiled binary when the build names the
 * worker file as an entrypoint and the caller asks for the built `.js` name.
 * v1.1.155 shipped without either, and every OpenCode poll failed with
 * `ModuleNotFound resolving "/$bunfs/root/opencodeStorage.worker.ts"`.
 *
 * The first test holds every worker in `src/` to WORKER_ENTRIES. The second
 * compiles the same layout in miniature, the way `fastPath.split.test.ts`
 * does, because how bun names a worker inside a binary is a fact about bun.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WORKER_ENTRIES, workerBuildArgs } from "../scripts/build-with-native.js";

let stage = "";

beforeEach(() => {
  stage = fs.mkdtempSync(path.join(os.tmpdir(), "cast-worker-"));
});

afterEach(() => {
  fs.rmSync(stage, { recursive: true, force: true });
});

test("every new Worker in src names a built entrypoint by its .js name", () => {
  const found: string[] = [];
  for (const rel of fs.readdirSync(import.meta.dir, { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(rel) || /\.test\.tsx?$/.test(rel)) continue;
    const source = fs.readFileSync(path.join(import.meta.dir, rel), "utf8");
    for (const match of source.matchAll(/new Worker\(([^;]*)/g)) {
      const spec = /new URL\("\.\/([^"]+)", import\.meta\.url\)/.exec(match[1]);
      expect(spec, `${rel}: new Worker must take new URL("./<name>.js", import.meta.url)`).not.toBeNull();
      expect(path.dirname(rel), `${rel}: a worker caller must sit in src/ beside main.ts`).toBe(".");
      expect(spec![1], `${rel}: name the worker by its built .js name`).toEndWith(".js");
      found.push(spec![1]);
    }
  }
  expect(found.length).toBeGreaterThan(0);
  expect(found.map((name) => name.replace(/\.js$/, ".ts")).sort()).toEqual([...WORKER_ENTRIES].sort());
});

test("a compiled, split binary starts a worker named the way src names it", () => {
  const src = path.join(stage, "src");
  fs.mkdirSync(src);
  // main.ts reaches the caller through a lazy import, as the daemon does, so
  // the caller runs from a chunk rather than from the entry module.
  fs.writeFileSync(path.join(src, "main.ts"), `const m = await import("./caller.ts");\nm.go();\n`);
  fs.writeFileSync(
    path.join(src, "caller.ts"),
    `export function go() {\n` +
      `  const w = new Worker(new URL("./probe.worker.js", import.meta.url).href);\n` +
      `  w.onmessage = (e) => { console.log("reply", e.data); process.exit(0); };\n` +
      `  w.addEventListener("error", (e) => { console.log("error", e.message); process.exit(1); });\n` +
      `  w.postMessage(1);\n` +
      `}\n`,
  );
  fs.writeFileSync(path.join(src, "probe.worker.ts"), `self.onmessage = (e: MessageEvent) => postMessage((e.data as number) + 1);\n`);

  const fromSource = spawnSync(process.execPath, [path.join(src, "main.ts")], { cwd: os.tmpdir(), encoding: "utf8", timeout: 30_000 });
  expect(fromSource.stdout.trim()).toBe("reply 2");

  // The entry is relative and the worker absolute, as in build-binaries.sh,
  // which moves bun's own choice of root out of src/ unless --root pins it.
  const out = path.join(stage, "bin");
  const build = spawnSync(
    process.execPath,
    ["build", "src/main.ts", ...workerBuildArgs(src, ["probe.worker.ts"]), "--compile", "--splitting", "--minify", "--outfile", out],
    { cwd: stage, encoding: "utf8", timeout: 300_000 },
  );
  expect(build.status).toBe(0);
  const run = spawnSync(out, [], { cwd: os.tmpdir(), encoding: "utf8", timeout: 30_000 });
  expect(run.stdout.trim()).toBe("reply 2");
}, 300_000);
