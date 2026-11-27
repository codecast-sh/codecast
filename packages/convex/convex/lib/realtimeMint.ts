// One short-lived OpenAI Realtime client secret for a transcription session.
// The browser streams audio straight to OpenAI and must never see
// OPENAI_API_KEY, so a mint posts the session config to
// /v1/realtime/client_secrets (GA realtime API: the config nests under
// `session`) and hands back only the ephemeral secret. Shared by the call
// scribe (transcripts.mintAsrToken) and dictation (dictation.mintDictationToken).
// A leaf: it imports nothing from ./functions.
import type { asrTranscriptionSession, legacyAsrTranscriptionSession } from "@codecast/shared/contracts";
import { openaiFetch } from "./openai";
import type { VendorCtx } from "./vendorGuard";

export type RealtimeSession = ReturnType<typeof asrTranscriptionSession> | ReturnType<typeof legacyAsrTranscriptionSession>;

/** The secret for `session`, minted under `workspace`'s vendor gate, or a short error. */
export async function mintRealtimeSecret(
  ctx: VendorCtx,
  workspace: string,
  session: RealtimeSession,
): Promise<{ error: string } | { client_secret: string }> {
  const resp = await openaiFetch({ ctx, scope: { workspace } }, "/v1/realtime/client_secrets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session }),
  });
  if (!resp) return { error: "Transcription is not configured" };
  if (!resp.ok) {
    const body = (await resp.text()).slice(0, 300);
    console.error("[transcripts] mint failed", resp.status, body);
    let hint = "";
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
      const msg = parsed.error?.message ?? parsed.message;
      if (typeof msg === "string" && msg) hint = `: ${msg.slice(0, 160)}`;
    } catch {
      // Body was not JSON; the status is enough.
    }
    return { error: `ASR session mint failed (${resp.status})${hint}` };
  }
  const data = (await resp.json()) as { value?: string; client_secret?: { value?: string } };
  const secret = data.value ?? data.client_secret?.value;
  if (!secret) return { error: "ASR session mint returned no secret" };
  return { client_secret: secret };
}
