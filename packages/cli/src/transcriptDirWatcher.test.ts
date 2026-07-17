// Cluster 7 (ct-39077): CodexWatcher and GeminiWatcher collapsed into the one
// configurable TranscriptDirWatcher. These tests (1) prove the codex/gemini configs
// reproduce the OLD watchers' base path, filter, scan predicate, session-id
// extraction, projectHash, depth, and debounce exactly, and (2) exercise the shared
// machinery end-to-end per client (the old codexWatcher.test.ts case, plus gemini).
import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AGENT_CLIENTS } from "@codecast/shared/contracts";
import {
  TranscriptDirWatcher,
  transcriptDirWatcherConfig,
  expandTranscriptRoot,
  encodePiCwdSlug,
  decodePiCwdSlug,
  type TranscriptDirEvent,
} from "./transcriptDirWatcher.js";

// ── Oracles: the OLD per-watcher predicates, verbatim ───────────────────────
const oldCodex = {
  basePath: () => path.join(process.env.HOME || "", ".codex", "sessions"),
  watchFilter: (rel: string) => rel.endsWith(".jsonl"),
  scanMatch: (_dir: string, name: string) => name.endsWith(".jsonl"),
  extractSessionId: (filePath: string) => {
    const filename = path.basename(filePath, ".jsonl");
    const match = filename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    return match ? match[1] : filename;
  },
  maxDepth: 4,
  debounceMs: 100,
};
const oldGemini = {
  basePath: () => path.join(process.env.HOME || "", ".gemini", "tmp"),
  watchFilter: (rel: string) => rel.endsWith(".json") && (rel.includes(`chats${path.sep}`) || rel.includes("chats/")),
  scanMatch: (dir: string, name: string) => name.endsWith(".json") && dir.endsWith("/chats"),
  extractSessionId: (filePath: string) => path.basename(filePath, ".json"),
  extractProjectHash: (filePath: string) => {
    const parts = filePath.split(path.sep);
    const chatsIdx = parts.lastIndexOf("chats");
    return chatsIdx > 0 ? parts[chatsIdx - 1] : "";
  },
  debounceMs: 200,
};

describe("transcriptDirWatcherConfig — codex config matches the old CodexWatcher", () => {
  const cfg = transcriptDirWatcherConfig("codex");
  test("base path from the registry descriptor equals the old default", () => {
    expect(cfg.basePath).toBe(oldCodex.basePath());
    expect(cfg.basePath).toBe(expandTranscriptRoot(AGENT_CLIENTS.codex.transcriptRoots[0]));
  });
  test("watch filter matches on .jsonl only", () => {
    for (const rel of ["a.jsonl", "x/y/z.jsonl", "a.json", "a.txt", "", "chats/a.jsonl"]) {
      expect(cfg.watchFilter(rel)).toBe(oldCodex.watchFilter(rel));
    }
  });
  test("scan predicate matches on .jsonl regardless of dir", () => {
    for (const [dir, name] of [["/x", "a.jsonl"], ["/x/chats", "a.json"], ["/x", "b.txt"]] as [string, string][]) {
      expect(cfg.scanMatch(dir, name)).toBe(oldCodex.scanMatch(dir, name));
    }
  });
  test("session-id extraction (UUID suffix, else filename)", () => {
    for (const fp of [
      "/r/2026/02/25/cc-import-12345678-1234-1234-1234-123456789abc.jsonl",
      "/r/rollout-2026.jsonl",
      "/r/12345678-1234-1234-1234-123456789abc.jsonl",
    ]) {
      expect(cfg.extractSessionId(fp)).toBe(oldCodex.extractSessionId(fp));
    }
  });
  test("depth cap and debounce match", () => {
    expect(cfg.maxDepth).toBe(oldCodex.maxDepth);
    expect(cfg.debounceMs).toBe(oldCodex.debounceMs);
    expect(cfg.extractProjectHash).toBeUndefined();
  });
});

