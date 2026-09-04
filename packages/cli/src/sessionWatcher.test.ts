import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionWatcher, isTestProjectDir, isWorkflowAgentTranscript, watchFilter, watchDirFilter, type SessionEvent } from "./sessionWatcher.js";
import { RecursiveWatcher } from "./recursiveWatcher.js";

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

    await watcher.start();
    await watcher.whenPrimed();

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

    await watcher.start();
    await watcher.whenPrimed();

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
    await watcher.start();
    await watcher.whenPrimed();

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
    await watcher.start();

    await watcher.whenPrimed();

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
    await watcher.start();
    await watcher.whenPrimed();

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

    await watcher.start();
    await watcher.whenPrimed();

    await watcher.restart();
    await watcher.whenPrimed();

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
    await watcher.start();
    await watcher.whenPrimed();

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

  test("skips JSONL files in test-harness project dirs", async () => {
    const root = tmpDir("sw-test-skip");
    const realProj = path.join(root, "real-project");
    const harnessProj = path.join(root, "-private-tmp-codecast-test-cwd-ABC123");
    const shimProj = path.join(root, "-private-tmp-codecast-fake-claude-XYZ");
    fs.mkdirSync(realProj, { recursive: true });
    fs.mkdirSync(harnessProj, { recursive: true });
    fs.mkdirSync(shimProj, { recursive: true });

    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher(root);
    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });

    watcher.on("session", (e) => events.push(e));
    await watcher.start();
    await watcher.whenPrimed();

    fs.writeFileSync(path.join(realProj, "real-session.jsonl"), "{}");
    fs.writeFileSync(path.join(harnessProj, "harness-session.jsonl"), "{}");
    fs.writeFileSync(path.join(shimProj, "shim-session.jsonl"), "{}");

    await new Promise(r => setTimeout(r, 500));

    expect(events.map(e => e.sessionId).sort()).toEqual(["real-session"]);
  });

  test("isTestProjectDir matches harness markers", () => {
    expect(isTestProjectDir("-private-tmp-codecast-test-cwd-D1V9e5")).toBe(true);
    expect(isTestProjectDir("-tmp-codecast-fake-claude-AbC")).toBe(true);
    expect(isTestProjectDir("-Users-ashot-src-codecast")).toBe(false);
    expect(isTestProjectDir("real-project-abc123")).toBe(false);
  });

  test("watchFilter matches workflow agent transcripts, not their neighbors", () => {
    const wfDir = ["proj", "sess-uuid", "subagents", "workflows", "wf_8300ef22-6b5"].join(path.sep);
    expect(isWorkflowAgentTranscript(`${wfDir}${path.sep}agent-af865cb759119c484.jsonl`)).toBe(true);
    expect(watchFilter(`${wfDir}${path.sep}agent-af865cb759119c484.jsonl`)).toBe(true);
    // The runtime's run journal sits alongside agent transcripts — not a session.
    expect(watchFilter(`${wfDir}${path.sep}journal.jsonl`)).toBe(false);
    // Task-tool subagents (historical depth) still match via the plain .jsonl rule.
    expect(watchFilter(["proj", "sess-uuid", "subagents", "agent-abc.jsonl"].join(path.sep))).toBe(true);
    // Top-level transcripts and workflow snapshots unchanged.
    expect(watchFilter(["proj", "sess-uuid.jsonl"].join(path.sep))).toBe(true);
    expect(watchFilter(["proj", "sess-uuid", "workflows", "wf_x.json"].join(path.sep))).toBe(true);
    // A stray deep .jsonl that matches no known shape stays excluded.
    expect(watchFilter(["proj", "sess-uuid", "tool-results", "deep", "deeper", "x.jsonl"].join(path.sep))).toBe(false);
  });

  test("emits workflow agent transcripts as sessions, skips the run journal", async () => {
    const root = tmpDir("sw-wf-agent");
    const wfDir = path.join(root, "proj1", "6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b", "subagents", "workflows", "wf_run123");
    fs.mkdirSync(wfDir, { recursive: true });

    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher(root);
    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });

    watcher.on("session", (e) => events.push(e));
    await watcher.start();
    await watcher.whenPrimed();

    const eventPromise = waitForSessionEvent(watcher, (e) => e.sessionId === "agent-a1b2c3");
    fs.writeFileSync(path.join(wfDir, "agent-a1b2c3.jsonl"), '{"role":"user","content":"go"}\n');
    fs.writeFileSync(path.join(wfDir, "journal.jsonl"), '{"agent":"a1b2c3"}\n');

    const event = await eventPromise;
    expect(event.sessionId).toBe("agent-a1b2c3");
    expect(event.projectPath).toBe("proj1");
    expect(event.workflowRunId).toBeUndefined();

    await new Promise(r => setTimeout(r, 300));
    expect(events.some(e => e.filePath.endsWith("journal.jsonl"))).toBe(false);
  });

  test("does not start twice", async () => {
    const root = tmpDir("sw-double-start");
    fs.mkdirSync(root, { recursive: true });

    const watcher = new SessionWatcher(root);
    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });

    await watcher.start();
    await watcher.start(); // should be no-op
    watcher.stop();
  });

  const UUID = "6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";

  test("start() resolves only after the existing recent files were emitted", async () => {
    const root = tmpDir("sw-primed");
    const projectDir = path.join(root, "projhash");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "s1.jsonl"), "{}\n");
    fs.writeFileSync(path.join(projectDir, "s2.jsonl"), "{}\n");

    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher(root);
    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.on("session", (e) => events.push(e));
    await watcher.start();
    expect(events.map((e) => e.sessionId).sort()).toEqual(["s1", "s2"]);
    // A second start() is a no-op that still answers with the primed promise.
    await watcher.start();
    await watcher.whenPrimed();
  });

  test("priming never opens tool-results or memory dirs, and still finds workflow agent transcripts", async () => {
    const root = tmpDir("sw-dirfilter");
    const sess = path.join(root, "slug", UUID);
    fs.mkdirSync(path.join(sess, "tool-results"), { recursive: true });
    fs.mkdirSync(path.join(root, "slug", "memory"), { recursive: true });
    fs.mkdirSync(path.join(sess, "subagents", "workflows", "wf_1"), { recursive: true });
    fs.writeFileSync(path.join(sess, "tool-results", "x.jsonl"), "{}\n");
    fs.writeFileSync(path.join(root, "slug", "memory", "x.jsonl"), "{}\n");
    fs.writeFileSync(path.join(sess, "subagents", "workflows", "wf_1", "agent-a.jsonl"), "{}\n");
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    // The wrapper hides the walk, so probe the same RecursiveWatcher shape the
    // wrapper builds: every file the walk stats names the dir it had to read.
    const visited: string[] = [];
    const probe = new RecursiveWatcher({
      path: root,
      filter: (rel) => { visited.push(path.dirname(rel)); return watchFilter(rel); },
      dirFilter: watchDirFilter,
      maxDepth: 6,
      callback: () => {},
    });
    cleanups.push(() => probe.stop());
    probe.start();
    await probe.whenPrimed();
    probe.stop();
    expect(visited.some((d) => d.split(path.sep).includes("tool-results"))).toBe(false);
    expect(visited.some((d) => d.split(path.sep).includes("memory"))).toBe(false);

    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher(root);
    cleanups.push(() => watcher.stop());
    watcher.on("session", (e) => events.push(e));
    await watcher.start();
    expect(events.map((e) => e.sessionId)).toEqual(["agent-a"]);
  });

  test("watchDirFilter admits exactly the dirs that can hold a syncable file", () => {
    const j = (...p: string[]) => p.join(path.sep);
    expect(watchDirFilter("any-slug")).toBe(true);
    expect(watchDirFilter(j("slug", UUID))).toBe(true);
    expect(watchDirFilter(j("slug", "memory"))).toBe(false);
    expect(watchDirFilter(j("slug", ".timelines"))).toBe(false);
    expect(watchDirFilter(j("slug", UUID, "subagents"))).toBe(true);
    expect(watchDirFilter(j("slug", UUID, "workflows"))).toBe(true);
    expect(watchDirFilter(j("slug", UUID, "tool-results"))).toBe(false);
    expect(watchDirFilter(j("slug", UUID, "session-memory"))).toBe(false);
    expect(watchDirFilter(j("slug", UUID, "subagents", "workflows"))).toBe(true);
    expect(watchDirFilter(j("slug", UUID, "subagents", "other"))).toBe(false);
    expect(watchDirFilter(j("slug", UUID, "workflows", "wf_1"))).toBe(false);
    expect(watchDirFilter(j("slug", UUID, "subagents", "workflows", "wf_1"))).toBe(true);
    expect(watchDirFilter(j("slug", UUID, "subagents", "workflows", "other"))).toBe(false);
    expect(watchDirFilter(j("slug", UUID, "subagents", "workflows", "wf_1", "deeper"))).toBe(false);
  });
});
