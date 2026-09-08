import { CLIENT_ERROR_BANNER_PREFIX, CODEX_SAFETY_ERROR_CODE, SAFETY_BANNER_PREFIX, codexErrorCode, codexErrorKind, limitBannerContent, throttleBannerContent, type CodexTurnError } from "@codecast/shared/contracts";
import type { ParsedMessage } from "./parser.js";

// Why: the turn error's structured `codex_error_info` code is visible ONLY
// here, where codex's own event is parsed — the banner that reaches the server
// is just text. So this is the one place that can turn "usage_limit_exceeded"
// into a park the recovery chain recognizes, exactly as the Claude parser
// rewrites a burst 429 into the throttle banner (ct-49676).
function codexBannerContent(error: CodexTurnError, detail: string): string {
  switch (codexErrorKind(error)) {
    // More than one CodexErrorInfo code means safety now, so name the one that
    // actually fired. The fallback covers the prose-matched stop, which carries
    // no code at all.
    case "safety":
      return `${SAFETY_BANNER_PREFIX} ${codexErrorCode(error) ?? CODEX_SAFETY_ERROR_CODE} · ${detail}`;
    case "limit":
      return limitBannerContent(detail);
    case "throttle":
      return throttleBannerContent(detail, "Codex");
    default:
      return `${CLIENT_ERROR_BANNER_PREFIX} ${detail}`;
  }
}

export function codexTurnErrorMessage(turnId: string, error: CodexTurnError, timestamp: number, model?: string): ParsedMessage {
  const detail = error.message?.trim() || "Codex could not complete this turn.";
  return {
    uuid: `codex-turn-error-${turnId}`,
    role: "assistant",
    content: codexBannerContent(error, detail),
    timestamp,
    model,
  };
}
