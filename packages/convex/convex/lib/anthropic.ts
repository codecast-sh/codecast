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

/**
 * One Messages API request, as the server sends it. The evals replay the same
 * object, so a prompt measured offline is the prompt prod posts.
 */
export type SurfaceRequest = {
  model: string;
  system?: string;
  prompt: string;
  max_tokens: number;
  /** Left out of the body when undefined, so the API default applies. */
  temperature?: number;
};

/**
 * The JSON body prod posts for a request. Key order is model, max_tokens,
 * temperature, system, messages: every server call site uses that order, so
 * JSON.stringify of this object is byte-identical to what each site sent.
 */
export function anthropicBody(req: SurfaceRequest) {
  return {
    model: req.model,
    max_tokens: req.max_tokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.system ? { system: req.system } : {}),
    messages: [{ role: "user" as const, content: req.prompt }],
  };
}

export async function callModel(args: Omit<SurfaceRequest, "model"> & {
  model?: string;
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
      body: JSON.stringify(
        anthropicBody({
          model: args.model ?? CHEAP_MODEL,
          system: args.system,
          prompt: args.prompt,
          max_tokens: args.max_tokens,
          temperature: args.temperature ?? 0,
        }),
      ),
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

// The JSON value the reply starts with. A model that answers `[]` and then
// explains why it stayed silent has still answered; the explanation is
// dropped, not the answer. Fences are stripped the same way.
export function parseJsonBlock(raw: string): unknown | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[\[{]/);
    if (start < 0) return null;
    const open = cleaned[start];
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inString = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }
}
