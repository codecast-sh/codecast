import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isLaunchToken, launchTokenEnv, LAUNCH_TOKEN_VAR, mintLaunchToken } from "./agentEnv.js";
import { LaunchTokenLedger, launchTokenLedger } from "./launchToken.js";
import { judgeProcessIdentity } from "./sessionProcessMatcher.js";
import { CODECAST_STATUS_HOOK } from "./statusHook.js";

// Every ledger in here writes into its own CODECAST_DIR, so no test reads the
// real ~/.codecast and none can see another's file.
let dir: string;
let priorCodecastDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-launch-token-"));
  priorCodecastDir = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
});

afterEach(() => {
  if (priorCodecastDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = priorCodecastDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const ledger = () => new LaunchTokenLedger({ dir });

describe("launch token env stamping", () => {
  test("a minted token is hex-only, so it stays inert in a send-keys -l line", () => {
    const token = mintLaunchToken();
    expect(isLaunchToken(token)).toBe(true);
    expect(launchTokenEnv(token)).toBe(` ${LAUNCH_TOKEN_VAR}=${token}`);
  });

  test("anything that is not a minted token contributes no assignment", () => {
    expect(launchTokenEnv(undefined)).toBe("");
    expect(launchTokenEnv("")).toBe("");
    expect(launchTokenEnv("; rm -rf ~")).toBe("");
  });
});

describe("launch token fence", () => {
  test("the current launch is admitted; the launch it replaced is dropped", () => {
    const l = ledger();
    const first = l.issue("cc-claude-abc", "sess-1");
    expect(l.admit({ sessionId: "sess-1", token: first }).decision).toBe("accept");

    // A resume of the same session in the same pane: a new token, and the
    // process the resume left behind still posts under the old one.
    const second = l.issue("cc-claude-abc", "sess-1");
    expect(second).not.toBe(first);
    expect(l.admit({ sessionId: "sess-1", token: second }).decision).toBe("accept");
    const orphan = l.admit({ sessionId: "sess-1", token: first });
    expect(orphan.decision).toBe("drop");
    expect(orphan.reason).toBe("stale-token");
    expect(orphan.notable).toBe(true);
  });

  test("a resume into a NEW pane supersedes the launch left alive in the old one", () => {
    const l = ledger();
    // The started pane, still holding a live process.
    const started = l.issue("cc-claude-conv1", "sess-1");
    expect(l.admit({ sessionId: "sess-1", token: started }).decision).toBe("accept");
    // The resume lands in cc-resume-…, so the old pane is still its own pane's
    // current launch — only the session's head can tell it apart.
    const resumed = l.issue("cc-resume-sess-1", "sess-1");
    expect(l.admit({ sessionId: "sess-1", token: resumed }).decision).toBe("accept");
    const orphan = l.admit({ sessionId: "sess-1", token: started, newTurn: true });
    expect(orphan.decision).toBe("drop");
    expect(orphan.reason).toBe("stale-token");
    expect(l.isStaleToken(started)).toBe(true);
    expect(l.isStaleToken(resumed)).toBe(false);
  });

  test("a retired pane drops the launch that was running in it", () => {
    const l = ledger();
    const token = l.issue("cc-claude-abc", "sess-1");
    l.retirePane("cc-claude-abc");
    const after = l.admit({ sessionId: "sess-1", token });
    expect(after.decision).toBe("drop");
    expect(after.reason).toBe("retired-pane");
    // Not even a turn start brings the same launch back — a live orphan emits
    // those too, and replaying them re-entered the process the pane moved on from.
    expect(l.admit({ sessionId: "sess-1", token, newTurn: true }).decision).toBe("drop");
  });

  test("a retired pane comes back on a new turn from a token it has never seen", () => {
    const l = ledger();
    const old = l.issue("cc-claude-abc", "sess-1");
    l.retirePane("cc-claude-abc");
    const fresh = mintLaunchToken();
    // Mid-turn events prove nothing: a process that never announced itself
    // cannot claim a retired pane.
    expect(l.admit({ sessionId: "sess-1", token: fresh }).decision).toBe("drop");
    const restart = l.admit({ sessionId: "sess-1", token: fresh, newTurn: true });
    expect(restart.decision).toBe("accept");
    expect(restart.reason).toBe("restart");
    // …and the pane is fenced against the old launch again.
    expect(l.admit({ sessionId: "sess-1", token: fresh }).decision).toBe("accept");
    expect(l.admit({ sessionId: "sess-1", token: old }).decision).toBe("drop");
  });

  test("a launch into a retired pane un-retires it", () => {
    const l = ledger();
    l.issue("cc-claude-abc", "sess-1");
    l.retirePane("cc-claude-abc");
    const relaunch = l.issue("cc-claude-abc", "sess-1");
    expect(l.admit({ sessionId: "sess-1", token: relaunch }).decision).toBe("accept");
  });

  test("a hook script with no token is accepted for one release, and logged once", () => {
    const l = ledger();
    l.issue("cc-claude-abc", "sess-1");
    const first = l.admit({ sessionId: "sess-1" });
    expect(first.decision).toBe("accept");
    expect(first.reason).toBe("legacy");
    expect(first.notable).toBe(true);
    const second = l.admit({ sessionId: "sess-1" });
    expect(second.decision).toBe("accept");
    expect(second.notable).toBe(false);
  });

  test("a session this daemon never launched is not fenced at all", () => {
    const l = ledger();
    const verdict = l.admit({ sessionId: "sess-in-their-own-terminal" });
    expect(verdict.decision).toBe("accept");
    expect(verdict.reason).toBe("unmanaged");
    expect(verdict.notable).toBe(false);
  });

  test("a relocated occupant keeps posting; the name it left is retired", () => {
    const l = ledger();
    const occupant = l.issue("cc-resume-squatted", "sess-occupant");
    l.relocatePane("cc-resume-squatted", "cc-resume-home");
    expect(l.admit({ sessionId: "sess-occupant", token: occupant }).decision).toBe("accept");
    expect(l.currentToken("cc-resume-home")).toBe(occupant);
    // The vacated name is now fenced: the session that takes it next mints its
    // own token, and anything still posting under the old one is dropped.
    const stranger = mintLaunchToken();
    expect(l.admit({ sessionId: "sess-other", token: stranger }).decision).toBe("accept"); // unknown pane
    const relaunch = l.issue("cc-resume-squatted", "sess-other");
    expect(l.admit({ sessionId: "sess-other", token: relaunch }).decision).toBe("accept");
  });

  test("a daemon restart keeps the fence", () => {
    const first = ledger();
    const stale = first.issue("cc-claude-abc", "sess-1");
    const current = first.issue("cc-claude-abc", "sess-1");
    first.issue("cc-claude-retired", "sess-2");
    first.retirePane("cc-claude-retired");

    const rebooted = ledger();
    expect(rebooted.currentToken("cc-claude-abc")).toBe(current);
    expect(rebooted.admit({ sessionId: "sess-1", token: current }).decision).toBe("accept");
    expect(rebooted.admit({ sessionId: "sess-1", token: stale }).decision).toBe("drop");
    expect(rebooted.admit({ sessionId: "sess-2", token: first.currentToken("cc-claude-retired")! }).decision).toBe("drop");
  });

  test("the shared ledger follows CODECAST_DIR", () => {
    const token = launchTokenLedger().issue("cc-claude-abc", "sess-1");
    expect(fs.existsSync(path.join(dir, "launch-tokens.json"))).toBe(true);
    expect(launchTokenLedger().admit({ sessionId: "sess-1", token }).decision).toBe("accept");
  });
});

describe("registry claims carry the launch", () => {
  test("a pid claiming the right session under a superseded launch is foreign", () => {
    const l = ledger();
    const stale = l.issue("cc-claude-abc", "sess-1");
    l.issue("cc-claude-abc", "sess-1");
    const judged = judgeProcessIdentity({
      sessionId: "sess-1",
      argvId: "sess-1",
      claims: [{ sessionId: "sess-1", ts: 2000, launchToken: stale }],
      processStartSec: 1000,
      staleLaunchToken: (t) => l.isStaleToken(t),
    });
    expect(judged.verdict).toBe("foreign");
    expect(judged.reason).toBe("stale-token");
  });

  test("the same claim under the current launch owns the session", () => {
    const l = ledger();
    const current = l.issue("cc-claude-abc", "sess-1");
    expect(judgeProcessIdentity({
      sessionId: "sess-1",
      argvId: "sess-1",
      claims: [{ sessionId: "sess-1", ts: 2000, launchToken: current }],
      processStartSec: 1000,
      staleLaunchToken: (t) => l.isStaleToken(t),
    }).verdict).toBe("owned");
  });

  test("a claim with no token is judged exactly as it was before launch tokens", () => {
    const l = ledger();
    expect(judgeProcessIdentity({
      sessionId: "sess-1",
      argvId: "sess-1",
      claims: [{ sessionId: "sess-1", ts: 2000 }],
      processStartSec: 1000,
      staleLaunchToken: (t) => l.isStaleToken(t),
    }).verdict).toBe("owned");
  });
});

// The fence has to sit at the funnel both transports reach, and handleStatusData
// lives inside the daemon's main(), out of reach of a test. The wiring is
// asserted the same way the route's id check is (daemon.hookStatusRoute.test.ts).
describe("the daemon fences hook posts where both transports land", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.ts"), "utf8");

  test("the route forwards the token onto the status record", () => {
    const routeAt = src.indexOf('req.url?.startsWith("/hook/status")');
    expect(routeAt).toBeGreaterThan(-1);
    expect(src.indexOf('url.searchParams.get("launch_token")', routeAt)).toBeGreaterThan(routeAt);
    expect(src.indexOf("launch_token: launchToken", routeAt)).toBeGreaterThan(routeAt);
  });

  test("every status is admitted before anything is done with it", () => {
    const handlerAt = src.indexOf("function handleStatusData(sessionId: string");
    expect(handlerAt).toBeGreaterThan(-1);
    const admitAt = src.indexOf("admitHookPost(sessionId, data)", handlerAt);
    const useAt = src.indexOf("conversationCache[sessionId]", handlerAt);
    expect(admitAt).toBeGreaterThan(handlerAt);
    expect(admitAt).toBeLessThan(useAt);
  });

  test("a killed pane and a relocated one are both retired", () => {
    const killAt = src.indexOf("async function killTmuxSessionAndTree(");
    expect(src.indexOf("launchTokenLedger().retirePane(tmuxSession)", killAt)).toBeGreaterThan(killAt);
    const relocateAt = src.indexOf("async function relocateForeignOccupant(");
    expect(src.indexOf("launchTokenLedger().relocatePane(tmuxSession, home)", relocateAt)).toBeGreaterThan(relocateAt);
  });
});

// The hook is the transport: run the installed script the way Claude Code does
// and read back what it recorded.
describe("codecast-status.sh forwards the launch token", () => {
  let home: string;
  let hookFile: string;

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-launch-hook-"));
    hookFile = path.join(home, "codecast-status.sh");
    fs.writeFileSync(hookFile, CODECAST_STATUS_HOOK, { mode: 0o755 });
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runHook(sessionId: string, env: Record<string, string>): Record<string, unknown> {
    execFileSync("bash", [hookFile], {
      input: JSON.stringify({ session_id: sessionId, hook_event_name: "Stop" }),
      env: { ...process.env, HOME: home, ...env },
    });
    return JSON.parse(fs.readFileSync(path.join(home, ".codecast", "agent-status", `${sessionId}.json`), "utf-8"));
  }

  test("the pane's token rides the status record", () => {
    const token = mintLaunchToken();
    const out = runHook("tok-1", { CODECAST_LAUNCH_TOKEN: token });
    expect(out.status).toBe("idle");
    expect(out.launch_token).toBe(token);
  });

  test("a pane launched before this shipped still reports its status", () => {
    const out = runHook("tok-2", { CODECAST_LAUNCH_TOKEN: "" });
    expect(out.status).toBe("idle");
    expect(out.launch_token).toBeUndefined();
  });
});
