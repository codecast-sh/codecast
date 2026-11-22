/**
 * What this machine's checkouts look like to the rest of the team
 * (contracts/checkouts.ts, ct-98780): each root the level sweep visits, where
 * it stands against origin's default branch, the uncommitted work in it by the
 * session that wrote it (attribute.ts, as `cast ship checkout` reads it), and
 * the sweep's state on it. Reported when that changes, never every minute.
 *
 * A level refused on the same files for LEVEL_STUCK_FILE_MS asks for help,
 * once per episode per writer: each session that last wrote some of the
 * conflicting files hears about those files only (the `cast send` path), and
 * the files no session wrote go to one finding on the repository's project.
 * The episode and who it has told are kept on disk, so a daemon restart
 * neither forgets nor asks again.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CHECKOUT_IDLE_MS, CHECKOUT_PATHS_MAX, CHECKOUT_SESSIONS_MAX, checkoutHash, LEVEL_STUCK_FILE_MS,
  levelAskWords, toldOf, type CheckoutLevel, type CheckoutReport, type CheckoutSession, type CheckoutTold,
} from "@codecast/shared/contracts/checkouts";
import { defaultConfigDir } from "../config/configDir.js";
import { gitTry } from "../wipSnapshot.js";
import { attributeEdits, isMidTurn, type Attribution } from "./attribute.js";
import type { LevelSweepOutcome } from "./levelSweep.js";
import { attributionSince, upstreamRef } from "./shipCheckout.js";

type Post = (urlPath: string, body: Record<string, unknown>) => Promise<any>;

/** A stuck level's ask waits for the writer to be known. */
class DeferFiling extends Error {}

/** One root's stuck episode: the files, why, since when, and who has been told (`filed`: an earlier daemon's single ask, read as told). */
type Episode = { key: string; files: string[]; reason: string; since: number; told?: CheckoutTold[]; filed?: { at: number; to: "session"; conversation_id: string } | { at: number; to: "finding" } | null };

/** The last grouping of a root's uncommitted paths, kept while the same paths stay dirty (attribution reads every transcript). */
type Grouped = { sig: string; at: number; uncommitted: CheckoutReport["uncommitted"] };
type RootState = { levelled_at?: number; stuck?: Episode; hash?: string; grouped?: Grouped };

/** How long a grouping of unchanged dirty paths stands before it is read again (sessions move from working to finished). */
export const REGROUP_MS = 5 * 60_000;
type StateFile = { version: 1; roots: Record<string, RootState> };

const stateFile = () => path.join(defaultConfigDir(), "cache", "checkout-state.json");

export function loadCheckoutState(file = stateFile()): StateFile {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (data?.version === 1 && data.roots) return data;
  } catch {}
  return { version: 1, roots: {} };
}

