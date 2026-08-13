// Regression tests for two failures that combined to make `cast own` unusable
// from a scripted one-liner (see jx71s6a). An agent ran:
//
//   cast own $(cast codecast 2>/dev/null | grep -oE 'jx[a-z0-9]+' | head -1) <email>
//     || cast own <email>
//
// `cast codecast` is not a command, but the root action handler swallowed the
// unknown operand, printed 32KB of help to STDOUT and exited 0 — so the grep
// scraped `jx7c6zk`, the placeholder id out of `cast own`'s OWN examples, and
// the CLI tried to own a session that never existed. The `||` fallback failed
// too, because a lone argument filled the SESSION slot rather than the member
// slot: `No session found for "ashot@almostcandid.com"`.
import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { looksLikeMember, resolveOwnTarget } from "./ownTarget.js";

const CURRENT = () => "CURRENT-SESSION";
const NONE = () => null;

describe("looksLikeMember", () => {
  test("emails and spaced names are people", () => {
    expect(looksLikeMember("ashot@almostcandid.com")).toBe(true);
    expect(looksLikeMember("Jason Benn")).toBe(true);
  });

  test("session references are not", () => {
    expect(looksLikeMember("jx7c6zk")).toBe(false);
    expect(looksLikeMember("jx71s6ayvgf9qh98zzm555agm58caknb")).toBe(false);
    // A bare handle stays a session reference: it is ambiguous, and misreading
    // it as a member would silently retarget whatever session it names.
    expect(looksLikeMember("jason")).toBe(false);
  });
});

describe("resolveOwnTarget", () => {
  test("a lone email targets the CURRENT session — the bug", () => {
    expect(resolveOwnTarget("ashot@almostcandid.com", undefined, CURRENT)).toEqual({
      ok: true,
      sessionId: "CURRENT-SESSION",
      member: "ashot@almostcandid.com",
    });
  });

  test("a lone spaced name does too", () => {
    expect(resolveOwnTarget("Jason Benn", undefined, CURRENT)).toEqual({
      ok: true,
      sessionId: "CURRENT-SESSION",
      member: "Jason Benn",
    });
  });

  test("a lone id-shaped argument still means the SESSION, with no member", () => {
    expect(resolveOwnTarget("jx7c6zk", undefined, CURRENT)).toEqual({
      ok: true,
      sessionId: "jx7c6zk",
      member: undefined,
    });
  });

  test("two arguments keep their original meaning", () => {
    expect(resolveOwnTarget("jx7c6zk", "ashot@almostcandid.com", CURRENT)).toEqual({
      ok: true,
      sessionId: "jx7c6zk",
      member: "ashot@almostcandid.com",
    });
  });

  test("an explicit session wins even when it looks like a member", () => {
    // Two arguments are never ambiguous, so the first stays the session.
    expect(resolveOwnTarget("a@b.com", "c@d.com", CURRENT)).toEqual({
      ok: true,
      sessionId: "a@b.com",
      member: "c@d.com",
    });
  });

  test("a lone member with no detectable session reports failure, never guesses", () => {
    expect(resolveOwnTarget("ashot@almostcandid.com", undefined, NONE)).toEqual({
      ok: false,
      member: "ashot@almostcandid.com",
    });
  });

  test("a lone session id does not consult detection at all", () => {
    let called = false;
    const detect = () => {
      called = true;
      return null;
    };
    expect(resolveOwnTarget("jx7c6zk", undefined, detect).ok).toBe(true);
    expect(called).toBe(false);
  });
});

// The stdout guarantee only exists end to end: it is the root command's
// unknown-operand handling, and the whole failure was a shell scrape of stdout.
describe("unknown commands (subprocess)", () => {
  const ENTRY = path.join(import.meta.dir, "index.ts");

  // Async spawn, not spawnSync: under `bun test` spawnSync hands back empty
  // pipes. HOME is redirected because a CLI invocation calls
  // ensureDaemonRunning(), and a test must not touch the real daemon or config.
  async function run(args: string[]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-own-args-"));
    try {
      const proc = Bun.spawn({
        cmd: [process.execPath, ENTRY, ...args],
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  test("an invented subcommand fails with nothing scrapable on stdout", async () => {
    const r = await run(["codecast"]);
    expect(r.exitCode).not.toBe(0);
    // The crux: `... | grep -oE 'jx[a-z0-9]+'` must come back empty, so the
    // placeholder id in the help examples can never be mistaken for a session.
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("unknown command 'codecast'");
  }, 30_000);

  test("bare `cast` still prints help and exits 0", async () => {
    const r = await run([]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage: cast");
  }, 30_000);

  // `cast link` is what the agent actually wanted. Its ref argument used to be
  // required, so the one thing you could not ask for was "link to THIS
  // session" — which is why an invented command got reached for instead.
  test("`cast link` takes no required argument", async () => {
    const r = await run(["link", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[ref]");
    expect(r.stdout).not.toContain("<ref>");
  }, 30_000);

  test("`cast link` with no argument does not fail on a missing argument", async () => {
    // HOME is a temp dir, so this reaches the "not authenticated" / "no session
    // detected" path rather than commander's argument check. Either is fine;
    // the regression is specifically `missing required argument`.
    const r = await run(["link"]);
    expect(r.stderr).not.toContain("missing required argument");
  }, 30_000);
});
