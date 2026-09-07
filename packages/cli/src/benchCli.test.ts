import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { blockAt } from "./test-helpers/sourceRegion.js";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const anchor = '\nprogram\n  .command("bench", { hidden: true })';
const start = source.indexOf(anchor);
if (start < 0 || source.indexOf(anchor, start + 1) >= 0) throw new Error("expected one registered bench command");
const action = blockAt(source, source.indexOf("  .action(", start));
const registration = source.split("\n").slice(source.slice(0, start + 1).split("\n").length - 1, action.endLine).join("\n");
const moduleImport = 'await import("./bench/daemonBench.js")';
if (registration.split(moduleImport).length !== 2) throw new Error("expected one bench module import");
const isolated = registration.replace(moduleImport, "await loadBenchModule()");
if (/\bimport\s*\(/.test(isolated)) throw new Error("unexpected dynamic import in bench action");
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(isolated);

for (const fixture of [
  { name: "clean report", status: "NOT ESTABLISHED", reasons: [], errors: [], load: null, exit: 0 },
  { name: "measurement FAIL with empty cleanup warnings", status: "FAIL", reasons: ["health RTT >=1000ms"], errors: [], load: { teardown: { warnings: [] } }, exit: 1 },
  { name: "cleanup FAIL", status: "FAIL", reasons: ["cleanup unverified"], errors: [], load: { teardown: { warnings: ["owned file retained"] } }, exit: 1 },
  { name: "honest NOT ESTABLISHED", status: "NOT ESTABLISHED", reasons: ["N=200 not measured"], errors: [], load: { teardown: { warnings: [] } }, exit: 0 },
]) test(`registered bench action exits ${fixture.exit} for ${fixture.name}`, async () => {
  const report = { acceptance: { status: fixture.status, reasons: fixture.reasons }, errors: fixture.errors, load: fixture.load };
  const program = new Command().exitOverride();
  const calls: { deps: unknown; options: unknown }[] = [], output: string[] = [], exits: number[] = [];
  const deps = { getDaemonPid: () => 123 };
  const exit = new Error("private CLI exit");
  let imports = 0;
  const loadBenchModule = async () => {
    imports++;
    return {
      runDaemonBench: async (actualDeps: unknown, options: unknown) => { calls.push({ deps: actualDeps, options }); return report; },
      renderMarkdown: () => { throw new Error("unexpected markdown output"); },
    };
  };
  new Function("program", "process", "console", "doctorDeps", "requireAuthedConfig", "loadBenchModule", code)(
    program, { exit: (value: number) => { exits.push(value); throw exit; } },
    { log: (value: string) => output.push(value), error: (value: string) => { throw new Error(value); } },
    () => deps, () => ({}), loadBenchModule,
  );
  await expect(program.parseAsync(["bench", "daemon", "--json"], { from: "user" })).rejects.toBe(exit);
  expect(exits).toEqual([fixture.exit]); expect(imports).toBe(1); expect(calls).toHaveLength(1);
  expect(calls[0].deps).toBe(deps);
  expect(calls[0].options).toEqual({ load: undefined, sample: 5, durationMs: 60000, churnIntervalMs: 2000, logSinceMs: 86400000, json: true, keep: false, projectDir: undefined });
  expect(output).toEqual([JSON.stringify(report, null, 2)]);
});

test("CLI test script roots the same source tree and preserves Node build splitting", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg.scripts.test).toBe("bun test ./src/");
  expect(pkg.scripts.build).toBe("bun scripts/stamp-daemon-build-id.ts && bun scripts/build-with-native.ts src/main.ts src/daemon.ts --outdir dist --target=node --splitting");
  expect(pkg.scripts["build:binary"]).toBe("bash scripts/guard-no-src-shadow.sh && bun scripts/build-with-native.ts src/main.ts --compile --outfile codecast");
  expect(pkg.scripts.dev).toBe("bun run src/main.ts");
  expect(pkg.scripts.typecheck).toBe("tsc --noEmit -p tsconfig.typecheck.json");
});
