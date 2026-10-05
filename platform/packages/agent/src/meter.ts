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
 * Prices for models pi-ai's generated catalog does not know, or knows at a
 * price we bill differently. These win over the catalog, so a turn on a new
 * model is never metered at zero.
 */
export const PRICE_OVERRIDES: Readonly<Record<string, Price>> = {
  "claude-sonnet-5-5": listPrice(2, 10),
  "claude-opus-5-5": listPrice(4, 20),
  "claude-haiku-4-5": listPrice(1, 5),
};

/** The price for a model nothing else names: the dearest override, so a cap never undercounts. */
export const FALLBACK_PRICE: Price = PRICE_OVERRIDES["claude-opus-5-5"];

/** Strips a snapshot date (`claude-haiku-4-5-20251001` is priced as `claude-haiku-4-5`). */
function baseModelId(modelId: string): string {
  return modelId.replace(/-\d{8}$/, "");
}

/**
 * The price a model id bills at: the override table first, then the model's
 * own catalog price when it has one, then the fallback.
 */
export function priceFor(modelId: string, model?: Pick<Model<Api>, "cost">): Price {
  const override = PRICE_OVERRIDES[modelId] ?? PRICE_OVERRIDES[baseModelId(modelId)];
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

/**
 * Dollars one model message cost. pi-ai prices usage from its catalog; when
 * that came to zero (a model it does not know, a test provider) the tokens are
 * priced here instead.
 */
export function messageCost(message: AssistantMessage, model?: Pick<Model<Api>, "cost">): number {
  const reported = message.usage?.cost?.total ?? 0;
  if (reported > 0) return reported;
  if (!message.usage) return 0;
  return usageCost(message.usage, priceFor(message.model, model));
}

/** A rough token count for text: four characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The most the input of a call with this context can cost: every token billed
 * as fresh input. Cache reads bill at a tenth, so the real cost is usually
 * lower; the wallet trues up after the run.
 */
export function projectInputCost(context: Context, price: Price): number {
  const text = JSON.stringify([context.systemPrompt ?? "", context.messages, context.tools ?? []]);
  return (estimateTokens(text) * price.input) / 1_000_000;
}

/** How many output tokens the money left buys after the call's input. Never negative. */
export function affordableOutputTokens(remainingUsd: number, inputUsd: number, price: Price): number {
  if (!Number.isFinite(remainingUsd)) return Number.POSITIVE_INFINITY;
  const left = remainingUsd - inputUsd;
  if (left <= 0) return 0;
  if (price.output <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor((left * 1_000_000) / price.output);
}