describe("transcriptDirWatcherConfig — gemini config matches the old GeminiWatcher", () => {
  const cfg = transcriptDirWatcherConfig("gemini");
  test("base path from the registry descriptor equals the old default", () => {
    expect(cfg.basePath).toBe(oldGemini.basePath());
    expect(cfg.basePath).toBe(expandTranscriptRoot(AGENT_CLIENTS.gemini.transcriptRoots[0]));
  });
  test("watch filter requires .json under a chats path", () => {
    for (const rel of [`ph/chats${path.sep}a.json`, "chats/a.json", "a.json", "ph/chats/a.jsonl", "ph/other/a.json"]) {
      expect(cfg.watchFilter(rel)).toBe(oldGemini.watchFilter(rel));
    }
  });
  test("scan predicate requires .json in a dir ending /chats", () => {
    for (const [dir, name] of [["/x/ph/chats", "a.json"], ["/x/ph", "a.json"], ["/x/ph/chats", "a.jsonl"]] as [string, string][]) {
      expect(cfg.scanMatch(dir, name)).toBe(oldGemini.scanMatch(dir, name));
    }
  });
  test("session-id extraction is the bare filename", () => {
    for (const fp of ["/r/ph/chats/session-abcd1234.json", "/r/ph/chats/whatever.json"]) {
      expect(cfg.extractSessionId(fp)).toBe(oldGemini.extractSessionId(fp));
    }
  });
  test("projectHash is the segment before chats", () => {
    for (const fp of ["/r/myproj/chats/s.json", "/nochats/s.json", "/a/b/chats/s.json"]) {
      expect(cfg.extractProjectHash!(fp)).toBe(oldGemini.extractProjectHash(fp));
    }
  });
  test("debounce matches and no depth cap", () => {
    expect(cfg.debounceMs).toBe(oldGemini.debounceMs);
    expect(cfg.maxDepth).toBeUndefined();
  });
});

function waitForSessionEvent(
  watcher: TranscriptDirWatcher,
  predicate: (event: TranscriptDirEvent) => boolean,
  timeoutMs = 5000,
): Promise<TranscriptDirEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.off("session", onSession);
      reject(new Error("Timed out waiting for session event"));
    }, timeoutMs);
    const onSession = (event: TranscriptDirEvent) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      watcher.off("session", onSession);
      resolve(event);
    };
    watcher.on("session", onSession);
  });
}

