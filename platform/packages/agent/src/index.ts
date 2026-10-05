/**
 * @platform/agent: a hosted assistant's harness, a soft fork of pi
 * (`@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`, pinned at 0.73.1).
 *
 * Runtime neutral: no Node built-ins, safe in a Convex action. See README.md.
 */
export { defineTool, runTool, toAgentTool } from "./tool";
export type { RunToolContext, Tool, ToolContent, ToolContext, ToolOutput, ToolRisk } from "./tool";
export { DEFAULT_MAX_TOKENS, MAX_DEADLINE_MS, MIN_OUTPUT_TOKENS, THINKING_BUDGETS, gateByRisk, planOutput, runAssistant } from "./run";
export type {
  Gate,
  GateDecision,
  GateVerdict,
  OutputPlan,
  Resolution,
  RunAssistantOptions,
  RunResult,
  StopReason,
  ToolCallRequest,
} from "./run";
export {
  FALLBACK_PRICE,
  IMAGE_TOKENS,
  PER_MESSAGE_TOKENS,
  PER_TOOL_TOKENS,
  PRICE_OVERRIDES,
  TOOL_PREAMBLE_TOKENS,
  affordableOutputTokens,
  baseModelId,
  billedUsage,
  estimateInputTokens,
  estimateTokens,
  listPrice,
  messageCost,
  overrideFor,
  priceFor,
  projectInputCost,
  streamedOutputTokens,
  usageCost,
  wasCutOff,
} from "./meter";
export type { Price } from "./meter";
export { resolveModel } from "./models";
export { errorStream, streamModel } from "./stream";
export { MESSAGE_ROW_FIELDS, messagesToRows, prepareContext, rowsToMessages } from "./history";
export type { AbsentField, ImageRow, MessageRow, RowMessage, RowOrigin, ToolCallRow, ToolResultRow, UsageRow } from "./history";
export { UNTRUSTED_GUIDANCE, UNTRUSTED_MAX_CHARS, untrusted, untrustedBody } from "./untrusted";
export type { UntrustedOptions, UntrustedSource } from "./untrusted";
/** Typebox, as pi-ai re-exports it, for tool parameter schemas. */
export { Type } from "@mariozechner/pi-ai";
export type { Static, TSchema } from "@mariozechner/pi-ai";
