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
  agentSessionFromTranscriptPath,
  expandTranscriptRoot,
  encodePiCwdSlug,
  decodePiCwdSlug,
  encodeGrokCwdSlug,
  decodeGrokCwdSlug,
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
  test("watch filter requires .json under a chats path segment", () => {
    for (const rel of [`ph/chats${path.sep}a.json`, "chats/a.json", "a.json", "ph/chats/a.jsonl", "ph/other/a.json"]) {
      expect(cfg.watchFilter(rel)).toBe(oldGemini.watchFilter(rel));
    }
    expect(cfg.watchFilter("ph/not-chats/a.json")).toBe(false);
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
  test("debounce matches; the depth cap stops at <hash>/chats/<id>.json", () => {
    expect(cfg.debounceMs).toBe(oldGemini.debounceMs);
    expect(cfg.maxDepth).toBe(3);
  });
});

// Each watcher's dirFilter admits only directories that can hold a transcript,
// so priming and every rescan skip the sibling trees the client keeps next to
// its sessions.
describe("transcriptDirWatcherConfig: dirFilter per client", () => {
  const j = (...parts: string[]) => parts.join(path.sep);
  test("codex enters only dated YYYY/MM/DD dirs", () => {
    const f = transcriptDirWatcherConfig("codex").dirFilter!;
    expect(f("2026")).toBe(true);
    expect(f(j("2026", "02"))).toBe(true);
    expect(f(j("2026", "02", "25"))).toBe(true);
    expect(f("watcher-test-1772041030215")).toBe(false);
    expect(f("node_modules")).toBe(false);
    expect(f(j("2026", "02", "25", "deeper"))).toBe(false);
  });
  test("gemini enters a project hash and its chats dir only", () => {
    const f = transcriptDirWatcherConfig("gemini").dirFilter!;
    expect(f("abc123hash")).toBe(true);
    expect(f(j("abc123hash", "chats"))).toBe(true);
    expect(f(j("abc123hash", "checkpoints"))).toBe(false);
    expect(f(j("abc123hash", "chats", "deeper"))).toBe(false);
  });
  test("grok enters a cwd slug and a session uuid dir only", () => {
    const f = transcriptDirWatcherConfig("grok").dirFilter!;
    expect(f("%2FUsers%2Fdev")).toBe(true);
    expect(f(j("%2FUsers%2Fdev", "a7c9c0e2-1d82-4d42-b342-f59fefc7b9f5"))).toBe(true);
    expect(f(j("%2FUsers%2Fdev", ".cwd"))).toBe(false);
    expect(f(j("%2FUsers%2Fdev", "a7c9c0e2-1d82-4d42-b342-f59fefc7b9f5", "sub"))).toBe(false);
    expect(transcriptDirWatcherConfig("grok").maxDepth).toBe(3);
  });
  test("pi needs no dirFilter: maxDepth 2 stops at the slug dirs", () => {
    const cfg = transcriptDirWatcherConfig("pi");
    expect(cfg.dirFilter).toBeUndefined();
    expect(cfg.maxDepth).toBe(2);
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
  test("start() resolves after priming, with the pre-existing file already emitted", async () => {
    const root = path.join(os.tmpdir(), `.codex-watcher-prime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const sessionId = "12345678-1234-1234-1234-123456789abc";
    const filePath = path.join(root, "2026", "02", "25", `rollout-${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{"type":"response_item"}\n');
    // A matching file under a dir the codex dirFilter refuses: never walked.
    const cruft = path.join(root, "watcher-test-1", `rollout-${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(cruft), { recursive: true });
    fs.writeFileSync(cruft, '{"type":"response_item"}\n');

    const events: TranscriptDirEvent[] = [];
    const watcher = new TranscriptDirWatcher(transcriptDirWatcherConfig("codex", root));
    watcher.on("session", (e) => events.push(e));
    await watcher.start();
    expect(events.map((e) => e.filePath)).toEqual([filePath]);
    expect(events[0].sessionId).toBe(sessionId);
    watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

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

  // Ingest-boundary RCE guard (security critic): a real pi transcript ALWAYS ends in
  // its session UUID. A filename that doesn't is a crafted/foreign file, so returning
  // the raw filename (the old behavior) would make attacker text the session_id — and
  // later an unescaped resume command. extractSessionId now REFUSES it (null). Payload
  // is SYNTHETIC and slash-free (a real filename can't contain `/`).
  test("REFUSES a filename with no trailing uuid so a poisoned id is never tracked (null)", () => {
    const cfg = transcriptDirWatcherConfig("pi");
    expect(cfg.extractSessionId("/root/--Users-dev--/x; touch pwned #.jsonl")).toBeNull();
    expect(cfg.extractSessionId("/root/--Users-dev--/not-a-uuid.jsonl")).toBeNull();
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

  // Ingest-boundary RCE guard: a malformed pi filename (no trailing uuid) sitting in
  // the tree next to a real session is SKIPPED — never emitted, watcher stays alive —
  // so its attacker-controlled "id" never reaches convex. SYNTHETIC fixture.
  test("skips a malformed pi filename while still emitting a valid sibling session", async () => {
    const root = path.join(os.tmpdir(), `.pi-watcher-skip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const slug = "--Users-dev-src-demo--";
    const goodId = "b1946ac9-2d0e-4f3a-9c11-000000000001";
    const goodPath = path.join(root, slug, `2026-03-03T14-40-34-973Z_${goodId}.jsonl`);
    const poisonPath = path.join(root, slug, "x; touch pwned #.jsonl");
    fs.mkdirSync(path.dirname(goodPath), { recursive: true });
    // Both files present BEFORE start, so the initial scan sees both.
    fs.writeFileSync(poisonPath, '{"type":"session","version":3,"id":"x; touch pwned #"}\n');
    fs.writeFileSync(goodPath, '{"type":"session","version":3,"id":"' + goodId + '","cwd":"/x"}\n');

    const emitted: string[] = [];
    const watcher = new TranscriptDirWatcher(transcriptDirWatcherConfig("pi", root));
    watcher.on("session", (e: TranscriptDirEvent) => emitted.push(e.sessionId));
    const sawGood = waitForSessionEvent(watcher, (e) => e.sessionId === goodId);
    watcher.start();
    await sawGood;
    await new Promise((r) => setTimeout(r, 150)); // give a stray poison emit a chance

    expect(emitted).toContain(goodId);
    expect(emitted.some((id) => id.includes("touch") || id.includes(";"))).toBe(false);

    watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── grok (pl-438) ───────────────────────────────────────────────────────────
describe("transcriptDirWatcherConfig — grok config", () => {
  const cfg = transcriptDirWatcherConfig("grok");
  const uuid = "c3f8a1b2-4d5e-4f60-8a9b-0c1d2e3f4a5b";

  test("base path is ~/.grok/sessions (from the registry descriptor)", () => {
    expect(cfg.basePath).toBe(path.join(process.env.HOME || "", ".grok", "sessions"));
    expect(cfg.basePath).toBe(expandTranscriptRoot(AGENT_CLIENTS.grok.transcriptRoots[0]));
  });

  test("watches ONLY updates.jsonl — never the session dir's churning siblings", () => {
    expect(cfg.watchFilter(`%2Ftmp%2Fdemo/${uuid}/updates.jsonl`)).toBe(true);
    // chat_history.jsonl is a rewriteable cache (compaction replaces it) and the
    // rest churn during a turn — matching any of them double-fires per session.
    for (const sibling of [
      "chat_history.jsonl",
      "chat_history.jsonl.pre-strip",
      "summary.json",
      "plan.json",
      "signals.json",
      "updates.jsonl.lock",
      "updates.jsonl.tmp",
    ]) {
      expect(cfg.watchFilter(`%2Ftmp%2Fdemo/${uuid}/${sibling}`)).toBe(false);
    }
    // a bare updates.jsonl at the root has no session dir -> not a session file
    expect(cfg.watchFilter("updates.jsonl")).toBe(false);
    expect(cfg.scanMatch("/x", "updates.jsonl")).toBe(true);
    expect(cfg.scanMatch("/x", "chat_history.jsonl")).toBe(false);
    expect(cfg.maxDepth).toBe(3);
  });

  test("session id is the containing dir's FULL uuid", () => {
    expect(cfg.extractSessionId(`/root/%2Ftmp%2Fdemo/${uuid}/updates.jsonl`)).toBe(uuid);
  });

  // Ingest-boundary RCE guard (same contract as pi): the id flows into a resume
  // shell command, so a non-UUID dir name must be REFUSED (null) — which also
  // skips the sessions root's non-session entries by construction.
  test("REFUSES a non-uuid containing dir (cruft and crafted names) with null", () => {
    for (const dir of [
      "x; touch pwned #",
      "not-a-uuid",
      "session_search.sqlite",
      ".cwd",
      `${"c3f8a1b2-4d5e-4f60-8a9b-0c1d2e3f4a5b"}-extra`,
    ]) {
      expect(cfg.extractSessionId(`/root/%2Ftmp%2Fdemo/${dir}/updates.jsonl`)).toBeNull();
    }
  });
});

describe("grok cwd-slug encode/decode", () => {
  // Encoder verbatim to grok's encode_cwd_dirname (the Rust `urlencoding` crate):
  // percent-encode every byte outside [A-Za-z0-9_.~-], uppercase hex.
  test("encodes real cwds to the exact on-disk dir names", () => {
    expect(encodeGrokCwdSlug("/Users/ashot/src/codecast")).toBe("%2FUsers%2Fashot%2Fsrc%2Fcodecast");
    expect(encodeGrokCwdSlug("/private/tmp")).toBe("%2Fprivate%2Ftmp");
  });

  test("is STRICTER than encodeURIComponent: !'()* are percent-encoded too", () => {
    // encodeURIComponent leaves these bare — a naive delegation would compute a
    // dir name grok never writes and the session lookup would miss.
    expect(encodeGrokCwdSlug("/tmp/a!b'c(d)e*f")).toBe("%2Ftmp%2Fa%21b%27c%28d%29e%2Af");
    expect(encodeURIComponent("/tmp/a!b'c(d)e*f")).not.toBe(encodeGrokCwdSlug("/tmp/a!b'c(d)e*f"));
  });

  test("round-trips losslessly (unlike pi's dash-collapsing slug)", () => {
    for (const cwd of [
      "/Users/ashot/src/codecast",
      "/private/tmp",
      "/Users/dev/footage-app",
      "/tmp/a!b'c(d)e*f",
      "/tmp/with space/übung",
    ]) {
      expect(decodeGrokCwdSlug(encodeGrokCwdSlug(cwd))).toBe(cwd);
    }
  });

  test("decode accepts only absolute results — hash dirs and malformed %-seqs -> null", () => {
    // Long cwds (>255 encoded bytes) use `{slug}-{blake3_16}` dir names, which
    // decode to relative text; there the dir's `.cwd` file / summary.json cwd is
    // the source of truth, so the decoder must refuse rather than guess.
    expect(decodeGrokCwdSlug("codecast-0123456789abcdef")).toBeNull();
    expect(decodeGrokCwdSlug("%ZZbroken")).toBeNull();
    expect(decodeGrokCwdSlug("%2Fok")).toBe("/ok");
  });
});

describe("TranscriptDirWatcher — live behavior via the grok config", () => {
  test("emits a session two dirs deep, id = uuid dir name; siblings never fire", async () => {
    const root = path.join(os.tmpdir(), `.grok-watcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const sessionId = "a7c9c0e2-1d82-4d42-b342-f59fefc7b9f5";
    const sessionDir = path.join(root, encodeGrokCwdSlug("/tmp/grok-demo"), sessionId);
    const filePath = path.join(sessionDir, "updates.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });

    const emitted: string[] = [];
    const watcher = new TranscriptDirWatcher(transcriptDirWatcherConfig("grok", root));
    watcher.on("session", (e: TranscriptDirEvent) => emitted.push(e.filePath));
    watcher.start();
    await new Promise((r) => setTimeout(r, 200));

    const addPromise = waitForSessionEvent(watcher, (e) => e.filePath === filePath);
    // The real dir's churning siblings land beside the transcript — none may fire.
    fs.writeFileSync(path.join(sessionDir, "chat_history.jsonl"), "{}\n");
    fs.writeFileSync(path.join(sessionDir, "summary.json"), "{}");
    fs.writeFileSync(path.join(sessionDir, "updates.jsonl.lock"), "");
    fs.writeFileSync(filePath, '{"timestamp":0,"method":"session/update","params":{"sessionId":"' + sessionId + '","update":{"sessionUpdate":"available_commands_update","availableCommands":[]}}}\n');
    const addEvent = await addPromise;
    expect(addEvent.sessionId).toBe(sessionId);
    await new Promise((r) => setTimeout(r, 150));
    expect(emitted.every((p) => p.endsWith(`${path.sep}updates.jsonl`))).toBe(true);

    watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("skips the sessions root's non-session entries and non-uuid dirs on scan", async () => {
    const root = path.join(os.tmpdir(), `.grok-watcher-skip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const goodId = "b1946ac9-2d0e-4f3a-9c11-000000000001";
    const cwdDir = path.join(root, encodeGrokCwdSlug("/tmp/grok-demo"));
    const goodPath = path.join(cwdDir, goodId, "updates.jsonl");
    // Poison: an updates.jsonl inside a NON-uuid dir (crafted name) + root cruft.
    const poisonPath = path.join(cwdDir, "x; touch pwned #", "updates.jsonl");
    fs.mkdirSync(path.dirname(goodPath), { recursive: true });
    fs.mkdirSync(path.dirname(poisonPath), { recursive: true });
    fs.writeFileSync(path.join(root, "session_search.sqlite"), "");
    fs.writeFileSync(path.join(cwdDir, ".cwd"), "/tmp/grok-demo");
    fs.writeFileSync(poisonPath, "{}\n");
    fs.writeFileSync(goodPath, "{}\n");

    const emitted: string[] = [];
    const watcher = new TranscriptDirWatcher(transcriptDirWatcherConfig("grok", root));
    watcher.on("session", (e: TranscriptDirEvent) => emitted.push(e.sessionId));
    const sawGood = waitForSessionEvent(watcher, (e) => e.sessionId === goodId);
    watcher.start();
    await sawGood;
    await new Promise((r) => setTimeout(r, 150));

    expect(emitted).toContain(goodId);
    expect(emitted.some((id) => id.includes("touch") || id.includes(";"))).toBe(false);

    watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── Spawner identification: transcript path → agent session ─────────────────
// A `claude -p` child launched from a CODEX session's exec tool has no pid
// registry entry anywhere in its ancestor chain (only Claude Code writes those),
// so the daemon names the ancestor by the transcript it holds open instead.
describe("agentSessionFromTranscriptPath", () => {
  const HOME = process.env.HOME || "";

  test("names a codex session from its rollout filename's trailing uuid", () => {
    // The real jx798rq parent: the codex process that spawned three top-level
    // reviewers held exactly this file open.
    const p = path.join(HOME, ".codex/sessions/2026/08/01/rollout-2026-08-01T23-03-27-019fbf23-9395-7c32-9946-f420e4f967b4.jsonl");
    expect(agentSessionFromTranscriptPath(p)).toEqual({
      agentType: "codex",
      sessionId: "019fbf23-9395-7c32-9946-f420e4f967b4",
    });
  });

  test("names claude, gemini, and pi sessions from their own layouts", () => {
    expect(agentSessionFromTranscriptPath(path.join(HOME, ".claude/projects/-Users-j-code/828ac129-18e8-4a03-a18c-254037389be9.jsonl")))
      .toEqual({ agentType: "claude", sessionId: "828ac129-18e8-4a03-a18c-254037389be9" });
    expect(agentSessionFromTranscriptPath(path.join(HOME, ".gemini/tmp/abc123/chats/session-1.json")))
      .toEqual({ agentType: "gemini", sessionId: "session-1" });
    expect(agentSessionFromTranscriptPath(path.join(HOME, ".pi/agent/sessions/-Users-j-code/2026-08-02T11-10-00_019fbf23-9395-7c32-9946-f420e4f967b4.jsonl")))
      .toEqual({ agentType: "pi", sessionId: "019fbf23-9395-7c32-9946-f420e4f967b4" });
  });

  test("names a grok session from its uuid DIRECTORY (the file itself is always updates.jsonl)", () => {
    expect(agentSessionFromTranscriptPath(path.join(HOME, ".grok/sessions/%2FUsers%2Fj%2Fcode/c3f8a1b2-4d5e-4f60-8a9b-0c1d2e3f4a5b/updates.jsonl")))
      .toEqual({ agentType: "grok", sessionId: "c3f8a1b2-4d5e-4f60-8a9b-0c1d2e3f4a5b" });
    // sibling files in the same session dir are not the transcript
    expect(agentSessionFromTranscriptPath(path.join(HOME, ".grok/sessions/%2FUsers%2Fj%2Fcode/c3f8a1b2-4d5e-4f60-8a9b-0c1d2e3f4a5b/chat_history.jsonl")))
      .toBeNull();
    // an updates.jsonl outside a uuid session dir names nothing
    expect(agentSessionFromTranscriptPath(path.join(HOME, ".grok/sessions/%2FUsers%2Fj%2Fcode/updates.jsonl")))
      .toBeNull();
  });

  test("refuses a claude subagent transcript: it names the child, not the process's session", () => {
    // A live claude process holds its subagents' transcripts open alongside its
    // own — linking a spawnee to one of those would be the wrong parent.
    const p = path.join(HOME, ".claude/projects/-Users-j-code/parent-uuid/subagents/agent-child.jsonl");
    expect(agentSessionFromTranscriptPath(p)).toBeNull();
  });

  test("ignores non-transcript files a process happens to hold open", () => {
    expect(agentSessionFromTranscriptPath("/dev/null")).toBeNull();
    expect(agentSessionFromTranscriptPath(path.join(HOME, ".claude/settings.json"))).toBeNull();
    expect(agentSessionFromTranscriptPath(path.join(HOME, ".gemini/tmp/project/not-chats/session.json"))).toBeNull();
    expect(agentSessionFromTranscriptPath(path.join(HOME, ".codex/sessions/rollout.json"))).toBeNull();
    // opencode/cursor keep every session in one SQLite store — no per-session file.
    expect(agentSessionFromTranscriptPath(path.join(HOME, ".local/share/opencode/opencode.db"))).toBeNull();
  });
});
