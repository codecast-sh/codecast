import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CodexWatcher, type CodexSessionEvent } from "./codexWatcher.js";

function waitForReady(watcher: CodexWatcher, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for watcher ready")), timeoutMs);
    watcher.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function waitForSessionEvent(
  watcher: CodexWatcher,
  predicate: (event: CodexSessionEvent) => boolean,
  timeoutMs = 3000
): Promise<CodexSessionEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.off("session", onSession);
      reject(new Error("Timed out waiting for session event"));
    }, timeoutMs);

    const onSession = (event: CodexSessionEvent) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      watcher.off("session", onSession);
      resolve(event);
    };

    watcher.on("session", onSession);
  });
}

describe("CodexWatcher", () => {
  test("emits add and change events under hidden session directories", async () => {
    const root = path.join(
      os.tmpdir(),
      `.codex-watcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    const sessionId = "12345678-1234-1234-1234-123456789abc";
    const filePath = path.join(root, "2026", "02", "25", `cc-import-${sessionId}.jsonl`);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const watcher = new CodexWatcher(root);
    watcher.start();
    await waitForReady(watcher);

    const addPromise = waitForSessionEvent(
      watcher,
      (event) => event.eventType === "add" && event.filePath === filePath
    );
    fs.writeFileSync(filePath, "{\"type\":\"response_item\"}\n");
    const addEvent = await addPromise;
    expect(addEvent.sessionId).toBe(sessionId);

    const changePromise = waitForSessionEvent(
      watcher,
      (event) => event.eventType === "change" && event.filePath === filePath
    );
    fs.appendFileSync(filePath, "{\"type\":\"response_item\"}\n");
    const changeEvent = await changePromise;
    expect(changeEvent.sessionId).toBe(sessionId);

    watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
