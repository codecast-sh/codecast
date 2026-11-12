// Stable-context building + recording, shared by the two injection paths:
//   - `cast stable-context` (the SessionStart hook for Claude Code) — resolves
//     env overrides, prints the block to stdout, records what it injected.
//   - the daemon's Codex threadStart (developerInstructions) — same builder,
//     records directly against the conversation it is spawning.
// One builder means the feed params, exclusion filtering, and the recorded
// item shape can never drift between agents.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  isExcludedStableItem,
  resolveStableLaunch,
  type StableContextData,
  type StableContextItem,
  type StableFeedMode,
  type StableMode,
} from "@codecast/shared/contracts";
import { formatFeedResults } from "./formatter.js";
import type { PushedPoolRow } from "./workflow/flowPool.js";
import { fetchMappedProjects, teamForDirectory } from "./directoryTeam.js";
import { orgContextBlock, type OrgWhere } from "@codecast/shared/contracts/orgWhere";
import { formatModGuide } from "./mods/guide.js";
import { defaultConfigDir } from "./config/configDir.js";
import { resolveCastInvocation } from "./castInvocation.js";
import { spawn } from "./proc.js";
import { STABLE_CONTEXT_AFTER_VERB, STABLE_CONTEXT_SERVED_VERB } from "./fastPath.js";
import { DIR_BLOCK_KEY_MAX, wrapForClient, type StableHookClient } from "./stableContextHooks.js";

export * from "./stableContextHooks.js";

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

export interface StableContextConfig {
  auth_token?: string;
  convex_url?: string;
  stable_mode?: StableMode;
  stable_global?: boolean;
}

export interface BuildStableContextOptions {
  mode: StableFeedMode;
  global: boolean;
  exclude?: string[];
  cwd?: string;
  /** The session being started (conversation id or agent session id), so the
   *  org context can say where it sits. Absent: the org context is unbound. */
  session?: string;
  /** Session start. A warm cache for this scope is rendered with no network
   *  wait at all; a cold one waits at most `budgetMs` for each live read and
   *  renders whatever arrived. Absent: wait for every live read. */
  start?: { budgetMs: number; source?: string };
  /** Where the reads are cached (tests). */
  cacheDir?: string;
}

export interface BuiltStableContext {
  text: string;
  data: StableContextData;
  /** Rendered from the cache or from a partial read, so the cache wants a refresh. */
  stale?: boolean;
}

/** One scope's reads (a mode, a project scope, a directory). A read that failed is null. */
interface StableReads {
  feed: any | null;
  mods: string | null;
  pool: { rows: PushedPoolRow[]; flowsOn?: boolean } | null;
  /** Where a session in this scope sits in the org; its session fields are filled per start. */
  where: OrgWhere | null;
}

interface StableCacheFile {
  at: number;
  opts: Pick<BuildStableContextOptions, "mode" | "global" | "cwd">;
  reads: StableReads;
}

const NO_READS: StableReads = { feed: null, mods: null, pool: null, where: null };

export function stableCacheDir(): string {
  return path.join(defaultConfigDir(), "stable-cache");
}

function stableScope(config: { auth_token: string; convex_url: string }, opts: BuildStableContextOptions) {
  const siteUrl = config.convex_url.replace(".cloud", ".site");
  const projectPath = opts.global ? undefined : opts.cwd;
  const key = crypto.createHash("sha256")
    .update(JSON.stringify({ siteUrl, token: crypto.createHash("sha256").update(config.auth_token).digest("hex"), mode: opts.mode, projectPath: projectPath ?? null, cwd: opts.cwd ?? null }))
    .digest("hex").slice(0, 32);
  const dir = opts.cacheDir ?? stableCacheDir();
  return { siteUrl, projectPath, file: path.join(dir, `${key}.json`), sessionFile: (session: string) => path.join(dir, `org-${crypto.createHash("sha256").update(`${key}:${session}`).digest("hex").slice(0, 32)}.json`) };
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // A cache that cannot be written only costs the next start its wait.
  }
}

/** The value if it settles within `ms`, else null; a rejection is null too. */
function within<T>(p: Promise<T | null>, ms?: number): Promise<T | null> {
  const safe = p.catch(() => null);
  if (ms === undefined) return safe;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void safe.then((v) => { clearTimeout(timer); resolve(v); });
  });
}

