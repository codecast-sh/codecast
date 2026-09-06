import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionIdFromEnv } from "./sessionIdentity.js";
import { parseCodecastPaneRows, tmuxRunAsync } from "./tmux.js";
import { formatAgentPrompt, mergeAgentPromptSources, resolveAgentPromptSource } from "./agentPromptOrigin.js";

export async function runAgentPrompt(args: string[]): Promise<void> {
  let from: string | undefined;
  let subagent = false;
  for (let at = 0; at < args.length; at++) {
    if (args[at] === "--from" && args[at + 1]) from = args[++at];
    else if (args[at] === "--subagent") subagent = true;
    else throw new Error("Usage: cast _agent-prompt [--from <session>] [--subagent] < prompt.txt");
  }
  const dir = join(process.env.HOME || "", ".codecast");
  const read = (name: string) => existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : {};
  const cache = mergeAgentPromptSources(read("conversations.json"), read("app-server-threads.json"));
  const explicit = from ?? sessionIdFromEnv() ?? undefined;
  if (!from) {
    const refs = ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODECAST_SESSION_ID", "CODECAST_MANAGED_SESSION"]
      .map(key => process.env[key]).filter((ref): ref is string => !!ref);
    const sources = refs.map(ref => resolveAgentPromptSource(ref, cache));
    if (sources.includes(undefined) || new Set(sources).size > 1) throw new Error("Ambiguous sending session. Pass --from <session> to the agent helper.");
  }
  let source = resolveAgentPromptSource(explicit, cache);
  if (!explicit && process.env.TMUX) {
    const pane = await tmuxRunAsync(["display-message", "-p", "-t", process.env.TMUX_PANE || "", "#{@codecast_session_id}|#{session_created}|#{session_name}"]);
    if (pane.status === 0) {
      const [senderPane] = parseCodecastPaneRows(pane.stdout);
      source = resolveAgentPromptSource(senderPane?.sessionId ?? undefined, cache);
      if (senderPane && !senderPane.sessionId) {
        const launch = read("tmux-spawns.json")[senderPane.tmux];
        const elapsed = senderPane.createdSec * 1000 - launch?.timestamp;
        if (elapsed >= -1000 && elapsed < 300_000) source = resolveAgentPromptSource(launch?.parent, cache);
      }
    }
  }
  if (!source) throw new Error("Cannot identify the sending session. Pass --from <session> to the agent helper.");
  const body = await Bun.stdin.text();
  process.stdout.write(formatAgentPrompt(source, body.replace(/\n$/, ""), subagent));
}
