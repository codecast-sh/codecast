/**
 * What this machine's checkouts look like to the rest of the team
 * (contracts/checkouts.ts, ct-98780): each root the level sweep visits, where
 * it stands against origin's default branch, the uncommitted work in it by the
 * session that wrote it (attribute.ts, as `cast ship checkout` reads it), and
 * the sweep's state on it. Reported when that changes, never every minute.
 *
 * A level refused on the same files for LEVEL_STUCK_FILE_MS asks for help
 * once per episode: a message to the session that last wrote one of the files
 * (the `cast send` path), else a finding on the repository's project (the
 * path a failed deploy step files by). The episode and whether it was filed
 * are kept on disk, so a daemon restart neither forgets nor files again.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CHECKOUT_IDLE_MS, CHECKOUT_PATHS_MAX, CHECKOUT_SESSIONS_MAX, checkoutHash, LEVEL_STUCK_FILE_MS,
  type CheckoutFiled, type CheckoutLevel, type CheckoutReport, type CheckoutSession,
} from "@codecast/shared/contracts/checkouts";
import { defaultConfigDir } from "../config/configDir.js";
import { gitTry } from "../wipSnapshot.js";
import { attributeEdits, isMidTurn, type Attribution } from "./attribute.js";
import type { LevelSweepOutcome } from "./levelSweep.js";
import { attributionSince, upstreamRef } from "./shipCheckout.js";

type Post = (urlPath: string, body: Record<string, unknown>) => Promise<any>;

/** One root's sweep history: when it last levelled, and the stuck episode it is in. */
type Episode = { key: string; files: string[]; reason: string; since: number; filed: CheckoutFiled | null };
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
  const stuck: Episode = prev.stuck?.key === key ? { ...prev.stuck, files, reason } : { key, files, reason, since: now, filed: null };
  return { level: { state: "stuck", files, reason, since: stuck.since, filed: stuck.filed }, state: { ...prev, stuck } };
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
export async function checkoutReport(root: string, ids: { repository: string; deviceId: string }, level: CheckoutLevel, now = Date.now(), grouped?: Grouped): Promise<{ report: CheckoutReport; attribution: Attribution | null; grouped: Grouped }> {
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
  const attribution = paths.length && !reuse ? attributeEdits(root, paths, { since: attributionSince(root, paths, now), now }) : null;
  const uncommitted = reuse?.uncommitted ?? (attribution ? groupUncommitted(paths, attribution, now) : { total: 0, sessions: [], unattributed: [], unattributed_more: 0 });
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
    grouped: reuse ?? { sig, at: now, uncommitted },
  };
}

/** The words a stuck level asks for help in: the exact conflict and the two ways out. */
export function stuckWords(r: Pick<CheckoutReport, "path" | "upstream" | "behind">, level: Extract<CheckoutLevel, { state: "stuck" }>, host = os.hostname()): { title: string; body: string } {
  const files = level.files.length ? level.files : [];
  const named = files.slice(0, 5).map((f) => `\`${f}\``).join(", ") + (files.length > 5 ? ` and ${files.length - 5} more` : "");
  const upstream = r.upstream ?? "origin/main";
  const since = new Date(level.since).toISOString().replace("T", " ").slice(0, 16);
  const title = `${path.basename(r.path)} on ${host} cannot level to ${upstream}${files.length ? `: ${files[0]}${files.length > 1 ? ` +${files.length - 1}` : ""}` : ""}`;
  const quoted = files.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(" ");
  const body = [
    `The daemon on ${host} has not levelled ${r.path} to ${upstream} since ${since} UTC${r.behind ? ` (${r.behind} commits behind now)` : ""}.`,
    files.length ? `${named} changed here, uncommitted, and on ${upstream}, and the two do not merge cleanly. ${level.reason}.` : `${level.reason}.`,
    "",
    "Two ways out, either lets the next sweep level the checkout:",
    files.length
      ? `1. Rebase the edit onto main's version: \`git -C ${r.path} show ${upstream}:<file> > <file>\`, then make your change again on top of it.`
      : `1. Rebase the edit onto main's version, then let the sweep run.`,
    files.length
      ? `2. Set it aside as a patch: \`git -C ${r.path} diff -- ${quoted} > /tmp/level-aside.patch && git -C ${r.path} checkout -- ${quoted}\`; apply it later with \`git apply --3way\`.`
      : `2. Set the edit aside as a patch (git diff > patch, then git checkout -- the file).`,
  ].join("\n");
  return { title, body };
}

