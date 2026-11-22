// A person's ask on a stuck checkout from the pipeline page (pipeline.md PL6): tell the session that last wrote some of
// the conflicting files, or file the files no session wrote as a finding, as the daemon's level sweep would
// (cli land/checkoutReport tellWriters). Apart from checkouts.ts so the checkouts feed does not load the message path.

import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { workspaceGrantsAccess } from "./lib/accessKeys";
import { performSessionSend } from "./pendingMessages";
import { checkoutHash, levelAskClientId, levelAskWords, levelWriters, type CheckoutPageAsk, type CheckoutReport } from "@codecast/shared/contracts/checkouts";

/**
 * A person's ask on a stuck checkout from the pipeline page (dispatch askCheckout): `who` is a session that last wrote
 * some of the conflicting files, told of those files only in the words the daemon uses (contracts/checkouts
 * levelAskWords), or "finding", which files the files no session wrote as the daemon would (same fingerprint, so a
 * daemon's later finding is the same one). The row keeps the ask, so the page reads it as told.
 */
/** `at`: when the page painted the ask (kept, so the row's echo matches what the page shows); never later than now. */
export async function askCheckoutCore(ctx: any, userId: Id<"users">, checkoutId: string, who: string, at?: number) {
  const id = ctx.db.normalizeId("checkouts", checkoutId);
  const row: Doc<"checkouts"> | null = id ? await ctx.db.get(id) : null;
  if (!row || !(await workspaceGrantsAccess(ctx, userId, row.workspace))) throw new ConvexError("Checkout not found");
  const report = row.report as Omit<CheckoutReport, "repository" | "device_id" | "path">;
  const level = report?.level;
  if (level?.state !== "stuck") throw new ConvexError("This checkout is not stuck any more");
  const { writers, nobody } = levelWriters(report);
  const mine = who === "finding" ? nobody : writers.find((w) => w.conversation_id === who)?.files ?? [];
  if (!mine.length) throw new ConvexError(who === "finding" ? "Every conflicting file has a session that wrote it" : "That session wrote none of the conflicting files");
  const host = row.device_label?.trim() || "its machine";
  const { title, body } = levelAskWords({ path: row.path, upstream: report.upstream, behind: report.behind }, level, mine, null, { host, whose: who === "finding" ? "nobody" : "session" });
  const now = typeof at === "number" && Number.isFinite(at) ? Math.min(at, Date.now()) : Date.now();
  if (who === "finding") {
    await ctx.scheduler.runAfter(0, internal.signals.ingestAs, {
      user_id: userId,
      source: "level",
      kind: "bug",
      fingerprint: `level:${row.device_id}:${row.path}:${checkoutHash(mine)}`,
      title,
      detail_md: body,
      subject: `level:${row.repository}`,
      project_path: row.path,
      ...(row.team_id ? { team_id: row.team_id } : {}),
    });
  } else {
    // The daemon's ask carries the same client id, so the writer hears this episode once, whichever asks first.
    const client_id = levelAskClientId({ device_id: row.device_id, path: row.path, files: level.files, since: level.since, conversation: who });
    await performSessionSend(ctx, userId, { to: who, body: `${title}\n\n${body}`, intent: "request", wake: true, client_id });
  }
  const ask: CheckoutPageAsk = who === "finding"
    ? { at: now, since: level.since, files: mine.length, to: "finding" }
    : { at: now, since: level.since, files: mine.length, to: "session", conversation_id: who };
  // Only this episode's asks are worth keeping: an older one no longer counts as told.
  const kept = ((row.asks ?? []) as CheckoutPageAsk[]).filter((a) => a.since === level.since);
  await ctx.db.patch(row._id, { asks: [...kept, ask], updated_at: now });
  return { told: mine.length };
}
