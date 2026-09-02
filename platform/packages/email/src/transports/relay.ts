// Worker relay transport: aurora's sendEmail. The app has no mail server; a
// Cloudflare Worker holds an Email Sending binding and relays anything POSTed
// to it with the shared secret. The matching handler ships in ../worker.

import type { EmailMessage, FetchLike, SendOptions, Transport } from "./types";

export interface RelayTransportConfig {
  /** EMAIL_RELAY_URL, e.g. https://sapling.day/api/email */
  url: string | undefined;
  /** EMAIL_RELAY_SECRET, the bearer the Worker checks. */
  secret: string | undefined;
  fetch?: FetchLike;
}

export function createRelayTransport(config: RelayTransportConfig): Transport {
  const doFetch: FetchLike = config.fetch ?? ((input, init) => fetch(input, init));
  return {
    async send(message: EmailMessage, _opts?: SendOptions): Promise<void> {
      if (!config.url || !config.secret) {
        // Dev deployments: log instead of sending so the flows stay usable.
        console.warn(
          `[email] relay not configured; would send "${message.subject}" to ${message.to}\n${message.text}`,
        );
        return;
      }
      const res = await doFetch(config.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      });
      if (!res.ok) {
        throw new Error(`email relay ${res.status}: ${await res.text()}`);
      }
    },
  };
}
