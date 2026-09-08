// One directory resolver, and proof that nothing quietly grows a second one.
//
// The CLI used to carry about thirty copies of "where does codecast keep its
// state", under three names and two different answers. config/readAuthConfig
// built `$HOME + "/.codecast"`; browser/autoShot read CODECAST_DIR first. Under
// the CODECAST_DIR isolation the tests use, those are different directories, so
// the browser wrote a setting into the sandbox and the auth reader looked for it
// in the developer's real home and found nothing (ct-49869).
//
// Copies are the whole disease, so the guard below is about arithmetic, not
// style: every source outside config/configDir.ts is scanned for the two ways
// the old copies were written, and any hit fails. When it fails on your code,
// import defaultConfigDir instead of rebuilding the path — it is a leaf module
// (two node builtins, nothing first-party), so there is no graph cost anywhere,
// including the stable-context fast path.
//
// Deliberately NOT guarded: the shell scripts this CLI generates (supervision.ts
// writes the watchdog LaunchAgents, stableContext.ts the hook wrappers) spell
// the path as `$HOME/.codecast` inside a template literal. Those run later under
// launchd, in a shell that never sees CODECAST_DIR, so a TypeScript resolver
// cannot reach them and an allowlist entry for them could never be retired.

import { describe, expect, test, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { codeLines } from "../test-helpers/sourceRegion.js";
import { defaultConfigDir, readAuthConfig } from "./readAuthConfig.js";
import { readSharedConfig } from "./sharedConfig.js";
import { autoShotsEnabled, setAutoShots } from "../browser/autoShot.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The home the old copies were rooted at, in every spelling they used... */
const HOME_ROOT = String.raw`(?:process\.env\.HOME|os\.homedir\(\)|homedir\(\)|homeDir\(\))`;
/** ...and the fallback chains they hung off it. The first version of this
 *  pattern assumed the path followed the home expression directly, so anything
 *  that interposed a fallback walked straight past it: `process.env.HOME || ""`
 *  hid the CODECAST_DIR-blind bug in agentPrompt.ts (on the fast path) and
 *  desktopUpdate.ts, and the guard called itself complete while both stood. */
const HOME = String.raw`${HOME_ROOT}(?:\s*(?:\|\||\?\?)\s*(?:${HOME_ROOT}|""|''))*`;

const FORBIDDEN: Array<{ rx: RegExp; what: string }> = [
  {
    // ".codecast" ends the argument or opens a subpath inside the config dir.
    // Demanding the closing quote is how `".codecast/scaleway"` escaped.
    rx: new RegExp(String.raw`${HOME}\s*(?:\+\s*"/?\.codecast|,\s*"\.codecast["/])`),
    what: "builds the config dir from the home directory",
  },
  {
    rx: /process\.env\.CODECAST_DIR/,
    what: "reads CODECAST_DIR",
  },
];

/** Each entry needs a reason the copy cannot be the shared resolver. Empty is
 *  the correct state; a stale entry fails the guard too. */
const ALLOWED: Record<string, string> = {
  // The isolation helper itself: it WRITES CODECAST_DIR and has to know the
  // real directory to tell "already redirected" from "pointed at the human's
  // state" (ct-49576). Calling the resolver here would only hide that.
  "test-helpers/codecastDir.ts": "sets and restores CODECAST_DIR; naming the real directory is its whole job",
};

const SKIP_DIRS = new Set(["node_modules", "dist", "__fixtures__"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
      continue;
    }
    // Tests are exempt: setting CODECAST_DIR and building a scratch home is
    // exactly the isolation the resolver exists to honour.
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

describe("the config dir has exactly one resolver", () => {
  const offenders: string[] = [];
  const seenAllowed = new Set<string>();
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file);
    if (rel === path.join("config", "configDir.ts")) continue; // the resolver itself
    for (const { line, n } of codeLines(fs.readFileSync(file, "utf8"))) {
      const hit = FORBIDDEN.find(({ rx }) => rx.test(line));
      if (!hit) continue;
      if (rel in ALLOWED) {
        seenAllowed.add(rel);
        continue;
      }
      offenders.push(`${rel}:${n} ${hit.what} — import defaultConfigDir from config/configDir.js`);
    }
  }

  test("no source rebuilds the config dir", () => {
    expect(offenders).toEqual([]);
  });

  test("no stale allowlist entries", () => {
    expect(Object.keys(ALLOWED).filter((rel) => !seenAllowed.has(rel))).toEqual([]);
  });

  test("the resolver stays a leaf, so any caller can import it", () => {
    const src = fs.readFileSync(path.join(SRC, "config", "configDir.ts"), "utf8");
    const imports = (src.match(/^import .* from "([^"]+)";$/gm) ?? [])
      .map((line) => line.match(/from "([^"]+)"/)![1]);
    expect(imports.every((spec) => spec.startsWith("node:"))).toBe(true);
  });
});

describe("defaultConfigDir", () => {
  const saved = { HOME: process.env.HOME, CODECAST_DIR: process.env.CODECAST_DIR };
  const scratch: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "configdir-"));
    scratch.push(d);
    return d;
  };

  afterEach(() => {
    for (const key of ["HOME", "CODECAST_DIR"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  test("CODECAST_DIR wins over HOME", () => {
    const dir = tmp();
    process.env.HOME = tmp();
    process.env.CODECAST_DIR = dir;
    expect(defaultConfigDir()).toBe(dir);
  });

  test("falls back to $HOME/.codecast", () => {
    const home = tmp();
    delete process.env.CODECAST_DIR;
    process.env.HOME = home;
    expect(defaultConfigDir()).toBe(path.join(home, ".codecast"));
  });

  test("$HOME beats os.homedir(), which bun caches at startup", () => {
    const home = tmp();
    delete process.env.CODECAST_DIR;
    process.env.HOME = home;
    // A resolver on os.homedir() would answer the developer's real home here
    // and escape every $HOME-sandboxed test on the way past.
    expect(defaultConfigDir()).not.toBe(path.join(os.homedir(), ".codecast"));
  });

  // The regression itself: before ct-49869 the browser wrote through its own
  // CODECAST_DIR-aware copy while the auth reader looked under $HOME, so this
  // round trip lost the write.
  test("the browser settings and the auth reader agree on the directory", () => {
    const dir = tmp();
    process.env.HOME = tmp();
    process.env.CODECAST_DIR = dir;

    setAutoShots(true);

    expect(defaultConfigDir()).toBe(dir);
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(true);
    expect(readSharedConfig(defaultConfigDir()).browser?.auto_shots).toBe(true);
    expect(readAuthConfig(defaultConfigDir())?.browser?.auto_shots).toBe(true);
    expect(autoShotsEnabled()).toBe(true);
    // Generous because setAutoShots publishes through atomicWriteFile, which
    // fsyncs before the rename: on a loaded machine that one write measures
    // anywhere from 200ms to several seconds, and the assertion here is about
    // which directory it landed in, not how fast the disk acknowledged it.
  }, 30_000);
});