/** A per-session org read is the session's own only while it is fresh: a binding moves. */
const SESSION_WHERE_MAX_AGE_MS = 10 * 60_000;

/**
 * The org as a session that has just started sees it, from a read made for
 * another session in the same scope: the workspace, its roles and people are
 * shared; the session is new, so it has no title, lead, binding or seat yet.
 */
export function whereForNewSession(base: OrgWhere, session?: string): OrgWhere {
  const shortId = session && /^[a-z0-9]{12,}$/.test(session) ? session.slice(0, 7) : null;
  return {
    ...base,
    session: shortId ? { short_id: shortId, title: null, person: base.session?.person ?? null, lead: null } : null,
    work: { task: null, plan: null, project: null },
    seat: { how: "none", handles: [] },
    card: null,
    chain: [],
    roles: base.roles.map((r) => ({ ...r, seat: false })),
  };
}

/** Read everything live, each read on its own clock. */
async function liveStableReads(
  config: { auth_token: string; convex_url: string },
  opts: BuildStableContextOptions,
  budgetMs?: number,
): Promise<StableReads> {
  const { siteUrl, projectPath } = stableScope(config, opts);
  const lookbackDays = opts.mode === "team" ? 14 : 7;
  const limit = opts.mode === "team" ? 15 : 10;
  const feed = (async () => {
    const response = await fetch(`${siteUrl}/cli/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        // Over-fetch by the exclusion count so excluding cards doesn't shrink
        // the injected feed below its normal size.
        limit: Math.min(limit + (opts.exclude?.length ?? 0), 30),
        offset: 0,
        start_time: Date.now() - lookbackDays * 24 * 60 * 60 * 1000,
        project_path: projectPath,
      }),
      // Stable context is optional and must never hold up agent startup
      // indefinitely when the network or backend is unhealthy.
      signal: AbortSignal.timeout(15_000),
    });
    const result = (await response.json()) as any;
    return response.ok && !result?.error ? result : null;
  })();
  const [feedResult, mods, pool, where] = await Promise.all([
    within(feed, budgetMs),
    within(fetchModsGuide(siteUrl, config.auth_token, opts.cwd), budgetMs),
    within(fetchDirectoryPool(siteUrl, config.auth_token, opts.cwd), budgetMs),
    within(fetchOrgWhere(siteUrl, config.auth_token, opts.session), budgetMs),
  ]);
  return { feed: feedResult, mods, pool, where };
}

/**
 * Read the scope live and keep what arrived for the next start: each read
 * replaces its cached copy only when it succeeded, and the org read is also
 * kept as this session's own. Used after a start, by the daemon when a session
 * is about to start, and by the daemon's warmer.
 */
export async function refreshStableCache(config: StableContextConfig | null, opts: BuildStableContextOptions): Promise<StableReads | null> {
  if (!config?.auth_token || !config?.convex_url) return null;
  const auth = { auth_token: config.auth_token, convex_url: config.convex_url };
  const scope = stableScope(auth, opts);
  const live = await liveStableReads(auth, opts);
  const prev = readJson<StableCacheFile>(scope.file)?.reads ?? NO_READS;
  const reads: StableReads = {
    feed: live.feed ?? prev.feed,
    mods: live.mods ?? prev.mods,
    pool: live.pool ?? prev.pool,
    where: live.where ?? prev.where,
  };
  writeJson(scope.file, { at: Date.now(), opts: { mode: opts.mode, global: opts.global, cwd: opts.cwd }, reads } satisfies StableCacheFile);
  if (opts.session && live.where) writeJson(scope.sessionFile(opts.session), { at: Date.now(), where: live.where });
  await writeDirBlock(config, opts);
  return reads;
}

/**
 * The name a terminal start's stable-feed.sh builds, with shell builtins only,
 * for its folder's block: mode, scope and the folder with every other character
 * made "_". The block's first line holds the exact "mode|global|cwd", which the
 * script compares, so two folders that share a name never share a block. A
 * terminal session names itself by Claude's uuid, which the org fill does not
 * show, so one block serves every start in the folder. Null past a file name's length.
 */
export function dirBlockKey(mode: string, global: boolean, cwd: string): string | null {
  const key = `${mode}-${global ? 1 : 0}-${cwd.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  return key.length <= DIR_BLOCK_KEY_MAX ? key : null;
}

function dirBlockHeader(mode: string, global: boolean, cwd: string): string {
  return `${mode}|${global ? 1 : 0}|${cwd}`;
}

interface DirBlockMeta {
  at: number;
  opts: Pick<BuildStableContextOptions, "mode" | "global" | "cwd">;
  data: StableContextData;
}

function dirBlockFiles(key: string, dir = stableCacheDir()) {
  return { text: path.join(dir, `rendered-dir-${key}.txt`), meta: path.join(dir, `rendered-dir-${key}.json`) };
}

function hasDirBlock(opts: BuildStableContextOptions): boolean {
  const key = opts.cwd ? dirBlockKey(opts.mode, opts.global, opts.cwd) : null;
  return !key || fs.existsSync(dirBlockFiles(key, opts.cacheDir).text);
}

/** Render a folder's block from its cache for terminal starts to print with no process to start. */
async function writeDirBlock(config: StableContextConfig, opts: BuildStableContextOptions): Promise<void> {
  if (!opts.cwd) return;
  const base = { mode: opts.mode, global: opts.global, cwd: opts.cwd };
  const built = await buildStableContext(config, { ...base, start: { budgetMs: 0, source: "startup" }, cacheDir: opts.cacheDir });
  if (!built) return;
  const key = dirBlockKey(opts.mode, opts.global, opts.cwd);
  if (!key) return;
  const files = dirBlockFiles(key, opts.cacheDir);
  writeJson(files.meta, { at: Date.now(), opts: base, data: built.data } satisfies DirBlockMeta);
  try {
    fs.writeFileSync(`${files.text}.${process.pid}.tmp`, `${dirBlockHeader(opts.mode, opts.global, opts.cwd)}\n${wrapForClient("claude", built.text)}`, { mode: 0o600 });
    fs.renameSync(`${files.text}.${process.pid}.tmp`, files.text);
  } catch {}
}

/** The warmer deletes a folder's block it has not refreshed for this long; the script prints any block it finds. */
const DIR_BLOCK_MAX_AGE_MS = 24 * 60 * 60_000;

/** A folder's block is re-read at most this often by the starts it served. */
const DIR_BLOCK_REFRESH_MS = 60_000;

/**
 * After stable-feed.sh printed a folder's block (`cast _stable-context-served
 * <key> <session id>`): record what the session was given, and refresh the
 * folder's cache and block for the next start.
 */
export async function runStableContextServed(config: StableContextConfig | null, key: string, sessionId: string, dir?: string): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(key) || key.length > DIR_BLOCK_KEY_MAX || !config?.auth_token) return;
  const meta = readJson<DirBlockMeta>(dirBlockFiles(key, dir).meta);
  if (!meta) return;
  await Promise.all([
    /^[A-Za-z0-9-]{8,64}$/.test(sessionId) ? recordStableContext(config, { session_id: sessionId, data: meta.data }) : null,
    Date.now() - meta.at > DIR_BLOCK_REFRESH_MS ? refreshStableCache(config, { ...meta.opts, ...(dir ? { cacheDir: dir } : {}) }) : null,
  ]);
}

/** Caches used within this window are kept warm by the daemon. */
const STABLE_WARM_USED_WITHIN_MS = 3 * 24 * 60 * 60_000;
/** The daemon re-reads a cache once it is older than this. */
export const STABLE_WARM_EVERY_MS = 10 * 60_000;

/** Refresh the caches recent starts used, so a directory that sat idle does not start cold. */
export async function warmStableCaches(config: StableContextConfig | null, dir = stableCacheDir(), now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{32}\.json$/.test(n));
  } catch {
    return 0;
  }
  let warmed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    let usedAt = 0;
    try { usedAt = fs.statSync(file).mtimeMs; } catch { continue; }
    const cached = readJson<StableCacheFile>(file);
    if (!cached?.opts) continue;
    // Old org reads for single sessions are never read again.
    if (now - usedAt > STABLE_WARM_USED_WITHIN_MS) { fs.rmSync(file, { force: true }); continue; }
    if (now - cached.at < STABLE_WARM_EVERY_MS) continue;
    await refreshStableCache(config, { ...cached.opts, cacheDir: dir });
    // A refresh is not a use: keep the use time the window is judged by.
    try { fs.utimesSync(file, new Date(usedAt), new Date(usedAt)); } catch {}
    warmed++;
  }
  // Per-session leftovers: org reads, and blocks rendered for a launch whose hook never ran.
  // A folder's block the warmer no longer refreshes is past serving (stable-feed.sh serves a day at most).
  for (const name of fs.readdirSync(dir).filter((n) => n.startsWith("org-") || n.startsWith("rendered-"))) {
    const file = path.join(dir, name);
    const maxAge = name.startsWith("rendered-dir-") ? DIR_BLOCK_MAX_AGE_MS : SESSION_WHERE_MAX_AGE_MS;
    try { if (now - fs.statSync(file).mtimeMs > maxAge) fs.rmSync(file, { force: true }); } catch {}
  }
  return warmed;
}

