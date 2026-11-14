/**
 * `cast computer` starts from fastPath.ts → entry.ts, not index.ts.
 *
 * An agent pays the CLI's startup on every step, and the whole saving is in
 * what this path does not load: index.ts's ~640-module graph, the sync client,
 * the browser launcher, the shared contracts barrel. A static import added
 * anywhere under the computer modules can quietly put one of them back, so
 * the modules the path evaluates are read from a real process here. The rest
 * pins that the short path still behaves like the full CLI where it must:
 * help, the unknown-verb suggestion, and the managed-policy refusal.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SRC = path.join(import.meta.dir, "..");
const MAIN = path.join(SRC, "main.ts");

let home = "";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-computer-entry-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function cast(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [MAIN, ...args], {
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, CODECAST_DIR: home, CODECAST_MANAGED_PREFS: path.join(home, "none.json"), ...env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test("the computer path evaluates none of the CLI's heavy modules", () => {
  // Every module the verbs reach: the entry, the registration, the action and
  // the client it loads lazily.
  const modules = ["computer/entry.ts", "computer/cli.ts", "computer/run.ts", "computer/client.ts", "computer/helperPayload.ts"];
  const script = `for (const m of ${JSON.stringify(modules.map((m) => path.join(SRC, m)))}) await import(m);
console.log(JSON.stringify(Object.keys(require.cache)));`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf-8", timeout: 60_000 });
  expect(r.status).toBe(0);
  const loaded = (JSON.parse(r.stdout) as string[]).map((f) => f.split(path.sep).join("/"));
  const forbidden = [
    "/cli/src/index.ts",
    "/cli/src/syncService.ts",
    "/cli/src/imageCommand.ts",
    "/cli/src/browser/instance.ts",
    "/cli/src/browser/profile.ts",
    "/cli/src/update.ts",
    "/shared/contracts/index.ts",
    "/node_modules/convex/",
  ];
  expect(forbidden.filter((needle) => loaded.some((f) => f.includes(needle)))).toEqual([]);
}, 60_000);

test("help comes from the real group registration", () => {
  const r = cast(["computer", "list-apps", "--help"]);
  expect(r.status).toBe(0);
  expect(r.out).toContain("Usage: cast computer list-apps");
});

test("an unknown verb still gets its sibling suggestion", () => {
  const r = cast(["computer", "list-app"]);
  expect(r.status).toBe(1);
  expect(r.err).toContain("unknown command 'computer list-app'");
  expect(r.err).toContain("list-apps");
});

test("a managed policy that turns computer control off still refuses", () => {
  const prefs = path.join(home, "prefs.json");
  fs.writeFileSync(prefs, JSON.stringify({ ComputerControlDisabled: true }));
  const r = cast(["computer", "list-apps"], { CODECAST_MANAGED_PREFS: prefs });
  expect(r.status).toBe(1);
  expect(r.err).toContain("turned off by your device's management profile");
  expect(r.out).toBe("");
});
