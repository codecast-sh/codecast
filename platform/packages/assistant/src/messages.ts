// The Anthropic Messages API as the assistant's own tools reach it: one
// request shape, the post an app supplies (its key, its fetch), and the reply
// text. Dependency free, so an app's every model call can share it.

/** One Messages API request with a single user message. */
export type MessagesRequest = {
  model: string;
  system?: string;
  prompt: string;
  max_tokens: number;
  /** Left out of the body when undefined, so the API default applies. */
  temperature?: number;
  /** Tool definitions (server tools such as web_search included). Left out when undefined. */
  tools?: unknown[];
};

/** Posts one request on the app's key and returns the raw response, or null
 *  when the app has no key. */
export type MessagesPost = (req: MessagesRequest, opts?: { signal?: AbortSignal }) => Promise<Response | null>;

/**
 * The reply's text: every text block, in order, trimmed. Newer models can open
 * the reply with a block that carries no text (thinking), so the first block
 * is not the answer.
 */
export function replyText(data: any): string {
  return (Array.isArray(data?.content) ? data.content : [])
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("")
    .trim();
}
