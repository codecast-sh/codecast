/**
 * `cast sync status | pull | push | diff | start | stop | keep`: a cloud
 * session's working folder and the laptop's, from either machine.
 *
 * On the cloud host the session is the one running (CODECAST_CONVERSATION_ID);
 * on a laptop it is named, or read from the laptop copy the shell stands in.
 * Every verb is carried out by the laptop that holds the session's copy
 * (cloud/syncRequests.ts, cloud/liveSyncJobs.ts), asked through Convex
 * (cloud.requestSync) and waited on here.
 */

import * as path from "node:path";
import type { Command } from "commander";
import { execFileSync } from "../proc.js";
import { fmt, icons } from "../colors.js";
import { isRemoteDevice, deviceId } from "../remote/device.js";

type Op = "status" | "pull" | "push" | "diff" | "start" | "stop" | "keep";

const WAIT_MS: Record<Op, number> = { status: 120_000, pull: 15 * 60_000, push: 10 * 60_000, diff: 120_000, start: 120_000, stop: 60_000, keep: 120_000 };

interface Target { conversationId: string; label: string }

function gitOut(args: string[]): string | null {
  try { return execFileSync("git", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}

/** The session a verb is about: the server resolves a short id (cloud.requestSync). */
function resolveTarget(ref: string | undefined): Target {
  if (!ref && isRemoteDevice()) {
    const env = process.env.CODECAST_CONVERSATION_ID;
    if (!env) throw new Error("run this inside a cloud session, or name one: cast sync status <session>");
    return { conversationId: env, label: "this session" };
  }
  if (!ref) {
    // Standing in a laptop copy: its folder names the session.
    const top = gitOut(["rev-parse", "--show-toplevel"]);
    ref = top?.match(/\.codecast\/worktrees\/sync-([a-z0-9]{7})$/)?.[1];
  }
  if (!ref) throw new Error("name the cloud session: cast sync status <session> (its short id, from cast hosts ls)");
  return { conversationId: ref, label: ref.slice(0, 7) };
}

/**
 * A path as the laptop reads it: relative to where the command runs becomes
 * relative to the repo; `~/…` stays as is (the laptop's home); an absolute
 * path inside this repo or this home is rewritten the same way.
 */
export function requestPath(p: string, where: { cwd: string; repoRoot: string | null; home: string }): string {
  if (p === "~" || p.startsWith("~/")) return p;
  const abs = path.isAbsolute(p) ? p : path.resolve(where.cwd, p);
  if (where.repoRoot && (abs === where.repoRoot || abs.startsWith(where.repoRoot + path.sep))) return path.relative(where.repoRoot, abs) || ".";
  if (abs === where.home || abs.startsWith(where.home + path.sep)) return `~/${path.relative(where.home, abs)}`;
  return path.isAbsolute(p) ? p : path.relative(where.repoRoot ?? where.cwd, abs);
}

/** Ask the laptop for one verb and print its answer; the exit code. (Heavy imports load here, not at startup.) */
export async function runSyncVerb(op: Op, ref: string | undefined, extra: { paths?: string[]; ref?: string; keep?: "laptop" | "cloud"; mode?: "two_way" | "from_cloud" }): Promise<number> {
  const [{ convexClient }, { awaitCommandOutcome }, { serverErrorLine }] = await Promise.all([
    import("../remote/convexClient.js"), import("./askLaptop.js"), import("../browser/sync.js"),
  ]);
  const out = (l: string) => console.log(l);
  const bad = (m: string) => { console.error(`${fmt.error(icons.cross)} ${m}`); return 1; };
  const { client, token, api } = await convexClient();
  let target: Target;
  try { target = resolveTarget(ref); } catch (e) { return bad((e as Error).message); }
  const repoRoot = gitOut(["rev-parse", "--show-toplevel"]);
  const paths = extra.paths?.map((p) => requestPath(p, { cwd: process.cwd(), repoRoot, home: process.env.HOME || "" }));
  let asked: { command_id: string; device_id: string; label: string | null };
  try {
    asked = await client.mutation(api.cloud.requestSync, {
      api_token: token,
      conversation_id: target.conversationId,
      op,
      ...(paths?.length ? { paths } : {}),
      ...(extra.ref ? { ref: extra.ref } : {}),
      ...(extra.keep ? { keep: extra.keep } : {}),
      ...(extra.mode ? { mode: extra.mode } : {}),
      ...(!isRemoteDevice() ? { caller_device_id: deviceId() } : {}),
    });
  } catch (e) {
    const raw = (e as Error).message ?? String(e);
    if (/Could not find public function/i.test(raw)) return bad("this cast and its server disagree about sync; update cast (cast update)");
    return bad(serverErrorLine(raw));
  }
  const via = asked.label ?? asked.device_id.slice(0, 8);
  const row = await awaitCommandOutcome((id) => client.query(api.cloud.commandOutcome, { api_token: token, command_id: id }), asked.command_id, Date.now() + WAIT_MS[op]);
  if (!row) return bad(`no answer from ${via} yet; it may be busy or asleep. The request stays queued, so run it again in a minute`);
  if (row.error) return bad(row.error.replace(/^on the host: /, "on the cloud host: "));
  let lines: string[];
  try { lines = (JSON.parse(row.result ?? "{}") as { lines?: string[] }).lines ?? [String(row.result ?? "done")]; } catch { lines = [row.result ?? "done"]; }
  const [first = "done", ...rest] = lines;
  out(`${fmt.success(icons.check)} ${first}${op === "status" || op === "diff" ? "" : fmt.muted(` (via ${via})`)}`);
  for (const l of rest) out(op === "diff" ? l : fmt.muted(l));
  return 0;
}

/** Hang the sync verbs under the existing `sync` command (whose bare form still syncs transcripts). */
export function registerSyncVerbs(sync: Command): void {
  const session = "--session <id>";
  sync
    .command("status [session]")
    .description("What differs between this cloud session's folder and the laptop, and what stayed behind and why")
    .action(async (ref?: string) => process.exit(await runSyncVerb("status", ref, {})));
  sync
    .command("pull [paths...]")
    .description("Bring the laptop's changes here now; or just the named files or folders (a skipped one, or one outside the repo like ~/data/x.csv); or a branch only the laptop has with --ref")
    .option(session, "The cloud session (default: the one this runs in)")
    .option("--ref <branch>", "A branch or commit from the laptop's repo, fetched as laptop/<name>")
    .action(async (paths: string[], o: { session?: string; ref?: string }) => process.exit(await runSyncVerb("pull", o.session, { paths, ref: o.ref })));
  sync
    .command("push [paths...]")
    .description("Send this folder's changes to the laptop copy now; or just the named paths")
    .option(session, "The cloud session (default: the one this runs in)")
    .action(async (paths: string[], o: { session?: string }) => process.exit(await runSyncVerb("push", o.session, { paths })));
  sync
    .command("diff <path>")
    .description("The laptop's version of a file against this folder's")
    .option(session, "The cloud session (default: the one this runs in)")
    .action(async (p: string, o: { session?: string }) => process.exit(await runSyncVerb("diff", o.session, { paths: [p] })));
  sync
    .command("start [session]")
    .description("Keep a cloud session's folder in step with a copy on this laptop, both ways (or --watch-only)")
    .option("--watch-only", "Changes go from the cloud to the laptop only; an edit in the laptop copy pauses it")
    .action(async (ref: string | undefined, o: { watchOnly?: boolean }) => process.exit(await runSyncVerb("start", ref, { mode: o.watchOnly ? "from_cloud" : "two_way" })));
  sync
    .command("stop [session]")
    .description("Stop keeping the folders in step (both copies stay as they are)")
    .action(async (ref?: string) => process.exit(await runSyncVerb("stop", ref, {})));
  sync
    .command("keep <side> [paths...]")
    .description("For files changed on both sides, keep the laptop's or the cloud's version (all of them, or the named ones)")
    .option(session, "The cloud session (default: the one this runs in)")
    .action(async (side: string, paths: string[], o: { session?: string }) => {
      if (side !== "laptop" && side !== "cloud") { console.error(`${fmt.error(icons.cross)} keep laptop or keep cloud`); process.exit(1); }
      process.exit(await runSyncVerb("keep", o.session, { keep: side, paths }));
    });
}
