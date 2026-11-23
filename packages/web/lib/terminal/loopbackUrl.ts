// Loopback daemon socket URLs, free of the store so a standalone page (the
// guest /meet call) can build one without booting the app.

import type { TerminalEndpoint } from "./endpoint";

/** A port a loopback URL can carry. Every endpoint handed out passes this, so
 *  a socket built from one (terminal, vault, browser watch) never throws
 *  "the provided URL is invalid" (ct-73198). */
export function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** An endpoint a loopback socket can be opened against: a valid port and a
 *  token to say hello with. */
export function isUsableEndpoint(ep: { port?: unknown; token?: unknown } | null | undefined): ep is TerminalEndpoint {
  return !!ep && isValidPort(ep.port) && typeof ep.token === "string" && ep.token.length > 0;
}

/** The one builder of a loopback daemon socket URL (terminal, browser watch,
 *  vault): null for an endpoint whose URL the browser would reject. */
export function loopbackWsUrl(ep: TerminalEndpoint, path: string): string | null {
  // Literal IPv4: macOS resolves `localhost` to ::1 first and the daemon may
  // bind IPv4 only.
  return isUsableEndpoint(ep) ? `ws://127.0.0.1:${ep.port}${path}` : null;
}