/** File the stuck episode once: to the session that last wrote one of its files, else a finding on the repo's project. */
export async function fileStuck(post: Post, report: CheckoutReport, level: Extract<CheckoutLevel, { state: "stuck" }>, attribution: Pick<Attribution, "owners"> | null, opts: { teamId?: string | null; host?: string; now?: number } = {}): Promise<CheckoutFiled> {
  const at = opts.now ?? Date.now();
  const { title, body } = stuckWords(report, level, opts.host);
  const writer = level.files.map((f) => attribution?.owners.get(f)).find((s) => s?.conversationId);
  if (writer?.conversationId) {
    await post("/cli/messages/send", { to: writer.conversationId, body: `${title}\n\n${body}`, intent: "request", wake: true });
    return { at, to: "session", conversation_id: writer.conversationId };
  }
  await post("/cli/signal/add", {
    source: "level",
    kind: "bug",
    fingerprint: `level:${report.device_id}:${report.path}:${level.files.join(",") || level.reason}`,
    title,
    detail_md: body,
    subject: `level:${report.repository}`,
    project_path: report.path,
    ...(opts.teamId ? { team_id: opts.teamId } : {}),
  });
  return { at, to: "finding" };
}

/**
 * After a sweep: each root's level state moved on, a stuck episode past LEVEL_STUCK_FILE_MS filed once, and every
 * checkout whose report changed sent (checkouts.report). Roots no longer on disk are reported gone.
 */
export async function reportCheckouts(outcomes: LevelSweepOutcome[], deps: { post: Post; deviceId: string; repositoryOf: (root: string) => string | null; now?: number; log?: (line: string) => void; stateFile?: string; host?: string }): Promise<{ sent: number; filed: number }> {
  const now = deps.now ?? Date.now();
  const log = deps.log ?? (() => {});
  const state = loadCheckoutState(deps.stateFile);
  const reports: CheckoutReport[] = [];
  let filed = 0;
  for (const o of outcomes) {
    const repository = deps.repositoryOf(o.root);
    if (!repository) continue;
    const prev = state.roots[o.root] ?? {};
    const next = nextLevel(prev, o, now);
    const read = await checkoutReport(o.root, { repository, deviceId: deps.deviceId }, next.level, now, prev.grouped);
    let report = read.report;
    next.state.grouped = read.grouped;
    const level = report.level;
    if (level.state === "stuck" && !level.filed && now - level.since >= LEVEL_STUCK_FILE_MS) {
      try {
        const attribution = read.attribution ?? (level.files.length ? attributeEdits(o.root, level.files, { since: attributionSince(o.root, level.files, now), now }) : null);
        const done = await fileStuck(deps.post, report, level, attribution, { host: deps.host, now });
        next.state.stuck = { ...next.state.stuck!, filed: done };
        report = { ...report, level: { ...level, filed: done } };
        filed++;
        log(`[LEVEL] ${o.root}: stuck since ${new Date(level.since).toISOString()} on ${level.files.join(", ") || level.reason}; asked ${done.to === "session" ? `the session that wrote it (${done.conversation_id})` : "the project (a finding)"} for help`);
      } catch (e) {
        log(`[LEVEL] ${o.root}: could not file the stuck level: ${(e as Error)?.message ?? e}`);
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
