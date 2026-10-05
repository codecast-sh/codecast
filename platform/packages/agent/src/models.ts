import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import { PRICE_OVERRIDES, priceFor } from "./meter";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * The pi model for a Claude model id. A model pi-ai's catalog knows keeps its
 * catalog entry (with the override price when there is one); a newer id is
 * built as an Anthropic Messages model priced from the override table.
 *
 * A built model declares no reasoning, so pi sends no `thinking` parameter and
 * the model uses its own default. Newer models think by default and that
 * thinking counts toward `max_tokens`, which is why the run leaves it room.
 */
export function resolveModel(modelId: string): Model<Api> {
  const known = getModel("anthropic", modelId as never) as Model<Api> | undefined;
  if (known) {
    const override = PRICE_OVERRIDES[modelId];
    return override ? { ...known, cost: override } : known;
  }
  if (!modelId.startsWith("claude-")) throw new Error(`Unknown model "${modelId}"`);
  return {
    id: modelId,
    name: modelId,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: ANTHROPIC_BASE_URL,
    reasoning: false,
    input: ["text", "image"],
    cost: priceFor(modelId),
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}
