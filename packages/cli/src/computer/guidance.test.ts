/**
 * The `## Computer` section an agent reads, held against the binary it
 * describes (ct-49522).
 *
 * Guidance drifts silently: a verb gets renamed, a flag gets a new spelling, a
 * failure gets a new code, and the section in every CLAUDE.md on the fleet goes
 * on teaching last month's command line with nothing to say it is wrong. So the
 * three things the section names are all checked against their source:
 *
 *   - every `cast computer <verb>` it shows is a verb the CLI registers,
 *   - every `--flag` it shows is an option some verb declares,
 *   - every error code in its table is one the CLI actually raises, and none
 *     of them is missing.
 *
 * The flags beyond the ones it shows come from `cast computer help <verb>`,
 * rendered from this same binary — which is why the section points there rather
 * than trying to carry them all.
 */

import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderSectionBody, snippetBySlug } from "@codecast/shared/contracts";
import { registerComputerCommand } from "./cli.js";
import { isComputerErrorCode } from "./errors.js";
import { guidanceSectionStatus } from "../snippets.js";

const computer = snippetBySlug("computer")!;
const BODY = computer.section!.body;

/** The registered command tree, built the way index.ts builds it. */
function registeredGroup(): Command {
  const program = new Command();
  registerComputerCommand(program);
  return program.commands.find((c) => c.name() === "computer")!;
}

const group = registeredGroup();
const VERBS = new Set(group.commands.map((c) => c.name()));
const FLAGS = new Set(
  group.commands.flatMap((c) => c.options.map((o) => o.long).filter((l): l is string => !!l)),
);

/**
 * The codes the CLI can raise.
 *
 * Read out of the source rather than imported: `ComputerErrorCode` is a type,
 * and the RECOVERY table that enumerates it is private to errors.ts. Scraping
 * it keeps this check from needing a new export in a file another task owns.
 */
