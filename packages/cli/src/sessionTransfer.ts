import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_DIRECT_BYTES,
  MAX_FOLDER_BYTES,
  peerTransferReporter,
  planFolderExport,
  servePlan,
  syncFolderFromPeer,
  unpackFolderStream,
  wantsDirect,
  type ExportAnswer,
  type ExportFolderArgs,
  type ExportFolderDeps,
  type ExportFolderResult,
  type PeerOutcome,
  type PeerProgress,
  type PeerRequest,
  type PeerRequestOpts,
  type SyncFromPeerDeps,
  type TransferMode,
} from "./folderSync.js";
import { claudeProjectDirName } from "./projectPathResolver.js";
import { cwdFromTranscript, relocateTranscript } from "./remote/session-move.js";
import { localTailnetAsync, selfTailnet } from "./cloud/tailnet.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionUuid(id: unknown): id is string {
  return typeof id === "string" && UUID.test(id);
}

export function findClaudeTranscript(projectsDirs: string[], sessionId: string): string | null {
  if (!isSessionUuid(sessionId)) return null;
  let best: { jsonl: string; mtime: number } | null = null;
  for (const projectsDir of projectsDirs) {
    let dirs: fs.Dirent[];
    try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      const jsonl = path.join(projectsDir, d.name, `${sessionId}.jsonl`);
      const st = fs.lstatSync(jsonl, { throwIfNoEntry: false });
      if (st?.isFile() && (!best || st.mtimeMs > best.mtime)) best = { jsonl, mtime: st.mtimeMs };
    }
  }
  return best?.jsonl ?? null;
}

export interface ExportSessionArgs extends ExportFolderArgs {
  conversation_id?: unknown;
  session_id?: unknown;
  last_uuid?: unknown;
}

export interface ExportSessionDeps extends ExportFolderDeps {
  projectsDirs: string[];
}

export type SessionAnswerFields = { session_id: string; cwd: string; home: string };
export type ExportSessionResult = (ExportFolderResult & { ok: true } & SessionAnswerFields) | Extract<ExportFolderResult, { ok: false }>;

export async function exportSession(args: ExportSessionArgs, deps: ExportSessionDeps): Promise<ExportSessionResult> {
  if (typeof args.conversation_id !== "string" || !args.conversation_id) return { ok: false, reason: "export_session: missing conversation_id" };
  if (!isSessionUuid(args.session_id)) return { ok: false, reason: "export_session: missing session_id" };
  const sessionId = args.session_id;
  const jsonl = findClaudeTranscript(deps.projectsDirs, sessionId);
  if (!jsonl) return { ok: false, missing: true, reason: "no transcript of this conversation is on this machine" };
  if (typeof args.last_uuid === "string" && !fs.readFileSync(jsonl, "utf-8").includes(`"${args.last_uuid}"`)) {
    return { ok: false, missing: true, reason: "this machine's copy of the transcript is older than the conversation" };
  }
  const cwd = cwdFromTranscript(jsonl);
  if (!cwd || !path.isAbsolute(cwd)) return { ok: false, reason: "the transcript names no working folder" };
  const dir = path.dirname(jsonl);
  const cap = wantsDirect(args) ? MAX_DIRECT_BYTES : MAX_FOLDER_BYTES;
  const entries = [path.basename(jsonl)];
  let bytes = fs.statSync(jsonl).size;
  const tooBig = { ok: false as const, reason: `the transcript is over the ${Math.round(cap / 1024 / 1024)} MB limit` };
  if (bytes > cap) return tooBig;
  const sibling = path.join(dir, sessionId);
  if (fs.lstatSync(sibling, { throwIfNoEntry: false })?.isDirectory()) {
    const sub = await planFolderExport(sibling, cap - bytes);
    if (!sub.ok) return { ok: false, reason: sub.reason };
    for (const e of sub.entries) {
      const st = fs.lstatSync(path.join(sibling, e), { throwIfNoEntry: false });
      if (!st?.isFile()) continue;
      entries.push(path.join(sessionId, e));
      bytes += st.size;
    }
  }
  if (bytes > cap) return tooBig;
  const out = await servePlan({ ok: true, dir, entries, bytes, files: entries.length }, args, deps);
  return out.ok ? { ...out, session_id: sessionId, cwd, home: deps.home } : out;
}

function sessionFields(a: ExportAnswer): SessionAnswerFields | null {
  const f = a as Partial<SessionAnswerFields>;
  return isSessionUuid(f.session_id) && typeof f.cwd === "string" && path.isAbsolute(f.cwd) && typeof f.home === "string" && path.isAbsolute(f.home)
    ? { session_id: f.session_id, cwd: f.cwd, home: f.home }
    : null;
}

