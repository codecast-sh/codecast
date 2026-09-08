/**
 * The dump is only worth reading if it is the CLI. So the parity checks run
 * against the real binary: `cast agent-context --json` is spawned once, with an
 * empty HOME, and everything below is asserted about what it printed.
 *
 * Three claims, each one a way the surface and its description drift apart. A
 * command registered without a description reaches an agent as a blank line, so
 * every path must carry a summary. A destructive-table entry that names no
 * command guards nothing, so every marked path must exist and be marked in the
 * dump. And a lazy group that failed to activate would serialize as its
 * placeholder — a real name with no subcommands — which is the one failure this
 * verb can produce that still looks like success, so each group's children are
 * compared against the group module's own registration. ct-49547.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { COMMAND_GROUPS, activateGroup, registerGroupStubs, type GroupDeps } from "./commandGroups.js";
import { DESTRUCTIVE_COMMANDS } from "./destructiveCommands.js";
import { buildAgentContext, formatAgentContextSummary, type AgentContext } from "./agentContext.js";

// `cast browser` registers one of two verb sets depending on whether the
// agent-browser engine is installed on the machine (useEngine in browser/cli.ts),
// so a subcommand comparison is only meaningful with that choice pinned. Its own
// escape hatch pins it, on both sides of the comparison, and which of the two
// surfaces they agree on does not matter here — the drift between them is
// browser/surface.test.ts's job.
const PINNED_ENV = { CAST_BROWSER_LEGACY: "1" };
Object.assign(process.env, PINNED_ENV);

const deps: GroupDeps = {
  getCliEndpoint: () => ({ siteUrl: "https://example.invalid", apiToken: "t" }),
  detectCurrentSessionId: () => null,
  resolveProjectId: async () => "p",
};

/** The dump the shipped CLI produces, with nothing of this machine in it: an
 *  empty HOME and its own CODECAST_DIR, so no config, credential or daemon of
 *  the developer running the test can reach the run. */
