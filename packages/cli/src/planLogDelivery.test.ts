import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deliverPlanLog, formatLogEntries, NO_LOG_RECHECK_MS } from "./planLogDelivery.js";

let reply: any = { entries: [] };
let status = 200;
const calls: any[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    calls.push(structuredClone(await req.json()));
    return new Response(JSON.stringify(reply), { status, headers: { "Content-Type": "application/json" } });
  },
});
afterAll(() => server.stop(true));

const deps = { getCliEndpoint: () => ({ siteUrl: `http://localhost:${server.port}`, apiToken: "tok" }) };
let stateDir = "";
let printed: string[] = [];
const run = (o: Partial<Parameters<typeof deliverPlanLog>[1]> = {}) =>
  deliverPlanLog(deps, { command: "task", json: false, sessionId: "s1", stateDir, print: (t) => printed.push(t), ...o });

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-log-"));
  reply = { entries: [] };
  status = 200;
  calls.length = 0;
  printed = [];
});

describe("deliverPlanLog", () => {
  test("prints the new entries of a shared-log plan under the command's output", async () => {
    reply = {
      plan_short_id: "pl-7",
      entries: [
        { type: "fact", content: "the cache key ignores locale", author: "w2", timestamp: 1 },
        { type: "interface", content: "renaming parseX to parse\nin src/a.ts", timestamp: 2 },
      ],
    };
    await run();
    expect(calls).toEqual([{ api_token: "tok", session_id: "s1" }]);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("shared log of pl-7, 2 new:");
    expect(printed[0]).toContain("[fact] w2: the cache key ignores locale");
    expect(printed[0]).toContain("[interface] renaming parseX to parse\n  in src/a.ts");
  });

  test("prints nothing when nothing is new", async () => {
    reply = { plan_short_id: "pl-7", entries: [] };
    await run();
    expect(calls).toHaveLength(1);
    expect(printed).toEqual([]);
  });

  test("a person's shell, a --json command and the daemon's own commands never ask", async () => {
    await run({ sessionId: null });
    await run({ json: true });
    for (const command of ["daemon", "stable-context", "_watchdog"]) await run({ command });
    expect(calls).toEqual([]);
  });

  test("a session with no shared-log plan is not asked again for a while, except by a plan command", async () => {
    const t = Date.now();
    await run({ now: t });
    await run({ now: t + 1000 });
    expect(calls).toHaveLength(1);
    await run({ command: "plan", now: t + 1000 });
    expect(calls).toHaveLength(2);
    await run({ now: t + NO_LOG_RECHECK_MS + 1000 });
    expect(calls).toHaveLength(3);
  });

  test("a failing server is silent", async () => {
    status = 500;
    reply = { error: "boom" };
    await run();
    expect(printed).toEqual([]);
  });
});

test("formatLogEntries names each entry's kind", () => {
  expect(formatLogEntries(undefined, [{ type: "fail", content: "retry loop", timestamp: 1 }])).toContain("[fail] retry loop");
});

test("formatLogEntries names the writing session, so one person's agents can be told apart", () => {
  expect(formatLogEntries(undefined, [{ type: "fail", content: "retry loop", author: "Ana", session: "c-12", title: "Fix the cap", timestamp: 1 }]))
    .toContain('[fail] Ana, session c-12, "Fix the cap": retry loop');
});

test("formatLogEntries escapes another agent's control characters", () => {
  const out = formatLogEntries(undefined, [{ type: "fact", content: "ok\u001b[2Jwiped", author: "w\u001b[31m2", timestamp: 1 }]);
  expect(out).not.toContain("\u001b[2J");
  expect(out).not.toContain("\u001b[31m");
});
