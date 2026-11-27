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