function relocateFile(file: string, from: { home: string; cwd: string }, to: { home: string; cwd: string }): void {
  const tmp = `${file}.cast-relocate`;
  fs.writeFileSync(tmp, relocateTranscript(fs.readFileSync(file, "utf-8"), from, to), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function relocateTree(dir: string, from: { home: string; cwd: string }, to: { home: string; cwd: string }): void {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isSymbolicLink()) fs.unlinkSync(p);
    else if (d.isDirectory()) relocateTree(p, from, to);
    else if (d.isFile() && d.name.endsWith(".jsonl")) relocateFile(p, from, to);
  }
}

export function placeSession(staging: string, s: SessionAnswerFields, to: { home: string; cwd: string; projectsDir: string }): string {
  const jsonl = path.join(staging, `${s.session_id}.jsonl`);
  if (!fs.lstatSync(jsonl, { throwIfNoEntry: false })?.isFile()) throw new Error("the archive holds no transcript for that session");
  const from = { home: s.home, cwd: s.cwd };
  const target = { home: to.home, cwd: to.cwd };
  const projectDir = path.join(to.projectsDir, claudeProjectDirName(to.cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  const dest = path.join(projectDir, `${s.session_id}.jsonl`);
  const folder = path.join(staging, s.session_id);
  if (fs.lstatSync(folder, { throwIfNoEntry: false })?.isDirectory() && !fs.existsSync(path.join(projectDir, s.session_id))) {
    relocateTree(folder, from, target);
    fs.renameSync(folder, path.join(projectDir, s.session_id));
  }
  if (fs.existsSync(dest)) return dest;
  relocateFile(jsonl, from, target);
  fs.renameSync(jsonl, dest);
  return dest;
}

export interface FetchSessionDeps extends Omit<SyncFromPeerDeps, "receive" | "validate"> {
  home: string;
  projectsDir: string;
  sessionId: string;
  localCwd: (recorded: string) => Promise<string | null>;
  beforePlace?: () => void;
}

export type FetchSessionResult =
  | { ok: true; sessionId: string; jsonl: string; cwd: string; from: string; mode: TransferMode }
  | { ok: false; reason: string; noLocalFolder?: true };

export const SESSION_PEER_WAIT_MS = 45_000;
const STAGING_PREFIX = ".codecast-incoming-";
const STALE_STAGING_MS = 60 * 60_000;

// Staged beside the projects dir, never inside it: the session watcher would
// sync a half-relocated `<id>.jsonl` there as a session of its own.
function stagingDir(projectsDir: string): string {
  const parent = path.dirname(projectsDir);
  fs.mkdirSync(parent, { recursive: true });
  for (const name of fs.readdirSync(parent)) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const p = path.join(parent, name);
    if (Date.now() - (fs.lstatSync(p, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > STALE_STAGING_MS) fs.rmSync(p, { recursive: true, force: true });
  }
  return path.join(parent, `${STAGING_PREFIX}${randomUUID().slice(0, 8)}`);
}

export async function fetchSessionFromPeers(deps: FetchSessionDeps, waitMs = SESSION_PEER_WAIT_MS): Promise<FetchSessionResult> {
  if (!isSessionUuid(deps.sessionId)) return { ok: false, reason: "not a session id" };
  const staging = stagingDir(deps.projectsDir);
  let fields: SessionAnswerFields | null = null;
  try {
    const got = await syncFolderFromPeer(staging, {
      ...deps,
      validate: (answer) => {
        const f = sessionFields(answer);
        if (!f) return "the answer names no session";
        return f.session_id === deps.sessionId ? null : "the answer is another session";
      },
      receive: async (body, answer, limits) => {
        await fs.promises.rm(staging, { recursive: true, force: true });
        await unpackFolderStream(body, staging, limits);
        fields = sessionFields(answer);
      },
    }, waitMs);
    if (!got.ok) return got;
    const s = fields as SessionAnswerFields | null;
    if (!s) return { ok: false, reason: "the answer names no session" };
    const cwd = await deps.localCwd(s.cwd);
    if (!cwd) return { ok: false, reason: `no local folder for ${s.cwd}`, noLocalFolder: true };
    deps.beforePlace?.();
    const jsonl = placeSession(staging, s, { home: deps.home, cwd, projectsDir: deps.projectsDir });
    return { ok: true, sessionId: s.session_id, jsonl, cwd, from: got.from, mode: got.mode };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export interface SessionTransferService {
  getConversationOwner(conversationId: string): Promise<string | null>;
  requestSessionExport(conversationId: string, deviceId: string, opts?: PeerRequestOpts): Promise<PeerRequest>;
  sessionExportOutcomes(ids: string[]): Promise<PeerOutcome[]>;
  discardSessionBundle(id: string): Promise<void>;
  getImageUrl(storageId: string): Promise<string | null>;
  recordPeerLink(link: { from_device_id: string; to_device_id: string; mode: TransferMode; ok: boolean; reason?: string; bytes?: number }): Promise<void>;
  reportPeerTransfer(
    conversationId: string,
    deviceId: string,
    startedAt: number,
    report: { phase: PeerProgress["phase"] | "done" | "failed"; from?: string; mode?: TransferMode; bytes?: number; total?: number; reason?: string },
  ): Promise<{ cancel: boolean }>;
}

export type Fetched = Extract<FetchSessionResult, { ok: true }>;
export type ResumeFetch = Fetched | "cancelled" | null;
const inFlight = new Map<string, Promise<ResumeFetch>>();
const failures = new Map<string, { at: number; cancelled: boolean }>();
const RETRY_MS = 60_000;

export function forgetSessionFetchFailures(conversationId: string): void {
  for (const key of failures.keys()) if (key.startsWith(`${conversationId}\0`)) failures.delete(key);
}

export function fetchSessionForResume(opts: {
  svc: SessionTransferService;
  conversationId: string;
  sessionId: string;
  deviceId: string;
  home: string;
  projectsDir: string;
  localCwd: (recorded: string) => Promise<string | null>;
  bind: () => void;
  log: (m: string) => void;
  heartbeatMs?: number;
}): Promise<ResumeFetch> {
  const { svc, conversationId, sessionId, deviceId, log } = opts;
  if (!isSessionUuid(sessionId)) return Promise.resolve(null);
  const key = `${conversationId}\0${sessionId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const failed = failures.get(key);
  if (failed && Date.now() - failed.at < RETRY_MS) return Promise.resolve(failed.cancelled ? "cancelled" : null);
  const run = (async (): Promise<ResumeFetch> => {
    const owner = await svc.getConversationOwner(conversationId).catch(() => null);
    if (owner && owner !== deviceId) return null;
    log(`[SESSION] no transcript for ${sessionId.slice(0, 8)} here; asking your other machines for it`);
    const startedAt = Date.now();
    const progress = peerTransferReporter((p) => svc.reportPeerTransfer(conversationId, deviceId, startedAt, p), { log, heartbeatMs: opts.heartbeatMs });
    const r = await fetchSessionFromPeers({
      home: opts.home,
      projectsDir: opts.projectsDir,
      sessionId,
      localCwd: async (recorded) => {
        progress.report({ phase: "done" });
        await progress.settled();
        return opts.localCwd(recorded);
      },
      beforePlace: opts.bind,
      onProgress: progress.report,
      cancelled: progress.cancelled,
      request: (o) => svc.requestSessionExport(conversationId, deviceId, o),
      outcomes: (ids) => svc.sessionExportOutcomes(ids),
      discard: (id) => svc.discardSessionBundle(id),
      direct: async () => {
        const self = selfTailnet(await localTailnetAsync());
        return self ? { self: { ip: self.ip, name: self.name } } : null;
      },
      download: async (storageId, signal) => {
        const url = await svc.getImageUrl(storageId);
        if (!url) return null;
        const timeout = AbortSignal.timeout(5 * 60_000);
        const res = await fetch(url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      },
      onAttempt: (a) => {
        if (!a.device_id) return;
        svc.recordPeerLink({ from_device_id: a.device_id, to_device_id: deviceId, mode: a.mode, ok: a.ok, reason: a.reason, bytes: a.bytes })
          .catch((e) => log(`[SESSION] peer link not recorded: ${e instanceof Error ? e.message : String(e)}`));
      },
      log,
    });
    if (!r.ok && r.reason === "cancelled") {
      progress.report({ phase: "failed", reason: "you cancelled the transfer" });
      failures.set(key, { at: Date.now(), cancelled: true });
      log(`[SESSION] transcript ${sessionId.slice(0, 8)}: you cancelled the transfer`);
      return "cancelled";
    }
    if (!r.ok) {
      if (!r.noLocalFolder) {
        progress.report({ phase: "done" });
        failures.set(key, { at: Date.now(), cancelled: false });
      }
      log(`[SESSION] couldn't fetch transcript ${sessionId.slice(0, 8)}: ${r.reason}`);
      return null;
    }
    progress.report({ phase: "done", from: r.from, mode: r.mode });
    failures.delete(key);
    log(`[SESSION] transcript ${sessionId.slice(0, 8)} arrived from ${r.from} (${r.mode}) at ${r.jsonl}`);
    return r;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}
