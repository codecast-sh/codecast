import { afterEach, describe, expect, test as bunTest } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FakeExtension, testBridgeHost } from "./bridge/host.testutil.js";
import { BROWSER_SNIPPET, renderSectionBody, snippetBySlug } from "@codecast/shared/contracts";

const dirs: string[] = [];
const test = (name: string, fn: () => unknown | Promise<unknown>) => bunTest(name, fn, 30_000);

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function run(driver: "engine" | "builtin", args: string[], codecastDir?: string, sticky?: "clone" | "real") {
  const dir = codecastDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "cast-browser-default-"));
  if (!codecastDir) dirs.push(dir);
  const modulePath = (name: string) => JSON.stringify(path.join(import.meta.dir, name));
  const script = `
    import { mock } from "bun:test";
    import { Command } from "commander";
    const managed = await import(${modulePath("managedBrowser.ts")});
    mock.module(${modulePath("managedBrowser.ts")}, () => ({
      ...managed,
      startLocalBrowser: async () => { console.log("CLONE_LAUNCH"); },
      startManagedBrowser: async () => { console.log("CLONE_LAUNCH"); },
    }));
    const engine = await import(${modulePath("engine.ts")});
    mock.module(${modulePath("engine.ts")}, () => ({
      ...engine,
      ensureEngine: () => ({ binary: "test-engine", installed: false }),
      engineHelpText: () => "test help",
    }));
    const pinned = await import(${modulePath("pinnedTab.ts")});
    mock.module(${modulePath("pinnedTab.ts")}, () => ({
      ...pinned,
      ensurePinnedTab: async () => { console.log("PIN_TAB"); },
    }));
    const pageEval = await import(${modulePath("pageEval.ts")});
    mock.module(${modulePath("pageEval.ts")}, () => ({
      ...pageEval,
      evalInPage: async (_script, ctx) => ({ ok: true, output: ctx.cdp && ctx.session.endsWith("-real") ? "EVAL_REAL" : "EVAL_CLONE" }),
    }));
    const reap = await import(${modulePath("engineReap.ts")});
    mock.module(${modulePath("engineReap.ts")}, () => ({ ...reap, reapEngineOrphans: async () => ({ closed: [], killed: 0, tmpDirsRemoved: 0 }) }));
    const real = await import(${modulePath("bridge/real.ts")});
    if (${JSON.stringify(sticky) ?? "undefined"}) real.setStickyTarget("session:default-test", ${JSON.stringify(sticky) ?? "undefined"});
    const program = new Command();
    const deps = { detectCurrentSessionId: () => "default-test", getCliEndpoint: () => { throw new Error("unexpected API call"); } };
    if (${JSON.stringify(driver)} === "engine") {
      const { registerEngineCommands } = await import(${modulePath("cliEngine.ts")});
      registerEngineCommands(program.command("browser"), deps);
    } else {
      const { registerBrowserCommand } = await import(${modulePath("cli.ts")});
      registerBrowserCommand(program, deps);
    }
    await program.parseAsync(["bun", "cast", "browser", ...${JSON.stringify(args)}]);
  `;
  const stdout = path.join(dir, "stdout.log");
  const stderr = path.join(dir, "stderr.log");
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: import.meta.dir,
    env: { ...process.env, CODECAST_DIR: dir, CODECAST_SESSION_ID: "", CLAUDE_SESSION_ID: "", CAST_BROWSER_LEGACY: "1", NO_COLOR: "1" },
    stdout: Bun.file(stdout),
    stderr: Bun.file(stderr),
  });
  const code = await child.exited;
  return { code, text: fs.readFileSync(stdout, "utf8") + fs.readFileSync(stderr, "utf8") };
}

for (const driver of ["engine", "builtin"] as const) {
  describe(`${driver} browser routing`, () => {
    for (const args of [["start"], ["open", "https://example.com"], ["status"], ["eval", "1 + 1"]]) {
      test(`${args[0]} without pairing refuses instead of launching a clone`, async () => {
        const result = await run(driver, args);
        expect(result.code).toBe(1);
        expect(result.text).toContain("extension setup");
        expect(result.text).not.toContain("CLONE_LAUNCH");
      });
    }

    for (const args of [["--fresh"], ["--headless"], ["--resync"], ["--remote", "linux"], ["--profile", "Default"], ["--size", "800x600"]]) {
      test(`start ${args[0]} cannot implicitly select the clone`, async () => {
        const result = await run(driver, ["start", ...args]);
        expect(result.code).toBe(1);
        expect(result.text).toContain("explicitly selected agent browser");
        expect(result.text).not.toContain("CLONE_LAUNCH");
      });
    }

    test("start --clone remains available explicitly", async () => {
      const result = await run(driver, ["start", "--clone"]);
      expect(result.code, result.text).toBe(0);
      expect(result.text).toContain("CLONE_LAUNCH");
    });

    test("an explicit session choice remains available", async () => {
      const result = await run(driver, ["start"], undefined, "clone");
      expect(result.code, result.text).toBe(0);
      expect(result.text).toContain("CLONE_LAUNCH");
    });

    test("start connects through a real bridge without launching Chrome or creating a tab", async () => {
      const host = await testBridgeHost();
      const extension = await new FakeExtension([]).connect(host.port);
      try {
        const result = await run(driver, ["start"], process.env.CODECAST_DIR);
        expect(result.code, result.text).toBe(0);
        expect(result.text).toContain("connected to the human's Chrome");
        expect(result.text).not.toContain("CLONE_LAUNCH");
        expect(result.text).not.toContain("PIN_TAB");
        expect(extension.seen.filter((m) => m.op === "tabs.create")).toHaveLength(0);
      } finally {
        extension.ws.close();
        await host.close();
      }
    });
  });
}

test("eval through the real bridge never starts the separate browser", async () => {
  const host = await testBridgeHost();
  const extension = await new FakeExtension([]).connect(host.port);
  try {
    const result = await run("engine", ["eval", "1 + 1"], process.env.CODECAST_DIR);
    expect(result.code, result.text).toBe(0);
    expect(result.text).toContain("EVAL_REAL");
    expect(result.text).not.toContain("CLONE_LAUNCH");
  } finally {
    extension.ws.close();
    await host.close();
  }
});

for (const verb of ["sync", "grant", "login"]) {
  test(`${verb} refuses the default browser before creating any tab or clone`, async () => {
    const result = await run("engine", [verb]);
    expect(result.code).toBe(1);
    expect(result.text).toContain("human's Chrome");
    expect(result.text).not.toContain("CLONE_LAUNCH");
    expect(result.text).not.toContain("PIN_TAB");
  });
}

test("reading command help needs no browser connection", async () => {
  for (const verb of ["eval", "open", "snapshot", "start"]) {
    const result = await run("engine", [verb, "--help"]);
    expect(result.code, result.text).toBe(0);
    expect(result.text).not.toContain("CLONE_LAUNCH");
    expect(result.text).not.toContain("PIN_TAB");
  }
});

test("full and short agent instructions make separate Chrome a last resort", () => {
  for (const mode of ["full", "stub"] as const) {
    const text = renderSectionBody(snippetBySlug("browser")!, mode, "1.0.0");
    expect(text).toContain("last resort");
    expect(text).toContain("explicit permission");
    expect(text).toContain("extension");
    expect(text).not.toContain("your own Chrome is never touched");
    expect(text).not.toContain("start --fresh");
    expect(text).not.toContain("start --remote");
  }
  expect(BROWSER_SNIPPET).not.toContain("--clone");
  expect(BROWSER_SNIPPET).not.toContain("target clone");
});
