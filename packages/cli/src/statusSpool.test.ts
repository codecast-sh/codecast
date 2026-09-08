import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HookStatusGate } from "./hookStatusGate.js";
import { CODECAST_STATUS_HOOK } from "./statusHook.js";
import {
  SPOOL_EXT,
  SPOOL_MAX_BYTES,
  SPOOL_SKIPPED_STATUS,
  SPOOL_TTL_MS,
  appendStatusSpool,
  drainAllStatusSpools,
  drainStatusSpool,
  isSafeStatusSessionId,
  isSpoolableStatus,
  listStatusSpools,
  statusSpoolPath,
  sweepStatusSpools,
} from "./statusSpool.js";

type Status = { status: string; ts: number };

// HOME is what the hook script builds its paths from and CODECAST_DIR is what
// the rest of the CLI reads, so both point at scratch for the whole file: no
// test may touch the real ~/.codecast.
let home: string;
let statusDir: string;
let hookFile: string;
const priorEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-spool-"));
  statusDir = path.join(home, ".codecast", "agent-status");
  for (const k of ["HOME", "CODECAST_DIR"]) priorEnv[k] = process.env[k];
  process.env.HOME = home;
  process.env.CODECAST_DIR = path.join(home, ".codecast");
  hookFile = path.join(home, "codecast-status.sh");
  fs.writeFileSync(hookFile, CODECAST_STATUS_HOOK, { mode: 0o755 });
});

afterAll(() => {
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(statusDir, { recursive: true, force: true });
});

function runHook(payload: Record<string, unknown>): void {
  execFileSync("bash", [hookFile], { input: JSON.stringify(payload), env: { ...process.env, HOME: home } });
}