function renderedStableFile(conversationId: string, dir = stableCacheDir()): string | null {
  return /^[a-z0-9]+$/.test(conversationId) ? path.join(dir, `rendered-${conversationId}.txt`) : null;
}

/** How long a launch waits for its own session's org read before it renders from the cache. */
const LAUNCH_ORG_BUDGET_MS = 3_000;

/**
 * For a Claude session the daemon is about to launch: render its block now and
 * leave it where the SessionStart hook prints it with no process to start, then
 * record it. The session's own org read (its lead, its binding) is waited for
 * briefly; everything else renders from the cache, which is refreshed after.
 * Runs beside the launch, so it is usually done before Claude reaches its hooks;
 * when it is not, the hook builds the block itself.
 */
export async function prepareLaunchStableContext(config: StableContextConfig | null, opts: BuildStableContextOptions & { session: string }): Promise<void> {
  if (!config?.auth_token || !config?.convex_url) return;
  const file = renderedStableFile(opts.session, opts.cacheDir);
  if (!file) return;
  const auth = { auth_token: config.auth_token, convex_url: config.convex_url };
  const scope = stableScope(auth, opts);
  const own = await within(fetchOrgWhere(scope.siteUrl, auth.auth_token, opts.session), LAUNCH_ORG_BUDGET_MS);
  if (own) writeJson(scope.sessionFile(opts.session), { at: Date.now(), where: own });
  const built = await buildStableContext(config, { ...opts, start: { budgetMs: LAUNCH_ORG_BUDGET_MS, source: "startup" } });
  if (!built) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.${process.pid}.tmp`, wrapForClient("claude", built.text), { mode: 0o600 });
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
  } catch {
    return;
  }
  await Promise.all([
    recordStableContext(config, { conversation_id: opts.session, data: built.data }),
    built.stale ? refreshStableCache(config, opts) : null,
  ]);
}

/**
 * The most text a session-start hook may hand an agent. Claude Code delivers
 * hook output whole up to about 9.8KB; past that the agent sees a 2KB preview
 * and a file path, so everything after the opening lines is lost. 702 of 748
 * sessions in three days of 2026-10 were cut that way, and with them every
 * mod's and the org's instructions, which came last.
 */
export const STABLE_CONTEXT_BUDGET = 9_000; // bytes

/**
 * Render the org, mods and flows lead and the <stable-context> feed block.
 * Every session waits on its SessionStart hooks before it takes its first
 * message, so a start (`opts.start`) never waits on the network when an
 * earlier start in the scope left a cache. Whatever reads are missing are left
 * out; undefined only when nothing at all could be read.
 */
export async function buildStableContext(
  config: StableContextConfig | null,
  opts: BuildStableContextOptions,
): Promise<BuiltStableContext | undefined> {
  if (!config?.auth_token || !config?.convex_url) return undefined;
  const auth = { auth_token: config.auth_token, convex_url: config.convex_url };
  const scope = stableScope(auth, opts);
  const { projectPath } = scope;
  const limit = opts.mode === "team" ? 15 : 10;
  const exclude = opts.exclude ?? [];

  let reads: StableReads;
  let stale = false;
  const cached = opts.start ? readJson<StableCacheFile>(scope.file) : null;
  if (cached) {
    // A use: the daemon keeps used caches warm.
    try { fs.utimesSync(scope.file, new Date(), new Date()); } catch {}
    reads = { ...cached.reads };
    stale = true;
    const own = opts.session ? readJson<{ at: number; where: OrgWhere }>(scope.sessionFile(opts.session)) : null;
    if (own && Date.now() - own.at <= SESSION_WHERE_MAX_AGE_MS) reads.where = own.where;
    else if (opts.start?.source && opts.start.source !== "startup") {
      // A resumed session has a title, a binding and perhaps a lead of its own: ask, briefly.
      reads.where = (await within(fetchOrgWhere(scope.siteUrl, auth.auth_token, opts.session), opts.start.budgetMs))
        ?? (reads.where && whereForNewSession(reads.where, opts.session));
    } else reads.where = reads.where && whereForNewSession(reads.where, opts.session);
  } else {
    reads = await liveStableReads(auth, opts, opts.start?.budgetMs);
    stale = !!opts.start && (!reads.feed || !reads.mods || !reads.pool || !reads.where);
    if (opts.start && !stale) writeJson(scope.file, { at: Date.now(), opts: { mode: opts.mode, global: opts.global, cwd: opts.cwd }, reads } satisfies StableCacheFile);
  }

  try {
    // What agents must act on (the org, the mods' objects and blocks) leads;
    // the feed is background and gives up its oldest conversations to fit.
    const orgBlock = reads.where?.roles?.length ? `\n\n${orgContextBlock(reads.where)}` : "";
    const lead = `${orgBlock}${reads.mods ?? ""}${!reads.pool || reads.pool.flowsOn === false ? "" : await flowsLine(opts.cwd, reads.pool.rows)}`.trim();
    const result = reads.feed;
    if (!result && !lead) return undefined;

    let conversations = ((result?.conversations ?? []) as any[])
      .filter((conv) => !isExcludedStableItem(String(conv.id ?? ""), exclude))
      .slice(0, limit);
    const verifyNote =
      "This is a snapshot from session start — `cast feed` / `cast sessions` give the current picture. " +
      "Before attributing work to a session or messaging it about its work, check its evidence: `cast diff <id>` shows the files it changed, `cast read <id>` its recent turns. " +
      "A session's state says who is paying attention now, not who wrote what.";
    const instruction = opts.mode === "team"
      ? `This gives you bigger-picture visibility on what has been and is being worked on by the team.\n${verifyNote}`
      : `This gives you bigger-picture visibility on what you have been and are currently working on.\n${verifyNote}`;

    const render = () => {
      if (!result) return lead;
      const feed = stripAnsi(formatFeedResults({ ...result, conversations }, { projectPath }));
      return `${lead ? `${lead}\n\n` : ""}<stable-context mode="${opts.mode}">\n${instruction}\n\n${feed}\n</stable-context>`;
    };
    let text = render();
    while (Buffer.byteLength(text) > STABLE_CONTEXT_BUDGET && conversations.length) {
      conversations = conversations.slice(0, -1);
      text = render();
    }

    const items: StableContextItem[] = conversations.map((conv) => ({
      id: String(conv.id),
      title: String(conv.title ?? "Untitled"),
      project_path: conv.project_path ?? null,
      updated_at: conv.updated_at,
      message_count: conv.message_count,
      work_state: conv.work_state,
      is_live: conv.is_live,
      user_name: conv.user?.name ?? conv.user?.email ?? null,
      owner_name: conv.owner?.name ?? conv.owner?.email ?? null,
      owned_by_me: conv.owned_by_me,
    }));

    return {
      text,
      data: { mode: opts.mode, global: opts.global, injected_at: Date.now(), items },
      ...(stale ? { stale: true } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Where the session sits in the org (shared/contracts/orgWhere), or null when the read fails. */
async function fetchOrgWhere(siteUrl: string, apiToken: string, session?: string): Promise<OrgWhere | null> {
  const response = await fetch(`${siteUrl}/cli/org/where`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: apiToken, session }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const where = (await response.json()) as OrgWhere | null;
  return Array.isArray(where?.roles) ? where : null;
}

/**
 * One line naming the flows a change made here can run through (docs/architecture/flows.md FL7), read from this
 * checkout's pool with no network. Kept to one line: it rides the same 9000-byte budget the feed gives way to.
 */
export async function flowsLine(cwd?: string, pushed: ReadonlyArray<PushedPoolRow> = []): Promise<string> {
  try {
    // The pool's parser and templates load only here, so the CLI and the daemon don't carry them on every start.
    const [{ poolFlows }, { flowPathWords }] = await Promise.all([import("./workflow/flowPool.js"), import("@codecast/shared/contracts/flowPool")]);
    const pool = poolFlows(cwd ?? process.cwd(), null, pushed).filter((f) => f.takes.includes("branch") && !f.errors.length);
    if (!pool.length) return "";
    const lead = pool.find((f) => f.slug === "change") ?? pool[0];
    const segments = pool.filter((f) => f !== lead && f.kind === "segment").map((f) => f.slug);
    const lines = pool.filter((f) => f !== lead && f.kind === "line").map((f) => f.slug);
    const parts = [
      `the standard one is ${lead.slug} (${flowPathWords(lead).path})`,
      ...(segments.length ? [`the segments ${segments.join(", ")} each run one part of a change`] : []),
      ...(lines.length ? [`${lines.join(", ")} ${lines.length === 1 ? "is another whole line" : "are other whole lines"}`] : []),
    ];
    return `\n\n<flows>A finished change goes through a flow from the pool before it ships: ${parts.join("; ")}. \`cast flow run <flow>\` sends this session's own edits through one, and \`cast flow show <flow>\` says what each step does.</flows>`;
  } catch {
    return "";
  }
}

