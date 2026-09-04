// /hook/status is an unauthenticated loopback route, and both of its status
// paths build a file name out of the session id the caller sent: the gate's
// deferred write during boot, and persistHookStatus once the handler is up.
// Without a check on the id, `session_id=../config` writes over
// ~/.codecast/config.json. The route rejects a bad id before either path runs.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isSafeStatusSessionId } from "./daemon.js";

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.ts"), "utf8");

describe("hook status session ids", () => {
  test("accepts the ids real callers send", () => {
    for (const id of [
      "9f8c1e2a-4b6d-4f31-9c0a-1b2c3d4e5f60",
      "session_123",
      "a",
      "cast-term-1.2",
      "A".repeat(128),
    ]) {
      expect(isSafeStatusSessionId(id), id).toBe(true);
    }
  });

  test("rejects anything that could name a file outside the status directory", () => {
    for (const id of [
      "../config",
      "..",
      ".",
      "../../.ssh/id_rsa",
      "a/b",
      "a\\b",
      ".hidden",
      "",
      "a b",
      "a\tb",
      "a\nb",
      "a\u0000b",
      "A".repeat(129),
    ]) {
      expect(isSafeStatusSessionId(id), JSON.stringify(id)).toBe(false);
    }
  });

  // The predicate only helps where it is called. Both writes are downstream of
  // this one branch, so the guard is that the branch still runs the check.
  test("the route checks the id before it delivers a status", () => {
    const routeAt = src.indexOf('req.url?.startsWith("/hook/status")');
    expect(routeAt).toBeGreaterThan(-1);
    const checkAt = src.indexOf("isSafeStatusSessionId(sessionId)", routeAt);
    const deliverAt = src.indexOf("hookStatusGate.deliver(sessionId", routeAt);
    expect(checkAt).toBeGreaterThan(routeAt);
    expect(deliverAt).toBeGreaterThan(checkAt);
  });

  // The gate's deferred write and the handler's persisted write are both live
  // during the boot window, for the same session and the same path. One
  // ordered writer is what keeps a Stop from landing before the PostToolUse
  // that preceded it, and keeps two writes off one file.
  test("one ordered writer owns the agent status directory", () => {
    const writes = src.match(/writeFile\(path\.join\(AGENT_STATUS_DIR/g) ?? [];
    expect(writes.length, "every agent status write goes through queueAgentStatusWrite").toBe(1);
    const chainAt = src.indexOf("agentStatusWriteChain = agentStatusWriteChain");
    expect(chainAt).toBeGreaterThan(-1);
    expect(src.indexOf("writeFile(path.join(AGENT_STATUS_DIR")).toBeGreaterThan(chainAt);
  });
});
