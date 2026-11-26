// `cast switch` — stay on this session and change the agent or model.
//
// Default is in-place: the conversation id does not change, a divider lands in
// the thread, and the live process is reconstituted as the new agent when the
// provider changes. `--fork` is the old behavior (a new inbox card).

import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import {
  LOCAL_AGENT_CLIENTS,
  InvalidExecutionAgentTypeError,
  parseExecutionAgentClientId,
  toConvexAgentType,
  type ConvexAgentType,
} from "@codecast/shared/contracts";
import { c, fmt } from "./colors.js";
import { apiPost, type PublishDeps } from "./castApi.js";
import { commandGroup } from "./commandGroupLookup.js";

const AGENT_NAMES = Object.keys(LOCAL_AGENT_CLIENTS).join(", ");

/** Accept "claude", "claude_code", "Codex", etc. */
export function parseSwitchAgentArg(raw: string): ConvexAgentType {
  const n = raw.trim().toLowerCase().replace(/\s+/g, "_");
  const aliased = n === "claude_code" ? "claude" : n;
  try {
    return toConvexAgentType(parseExecutionAgentClientId(aliased));
  } catch (err) {
    if (err instanceof InvalidExecutionAgentTypeError) {
      throw new Error(
        `Unknown agent "${raw}". Use one of: ${AGENT_NAMES}.`,
      );
    }
    throw err;
  }
}

/**
 * What a switch did, in the words the command prints. A same-agent model or
 * effort change is sent to the running session as slash commands that wait in
 * its queue like any message, so it has not taken effect when this returns.
 * It printed "applied" for a `/model opus` that sat behind a blocked queue,
 * and the session stayed on the model whose limit it had hit (2026-11-17).
 */
export function switchOutcome(result: { reconstituted?: boolean; blank?: boolean; live_commands?: string[] }): string {
  if (result.reconstituted) return "this session will resume as the new agent";
  if (result.blank) return "blank session relaunched";
  const sent = result.live_commands ?? [];
  return sent.length > 0
    ? `sent ${sent.join(" and ")} to the session; it changes when the session reads ${sent.length > 1 ? "them" : "it"}`
    : "recorded for the session's next launch; nothing was sent to the running session";
}

export function registerSwitchCommand(program: Command, deps: PublishDeps): void {
  program
    .command("switch")
    .description(commandGroup("switch").description)
    .option("--agent <name>", `Agent to continue as (${AGENT_NAMES})`)
    .option("--model <name>", "Model option key (opus, sonnet, gpt-5.4, …)")
    .option("--effort <level>", "Effort level (low, medium, high, max, …)")
    .option("-s, --session <id>", "Session to switch (default: the current one)")
    .option("--fork", "Create a new session instead of continuing here")
    .option("--json", "Machine-readable output")
    .action(async (options: {
      agent?: string;
      model?: string;
      effort?: string;
      session?: string;
      fork?: boolean;
      json?: boolean;
    }) => {
      const session = options.session || deps.detectCurrentSessionId();
      if (!session) {
        console.error("No session given and none detected: pass one with -s <id>");
        process.exit(1);
      }
      if (!options.agent && options.model === undefined && options.effort === undefined) {
        console.error("Nothing to switch: pass --agent <name>, --model <name> and/or --effort <level> (e.g. cast switch --model opus)");
        process.exit(1);
      }

      let agentType: ConvexAgentType | undefined;
      if (options.agent) {
        try {
          agentType = parseSwitchAgentArg(options.agent);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }

      if (options.fork) {
        if (!agentType) {
          console.error("--fork requires --agent");
          process.exit(1);
        }
        const forkKey = `forked-cli-${randomUUID()}`;
        const result = await apiPost(deps, "/cli/fork", {
          conversation_id: session,
          target_agent_type: agentType,
          session_id: forkKey,
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const shortId = result.short_id || String(result.conversation_id ?? "").slice(0, 7);
        console.log(
          `${c.green}ok${c.reset} forked as ${c.cyan}${shortId}${c.reset} ${fmt.muted(`— ${options.agent}`)}`,
        );
        return;
      }

      const result = await apiPost(deps, "/cli/sessions/switch", {
        session,
        ...(agentType ? { agent_type: agentType } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.effort !== undefined ? { effort: options.effort } : {}),
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const who = options.agent || options.model || options.effort;
      const how = switchOutcome(result);
      console.log(
        `${c.green}ok${c.reset} switched ${c.cyan}${result.short_id}${c.reset} ${fmt.muted(`— ${who} (${how})`)}`,
      );
    });
}
