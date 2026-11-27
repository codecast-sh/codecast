// The delivery gate for a message that would resume a Claude Code subagent as
// its own process (daemon.ts deliverMessageIntoSession): it waits while the
// copy inside its parent's process may still run, and the agent goes on the
// SendMessage deny list first (subagentPromotion.ts). A workflow agent is
// refused later in delivery instead: it is never resumed. Kept apart from
// subagentPromotion.ts, which the PreToolUse hook's fast path loads.
import * as fs from "node:fs";
import { isWorkflowAgentTranscriptPath } from "./resumeCommand.js";
import { isSubagentTranscriptPath, readSubagentRunFacts, subagentRunState } from "./subagentFinish.js";
import { promotionHold } from "./subagentPromotion.js";
import { PromotionHoldError } from "./terminalHold.js";

export async function holdForInProcessSubagent(file: { path: string; agentType: string } | null, conversationId: string, configDir: string): Promise<void> {
  if (!file || file.agentType !== "claude" || !isSubagentTranscriptPath(file.path) || isWorkflowAgentTranscriptPath(file.path)) return;
  const reason = await promotionHold(file.path, conversationId.slice(0, 7), {
    configDir,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    runState: async (jsonlPath) => {
      const facts = await readSubagentRunFacts(jsonlPath);
      return facts ? subagentRunState(facts) : "running";
    },
    mtimeMs: (jsonlPath) => {
      try {
        return fs.statSync(jsonlPath).mtimeMs;
      } catch {
        return null;
      }
    },
  });
  if (reason) throw new PromotionHoldError(reason);
}
