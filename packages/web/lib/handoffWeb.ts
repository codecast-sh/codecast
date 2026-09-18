import { api } from "@codecast/convex/convex/_generated/api";
import type { ConvexReactClient } from "convex/react";
import { findModelOption } from "@codecast/shared/contracts";

// Web caller for the session handoff action (`handoff.start`, the same action
// `cast handoff --to <agent>` runs). The action summarizes the source session
// with Haiku, composes the starting brief with `cast read` pointers, starts a
// fresh session on the chosen agent/model, and links both rows
// (handed_off_from / handed_off_to). Both web initiators (the header session
// control panel and the Cmd+K `agent_handoff` mode) funnel through here.

export interface StartHandoffArgs {
  conversation_id: string;
  /** Convex agent_type ("claude_code", "codex", …). Omitted = the source's own. */
  agent_type?: string;
  /** Picker option key ("opus", "gpt-5.5", "anthropic/claude-opus-4-8"); "default" = omit. */
  model?: string;
  effort?: string;
  /** Operator text for the new session's "Direction" section. */
  direction?: string;
}

export interface StartHandoffResult {
  conversation_id: string;
  short_id: string;
  agent_type: string;
}

/** The launch flag value for a picker key: the option's cliAlias (the same
 *  value `cast handoff --model` takes), a dynamic id as-is, nothing for
 *  "default". */
export function handoffModelFlag(agentType: string | undefined, key: string | undefined): string | undefined {
  if (!key || key === "default") return undefined;
  return findModelOption(agentType, key)?.cliAlias ?? key;
}

export async function startHandoff(
  client: Pick<ConvexReactClient, "action">,
  args: StartHandoffArgs,
): Promise<StartHandoffResult> {
  const effort = args.effort && args.effort !== "default" ? args.effort : undefined;
  const direction = args.direction?.trim() || undefined;
  const result = await client.action(api.handoff.start, {
    conversation_id: args.conversation_id,
    agent_type: args.agent_type as any,
    model: handoffModelFlag(args.agent_type, args.model),
    effort,
    direction,
  });
  const session = (result as any)?.session as { conversation_id: string; short_id: string; agent_type: string } | null;
  if (!session) throw new Error("Handoff did not start a session");
  return { conversation_id: String(session.conversation_id), short_id: session.short_id, agent_type: session.agent_type };
}

/** The one-line explanation every handoff surface shows above its submit. */
export const HANDOFF_EXPLAINER =
  "The new session starts from a Haiku brief of this one, with commands to read the rest. This session is pinned as handed off.";