function errorCodes(): string[] {
  const source = fs.readFileSync(path.join(import.meta.dir, "errors.ts"), "utf-8");
  const table = source.slice(source.indexOf("const RECOVERY"), source.indexOf("const CODES"));
  const codes = [...table.matchAll(/^ {2}([a-z_]+): \[/gm)].map((m) => m[1]!);
  expect(codes.length).toBeGreaterThan(10); // a scrape that finds nothing passes everything
  return codes;
}

describe("the Computer section describes the binary that ships with it", () => {
  // Anchored to a line start or a backtick so it reads COMMANDS, not the prose
  // that names the helper app ("the codecast computer helper").
  const named = new Set([...BODY.matchAll(/(?:^|`)cast computer ([a-z-]+)/gm)].map((m) => m[1]!));

  test("names only verbs the CLI registers", () => {
    expect(named.size).toBeGreaterThan(10);
    const unknown = [...named].filter((v) => !VERBS.has(v));
    expect(`verbs in the snippet with no command: ${unknown.join(", ") || "none"}`).toBe(
      "verbs in the snippet with no command: none",
    );
  });

  test("shows every verb, so one read is the whole surface", () => {
    const missing = [...VERBS].filter((v) => !named.has(v));
    expect(`verbs the snippet never shows: ${missing.join(", ") || "none"}`).toBe(
      "verbs the snippet never shows: none",
    );
  });

  test("names only flags some verb declares", () => {
    const flags = new Set([...BODY.matchAll(/--[a-z][a-z-]+/g)].map((m) => m[0]));
    expect(flags.size).toBeGreaterThan(10);
    const unknown = [...flags].filter((f) => !FLAGS.has(f));
    expect(`flags in the snippet no verb takes: ${unknown.join(", ") || "none"}`).toBe(
      "flags in the snippet no verb takes: none",
    );
  });

  test("its error table is exactly the set of codes the CLI raises", () => {
    const tabled = [...BODY.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]!);
    expect(tabled.slice().sort()).toEqual(errorCodes().slice().sort());
    for (const code of tabled) expect(isComputerErrorCode(code)).toBe(true);
  });

  test("every command a recovery names is a verb that takes those flags", () => {
    // The flag check above pools every option in the group, so it passes a
    // recovery that sends an agent to `permissions --restore-window`. Grading
    // each command against the verb it names is what catches a recovery
    // written before a flag moved, or written for a flag that never existed:
    // the permission rows spent a release telling agents to run a command that
    // could not grant anything (ct-49771).
    const rows = [...BODY.matchAll(/^\| `[a-z_]+` \| (.+) \|$/gm)].map((m) => m[1]!);
    expect(rows.length).toBeGreaterThan(10);
    const wrong: string[] = [];
    for (const row of rows) {
      for (const cmd of row.matchAll(/`cast computer ([a-z-]+)((?: --[a-z-]+(?: [^`\s]+)?)*)`/g)) {
        const verb = group.commands.find((c) => c.name() === cmd[1]!);
        if (!verb) {
          wrong.push(`${cmd[1]} is not a verb`);
          continue;
        }
        const declared = new Set(verb.options.map((o) => o.long));
        for (const flag of cmd[2]!.match(/--[a-z-]+/g) ?? []) {
          if (!declared.has(flag)) wrong.push(`${verb.name()} does not take ${flag}`);
        }
      }
    }
    expect(`recoveries naming a command the CLI does not have: ${wrong.join("; ") || "none"}`).toBe(
      "recoveries naming a command the CLI does not have: none",
    );
  });

  test("the permission rows teach the raise, not just the read", () => {
    // Bare `permissions` reads and shows nothing since the read was split from
    // the raise (ct-49667). A row that stops at the read leaves an agent
    // reading `not-granted` forever, so each of the three failures a missing
    // grant produces has to name the flag that opens the pane.
    for (const code of ["permission_denied", "screenshot_failed", "accessibility_error"]) {
      const row = BODY.match(new RegExp(`^\\| \`${code}\` \\| (.+) \\|$`, "m"))?.[1] ?? "";
      expect(`${code} names --open-settings: ${row.includes("--open-settings")}`).toBe(
        `${code} names --open-settings: true`,
      );
      expect(`${code} says to ask the human: ${/ask the human/.test(row)}`).toBe(
        `${code} says to ask the human: true`,
      );
    }
  });

  test("teaches the rules whose cost lands on the human, not on a retry", () => {
    // Each is a decision the design made that an agent cannot infer from the
    // command line: the stale index rule, the focus rule, the secret rule, the
    // behaviour rule, the coordinate conversion, and the line that keeps this
    // tool off web pages.
    expect(BODY).toContain("never infer an index from `elementCount`");
    expect(BODY).toContain("No verb raises a window on its own");
    expect(BODY).toContain("Secrets never go on the command line");
    expect(BODY).toContain("Do not push, submit a form, send a message, buy anything, delete data");
    expect(BODY).toContain("action_x = screenshot_pixel_x / screenshot.scale");
    expect(BODY).toContain("`cast browser` is the tool and stays the default");
  });

  test("the safety rules name the real block list and the real paste cap", () => {
    for (const manager of ["1Password", "Bitwarden", "Dashlane", "LastPass", "NordPass", "Proton Pass"]) {
      expect(BODY).toContain(manager);
    }
    expect(BODY).toContain("16 MiB");
    expect(BODY).toContain("--value-stdin");
  });
});

describe("cast doctor grades the Computer section like any other", () => {
  const config = { computer_enabled: true };
  const current = renderSectionBody(computer, "full", "1.0.0");
  const fileWith = (body: string) => `# My own notes\n\nkeep me\n\n${body.replace(/^\n+/, "")}\n`;

  test("the section this binary writes reads as current", () => {
    const rows = guidanceSectionStatus({
      files: [{ label: "CLAUDE.md", text: fileWith(current) }],
      config,
      version: "1.0.0",
      mode: "full",
    });
    expect(rows).toEqual([{ slug: "computer", file: "CLAUDE.md", state: "current", stamp: "1.0.0" }]);
  });

  test("a body written by an older cast reads as stale, and names it", () => {
    // A body word, not the heading: the heading is how the section is found at
    // all, so changing it would read as missing rather than as drift.
    const older = current.replace("the address field", "the URL bar");
    const rows = guidanceSectionStatus({
      files: [{ label: "CLAUDE.md", text: fileWith(older) }],
      config,
      version: "2.0.0",
      mode: "full",
    });
    expect(rows[0]).toMatchObject({ state: "stale", stamp: "1.0.0" });
  });

  test("enabled with nothing on disk reads as missing", () => {
    const rows = guidanceSectionStatus({
      files: [{ label: "CLAUDE.md", text: "# only my own notes\n" }],
      config,
      version: "1.0.0",
      mode: "full",
    });
    expect(rows[0]).toMatchObject({ state: "missing", stamp: null });
  });
});
