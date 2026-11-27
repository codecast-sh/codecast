import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUnderLease } from "./repoLeaseCommand";
import { pollUntil } from "../test-helpers/pollUntil";

// `cast repo lease -- <cmd>`: the command runs only once the lease is held, the
// lease goes back when it exits or is stopped, and the exit is the command's.

function server(waits = 0) {
  const ops: string[] = [];
  const post = async (_path: string, body: Record<string, unknown>) => {
    ops.push(String(body.op));
    if (body.op === "release") return { released: true };
    if (body.op === "take" && waits-- > 0) return { held: false, holder: "the merge of PR #9 on host-2", since: 0, position: 2 };
    return { held: true, expires_at: 0 };
  };
  return { ops, post };
}

describe("cast repo lease", () => {
  test("waits in line, runs the command under the lease, releases after it, and exits with its code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-lease-"));
    try {
      const s = server(1);
      const lines: string[] = [];
      // The command records which asks the server had seen when it ran: it ran held, before the release.
      const code = await runUnderLease({ post: s.post, repository: "o/r", holder: "merge on me", log: (l) => lines.push(l), pollMs: 1, cmd: ["sh", "-c", `echo ran > ${join(dir, "ran")}; exit 3`] });
      expect(code).toBe(3);
      expect(readFileSync(join(dir, "ran"), "utf-8").trim()).toBe("ran");
      expect(s.ops).toEqual(["take", "take", "release"]);
      expect(lines.some((l) => l.startsWith("waiting for the lease on o/r: 2nd in line behind the merge of PR #9 on host-2"))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("SIGTERM passes to the command and the lease is released; a command that cannot start exits 127, released", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-lease-"));
    const s = server();
    const signals = new EventEmitter();
    const started = join(dir, "started");
    const running = runUnderLease({ post: s.post, repository: "o/r", holder: "x", log: () => {}, signals, cmd: ["sh", "-c", `touch ${started}; exec sleep 30`] });
    await pollUntil(() => { try { readFileSync(started); return true; } catch { return false; } }, "the command started");
    signals.emit("SIGTERM");
    expect(await running).toBe(143);
    expect(s.ops).toEqual(["take", "release"]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    rmSync(dir, { recursive: true, force: true });

    const missing = server();
    expect(await runUnderLease({ post: missing.post, repository: "o/r", holder: "x", log: () => {}, cmd: ["no-such-command-anywhere"] })).toBe(127);
    expect(missing.ops).toEqual(["take", "release"]);
  });

  test("--team and --run go to the server as team_id and run_id", async () => {
    const bodies: Record<string, unknown>[] = [];
    const post = async (_p: string, body: Record<string, unknown>) => { bodies.push(body); return body.op === "release" ? { released: true } : { held: true, expires_at: 0 }; };
    expect(await runUnderLease({ post, repository: "o/r", holder: "x", log: () => {}, teamId: "teams_1", runId: "workflow_runs_1", cmd: ["sh", "-c", "exit 0"] })).toBe(0);
    expect(bodies.map((b) => [b.op, b.team_id, b.run_id])).toEqual([["take", "teams_1", "workflow_runs_1"], ["release", "teams_1", "workflow_runs_1"]]);
  });

  test("--wait: a line that outlasts it leaves the line and starts nothing, as a refused lease does", async () => {
    const s = server(Infinity);
    const started = Date.now();
    const err = await runUnderLease({ post: s.post, repository: "o/r", holder: "x", log: () => {}, waitMs: 30, pollMs: 5, cmd: ["sh", "-c", "exit 0"] }).then(() => null, (e: Error) => e);
    expect(err?.message).toStartWith("still waiting for the lease after 0m: 2nd in line behind the merge of PR #9 on host-2");
    expect(Date.now() - started).toBeLessThan(2000);
    // It gave its place up: the last ask leaves the line, and no command ran under a lease.
    expect(s.ops.at(-1)).toBe("release");
    expect(s.ops.filter((o) => o !== "take")).toEqual(["release"]);
  });

  // As the Merge station merges unleased: a workspace refused the repository, or a server with no lease, runs the
  // command without the lease, saying so once; --require keeps the refusal, and so does any other refusal.
  const unleasable = {
    "the server will not lease the repository to the workspace": "Run run_1 cannot lease o/r: neither its workspace nor any of your teams works on it.",
    "the server has no lease route": "this codecast server has no /cli/repo-lease route — it needs a newer deployment.",
  };
  for (const [why, refusal] of Object.entries(unleasable)) {
    test(`${why}: the command runs without the lease, saying so once, and exits with its code; --require refuses`, async () => {
      const refuse = async () => { throw new Error(refusal); };
      const said: string[] = [];
      expect(await runUnderLease({ post: refuse, repository: "o/r", holder: "x", log: (l) => said.push(l), cmd: ["sh", "-c", "exit 5"] })).toBe(5);
      expect(said).toEqual([`running without the repository's turn: ${refusal}`]);
      const strict = await runUnderLease({ post: refuse, repository: "o/r", holder: "x", log: () => {}, require: true, cmd: ["sh", "-c", "exit 0"] }).then(() => null, (e: Error) => e);
      expect(strict?.message).toBe(refusal);
    });
  }

  test("any other refusal of the lease still refuses, starting nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-lease-"));
    try {
      const refuse = async () => { throw new Error("No run run_1 you can lease a repository for."); };
      const err = await runUnderLease({ post: refuse, repository: "o/r", holder: "x", log: () => {}, cmd: ["sh", "-c", `touch ${join(dir, "ran")}`] }).then(() => null, (e: Error) => e);
      expect(err?.message).toBe("No run run_1 you can lease a repository for.");
      expect(() => readFileSync(join(dir, "ran"))).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a lease lost while the command runs is said loudly; with --strict the command is ended", async () => {
    // The renewal finds another holder: the lease went to the next in line while this one ran.
    const lostServer = () => {
      const ops: string[] = [];
      const post = async (_p: string, body: Record<string, unknown>) => {
        ops.push(String(body.op));
        if (body.op === "renew") return { held: false, holder: "the merge of PR #9 on host-2", since: 0, expires_at: 0 };
        return body.op === "release" ? { released: false } : { held: true, expires_at: 0 };
      };
      return { ops, post };
    };
    const loose = lostServer();
    const said: string[] = [];
    expect(await runUnderLease({ post: loose.post, repository: "o/r", holder: "x", log: (l) => said.push(l), renewMs: 5, cmd: ["sh", "-c", "sleep 0.3; exit 4"] })).toBe(4);
    expect(said.filter((l) => l.includes("was LOST"))).toEqual(["!! the lease on o/r was LOST while `sh -c sleep 0.3; exit 4` runs: another merge or deploy may now run beside it"]);
    const strict = lostServer();
    const started = Date.now();
    expect(await runUnderLease({ post: strict.post, repository: "o/r", holder: "x", log: () => {}, renewMs: 5, strict: true, cmd: ["sleep", "30"] })).toBe(143);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(strict.ops.at(-1)).toBe("release");
  });

  test("a SIGINT that comes during a take ends the wait at once, never after another poll", async () => {
    const ops: string[] = [];
    let answer: (v: unknown) => void = () => {};
    const post = (_p: string, body: Record<string, unknown>) => {
      ops.push(String(body.op));
      if (body.op === "release") return Promise.resolve({ released: false });
      return new Promise((res) => { answer = res; });
    };
    const signals = new EventEmitter();
    // A poll of a minute: a wait that sat through it would outlast the test.
    const running = runUnderLease({ post, repository: "o/r", holder: "x", log: () => {}, signals, pollMs: 60_000, cmd: ["sh", "-c", "exit 0"] });
    await pollUntil(() => ops.length === 1, "the take in flight");
    signals.emit("SIGINT");
    answer({ held: false, holder: "merge A", since: 0, position: 2 });
    expect(await running).toBe(130);
    expect(ops).toEqual(["take", "release"]);
  }, 5000);

  test("a SIGINT the command got from the terminal is not sent again; without a terminal it is passed on", async () => {
    const shared = server();
    const signals = new EventEmitter();
    const dir = mkdtempSync(join(tmpdir(), "repo-lease-"));
    const started = join(dir, "started");
    // The command finishes on its own (sleep exits 0): our SIGINT never reached it, which would have ended it at 130.
    const own = runUnderLease({ post: shared.post, repository: "o/r", holder: "x", log: () => {}, signals, forwardInt: false, cmd: ["sh", "-c", `touch ${started}; exec sleep 0.5`] });
    await pollUntil(() => { try { readFileSync(started); return true; } catch { return false; } }, "the command started");
    signals.emit("SIGINT");
    expect(await own).toBe(0);
    rmSync(started);
    const passed = runUnderLease({ post: server().post, repository: "o/r", holder: "x", log: () => {}, signals, forwardInt: true, cmd: ["sh", "-c", `touch ${started}; exec sleep 30`] });
    await pollUntil(() => { try { readFileSync(started); return true; } catch { return false; } }, "the command started");
    signals.emit("SIGINT");
    expect(await passed).toBe(130);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a command spawn refuses outright is reported as one that could not start, and the lease goes back", async () => {
    const s = server();
    const said: string[] = [];
    expect(await runUnderLease({ post: s.post, repository: "o/r", holder: "x", log: (l) => said.push(l), cmd: ["bad\u0000name"] })).toBe(127);
    expect(said.some((l) => l.startsWith("could not start bad"))).toBe(true);
    expect(s.ops).toEqual(["take", "release"]);
  });

  test("a signal while waiting in line leaves the line and starts nothing", async () => {
    const s = server(Infinity);
    const signals = new EventEmitter();
    const running = runUnderLease({ post: s.post, repository: "o/r", holder: "x", log: () => {}, signals, pollMs: 5, cmd: ["sh", "-c", "exit 0"] });
    await pollUntil(() => s.ops.length >= 2, "a wait in line");
    signals.emit("SIGINT");
    expect(await running).toBe(130);
    expect(s.ops.at(-1)).toBe("release");
    expect(s.ops.filter((o) => o !== "take")).toEqual(["release"]);
  });
});
