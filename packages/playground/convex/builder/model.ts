// Clay's model. @platform/agent sends Claude its defaults; a build wants two
// things more: an effort set for small changes people sit and watch, and its
// thinking returned as short summaries that stream to the card, so the room
// sees Clay think instead of a silent pause. pi-ai's Anthropic provider sends
// both through onPayload, under an api name of Clay's own that the agent's
// stream finds in pi-ai's provider registry.
import { createAssistantMessageEventStream, registerApiProvider, type Api, type AssistantMessageEventStream, type Model } from "@mariozechner/pi-ai";
import { streamSimpleAnthropic } from "@mariozechner/pi-ai/anthropic";
import { resolveModel } from "@platform/agent";

const API = "clayground-anthropic";

export type Effort = "low" | "medium" | "high";

type Hooks = {
  effort: Effort;
  /** The thinking summary written so far in the current block. */
  onThinking?: (summary: string) => void;
};

type ClayModel = Model<Api> & { clay: Hooks };

/** A Claude model id as Clay runs it. */
export function clayModel(id: string, hooks: Hooks): Model<Api> {
  const model: ClayModel = { ...resolveModel(id), api: API, clay: hooks };
  return model;
}

function streamClay(model: Model<Api>, context: Parameters<typeof streamSimpleAnthropic>[1], options?: Parameters<typeof streamSimpleAnthropic>[2]) {
  const { clay, ...rest } = model as ClayModel;
  const inner = streamSimpleAnthropic({ ...rest, api: "anthropic-messages" }, context, {
    ...options,
    onPayload: async (payload, m) => {
      const params = ((await options?.onPayload?.(payload, m)) ?? payload) as Record<string, unknown>;
      return {
        ...params,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { ...(params.output_config as object | undefined), effort: clay.effort },
      };
    },
  });
  return clay.onThinking ? tapThinking(inner, clay.onThinking) : inner;
}

/** The same events, with each thinking delta also handed to `onThinking`. */
function tapThinking(inner: AssistantMessageEventStream, onThinking: (summary: string) => void): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of inner) {
      if (event.type === "thinking_delta") {
        const block = event.partial.content[event.contentIndex];
        if (block?.type === "thinking") onThinking(block.thinking);
      }
      out.push(event);
    }
  })();
  return out;
}

registerApiProvider({ api: API, stream: streamClay, streamSimple: streamClay });