function spoolLines(sessionId: string): string[] {
  try {
    return fs.readFileSync(statusSpoolPath(statusDir, sessionId), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("status spool", () => {
  // The failure this replaces: the fallback overwrote one file per session, so
  // a burst while the handler was down collapsed to its last entry and a Stop
  // behind a later event was simply lost.
  test("a burst written while the handler is down drains in the order it happened", async () => {
    const burst: Status[] = [
      { status: "thinking", ts: 1 },
      { status: "permission_blocked", ts: 2 },
      { status: "thinking", ts: 3 },
      { status: "compacting", ts: 4 },
      { status: "idle", ts: 5 },
    ];
    for (const record of burst) await appendStatusSpool(statusDir, "burst-1", record);

    const drained = await drainStatusSpool<Status>(statusSpoolPath(statusDir, "burst-1"));
    expect(drained).toEqual(burst);
    // Truncated behind the drain, so the next one replays nothing twice.
    expect(await drainStatusSpool<Status>(statusSpoolPath(statusDir, "burst-1"))).toEqual([]);
  });

  test("a malformed line is skipped and the records behind it still replay", async () => {
    await appendStatusSpool(statusDir, "bad-1", { status: "thinking", ts: 1 });
    fs.appendFileSync(statusSpoolPath(statusDir, "bad-1"), "{not json\n");
    await appendStatusSpool(statusDir, "bad-1", { status: "idle", ts: 3 });

    expect(await drainStatusSpool<Status>(statusSpoolPath(statusDir, "bad-1"))).toEqual([
      { status: "thinking", ts: 1 },
      { status: "idle", ts: 3 },
    ]);
  });

  test("a half-written trailing line waits for the next drain", async () => {
    const file = statusSpoolPath(statusDir, "partial-1");
    await appendStatusSpool(statusDir, "partial-1", { status: "thinking", ts: 1 });
    fs.appendFileSync(file, '{"status":"idle","ts":2');

    expect(await drainStatusSpool<Status>(file)).toEqual([{ status: "thinking", ts: 1 }]);
    fs.appendFileSync(file, "}\n");
    expect(await drainStatusSpool<Status>(file)).toEqual([{ status: "idle", ts: 2 }]);
  });

  test("every session's spool drains, each in write order", async () => {
    await appendStatusSpool(statusDir, "sess-a", { status: "thinking", ts: 1 });
    await appendStatusSpool(statusDir, "sess-b", { status: "working", ts: 2 });
    await appendStatusSpool(statusDir, "sess-a", { status: "idle", ts: 3 });

    const all = await drainAllStatusSpools<Status>(statusDir);
    expect(all).toEqual([
      { sessionId: "sess-a", records: [{ status: "thinking", ts: 1 }, { status: "idle", ts: 3 }] },
      { sessionId: "sess-b", records: [{ status: "working", ts: 2 }] },
    ]);
  });

  test("a session id that could leave the directory writes nothing", async () => {
    await appendStatusSpool(statusDir, "../escape", { status: "idle", ts: 1 });
    expect(await listStatusSpools(statusDir)).toEqual([]);
  });

  test("a missing directory drains and sweeps to nothing", async () => {
    expect(await drainAllStatusSpools(path.join(home, "nope"))).toEqual([]);
    expect(await sweepStatusSpools(path.join(home, "nope"))).toEqual({ removed: [], trimmed: [] });
  });
});

describe("status spool retention", () => {
  test("the cap cuts an oversized spool back to whole lines of its newest bytes", async () => {
    const file = statusSpoolPath(statusDir, "big-1");
    fs.mkdirSync(statusDir, { recursive: true });
    // One long record per line, past the cap, then the newest record last.
    const filler = `${JSON.stringify({ status: "thinking", ts: 1, message: "x".repeat(4096) })}\n`;
    const lines = Math.ceil(SPOOL_MAX_BYTES / filler.length) + 8;
    fs.writeFileSync(file, filler.repeat(lines));
    fs.appendFileSync(file, `${JSON.stringify({ status: "idle", ts: 999 })}\n`);
    expect(fs.statSync(file).size).toBeGreaterThan(SPOOL_MAX_BYTES);

    expect((await sweepStatusSpools(statusDir)).trimmed).toEqual(["big-1"]);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(SPOOL_MAX_BYTES);

    // Whole lines only, and the newest record survived: a replay after an
    // overflow still sees the settle, having lost only the oldest history.
    const drained = await drainStatusSpool<Status>(file);
    expect(drained.length).toBeGreaterThan(0);
    expect(drained[drained.length - 1]).toEqual({ status: "idle", ts: 999 });
  });

  test("a spool nothing has written to for the TTL is removed; a fresh one is kept", async () => {
    await appendStatusSpool(statusDir, "old-1", { status: "idle", ts: 1 });
    await appendStatusSpool(statusDir, "new-1", { status: "idle", ts: 2 });
    const stale = new Date(Date.now() - SPOOL_TTL_MS - 60_000);
    fs.utimesSync(statusSpoolPath(statusDir, "old-1"), stale, stale);

    expect(await sweepStatusSpools(statusDir)).toEqual({ removed: ["old-1"], trimmed: [] });
    expect((await listStatusSpools(statusDir)).map((s) => s.sessionId)).toEqual(["new-1"]);
  });
});

describe("the hook's fallback write", () => {
  test("a burst with no daemon listening lands one line per event, in order", () => {
    runHook({ session_id: "hook-burst", hook_event_name: "UserPromptSubmit" });
    runHook({ session_id: "hook-burst", hook_event_name: "PreCompact" });
    runHook({ session_id: "hook-burst", hook_event_name: "Stop" });

    const statuses = spoolLines("hook-burst").map((l) => JSON.parse(l).status);
    expect(statuses).toEqual(["thinking", "compacting", "idle"]);
  });

  test("tool progress stays out of the spool and only the legacy file carries it", () => {
    runHook({ session_id: "hook-tools", hook_event_name: "PreToolUse", tool_name: "Bash" });
    runHook({ session_id: "hook-tools", hook_event_name: "PreToolUse", tool_name: "Read" });
    runHook({ session_id: "hook-tools", hook_event_name: "Stop" });

    expect(spoolLines("hook-tools").map((l) => JSON.parse(l).status)).toEqual(["idle"]);
    // Kept readable for one release: an older daemon reads only this file, and
    // a newer one replays it after the spool, where the ts guards dedupe it.
    const legacy = JSON.parse(fs.readFileSync(path.join(statusDir, "hook-tools.json"), "utf8"));
    expect(legacy.status).toBe("idle");
  });

  // The id comes from the hook payload and names both files. Before this, an
  // id of ../../target/evil wrote them wherever it pointed — the single status
  // file had that hole for as long as it has existed, and the spool inherited
  // it.
  test("a session id that climbs out of the status dir writes nothing, anywhere", () => {
    const escaped = path.join(home, "target");
    fs.mkdirSync(escaped, { recursive: true });
    runHook({ session_id: "../../target/evil", hook_event_name: "Stop" });

    expect(fs.readdirSync(escaped)).toEqual([]);
    expect(fs.existsSync(statusDir) ? fs.readdirSync(statusDir) : []).toEqual([]);
  });

  // The guard runs under whatever shell a machine points at the script, so it
  // uses only builtins every POSIX shell has: a case pattern and ${#var}.
  describe.each(["sh", "dash", "bash"])("its id guard under %s", (shell) => {
    const guard = CODECAST_STATUS_HOOK.slice(
      CODECAST_STATUS_HOOK.indexOf('case "$SESSION_ID" in'),
      CODECAST_STATUS_HOOK.indexOf('STATUS_DIR="$HOME'),
    );

    function accepts(sessionId: string): boolean {
      const script = path.join(home, `guard-${shell}.sh`);
      fs.writeFileSync(script, `SESSION_ID="$1"\n${guard}\nprintf accepted\n`);
      return execFileSync(shell, [script, sessionId], { encoding: "utf8" }) === "accepted";
    }

    test("takes exactly the ids the daemon takes", () => {
      const ids = [
        "b3c1f0e2-1234-4a5b-8c9d-0123456789ab",
        "a",
        "A_b-c.d",
        "-",
        "x".repeat(128),
        "",
        "../../target/evil",
        "..",
        ".hidden",
        "a/b",
        "a b",
        "x".repeat(129),
        "évil",
      ];
      for (const id of ids) expect([id, accepts(id)]).toEqual([id, isSafeStatusSessionId(id)]);
    });
  });

  test("the guard runs before either path is built", () => {
    const guardAt = CODECAST_STATUS_HOOK.indexOf('case "$SESSION_ID" in');
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(CODECAST_STATUS_HOOK.indexOf('STATUS_DIR="$HOME'));
    expect(guardAt).toBeLessThan(CODECAST_STATUS_HOOK.indexOf("$SESSION_ID.json"));
    expect(guardAt).toBeLessThan(CODECAST_STATUS_HOOK.indexOf(`$SESSION_ID${SPOOL_EXT}`));
  });

  test("the shell's skip rule is the same one the daemon applies", () => {
    expect(isSpoolableStatus(SPOOL_SKIPPED_STATUS)).toBe(false);
    expect(isSpoolableStatus("idle")).toBe(true);
    expect(CODECAST_STATUS_HOOK).toContain(`"$STATUS" != "${SPOOL_SKIPPED_STATUS}"`);
    expect(CODECAST_STATUS_HOOK).toContain(`>> "$STATUS_DIR/$SESSION_ID${SPOOL_EXT}"`);
  });
});

describe("the boot gate's deferral", () => {
  // The gate defers to the same spool, so a status pushed during the boot
  // window replays with the ones the hook wrote itself.
  test("a burst deferred before the sink registers replays in order afterwards", async () => {
    // One chain for every deferral, as queueAgentStatusSpoolAppend does: two
    // statuses for a session have to land in the order they arrived.
    let chain: Promise<void> = Promise.resolve();
    const gate = new HookStatusGate<Status>((sessionId, data) => {
      chain = chain.then(() => appendStatusSpool(statusDir, sessionId, data));
    });
    const burst: Status[] = [
      { status: "thinking", ts: 10 },
      { status: "permission_blocked", ts: 11 },
      { status: "idle", ts: 12 },
    ];
    for (const record of burst) expect(gate.deliver("gate-1", record)).toBe("deferred");

    await chain;
    expect(await drainStatusSpool<Status>(statusSpoolPath(statusDir, "gate-1"))).toEqual(burst);
  });

  test("the daemon defers to the spool and drains it at boot, on the watcher and on the sweep", () => {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "daemon.ts"), "utf8");
    // The gate's defer writes both files: the spool for the order, the legacy
    // single-status file for a daemon from before the spool.
    const defer = src.slice(src.indexOf("new HookStatusGate<HookStatusData>"), src.indexOf("export function setHookStatusSink"));
    expect(defer).toContain("queueAgentStatusWrite(");
    expect(defer).toContain("queueAgentStatusSpoolAppend(");
    const main = src.indexOf("async function main(");
    // Boot: the spools replay before the single-status files, and before the
    // handler the gate has been deferring for registers.
    const bootReplay = src.indexOf("drainAllStatusSpools<HookStatusData>(AGENT_STATUS_DIR)", main);
    expect(bootReplay).toBeGreaterThan(0);
    expect(bootReplay).toBeLessThan(src.indexOf("readAgentStatusFiles().then(", main));
    expect(bootReplay).toBeLessThan(src.indexOf("setHookStatusSink(", main));
    // Watcher: a .jsonl event drains that spool through handleStatusData, the
    // same funnel a pushed status goes through.
    expect(src.slice(main)).toContain("if (filePath.endsWith(SPOOL_EXT)) { handleStatusSpoolFile(filePath); return; }");
    expect(src.slice(main)).toContain("sweepStatusSpools(AGENT_STATUS_DIR)");
  });
});
