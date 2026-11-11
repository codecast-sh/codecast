import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  exportSession,
  fetchSessionForResume,
  fetchSessionFromPeers,
  findClaudeTranscript,
  placeSession,
  type ExportSessionResult,
  type FetchSessionDeps,
} from "./sessionTransfer";
import type { PeerAttempt, PeerOutcome, PeerRequestOpts } from "./folderSync";
import type { TailnetStatus } from "./cloud/tailnet";
import { closeAllGrants, liveGrantCount } from "./peer/grant";
import { claudeProjectDirName } from "./projectPathResolver";
import { pollUntil } from "./test-helpers/pollUntil";

const ID = "0b9c2f7e-3d4a-4c1b-9e8f-1234567890ab";
const OTHER = "11111111-2222-4333-8444-555555555555";
const CONV = "conv_family";
const FIRST_UUID = "aaaaaaaa-0000-4000-8000-000000000001";
const LAST_UUID = "aaaaaaaa-0000-4000-8000-000000000002";

let root: string;
let srcHome: string;
let dstHome: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-transfer-test-")));
  srcHome = path.join(root, "src-home");
  dstHome = path.join(root, "dst-home");
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const projects = (home: string) => path.join(home, ".claude", "projects");
const listed = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

function writeTranscript(home: string, cwd: string, id: string, extra: Record<string, string> = {}): string {
  const dir = path.join(projects(home), claudeProjectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "user", uuid: FIRST_UUID, cwd, sessionId: id, message: { role: "user", content: `read ${cwd}/notes.md` } },
    { type: "assistant", uuid: LAST_UUID, cwd, sessionId: id, toolUseResult: { stdout: `${home}/.claude/projects/${claudeProjectDirName(cwd)}/${id}/tool-results/a.txt` } },
  ];
  const jsonl = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(jsonl, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  for (const [rel, body] of Object.entries(extra)) {
    const p = path.join(dir, id, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return jsonl;
}

const sourceDeps = (extra: Record<string, unknown> = {}) => ({
  home: srcHome,
  projectsDirs: [projects(srcHome)],
  upload: async () => "s1",
  ...extra,
});

describe("source resolution", () => {
  test("only the server-named UUID, never a path", async () => {
    const srcCwd = path.join(srcHome, "src", "family");
    writeTranscript(srcHome, srcCwd, ID);
    fs.writeFileSync(path.join(projects(srcHome), "passwd.jsonl"), "secret");
    for (const bad of ["../passwd", "/etc/passwd", `../${claudeProjectDirName(srcCwd)}/${ID}`, "passwd", `${ID}/..`, ""]) {
      expect(findClaudeTranscript([projects(srcHome)], bad)).toBeNull();
      expect(await exportSession({ conversation_id: CONV, session_id: bad }, sourceDeps())).toMatchObject({ ok: false, reason: expect.stringContaining("session_id") });
    }
  });

  test("another session's transcript is never served", async () => {
    writeTranscript(srcHome, path.join(srcHome, "src", "family"), OTHER);
    expect(await exportSession({ conversation_id: CONV, session_id: ID }, sourceDeps())).toMatchObject({ ok: false, missing: true });
  });

  test("a symlinked transcript is refused", async () => {
    const cwd = path.join(srcHome, "src", "family");
    const real = writeTranscript(srcHome, cwd, OTHER);
    fs.symlinkSync(real, path.join(path.dirname(real), `${ID}.jsonl`));
    expect(findClaudeTranscript([projects(srcHome)], ID)).toBeNull();
  });

  test("a request without a conversation is refused", async () => {
    expect(await exportSession({ session_id: ID }, sourceDeps())).toMatchObject({ ok: false, reason: expect.stringContaining("conversation_id") });
  });

  test("a copy without the conversation's newest message is refused as stale", async () => {
    writeTranscript(srcHome, path.join(srcHome, "src", "family"), ID);
    expect(await exportSession({ conversation_id: CONV, session_id: ID, last_uuid: "bbbbbbbb-0000-4000-8000-000000000009" }, sourceDeps()))
      .toMatchObject({ ok: false, missing: true, reason: expect.stringContaining("older") });
    expect(await exportSession({ conversation_id: CONV, session_id: ID, last_uuid: LAST_UUID }, sourceDeps())).toMatchObject({ ok: true, session_id: ID });
  });

  test("served with no local record of the conversation: the newest copy with its folder minus secrets", async () => {
    const cwd = path.join(srcHome, "src", "family");
    const old = writeTranscript(srcHome, path.join(srcHome, "src", "old"), ID);
    fs.utimesSync(old, new Date(1_000), new Date(1_000));
    writeTranscript(srcHome, cwd, ID, { "subagents/agent-1.jsonl": "{}\n", "tool-results/a.txt": "out", ".env": "SECRET=1" });
    let stored: Uint8Array | null = null;
    const out = await exportSession({ conversation_id: CONV, session_id: ID }, sourceDeps({ upload: async (b: Uint8Array) => { stored = b; return "s1"; } }));
    expect(out).toMatchObject({ ok: true, storage_id: "s1", session_id: ID, cwd, home: srcHome, files: 3 });
    expect(stored).not.toBeNull();
  });
});

describe("placeSession", () => {
  test("files the transcript under the local cwd's slug with paths rewritten, and never replaces one", () => {
    const srcCwd = path.join(srcHome, "src", "family");
    writeTranscript(srcHome, srcCwd, ID, { "subagents/agent-1.jsonl": JSON.stringify({ cwd: srcCwd }) + "\n" });
    const staging = path.join(root, "staging");
    fs.mkdirSync(staging);
    const srcDir = path.join(projects(srcHome), claudeProjectDirName(srcCwd));
    fs.cpSync(srcDir, staging, { recursive: true });
    const dstCwd = path.join(dstHome, "work", "family-2");
    const placed = placeSession(staging, { session_id: ID, cwd: srcCwd, home: srcHome }, { home: dstHome, cwd: dstCwd, projectsDir: projects(dstHome) });
    expect(placed).toBe(path.join(projects(dstHome), claudeProjectDirName(dstCwd), `${ID}.jsonl`));
    const text = fs.readFileSync(placed, "utf-8");
    expect(text).not.toContain(srcHome);
    expect(JSON.parse(text.split("\n")[0]).cwd).toBe(dstCwd);
    expect(text).toContain(`${projects(dstHome)}/${claudeProjectDirName(dstCwd)}/${ID}/tool-results/a.txt`);
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(placed), ID, "subagents", "agent-1.jsonl"), "utf-8")).cwd).toBe(dstCwd);

    fs.writeFileSync(placed, "mine\n");
    const again = path.join(root, "again");
    fs.cpSync(srcDir, again, { recursive: true });
    placeSession(again, { session_id: ID, cwd: srcCwd, home: srcHome }, { home: dstHome, cwd: dstCwd, projectsDir: projects(dstHome) });
    expect(fs.readFileSync(placed, "utf-8")).toBe("mine\n");
  });
});

