// Our speech worker (infra/speech-worker): CAM++ voice embeddings for spans
// of a recording. Our own service, not a vendor: the audio never leaves
// Codecast's infrastructure for it.
//   POST $SPEECH_WORKER_URL/embed  Bearer $SPEECH_WORKER_SECRET
//   {audio_url, spans:[{key, windows:[[s,e],...]}]} -> {model, vectors:{key:[vector|null,...]}}
// (null for a window under 0.5 s).
import type { Window } from "./voiceMatch";

/** The longest the worker may take; the caller's deadline also caps it. */
export const WORKER_MAX_MS = 3 * 60_000;

export type EmbedResult = { model: string; vectors: Record<string, Array<number[] | null>> };

/** Embeddings for each key's windows, or null when the worker is not
 *  configured or did not answer (the caller goes on without names). */
export async function embedWindows(
  audioUrl: string,
  spans: Array<{ key: string; windows: Window[] }>,
  timeoutMs: number = WORKER_MAX_MS,
): Promise<EmbedResult | null> {
  const url = process.env.SPEECH_WORKER_URL;
  const secret = process.env.SPEECH_WORKER_SECRET;
  if (!url || !secret || !spans.length) return null;
  try {
    const resp = await fetch(`${url.replace(/\/$/, "")}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ audio_url: audioUrl, spans }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(WORKER_MAX_MS, timeoutMs))),
    });
    if (!resp.ok) {
      console.error("[speechWorker] embed failed", resp.status, (await resp.text()).slice(0, 200));
      return null;
    }
    const data = (await resp.json()) as Partial<EmbedResult>;
    if (!data || typeof data.model !== "string" || !data.vectors || typeof data.vectors !== "object") return null;
    return data as EmbedResult;
  } catch (err) {
    console.error("[speechWorker] embed unreachable", String(err).slice(0, 200));
    return null;
  }
}

/** The usable vectors of one key's windows (nulls dropped). */
export function vectorsOf(result: EmbedResult | null, key: string): number[][] {
  return (result?.vectors[key] ?? []).filter((v): v is number[] => Array.isArray(v) && v.length > 0);
}
