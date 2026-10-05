import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import { overrideFor, priceFor } from "./meter";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * The pi model for a Claude model id, priced from the override table when it
 * lists the id (dated or not). A model pi-ai's catalog knows keeps its catalog
 * entry; an id only the table knows is built as an Anthropic Messages model.
 * An id neither knows throws, so no turn runs on a model nobody has priced.
 *
 * A built model declares no reasoning, so pi sends no `thinking` parameter and
 * the model uses its own default. Newer models think by default and that
 * thinking counts toward `max_tokens`, which is why the run leaves it room.
 */
export function resolveModel(modelId: string): Model<Api> {
  const known = getModel("anthropic", modelId as never) as Model<Api> | undefined;
  if (known) return { ...known, cost: priceFor(modelId, known) };
  const price = overrideFor(modelId);
  if (!price) throw new Error(`Unknown model "${modelId}": add its price to PRICE_OVERRIDES first`);
  return {
    id: modelId,
    name: modelId,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: ANTHROPIC_BASE_URL,
    reasoning: false,
    input: ["text", "image"],
    cost: price,
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}