describe("fetchSessionFromPeers", () => {
  const SRC = { ip: "127.0.0.1", name: "source.tail1234.ts.net." };
  const DST = { ip: "127.0.0.1", name: "dest.tail1234.ts.net." };
  const node = (n: { ip: string; name: string }) => ({ DNSName: n.name, TailscaleIPs: [n.ip], Online: true, UserID: 7 });
  const seenBy = (self: typeof SRC, peer: typeof SRC): TailnetStatus => ({ BackendState: "Running", Self: node(self), Peer: { k: node(peer) } });

  afterEach(async () => {
    closeAllGrants();
    await pollUntil(() => liveGrantCount() === 0, "grants closed");
  });

  /** Convex and the source daemon in one: each request runs export_session at once. */
  function fleet(srcCwd: string, dstCwd: string, served = ID) {
    const rows: PeerOutcome[] = [];
    const requests: PeerRequestOpts[] = [];
    const store = new Map<string, Uint8Array>();
    const attempts: PeerAttempt[] = [];
    const discarded: string[] = [];
    const deps: FetchSessionDeps = {
      home: dstHome,
      projectsDir: projects(dstHome),
      sessionId: ID,
      localCwd: async (recorded) => (recorded === srcCwd ? dstCwd : null),
      direct: async () => ({ self: DST }),
      tailnetStatus: async () => seenBy(DST, SRC),
      request: async (o: PeerRequestOpts = {}) => {
        requests.push(o);
        const id = `c${rows.length + 1}`;
        const out: ExportSessionResult = await exportSession(
          { conversation_id: CONV, session_id: served, relay_only: o.relay_only, direct: o.tailnet ? { requester: o.tailnet, token_hash: o.token_hash } : undefined },
          sourceDeps({
            upload: async (b: Uint8Array) => { store.set(id, b); return id; },
            tailnetStatus: async () => seenBy(SRC, DST),
            firewallBlocks: async () => false,
          }),
        );
        rows.push({ command_id: id, executed_at: 1, result: JSON.stringify(out), error: null, label: "Mac mini", device_id: "mini" });
        return { command_ids: [id], labels: { [id]: "Mac mini" } };
      },
      outcomes: async () => rows,
      download: async (id: string) => store.get(id) ?? null,
      discard: async (id) => { discarded.push(id); },
      sleep: async () => {},
      onAttempt: (a: PeerAttempt) => attempts.push(a),
    };
    return { deps, rows, requests, attempts, discarded };
  }

  for (const mode of ["direct", "relay"] as const) {
    test(`the real transcript and its folder land under this machine's cwd (${mode})`, async () => {
      const srcCwd = path.join(srcHome, "src", "family");
      const dstCwd = path.join(dstHome, "code", "family");
      writeTranscript(srcHome, srcCwd, ID, { "tool-results/a.txt": "full tool output" });
      const f = fleet(srcCwd, dstCwd);
      const dest = path.join(projects(dstHome), claudeProjectDirName(dstCwd), `${ID}.jsonl`);
      fs.mkdirSync(projects(dstHome), { recursive: true });
      const seen: string[] = [];
      const watcher = fs.watch(projects(dstHome), { recursive: true }, (_e, name) => { if (name) seen.push(String(name)); });
      let boundBeforeLanding = null as boolean | null;
      const r = await fetchSessionFromPeers({
        ...(mode === "direct" ? f.deps : { ...f.deps, direct: async () => null }),
        beforePlace: () => { boundBeforeLanding = !fs.existsSync(dest); },
      });
      await pollUntil(() => seen.some((n) => n.endsWith(`${ID}.jsonl`)), "the landed transcript observed").finally(() => watcher.close());
      expect(seen.filter((n) => n.endsWith(".jsonl") && !n.startsWith(`${claudeProjectDirName(dstCwd)}/`))).toEqual([]);
      expect(boundBeforeLanding).toBe(true);
      expect(r).toMatchObject({ ok: true, sessionId: ID, cwd: dstCwd, from: "Mac mini", mode });
      if (!r.ok) return;
      expect(r.jsonl).toBe(dest);
      const first = JSON.parse(fs.readFileSync(r.jsonl, "utf-8").split("\n")[0]);
      expect(first.cwd).toBe(dstCwd);
      expect(first.message.content).toBe(`read ${dstCwd}/notes.md`);
      expect(fs.readFileSync(path.join(path.dirname(r.jsonl), ID, "tool-results", "a.txt"), "utf-8")).toBe("full tool output");
      expect(f.attempts).toEqual([expect.objectContaining({ mode, ok: true, device_id: "mini" })]);
      expect(f.discarded).toEqual(["c1"]);
      expect(fs.readdirSync(projects(dstHome)).filter((n) => n.startsWith("."))).toEqual([]);
      expect(fs.readdirSync(path.join(dstHome, ".claude")).filter((n) => n.startsWith(".codecast-incoming-"))).toEqual([]);
    });
  }

  test("nobody has it, and no local folder for the source's cwd, both refuse without writing", async () => {
    const srcCwd = path.join(srcHome, "src", "family");
    const f = fleet(srcCwd, path.join(dstHome, "x"));
    expect(await fetchSessionFromPeers(f.deps)).toEqual({ ok: false, reason: "none of your other machines has it" });
    writeTranscript(srcHome, srcCwd, ID);
    const g = fleet(srcCwd, path.join(dstHome, "x"));
    const r = await fetchSessionFromPeers({ ...g.deps, localCwd: async () => null });
    expect(r).toEqual({ ok: false, reason: `no local folder for ${srcCwd}` });
    expect(listed(projects(dstHome))).toEqual([]);
  });

  test("an answer naming another session is refused before any pull and counts against no link", async () => {
    const srcCwd = path.join(srcHome, "src", "family");
    writeTranscript(srcHome, srcCwd, OTHER);
    const f = fleet(srcCwd, path.join(dstHome, "x"), OTHER);
    const r = await fetchSessionFromPeers(f.deps);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("another session") });
    expect(f.attempts).toEqual([]);
    expect(f.requests).toHaveLength(1);
    expect(listed(projects(dstHome))).toEqual([]);
  });

  test("an answer without a valid session id is not filed", async () => {
    const r = await fetchSessionFromPeers({
      home: dstHome,
      projectsDir: projects(dstHome),
      sessionId: ID,
      localCwd: async () => dstHome,
      request: async () => ({ command_ids: ["c1"], labels: { c1: "Mac mini" } }),
      outcomes: async () => [{ command_id: "c1", executed_at: 1, error: null, label: "Mac mini", result: JSON.stringify({ ok: true, storage_id: "s", bytes: 1, files: 1, path: "/x", session_id: "../../etc", cwd: "/x", home: "/y" }) }],
      download: async () => new Uint8Array([1]),
      discard: async () => {},
      sleep: async () => {},
    });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("names no session") });
    expect(listed(projects(dstHome))).toEqual([]);
  });
});

