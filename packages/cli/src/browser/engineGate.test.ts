import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveEngine, type EngineFitness } from "./engine.js";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";

// Which driver `cast browser` registers. A laptop with no engine used to fall
// to the built-in driver in silence, so verbs the agent docs name (handoff,
// subscribe, read) were missing from its help with nothing saying why.
describe("resolveEngine", () => {
  isolateCodecastDirEachTest();
  const missing = (): EngineFitness => ({ ok: false, reason: "missing" });
  const run = (opts: { fitness?: () => EngineFitness; install?: () => unknown; now?: number; env?: NodeJS.ProcessEnv; browserDisabled?: boolean }) => {
    const warnings: string[] = [];
    let installs = 0;
    const engine = resolveEngine({
      env: opts.env ?? {},
      fitness: opts.fitness ?? missing,
      install: () => {
        installs++;
        return opts.install?.();
      },
      warn: (l) => warnings.push(l),
      now: opts.now,
      browserDisabled: () => opts.browserDisabled ?? false,
    });
    return { engine, warnings, installs };
  };

  test("a missing engine is installed on first use, with no host check", () => {
    expect(run({})).toEqual({ engine: true, warnings: [], installs: 1 });
  });

  test("an installed engine drives without installing", () => {
    expect(run({ fitness: () => ({ ok: true, version: "0.34.0" }) })).toEqual({ engine: true, warnings: [], installs: 0 });
  });

  test("a failed install warns in one line naming the verbs and the command, and is not retried for a day", () => {
    const fail = () => {
      throw new Error("could not install the browser engine (npm: ENOTFOUND registry.npmjs.org).\n  Install it yourself with: …");
    };
    const first = run({ install: fail });
    expect(first.engine).toBe(false);
    expect(first.installs).toBe(1);
    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]).not.toContain("\n");
    for (const s of ["read", "handoff", "subscribe", "npm install -g agent-browser@", "ENOTFOUND registry.npmjs.org"]) expect(first.warnings[0]).toContain(s);

    const soon = run({ install: fail });
    expect(soon.installs).toBe(0);
    expect(soon.warnings).toHaveLength(1);
    expect(soon.warnings[0]).toContain("ENOTFOUND registry.npmjs.org");

    const tomorrow = run({ now: Date.now() + 25 * 60 * 60 * 1000 });
    expect(tomorrow).toEqual({ engine: true, warnings: [], installs: 1 });
  });

  test("CAST_BROWSER_LEGACY=1 keeps the built-in driver without installing", () => {
    expect(run({ env: { CAST_BROWSER_LEGACY: "1" } })).toEqual({ engine: false, warnings: [], installs: 0 });
  });

  test("a test process never installs, so registering `cast browser` in a test stays off the network", () => {
    expect(run({ env: { NODE_ENV: "test" } })).toEqual({ engine: false, warnings: [], installs: 0 });
  });

  test("a machine whose policy turns browser control off never installs, and says nothing", () => {
    expect(run({ browserDisabled: true })).toEqual({ engine: false, warnings: [], installs: 0 });
  });

  test("an engine below the floor is not driven, and says how to upgrade", () => {
    const r = run({ fitness: () => ({ ok: false, reason: "too-old", version: "0.20.0" }) });
    expect(r.engine).toBe(false);
    expect(r.installs).toBe(0);
    expect(r.warnings[0]).toContain("0.20.0");
  });
});

/** A machine with no engine and an npm that counts its runs, takes a moment,
 *  then lays a stand-in engine binary in the prefix it was given. */
function laptopWithoutEngine(dir: string): { env: Record<string, string>; npmRuns: () => number } {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const runs = path.join(dir, "npm-runs");
  fs.writeFileSync(
    path.join(bin, "npm"),
    `#!/bin/bash\necho x >> "${runs}"\nwhile [ "$1" != "--prefix" ]; do shift; done\nsleep 1\nmkdir -p "$2/node_modules/.bin"\nprintf '#!/bin/bash\\necho 0.34.0\\n' > "$2/node_modules/.bin/agent-browser"\nchmod +x "$2/node_modules/.bin/agent-browser"\n`,
    { mode: 0o755 },
  );
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: `${bin}:/usr/bin:/bin`, CODECAST_DIR: path.join(dir, "state"), NO_COLOR: "1" };
  for (const k of ["CAST_BROWSER_ENGINE", "CAST_BROWSER_LEGACY", "NODE_ENV"]) delete env[k];
  return { env, npmRuns: () => (fs.existsSync(runs) ? fs.readFileSync(runs, "utf-8").trim().split("\n").length : 0) };
}

// The path the bug lived on: `cast browser` registering on a laptop (no cloud
// host) with no engine present fell to the built-in driver, without handoff.
describe("registerBrowserCommand", () => {
  test("a laptop with no engine installs it and registers the engine's verbs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-engine-register-"));
    try {
      const { env, npmRuns } = laptopWithoutEngine(dir);
      const script = `
        const { Command } = await import("commander");
        const { registerBrowserCommand } = await import(${JSON.stringify(path.join(import.meta.dir, "cli.ts"))});
        const program = new Command();
        registerBrowserCommand(program, { detectCurrentSessionId: () => null, getCliEndpoint: () => { throw new Error("unexpected API call"); } });
        const br = program.commands.find((c) => c.name() === "browser");
        console.log(JSON.stringify(br.commands.map((c) => c.name())));
      `;
      const p = Bun.spawn([process.execPath, "-e", script], { cwd: import.meta.dir, env, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = [await p.exited, await new Response(p.stdout).text(), await new Response(p.stderr).text()];
      expect(code, err).toBe(0);
      const verbs = JSON.parse(out.trim().split("\n").pop()!) as string[];
      expect(verbs).toEqual(expect.arrayContaining(["handoff", "subscribe", "read"]));
      expect(npmRuns()).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

// Parallel agents' first calls land together; two npm runs into one prefix race.
describe("ensureEngine", () => {
  test("concurrent first calls run npm once and all find the copy", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-engine-race-"));
    try {
      const { env, npmRuns } = laptopWithoutEngine(dir);
      const script = `const { ensureEngine } = await import(${JSON.stringify(path.join(import.meta.dir, "engine.ts"))}); console.log(JSON.stringify(ensureEngine({ quiet: true })));`;
      const procs = [0, 1, 2].map(() => Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" }));
      const outs = await Promise.all(procs.map(async (p) => ({ code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() })));
      for (const o of outs) expect(o.code, o.err).toBe(0);
      const results = outs.map((o) => JSON.parse(o.out.trim()) as { binary: string; installed: boolean });
      expect(npmRuns()).toBe(1);
      expect(results.filter((r) => r.installed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.binary)).size).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
