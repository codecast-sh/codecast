import { describe, test, expect } from "bun:test";
import { SessionWatcher } from "./sessionWatcher.js";

describe("SessionWatcher", () => {
  test("extracts project path from file path", () => {
    const watcher = new SessionWatcher();
    const extractProjectPath = (watcher as any).extractProjectPath.bind(watcher);

    expect(extractProjectPath("/Users/someone/.claude/projects/-Users-john-secret-project/session.jsonl"))
      .toBe("/Users/john/secret/project");

    expect(extractProjectPath("/Users/someone/.claude/projects/-Users-ashot-src-share-code-chat/abc123.jsonl"))
      .toBe("/Users/ashot/src/share/code/chat");
  });
});
