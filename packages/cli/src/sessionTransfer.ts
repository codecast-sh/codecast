/**
 * Carrying a session's real transcript from another of the owner's machines
 * (docs/architecture/peer-transport.md, payload "Session transcript").
 *
 * A session moved to this machine with no transcript here used to be rebuilt
 * from the Convex export, which loses tool results and the session folder.
 * Now the destination first asks the owner's other online machines
 * (export_session): the one that ran it finds the transcript by the
 * conversation's id in its own records, never by a path from the request, and
 * sends `<id>.jsonl` plus its `<id>/` folder over the same direct link or
 * relay as a session folder (folderSync.ts). The destination files it under
 * the slug of its own cwd with the source's paths rewritten to this machine's.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_DIRECT_BYTES,
  MAX_FOLDER_BYTES,
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

/** The newest Claude Code transcript of one of `sessionIds` directly under a
 *  project folder of one of `projectsDirs`: a regular file, never a symlink. */
export function findClaudeTranscript(projectsDirs: string[], sessionIds: string[]): { sessionId: string; jsonl: string } | null {
  let best: { sessionId: string; jsonl: string; mtime: number } | null = null;
  const ids = sessionIds.filter(isSessionUuid);
  for (const projectsDir of projectsDirs) {
    let dirs: fs.Dirent[];
    try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { continue; }
    for (const id of ids) for (const d of dirs) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      const jsonl = path.join(projectsDir, d.name, `${id}.jsonl`);
      const st = fs.lstatSync(jsonl, { throwIfNoEntry: false });
      if (!st?.isFile()) continue;
      if (!best || st.mtimeMs > best.mtime) best = { sessionId: id, jsonl, mtime: st.mtimeMs };
    }
  }
  return best && { sessionId: best.sessionId, jsonl: best.jsonl };
}

export interface ExportSessionArgs extends ExportFolderArgs {
  conversation_id?: unknown;
}

export interface ExportSessionDeps extends ExportFolderDeps {
  projectsDirs: string[];
  /** The session ids this machine's own records map to the conversation. */
  sessionIdsFor: (conversationId: string) => string[];
}

export type SessionAnswerFields = { session_id: string; cwd: string; home: string };
export type ExportSessionResult = (ExportFolderResult & { ok: true } & SessionAnswerFields) | Extract<ExportFolderResult, { ok: false }>;

/** The source side of export_session. */
export async function exportSession(args: ExportSessionArgs, deps: ExportSessionDeps): Promise<ExportSessionResult> {
  if (typeof args.conversation_id !== "string" || !args.conversation_id) return { ok: false, reason: "export_session: missing conversation_id" };
  const found = findClaudeTranscript(deps.projectsDirs, deps.sessionIdsFor(args.conversation_id));
  if (!found) return { ok: false, missing: true, reason: "no transcript of this conversation is on this machine" };
  const cwd = cwdFromTranscript(found.jsonl);
  if (!cwd || !path.isAbsolute(cwd)) return { ok: false, reason: "the transcript names no working folder" };
  const dir = path.dirname(found.jsonl);
  const cap = wantsDirect(args) ? MAX_DIRECT_BYTES : MAX_FOLDER_BYTES;
  const entries = [path.basename(found.jsonl)];
  let bytes = fs.statSync(found.jsonl).size;
  const sibling = path.join(dir, found.sessionId);
  if (fs.lstatSync(sibling, { throwIfNoEntry: false })?.isDirectory()) {
    const sub = await planFolderExport(sibling, cap);
    if (!sub.ok) return { ok: false, reason: sub.reason };
    entries.push(...sub.entries.map((e) => path.join(found.sessionId, e)));
    bytes += sub.bytes;
  }
  const out = await servePlan({ ok: true, dir, entries, bytes, files: entries.length }, args, deps);
  return out.ok ? { ...out, session_id: found.sessionId, cwd, home: deps.home } : out;
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
    if (d.isDirectory()) relocateTree(p, from, to);
    else if (d.isFile() && d.name.endsWith(".jsonl")) relocateFile(p, from, to);
  }
}

/**
 * File an unpacked session under this machine's project slug for `localCwd`,
 * paths rewritten from the source's home and cwd. Never replaces a transcript
 * or session folder already here. Returns the transcript's path.
 */
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

export interface FetchSessionDeps extends Omit<SyncFromPeerDeps, "receive"> {
  home: string;
  projectsDir: string;
  /** Where the session runs on this machine, given the cwd it ran in there; null refuses. */
  localCwd: (recorded: string) => Promise<string | null>;
}

export type FetchSessionResult =
  | { ok: true; sessionId: string; jsonl: string; cwd: string; from: string; mode: TransferMode }
  | { ok: false; reason: string };

export const SESSION_PEER_WAIT_MS = 45_000;

