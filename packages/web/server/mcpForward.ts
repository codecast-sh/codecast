// The headers codecast.sh sends when it forwards an MCP or OAuth request to the
// Convex site (docs/architecture/agent-mcp.md). The request goes on whole,
// except: host and content-length belong to the new hop, any inbound copy of
// the caller-address headers is dropped (a client must never set them), and the
// caller's address as Cloudflare saw it is added, signed with MCP_FORWARD_SECRET.
import { MCP_CALLER_IP_HEADER, MCP_CALLER_SIG_HEADER, signCallerAddress } from "@codecast/shared/contracts/agentAccess";

export async function mcpForwardHeaders(inbound: Headers, secret: string | undefined): Promise<Headers> {
  const headers = new Headers(inbound);
  for (const name of ["host", "content-length", MCP_CALLER_IP_HEADER, MCP_CALLER_SIG_HEADER]) headers.delete(name);
  const caller = inbound.get("cf-connecting-ip")?.trim();
  if (secret && caller) {
    headers.set(MCP_CALLER_IP_HEADER, caller);
    headers.set(MCP_CALLER_SIG_HEADER, await signCallerAddress(secret, caller));
  }
  return headers;
}
