/**
 * @platform/agent: a hosted assistant's harness, a soft fork of pi
 * (`@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`, pinned at 0.73.1).
 *
 * Runtime neutral: no Node built-ins, safe in a Convex action. See README.md.
 */
export { defineTool, runTool, toAgentTool } from "./tool";
export type { Tool, ToolContent, ToolContext, ToolOutput, ToolRisk } from "./tool";
export { DEFAULT_MAX_TOKENS, MIN_OUTPUT_TOKENS, gateByRisk, runAssistant } from "./run";
export type {
  Gate,
  GateDecision,
  GateVerdict,
  Resolution,
  RunAssistantOptions,
  RunResult,
  StopReason,
  ToolCallRequest,
} from "./run";
export {
  FALLBACK_PRICE,
  PRICE_OVERRIDES,
  affordableOutputTokens,
  estimateTokens,
  listPrice,
  messageCost,
  priceFor,
  projectInputCost,
  usageCost,
} from "./meter";
export type { Price } from "./meter";
export { resolveModel } from "./models";
export { errorStream, streamModel } from "./stream";
export { messagesToRows, prepareContext, rowsToMessages } from "./history";
export type { ImageRow, MessageRow, RowMessage, ToolCallRow, ToolResultRow, UsageRow } from "./history";
export { UNTRUSTED_GUIDANCE, untrusted } from "./untrusted";
export type { UntrustedSource } from "./untrusted";
/** Typebox, as pi-ai re-exports it, for tool parameter schemas. */
export { Type } from "@mariozechner/pi-ai";
export type { Static, TSchema } from "@mariozechner/pi-ai";
