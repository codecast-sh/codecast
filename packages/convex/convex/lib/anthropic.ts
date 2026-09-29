// One call to the Anthropic Messages API on the deployment's own key, so a
// feature that needs a model never asks the caller's machine for one. Returns
// null when the key is missing or the call fails; the caller decides what a
// missing answer means.

/** The small model the server's summaries and briefs run on. */
export const CHEAP_MODEL = "claude-haiku-4-5-20251001";
/** Its list price in dollars per million tokens, for the cost a caller reports. */
export const CHEAP_MODEL_PRICE = { input: 1, output: 5 };

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ModelReply {
  text: string;
  usage: ModelUsage;
}

export async function callModel(args: {
  prompt: string;
  system?: string;
  max_tokens: number;
  model?: string;
  temperature?: number;
  label: string;
  /** Give up after this long, so a stalled call cannot outlive its caller. */
  timeout_ms?: number;
}): Promise<ModelReply | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const abort = new AbortController();
  const timer = args.timeout_ms ? setTimeout(() => abort.abort(), args.timeout_ms) : undefined;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: abort.signal,
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: args.model ?? CHEAP_MODEL,
        max_tokens: args.max_tokens,
        temperature: args.temperature ?? 0,
        ...(args.system ? { system: args.system } : {}),
        messages: [{ role: "user", content: args.prompt }],
      }),
    });
    if (!response.ok) {
      console.error(`${args.label} API error:`, response.status, (await response.text()).slice(0, 300));
      return null;
    }
    const data = await response.json();
    const text = (data.content?.[0]?.text ?? "").trim();
    if (!text) return null;
    return {
      text,
      usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 },
    };
  } catch (error) {
    console.error(`${args.label} failed:`, error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Dollars for a usage on the cheap model. */
export function cheapModelCost(usage: ModelUsage): number {
  return (usage.input_tokens * CHEAP_MODEL_PRICE.input + usage.output_tokens * CHEAP_MODEL_PRICE.output) / 1_000_000;
}
