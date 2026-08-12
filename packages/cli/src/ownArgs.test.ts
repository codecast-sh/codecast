// Regression tests for two failures that combined to make `cast own` unusable
// from a scripted one-liner (see jx71s6a): an agent ran
//
//   cast own $(cast codecast 2>/dev/null | grep -oE 'jx[a-z0-9]+' | head -1) <email>
//     || cast own <email>
//
// `cast codecast` is not a command, but the root action handler swallowed the
// unknown operand, printed 32KB of help to STDOUT and exited 0 — so the grep
// scraped `jx7c6zk`, the placeholder id out of `cast own`'s OWN examples, and
// the CLI tried to own a session that never existed. The `||` fallback then
// failed too, because a lone argument filled the SESSION slot, not the member
// slot: "No session found for \"ashot@almostcandid.com\"".
//
// These drive the real entrypoint against a local capture server, so the
// assertions are on the request the CLI actually sends rather than on a
// reimplementation of its argument parsing. Each case spawns bun on a
// 16k-line entrypoint, hence the explicit per-test timeout.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ENTRY = path.join(import.meta.dir, "index.ts");
const SPAWN_TIMEOUT = 30_000;

let server: ReturnType<typeof Bun.serve>;
let home: string;
let captured: Array<{ path: string; body: any }> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json().catch(() => ({}));
      captured.push({ path: new URL(req.url).pathname, body });
      return Response.json({ owners: [], added: [], removed: ["me"], short_id: "CAPTURED" });
    },
  });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-own-args-"));
  fs.mkdirSync(path.join(home, ".codecast"));
  fs.writeFileSync(
    path.join(home, ".codecast", "config.json"),
    JSON.stringify({ auth_token: "test-token", convex_url: `http://127.0.0.1:${server.port}` }),
  );
});

afterAll(() => {
  server?.stop(true);
  fs.rmSync(home, { recursive: true, force: true });
});

// Run the real CLI with a deterministic "current session" and an isolated HOME
// (CONFIG_DIR is derived from process.env.HOME, so this redirects all config).
//
// Async on purpose: Bun.spawnSync blocks this process's event loop, so the
// in-process capture server above could never answer the CLI's request and
// every networked case would deadlock until the test timed out.
async function run(args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}) {
  captured = [];
  const proc = Bun.spawn({
    cmd: [process.execPath, ENTRY, ...args],
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: "CURRENT-SESSION", ...opts.env },
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // The CLI also fires a telemetry POST to /cli/log; only the command's own
  // request is interesting here.
  const calls = captured.filter((c) => !c.path.startsWith("/cli/log"));
  return { exitCode, stdout, stderr, call: calls[0] };
}

describe("unknown commands fail instead of printing help to stdout", () => {
  test("an invented subcommand exits nonzero with nothing scrapable on stdout", async () => {
    const r = await run(["codecast"]);
    expect(r.exitCode).not.toBe(0);
    // The whole bug: a scrape of stdout must come back empty, so the
    // placeholder id in the help examples is unreachable.
    expect(r.stdout).toBe("");
    expect(r.stdout).not.toMatch(/jx[a-z0-9]+/);
    expect(r.stderr).toContain("unknown command 'codecast'");
  }, SPAWN_TIMEOUT);

  test("bare `cast` still prints help and exits 0", async () => {
    const r = await run([]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage: cast");
  }, SPAWN_TIMEOUT);
});

describe("cast own / disown resolve a lone member against the current session", () => {
  test("an email argument fills the MEMBER slot, not the session slot", async () => {
    const r = await run(["own", "ashot@almostcandid.com"]);
    expect(r.call?.path).toBe("/cli/sessions/own");
    expect(r.call?.body.owner).toBe("ashot@almostcandid.com");
    expect(r.call?.body.session_id).toBe("CURRENT-SESSION");
  }, SPAWN_TIMEOUT);

  test("a name with a space fills the MEMBER slot too", async () => {
    const r = await run(["own", "Jason Benn"]);
    expect(r.call?.body.owner).toBe("Jason Benn");
    expect(r.call?.body.session_id).toBe("CURRENT-SESSION");
  }, SPAWN_TIMEOUT);

  test("an id-shaped argument still means the SESSION, claimed by you", async () => {
    const r = await run(["own", "jx7c6zk"]);
    expect(r.call?.body.session_id).toBe("jx7c6zk");
    expect(r.call?.body.owner).toBe("me");
  }, SPAWN_TIMEOUT);

  test("two arguments keep their original meaning", async () => {
    const r = await run(["own", "jx7c6zk", "ashot@almostcandid.com"]);
    expect(r.call?.body.session_id).toBe("jx7c6zk");
    expect(r.call?.body.owner).toBe("ashot@almostcandid.com");
  }, SPAWN_TIMEOUT);

  test("disown shares the resolution", async () => {
    const r = await run(["disown", "ashot@almostcandid.com"]);
    expect(r.call?.path).toBe("/cli/sessions/disown");
    expect(r.call?.body.owner).toBe("ashot@almostcandid.com");
    expect(r.call?.body.session_id).toBe("CURRENT-SESSION");
  }, SPAWN_TIMEOUT);

  test("disown with an id-shaped argument is unchanged", async () => {
    const r = await run(["disown", "jx7c6zk"]);
    expect(r.call?.body.session_id).toBe("jx7c6zk");
    expect(r.call?.body.owner).toBe("me");
  }, SPAWN_TIMEOUT);

  test("a lone member with no detectable session errors instead of guessing", async () => {
    // Detection has three inputs, so all three have to come up empty: no
    // CLAUDE_CODE_SESSION_ID, a cwd outside any tracked project (process
    // ancestry matches on the project root), and an isolated HOME with no
    // ~/.claude transcripts to fall back on.
    const r = await run(["own", "ashot@almostcandid.com"], {
      env: { CLAUDE_CODE_SESSION_ID: "" },
      cwd: os.tmpdir(),
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("ashot@almostcandid.com");
    // It must not have silently posted anything.
    expect(r.call).toBeUndefined();
  }, SPAWN_TIMEOUT);
});
