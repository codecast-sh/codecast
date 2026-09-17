import { afterEach, describe, expect, test as bunTest } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FakeExtension, testBridgeHost } from "./bridge/host.testutil.js";
import { BROWSER_SNIPPET, renderSectionBody, snippetBySlug } from "@codecast/shared/contracts";

const dirs: string[] = [];
const test = (name: string, fn: () => void | Promise<unknown>) => bunTest(name, fn, 30_000);

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function run(driver: "engine" | "builtin", args: string[], codecastDir?: string, sticky?: "clone" | "real", actualPin = false) {
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
      engineVersion: () => "test",
      findEngine: () => "test-engine",
      runEngine: () => { console.log("ENGINE_CALL"); return { status: 0, stdout: "", stderr: "" }; },
    }));
    const pinned = await import(${modulePath("pinnedTab.ts")});
    mock.module(${modulePath("pinnedTab.ts")}, () => ({
      ...pinned,
      ensurePinnedTab: ${actualPin ? "pinned.ensurePinnedTab" : 'async () => { console.log("PIN_TAB"); }'},
    }));
    const pageEval = await import(${modulePath("pageEval.ts")});
    mock.module(${modulePath("pageEval.ts")}, () => ({
      ...pageEval,
      evalInPage: async (_script, ctx) => ({ ok: true, output: ctx.cdp && ctx.session.endsWith("-real") ? "EVAL_REAL" : "EVAL_CLONE" }),
    }));
    const reap = await import(${modulePath("engineReap.ts")});
    mock.module(${modulePath("engineReap.ts")}, () => ({
      ...reap,
      closeSessionTab: async () => { console.log("CLOSE_TAB"); },
      reapEngineOrphans: async () => { console.log("REAP_CLONE"); return { closed: [], killed: 0, tmpDirsRemoved: 0 }; },
    }));
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
  fs.writeFileSync(stdout, "");
  fs.writeFileSync(stderr, "");
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: import.meta.dir,
    env: { ...process.env, CODECAST_DIR: dir, AGENT_BROWSER_SOCKET_DIR: path.join(dir, "engine"), CODECAST_SESSION_ID: "", CLAUDE_SESSION_ID: "", CAST_BROWSER_LEGACY: "1", NO_COLOR: "1" },
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
        expect(result.text).toContain("unavailable in ordinary commands");
        expect(result.text).not.toContain("CLONE_LAUNCH");
      });
    }

    test("advanced clone start remains available for one invocation", async () => {
      const result = await run(driver, ["advanced", "clone", "start"]);
      expect(result.code, result.text).toBe(0);
      expect(result.text).toContain("CLONE_LAUNCH");
    });

    test("old sticky clone choices cannot launch a browser", async () => {
      const result = await run(driver, ["start"], undefined, "clone");
      expect(result.code, result.text).toBe(1);
      expect(result.text).toContain("extension setup");
      expect(result.text).not.toContain("CLONE_LAUNCH");
    });

    test("advanced clone use does not change the next ordinary invocation", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-browser-advanced-"));
      dirs.push(dir);
      expect((await run(driver, ["advanced", "clone", "start"], dir)).code).toBe(0);
      const next = await run(driver, ["start"], dir);
      expect(next.code, next.text).toBe(1);
      expect(next.text).toContain("extension setup");
      expect(next.text).not.toContain("CLONE_LAUNCH");
    });

    for (const args of [["start", "--clone"], ["open", "--clone", "https://example.com"], ["eval", "--clone", "1"], ["do", "--clone", "open https://example.com"], ["target", "clone"]]) {
      test(`${args.join(" ")} rejects the retired shortcut before browser work`, async () => {
        const result = await run(driver, args);
        expect(result.code, result.text).toBe(1);
        expect(result.text).not.toContain("CLONE_LAUNCH");
        expect(result.text).not.toContain("PIN_TAB");
      });
    }

    test("ordinary help does not advertise separate browser controls", async () => {
      for (const args of [["--help"], ["start", "--help"]]) {
        const result = await run(driver, args);
        expect(result.code, result.text).toBe(0);
        expect(result.text).not.toMatch(/--clone|--headless|--fresh|--resync|--remote|advanced|target clone/);
      }
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

test("ordinary stop closes its real tab and reaps abandoned ones without launching a clone", async () => {
  const host = await testBridgeHost();
  const extension = await new FakeExtension([]).connect(host.port);
  try {
    const result = await run("engine", ["stop"], process.env.CODECAST_DIR);
    expect(result.code, result.text).toBe(0);
    expect(result.text).toContain("CLOSE_TAB");
    expect(result.text).toContain("REAP_CLONE");
    expect(result.text).not.toContain("CLONE_LAUNCH");
  } finally {
    extension.ws.close();
    await host.close();
  }
});

for (const args of [["status"], ["tabs"], ["tabs", "--all"], ["eval", "1 + 1"], ["do", "eval 1 + 1"]]) {
  test(`${args.join(" ")} with no page never creates a placeholder or starts the engine`, async () => {
    const host = await testBridgeHost();
    const extension = await new FakeExtension([]).connect(host.port);
    try {
      const result = await run("engine", args, process.env.CODECAST_DIR, undefined, true);
      expect(result.code, result.text).toBe(args[0] === "eval" || args[0] === "do" ? 1 : 0);
      expect(result.text).not.toContain("ENGINE_CALL");
      expect(extension.seen.filter((m) => m.op === "tabs.create" || m.op === "attach")).toHaveLength(0);
    } finally {
      extension.ws.close();
      await host.close();
    }
  });
}

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
  expect(BROWSER_SNIPPET).not.toContain("help start");
  expect(BROWSER_SNIPPET).toContain("another agent");
  expect(BROWSER_SNIPPET).toContain("Connection checks and tab lists create nothing");
  expect(BROWSER_SNIPPET).toContain("unless the human still needs them");
  expect(BROWSER_SNIPPET).toContain("Close tabs you opened");
  expect(BROWSER_SNIPPET).toContain("abandoned Cast tab already on that URL");
  expect(BROWSER_SNIPPET).toContain("cast read");
  const stub = renderSectionBody(snippetBySlug("browser")!, "stub", "1.0.0");
  expect(stub).toContain("unless the human still needs them");
});
