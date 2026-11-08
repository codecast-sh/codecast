// Every write that puts words into Slack (chat.postMessage, chat.update) goes
// through slackSend, so the regulated data rule (plan pl-990) has one home.
//
// A team whose managed policy marks its data as regulated health data
// (`regulated_data`) sends Slack no transcript content (message text, session
// titles, tool output, summaries, call transcripts) until a team admin records
// that its Slack plan is covered by a BAA (`slack_baa_confirmed`). Until then a
// post carries one neutral line and a link back into Codecast, and nothing
// else: no blocks, no author name (an agent's name is its session title), no
// unfurl. slackSends.guard.test.ts fails a content write anywhere else.
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { TeamPolicy } from "@codecast/shared/contracts";
import { slackApi, type SlackResp } from "./slackApi";

export type SlackContentMethod = "chat.postMessage" | "chat.update";

/** Whose data a post carries, and where in Codecast a reader finds it. */
export type SlackSendScope = { team_id: Id<"teams"> | null | undefined; open_url: string };

/** Whether a team's Slack posts may carry transcript content. No team (a personal workspace) may. */
export function slackMayCarryContent(policy: TeamPolicy | null | undefined): boolean {
  return policy?.regulated_data !== true || policy.slack_baa_confirmed === true;
}

/** The neutral line a regulated team's post carries in place of its content. */
export function linkOnlyText(openUrl: string): string {
  return `New activity in Codecast: <${openUrl}|Open in Codecast>`;
}

// Only what places the post (channel, thread, the message an update edits)
// survives; everything that could carry content is dropped.
const PLACEMENT = ["channel", "ts", "thread_ts", "reply_broadcast"] as const;

export function linkOnlyParams(method: SlackContentMethod, params: Record<string, unknown>, openUrl: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PLACEMENT) if (params[k] !== undefined) out[k] = params[k];
  out.text = linkOnlyText(openUrl);
  // An edit must clear the blocks the earlier post may have carried.
  if (method === "chat.update") out.blocks = [];
  else Object.assign(out, { unfurl_links: false, unfurl_media: false });
  return out;
}

export async function slackSend(
  ctx: Pick<ActionCtx, "runQuery">,
  scope: SlackSendScope,
  token: string,
  method: SlackContentMethod,
  params: Record<string, unknown>,
): Promise<SlackResp> {
  const full = scope.team_id
    ? await ctx.runQuery(internal.slack.slackMayCarryContentFor, { team_id: scope.team_id })
    : true;
  return slackApi(token, method, full ? params : linkOnlyParams(method, params, scope.open_url));
}