/** The requester side: take the conversation's transcript from whichever of
 *  the owner's other machines has it and file it here. */
export async function fetchSessionFromPeers(deps: FetchSessionDeps, waitMs = SESSION_PEER_WAIT_MS): Promise<FetchSessionResult> {
  fs.mkdirSync(deps.projectsDir, { recursive: true });
  const staging = path.join(deps.projectsDir, `.codecast-incoming-${randomUUID().slice(0, 8)}`);
  let fields: SessionAnswerFields | null = null;
  try {
    const got = await syncFolderFromPeer(staging, {
      ...deps,
      receive: async (body, answer, limits) => {
        const f = sessionFields(answer);
        if (!f) throw new Error("the answer names no session");
        await fs.promises.rm(staging, { recursive: true, force: true });
        await unpackFolderStream(body, staging, limits);
        fields = f;
      },
    }, waitMs);
    if (!got.ok) return got;
    const s = fields as SessionAnswerFields | null;
    if (!s) return { ok: false, reason: "the answer names no session" };
    const cwd = await deps.localCwd(s.cwd);
    if (!cwd) return { ok: false, reason: `no local folder for ${s.cwd}` };
    const jsonl = placeSession(staging, s, { home: deps.home, cwd, projectsDir: deps.projectsDir });
    return { ok: true, sessionId: s.session_id, jsonl, cwd, from: got.from, mode: got.mode };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** What the daemon's sync service offers this module. */
export interface SessionTransferService {
  getConversationOwner(conversationId: string): Promise<string | null>;
  requestSessionExport(conversationId: string, deviceId: string, opts?: PeerRequestOpts): Promise<PeerRequest>;
  sessionExportOutcomes(ids: string[]): Promise<PeerOutcome[]>;
  discardSessionBundle(id: string): Promise<void>;
  getImageUrl(storageId: string): Promise<string | null>;
  recordPeerLink(link: { from_device_id: string; to_device_id: string; mode: TransferMode; ok: boolean; reason?: string; bytes?: number }): Promise<void>;
}

type Fetched = Extract<FetchSessionResult, { ok: true }>;
const inFlight = new Map<string, Promise<Fetched | null>>();
const failures = new Map<string, number>();
const RETRY_MS = 60_000;

/**
 * The daemon's entry: when this machine owns the conversation, fetch its
 * transcript from another of the owner's machines. One fetch per conversation
 * at a time, and a failed one is not retried for a minute. Null when it did
 * not run or did not land; the caller then regenerates from the export.
 */
export function fetchSessionForResume(opts: {
  svc: SessionTransferService;
  conversationId: string;
  deviceId: string;
  home: string;
  projectsDir: string;
  localCwd: (recorded: string) => Promise<string | null>;
  log: (m: string) => void;
}): Promise<Fetched | null> {
  const { svc, conversationId, deviceId, log } = opts;
  const running = inFlight.get(conversationId);
  if (running) return running;
  if (Date.now() - (failures.get(conversationId) ?? 0) < RETRY_MS) return Promise.resolve(null);
  const run = (async (): Promise<Fetched | null> => {
    if ((await svc.getConversationOwner(conversationId).catch(() => null)) !== deviceId) return null;
    log(`[SESSION] no transcript for ${conversationId.slice(0, 12)} here; asking your other machines for it`);
    const r = await fetchSessionFromPeers({
      home: opts.home,
      projectsDir: opts.projectsDir,
      localCwd: opts.localCwd,
      request: (o) => svc.requestSessionExport(conversationId, deviceId, o),
      outcomes: (ids) => svc.sessionExportOutcomes(ids),
      discard: (id) => svc.discardSessionBundle(id),
      direct: async () => {
        const self = selfTailnet(await localTailnetAsync());
        return self ? { self: { ip: self.ip, name: self.name } } : null;
      },
      download: async (storageId) => {
        const url = await svc.getImageUrl(storageId);
        if (!url) return null;
        const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      },
      onAttempt: (a) => {
        if (!a.device_id) return;
        svc.recordPeerLink({ from_device_id: a.device_id, to_device_id: deviceId, mode: a.mode, ok: a.ok, reason: a.reason, bytes: a.bytes })
          .catch((e) => log(`[SESSION] peer link not recorded: ${e instanceof Error ? e.message : String(e)}`));
      },
      log,
    });
    if (!r.ok) {
      failures.set(conversationId, Date.now());
      log(`[SESSION] couldn't fetch the transcript of ${conversationId.slice(0, 12)}: ${r.reason}`);
      return null;
    }
    failures.delete(conversationId);
    log(`[SESSION] transcript ${r.sessionId.slice(0, 8)} arrived from ${r.from} (${r.mode}) at ${r.jsonl}`);
    return r;
  })().finally(() => inFlight.delete(conversationId));
  inFlight.set(conversationId, run);
  return run;
}
