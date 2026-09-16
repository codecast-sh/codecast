/**
 * The guidance tells agents to delegate with `cast spawn --subagent`, so these
 * pin the two facts that advice rests on.
 *
 * `--subagent` takes an OPTIONAL value (the parent session), so commander reads
 * the next bare word as that value: `cast spawn --subagent "audit the auth flow"`
 * spends the prompt on the parent and then has no task left. That is why every
 * example in the snippet either puts a flag after `--subagent` or separates the
 * prompt with `--`. If the option shape ever changes, the snippet's examples
 * must change with it — that is what fails here.
 *
 * The commander command under test is BUILT FROM the real declarations in
 * index.ts, so it cannot drift from the command the snippet describes.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { FORKS_SNIPPET } from "@codecast/shared/contracts";

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

/** A commander command with the real spawn signature, parsed in isolation. */
function parseSpawn(argv: string[]): { prompts: string[]; subagent: unknown } {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  let seen: { prompts: string[]; subagent: unknown } | undefined;
  const spawn = program
    .command("spawn")
    .argument("<prompts...>")
    .action((prompts: string[], options: Record<string, unknown>) => {
      seen = { prompts, subagent: options.subagent };
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

/** Every `cast spawn …` line in the snippet's fenced examples. */
const spawnExamples = FORKS_SNIPPET.split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("cast spawn "));

describe("cast spawn --subagent: the option shape the guidance is written for", () => {
  test("--subagent still takes an optional parent, so a bare prompt after it is swallowed", () => {
    expect(spawnFlags()).toContain("--subagent [parent]");
    // The footgun itself. Rewrite the snippet's examples if this ever changes.
    expect(() => parseSpawn(["spawn", "--subagent", "audit the auth flow"])).toThrow(
      /missing required argument/,
    );
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
