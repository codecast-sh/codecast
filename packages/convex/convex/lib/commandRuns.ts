// `cast decide --run` (shared/contracts/commandRun.ts): a decision whose card
// shows a cast command. A signed-in person's Run sends it to the asking
// session's machine (daemon run_cast), which runs it outside the session and
// reports back; the result is delivered to the session as the answer. A leaf:
// sessionDecisions calls in and hands over its delivery, so this file never
// imports that module graph.

import { RUN_OPTION, approvesCommandRun, clipRunOutput, commandLine, runResultText, type CommandRun } from "@codecast/shared/contracts/commandRun";
import { decisionAnswerClientId, parseDecisionAnswer } from "@codecast/shared/contracts/decisionAnswers";
import type { Doc, Id } from "../_generated/dataModel";
import { consumePresence, presenceRefusal } from "./presence";
import { isSessionOwner } from "../sessionOwners";

type Ctx = { db: any };
type Row = { _id: Id<"session_decisions">; conversation_id: Id<"conversations">; options: Array<{ label: string }>; run?: CommandRun };
type Verdict = { status: string; answer_index?: number };
type By = { kind: string; user_id?: Id<"users">; signed_in?: boolean; presence?: string };
/** Delivers the answer into the asking session, with the run's result after the tag. */
export type DeliverRunAnswer = (detail: string) => Promise<void>;

const approves = (row: Row, verdict: Verdict) => verdict.status === "answered" && approvesCommandRun(row, verdict.answer_index ?? -1);

/** Who may press Run: the account the asking session runs as, or one of its owners (a session a bot account runs is answered by its owner). */
async function mayRun(ctx: Ctx, conversation: Doc<"conversations"> | null, userId: Id<"users"> | undefined): Promise<boolean> {
  if (!conversation || !userId) return false;
  return String(conversation.user_id) === String(userId) || (await isSessionOwner(ctx, conversation._id, userId));
}

/**
 * Why `by` may not resolve this run decision, or null. Run executes a command
 * in the person's name, so it is the asking session's person's, signed in to
 * the app (never an api token, which the asking agent holds too), and it
 * takes Touch ID, since an agent may drive the person's signed-in browser.
 * Don't run and a dismissal stay one press. With no verdict the answer is
 * taken to run.
 */
export async function commandRunRefusal(ctx: Ctx, row: Row, by: By, verdict?: Verdict): Promise<string | null> {
  if (!row.run || (verdict && !approves(row, verdict))) return null;
  if (by.kind !== "user" || !by.signed_in) return `${RUN_OPTION} runs a command in your name: press it on the web or the phone, where you are signed in`;
  if (!(await mayRun(ctx, await ctx.db.get(row.conversation_id), by.user_id))) return `Only the person whose session asked can press ${RUN_OPTION}`;
  return await presenceRefusal(ctx, by.user_id!, "approve", String(row._id), by.presence);
}

/** What Touch ID confirms for pressing Run on `row`: the command itself, when the run still waits and `userId` may press it; else null. */
export async function runPresenceLabel(ctx: Ctx, row: Row, userId: Id<"users">): Promise<string | null> {
  if (row.run?.state !== "waiting") return null;
  return (await mayRun(ctx, await ctx.db.get(row.conversation_id), userId)) ? commandLine(row.run.argv) : null;
}

/**
 * A run decision was resolved. Returns true when the answer's delivery is
 * this file's: a Run that went to the machine is delivered with its result
 * when the machine reports (applyCommandRunReport), and one that cannot start
 * is delivered here with why. Don't run, a dismissal or a withdrawal mark the
 * command skipped and leave the ordinary delivery alone. A Run by anyone the
 * refusal would stop runs nothing (the belt to that brace).
 */
export async function settleCommandRun(ctx: Ctx, row: Row, verdict: Verdict, by: By, now: number, deliver: DeliverRunAnswer): Promise<boolean> {
  const run = row.run;
  if (!run || run.state !== "waiting") return false;
  if (!approves(row, verdict)) {
    await ctx.db.patch(row._id, { run: { ...run, state: "skipped", at: now } });
    return false;
  }
  const conversation: Doc<"conversations"> | null = await ctx.db.get(row.conversation_id);
  if (by.kind !== "user" || !by.signed_in || !(await mayRun(ctx, conversation, by.user_id))) return false;
  if (await consumePresence(ctx, by.user_id!, "approve", String(row._id), by.presence)) return false;
  const device_id = run.device_id ?? conversation?.owner_device_id;
  if (!conversation || !device_id) {
    const failed: CommandRun = { ...run, state: "failed", output: "No machine runs this session, so the command did not run.", at: now };
    await ctx.db.patch(row._id, { run: failed });
    await deliver(runResultText(failed));
    return true;
  }
  await ctx.db.patch(row._id, { run: { ...run, state: "queued", device_id, at: now } });
  await ctx.db.insert("daemon_commands", {
    user_id: conversation.user_id,
    command: "run_cast" as const,
    args: JSON.stringify({ decision_id: String(row._id), argv: run.argv, ...(run.cwd ? { cwd: run.cwd } : {}) }),
    created_at: now,
    target_device_id: device_id,
  });
  return true;
}

/**
 * The machine that took a run_cast reports it: `running` when it starts, then
 * `done` or `failed` with the exit and output, which reach the asking session
 * as the answer. Only the session's account reports, and only a run that was
 * sent (a stale or repeated report changes nothing).
 */
export async function applyCommandRunReport(
  ctx: Ctx,
  userId: Id<"users">,
  args: { decision_id: Id<"session_decisions">; state: "running" | "done" | "failed"; exit_code?: number; output?: string },
  deliver: (row: Row & Doc<"session_decisions">, detail: string) => Promise<void>,
): Promise<{ ok: boolean }> {
  const row: (Row & Doc<"session_decisions">) | null = await ctx.db.get(args.decision_id);
  const conversation: Doc<"conversations"> | null = row ? await ctx.db.get(row.conversation_id) : null;
  if (!row?.run || !conversation || String(conversation.user_id) !== String(userId)) throw new Error("Run not found");
  const open = args.state === "running" ? row.run.state === "queued" : row.run.state === "queued" || row.run.state === "running";
  if (!open) return { ok: false };
  const now = Date.now();
  const next: CommandRun = {
    ...row.run,
    state: args.state,
    at: now,
    ...(args.exit_code !== undefined ? { exit_code: args.exit_code } : {}),
    ...(args.output !== undefined ? { output: clipRunOutput(args.output) } : {}),
  };
  await ctx.db.patch(row._id, { run: next });
  if (args.state !== "running") await deliver(row, runResultText(next));
  return { ok: true };
}

/**
 * Why a message may not enter a session, when it claims a Run on a run card:
 * that answer is the server's alone, delivered with the command's output once
 * the machine ran it (its client id is the decision's own). A client built
 * before run cards sends a bare "Decision: Run" whether or not anything ran,
 * which would tell the agent its command ran when it did not.
 */
export async function clientRunAnswerRefusal(ctx: Ctx, content: string, clientId: string | undefined): Promise<string | null> {
  const answer = parseDecisionAnswer(content);
  if (!answer?.id || answer.answer !== RUN_OPTION) return null;
  if (clientId === decisionAnswerClientId(answer.id)) return null;
  const id = ctx.db.normalizeId?.("session_decisions", answer.id);
  const row = id ? await ctx.db.get(id) : null;
  return row?.run ? "This app is out of date: Run on this card needs the current version, which confirms with Touch ID and returns the command's output" : null;
}
