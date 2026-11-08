import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { addVerbHelp } from "./verbHelp";
import { DECIDE_VERB_HELP, registerDecideCommand } from "./decideCommand";
import { PUBLISH_VERB_HELP, registerPublishCommand } from "./publish";

function helpFor(argv: string[]): string {
  let out = "";
  const program = new Command("cast").exitOverride().configureOutput({ writeOut: (s) => (out += s), writeErr: (s) => (out += s) });
  addVerbHelp(program.command("decide"), { edit: { usage: "cast decide edit [sd-N]", summary: "Rewrite the open decision", flags: ["--question", "--json"] } })
    .argument("[question]")
    .argument("[args...]")
    .option("--question <text>", "edit: replace the question")
    .option("--note <text>", "recommend: what to know")
    .option("--json", "Machine-readable output")
    .action(() => {});
  try {
    program.parse(["node", "cast", ...argv]);
  } catch {
    /* help exits through exitOverride */
  }
  return out;
}

describe("--help after a positional verb", () => {
  test("prints only that verb's usage and flags", () => {
    const out = helpFor(["decide", "edit", "--help"]);
    expect(out).toStartWith("Usage: cast decide edit [sd-N]");
    expect(out).toContain("--question <text>");
    expect(out).not.toContain("--note");
    expect(out).toContain("Every verb and flag: cast decide --help");
  });

  test("the bare command and an unknown word keep the whole help", () => {
    expect(helpFor(["decide", "--help"])).toContain("--note");
    expect(helpFor(["decide", "why", "--help"])).toContain("--note");
  });

  test("every flag a verb names exists on its real command", () => {
    // Flags are matched to the options by long name; a renamed flag would drop out of its verb's help silently.
    const deps = { getCliEndpoint: () => ({ siteUrl: "", apiToken: "" }), detectCurrentSessionId: () => null };
    const program = new Command("cast");
    registerDecideCommand(program, deps);
    registerPublishCommand(program, deps);
    for (const [name, specs] of [["decide", DECIDE_VERB_HELP], ["publish", PUBLISH_VERB_HELP]] as const) {
      const longs = new Set(program.commands.find((c) => c.name() === name)!.options.map((o) => o.long));
      for (const spec of Object.values(specs)) for (const flag of spec.flags ?? []) expect([name, flag, longs.has(flag)]).toEqual([name, flag, true]);
    }
  });
});
