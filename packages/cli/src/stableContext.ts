// Stable-context building + recording, shared by the two injection paths:
//   - `cast stable-context` (the SessionStart hook for Claude Code) — resolves
//     env overrides, prints the block to stdout, records what it injected.
//   - the daemon's Codex threadStart (developerInstructions) — same builder,
//     records directly against the conversation it is spawning.
// One builder means the feed params, exclusion filtering, and the recorded
// item shape can never drift between agents.

import { editHarnessJson, removeHarnessFile, writeHarnessFile } from "./harness.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  isExcludedStableItem,
  resolveStableLaunch,
  STABLE_ENV_CONVERSATION_ID,
  STABLE_ENV_EXCLUDE,
  STABLE_ENV_GLOBAL,
  STABLE_ENV_MODE,
  type AgentClientId,
  type StableContextData,
  type StableContextItem,
  type StableFeedMode,
  type StableLaunchPrefs,
  type StableMode,
} from "@codecast/shared/contracts";
import { formatFeedResults } from "./formatter.js";
import type { PushedPoolRow } from "./workflow/flowPool.js";
import { fetchMappedProjects, teamForDirectory } from "./directoryTeam.js";
import { orgContextBlock, type OrgWhere } from "@codecast/shared/contracts/orgWhere";
import { formatModGuide } from "./mods/guide.js";
import { STABLE_FEED_HOOK_FILE } from "./codecastOwned.js";
import { defaultConfigDir, HOOK_STATE_DIR } from "./config/configDir.js";
import { resolveCastInvocation } from "./castInvocation.js";
import { spawn } from "./proc.js";
import { STABLE_CONTEXT_AFTER_VERB, STABLE_CONTEXT_SERVED_VERB } from "./fastPath.js";

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

/** Keys longer than this get no block (the script checks the same bound). */
const DIR_BLOCK_KEY_MAX = 200;

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
  return response.ok ? ((await response.json()) as OrgWhere) : null;
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

/** Clients whose session-start hook mechanism we install into. Each consumes
 * the same feed block; only the stdout envelope differs:
 *  - claude:   raw text (SessionStart hook stdout becomes context)
 *  - codex:    {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}
 *  - cursor:   {"additional_context":…} (sessionStart hook, JSON stdout required)
 *  - opencode: raw text (our plugin pushes stdout into the system prompt) */
export type StableHookClient = "claude" | "codex" | "cursor" | "opencode";

export const STABLE_HOOK_CLIENTS: readonly StableHookClient[] = ["claude", "codex", "cursor", "opencode"];

export function parseStableHookClient(value: string | undefined): StableHookClient {
  return (STABLE_HOOK_CLIENTS as readonly string[]).includes(value ?? "")
    ? (value as StableHookClient)
    : "claude";
}

/** A SessionStart block in the envelope `client` reads it from (also the
 *  task context after compaction, taskContextHook.ts). */
export function wrapForClient(client: StableHookClient, text: string): string {
  switch (client) {
    case "codex":
      return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } })}\n`;
    case "cursor":
      return `${JSON.stringify({ additional_context: text })}\n`;
    default:
      return `${text}\n`;
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

// ─── SessionStart hook install ────────────────────────────────────────────────
// The mode/scope resolution, feed build, exclusion filtering, and the record of
// what was injected all live in `codecast stable-context` — the script only
// gates the disabled case cheaply so a machine without stable mode never pays a
// node boot per session start. CODECAST_STABLE_MODE is the daemon's per-session
// override (may enable injection on a machine whose config has no stable_mode,
// or force it off). Installed by `cast stable` / the install flow, and
// refreshed by the daemon on boot so script updates ship with the CLI.

/** One script template for every client: cheap disabled-case gate (no node
 * boot on machines without stable mode), then exec the real command. The
 * `--client` flag only selects the stdout envelope. Claude's script omits the
 * flag so hook files installed by older CLI versions keep matching it. */
function stableFeedHookScript(client: StableHookClient): string {
  const clientArg = client === "claude" ? "" : ` --client ${client}`;
  return `#!/bin/bash
# CodeCast Stable Mode - injects recent session history on session start (${client})
set -uo pipefail

${HOOK_STATE_DIR}
CONFIG_FILE="$CC_DIR/config.json"

