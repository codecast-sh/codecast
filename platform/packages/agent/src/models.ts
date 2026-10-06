import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import { overrideFor, priceFor } from "./meter";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** Providers a model id may name with a `provider/` prefix, each streamed
 *  through a static import (stream.ts streamModel). A bare id is Claude. */
const PREFIXED_PROVIDERS = new Set(["openai"]);

/**
 * The pi model for a model id. A bare id is a Claude model; `openai/<id>`
 * names a model in pi-ai's OpenAI catalog, priced from that catalog.
 *
 * For a Claude model id: the pi model, priced from the override table when it
 * lists the id (dated or not). A model pi-ai's catalog knows keeps its catalog
 * entry; an id only the table knows is built as an Anthropic Messages model.
 * An id neither knows throws, so no turn runs on a model nobody has priced.
 *
 * A built model declares no reasoning, so pi sends no `thinking` parameter and
 * the model uses its own default. Newer models think by default and that
 * thinking counts toward `max_tokens`, which is why the run leaves it room.
 */
export function resolveModel(modelId: string): Model<Api> {
  const slash = modelId.indexOf("/");
  if (slash > 0 && PREFIXED_PROVIDERS.has(modelId.slice(0, slash))) {
    const provider = modelId.slice(0, slash);
    const id = modelId.slice(slash + 1);
    const model = getModel(provider as never, id as never) as Model<Api> | undefined;
    if (!model) throw new Error(`Unknown model "${modelId}"`);
    return { ...model, cost: priceFor(id, model) };
  }
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
