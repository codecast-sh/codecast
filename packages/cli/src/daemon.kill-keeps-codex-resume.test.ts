// A kill must leave a Codex thread resumable. The saved app-server record is the
// only handle a later delivery can resume the thread from: a message queued after
// the kill revives the conversation on the server, and delivery demands a resume
// from that record. Erasing it on kill left four killed Codex threads with
// receipts that retried every 5 minutes forever (228 retries, 2026-11-11).

import { expect, test } from "bun:test";
import fs from "node:fs";
import { functionBlock } from "./test-helpers/sourceRegion.js";
import { settledCodexRecord, type PersistedCodexThread } from "./codexTurnRecovery.js";

const source = fs.readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");

test("kill tears down with the Codex record kept", () => {
  const kill = functionBlock(source, "killConversationBackends").text;
  expect(kill).toMatch(/teardownConversationBackendsLive\([^)]*keepCodexResume: true/);
  const live = functionBlock(source, "teardownConversationBackendsLive").text;
  expect(live).toContain("forgetPersisted: opts.keepCodexResume ? settlePersistedAppServerConversation : forgetPersistedAppServerConversation");
});

test("settling keeps the thread and drops only the in-flight turn", () => {
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(functionBlock(source, "settlePersistedAppServerConversation").text);
  const persistedAppServerThreads = new Map<string, PersistedCodexThread>();
  const appServerRecoveryRetryAt = new Map<string, number>([["conv", 1]]);
  let writes = 0;
  const settle = new Function(
    "persistedAppServerThreads", "appServerRecoveryRetryAt", "settledCodexRecord", "persistAppServerThreadRegistrations",
    `${code}; return settlePersistedAppServerConversation;`,
  )(persistedAppServerThreads, appServerRecoveryRetryAt, settledCodexRecord, () => { writes++; return true; }) as (c: string) => void;

  persistedAppServerThreads.set("conv", { threadId: "thread", updatedAt: 1, cwd: "/p", activeTurnId: "turn", recoveryAttempts: 2 } as PersistedCodexThread);
  settle("conv");
  expect(persistedAppServerThreads.get("conv")).toMatchObject({ threadId: "thread", cwd: "/p", activeTurnId: undefined, recoveryAttempts: undefined });
  expect(appServerRecoveryRetryAt.has("conv")).toBe(false);
  expect(writes).toBe(1);

  settle("missing");
  expect(persistedAppServerThreads.has("missing")).toBe(false);
});
