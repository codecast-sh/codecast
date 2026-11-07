// Every server request to OpenAI on the deployment's key goes through
// openaiFetch, so the vendor rule (lib/vendorGuard: a regulated team's content
// reaches OpenAI only once Codecast holds a BAA with it) has one home.
import { vendorRefusalFor, type VendorGate } from "./vendorGuard";

/** The refusal for sending this gate's content to OpenAI, or null when it may go. */
export function openaiRefusal(gate: VendorGate): Promise<string | null> {
  return vendorRefusalFor(gate.ctx, gate.scope, "openai");
}

/**
 * One request to the OpenAI API (`path` like "/v1/embeddings"), with the
 * deployment's key as the bearer. Null when the key is missing or the gate's
 * team may not send to OpenAI; the caller decides what a missing answer means.
 */
export async function openaiFetch(gate: VendorGate, path: `/${string}`, init: RequestInit = {}): Promise<Response | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || (await openaiRefusal(gate))) return null;
  return fetch(`https://api.openai.com${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${key}` } });
}