describe("fetchSessionForResume", () => {
  test("does nothing unless this machine owns the conversation", async () => {
    const asked: string[] = [];
    const svc = {
      getConversationOwner: async () => "other-device",
      requestSessionExport: async (c: string) => { asked.push(c); return { command_ids: [], labels: {} }; },
      sessionExportOutcomes: async () => [],
      discardSessionBundle: async () => {},
      getImageUrl: async () => null,
      recordPeerLink: async () => {},
      reportPeerTransfer: async () => ({ cancel: false }),
    };
    const base = { svc, conversationId: "conv_a", sessionId: ID, deviceId: "me", home: dstHome, projectsDir: projects(dstHome), localCwd: async () => null, bind: () => {}, log: () => {} };
    expect(await fetchSessionForResume(base)).toBeNull();
    expect(await fetchSessionForResume({ ...base, svc: { ...svc, getConversationOwner: async () => "me" }, sessionId: "forked-abc" })).toBeNull();
    expect(asked).toEqual([]);
  });

  test("a failed fetch is not retried within a minute", async () => {
    let asked = 0;
    const svc = {
      getConversationOwner: async () => "me",
      requestSessionExport: async () => { asked++; return { command_ids: [], labels: {} }; },
      sessionExportOutcomes: async () => [],
      discardSessionBundle: async () => {},
      getImageUrl: async () => null,
      recordPeerLink: async () => {},
      reportPeerTransfer: async () => ({ cancel: false }),
    };
    const opts = { svc, conversationId: "conv_b", sessionId: ID, deviceId: "me", home: dstHome, projectsDir: projects(dstHome), localCwd: async () => null, bind: () => {}, log: () => {} };
    expect(await fetchSessionForResume(opts)).toBeNull();
    expect(await fetchSessionForResume(opts)).toBeNull();
    expect(asked).toBe(1);
  });
});

describe("daemon wiring", () => {
  const src = fs.readFileSync(path.join(import.meta.dir, "daemon.ts"), "utf-8");

  test("export_session is detached and resolves the transcript from the server-named id", () => {
    expect(src).toMatch(/DETACHED_COMMANDS[^\n]*"export_session"/);
    const handler = src.slice(src.indexOf('case "export_session"'), src.indexOf('case "cap_publish"'));
    expect(handler).not.toContain("readConversationCache");
  });

  test("the resume hook maps the session before it lands and resumes the landed file itself", () => {
    const hook = src.slice(src.indexOf("fetchSessionForResume({"), src.indexOf("if (mayReconstituteResumeTranscript("));
    expect(hook).toContain("bind: () => mapSessionToConversation(sessionId, conversationId)");
    expect(hook).toContain('sessionFile = { path: fetched.jsonl, agentType: "claude" }');
    expect(hook).not.toContain("rebindConversationSession");
  });
});
