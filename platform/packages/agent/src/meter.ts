// Pricing and the cost meter. This module imports only types, so it is safe to
// import from anywhere (`@platform/agent/meter`) without loading pi-ai.
import type { Api, AssistantMessage, Context, Model, Usage } from "@mariozechner/pi-ai";

/** Dollars per million tokens for each kind of token a call bills. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A list price from its input and output rates: cache reads bill at a tenth of input, cache writes at 1.25x. */
export function listPrice(input: number, output: number): Price {
  return { input, output, cacheRead: input / 10, cacheWrite: input * 1.25 };
}

/**
 * What we bill each Claude model at, by its undated id. This table is the one
 * price source: it wins over pi-ai's catalog and whatever price a provider
 * reports, and codecast's own model calls (`modelCost` in
 * convex/lib/anthropic.ts) read it too.
 */
export const PRICE_OVERRIDES: Readonly<Record<string, Price>> = {
  "claude-sonnet-5-5": listPrice(2, 10),
  "claude-opus-5-5": listPrice(4, 20),
  "claude-haiku-4-5": listPrice(1, 5),
};

/** The price for a model nothing else names: the dearest entry in the table, so a cap is not undercounted for a model we know of. */
export const FALLBACK_PRICE: Price = PRICE_OVERRIDES["claude-opus-5-5"];

/** Strips a snapshot date (`claude-haiku-4-5-20251001` is priced as `claude-haiku-4-5`). */
export function baseModelId(modelId: string): string {
  return modelId.replace(/-\d{8}$/, "");
}

/** The table's price for a model id, dated or not; undefined when the table does not list it. */
export function overrideFor(modelId: string): Price | undefined {
  return PRICE_OVERRIDES[modelId] ?? PRICE_OVERRIDES[baseModelId(modelId)];
}

/**
 * The price a model id bills at: the table first, then the model's own
 * catalog price when it has one, then the fallback.
 */
export function priceFor(modelId: string, model?: Pick<Model<Api>, "cost">): Price {
  const override = overrideFor(modelId);
  if (override) return override;
  const cost = model?.cost;
  if (cost && (cost.input > 0 || cost.output > 0)) return cost;
  return FALLBACK_PRICE;
}

/** Dollars for a usage at a price. */
export function usageCost(usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">, price: Price): number {
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

/** True for a message the stream did not finish: cancelled, past the deadline, or failed. */
export function wasCutOff(message: Pick<AssistantMessage, "stopReason">): boolean {
  return message.stopReason === "aborted" || message.stopReason === "error";
}

/** An estimate of the output tokens a message streamed: its text, its thinking and its tool call arguments. */
export function streamedOutputTokens(message: Pick<AssistantMessage, "content">): number {
  let tokens = 0;
  for (const block of message.content) {
    if (block.type === "text") tokens += estimateTokens(block.text);
    else if (block.type === "thinking") tokens += estimateTokens(block.thinking);
    else if (block.type === "toolCall") tokens += estimateTokens(block.name + JSON.stringify(block.arguments ?? {}));
  }
  return tokens;
}

/**
 * The usage a message is billed at. pi-ai's Anthropic provider reports the
 * output count of the stream's first event and updates it only at the end, so
 * a message cut off midway reports almost no output, while the API bills
 * every token it generated before the disconnect. For such a message, output
 * is raised to the estimate of what streamed. Pass the message as it
 * streamed, before any of its blocks are dropped.
 */
export function billedUsage(message: Pick<AssistantMessage, "usage" | "content" | "stopReason">): Usage {
  const usage = message.usage;
  if (!wasCutOff(message)) return usage;
  const output = Math.max(usage.output, streamedOutputTokens(message));
  if (output === usage.output) return usage;
  return { ...usage, output, totalTokens: usage.totalTokens + output - usage.output };
}

/**
 * Dollars one model message cost, at its `billedUsage`. A model the table
 * lists is priced from the table, whatever the provider reported. Otherwise
 * pi-ai's reported cost is used for a finished message, and the tokens are
 * priced here when that came to zero (a model it does not know, a test
 * provider) or the message was cut off.
 */
export function messageCost(message: AssistantMessage, model?: Pick<Model<Api>, "cost">): number {
  if (!message.usage) return 0;
  const usage = billedUsage(message);
  const override = overrideFor(message.model);
  if (override) return usageCost(usage, override);
  const reported = message.usage.cost?.total ?? 0;
  if (reported > 0 && usage === message.usage) return reported;
  return usageCost(usage, priceFor(message.model, model));
}

/**
 * An upper bound on the tokens a text takes. Each non-ASCII code point
 * counts as a token (two outside the Basic Multilingual Plane, such as most
 * emoji), and ASCII as a token every three characters. Real tokenizers do
 * better on English prose and close to this on CJK, dense JSON and ids.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) ascii++;
    else other += code > 0xffff ? 2 : 1;
  }
  return other + Math.ceil(ascii / 3);
}

/** Tokens charged for each image, whatever its size: the API scales images down to about this. */
export const IMAGE_TOKENS = 1_600;
/** Tokens the API adds to a request that carries tools: its tool use system preamble. */
export const TOOL_PREAMBLE_TOKENS = 600;
/** Tokens the API adds for each tool definition beyond its JSON. */
export const PER_TOOL_TOKENS = 50;
/** Tokens for message framing (roles, block separators) per message. */
export const PER_MESSAGE_TOKENS = 10;

/** An upper bound on the input tokens of a call with this context. */
export function estimateInputTokens(context: Context): number {
  let images = 0;
  const text = JSON.stringify([context.systemPrompt ?? "", context.messages, context.tools ?? []], (key, value) => {
    // Image bytes are billed by the image, not as text.
    if (value && typeof value === "object" && (value as { type?: unknown }).type === "image") {
      images++;
      return { type: "image", mimeType: (value as { mimeType?: unknown }).mimeType };
    }
    return value;
  });
  const tools = context.tools?.length ?? 0;
  return (
    estimateTokens(text) +
    images * IMAGE_TOKENS +
    context.messages.length * PER_MESSAGE_TOKENS +
    (tools > 0 ? TOOL_PREAMBLE_TOKENS + tools * PER_TOOL_TOKENS : 0)
  );
}

/**
 * The most the input of a call with this context should cost: the token
 * upper bound, every token billed at the dearer of fresh input and a cache
 * write (pi marks the system prompt, the last tool and the last message for
 * the cache, so a fresh context bills as cache writes). Cache reads bill at a
 * tenth, so the real cost is usually lower; the wallet trues up from the
 * run's metered cost.
 */
export function projectInputCost(context: Context, price: Price): number {
  return (estimateInputTokens(context) * Math.max(price.input, price.cacheWrite)) / 1_000_000;
}

/** How many output tokens the money left buys after the call's input. Never negative; 0 for a NaN amount. */
export function affordableOutputTokens(remainingUsd: number, inputUsd: number, price: Price): number {
  // A bad amount fails closed: only an explicit Infinity is unlimited.
  if (Number.isNaN(Number(remainingUsd)) || Number.isNaN(Number(inputUsd))) return 0;
  if (remainingUsd === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  const left = remainingUsd - inputUsd;
  if (left <= 0) return 0;
  if (price.output <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor((left * 1_000_000) / price.output);
}