# Ensure codecast is on PATH (hooks run non-interactively)
export PATH="$HOME/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

${client === "claude" ? `# A session the daemon launched finds its block already rendered (prepareLaunchStableContext):
# printed with shell builtins, once (emptied as it is read).
case "\${${STABLE_ENV_CONVERSATION_ID}:-}" in
  ""|*[!a-z0-9]*) ;;
  *)
    RENDERED="$CC_DIR/stable-cache/rendered-\${${STABLE_ENV_CONVERSATION_ID}}.txt"
    if [ -s "$RENDERED" ]; then
      BODY=""
      IFS= read -r -d '' BODY < "$RENDERED" || true
      : > "$RENDERED"
      printf '%s' "$BODY"
      exit 0
    fi
    ;;
esac

# A terminal start (no launch overrides from the daemon) prints its folder's
# block, rendered by the last refresh, with shell builtins only: a process here
# costs the agent tens of milliseconds on a loaded machine. A detached
# \`codecast ${STABLE_CONTEXT_SERVED_VERB}\` records it and refreshes it. A resume, a
# payload this can't read, or a folder with no block takes the full path.
if [ -z "\${${STABLE_ENV_CONVERSATION_ID}:-}\${${STABLE_ENV_EXCLUDE}:-}\${${STABLE_ENV_MODE}:-}\${${STABLE_ENV_GLOBAL}:-}" ]; then
  INPUT=""; CFG=""; BODY=""
  IFS= read -r -d '' INPUT || true
  [ -f "$CONFIG_FILE" ] && { IFS= read -r -d '' CFG < "$CONFIG_FILE" || true; }
  MODE=""; GLOBAL=0; CWD=""; SOURCE=""; SID=""
  RE_MODE='"stable_mode"[[:space:]]*:[[:space:]]*"(team|solo)"'
  RE_GLOBAL='"stable_global"[[:space:]]*:[[:space:]]*true'
  RE_CWD='"cwd"[[:space:]]*:[[:space:]]*"([^"\\\\]+)"'
  RE_SOURCE='"source"[[:space:]]*:[[:space:]]*"([a-z]*)"'
  RE_SID='"session_id"[[:space:]]*:[[:space:]]*"([A-Za-z0-9-]+)"'
  [[ $CFG =~ $RE_MODE ]] && MODE=\${BASH_REMATCH[1]}
  [[ $CFG =~ $RE_GLOBAL ]] && GLOBAL=1
  [[ $INPUT =~ $RE_CWD ]] && CWD=\${BASH_REMATCH[1]}
  [[ $INPUT =~ $RE_SOURCE ]] && SOURCE=\${BASH_REMATCH[1]}
  [[ $INPUT =~ $RE_SID ]] && SID=\${BASH_REMATCH[1]}
  case "$INPUT" in *cursor_version*) MODE="" ;; esac
  [ -n "$MODE" ] || exit 0
  KEY="$MODE-$GLOBAL-\${CWD//[^A-Za-z0-9._-]/_}"
  BLOCK="$CC_DIR/stable-cache/rendered-dir-$KEY.txt"
  if [ -n "$CWD" ] && [ \${#KEY} -le ${DIR_BLOCK_KEY_MAX} ] && { [ "$SOURCE" = startup ] || [ -z "$SOURCE" ]; } && [ -f "$BLOCK" ]; then
    IFS= read -r -d '' BODY < "$BLOCK" || true
    if [ "\${BODY%%$'\n'*}" = "$MODE|$GLOBAL|$CWD" ]; then
      printf '%s' "\${BODY#*$'\n'}"
      if command -v codecast >/dev/null 2>&1; then
        nohup codecast ${STABLE_CONTEXT_SERVED_VERB} "$KEY" "\${SID:-none}" >/dev/null 2>&1 </dev/null &
      fi
      exit 0
    fi
  fi
  command -v codecast >/dev/null 2>&1 || exit 0
  printf '%s' "$INPUT" | codecast stable-context
  exit 0
fi

` : ""}if [ -z "\${CODECAST_STABLE_MODE:-}" ]; then
  [ -f "$CONFIG_FILE" ] || exit 0
  grep -q '"stable_mode"' "$CONFIG_FILE" 2>/dev/null || exit 0
