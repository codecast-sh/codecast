// A lazy group has to be indistinguishable from an eager one.
//
// The whole design rests on one claim: the placeholder a group has in the tree
// renders the same root help line the real command would, so `cast --help` can
// be answered without loading anything. That claim is a promise about two
// separate files, so it gets a test rather than a comment — a group that grows
// an option or an argument and forgets the manifest fails here, loudly, instead
// of quietly changing the front page of the CLI. ct-49546.

import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { COMMAND_GROUPS, activateAllGroups, activateGroup, groupForToken, groupTokenInArgv, registerGroupStubs, type GroupDeps } from "./commandGroups.js";
import { commandTree, unknownCommandNextStep } from "./commandSuggestion.js";

const deps: GroupDeps = {
  getCliEndpoint: () => ({ siteUrl: "https://example.invalid", apiToken: "t" }),
  detectCurrentSessionId: () => null,
  resolveProjectId: async () => "p",
};

function freshProgram(): Command {
  const program = new Command().name("cast").description("test");
  registerGroupStubs(program);
  return program;
}

/** The one line the root help prints for a command: its term and description. */
function helpLine(program: Command, token: string): string {
  const cmd = program.commands.find((c) => c.name() === token);
  if (!cmd) throw new Error(`no command "${token}"`);
  const args = (cmd as unknown as { registeredArguments: Array<{ name(): string; required: boolean; variadic: boolean }> })
    .registeredArguments.map((a) => {
      const base = a.name() + (a.variadic ? "..." : "");
      return a.required ? `<${base}>` : `[${base}]`;
    });
  const alias = cmd.aliases()[0];
  const term = cmd.name() + (alias ? `|${alias}` : "") + (cmd.options.length ? " [options]" : "") + (args.length ? ` ${args.join(" ")}` : "");
  return `${term}\n${cmd.description()}`;
}

describe("the command group manifest", () => {
  test("every group has a distinct token, and its aliases collide with nothing", () => {
    const seen = new Set<string>();
    for (const group of COMMAND_GROUPS) {
      for (const name of [group.token, ...(group.aliases ?? [])]) {
        expect(seen.has(name), `"${name}" is claimed twice`).toBe(false);
        seen.add(name);
      }
    }
  });

  test("a placeholder renders the same root help line as the real command", async () => {
    for (const group of COMMAND_GROUPS) {
      const stubbed = freshProgram();
      const before = helpLine(stubbed, group.token);
      await activateGroup(stubbed, group.token, deps);
      expect(helpLine(stubbed, group.token), `cast ${group.token} in the root help`).toBe(before);
    }
  }, 60_000);

  test("activating every group leaves the root help exactly as the placeholders wrote it", async () => {
    const stubbed = freshProgram();
    const real = freshProgram();
    await activateAllGroups(real, deps);
    expect(real.helpInformation()).toBe(stubbed.helpInformation());
  }, 60_000);

  test("the real command takes the placeholder's position, so the help keeps its order", async () => {
    const program = freshProgram();
    const order = program.commands.map((c) => c.name());
    await activateGroup(program, "browser", deps);
    expect(program.commands.map((c) => c.name())).toEqual(order);
  }, 30_000);

  test("hidden groups stay hidden", () => {
    const program = freshProgram();
    for (const group of COMMAND_GROUPS.filter((g) => g.hidden)) {
      expect(program.helpInformation()).not.toContain(`\n  ${group.token} `);
    }
  });
});

describe("which group argv names", () => {
  test("a first token, a group alias, or the argument of `help`", () => {
    expect(groupTokenInArgv(["bun", "cast", "browser", "open"])).toBe("browser");
    expect(groupTokenInArgv(["bun", "cast", "ws"])).toBe("ws");
    expect(groupTokenInArgv(["bun", "cast", "help", "browser"])).toBe("browser");
  });

  test("leading flags are skipped, so this and commander pick the same word", () => {
    expect(groupTokenInArgv(["bun", "cast", "--", "publish", "x"])).toBe("publish");
    expect(groupTokenInArgv(["bun", "cast", "--help", "browser"])).toBe("browser");
  });

  test("a flag, a non-group verb, and a bare `cast` name nothing", () => {
    expect(groupForToken(groupTokenInArgv(["bun", "cast", "--help"]))).toBeUndefined();
    expect(groupForToken(groupTokenInArgv(["bun", "cast", "send", "jx7"]))).toBeUndefined();
    expect(groupForToken(groupTokenInArgv(["bun", "cast"]))).toBeUndefined();
    expect(groupForToken(groupTokenInArgv(["bun", "cast", "bogus"]))).toBeUndefined();
  });

  test("an alias resolves to the same group as its token", () => {
    expect(groupForToken("ws")).toBe(groupForToken("workspace")!);
    expect(groupForToken("br")).toBe(groupForToken("browser")!);
  });

  test("activating an unknown token is a no-op, not an error", async () => {
    const program = freshProgram();
    expect(await activateGroup(program, "bogus", deps)).toBe(false);
    expect(await activateGroup(program, undefined, deps)).toBe(false);
  });
});

describe("typo recovery inside a lazy group", () => {
  test("an unknown subcommand is answered from the group's real subcommand names", async () => {
    const program = freshProgram();
    await activateGroup(program, "workspace", deps);
    expect(unknownCommandNextStep(commandTree(program), ["workspace", "destry"])).toBe(
      "Next step: did you mean 'cast workspace destroy'?",
    );
  }, 30_000);

  // `cast computer` is the one group that installs an action handler on itself,
  // which is exactly what stops commander from firing unknownCommand — so the
  // claim "every level of the tree routes through the guarded suggester" is a
  // promise about that group's own registration, not about this hook. It calls
  // the suggester by hand (computer/cli.ts), and cli.test.ts pins the stderr it
  // prints; this pins that the tree it walks still answers. ct-49879.
  test("a group with its own action handler is still answered from the same tree", async () => {
    const program = freshProgram();
    await activateGroup(program, "computer", deps);
    expect(unknownCommandNextStep(commandTree(program), ["computer", "clik"])).toBe(
      "Next step: did you mean 'cast computer click'?",
    );
  }, 30_000);

  test("a mistyped group name is answered without activating anything", () => {
    const program = freshProgram();
    expect(unknownCommandNextStep(commandTree(program), ["browsr"])).toContain("'cast browser'");
  });
});
