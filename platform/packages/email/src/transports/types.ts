// The transport seam: templates render a message, a Transport delivers it.
// Both shipped transports degrade to a console warning when unconfigured, so
// auth and invite flows stay usable on dev deployments with no secrets.

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendOptions {
  /**
   * Labels the template ("welcome", "digest") for provider dashboards and
   * the skip warning, so per template deliverability stays visible.
   */
  tag?: string;
  /** Per message headers (List-Unsubscribe for the digest). */
  headers?: Record<string, string>;
}

export interface Transport {
  send(message: EmailMessage, opts?: SendOptions): Promise<void>;
}

/** Injectable fetch, so tests and exotic runtimes never touch the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
