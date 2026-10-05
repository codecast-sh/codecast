// One call to the Anthropic Messages API on the deployment's own key, so a
// feature that needs a model never asks the caller's machine for one. Returns
// null when the key is missing or the call fails; the caller decides what a
// missing answer means.

import { priceFor, usageCost } from "@platform/agent/meter";

/** The small model the server's summaries and briefs run on. */
export const CHEAP_MODEL = "claude-haiku-4-5-20251001";
/** The current Sonnet, for work the cheap model is too small for. It refuses any temperature. */
export const STRONG_MODEL = "claude-sonnet-5-5";

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
  /** Tool definitions (server tools such as web_search included). Left out when undefined. */
  tools?: unknown[];
};

/**
 * The JSON body prod posts for a request. Key order is model, max_tokens,
 * temperature, system, messages, tools: every server call site uses that
 * order, so JSON.stringify of this object is byte-identical to what each site
 * sent.
 */
export function anthropicBody(req: SurfaceRequest) {
  return {
    model: req.model,
    max_tokens: req.max_tokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.system ? { system: req.system } : {}),
    messages: [{ role: "user" as const, content: req.prompt }],
    ...(req.tools ? { tools: req.tools } : {}),
  };
}

/**
 * POST one request to the Messages API on the deployment's key: the one fetch
 * every server site goes through. Returns the raw response so a site that
 * reads the status or the usage can; null when the key is missing.
 */
export async function postMessages(req: SurfaceRequest, opts: { signal?: AbortSignal } = {}): Promise<Response | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: opts.signal,
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(anthropicBody(req)),
  });
}

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

export async function callModel(args: Omit<SurfaceRequest, "model"> & {
  model?: string;
  label: string;
  /** Give up after this long, so a stalled call cannot outlive its caller. */
  timeout_ms?: number;
}): Promise<ModelReply | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const abort = new AbortController();
  const timer = args.timeout_ms ? setTimeout(() => abort.abort(), args.timeout_ms) : undefined;
  try {
    const response = await postMessages(
      {
        model: args.model ?? CHEAP_MODEL,
        system: args.system,
        prompt: args.prompt,
        max_tokens: args.max_tokens,
        // The cheap model runs deterministic unless asked otherwise. Newer
        // models refuse any temperature ("deprecated for this model"), so
        // they get one only when a caller passes it.
        temperature: args.temperature ?? ((args.model ?? CHEAP_MODEL) === CHEAP_MODEL ? 0 : undefined),
      },
      { signal: abort.signal },
    );
    if (!response) return null;
    if (!response.ok) {
      console.error(`${args.label} API error:`, response.status, (await response.text()).slice(0, 300));
      return null;
    }
    const data = await response.json();
    const text = replyText(data);
    if (!text) {
      console.error(`${args.label} empty reply:`, data.stop_reason, (data.content ?? []).map((b: any) => b?.type).join(","));
      return null;
    }
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
  return modelCost(CHEAP_MODEL, usage);
}

/**
 * Dollars for a usage on `model`, from the one price table (`PRICE_OVERRIDES`
 * in @platform/agent). A model it does not list is charged at its dearest
 * entry, so a cap never undercounts.
 */
export function modelCost(model: string, usage: ModelUsage): number {
  return usageCost({ input: usage.input_tokens, output: usage.output_tokens, cacheRead: 0, cacheWrite: 0 }, priceFor(model));
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