export function saveCheckoutState(state: StateFile, file = stateFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

/** The level state a sweep outcome leaves a root in; the same files refused again keep the episode they started. */
export function nextLevel(prev: RootState, o: LevelSweepOutcome, now: number): { level: CheckoutLevel; state: RootState } {
  if ("skipped" in o) {
    if (o.skipped === "level") return { level: { state: "level", levelled_at: prev.levelled_at ?? null }, state: { ...prev, stuck: undefined } };
    return { level: { state: "off", reason: o.skipped }, state: { ...prev, stuck: undefined } };
  }
  const r = o.result;
  if (r.ok) return { level: { state: "level", levelled_at: now }, state: { ...prev, levelled_at: now, stuck: undefined } };
  const files = [...r.conflicts].sort();
  // The reason names the commit it was levelling to, which moves as main does: the episode is the files.
  const key = files.length ? files.join("\n") : (r.reason ?? "refused").replace(/\b[0-9a-f]{7,40}\b/g, "");
  const reason = r.reason ?? "refused";
  const stuck: Episode = prev.stuck?.key === key ? { ...prev.stuck, files, reason } : { key, files, reason, since: now, told: [] };
  return { level: { state: "stuck", files, reason, since: stuck.since, told: toldOf(stuck) }, state: { ...prev, stuck } };
}

const num = (s: string | null | undefined) => (s && /^\d+$/.test(s.trim()) ? Number(s.trim()) : null);

/** The uncommitted paths, repo-relative (renames by their new name). */
export async function dirtyPaths(root: string): Promise<string[]> {
  const out = (await gitTry(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"])) ?? "";
  const parts = out.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    // "XY path"; gitTry trims the output, so the first record may have lost a leading blank status column.
    const m = parts[i].match(/^(.{1,2}) (.+)$/s);
    if (!m) continue;
    paths.push(m[2]);
    // A rename or copy carries its old name as the next record.
    if (/[RC]/.test(m[1])) i++;
  }
  return paths;
}

/** The uncommitted work grouped by the session that wrote each path last, capped. */
export function groupUncommitted(paths: string[], a: Pick<Attribution, "owners">, now: number): CheckoutReport["uncommitted"] {
  const groups = new Map<string, { s: CheckoutSession; at: Map<string, number> }>();
  const unattributed: string[] = [];
  for (const p of paths) {
    const owner = a.owners.get(p);
    if (!owner) { unattributed.push(p); continue; }
    const key = owner.conversationId ?? owner.sessionId;
    let g = groups.get(key);
    if (!g) {
      const state = isMidTurn(owner) ? "working" : now - owner.lastActivity < CHECKOUT_IDLE_MS ? "idle" : "finished";
      g = { s: { conversation_id: owner.conversationId, session_id: owner.sessionId, client: owner.client, state, last_activity: Math.round(owner.lastActivity), paths: [], more: 0 }, at: new Map() };
      groups.set(key, g);
    }
    g.at.set(p, owner.edits.get(p) ?? 0);
  }
  const sessions = [...groups.values()]
    .map(({ s, at }) => {
      const ordered = [...at.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([p]) => p);
      return { ...s, paths: ordered.slice(0, CHECKOUT_PATHS_MAX), more: Math.max(0, ordered.length - CHECKOUT_PATHS_MAX) };
    })
    .sort((x, y) => y.last_activity - x.last_activity)
    .slice(0, CHECKOUT_SESSIONS_MAX);
  unattributed.sort();
  return { total: paths.length, sessions, unattributed: unattributed.slice(0, CHECKOUT_PATHS_MAX), unattributed_more: Math.max(0, unattributed.length - CHECKOUT_PATHS_MAX) };
}

/** One checkout's report and the attribution it was read with (the filing names the writer from it). */
/**
 * How long one report pass may read transcripts across every checkout, and how long any one read may hold the
 * daemon's event loop before it yields (attribution is synchronous: heartbeats and message delivery wait on it).
 */
export const REPORT_BUDGET_MS = 1_000;
export const REPORT_SLICE_MS = 150;

const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Attribution read a slice at a time, yielding between slices, until it is whole or `budgetMs` is spent. */
export async function attributeInSlices(root: string, paths: string[], now: number, budgetMs: number): Promise<Attribution> {
  const ends = Date.now() + budgetMs;
  const since = attributionSince(root, paths, now);
  for (;;) {
    const a = attributeEdits(root, paths, { since, now, budgetMs: Math.min(REPORT_SLICE_MS, Math.max(0, ends - Date.now())) });
    if (!a.partial || Date.now() >= ends) return a;
    await yieldToLoop();
  }
}

export async function checkoutReport(root: string, ids: { repository: string; deviceId: string }, level: CheckoutLevel, now = Date.now(), grouped?: Grouped, budgetMs?: number): Promise<{ report: CheckoutReport; attribution: Attribution | null; grouped: Grouped | undefined }> {
  const branch = await gitTry(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const head = await gitTry(root, ["rev-parse", "HEAD"]);
  let upstream: string | null = null;
  try { upstream = await upstreamRef(root); } catch {}
  const counts = upstream && head ? await gitTry(root, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]) : null;
  const [ahead, behind] = counts ? counts.split(/\s+/) : [];
  const common = await gitTry(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  let fetched_at: number | null = null;
  try { if (common) fetched_at = Math.round(fs.statSync(path.join(common, "FETCH_HEAD")).mtimeMs); } catch {}
  const paths = await dirtyPaths(root);
  const sig = checkoutHash(paths);
  const reuse = grouped && grouped.sig === sig && now - grouped.at < REGROUP_MS ? grouped : null;
  const attribution = paths.length && !reuse
    ? budgetMs === undefined ? attributeEdits(root, paths, { since: attributionSince(root, paths, now), now }) : await attributeInSlices(root, paths, now, budgetMs)
    : null;
  // Read only in part: no owner it names can be trusted yet (a later write may sit unread), so none is named.
  const uncommitted = reuse?.uncommitted
    ?? (attribution?.partial ? { ...groupUncommitted(paths, { owners: new Map() }, now), attributing: true as const } : attribution ? groupUncommitted(paths, attribution, now) : { total: 0, sessions: [], unattributed: [], unattributed_more: 0 });
  return {
    report: {
      repository: ids.repository.toLowerCase(),
      device_id: ids.deviceId,
      path: root,
      branch: branch || null,
      upstream,
      head_sha: head || null,
      ahead: num(ahead),
      behind: num(behind),
      fetched_at,
      uncommitted,
      level,
    },
    attribution,
    grouped: reuse ?? (attribution?.partial ? undefined : { sig, at: now, uncommitted }),
  };
}

/** The conflicting files by who should hear of them: each session that last wrote some (by conversation), and the rest. */
export function conflictGroups(files: string[], attribution: Pick<Attribution, "owners"> | null): { writers: Map<string, string[]>; nobody: string[] } {
  const writers = new Map<string, string[]>();
  const nobody: string[] = [];
  for (const f of files) {
    const conversation = attribution?.owners.get(f)?.conversationId;
    if (!conversation) { nobody.push(f); continue; }
    const list = writers.get(conversation) ?? [];
    list.push(f);
    writers.set(conversation, list);
  }
  return { writers, nobody };
}

/** Where an ask's full file list and its set-aside patch go: on this machine, beside each other, named by who it is for. */
export function askFiles(r: Pick<CheckoutReport, "device_id" | "path">, who: string, dir = path.join(os.tmpdir(), "codecast-level")): { list: string; patch: string } {
  const base = `${path.basename(r.path)}-${checkoutHash([r.device_id, r.path])}-${who.replace(/[^\w-]/g, "")}`;
  return { list: path.join(dir, `${base}.txt`), patch: path.join(dir, `${base}.patch`) };
}

/** The words of one ask (contracts/checkouts levelAskWords), on this machine: the list file it names is written here. */
export function conflictWords(r: Pick<CheckoutReport, "path" | "upstream" | "behind">, level: Pick<Extract<CheckoutLevel, { state: "stuck" }>, "files" | "since">, mine: string[], files: { list: string; patch: string }, opts: { host?: string; whose: "session" | "nobody" }): { title: string; body: string } {
  return levelAskWords(r, level, mine, files, { host: opts.host ?? os.hostname(), whose: opts.whose });
}

/**
 * Ask everyone a stuck level has not asked yet this episode: each session about the conflicting files it last wrote,
 * and one finding for the files no session wrote. Each ask's full list is written to a file the ask names.
 */
export async function tellWriters(post: Post, report: CheckoutReport, level: Extract<CheckoutLevel, { state: "stuck" }>, attribution: Pick<Attribution, "owners"> | null, opts: { teamId?: string | null; host?: string; now?: number; dir?: string } = {}): Promise<CheckoutTold[]> {
  const at = opts.now ?? Date.now();
  const { writers, nobody } = conflictGroups(level.files, attribution);
  const asked = new Set(level.told.map((t) => (t.to === "session" ? t.conversation_id : "")));
  const out: CheckoutTold[] = [];
  const listed = (who: string, mine: string[]) => {
    const files = askFiles(report, who, opts.dir);
    fs.mkdirSync(path.dirname(files.list), { recursive: true });
    fs.writeFileSync(files.list, `${mine.join("\n")}\n`);
    return files;
  };
  for (const [conversation, mine] of writers) {
    if (asked.has(conversation)) continue;
    const { title, body } = conflictWords(report, level, mine, listed(conversation, mine), { host: opts.host, whose: "session" });
    await post("/cli/messages/send", { to: conversation, body: `${title}\n\n${body}`, intent: "request", wake: true });
    out.push({ at, files: mine.length, to: "session", conversation_id: conversation });
  }
  if (nobody.length && !asked.has("")) {
    const { title, body } = conflictWords(report, level, nobody, listed("nobody", nobody), { host: opts.host, whose: "nobody" });
    await post("/cli/signal/add", {
      source: "level",
      kind: "bug",
      fingerprint: `level:${report.device_id}:${report.path}:${checkoutHash(nobody)}`,
      title,
      detail_md: body,
      subject: `level:${report.repository}`,
      project_path: report.path,
      ...(opts.teamId ? { team_id: opts.teamId } : {}),
    });
    out.push({ at, files: nobody.length, to: "finding" });
  }
  return out;
}

/**
 * After a sweep: each root's level state moved on, a stuck episode past LEVEL_STUCK_FILE_MS filed once, and every
 * checkout whose report changed sent (checkouts.report). Roots no longer on disk are reported gone.
 */
export async function reportCheckouts(outcomes: LevelSweepOutcome[], deps: { post: Post; deviceId: string; repositoryOf: (root: string) => string | null; now?: number; log?: (line: string) => void; stateFile?: string; host?: string; budgetMs?: number; askDir?: string }): Promise<{ sent: number; filed: number }> {
  const now = deps.now ?? Date.now();
  const passEnds = Date.now() + (deps.budgetMs ?? REPORT_BUDGET_MS);
  const left = () => Math.max(0, passEnds - Date.now());
  const log = deps.log ?? (() => {});
  const state = loadCheckoutState(deps.stateFile);
  const reports: CheckoutReport[] = [];
  let filed = 0;
  for (const o of outcomes) {
    const repository = deps.repositoryOf(o.root);
    if (!repository) continue;
    await yieldToLoop();
    const prev = state.roots[o.root] ?? {};
    const next = nextLevel(prev, o, now);
    const read = await checkoutReport(o.root, { repository, deviceId: deps.deviceId }, next.level, now, prev.grouped, left());
    let report = read.report;
    next.state.grouped = read.grouped;
    const level = report.level;
    if (level.state === "stuck" && level.files.length && now - level.since >= LEVEL_STUCK_FILE_MS) {
      try {
        const attribution = read.attribution ?? await attributeInSlices(o.root, level.files, now, left());
        // Who to ask is each file's last writer: until every transcript is read, ask nobody (a later pass will).
        if (attribution.partial) throw new DeferFiling();
        const told = await tellWriters(deps.post, report, level, attribution, { host: deps.host, now, dir: deps.askDir });
        if (told.length) {
          const all = [...level.told, ...told];
          next.state.stuck = { ...next.state.stuck!, told: all, filed: undefined };
          report = { ...report, level: { ...level, told: all } };
          filed += told.length;
          log(`[LEVEL] ${o.root}: stuck since ${new Date(level.since).toISOString()} on ${level.files.length} file(s); asked ${told.map((t) => (t.to === "session" ? `${t.conversation_id} about ${t.files}` : `a finding about ${t.files}`)).join(", ")}`);
        }
      } catch (e) {
        if (!(e instanceof DeferFiling)) log(`[LEVEL] ${o.root}: could not file the stuck level: ${(e as Error)?.message ?? e}`);
      }
    }
    const hash = checkoutHash(report);
    state.roots[o.root] = { ...next.state, hash: next.state.hash };
    if (hash !== prev.hash) {
      reports.push(report);
      state.roots[o.root].hash = hash;
    }
  }
  const gone = Object.keys(state.roots).filter((root) => !fs.existsSync(root));
  let sent = 0;
  if (reports.length || gone.length) {
    try {
      await deps.post("/cli/checkouts/report", { device_id: deps.deviceId, reports, gone });
      sent = reports.length;
      for (const root of gone) delete state.roots[root];
    } catch (e) {
      // Unsent: forget the hashes so the next pass sends them again.
      for (const r of reports) if (state.roots[r.path]) state.roots[r.path].hash = undefined;
      log(`[LEVEL] checkout report failed: ${(e as Error)?.message ?? e}`);
    }
  }
  saveCheckoutState(state, deps.stateFile);
  return { sent, filed };
}
