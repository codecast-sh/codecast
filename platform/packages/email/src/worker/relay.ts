// Reference Cloudflare Worker handler for the relay transport. Port of
// aurora's packages/web/worker.js relayEmail. Mount it in the app's Worker:
//
//   const relay = createEmailRelayHandler({ from: { email: "hello@sapling.day", name: "Sapling" } })
//   if (url.pathname === "/api/email") return relay(request, env)
//
// wrangler.toml needs a send_email binding named EMAIL and an EMAIL_SECRET
// var; the backend sets EMAIL_RELAY_URL and EMAIL_RELAY_SECRET to match.

/** Cloudflare's send_email binding, typed minimally so no CF types are needed. */
export interface EmailSendBinding {
  send(msg: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ messageId?: string } | undefined>;
}

export interface EmailRelayEnv {
  EMAIL_SECRET?: string;
  EMAIL: EmailSendBinding;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createEmailRelayHandler(config: { from: { email: string; name: string } }) {
  return async function relayEmail(request: Request, env: EmailRelayEnv): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = request.headers.get("authorization") ?? "";
    if (!env.EMAIL_SECRET || auth !== `Bearer ${env.EMAIL_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    let body: { to?: unknown; subject?: unknown; text?: unknown; html?: unknown };
    try {
      body = await request.json();
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }
    const { to, subject, text, html } = body ?? {};
    if (typeof to !== "string" || typeof subject !== "string" || typeof text !== "string") {
      return new Response("to, subject, text required", { status: 400 });
    }
    try {
      const sent = await env.EMAIL.send({
        to,
        from: config.from,
        subject,
        text,
        html: typeof html === "string" && html ? html : undefined,
      });
      return jsonResponse({ ok: true, messageId: sent?.messageId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ ok: false, error: message }, 502);
    }
  };
}