function liveContext(): AgentContext {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-agent-context-"));
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
  try {
    const result = spawnSync(process.execPath, [path.join(import.meta.dir, "main.ts"), "agent-context", "--json"], {
      env: {
        ...process.env,
        ...PINNED_ENV,
        HOME: home,
        CODECAST_DIR: path.join(home, ".codecast"),
        NO_COLOR: "1",
        CODECAST_NO_AUTO_UPDATE: "1",
      },
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      // Generous, because this run loads every command group and a busy machine
      // transpiles the whole CLI first. It bounds a hang, not the normal run.
      timeout: 300_000,
    });
    if (result.status !== 0) {
      throw new Error(`cast agent-context --json exited ${result.status}: ${result.stderr || result.stdout}`);
    }
    if (result.stderr) throw new Error(`cast agent-context --json wrote to stderr: ${result.stderr}`);
    return JSON.parse(result.stdout) as AgentContext;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const context = liveContext();
const byPath = new Map(context.commands.map((cmd) => [cmd.command, cmd]));

describe("the live command surface", () => {
  test("every registered command carries a summary", () => {
    const blank = context.commands.filter((cmd) => !cmd.summary.trim()).map((cmd) => cmd.command);
    expect(blank).toEqual([]);
  });

  test("every destructive table entry names a command, and the dump marks it", () => {
    const marked = new Set(context.commands.filter((cmd) => cmd.destructive).map((cmd) => cmd.command));
    const declared = DESTRUCTIVE_COMMANDS.map((cmd) => cmd.path.join(" "));
    expect(declared.filter((full) => !byPath.has(full)), "destructive paths that are not commands").toEqual([]);
    expect([...marked].sort()).toEqual([...declared].sort());
  });

  test("every lazy group is in the dump with the subcommands its module registers", async () => {
    for (const group of COMMAND_GROUPS) {
      const dumped = byPath.get(group.token);
      expect(dumped, `cast ${group.token} is missing from the dump`).toBeDefined();
      expect(dumped!.aliases).toEqual([...(group.aliases ?? [])]);
      expect(dumped!.summary).toBe(group.description);
      expect(dumped!.hidden).toBe(group.hidden === true);

      // The group as its own module registers it — the answer the dump must
      // match. A placeholder would have no children at all.
      const program = new Command().name("cast").description("parity");
      registerGroupStubs(program);
      await activateGroup(program, group.token, deps);
      const real = program.commands.find((cmd) => cmd.name() === group.token)!;
      const children = real.commands.map((child) => `${group.token} ${child.name()}`).sort();
      expect(dumped!.subcommands, `subcommands of cast ${group.token}`).toEqual(children);
    }
  }, 120_000);

  test("a group's flags are the real ones, never the placeholder's stand-in", () => {
    const placeholders = context.commands
      .filter((cmd) => cmd.flags.some((flag) => flag.long === "--placeholder"))
      .map((cmd) => cmd.command);
    expect(placeholders).toEqual([]);
  });

  test("the dump describes the verb that produced it", () => {
    const self = byPath.get("agent-context");
    expect(self?.flags.map((flag) => flag.long)).toContain("--json");
    expect(self?.destructive).toBe(false);
  });

  test("commands carry their globals, their own flags and their arguments", () => {
    const send = byPath.get("send");
    expect(send?.usage).toStartWith("cast send ");
    expect(send?.args.length, "cast send takes positional arguments").toBeGreaterThan(0);
    expect(send?.flags.filter((flag) => flag.global).map((flag) => flag.long).sort()).toEqual(["--help", "--version"]);
  });

  test("the envelope counts what it carries, and the order is stable", () => {
    expect(context.schemaVersion).toBe(1);
    expect(context.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(context.commandCount).toBe(context.commands.length);
    expect(context.commands.map((cmd) => cmd.command)).toEqual(
      [...context.commands.map((cmd) => cmd.command)].sort((a, b) => a.localeCompare(b)),
    );
  });
});

describe("buildAgentContext", () => {
  function fixture(): Command {
    const program = new Command().name("cast").version("9.9.9");
    const task = program.command("task").description("Work items");
    task
      .command("ls")
      .alias("list")
      .description("List work items")
      .option("-n, --limit <n>", "Max results", "50")
      .option("--json", "Output as JSON")
      .argument("[query]", "Filter text");
    task.command("drop", { hidden: true }).description("Drop a task").argument("<ids...>", "Task ids");
    return program;
  }

  test("flattens the tree, sorted, with a path and a runnable usage line", () => {
    const built = buildAgentContext(fixture(), "9.9.9");
    expect(built.commands.map((cmd) => cmd.command)).toEqual(["task", "task drop", "task ls"]);
    expect(built.commandCount).toBe(3);
    const ls = built.commands.find((cmd) => cmd.command === "task ls")!;
    expect(ls.path).toEqual(["task", "ls"]);
    expect(ls.aliases).toEqual(["list"]);
    expect(ls.usage).toBe("cast task ls [options] [query]");
    expect(built.commands.find((cmd) => cmd.command === "task")!.subcommands).toEqual(["task drop", "task ls"]);
  });

  test("flags carry their type, their default and the globals", () => {
    const ls = buildAgentContext(fixture(), "9.9.9").commands.find((cmd) => cmd.command === "task ls")!;
    expect(ls.flags.find((flag) => flag.long === "--limit")).toEqual({
      flags: "-n, --limit <n>",
      description: "Max results",
      type: "value",
      long: "--limit",
      short: "-n",
      default: "50",
    });
    expect(ls.flags.find((flag) => flag.long === "--json")?.type).toBe("boolean");
    expect(ls.flags.filter((flag) => flag.global).map((flag) => flag.long)).toEqual(["--version", "--help"]);
  });

  test("positional arguments keep whether they are required and variadic", () => {
    const drop = buildAgentContext(fixture(), "9.9.9").commands.find((cmd) => cmd.command === "task drop")!;
    expect(drop.args).toEqual([{ name: "ids", required: true, variadic: true, description: "Task ids" }]);
    expect(drop.hidden).toBe(true);
  });

  test("the human summary reports the size and names the flag that prints it", () => {
    const summary = formatAgentContextSummary(buildAgentContext(fixture(), "9.9.9"));
    expect(summary).toContain("3 commands");
    expect(summary).toContain("cast agent-context --json");
  });
});

describe("the dump survives a pipe", () => {
  // Regression for ct-49907. stdout to a pipe is asynchronous, and the runtime
  // exits once the event loop drains, so a ~580KB payload printed with
  // console.log lost whatever the pipe had not accepted — the same run
  // redirected to a FILE was complete, which is why it hid for so long. Every
  // programmatic reader of this command gets a pipe, so a truncated document
  // was the normal case for the audience the command exists for.
  //
  // The assertion is deliberately the parse, not a byte count: a length pin
  // would drift with every command added, while "a consumer can read it" is
  // the property that was broken.
  test("a piped run returns one complete JSON document", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-agent-context-pipe-"));
    fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
    try {
      // `sh -c … | cat` rather than a direct spawn: a captured stdout is a pipe
      // either way, but going through a second process is the shape a caller
      // actually uses and the one that truncated.
      const entry = path.join(import.meta.dir, "main.ts");
      const result = spawnSync("/bin/sh", ["-c", `"${process.execPath}" "${entry}" agent-context --json | cat`], {
        env: { ...process.env, ...PINNED_ENV, HOME: home, CODECAST_DIR: path.join(home, ".codecast"), NO_COLOR: "1", CODECAST_NO_AUTO_UPDATE: "1" },
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 300_000,
      });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout) as AgentContext;
      // The tail of the document, so a truncation cannot pass by parsing a
      // prefix that happens to close.
      expect(parsed.commands.length).toBeGreaterThan(0);
      expect(result.stdout.trimEnd().endsWith("}")).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});
