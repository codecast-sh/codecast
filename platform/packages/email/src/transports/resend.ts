// Resend transport: codecast's deliver logic over Resend's HTTP API, with the
// API key and fetch injected. No SDK dependency; the request body matches
// what the resend package sends.

import { senderAddress, type Brand } from "../brand";
import type { EmailMessage, FetchLike, SendOptions, Transport } from "./types";

export interface ResendTransportConfig {
  /** RESEND_API_KEY. When absent, sends warn and skip instead of throwing. */
  apiKey: string | undefined;
  /** From header, e.g. `Codecast <support@codecast.sh>`; see senderAddress(). */
  from: string;
  /** Reply-To address. Optional. */
  replyTo?: string;
  fetch?: FetchLike;
  endpoint?: string;
}

export function createResendTransport(config: ResendTransportConfig): Transport {
  const endpoint = config.endpoint ?? "https://api.resend.com/emails";
  const doFetch: FetchLike = config.fetch ?? ((input, init) => fetch(input, init));
  return {
    async send(message: EmailMessage, opts?: SendOptions): Promise<void> {
      const tag = opts?.tag ?? "email";
      if (!config.apiKey) {
        // Dev deployments without a key: log instead of throwing so auth and
        // invite flows stay usable locally.
        console.warn(`[email] RESEND_API_KEY not set; skipping "${tag}" to ${message.to}`);
        return;
      }
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: config.from,
          to: [message.to],
          ...(config.replyTo ? { reply_to: config.replyTo } : {}),
          subject: message.subject,
          html: message.html,
          text: message.text,
          tags: [{ name: "template", value: tag }],
          ...(opts?.headers ? { headers: opts.headers } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Resend ${tag} to ${message.to} failed: ${body}`);
      }
    },
  };
}

/** Codecast's default wiring: From and Reply-To both from the brand. */
export function resendTransportForBrand(
  brand: Pick<Brand, "name" | "supportEmail">,
  apiKey: string | undefined,
  fetchImpl?: FetchLike,
): Transport {
  return createResendTransport({
    apiKey,
    from: senderAddress(brand),
    replyTo: brand.supportEmail,
    fetch: fetchImpl,
  });
}
