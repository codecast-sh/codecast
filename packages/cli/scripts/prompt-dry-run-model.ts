// The agent's only ways off the machine: the egress proxy (CONNECT to
// Anthropic alone) and the model proxy that holds the real login so it never
// enters the sandbox.
import * as net from "node:net";

/** The hosts an agent may open a tunnel to: the model's API and Claude Code's own sign-in. */
const EGRESS_ALLOWED = /^(?:[a-z0-9-]+\.)*(?:anthropic\.com|claude\.ai)$/i;

/**
 * The one way off the machine an agent has: an HTTP CONNECT proxy
 * on the loopback that opens tunnels to Anthropic on 443 and answers anything
 * else 403. The sandbox refuses every other connection, so gh, a git remote
 * or curl reach nothing whatever sign-in they hold; tools that read the proxy
 * env are told no, the rest are refused by the kernel. Lives as long as this
 * process, like the broker.
 */
export async function startEgressProxy(): Promise<string> {
  const server = net.createServer((client) => {
    client.once("data", (head) => {
      const line = head.toString("latin1").split("\r\n", 1)[0];
      const m = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]$/.exec(line);
      if (!m || m[2] !== "443" || !EGRESS_ALLOWED.test(m[1])) {
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = net.connect(443, m[1], () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    client.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

/** What an agent's Claude Code holds in place of the login: a token that opens nothing. */
export const PLACEHOLDER_TOKEN = "sk-ant-oat01-dry-run-placeholder";
/** The model endpoints the agent's Claude Code calls; the model proxy forwards these and nothing else. */
const MODEL_PATHS = /^(?:HEAD \/api\/hello|POST \/v1\/messages(?:\/count_tokens)?|GET \/v1\/models(?:\/[^/]+)?)$/;

/**
 * The anthropic-beta values Claude Code sends on a turn (captured from real
 * haiku, sonnet and opus turns, 2.1.326, 2026-11-16); any other is dropped
 * before the request leaves, so a beta that would enable a feature reaching
 * past the model is never asked for. 1M-context models add context-1m-*.
 */
const MODEL_BETAS = new Set(["oauth-2025-04-20", "interleaved-thinking-2025-05-14", "context-management-2025-06-27", "claude-code-20250219", "per-turn-control-2026-07-01", "mid-conversation-tool-changes-2026-07-01", "thinking-token-count-2026-05-13", "advanced-tool-use-2025-11-20", "effort-2025-11-24", "extended-cache-ttl-2025-04-11"]);

/**
 * Why a model request is refused, or null: anything that has Anthropic act
 * beyond the model on the agent's behalf. A tool with a `type` is a server
 * tool (web fetch and search, code execution, a computer); mcp_servers and
 * container reach other hosts. Claude Code's own turns declare client tools
 * only, so none of these is ever its.
 */
/**
 * A URL inside a message or the system prompt, outside the arguments of a
 * tool call the agent already made: an image, a document or a file Anthropic
 * would fetch from any host (`source: {type: "url"}`), which reaches past the
 * model with no tool and no beta at all. Null when there is none.
 */
function urlInContent(node: unknown, at = ""): string | null {
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) {
      const hit = urlInContent(v, `${at}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const o = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    // What a tool was called with is the agent's own record, never fetched.
    if (k === "input" && o.type === "tool_use") continue;
    if (/url$/i.test(k) && typeof v === "string") return `${at}.${k}`;
    if (k === "source" && v && typeof v === "object" && (v as Record<string, unknown>).type === "url") return `${at}.source`;
    const hit = urlInContent(v, `${at}.${k}`);
    if (hit) return hit;
  }
  return null;
}

function modelRequestRefusal(req: any): string | null {
  if (!req || typeof req !== "object" || Array.isArray(req)) return "a model request must be a JSON object";
  const url = urlInContent(req.messages, "messages") ?? urlInContent(req.system, "system");
  if (url) return `content Anthropic would fetch from a URL is not available here (${url})`;
  if ("mcp_servers" in req) return "mcp_servers would reach other hosts";
  if ("container" in req) return "a container runs code off the machine";
  const server = (Array.isArray(req.tools) ? req.tools : []).filter((t: any) => t && typeof t === "object" && "type" in t && t.type !== "custom");
  return server.length ? `server tools are not available here (${server.map((t: any) => t.type).join(", ")})` : null;
}

/**
 * The model, reached without the login ever entering the sandbox. Claude
 * Code inside reads its own process environment, and so can every process
 * in its session (sysctl KERN_PROCARGS2), the agent's Bash included, so the
 * real token cannot sit there. Claude Code gets a placeholder and this
 * address as ANTHROPIC_BASE_URL; each call to a model endpoint goes on to
 * Anthropic over TLS with the placeholder swapped for the real login, and
 * any other path is refused, so the agent cannot spend the login on the
 * account's own endpoints either.
 */
export function startModelProxy(token: string): string {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (!MODEL_PATHS.test(`${req.method} ${u.pathname}`)) return new Response("dry run: only the model's endpoints are reachable\n", { status: 403 });
      let body: string | undefined;
      if (req.method === "POST") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await req.text());
        } catch {
          return new Response("dry run: a model request must be JSON\n", { status: 403 });
        }
        const refused = modelRequestRefusal(parsed);
        if (refused) return new Response(`dry run: ${refused}\n`, { status: 403 });
        // What was checked is what is sent: re-serialized, so no second parser can read the raw text another way (a duplicate key).
        body = JSON.stringify(parsed);
      }
      const headers = new Headers(req.headers);
      for (const h of ["host", "content-length", "content-encoding", "transfer-encoding"]) headers.delete(h);
      if (headers.get("authorization")?.includes(PLACEHOLDER_TOKEN)) headers.set("authorization", `Bearer ${token}`);
      const betas = (headers.get("anthropic-beta") ?? "").split(",").map((b) => b.trim()).filter((b) => b && (MODEL_BETAS.has(b) || /^context-1m-/.test(b)));
      if (betas.length) headers.set("anthropic-beta", betas.join(","));
      else headers.delete("anthropic-beta");
      const r = await fetch(`https://api.anthropic.com${u.pathname}${u.search}`, { method: req.method, headers, body } as RequestInit);
      const out = new Headers(r.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      return new Response(r.body, { status: r.status, headers: out });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}
