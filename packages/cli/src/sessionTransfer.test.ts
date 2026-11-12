import { describe, expect, test, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  exportSession,
  fetchSessionForResume,
  fetchSessionFromPeers,
  findClaudeTranscript,
  forgetSessionFetchFailures,
  placeSession,
  type ExportSessionResult,
  type FetchSessionDeps,
} from "./sessionTransfer";
import type { PeerAttempt, PeerOutcome, PeerRequestOpts } from "./folderSync";
import type { TailnetStatus } from "./cloud/tailnet";
import { closeAllGrants, liveGrantCount } from "./peer/grant";
import { claudeProjectDirName } from "./projectPathResolver";
import { pollUntil } from "./test-helpers/pollUntil";

// These tests spawn tar and serve real sockets; the 5 s default is not enough under `bun test --parallel`.
setDefaultTimeout(30_000);

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

  test("symlinks in the session folder are never packed", async () => {
    const cwd = path.join(srcHome, "src", "family");
    const jsonl = writeTranscript(srcHome, cwd, ID, { "tool-results/a.txt": "out" });
    fs.symlinkSync(path.join(root, "outside.txt"), path.join(path.dirname(jsonl), ID, "tool-results", "link"));
    fs.writeFileSync(path.join(root, "outside.txt"), "secret");
    const out = await exportSession({ conversation_id: CONV, session_id: ID }, sourceDeps());
    expect(out).toMatchObject({ ok: true, files: 2 });
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

  test("a symlink in the archive never lands", () => {
    const srcCwd = path.join(srcHome, "src", "family");
    const staging = path.join(root, "staging");
    fs.mkdirSync(path.join(staging, ID, "sub"), { recursive: true });
    fs.writeFileSync(path.join(staging, `${ID}.jsonl`), JSON.stringify({ cwd: srcCwd }) + "\n");
    fs.writeFileSync(path.join(staging, `${OTHER}.jsonl`), "{}\n");
    fs.symlinkSync(`../${OTHER}.jsonl`, path.join(staging, ID, "link"));
    fs.symlinkSync("/etc", path.join(staging, ID, "sub", "etc"));
    const placed = placeSession(staging, { session_id: ID, cwd: srcCwd, home: srcHome }, { home: dstHome, cwd: path.join(dstHome, "family"), projectsDir: projects(dstHome) });
    const folder = path.join(path.dirname(placed), ID);
    expect(fs.existsSync(path.join(folder, "sub"))).toBe(true);
    expect(fs.readdirSync(folder, { recursive: true }).map(String).sort()).toEqual(["sub"]);
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
      const transcriptsUnder = (dir: string): string[] =>
        (fs.readdirSync(dir, { recursive: true }) as string[]).filter((n) => n.endsWith(".jsonl"));
      let beforeLanding = null as string[] | null;
      const r = await fetchSessionFromPeers({
        ...(mode === "direct" ? f.deps : { ...f.deps, direct: async () => null }),
        beforePlace: () => { beforeLanding = transcriptsUnder(projects(dstHome)); },
      });
      expect(beforeLanding).toEqual([]);
      expect(transcriptsUnder(projects(dstHome))).toEqual([`${claudeProjectDirName(dstCwd)}/${ID}.jsonl`]);
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
    expect(r).toEqual({ ok: false, reason: `no local folder for ${srcCwd}`, noLocalFolder: true });
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
  type Report = { phase: string; reason?: string };
  function service(over: Record<string, unknown> = {}) {
    const asked: string[] = [];
    const reports: Report[] = [];
    const svc = {
      getConversationOwner: async (): Promise<string | null> => "me",
      requestSessionExport: async (c: string) => { asked.push(c); return { command_ids: [], labels: {} }; },
      sessionExportOutcomes: async (): Promise<PeerOutcome[]> => [],
      discardSessionBundle: async () => {},
      getImageUrl: async (): Promise<string | null> => null,
      recordPeerLink: async () => {},
      reportPeerTransfer: async (_c: string, _d: string, _s: number, r: Report) => { reports.push(r); return { cancel: false }; },
      ...over,
    };
    return { svc, asked, reports };
  }
  const opts = (svc: ReturnType<typeof service>["svc"], conversationId: string, extra: Record<string, unknown> = {}) =>
    ({ svc, conversationId, sessionId: ID, deviceId: "me", home: dstHome, projectsDir: projects(dstHome), localCwd: async () => null, bind: () => {}, log: () => {}, ...extra });

  test("does nothing when another machine owns the conversation; an unowned one is fetched", async () => {
    const other = service({ getConversationOwner: async () => "other-device" });
    expect(await fetchSessionForResume(opts(other.svc, "conv_a"))).toBeNull();
    expect(await fetchSessionForResume(opts(service().svc, "conv_a", { sessionId: "forked-abc" }))).toBeNull();
    expect(other.asked).toEqual([]);
    const unowned = service({ getConversationOwner: async () => null });
    expect(await fetchSessionForResume(opts(unowned.svc, "conv_a2"))).toBeNull();
    expect(unowned.asked).toEqual(["conv_a2"]);
  });

  test("a failed fetch clears the strip, is not retried within a minute, and a restart forgets it", async () => {
    const f = service();
    expect(await fetchSessionForResume(opts(f.svc, "conv_b"))).toBeNull();
    await pollUntil(() => f.reports.at(-1)?.phase === "done", "the strip cleared");
    expect(f.reports.map((r) => r.phase)).not.toContain("failed");
    expect(await fetchSessionForResume(opts(f.svc, "conv_b"))).toBeNull();
    expect(f.asked).toHaveLength(1);
    forgetSessionFetchFailures("conv_other");
    expect(await fetchSessionForResume(opts(f.svc, "conv_b"))).toBeNull();
    expect(f.asked).toHaveLength(1);
    forgetSessionFetchFailures("conv_b");
    expect(await fetchSessionForResume(opts(f.svc, "conv_b"))).toBeNull();
    expect(f.asked).toHaveLength(2);
  });

  describe("through the relay", () => {
    let server: ReturnType<typeof Bun.serve>;
    const store = new Map<string, Uint8Array>();
    let aborted = 0;
    beforeEach(() => {
      server = Bun.serve({
        port: 0,
        fetch: (req) => {
          const id = new URL(req.url).pathname.slice(1);
          if (id === "hang") return new Promise<Response>(() => { req.signal.addEventListener("abort", () => { aborted++; }); });
          const body = store.get(id);
          return body ? new Response(body.slice()) : new Response("no", { status: 404 });
        },
      });
    });
    afterEach(() => { server.stop(true); store.clear(); });

    function relaying(srcCwd: string, over: Record<string, unknown> = {}) {
      const rows: PeerOutcome[] = [];
      const f = service({
        requestSessionExport: async (c: string) => {
          f.asked.push(c);
          const id = `r${rows.length + 1}`;
          const out = await exportSession({ conversation_id: c, session_id: ID }, sourceDeps({ upload: async (b: Uint8Array) => { store.set(id, b); return id; } }));
          rows.push({ command_id: id, executed_at: 1, result: JSON.stringify(out), error: null, label: "Mac mini", device_id: "mini" });
          return { command_ids: [id], labels: { [id]: "Mac mini" } };
        },
        sessionExportOutcomes: async () => rows,
        getImageUrl: async (sid: string) => `${server.url}${sid}`,
        ...over,
      });
      return f;
    }

    test("no local folder for the transcript's cwd does not close the transcript gate", async () => {
      writeTranscript(srcHome, path.join(srcHome, "src", "family"), ID);
      const f = relaying(path.join(srcHome, "src", "family"));
      expect(await fetchSessionForResume(opts(f.svc, "conv_c"))).toBeNull();
      expect(await fetchSessionForResume(opts(f.svc, "conv_c"))).toBeNull();
      expect(f.asked).toHaveLength(2);
      await pollUntil(() => f.reports.at(-1)?.phase === "done", "the strip cleared");
      expect(listed(projects(dstHome))).toEqual([]);
    });

    test("a long download keeps reporting, and a cancel aborts it, holds off automatic refetches, and a restart lifts it", async () => {
      writeTranscript(srcHome, path.join(srcHome, "src", "family"), ID);
      let receiving = 0;
      const f = relaying(path.join(srcHome, "src", "family"), {
        getImageUrl: async () => `${server.url}hang`,
        reportPeerTransfer: async (_c: string, _d: string, _s: number, r: Report) => {
          f.reports.push(r);
          if (r.phase === "receiving") receiving++;
          return { cancel: receiving >= 3 };
        },
      });
      expect(await fetchSessionForResume(opts(f.svc, "conv_d", { heartbeatMs: 20 }))).toBe("cancelled");
      expect(receiving).toBeGreaterThanOrEqual(3);
      await pollUntil(() => aborted > 0, "the download aborted");
      await pollUntil(() => f.reports.at(-1)?.phase === "failed", "the cancel reported");
      expect(f.reports.at(-1)).toEqual({ phase: "failed", reason: "you cancelled the transfer" });
      const reportsAfterCancel = f.reports.length;
      expect(await fetchSessionForResume(opts(f.svc, "conv_d", { heartbeatMs: 20 }))).toBe("cancelled");
      expect(f.asked).toHaveLength(1);
      expect(f.reports).toHaveLength(reportsAfterCancel);
      forgetSessionFetchFailures("conv_d");
      receiving = -100;
      const again = fetchSessionForResume(opts(f.svc, "conv_d", { heartbeatMs: 20 }));
      await pollUntil(() => f.asked.length === 2, "a fresh fetch after the restart");
      receiving = 100;
      expect(await again).toBe("cancelled");
    });

    test("the transcript's strip is finished before the folder lookup, so a folder transfer owns the strip alone", async () => {
      writeTranscript(srcHome, path.join(srcHome, "src", "family"), ID);
      const f = relaying(path.join(srcHome, "src", "family"));
      let atLookup = -1;
      const r = await fetchSessionForResume(opts(f.svc, "conv_e", {
        heartbeatMs: 10,
        localCwd: async () => {
          atLookup = f.reports.length;
          await new Promise((res) => setTimeout(res, 80));
          return dstHome;
        },
      }));
      expect(r).toMatchObject({ ok: true });
      expect(f.reports.at(atLookup - 1)).toEqual({ phase: "done" });
      expect(f.reports).toHaveLength(atLookup);
    });

    test("a folder fetch that failed keeps its failure on the strip", async () => {
      writeTranscript(srcHome, path.join(srcHome, "src", "family"), ID);
      const f = relaying(path.join(srcHome, "src", "family"));
      const folderFailure = { phase: "failed", reason: "the folder is over the limit" };
      const r = await fetchSessionForResume(opts(f.svc, "conv_f", {
        localCwd: async () => {
          await f.svc.reportPeerTransfer("conv_f", "me", 0, folderFailure);
          return null;
        },
      }));
      expect(r).toBeNull();
      await new Promise((res) => setTimeout(res, 30));
      expect(f.reports.at(-1)).toEqual(folderFailure);
    });
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