/** The team pool's published flows for a directory: its mapped team's, else none (session start reads no other
 *  team's). `flowsOn` says whether that workspace has the Flows feature on; undefined when the read failed or the
 *  server predates the flag, which leaves the line as it was. */
async function fetchDirectoryPool(siteUrl: string, apiToken: string, cwd?: string): Promise<{ rows: PushedPoolRow[]; flowsOn?: boolean } | null> {
  const team = teamForDirectory(await fetchMappedProjects(siteUrl, apiToken), cwd ?? process.cwd());
  const response = await fetch(`${siteUrl}/cli/workflows/pool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: apiToken, ...(team ? { team_id: team } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await response.json()) as { flows?: PushedPoolRow[]; flows_on?: boolean };
  if (!response.ok) return null;
  return { rows: team ? data.flows ?? [] : [], flowsOn: typeof data.flows_on === "boolean" ? data.flows_on : undefined };
}

/**
 * What the mods running for this person ask of agents in this project (their
 * objects, their blocks, their own instructions), as a block to follow the
 * org context, "" when none apply, or null when the read fails. A team's mod applies
 * only in that team's projects.
 */
async function fetchModsGuide(siteUrl: string, apiToken: string, cwd?: string): Promise<string | null> {
  const response = await fetch(`${siteUrl}/cli/mods/guide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: apiToken, ...(cwd ? { project_path: cwd } : {}) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const res = (await response.json()) as any;
  const text = res?.mods ? formatModGuide(res.mods) : "";
  return text ? `\n\n<mods>\nMods running for you add these to codecast. Use them where they fit.\n\n${text}\n</mods>` : "";
}

/** Report what was injected so the web can render it as cards at the top of
 * the conversation. Keyed by conversation_id when the daemon exported it
 * (web-started sessions), else by the agent session id — the server spools
 * records that arrive before the conversation row exists. Fire-and-forget
 * with a short cap so a slow network never delays session start. */
export async function recordStableContext(
  config: StableContextConfig | null,
  payload: { session_id?: string; conversation_id?: string; data: StableContextData },
): Promise<void> {
  if (!config?.auth_token || !config?.convex_url) return;
  if (!payload.session_id && !payload.conversation_id) return;
  const siteUrl = config.convex_url.replace(".cloud", ".site");
  try {
    await fetch(`${siteUrl}/cli/stable-context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        session_id: payload.session_id,
        conversation_id: payload.conversation_id,
        data: JSON.stringify(payload.data),
      }),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // Optional enhancement — never surface.
  }
}

/** Run the hidden session-start command without Commander or any of the CLI's
 * global lifecycle hooks. Stdout is reserved for the injected block because
 * the client consumes it as hook output. */
export async function runStableContextHook(
  config: StableContextConfig | null,
  client: StableHookClient = "claude",
): Promise<void> {
  // Hook payload on stdin: { session_id, cwd, source, ... }. Manual TTY runs
  // have no payload — fall back to process.cwd() and record by nothing.
  // Cursor's sessionStart payload has no cwd; it names workspace_roots instead.
  let payload: { session_id?: string; cwd?: string; source?: string; workspace_roots?: string[]; cursor_version?: string } = {};
  if (!process.stdin.isTTY) {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (raw) payload = JSON.parse(raw);
    } catch {
      // Malformed payload — still inject from defaults.
    }
  }

  // Cursor imports Claude user hooks and runs them with its own payload
  // (marked by cursor_version). Its native sessionStart hook already injects
  // the feed with the right envelope, so the Claude hook must stay silent
  // here — raw text would at best log a parse error in Cursor, at worst
  // double-inject if Cursor ever learns to read Claude hook stdout.
  if (client === "claude" && payload.cursor_version) return;

  // Env overrides (exported by the daemon from the new-session page's choice)
  // beat the machine config; no mode from either → nothing to inject.
  const launch = resolveStableLaunch(process.env, config ?? {});
  if (!launch.mode) return;

  const workspaceRoot = Array.isArray(payload.workspace_roots) ? payload.workspace_roots[0] : undefined;
  const buildOpts: BuildStableContextOptions = {
    mode: launch.mode,
    global: launch.global,
    exclude: launch.exclude,
    cwd: payload.cwd || workspaceRoot || process.cwd(),
    session: launch.conversationId || payload.session_id,
  };
  const built = await buildStableContext(config, { ...buildOpts, start: { budgetMs: STABLE_COLD_BUDGET_MS, source: payload.source } });
  if (!built) return;

  await new Promise<void>((resolve) => process.stdout.write(wrapForClient(client, built.text), () => resolve()));
  // The agent waits for this process to exit, so what follows the injection
  // runs in a detached child: the record of what was injected (the web renders
  // it as cards at the top of the conversation; the daemon-exported
  // conversation id avoids a lookup race, and terminal-started sessions fall
  // back to the agent session id, which the server spools until the
  // conversation registers), and a refresh of the cache this start read.
  startStableContextAfter({
    record: { conversation_id: launch.conversationId, session_id: payload.session_id, data: built.data },
    ...(built.stale || !hasDirBlock(buildOpts) ? { refresh: buildOpts } : {}),
  });
}

/** How long a start with no cache for its scope waits for each live read. */
export const STABLE_COLD_BUDGET_MS = 1_500;

interface StableContextAfterJob {
  record: { conversation_id?: string; session_id?: string; data: StableContextData };
  refresh?: BuildStableContextOptions;
}

function startStableContextAfter(job: StableContextAfterJob): void {
  try {
    const dir = path.join(defaultConfigDir(), "stable-cache");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `after-${process.pid}-${Date.now()}.job.json`);
    fs.writeFileSync(file, JSON.stringify(job), { mode: 0o600 });
    const { cmd, prefixArgs } = resolveCastInvocation();
    spawn(cmd, [...prefixArgs, STABLE_CONTEXT_AFTER_VERB, file], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Optional enhancement — never surface.
  }
}

/** The detached half of the hook: record what was injected, and refresh the cache it read. */
export async function runStableContextAfter(config: StableContextConfig | null, file: string): Promise<void> {
  let job: StableContextAfterJob;
  try {
    job = JSON.parse(fs.readFileSync(file, "utf-8"));
  } finally {
    fs.rmSync(file, { force: true });
  }
  await Promise.all([
    recordStableContext(config, job.record),
    job.refresh ? refreshStableCache(config, job.refresh) : null,
  ]);
}
