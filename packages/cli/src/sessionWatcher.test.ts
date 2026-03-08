import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionWatcher, type SessionEvent } from "./sessionWatcher.js";

function tmpDir(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

function waitForSessionEvent(
  watcher: SessionWatcher,
  predicate: (event: SessionEvent) => boolean,
  timeoutMs = 5000
): Promise<SessionEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.off("session", onSession);
      reject(new Error("Timed out waiting for session event"));
    }, timeoutMs);

    const onSession = (event: SessionEvent) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      watcher.off("session", onSession);
      resolve(event);
    };

    watcher.on("session", onSession);
  });
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups) {
    try { fn(); } catch {}
  }
  cleanups.length = 0;
});

describe("SessionWatcher", () => {
  test("detects new session file in project directory", async () => {
    const root = tmpDir("sw-new");
    const projectDir = path.join(root, "abc123hash");
    fs.mkdirSync(projectDir, { recursive: true });

    const watcher = new SessionWatcher(root);
    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });

    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    const sessionId = "test-session-001";
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);

    const eventPromise = waitForSessionEvent(
      watcher,
      (e) => e.sessionId === sessionId
    );

    fs.writeFileSync(filePath, '{"role":"user","content":"hello"}\n');
    const event = await eventPromise;

    expect(event.sessionId).toBe(sessionId);
    expect(event.projectPath).toBe("abc123hash");
    expect(event.filePath).toBe(filePath);
  });

  test("detects changes to existing session file", async () => {
    const root = tmpDir("sw-change");
    const projectDir = path.join(root, "projhash");
    fs.mkdirSync(projectDir, { recursive: true });

    const sessionId = "existing-session";
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, '{"role":"user","content":"first"}\n');

    const watcher = new SessionWatcher(root);
    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });

    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    const eventPromise = waitForSessionEvent(
      watcher,
      (e) => e.sessionId === sessionId
    );

    fs.appendFileSync(filePath, '{"role":"assistant","content":"reply"}\n');
    const event = await eventPromise;

    expect(event.sessionId).toBe(sessionId);
  });

  test("ignores non-jsonl files", async () => {
    const root = tmpDir("sw-ignore");
    const projectDir = path.join(root, "proj1");
    fs.mkdirSync(projectDir, { recursive: true });

    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher(root);
    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });

    watcher.on("session", (e) => events.push(e));
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    fs.writeFileSync(path.join(projectDir, "CLAUDE.md"), "# notes");
    fs.writeFileSync(path.join(projectDir, "config.json"), "{}");
    fs.writeFileSync(path.join(projectDir, "data.txt"), "data");

    await new Promise(r => setTimeout(r, 500));

    expect(events.length).toBe(0);
  });

  test("emits existing recent files on start sorted by mtime", async () => {
    const root = tmpDir("sw-existing");
    const projectDir = path.join(root, "proj1");
    fs.mkdirSync(projectDir, { recursive: true });

    const file1 = path.join(projectDir, "old-session.jsonl");
    const file2 = path.join(projectDir, "new-session.jsonl");
    fs.writeFileSync(file1, '{"msg": "old"}\n');
    const now = new Date();
    fs.utimesSync(file1, now, new Date(now.getTime() - 1000));
    fs.writeFileSync(file2, '{"msg": "new"}\n');

    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher(root);
    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });

    watcher.on("session", (e) => events.push(e));
    watcher.start();

    await new Promise(r => setTimeout(r, 100));

    expect(events.length).toBe(2);
    expect(events[0].sessionId).toBe("new-session");
    expect(events[1].sessionId).toBe("old-session");
  });

  test("stop prevents further events", async () => {
    const root = tmpDir("sw-stop");
    const projectDir = path.join(root, "proj1");
    fs.mkdirSync(projectDir, { recursive: true });

    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher(root);
    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });

    watcher.on("session", (e) => events.push(e));
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    watcher.stop();

    fs.writeFileSync(path.join(projectDir, "during-stop.jsonl"), "{}");
    await new Promise(r => setTimeout(r, 300));

    expect(events.filter(e => e.sessionId === "during-stop").length).toBe(0);
  });

  test("restart resumes watching", async () => {
    const root = tmpDir("sw-restart");
    const projectDir = path.join(root, "proj1");
    fs.mkdirSync(projectDir, { recursive: true });

    const watcher = new SessionWatcher(root);
    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });

    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    watcher.restart();
    await new Promise(r => setTimeout(r, 200));

    const eventPromise = waitForSessionEvent(
      watcher,
      (e) => e.sessionId === "after-restart"
    );
    fs.writeFileSync(path.join(projectDir, "after-restart.jsonl"), "{}");
    const event = await eventPromise;

    expect(event.sessionId).toBe("after-restart");
  });

  test("handles rapid file creation across multiple project dirs", async () => {
    const root = tmpDir("sw-rapid");
    fs.mkdirSync(root, { recursive: true });

    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher(root);
    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });

    watcher.on("session", (e) => events.push(e));
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    const sessionIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const projDir = path.join(root, `proj-${i}`);
      fs.mkdirSync(projDir, { recursive: true });
      const sid = `rapid-session-${i}`;
      sessionIds.push(sid);
      fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), `{"i": ${i}}\n`);
    }

    await new Promise(r => setTimeout(r, 1000));

    for (const sid of sessionIds) {
      expect(events.some(e => e.sessionId === sid)).toBe(true);
    }
  });

  test("does not start twice", () => {
    const root = tmpDir("sw-double-start");
    fs.mkdirSync(root, { recursive: true });

    const watcher = new SessionWatcher(root);
    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });

    watcher.start();
    watcher.start(); // should be no-op
    watcher.stop();
  });
});
