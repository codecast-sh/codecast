import { CLIENT_ERROR_BANNER_PREFIX, CODEX_SAFETY_ERROR_CODE, SAFETY_BANNER_PREFIX, isCodexSafetyError, type CodexTurnError } from "@codecast/shared/contracts";
import type { ParsedMessage } from "./parser.js";

export function codexTurnErrorMessage(turnId: string, error: CodexTurnError, timestamp: number, model?: string): ParsedMessage {
  const safety = isCodexSafetyError(error);
  const detail = error.message?.trim() || "Codex could not complete this turn.";
  return {
    uuid: `codex-turn-error-${turnId}`,
    role: "assistant",
    content: safety ? `${SAFETY_BANNER_PREFIX} ${CODEX_SAFETY_ERROR_CODE} · ${detail}` : `${CLIENT_ERROR_BANNER_PREFIX} ${detail}`,
    timestamp,
    model,
  };
}
