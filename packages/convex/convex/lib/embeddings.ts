// One text embedding for grouping findings by what happened
// (docs/architecture/learning-loop.md LL9): OpenAI text-embedding-3-small on
// the deployment's key, 1536 dimensions (momentsSchema.ts
// FINDING_VECTOR_DIMENSIONS). Null when the key is missing or the call
// fails; grouping then falls back to the attach judge's word overlap.

import { FINDING_VECTOR_DIMENSIONS } from "../momentsSchema";

export const EMBEDDING_MODEL = "text-embedding-3-small";
/** Dollars per input token for the model (US$0.02 per million). */
const PRICE_PER_TOKEN = 0.02 / 1_000_000;
/** What one embedding call may read; findings are a sentence or two. */
const MAX_CHARS = 4_000;

export interface Embedded {
  vector: number[];
  cost_usd: number;
}

/** The worst case of one embedding, for the budget's reservation. */
export function embeddingWorstCase(text: string): number {
  return Math.ceil(Math.min(text.length, MAX_CHARS) / 2) * PRICE_PER_TOKEN;
}

export async function embedText(text: string, opts: { timeout_ms?: number } = {}): Promise<Embedded | null> {
  const key = process.env.OPENAI_API_KEY;
  const input = text.trim().slice(0, MAX_CHARS);
  if (!key || !input) return null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeout_ms ?? 15_000);
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      signal: abort.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
    });
    if (!res.ok) {
      console.error("Embedding API error:", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data: any = await res.json();
    const vector = data?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== FINDING_VECTOR_DIMENSIONS) return null;
    const tokens = typeof data?.usage?.total_tokens === "number" ? data.usage.total_tokens : Math.ceil(input.length / 3);
    return { vector, cost_usd: tokens * PRICE_PER_TOKEN };
  } catch (error) {
    console.error("Embedding failed:", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
