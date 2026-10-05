import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  getApiProvider,
  type AssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@mariozechner/pi-ai";
import { streamSimpleAnthropic } from "@mariozechner/pi-ai/anthropic";

/**
 * A stream that ends at once with an error message, the way pi's providers
 * report a failure (the loop's stream contract forbids throwing).
 */
export function errorStream(model: Model<Api>, error: unknown): AssistantMessageEventStream {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "error", reason: "error", error: message });
  stream.end(message);
  return stream;
}

/**
 * Streams one model call. Anthropic goes through a static import of pi-ai's
 * Anthropic provider; pi-ai's own `streamSimple` reaches every built-in
 * provider through a dynamic `import()`, which a Convex isolate refuses at
 * call time. Any other api (the faux provider in tests, one an app registers)
 * is looked up in pi-ai's provider registry.
 */
export const streamModel: StreamFn = (model, context, options) => {
  try {
    if (model.api === "anthropic-messages") {
      return streamSimpleAnthropic(model as Model<"anthropic-messages">, context, options);
    }
    const provider = getApiProvider(model.api);
    if (!provider) return errorStream(model, new Error(`No provider is registered for api "${model.api}"`));
    return provider.streamSimple(model, context, options);
  } catch (error) {
    return errorStream(model, error);
  }
};