describe("TranscriptDirWatcher — live behavior via the codex config", () => {
  test("emits add and change events under nested dated session dirs, extracting the UUID", async () => {
    const root = path.join(os.tmpdir(), `.codex-watcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const sessionId = "12345678-1234-1234-1234-123456789abc";
    const filePath = path.join(root, "2026", "02", "25", `cc-import-${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const watcher = new TranscriptDirWatcher(transcriptDirWatcherConfig("codex", root));
    watcher.start();
    await new Promise((r) => setTimeout(r, 200));

    const addPromise = waitForSessionEvent(watcher, (e) => e.filePath === filePath);
    fs.writeFileSync(filePath, '{"type":"response_item"}\n');
    const addEvent = await addPromise;
    expect(addEvent.sessionId).toBe(sessionId);

    const changePromise = waitForSessionEvent(watcher, (e) => e.filePath === filePath);
    fs.appendFileSync(filePath, '{"type":"response_item"}\n');
    const changeEvent = await changePromise;
    expect(changeEvent.sessionId).toBe(sessionId);

    watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("TranscriptDirWatcher — live behavior via the gemini config", () => {
  test("emits a session under a project chats dir with projectHash and filename id", async () => {
    const root = path.join(os.tmpdir(), `.gemini-watcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const projectHash = "abc123hash";
    const filePath = path.join(root, projectHash, "chats", "session-deadbeef.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const watcher = new TranscriptDirWatcher(transcriptDirWatcherConfig("gemini", root));
    watcher.start();
    await new Promise((r) => setTimeout(r, 200));

    const addPromise = waitForSessionEvent(watcher, (e) => e.filePath === filePath);
    fs.writeFileSync(filePath, JSON.stringify({ sessionId: "session-deadbeef", messages: [] }));
    const addEvent = await addPromise;
    expect(addEvent.sessionId).toBe("session-deadbeef");
    expect(addEvent.projectHash).toBe(projectHash);

    watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── pi (ct-39080) ───────────────────────────────────────────────────────────
describe("transcriptDirWatcherConfig — pi config", () => {
  test("base path is ~/.pi/agent/sessions and files are *.jsonl", () => {
    const cfg = transcriptDirWatcherConfig("pi");
    expect(cfg.basePath).toBe(path.join(process.env.HOME || "", ".pi", "agent", "sessions"));
    expect(cfg.watchFilter("--Users-dev--/2026-03-03T14-40-34-973Z_" + "a7c9c0e2-1d82-4d42-b342-f59fefc7b9f5.jsonl")).toBe(true);
    expect(cfg.watchFilter("--Users-dev--/auth.json")).toBe(false);
    expect(cfg.scanMatch("--Users-dev--", "x.jsonl")).toBe(true);
    expect(cfg.maxDepth).toBe(2);
  });

  test("session id is the filename's trailing uuid (timestamp hyphens ignored)", () => {
    const cfg = transcriptDirWatcherConfig("pi");
    const file = "/root/--Users-dev--/2026-03-03T14-40-34-973Z_a7c9c0e2-1d82-4d42-b342-f59fefc7b9f5.jsonl";
    expect(cfg.extractSessionId(file)).toBe("a7c9c0e2-1d82-4d42-b342-f59fefc7b9f5");
  });
});

describe("pi cwd-slug encode/decode", () => {
  // Encoder verbatim to pi's session-manager rule; verified against REAL dir names.
  test("encodes real cwds to the exact on-disk dir names", () => {
    expect(encodePiCwdSlug("/Users/ashot")).toBe("--Users-ashot--");
    expect(encodePiCwdSlug("/Users/ashot/src/codecast")).toBe("--Users-ashot-src-codecast--");
    expect(encodePiCwdSlug("/private/tmp")).toBe("--private-tmp--");
  });

  test("round-trips paths that have no real dashes", () => {
    for (const cwd of ["/Users/ashot", "/Users/ashot/src/codecast", "/private/tmp", "/"]) {
      expect(decodePiCwdSlug(encodePiCwdSlug(cwd))).toBe(cwd);
    }
  });

  test("decodes real on-disk slugs back to their cwd", () => {
    expect(decodePiCwdSlug("--Users-ashot--")).toBe("/Users/ashot");
    expect(decodePiCwdSlug("--private-tmp--")).toBe("/private/tmp");
    expect(decodePiCwdSlug("----")).toBe("/");
  });

  test("is LOSSY on paths containing real dashes (documented — header cwd is authoritative)", () => {
    // /Users/dev/footage-app encodes the same as /Users/dev/footage/app, so the
    // decoder cannot recover the real dash. This is why processPiSession prefers the
    // session header's cwd over the slug.
    expect(encodePiCwdSlug("/Users/dev/footage-app")).toBe("--Users-dev-footage-app--");
    expect(decodePiCwdSlug("--Users-dev-footage-app--")).toBe("/Users/dev/footage/app");
  });
});

describe("TranscriptDirWatcher — live behavior via the pi config", () => {
  test("emits a session one dir deep under a cwd-slug, extracting the filename uuid", async () => {
    const root = path.join(os.tmpdir(), `.pi-watcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const sessionId = "a7c9c0e2-1d82-4d42-b342-f59fefc7b9f5";
    const filePath = path.join(root, "--Users-dev-src-demo--", `2026-03-03T14-40-34-973Z_${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const watcher = new TranscriptDirWatcher(transcriptDirWatcherConfig("pi", root));
    watcher.start();
    await new Promise((r) => setTimeout(r, 200));

    const addPromise = waitForSessionEvent(watcher, (e) => e.filePath === filePath);
    fs.writeFileSync(filePath, '{"type":"session","version":3,"id":"' + sessionId + '","cwd":"/Users/dev/src/demo"}\n');
    const addEvent = await addPromise;
    expect(addEvent.sessionId).toBe(sessionId);

    watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
