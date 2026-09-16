import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { indexHookClaims } from "./daemon.js";

// The hook claim index is on the delivery path (every inject asks whether the
// pane's pid still belongs to the session). The registry had grown to 11k
// files with nothing pruning it, and re-reading all of them each pass took
// longer than the pass's own TTL, so deliveries waited on it (2026-09-15).
const DAY = 24 * 60 * 60 * 1000;

function write(dir: string, name: string, body: unknown, ageMs: number, now: number): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, JSON.stringify(body));
  const t = new Date(now - ageMs);
  fs.utimesSync(full, t, t);
  return full;
}

describe("indexHookClaims", () => {
  test("prunes week-old files, skips stale and daemon-written ones, indexes hook claims by pid", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-registry-"));
    const now = Date.now();
    const dead = write(dir, "dead.json", { pid: 1, term: "iTerm", ts: 1 }, 8 * DAY, now);
    write(dir, "stale.json", { pid: 2, term: "iTerm", ts: 2 }, 3 * DAY, now);
    write(dir, "daemon.json", { pid: 3, ts: 3, src: "daemon" }, 0, now);
    write(dir, "live.json", { pid: 4, term: "iTerm", ts: 4, launch_token: "tok" }, 0, now);
    write(dir, "notes.txt", "x", 0, now);

    const { files, byPid, pruned } = await indexHookClaims(dir, new Map(), now);
    expect(pruned).toBe(1);
    expect(fs.existsSync(dead)).toBe(false);
    expect([...files.keys()].sort()).toEqual(["daemon.json", "live.json"]);
    expect(byPid.get(4)).toEqual([{ sessionId: "live", ts: 4, launchToken: "tok" }]);
    expect(byPid.has(3)).toBe(false);
    expect(byPid.has(2)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("reuses an entry whose mtime did not move instead of re-reading the file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-registry-"));
    const now = Date.now();
    const live = write(dir, "live.json", { pid: 4, term: "iTerm", ts: 4 }, 60_000, now);
    const first = await indexHookClaims(dir, new Map(), now);
    // Rewrite the body but keep the mtime: an unchanged mtime means no read.
    fs.writeFileSync(live, JSON.stringify({ pid: 9, term: "iTerm", ts: 9 }));
    const t = new Date(now - 60_000);
    fs.utimesSync(live, t, t);
    const second = await indexHookClaims(dir, first.files, now);
    expect(second.byPid.get(4)).toEqual([{ sessionId: "live", ts: 4 }]);
    expect(second.byPid.has(9)).toBe(false);
    // A moved mtime is read again.
    fs.utimesSync(live, new Date(now), new Date(now));
    const third = await indexHookClaims(dir, second.files, now);
    expect(third.byPid.get(9)).toEqual([{ sessionId: "live", ts: 9 }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