fi

command -v codecast >/dev/null 2>&1 || exit 0
exec codecast stable-context${clientArg}
`;
}

export const STABLE_FEED_HOOK = stableFeedHookScript("claude");

export function installStableHook(): void {
  const home = process.env.HOME || "";
  const hookFile = path.join(home, ".claude", "hooks", STABLE_FEED_HOOK_FILE);
  const settingsFile = path.join(home, ".claude", "settings.json");

  try {
    writeHarnessFile(hookFile, STABLE_FEED_HOOK, "stable-context", { mode: 0o755, executable: true });
    editHarnessJson(settingsFile, "stable-context", (settings) => {
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
      const hookArray = settings.hooks.SessionStart as any[];
      const alreadyPresent = hookArray.some((matcher: any) =>
        (matcher.hooks || []).some((h: any) => h.command?.includes(STABLE_FEED_HOOK_FILE))
      );
      if (alreadyPresent) return;
      const hookEntry = { type: "command", command: hookFile, timeout: 30 };
      if (hookArray.length > 0 && hookArray[0].matcher === "") {
        hookArray[0].hooks = hookArray[0].hooks || [];
        hookArray[0].hooks.push(hookEntry);
      } else {
        hookArray.unshift({ matcher: "", hooks: [hookEntry] });
      }
    });
  } catch {
    // Ignore errors - hook is optional enhancement
  }
}

// ─── Codex / Cursor / opencode hook install ──────────────────────────────────
// Same feed, three more delivery mechanisms. The wrapper scripts live under
// ~/.codecast/hooks/ (codecast-owned — client dot-dirs only get a config
// entry pointing at them). Every installer is a no-op when the client's
// dot-dir is absent, so enabling stable mode on a machine without a client
// touches nothing of that client's.

export function codecastHooksDir(): string {
  return path.join(defaultConfigDir(), "hooks");
}

function writeStableHookScript(client: Exclude<StableHookClient, "claude">): string {
  const file = path.join(codecastHooksDir(), `stable-feed-${client}.sh`);
  writeHarnessFile(file, stableFeedHookScript(client), "stable-context", { mode: 0o755, executable: true });
  return file;
}

function readCodexConfig(codexDir: string): string {
  const configFile = path.join(codexDir, "config.toml");
  return fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf-8") : "";
}

/** Codex reads hooks.json only when the `hooks` feature flag is on (off by
 * default as of 0.146). Turn it on unless the user has set `hooks =` at all —
 * an explicit false is an opt-out we must respect. Line-level TOML surgery,
 * same spirit as the marked-snippet installers. `what` is the harness ledger's
 * cause. */
function ensureCodexHooksFeature(codexDir: string, what: string): void {
  const existing = readCodexConfig(codexDir);
  if (/^\s*hooks\s*=/m.test(existing)) return;
  const updated = /^\s*\[features\]\s*$/m.test(existing)
    ? existing.replace(/^(\s*\[features\]\s*)$/m, "$1\nhooks = true")
    : `${existing.trimEnd()}\n\n[features]\nhooks = true\n`.replace(/^\n+/, "");
  writeHarnessFile(path.join(codexDir, "config.toml"), updated, what);
}

/** Codex: merge a SessionStart entry into ~/.codex/hooks.json. Codex's hook
 * schema mirrors Claude's settings.json (matcher groups with nested hooks).
 * additionalContextLimit 0 disables Codex's default 2,500-token spill-to-file
 * truncation — the feed must arrive whole or not at all. */
export function installStableHookCodex(): void {
  installCodexSessionStartHook(() => writeStableHookScript("codex"), "stable-context", 30, { enableHooks: true });
}

export function removeStableHookCodex(): void {
  removeCodexSessionStartHook(path.join(codecastHooksDir(), "stable-feed-codex.sh"), "stable-context");
}

/** Register a SessionStart script in ~/.codex/hooks.json (written by
 *  `writeScript`, which returns its path). The hooks flag is global and
 *  wakes every hook in hooks.json, so only an explicit opt-in (stable mode)
 *  turns it on (`enableHooks`); any other caller installs only where Codex
 *  hooks are already on. A no-op without ~/.codex. Never throws: hooks are an
 *  optional enhancement. */
export function installCodexSessionStartHook(writeScript: () => string, what: string, timeout: number, opts: { enableHooks?: boolean } = {}): void {
  const codexDir = path.join(process.env.HOME || "", ".codex");
  if (!fs.existsSync(codexDir)) return;
  try {
    if (opts.enableHooks) ensureCodexHooksFeature(codexDir, what);
    else if (!/^\s*hooks\s*=\s*true\b/m.test(readCodexConfig(codexDir))) return;
    const hookFile = writeScript();
    editHarnessJson(path.join(codexDir, "hooks.json"), what, (config) => {
      if (!config.hooks) config.hooks = {};
      if (!config.hooks.SessionStart) config.hooks.SessionStart = [];
      const present = (config.hooks.SessionStart as any[]).some((matcher: any) =>
        (matcher.hooks || []).some((h: any) => h.command === hookFile),
      );
      if (present) return;
      config.hooks.SessionStart.push({
        hooks: [{ type: "command", command: hookFile, additionalContextLimit: 0, timeout }],
      });
    });
  } catch {}
}

/** Delete a SessionStart script and its ~/.codex/hooks.json entry. */
export function removeCodexSessionStartHook(hookFile: string, what: string): void {
  try { removeHarnessFile(hookFile, what); } catch {}
  try {
    editHarnessJson(path.join(process.env.HOME || "", ".codex", "hooks.json"), what, (config) => {
      if (!config.hooks?.SessionStart) return;
      for (const matcher of config.hooks.SessionStart) {
        if (matcher.hooks) {
          // Exact-path match so unrelated SessionStart hooks survive.
          matcher.hooks = matcher.hooks.filter((h: any) => h.command !== hookFile);
        }
      }
      config.hooks.SessionStart = config.hooks.SessionStart.filter((m: any) => m.hooks && m.hooks.length > 0);
    }, { createIfMissing: false });
  } catch {}
}

/** Cursor: merge a sessionStart entry into ~/.cursor/hooks.json. Flat entry
 * list per event (no matcher groups); the hook must print JSON with an
 * `additional_context` field, which `--client cursor` produces. */
export function installStableHookCursor(): void {
  const home = process.env.HOME || "";
  const cursorDir = path.join(home, ".cursor");
  if (!fs.existsSync(cursorDir)) return;

  try {
    const hookFile = writeStableHookScript("cursor");
    editHarnessJson(path.join(cursorDir, "hooks.json"), "stable-context", (config) => {
      if (config.version == null) config.version = 1;
      if (!config.hooks) config.hooks = {};
      if (!config.hooks.sessionStart) config.hooks.sessionStart = [];
      const present = (config.hooks.sessionStart as any[]).some((h: any) => h.command === hookFile);
      if (!present) config.hooks.sessionStart.push({ command: hookFile, timeout: 30 });
    });
  } catch {
    // Optional enhancement.
  }
}

export function removeStableHookCursor(): void {
  const home = process.env.HOME || "";
  const hookFile = path.join(codecastHooksDir(), "stable-feed-cursor.sh");
  try { removeHarnessFile(hookFile, "stable-context"); } catch {}

  try {
    editHarnessJson(path.join(home, ".cursor", "hooks.json"), "stable-context", (config) => {
      if (!config.hooks?.sessionStart) return;
      config.hooks.sessionStart = config.hooks.sessionStart.filter((h: any) => h.command !== hookFile);
      if (config.hooks.sessionStart.length === 0) delete config.hooks.sessionStart;
    }, { createIfMissing: false });
  } catch {}
}

/** opencode has no session-start hook yet (the upstream PR is unmerged), but
 * its plugin API exposes `experimental.chat.system.transform` — called on
 * every prompt build with the system-prompt array to extend. The plugin
 * fetches the feed once per session (cached promise) and pushes it into the
 * system prompt on every request, which keeps the feed present for the whole
 * session rather than only the first turn. */
function opencodeGlobalDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config");
  return path.join(xdg, "opencode");
}

function opencodeStablePlugin(scriptPath: string): string {
  return `// CodeCast Stable Mode — injects recent session history into the system prompt.
