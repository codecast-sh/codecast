/**
 * The guidance tells agents to delegate with `cast spawn --subagent`, so these
 * pin the two facts that advice rests on.
 *
 * `--subagent` takes an OPTIONAL value (the parent session), so commander reads
 * the next bare word as that value: `cast spawn --subagent "audit the auth flow"`
 * spends the prompt on the parent. The action hands a value that cannot be a
 * session id back to the prompts (spawnArgs.ts), and every example in the
 * snippet still puts a flag after `--subagent` or separates the prompt with
 * `--`, so the examples hold with or without that recovery.
 *
 * The commander command under test is BUILT FROM the real declarations in
 * index.ts, so it cannot drift from the command the snippet describes.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { guideText, snippetBySlug } from "@codecast/shared/contracts";
import { recoverSwallowedPrompt } from "./spawnArgs.js";

const indexSrc = fs.readFileSync(path.join(import.meta.dir, "index.ts"), "utf8");

/** The `program.command("spawn")` block, up to its action handler. */
function spawnBlock(): string {
  const start = indexSrc.indexOf('.command("spawn")');
  expect(start).toBeGreaterThan(-1);
  const end = indexSrc.indexOf(".action(", start);
  expect(end).toBeGreaterThan(start);
  return indexSrc.slice(start, end);
}

/** Every flag string the real spawn command declares. */
function spawnFlags(): string[] {
  const flags = [...spawnBlock().matchAll(/\.option\(\s*"([^"]+)"/g)].map((m) => m[1]);
  expect(flags.length).toBeGreaterThan(5);
  return flags;
}

/** The prompts argument exactly as the real spawn command declares it. */
function spawnArgument(): string {
  const m = spawnBlock().match(/\.argument\(\s*"([^"]+)"/);
  expect(m).not.toBeNull();
  return m![1];
}

/** A commander command with the real spawn signature, parsed in isolation,
 *  then the action's own recovery of a swallowed prompt. */
function parseSpawn(argv: string[]): { prompts: string[]; subagent: unknown } {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  let seen: { prompts: string[]; subagent: unknown } | undefined;
  const spawn = program
    .command("spawn")
    .argument(spawnArgument())
    .action((prompts: string[], options: Record<string, unknown>) => {
      seen = recoverSwallowedPrompt(prompts, options.subagent, () => "stdin body");
    });
  for (const flag of spawnFlags()) spawn.option(flag, "");
  spawn.exitOverride();
  spawn.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  program.parse(["node", "cast", ...argv]);
  if (!seen) throw new Error(`no action ran for: ${argv.join(" ")}`);
  return seen;
}

/** A documented command line as argv (the leading `cast` dropped): comments,
 *  heredocs and quotes removed. The first token is the subcommand itself. */
function argvOf(line: string): string[] {
  const bare = line.replace(/<<'?\w+'?.*$/, "").replace(/\s+#.*$/, "").trim();
  const tokens = bare.match(/"[^"]*"|\S+/g) ?? [];
  return tokens.slice(1).map((t) => t.replace(/^"|"$/g, ""));
}

/** Every `cast spawn …` line in the guide's fenced examples: the installed body and its reference. */
const spawnExamples = guideText(snippetBySlug("forks")!).split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("cast spawn "));

describe("cast spawn --subagent: the option shape the guidance is written for", () => {
  test("--subagent takes an optional parent, and a task it swallowed is handed back", () => {
    expect(spawnFlags()).toContain("--subagent [parent]");
    expect(parseSpawn(["spawn", "--subagent", "audit the auth flow"]))
      .toEqual({ prompts: ["audit the auth flow"], subagent: true });
    expect(parseSpawn(["spawn", "--subagent", "task A", "task B"]))
      .toEqual({ prompts: ["task A", "task B"], subagent: true });
  });

  test("a '-' that --subagent swallowed still reads the heredoc", () => {
    // The preAction hook expands '-' prompts before the action; this one sat in
    // the parent slot, so the recovery expands it, never spawning a task of "-".
    expect(recoverSwallowedPrompt([], "-", () => "audit the auth flow\n"))
      .toEqual({ prompts: ["audit the auth flow"], subagent: true });
    expect(recoverSwallowedPrompt(["second task"], "-", () => "first task\n"))
      .toEqual({ prompts: ["first task", "second task"], subagent: true });
  });

  test("the documented separators keep the prompt a prompt and still nest the worker", () => {
    expect(parseSpawn(["spawn", "--subagent", "--", "audit the auth flow"]))
      .toEqual({ prompts: ["audit the auth flow"], subagent: true });
    // A flag after --subagent needs no separator: the flag ends the value.
    expect(parseSpawn(["spawn", "--subagent", "--label", "fleet", "task A", "task B"]))
      .toEqual({ prompts: ["task A", "task B"], subagent: true });
    // An explicit parent is still read as the parent, not as the task.
    expect(parseSpawn(["spawn", "--subagent", "jx7abcd", "audit the auth flow"]))
      .toEqual({ prompts: ["audit the auth flow"], subagent: "jx7abcd" });
  });
});

describe("every cast spawn example in the snippet parses as written", () => {
  test("the snippet shows both a nested worker and an independent thread", () => {
    expect(spawnExamples.length).toBeGreaterThanOrEqual(3);
    expect(spawnExamples.filter((l) => l.includes("--subagent")).length).toBeGreaterThanOrEqual(2);
    expect(spawnExamples.some((l) => !l.includes("--subagent"))).toBe(true);
  });

  test.each(spawnExamples)("%s", (line) => {
    const argv = argvOf(line);
    expect(argv[0]).toBe("spawn");
    const parsed = parseSpawn(argv);
    expect(parsed.prompts.length).toBeGreaterThan(0);
    // A worker example must nest. If --subagent had eaten the prompt, the parse
    // above would have thrown; if it ate a task id, subagent would be a string.
    if (line.includes("--subagent")) expect(parsed.subagent).toBe(true);
    else expect(parsed.subagent).toBeUndefined();
  });
});
