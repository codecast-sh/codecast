export type { EmailMessage, SendOptions, Transport, FetchLike } from "./types";
export { createResendTransport, resendTransportForBrand, type ResendTransportConfig } from "./resend";
export { createRelayTransport, type RelayTransportConfig } from "./relay";

import type { Brand } from "../brand";
import { createRelayTransport } from "./relay";
import { resendTransportForBrand } from "./resend";
import type { FetchLike, Transport } from "./types";

/**
 * Pick a transport from the deployment's env: Resend when RESEND_API_KEY is
 * set, the Worker relay when EMAIL_RELAY_URL and EMAIL_RELAY_SECRET are set,
 * else a transport that warns and skips (the Resend one, unconfigured).
 */
export function transportFromEnv(
  env: Record<string, string | undefined>,
  brand: Pick<Brand, "name" | "supportEmail">,
  fetchImpl?: FetchLike,
): Transport {
  if (env.RESEND_API_KEY) {
    return resendTransportForBrand(brand, env.RESEND_API_KEY, fetchImpl);
  }
  if (env.EMAIL_RELAY_URL && env.EMAIL_RELAY_SECRET) {
    return createRelayTransport({
      url: env.EMAIL_RELAY_URL,
      secret: env.EMAIL_RELAY_SECRET,
      fetch: fetchImpl,
    });
  }
  return resendTransportForBrand(brand, undefined, fetchImpl);
}