// Installed by \`cast stable\`; \`cast stable off\` removes it. Do not edit —
// the codecast daemon rewrites this file when the CLI updates.
export const CodecastStable = async ({ $, directory }) => {
  const script = ${JSON.stringify(scriptPath)};
  const cache = new Map();
  return {
    "experimental.chat.system.transform": async (input, output) => {
      const key = input.sessionID || "global";
      if (!cache.has(key)) {
        cache.set(key, (async () => {
          try {
            const payload = JSON.stringify({ session_id: input.sessionID, cwd: directory });
            const res = await $\`echo \${payload} | bash \${script}\`.quiet().nothrow();
            return res.exitCode === 0 ? res.text().trim() : "";
          } catch {
            return "";
          }
        })());
      }
      const text = await cache.get(key);
      if (text) output.system.push(text);
    },
  };
};
`;
}

export function installStableHookOpencode(): void {
  const ocDir = opencodeGlobalDir();
  if (!fs.existsSync(ocDir)) return;
  try {
    const scriptPath = writeStableHookScript("opencode");
    writeHarnessFile(path.join(ocDir, "plugins", "codecast-stable.js"), opencodeStablePlugin(scriptPath), "stable-context");
  } catch {
    // Optional enhancement.
  }
}

export function removeStableHookOpencode(): void {
  try { removeHarnessFile(path.join(codecastHooksDir(), "stable-feed-opencode.sh"), "stable-context"); } catch {}
  try { removeHarnessFile(path.join(opencodeGlobalDir(), "plugins", "codecast-stable.js"), "stable-context"); } catch {}
}

const HOOK_INSTALLERS: Record<StableHookClient, () => void> = {
  claude: installStableHook,
  codex: installStableHookCodex,
  cursor: installStableHookCursor,
  opencode: installStableHookOpencode,
};

/** Install the hook for every client present on this machine. Claude installs
 * unconditionally (its hook predates the per-client split); the others no-op
 * without their dot-dir. Used by `cast stable`, `cast install`, and the
 * daemon's boot refresh so script updates ship with the CLI. */
export function installAllStableHooks(): void {
  for (const client of STABLE_HOOK_CLIENTS) HOOK_INSTALLERS[client]();
}

export function removeAllStableHooks(): void {
  removeStableHook();
  removeStableHookCodex();
  removeStableHookCursor();
  removeStableHookOpencode();
}

/**
 * Ensure a launch that will actually inject stable context has this client's
 * session-start hook installed. This is intentionally evaluated per launch:
 * an explicit Team/Solo session can opt in on a machine whose configured
 * stable mode is off (and therefore had its hooks removed).
 */
export function ensureStableHookForLaunch(
  agentType: AgentClientId,
  configuredMode: StableMode | undefined,
  prefs: StableLaunchPrefs,
  installHook?: () => void,
): boolean {
  const effectiveMode = prefs.stable_mode ?? configuredMode;
  const installer = (HOOK_INSTALLERS as Partial<Record<AgentClientId, () => void>>)[agentType];
  if (!installer || (effectiveMode !== "team" && effectiveMode !== "solo")) {
    return false;
  }
  (installHook ?? installer)();
  return true;
}

export function removeStableHook(): void {
  const home = process.env.HOME || "";
  const hookFile = path.join(home, ".claude", "hooks", STABLE_FEED_HOOK_FILE);
  const settingsFile = path.join(home, ".claude", "settings.json");

  // The script contains no user data and is owned solely by Codecast. Removing
  // it as well as its settings entry makes `stable off` an actual uninstall.
  try { removeHarnessFile(hookFile, "stable-context"); } catch {}

  editHarnessJson(settingsFile, "stable-context", (settings) => {
    if (!settings.hooks?.SessionStart) return;
    for (const matcher of settings.hooks.SessionStart) {
      if (matcher.hooks) {
        // installStableHook writes this exact absolute path. Match it exactly so
        // an unrelated SessionStart integration with a similar filename survives.
        matcher.hooks = matcher.hooks.filter((h: any) => h.command !== hookFile);
      }
    }
    settings.hooks.SessionStart = settings.hooks.SessionStart.filter(
      (m: any) => m.hooks && m.hooks.length > 0
    );
  }, { createIfMissing: false });
}
