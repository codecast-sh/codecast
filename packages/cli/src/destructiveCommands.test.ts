import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { DESTRUCTIVE_COMMANDS, destructiveGate, isDestructivePath } from "./destructiveCommands.js";

/**
 * The table is only worth anything if every path in it is a command someone can
 * actually run: a stale entry silently stops guarding a live command, and a
 * misspelled one guards nothing at all. index.ts calls program.parse() at
 * import time, so the registered paths are read out of the source instead.
 */
function registeredCommands(): Set<string> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "__fixtures__") walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
        files.push(full);
      }
    }
  };
  walk(import.meta.dir);

  // A registration is `<receiver>.command("<name>")`. `<receiver>` is either the
  // root program (or a builder's `parent` argument), or a variable that itself
  // holds a command — `const doc = program.command("doc")`.
  const definedBy = new Map<string, { receiver: string; name: string }>();
  const registrations: { receiver: string; name: string }[] = [];

  for (const file of files) {
    const src = fs.readFileSync(file, "utf-8");
    for (const match of src.matchAll(/\.command\(\s*"([^"\s)]+)/g)) {
      // Bounded windows: the receiver and its `const` sit within a line or two,
      // and slicing whole files here would be quadratic on daemon.ts.
      const before = src.slice(Math.max(0, match.index! - 200), match.index!).replace(/\s+$/, "");
      const receiver = /([A-Za-z_$][\w$]*)$/.exec(before)?.[1];
      if (!receiver) continue;
      const name = match[1]!;
      registrations.push({ receiver, name });

      const declaration = /const\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(
        before.slice(0, before.length - receiver.length),
      );
      if (declaration) definedBy.set(declaration[1]!, { receiver, name });
    }
  }

  // Receivers that are not a defined command variable are the root: `program`
  // itself, and the `parent` a registerXCommand(parent) builder mounts onto.
  const pathOf = (receiver: string, seen = new Set<string>()): string[] => {
    const definition = definedBy.get(receiver);
    if (!definition || seen.has(receiver)) return [];
    seen.add(receiver);
    return [...pathOf(definition.receiver, seen), definition.name];
  };

  return new Set(registrations.map((reg) => [...pathOf(reg.receiver), reg.name].join(" ")));
}

describe("DESTRUCTIVE_COMMANDS", () => {
  const registered = registeredCommands();

  test("the source scan resolves nesting", () => {
    // A scanner that collapsed every command to the root, or found none at all,
    // would make the checks below vacuous.
    expect(registered.has("workspace destroy")).toBe(true);
    expect(registered.has("destroy")).toBe(false);
    expect(registered.has("doc")).toBe(true);
  });

  test("names only registered commands", () => {
    const missing = DESTRUCTIVE_COMMANDS.map((cmd) => cmd.path.join(" ")).filter(
      (full) => !registered.has(full),
    );
    expect(missing).toEqual([]);
  });

  test("lists each command once", () => {
    const paths = DESTRUCTIVE_COMMANDS.map((cmd) => cmd.path.join(" "));
    expect(paths).toEqual([...new Set(paths)]);
  });

  test("covers the verbs that cannot be undone", () => {
    const verbs = new Set(DESTRUCTIVE_COMMANDS.map((cmd) => cmd.path[cmd.path.length - 1]!));
    for (const verb of ["destroy", "rm", "kill", "delete", "cancel", "drop", "stop"]) {
      expect(verbs.has(verb)).toBe(true);
    }
  });

  test("marks paths, not bare verbs", () => {
    expect(isDestructivePath(["doc", "delete"])).toBe(true);
    // `rm` is destructive under `label`, but `cast label rename` is not.
    expect(isDestructivePath(["label", "rename"])).toBe(false);
    expect(isDestructivePath(["delete"])).toBe(false);
  });
});

describe("destructiveGate", () => {
  test("refuses without --yes and prints the exact re-run", () => {
    expect(destructiveGate(["doc", "delete"], { args: ["doc-7"] })).toEqual({
      kind: "refuse",
      lines: [
        "This permanently deletes the document. Re-run with --yes to confirm:",
        "  cast doc delete doc-7 --yes",
      ],
    });
  });

  test("asks on the terminal when the gate is a prompt", () => {
    expect(destructiveGate(["uninstall"])).toEqual({
      kind: "ask",
      question:
        "This will remove cast, its daemon, auto-start config, and all local data. Continue? [y/N] ",
    });
  });

  test("--yes passes either gate", () => {
    expect(destructiveGate(["doc", "delete"], { yes: true, args: ["doc-7"] })).toEqual({ kind: "pass" });
    expect(destructiveGate(["uninstall"], { yes: true })).toEqual({ kind: "pass" });
  });

  test("passes a destructive command that declares no gate", () => {
    expect(destructiveGate(["trigger", "cancel"])).toEqual({ kind: "pass" });
  });

  test("throws when asked about a command the table does not know", () => {
    expect(() => destructiveGate(["label", "rename"])).toThrow(/not in DESTRUCTIVE_COMMANDS/);
  });
});
