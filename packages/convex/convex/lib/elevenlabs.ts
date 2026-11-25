// Every server request to ElevenLabs on the deployment's key goes through
// elevenlabsFetch, so the vendor rule (lib/vendorGuard: a regulated team's
// content reaches ElevenLabs only once Codecast holds a BAA with it) has one
// home, as lib/openai.ts is for OpenAI.
import { vendorRefusalFor, type VendorGate } from "./vendorGuard";

/** The refusal for sending this gate's content to ElevenLabs, or null when it may go. */
export function elevenlabsRefusal(gate: VendorGate): Promise<string | null> {
  return vendorRefusalFor(gate.ctx, gate.scope, "elevenlabs");
}

/**
 * One request to the ElevenLabs API (`path` like "/v1/speech-to-text") with
 * the deployment's key. Null when the key is missing or the gate's team may
 * not send to ElevenLabs; the caller decides what a missing answer means.
 */
export async function elevenlabsFetch(gate: VendorGate, path: `/${string}`, init: RequestInit = {}): Promise<Response | null> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key || (await elevenlabsRefusal(gate))) return null;
  return fetch(`https://api.elevenlabs.io${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "xi-api-key": key } });
}
