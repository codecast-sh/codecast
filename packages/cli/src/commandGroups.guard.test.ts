// The manifest is the only door into `cast computer` and `cast guide`.
//
// Both features shipped with the opposite wiring and the gap went unnoticed for
// a whole workstream. `cast computer` was worse than lazy: registerComputerCommand
// was never called from index.ts at all, so the verb did not exist in the binary
// even though every task that built it was marked done (ct-49848). `cast guide`
// was called, but statically, which is what commandGroups.ts's own header had
// promised it would not be (ct-49849).
//
// bootGraph.guard.test.ts already proves the other direction: a module the
// manifest LISTS must stay off index.ts's static graph. It cannot see a register
// function the manifest never listed, which is exactly how both defects hid. So
// this test starts from the source files instead: every register function these
// two features export has to be named by a manifest entry, and index.ts has to
// reach it through none of the three ways it could bypass one.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_GROUPS } from "./commandGroups.js";
import { staticImportSpecifiers } from "./bench/bootGraph.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const rel = (file: string) => path.relative(SRC, file);

/** The features that must be reachable only through the manifest. A directory
 *  is walked, so a new module inside one is covered the day it is written. */
const LAZY_ONLY = [path.join(SRC, "computer"), path.join(SRC, "guide.ts")];

function sourceFiles(target: string): string[] {
  if (!fs.statSync(target).isDirectory()) return [target];
  return fs
    .readdirSync(target, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [full] : [];
    });
}

/** `export function registerFooCommand(` — the shape index.ts used to call. */
function exportedRegisterFunctions(file: string): string[] {
  const source = fs.readFileSync(file, "utf-8");
  return [...source.matchAll(/^export function (register\w+)\s*\(/gm)].map((m) => m[1]);
}

/** The module specifier each group's `load()` names, e.g. "./computer/cli.js". */
const LOADED_SPECS = COMMAND_GROUPS.map((group) => ({
  token: group.token,
  spec: /import\("([^"]+)"\)/.exec(group.load.toString())?.[1] ?? "",
  body: group.load.toString(),
}));

const REGISTRARS = LAZY_ONLY.flatMap((target) =>
  sourceFiles(target).flatMap((file) =>
    exportedRegisterFunctions(file).map((fn) => ({ file, fn })),
  ),
);

describe("cast computer and cast guide are reachable only through the manifest", () => {
  test("the sweep finds the register functions it exists to protect", () => {
    // A rename that this test stopped seeing would make every case below pass
    // vacuously, which is the failure mode a guard like this dies of.
    expect(REGISTRARS.map((r) => r.fn).sort()).toEqual(["registerComputerCommand", "registerGuideCommand"]);
  });

  test("every exported register function is named by a COMMAND_GROUPS entry", () => {
    for (const { file, fn } of REGISTRARS) {
      const spec = "./" + rel(file).replace(/\.ts$/, ".js");
      const group = LOADED_SPECS.find((g) => g.spec === spec);
      expect(group, `${fn} (${rel(file)}) needs a COMMAND_GROUPS entry whose load() imports "${spec}"`).toBeTruthy();
      expect(group!.body, `the entry for "${group!.token}" must reach ${fn}`).toContain(fn);
    }
  });

  test("a group's load() is a dynamic import, so listing one costs nothing at boot", () => {
    for (const { token, body } of LOADED_SPECS) {
      expect(body, `cast ${token}'s load()`).toMatch(/import\(/);
    }
  });

  test("index.ts neither imports nor calls them", () => {
    const index = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
    const statics = staticImportSpecifiers(index);
    for (const { file, fn } of REGISTRARS) {
      const spec = "./" + rel(file).replace(/\.ts$/, ".js");
      expect(statics, `index.ts static-imports ${spec}; it belongs in COMMAND_GROUPS instead`).not.toContain(spec);
      expect(index, `index.ts calls ${fn} directly; activateGroup must be the only caller`).not.toContain(`${fn}(`);
    }
  });
});
