// Signing in to a remote MCP server on one machine, from any device.
//
// The machine's daemon runs the agent CLI's own login (`claude mcp login
// <server> --no-browser`, `codex mcp login <server> --no-browser`) in a tmux
// pane. The CLI prints an authorization URL, then waits for its OAuth redirect:
// either on its localhost callback port, which only works when the browser
// runs on that same machine, or as the redirect address pasted at its prompt.
// The web shows the URL, takes the address the person's browser landed on (a
// page that fails to load on any other machine) and the daemon types it into
// the prompt. The PKCE verifier never leaves the CLI, so the address alone
// cannot be exchanged anywhere else.
//
// The flow's state lives on the device row (`devices.mcp_login_flow`):
// convex/mcpLogin.ts writes pending, the daemon adds the URL and the outcome.
//
// PURE isomorphic data: imported by the Convex runtime, the daemon and the web.

export const MCP_LOGIN_CLIENTS = ["claude", "codex"] as const;
export type McpLoginClient = (typeof MCP_LOGIN_CLIENTS)[number];

export function isMcpLoginClient(value: unknown): value is McpLoginClient {
  return typeof value === "string" && (MCP_LOGIN_CLIENTS as readonly string[]).includes(value);
}

/** Transports a CLI can sign in to. A stdio server takes no OAuth. */
export function isRemoteMcpTransport(transport: string | undefined): boolean {
  return transport === "http" || transport === "sse" || transport === "streamable_http" || transport === "streamable-http";
}

/** A server name as both CLIs accept it. Checked before it reaches a shell. */
export function isMcpServerName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/.test(name);
}

/** The daemon's sign-in gives up after this; a pending flow older than it is dead. */
export const MCP_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
export const MCP_LOGIN_STALE_MS = MCP_LOGIN_TIMEOUT_MS + 60 * 1000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The redirect address a person pasted, checked and trimmed, or a reason it is
 * not one. It must be the CLI's loopback callback carrying the provider's
 * answer (`code` or `error`): anything else typed into the waiting prompt
 * would only fail there, minutes later and less clearly.
 */
export function mcpLoginCallback(value: string): { url: string } | { error: string } {
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: "Paste the whole address from the browser's address bar, starting with http://localhost" };
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    return { error: "That is not the sign-in's return address. It starts with http://localhost or http://127.0.0.1" };
  }
  if (!url.searchParams.get("code") && !url.searchParams.get("error")) {
    return { error: "That address has no sign-in code in it. Approve access first, then copy the address the browser opens" };
  }
  if (/[\x00-\x1f\x7f]/.test(text) || text.length > 4096) return { error: "That address is not valid" };
  return { url: text };
}
