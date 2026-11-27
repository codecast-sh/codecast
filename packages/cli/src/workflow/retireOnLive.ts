// The daemon's half of retiring a session whose change is live (convex
// retireOnLive.ts, the `retire_on_live` command). The server picked it and
// proved its commits live; only this machine can see its checkout, so the call
// is made here, with the checks a run's end retire makes (runner.ts
// retireSubject): it has settled, no person took it over since its own work,
// and nothing it wrote differs from what landed. A changed file in the
// checkout that no session's edits account for (a script's output, a hand
// edit) may be its work too, so it keeps the session. Any doubt keeps it.
import * as fs from "node:fs";
import { cliFetch } from "../cliHttp.js";
import { gitTry } from "../wipSnapshot.js";
import { freezeAndAttribute, upstreamRef } from "../land/shipCheckout.js";
import { subjectOtherWork, subjectRow, subjectSettled, subjectTakenOver } from "./subjectPark.js";

type Call = (route: string, body: Record<string, unknown>) => Promise<any>;

export type RetireOnLiveArgs = {
  conversation_id: string;
  root?: string;
  /** When its own last edit or commit was: a person's message after it means a person is using it. */
  since: number;
  /** Its own commits that are live, newest first. */
  commits: Array<{ sha: string }>;
};

export async function retireOnLive(call: Call, args: RetireOnLiveArgs): Promise<{ retired: boolean; reason?: string }> {
  const keep = (reason: string) => ({ retired: false, reason });
  const landed = args.commits?.[0]?.sha;
  if (!args.conversation_id || !landed || typeof args.since !== "number") return keep("the ask names no session, commit or time");
  const row = await subjectRow(call, { conversationId: args.conversation_id, shortId: args.conversation_id.slice(0, 7) });
  if (!row) return keep("it cannot be read");
  const subject = { conversationId: args.conversation_id, shortId: row.short_id || args.conversation_id.slice(0, 7) };
  if (subjectTakenOver(row, { subject_watch_since: String(args.since) })) return keep("a person wrote to it after its own work");
  if (!subjectSettled(row) || row.work_state !== "done") return keep(`it is not done (${row.work_state ?? "unknown"})`);
  const root = args.root && fs.existsSync(args.root) ? (await gitTry(args.root, ["rev-parse", "--show-toplevel"]))?.trim() : null;
  if (!root) return keep("its checkout is not on this machine");
  const upstream = await upstreamRef(root).catch(() => null);
  if (!upstream) return keep("its checkout has no upstream");
  // Fetches upstream first, so the landed commit can be read.
  const other = await subjectOtherWork(root, subject, landed, upstream);
  if (other) return keep(other);
  const stray = await unclaimedChanges(root, upstream);
  if (stray) return keep(stray);
  // The server kills it only if nothing moved since this read and nothing would be cut off (cliRetireSession).
  const retired = await call("/cli/sessions/retire", { session: args.conversation_id, expected_message_count: row.message_count ?? 0 });
  return retired?.retired ? { retired: true } : keep(retired?.reason ?? "it could not be retired");
}

/** The command as the daemon runs it (daemon.ts executeRemoteCommand): its answer is the command's result. */
export async function runRetireOnLiveCommand(siteUrl: string, apiToken: string, commandArgs: string | undefined): Promise<{ retired: boolean; reason?: string }> {
  const call: Call = async (route, body) => {
    try {
      const resp = await cliFetch(`${siteUrl}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_token: apiToken, ...body }) });
      const data = await resp.json() as any;
      return !resp.ok || data?.error ? null : data;
    } catch {
      return null;
    }
  };
  return retireOnLive(call, commandArgs ? JSON.parse(commandArgs) : {});
}

/** Changed files in the checkout no session's edits account for, as a reason to keep, or null when there are none. */
async function unclaimedChanges(root: string, upstream: string): Promise<string | null> {
  try {
    const { paths, attribution } = await freezeAndAttribute(root, upstream);
    if (attribution.partial) return "its checkout's changes could not all be attributed";
    const stray = paths.filter((p) => !attribution.owners.has(p));
    return stray.length ? `its checkout has changes no session's edits account for: ${stray.slice(0, 5).join(", ")}${stray.length > 5 ? ` and ${stray.length - 5} more` : ""}` : null;
  } catch (err) {
    return `its checkout could not be read: ${err instanceof Error ? err.message : String(err)}`;
  }
}
