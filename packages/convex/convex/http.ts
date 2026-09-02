import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { unsubscribeResponse } from "@platform/email";
import { httpAction } from "./_generated/server";
import { BRAND } from "./emails/render";
import { auth } from "./auth";
import { internal, api } from "./_generated/api";
import { callback as googleOAuthCallback, GOOGLE_CALLBACK_PATH } from "./googleOAuth";
import { callback as connectorCallback, CONNECTOR_CALLBACK_PATH } from "./oauthConnectors";

const http = httpRouter();

auth.addHttpRoutes(http);

// IP-keyed rate limit for an unauthenticated HTTP route. Returns a 429 Response to
// short-circuit the handler when the caller's IP exceeds the window, else null.
// Fail-open: a limiter error never blocks the route (availability > strictness).
async function ipRateLimited(
  ctx: any,
  request: Request,
  name: string,
  max: number,
  windowMs: number,
): Promise<Response | null> {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    "unknown";
  try {
    const res = await ctx.runMutation(internal.ipRateLimit.bump, {
      key: `${name}:${ip}`,
      max,
      window_ms: windowMs,
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ error: "Too many requests" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil((res.retry_after_ms ?? windowMs) / 1000)),
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  } catch {
    // Fail open.
  }
  return null;
}


// Google OAuth callback (Gmail connector). GET because Google redirects the
// browser here; the handler validates state and closes the popup.
http.route({
  path: GOOGLE_CALLBACK_PATH,
  method: "GET",
  handler: googleOAuthCallback,
});
// Linear, Notion, and any provider added to oauthConnectors.PROVIDERS share
// one callback: the signed state carries the provider.
http.route({
  path: CONNECTOR_CALLBACK_PATH,
  method: "GET",
  handler: connectorCallback,
});

http.route({
  path: "/cli/exchange-token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      // Brute-force guard: a setup token is one-shot + TTL-bound, so 20 exchange
      // attempts/min per IP is far above any legitimate use and caps guessing.
      const limited = await ipRateLimited(ctx, request, "exchange-token", 20, 60_000);
      if (limited) return limited;

      const body = await request.json();
      const setupToken = body.token;

      if (!setupToken) {
        return new Response(JSON.stringify({ error: "Missing token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(internal.apiTokens.exchangeSetupToken, {
        setupToken,
      });

      if (!result) {
        return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/exchange-token",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

// Polled by `cast auth` while it waits on its localhost listener, so auth
// also completes for CLIs the browser can't reach (SSH / remote machines).
// The nonce is the CLI's one-time 256-bit secret; a claim is single-use.
http.route({
  path: "/cli/claim-auth",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const nonce = body.nonce;

      if (!nonce || typeof nonce !== "string") {
        return new Response(JSON.stringify({ error: "Missing nonce" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(internal.cliAuth.claim, { nonce });

      // "Not deposited yet" is the normal polling answer, not an error.
      if (!result) {
        return new Response(JSON.stringify({ pending: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/claim-auth",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/api/github-app/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const installationId = url.searchParams.get("installation_id");
    const setupAction = url.searchParams.get("setup_action");
    const state = url.searchParams.get("state");

    if (!installationId) {
      return new Response("Missing installation_id", { status: 400 });
    }

    if (setupAction === "install" || setupAction === "update") {
      let teamId: string | null = null;
      let userId: string | null = null;
      if (state) {
        try {
          const stateData = JSON.parse(atob(state));
          teamId = stateData.team_id;
          userId = stateData.user_id;
        } catch {
        }
      }

      if (!teamId) {
        const redirectUrl = `${process.env.SITE_URL || "https://codecast.sh"}/settings/integrations/github-app?error=missing_team`;
        return new Response(null, {
          status: 302,
          headers: { Location: redirectUrl },
        });
      }

      try {
        const installationDetails = await ctx.runAction(internal.githubApp.fetchInstallationDetails, {
          installation_id: parseInt(installationId),
        });

        await ctx.runMutation(internal.githubApp.storeInstallation, {
          team_id: teamId as any,
          installation_id: installationDetails.installation_id,
          account_login: installationDetails.account_login,
          account_type: installationDetails.account_type,
          account_id: installationDetails.account_id,
          repository_selection: installationDetails.repository_selection,
          repositories: installationDetails.repositories,
          installed_by_user_id: userId as any,
        });

        const redirectUrl = `${process.env.SITE_URL || "https://codecast.sh"}/settings/integrations/github-app?success=true`;
        return new Response(null, {
          status: 302,
          headers: { Location: redirectUrl },
        });
      } catch (error) {
        console.error("Failed to process GitHub App installation:", error);
        const redirectUrl = `${process.env.SITE_URL || "https://codecast.sh"}/settings/integrations/github-app?error=installation_failed`;
        return new Response(null, {
          status: 302,
          headers: { Location: redirectUrl },
        });
      }
    }

    const redirectUrl = `${process.env.SITE_URL || "https://codecast.sh"}/settings/integrations/github-app`;
    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrl },
    });
  }),
});

// Constant-time hex-string compare so webhook signature verification can't be
// timing-probed (a plain `!==` short-circuits on the first differing byte).
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

http.route({
  path: "/api/webhooks/github-app",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signature = request.headers.get("X-Hub-Signature-256");
    const deliveryId = request.headers.get("X-GitHub-Delivery");
    const eventType = request.headers.get("X-GitHub-Event");

    if (!deliveryId || !eventType) {
      return new Response(JSON.stringify({ error: "Missing required headers" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await request.text();
    const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;

    // Fail CLOSED. The old `if (webhookSecret && signature)` skipped verification
    // entirely when the secret was unconfigured or the signature header absent —
    // i.e. it processed unsigned payloads. A missing secret or signature must reject.
    if (!webhookSecret) {
      console.error("[github-app webhook] GITHUB_APP_WEBHOOK_SECRET not configured; refusing webhook");
      return new Response(JSON.stringify({ error: "Webhook not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!signature) {
      return new Response(JSON.stringify({ error: "Missing signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
    const hashArray = Array.from(new Uint8Array(signatureBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    const expectedSignature = "sha256=" + hashHex;

    if (!timingSafeEqualHex(signature, expectedSignature)) {
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const payload = JSON.parse(body);

    if (eventType === "installation") {
      const action = payload.action;
      const installationId = payload.installation?.id;

      if (action === "deleted" && installationId) {
        await ctx.runMutation(internal.githubApp.removeInstallation, {
          installation_id: installationId,
        });
      } else if (action === "suspend" && installationId) {
        await ctx.runMutation(internal.githubApp.suspendInstallation, {
          installation_id: installationId,
          suspended_at: Date.now(),
        });
      } else if (action === "unsuspend" && installationId) {
        await ctx.runMutation(internal.githubApp.unsuspendInstallation, {
          installation_id: installationId,
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (eventType === "installation_repositories") {
      const installationId = payload.installation?.id;
      if (installationId && payload.repositories_added) {
        const existing = await ctx.runQuery(internal.githubApp.getCachedToken, {
          installation_id: installationId,
        });
        if (existing) {
        }
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (["pull_request", "push", "issue_comment", "pull_request_review", "pull_request_review_comment"].includes(eventType)) {
      const action = payload.action;
      const result = await ctx.runMutation(internal.githubWebhooks.storeWebhookEvent, {
        delivery_id: deliveryId,
        event_type: eventType,
        action,
        payload: body,
      });

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, ignored: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/api/webhooks/github",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const signature = request.headers.get("X-Hub-Signature-256");
      const deliveryId = request.headers.get("X-GitHub-Delivery");
      const eventType = request.headers.get("X-GitHub-Event");

      if (!signature || !deliveryId || !eventType) {
        return new Response(JSON.stringify({ error: "Missing required headers" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const body = await request.text();
      const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

      if (!webhookSecret) {
        console.error("GITHUB_WEBHOOK_SECRET not configured");
        return new Response(JSON.stringify({ error: "Server configuration error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      const encoder = new TextEncoder();
      const keyData = encoder.encode(webhookSecret);
      const messageData = encoder.encode(body);

      const key = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );

      const signatureBuffer = await crypto.subtle.sign("HMAC", key, messageData);
      const hashArray = Array.from(new Uint8Array(signatureBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      const expectedSignature = "sha256=" + hashHex;

      if (!signature || !timingSafeEqualHex(signature, expectedSignature)) {
        return new Response(JSON.stringify({ error: "Invalid signature" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const payload = JSON.parse(body);
      const action = payload.action;

      const result = await ctx.runMutation(internal.githubWebhooks.storeWebhookEvent, {
        delivery_id: deliveryId,
        event_type: eventType,
        action,
        payload: body,
      });

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Webhook processing error:", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

http.route({
  path: "/cli/session-links",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    try {
      const body = await request.json();
      const { session_id, api_token } = body;

      if (!session_id || !api_token) {
        return new Response(JSON.stringify({ error: "Missing session_id or api_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.conversations.getSessionLinks, {
        session_id,
        api_token,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 404,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify({
        conversation_id: result.conversation_id,
        dashboard_url: `https://codecast.sh/conversation/${result.conversation_id}`,
        share_url: `https://codecast.sh/conversation/${result.conversation_id}`,
        title: result.title,
        slug: result.slug,
        started_at: result.started_at,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/session-links",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }),
});

http.route({
  path: "/cli/search",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, query, limit, offset, start_time, end_time, context_before, context_after, project_path, user_only, member_name, mine_only, label, titles_only } = body;

      if (!api_token || !query) {
        return new Response(JSON.stringify({ error: "Missing api_token or query" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let team_id = undefined;
      if (project_path) {
        team_id = await ctx.runQuery(api.conversations.resolveTeamFromDirectory, {
          api_token,
          project_path,
        }) ?? undefined;
      }

      const result = await ctx.runQuery(api.conversations.searchForCLI, {
        api_token,
        query,
        limit,
        offset,
        start_time,
        end_time,
        context_before,
        context_after,
        project_path,
        user_only,
        team_id,
        member_name,
        mine_only,
        label,
        titles_only,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Search error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/search",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/read",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, conversation_id, start_line, end_line, full_content, around_message_id, context } = body;

      if (!api_token || !conversation_id) {
        return new Response(JSON.stringify({ error: "Missing api_token or conversation_id" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runQuery(api.conversations.readConversationMessages, {
        api_token,
        conversation_id,
        start_line,
        end_line,
        full_content,
        around_message_id,
        context,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 :
                 result.error === "Conversation not found" ? 404 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Read error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/read",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/export",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const { api_token, conversation_id, cursor, limit } = body;
      if (!api_token || !conversation_id) {
        return new Response(JSON.stringify({ error: "Missing api_token or conversation_id" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const result = await ctx.runQuery(api.conversations.exportConversationMessagesPage, {
        api_token,
        conversation_id,
        cursor: typeof cursor === "string" ? cursor : undefined,
        limit: typeof limit === "number" ? limit : undefined,
      });
      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 :
                 result.error === "Conversation not found" ? 404 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Export error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/export",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/local-checkouts",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const { api_token, git_remote_url } = body;
      if (!api_token || !git_remote_url) {
        return new Response(JSON.stringify({ error: "Missing api_token or git_remote_url" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const checkouts = await ctx.runQuery(api.conversations.findUserLocalCheckouts, {
        git_remote_url,
        api_token,
      });
      return new Response(JSON.stringify({ checkouts }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/local-checkouts",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/feed",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, limit, offset, start_time, end_time, query, project_path, member_name, mine_only, live_only, state, label } = body;

      if (!api_token) {
        return new Response(JSON.stringify({ error: "Missing api_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let team_id = undefined;
      if (project_path) {
        team_id = await ctx.runQuery(api.conversations.resolveTeamFromDirectory, {
          api_token,
          project_path,
        }) ?? undefined;
      }

      const result = await ctx.runQuery(api.conversations.feedForCLI, {
        api_token,
        limit,
        offset,
        start_time,
        end_time,
        query,
        project_path,
        team_id,
        member_name,
        mine_only,
        live_only,
        state,
        label,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Feed error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/feed",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

// Record the stable-context feed a session was started with (posted by
// `cast stable-context` / the daemon's Codex launch). Body: { api_token,
// conversation_id? | session_id?, data: StableContextData JSON }.
http.route({
  path: "/cli/stable-context",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const { api_token, conversation_id, session_id, data } = body;
      if (!api_token || typeof data !== "string") {
        return new Response(JSON.stringify({ error: "Missing api_token or data" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const result = await ctx.runMutation(api.conversations.recordStableContext, {
        api_token,
        conversation_id,
        session_id,
        data,
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/stable-context",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/inbox",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, show_all, state, limit, label, project_path, session_ids } = body;

      if (!api_token) {
        return new Response(JSON.stringify({ error: "Missing api_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runQuery(api.conversations.inboxForCLI, {
        api_token,
        show_all,
        state,
        limit,
        label,
        project_path,
        session_ids: Array.isArray(session_ids) ? session_ids : undefined,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Inbox error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/inbox",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/sessions",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const { api_token, session_ids } = body;
      if (!api_token || !session_ids) {
        return new Response(JSON.stringify({ error: "Missing api_token or session_ids" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const result = await ctx.runQuery(api.conversations.getConversationsBySessionIds, {
        api_token,
        session_ids,
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Sessions endpoint error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/sessions",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/bookmark",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, session_id, message_index, name, note } = body;

      if (!api_token || !session_id || message_index === undefined) {
        return new Response(JSON.stringify({ error: "Missing api_token, session_id, or message_index" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.bookmarks.createFromCLI, {
        api_token,
        session_id,
        message_index,
        name,
        note,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Bookmark create error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/bookmark",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/bookmark/list",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, project_path, limit } = body;

      if (!api_token) {
        return new Response(JSON.stringify({ error: "Missing api_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.bookmarks.listFromCLI, {
        api_token,
        project_path,
        limit,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Bookmark list error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/bookmark/list",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/bookmark/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, name, bookmark_id } = body;

      if (!api_token) {
        return new Response(JSON.stringify({ error: "Missing api_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (!name && !bookmark_id) {
        return new Response(JSON.stringify({ error: "Must provide name or bookmark_id" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.bookmarks.deleteFromCLI, {
        api_token,
        name,
        bookmark_id,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 :
                 result.error === "Bookmark not found" ? 404 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Bookmark delete error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/bookmark/delete",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/decisions",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, project_path, tags, search, limit, offset } = body;

      if (!api_token) {
        return new Response(JSON.stringify({ error: "Missing api_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.decisions.list, {
        api_token,
        project_path,
        tags,
        search,
        limit,
        offset,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Decisions list error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/decisions",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/decisions/add",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, title, rationale, alternatives, session_id, message_index, tags, project_path } = body;

      if (!api_token || !title || !rationale) {
        return new Response(JSON.stringify({ error: "Missing required fields: api_token, title, rationale" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.decisions.create, {
        api_token,
        title,
        rationale,
        alternatives,
        session_id,
        message_index,
        tags,
        project_path,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Decisions add error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/decisions/add",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/decisions/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, decision_id } = body;

      if (!api_token || !decision_id) {
        return new Response(JSON.stringify({ error: "Missing required fields: api_token, decision_id" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.decisions.remove, {
        api_token,
        decision_id,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 :
                 result.error === "Decision not found" ? 404 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Decisions delete error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/decisions/delete",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

// `cast decide` — an agent hands its human one explicit decision (question +
// options + context, optionally a published HTML report). Distinct from
// /cli/decisions (the architectural decision LOG): this is a pending question.
http.route({
  path: "/cli/decide",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, session_id, question, options, context_md, report_slug, blocking, default_option } = body;
      // One route, four verbs: ask (default), edit, cancel, ls. The CLI's
      // `cast decide` subcommands map onto these one to one.
      const action: string = body.action || "ask";

      if (!api_token) {
        return new Response(JSON.stringify({ error: "Missing api_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let result: any;
      if (action === "ls") {
        if (!session_id) {
          return new Response(JSON.stringify({ error: "Missing session_id" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
        result = await ctx.runMutation(api.sessionDecisions.listForSession, { api_token, session_id });
      } else if (action === "edit" || action === "cancel") {
        if (!body.decision_id) {
          return new Response(JSON.stringify({ error: "Missing decision_id" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
        result =
          action === "cancel"
            ? await ctx.runMutation(api.sessionDecisions.withdraw, { api_token, decision_id: body.decision_id, session_id })
            : await ctx.runMutation(api.sessionDecisions.edit, {
                api_token,
                decision_id: body.decision_id,
                session_id,
                question,
                options: Array.isArray(options) ? options : undefined,
                context_md,
                report_slug,
                blocking,
                default_option,
                clear_default: body.clear_default,
              });
      } else {
        if (!session_id || !question || !Array.isArray(options)) {
          return new Response(
            JSON.stringify({ error: "Missing required fields: api_token, session_id, question, options" }),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }
        result = await ctx.runMutation(api.sessionDecisions.ask, {
          api_token,
          session_id,
          question,
          options,
          context_md,
          report_slug,
          blocking,
          default_option,
        });
      }

      if (result.error) {
        // A resolved row's summary rides along so the CLI can say how the
        // question was answered instead of only that it cannot be changed.
        return new Response(JSON.stringify(result), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Decide error:", error);
      return new Response(
        JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
  }),
});

http.route({
  path: "/cli/decide",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/patterns",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, search, tags, limit, offset } = body;

      if (!api_token) {
        return new Response(JSON.stringify({ error: "Missing api_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.patterns.list, {
        api_token,
        search,
        tags,
        limit,
        offset,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Patterns list error:", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/patterns",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/patterns/add",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, name, description, content, source_session_id, source_range, tags } = body;

      if (!api_token || !name || !description || !content) {
        return new Response(JSON.stringify({ error: "Missing required fields" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.patterns.create, {
        api_token,
        name,
        description,
        content,
        source_session_id,
        source_range,
        tags,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Pattern create error:", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/patterns/add",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/patterns/show",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, name } = body;

      if (!api_token || !name) {
        return new Response(JSON.stringify({ error: "Missing api_token or name" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.patterns.get, {
        api_token,
        name,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 :
                 result.error === "Pattern not found" ? 404 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Pattern get error:", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/patterns/show",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/patterns/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, name } = body;

      if (!api_token || !name) {
        return new Response(JSON.stringify({ error: "Missing api_token or name" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.patterns.remove, {
        api_token,
        name,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 :
                 result.error === "Pattern not found" ? 404 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Pattern delete error:", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/patterns/delete",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/similar",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, file_path, session_id, limit } = body;

      if (!api_token) {
        return new Response(JSON.stringify({ error: "Missing api_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (!file_path && !session_id) {
        return new Response(JSON.stringify({ error: "Must provide file_path or session_id" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.fileTouches.findSimilar, {
        api_token,
        file_path,
        session_id,
        limit,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Similar search error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/similar",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/blame",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, file_path, limit } = body;

      if (!api_token || !file_path) {
        return new Response(JSON.stringify({ error: "Missing api_token or file_path" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.fileTouches.findByFile, {
        api_token,
        file_path,
        limit,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Blame error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/blame",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

// Line-level blame resolution: maps git blame SHAs (and uncommitted line
// texts) to the sessions that produced them. The file-level /cli/blame above
// stays as-is — `cast context` also consumes it.
http.route({
  path: "/cli/blame/resolve",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, shas, commits, file_path, uncommitted_lines, content_lines } = body;

      if (!api_token || (!Array.isArray(shas) && !Array.isArray(commits))) {
        return new Response(JSON.stringify({ error: "Missing api_token or shas/commits" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runQuery(api.blame.resolveBlame, {
        api_token,
        shas,
        commits,
        file_path,
        uncommitted_lines,
        content_lines,
      });

      if ("error" in result && result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Blame resolve error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/blame/resolve",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/sync-settings",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token } = body;

      if (!api_token) {
        return new Response(JSON.stringify({ error: "Missing api_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runQuery(api.users.getSyncSettingsForCLI, {
        api_token,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Get sync settings error:", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/sync-settings",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/sync-settings/update",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, sync_mode, sync_projects } = body;

      if (!api_token) {
        return new Response(JSON.stringify({ error: "Missing api_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.users.updateSyncSettingsForCLI, {
        api_token,
        sync_mode,
        sync_projects,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Update sync settings error:", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/sync-settings/update",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/log",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, level, message, metadata, cli_version, platform } = body;

      if (!api_token || !message) {
        return new Response(JSON.stringify({ error: "Missing api_token or message" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      await ctx.runMutation(api.daemonLogs.insertBatch, {
        api_token,
        logs: [{
          level: level || "error",
          message,
          metadata,
          daemon_version: cli_version,
          platform,
          timestamp: Date.now(),
        }],
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("CLI log error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/log",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/log-batch",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, logs } = body;

      if (!api_token || !Array.isArray(logs) || logs.length === 0) {
        return new Response(JSON.stringify({ error: "Missing api_token or logs array" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const validLevels = ["debug", "info", "warn", "error"] as const;
      type LogLevel = typeof validLevels[number];
      const toLevel = (s?: string): LogLevel => validLevels.includes(s as LogLevel) ? s as LogLevel : "error";

      await ctx.runMutation(api.daemonLogs.insertBatch, {
        api_token,
        logs: logs.map((log: { level?: string; message: string; metadata?: Record<string, string>; daemon_version?: string; platform?: string; timestamp?: number }) => ({
          level: toLevel(log.level),
          message: log.message,
          metadata: log.metadata,
          daemon_version: log.daemon_version,
          platform: log.platform,
          timestamp: log.timestamp || Date.now(),
        })),
      });

      return new Response(JSON.stringify({ success: true, inserted: logs.length }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("CLI log-batch error:", error);
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/log-batch",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/teams",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token } = body;

      if (!api_token) {
        return new Response(JSON.stringify({ error: "Missing api_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runQuery(api.users.getTeamsForCLI, {
        api_token,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Get teams error:", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/teams",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/teams/mappings",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token } = body;

      if (!api_token) {
        return new Response(JSON.stringify({ error: "Missing api_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runQuery(api.users.getDirectoryMappingsForCLI, {
        api_token,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Get mappings error:", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/teams/mappings",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/teams/mappings/update",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, path_prefix, team_id, auto_share } = body;

      if (!api_token || !path_prefix) {
        return new Response(JSON.stringify({ error: "Missing api_token or path_prefix" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.users.updateDirectoryMappingForCLI, {
        api_token,
        path_prefix,
        team_id,
        auto_share,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Update mapping error:", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/teams/mappings/update",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/conversations/count",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, path_prefix } = body;

      if (!api_token || !path_prefix) {
        return new Response(JSON.stringify({ error: "Missing api_token or path_prefix" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runQuery(api.users.countConversationsForPathCLI, {
        api_token,
        path_prefix,
      });

      if ((result as any).error) {
        return new Response(JSON.stringify({ error: (result as any).error }), {
          status: (result as any).error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Count conversations error:", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/conversations/count",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/conversations/delete-by-path",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, path_prefix } = body;

      if (!api_token || !path_prefix) {
        return new Response(JSON.stringify({ error: "Missing api_token or path_prefix" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // Each mutation call deletes at most one message batch or one
      // conversation (bounded transactions); drain here so a single CLI call
      // deletes everything under the prefix. The iteration cap bounds one HTTP
      // request — a caller with an enormous project re-invokes on hasMore.
      let conversationsDeleted = 0;
      let messagesDeleted = 0;
      let hasMore = true;
      for (let i = 0; i < 400 && hasMore; i++) {
        const result = await ctx.runMutation(api.users.deleteConversationsForPathCLI, {
          api_token,
          path_prefix,
        });

        if ((result as any).error) {
          return new Response(JSON.stringify({ error: (result as any).error }), {
            status: (result as any).error === "Unauthorized" ? 401 : 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
        conversationsDeleted += (result as any).conversationsDeleted ?? 0;
        messagesDeleted += (result as any).messagesDeleted ?? 0;
        hasMore = !!(result as any).hasMore;
      }

      return new Response(JSON.stringify({ conversationsDeleted, messagesDeleted, hasMore }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Delete conversations error:", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/conversations/delete-by-path",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/teams/projects",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, limit } = body;

      if (!api_token) {
        return new Response(JSON.stringify({ error: "Missing api_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runQuery(api.users.getProjectsWithTeamsForCLI, {
        api_token,
        limit,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Get projects error:", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/teams/projects",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/heartbeat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, version, platform, pid, autostart_enabled, has_tmux, local_project_roots, git_plane, git_pubkey, pending_sync_count, oldest_pending_ms, pending_sync_messages, pending_sync_conversations, daemon_started_at, loop_freeze_ms, device_id, device_label, device_hostname, is_remote_device, input_idle_ms, cc_accounts, codex_usage, codex_accounts, provider_key_pubkey, managed_provider_ids, settings, model_inventory } = body;

      if (!api_token || !version || !platform) {
        return new Response(JSON.stringify({ error: "Missing required fields" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.users.daemonHeartbeat, {
        api_token,
        version,
        platform,
        pid: pid || 0,
        autostart_enabled,
        has_tmux,
        local_project_roots,
        git_plane,
        git_pubkey,
        pending_sync_count,
        oldest_pending_ms,
        pending_sync_messages,
        pending_sync_conversations,
        daemon_started_at,
        loop_freeze_ms,
        device_id,
        device_label,
        device_hostname,
        is_remote_device,
        input_idle_ms,
        cc_accounts,
        codex_usage,
        codex_accounts,
        provider_key_pubkey,
        managed_provider_ids,
        settings,
        model_inventory,
      });

      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.error === "Unauthorized" ? 401 : 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // Capability inventory, when the daemon attached one. Deviation from
      // ct-42826's literal wording (an arg on daemonHeartbeat): forwarding to
      // reportInventory reuses its whole pipeline — sanitizer, scope cap, hash
      // gate, per-scope docs — instead of duplicating it inside users.ts. The
      // daemon only attaches the payload on change or the hourly floor, so this
      // is not a per-beat write; and a failure here must not fail presence,
      // which is why it sits after the heartbeat result, fire-and-log.
      if (body.capability_state && typeof body.capability_state === "object") {
        try {
          await ctx.runMutation(api.capabilities.reportInventory, {
            api_token,
            device_id: body.device_id,
            entries_json: JSON.stringify({
              items: body.capability_state.items ?? [],
              marketplaces: body.capability_state.marketplaces ?? [],
            }),
          });
        } catch (err) {
          console.error("capability_state ingest failed:", err);
        }
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Heartbeat error:", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/heartbeat",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/command-result",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    try {
      const body = await request.json();
      const { api_token, command_id, result, error } = body;

      if (!api_token || !command_id) {
        return new Response(JSON.stringify({ error: "Missing required fields" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const res = await ctx.runMutation(api.users.reportCommandResult, {
        api_token,
        command_id,
        result,
        error,
      });

      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (err) {
      console.error("Command result error:", err);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/command-result",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});


http.route({
  path: "/cli/fork",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      // session_id is the CLI-supplied idempotency key: forkFromMessage returns
      // the existing row when it's seen before, so a retried/redelivered fork
      // can't mint a duplicate "Fork:" conversation. Dropping it here silently
      // disabled that guard for every CLI fork. direction titles the branch.
      const { api_token, conversation_id, message_uuid, session_id, direction, target_agent_type } = body;
      if (!api_token || !conversation_id) {
        return new Response(JSON.stringify({ error: "Missing api_token or conversation_id" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const result = await ctx.runMutation(api.conversations.forkFromMessage, {
        conversation_id,
        message_uuid,
        api_token,
        session_id,
        direction,
        target_agent_type,
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("Unauthorized") ? 401 :
                     message.includes("not found") ? 404 :
                     message.includes("Access denied") ? 403 : 500;
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/fork",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/tree",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const { api_token, conversation_id } = body;
      if (!api_token || !conversation_id) {
        return new Response(JSON.stringify({ error: "Missing api_token or conversation_id" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const result = await ctx.runQuery(api.conversations.getConversationTree, {
        conversation_id,
        api_token,
      });
      if (result && "error" in result) {
        const status = result.error === "Unauthorized" ? 401 :
                       result.error === "Conversation not found" ? 404 :
                       result.error === "Access denied" ? 403 : 400;
        return new Response(JSON.stringify({ error: result.error }), {
          status,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: "Internal error", details: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/tree",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

// --- Agent Tasks endpoints ---

http.route({
  path: "/cli/tasks/create",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const result: any = await ctx.runMutation(api.agentTasks.createTask, body);
      // `task_id` stays a bare string on the wire — older CLIs read it directly.
      // `short_id` ("tr-42") is additive: the handle newer CLIs print and the
      // agent quotes.
      return new Response(JSON.stringify({ task_id: result?.id ?? result, short_id: result?.short_id }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const status = msg.includes("Unauthorized") ? 401 : 500;
      return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/tasks/create",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/tasks/list",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const result = await ctx.runQuery(api.agentTasks.listTasks, {
        api_token: body.api_token,
        status: body.status,
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: msg }), {
        status: msg.includes("Unauthorized") ? 401 : 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/tasks/resolve",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const result = await ctx.runQuery(api.agentTasks.resolveTask, {
        api_token: body.api_token,
        ref: String(body.ref ?? ""),
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: msg }), {
        status: msg.includes("Unauthorized") ? 401 : 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/tasks/list",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/tasks/due",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const result = await ctx.runQuery(api.agentTasks.getDueTasks, {
        api_token: body.api_token,
        limit: body.limit,
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: msg }), {
        status: msg.includes("Unauthorized") ? 401 : 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/tasks/due",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/tasks/claim",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const result = await ctx.runMutation(api.agentTasks.claimTask, {
        api_token: body.api_token,
        task_id: body.task_id,
        daemon_id: body.daemon_id,
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: msg }), {
        status: msg.includes("Unauthorized") ? 401 : 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/tasks/claim",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/tasks/renew-lease",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const result = await ctx.runMutation(api.agentTasks.renewLease, {
        api_token: body.api_token,
        task_id: body.task_id,
        daemon_id: body.daemon_id,
      });
      return new Response(JSON.stringify({ success: result }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: msg }), {
        status: msg.includes("Unauthorized") ? 401 : 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/tasks/renew-lease",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/tasks/complete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const result = await ctx.runMutation(api.agentTasks.completeTaskRun, {
        api_token: body.api_token,
        task_id: body.task_id,
        ...(body.daemon_id ? { daemon_id: body.daemon_id } : {}),
        summary: body.summary,
        conversation_id: body.conversation_id,
        run_session_uuid: body.run_session_uuid,
        ...(body.needs_attention !== undefined ? { needs_attention: !!body.needs_attention } : {}),
      });
      return new Response(JSON.stringify({ success: result }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: msg }), {
        status: msg.includes("Unauthorized") ? 401 : 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/tasks/complete",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/tasks/fail",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const result = await ctx.runMutation(api.agentTasks.failTaskRun, {
        api_token: body.api_token,
        task_id: body.task_id,
        daemon_id: body.daemon_id,
        error: body.error,
      });
      return new Response(JSON.stringify({ success: result }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: msg }), {
        status: msg.includes("Unauthorized") ? 401 : 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/tasks/fail",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/tasks/cancel",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const result = await ctx.runMutation(api.agentTasks.cancelTask, {
        api_token: body.api_token,
        task_id: body.task_id,
      });
      return new Response(JSON.stringify({ success: result }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: msg }), {
        status: msg.includes("Unauthorized") ? 401 : 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/tasks/cancel",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/tasks/pause",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const result = await ctx.runMutation(api.agentTasks.pauseTask, {
        api_token: body.api_token,
        task_id: body.task_id,
      });
      return new Response(JSON.stringify({ success: result }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: msg }), {
        status: msg.includes("Unauthorized") ? 401 : 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/tasks/pause",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/tasks/resume",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const result = await ctx.runMutation(api.agentTasks.resumeTask, {
        api_token: body.api_token,
        task_id: body.task_id,
      });
      return new Response(JSON.stringify({ success: result }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: msg }), {
        status: msg.includes("Unauthorized") ? 401 : 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/tasks/resume",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/cli/tasks/run",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const result = await ctx.runMutation(api.agentTasks.runTaskNow, {
        api_token: body.api_token,
        task_id: body.task_id,
      });
      return new Response(JSON.stringify({ success: result }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: msg }), {
        status: msg.includes("Unauthorized") ? 401 : 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/tasks/run",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

// `cast trigger update` — edit a trigger in place; every effective edit is
// recorded in agent_task_revisions (version history + audit log).
http.route({
  path: "/cli/tasks/update",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const result = await ctx.runMutation(api.agentTasks.updateTask, {
        api_token: body.api_token,
        task_id: body.task_id,
        title: body.title,
        prompt: body.prompt,
        schedule_type: body.schedule_type,
        run_at: body.run_at,
        interval_ms: body.interval_ms,
        event_filter: body.event_filter,
        mode: body.mode,
        agent_type: body.agent_type,
        project_path: body.project_path,
        max_runtime_ms: body.max_runtime_ms,
      });
      return new Response(JSON.stringify({ success: result.ok, changed: result.changed }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: msg }), {
        status: msg.includes("Unauthorized") ? 401 : 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/tasks/update",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

// `cast trigger history` — the trigger's edit log with actor names resolved.
http.route({
  path: "/cli/tasks/history",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    try {
      const body = await request.json();
      const result = await ctx.runQuery(api.agentTasks.listRevisions, {
        api_token: body.api_token,
        task_id: body.task_id,
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: msg }), {
        status: msg.includes("Unauthorized") ? 401 : 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }),
});

http.route({
  path: "/cli/tasks/history",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

// --- Task Layer Routes ---

// ── Slack webhook (Anchor inbound) ───────────────────────────────────────────
// An @mention or DM in a mapped channel wakes that channel's anchor. Verified by
// Slack's v0 HMAC signature (SLACK_SIGNING_SECRET) with replay protection, then
// deduped by event_id so a Slack retry can't double-wake.
http.route({
  path: "/api/webhooks/slack",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signature = request.headers.get("X-Slack-Signature");
    const timestamp = request.headers.get("X-Slack-Request-Timestamp");
    const body = await request.text();
    const secret = process.env.SLACK_SIGNING_SECRET;

    if (!secret) {
      console.error("[slack webhook] SLACK_SIGNING_SECRET not configured; refusing");
      return new Response(JSON.stringify({ error: "Webhook not configured" }), { status: 500 });
    }
    if (!signature || !timestamp) {
      return new Response(JSON.stringify({ error: "Missing signature" }), { status: 401 });
    }
    // Replay protection: reject stale timestamps (Slack recommends 5 minutes).
    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
      return new Response(JSON.stringify({ error: "Stale timestamp" }), { status: 401 });
    }
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
    const hex = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!timingSafeEqualHex(signature, "v0=" + hex)) {
      return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
    }

    const payload = JSON.parse(body);
    // Slack's one-time endpoint verification handshake.
    if (payload.type === "url_verification") {
      return new Response(payload.challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    if (payload.type === "event_callback") {
      const event = payload.event || {};
      const eventId = payload.event_id as string | undefined;
      // Ignore the bot's own posts on both paths, so an anchor reply that happens
      // to @mention the app can't wake it in a loop (each loop has a new event_id,
      // so dedup wouldn't catch it).
      const isMention =
        event.type === "app_mention" && !event.bot_id && !event.subtype;
      const isDM =
        event.type === "message" && event.channel_type === "im" && !event.bot_id && !event.subtype;
      if ((isMention || isDM) && eventId && event.channel) {
        // One atomic mutation: dedup + resolve channel→anchor + wake. If the wake
        // throws it returns 500 and Slack retries — the dedup row rolls back with
        // it, so a transient failure never silently drops the mention.
        await ctx.runMutation(internal.slack.wakeFromSlackEvent, {
          event_id: eventId,
          channel: event.channel,
          workspace: payload.team_id as string | undefined,
          user: event.user,
          text: String(event.text || ""),
          thread: event.thread_ts || event.ts,
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});


// The HTTP status for each structured failure code a mutation can raise (see
// chat.ts `chatFail`). Anything unmapped is a 500, which is what an unstructured
// throw already was.
const CLI_ERROR_STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
};

function cliRoute(
  path: string,
  handler: (ctx: any, body: any) => Promise<any>,
  // forwardDeviceId: this route's own function takes device_id as a real
  // argument (cast pull's destination, a terminal pane's machine, …), so after
  // the binding check the field must survive into the body instead of being
  // consumed. Note for the binding rollout: on these routes the one device_id
  // field is BOTH the binding presentation and the argument, so a bound token
  // can only ever name its own machine here — a route whose argument may
  // legitimately be a DIFFERENT device (terminal watch of another machine)
  // will need a separate presentation channel before its tokens are bound.
  opts?: { forwardDeviceId?: boolean },
) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  http.route({
    path,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      try {
        const body = await request.json();
        // Device binding, enforced once for every CLI endpoint rather than in
        // each of the ~100 handlers. A token that names a device may only act
        // from that device; a token that names none is unbound and behaves
        // exactly as it always has, which is what makes this migration-free.
        if (typeof body?.api_token === "string") {
          const allowed = await ctx.runQuery(internal.apiTokens.deviceBindingAllows, {
            api_token: body.api_token,
            device_id: typeof body.device_id === "string" ? body.device_id : undefined,
          });
          if (!allowed) {
            return new Response(
              JSON.stringify({
                error:
                  "This token is bound to a different machine. Run `cast auth` on this machine to mint its own.",
                code: "FORBIDDEN",
              }),
              { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } },
            );
          }
        }
        // device_id is consumed HERE and only forwarded on routes that declare
        // it (forwardDeviceId). Most cliRoute handlers pass the body straight
        // into a mutation whose validator is a closed `v.object`, so an
        // unrecognised field is a hard rejection — but for routes whose own
        // function REQUIRES device_id, deleting it is an equally hard rejection
        // the other way (this broke cast pull, vault mirror, and terminal
        // streaming: ct-44344 follow-up).
        if (!opts?.forwardDeviceId && body && typeof body === "object" && "device_id" in body) {
          delete body.device_id;
        }
        const result = await handler(ctx, body);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (error) {
        // A ConvexError carries structured data — { code, message, retryable } —
        // and flattening it to a string is what makes a caller unable to tell
        // "wait and retry" from "this will never be accepted". Pass the data
        // through, with a status that says the same thing, so an outbox can make
        // that decision without parsing prose.
        const data = (error as any)?.data;
        if (data && typeof data === "object" && typeof data.code === "string") {
          return new Response(
            JSON.stringify({ ...data, error: data.message ?? data.code }),
            {
              status: CLI_ERROR_STATUS[data.code] ?? 500,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }
        const msg = error instanceof Error ? error.message : String(error);
        return new Response(JSON.stringify({ error: msg }), {
          status: msg.includes("Unauthorized") ? 401 : 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }),
  });
  http.route({
    path,
    method: "OPTIONS",
    handler: httpAction(async () => {
      return new Response(null, {
        status: 204,
        headers: { ...corsHeaders },
      });
    }),
  });
}

// Projects
// ── Capability library (cast cap …) ──
//
// /cli/cap/status is live. The phase 2 verbs are REGISTERED but answer with a
// structured NOT_IMPLEMENTED, because the mutations behind them do not exist
// yet: reserving the paths now means a newer CLI against an older deploy gets
// a clean, coded error instead of a bare 404 it cannot tell from a typo'd URL.
//
// RULE for whoever lands /cli/cap/bind (from the design draft, easy to lose):
// an agent-minted capability token can NEVER create a binding above session
// scope. The bind mutation must inspect the credential class and reject user,
// device, project and team scopes for anything but a real api_token held by
// the user — otherwise the consent gate is enforced only inside a CLI process
// the agent controls.
cliRoute("/cli/cap/status", async (ctx, body) => {
  return await ctx.runQuery(api.capabilities.listCapabilityState, body);
});
cliRoute("/cli/cap/bind", async (ctx, body) => {
  return await ctx.runMutation(api.capabilities.bindCapability, body);
});
cliRoute("/cli/cap/unbind", async (ctx, body) => {
  return await ctx.runMutation(api.capabilities.unbindCapability, body);
});
cliRoute("/cli/cap/toggle", async (ctx, body) => {
  // toggle is bind with the flag: same upsert, same key, so the CLI and the
  // web can never disagree on which row a toggle lands on.
  return await ctx.runMutation(api.capabilities.bindCapability, body);
});
cliRoute("/cli/whoami", async (ctx, body) => {
  return await ctx.runQuery(api.capabilities.whoamiForToken, body);
});
cliRoute("/cli/cap/surfaces", async (ctx, body) => {
  return await ctx.runQuery(api.capabilities.surfacesForSlug, body);
});
cliRoute("/cli/cap/mode", async (ctx, body) => {
  return await ctx.runMutation(api.capabilities.setCapabilitiesMode, body);
});
cliRoute("/cli/cap/bindings", async (ctx, body) => {
  return await ctx.runQuery(api.capabilities.listBindingsForToken, body);
});
for (const verb of ["resolve", "why"]) {
  cliRoute(`/cli/cap/${verb}`, async () => {
    throw new ConvexError({
      code: "NOT_IMPLEMENTED",
      message: `cast cap ${verb} needs a newer backend deploy — this endpoint is reserved but not live yet`,
    });
  });
}

cliRoute("/cli/projects/create", async (ctx, body) => {
  return await ctx.runMutation(api.projects.create, body);
});
cliRoute("/cli/projects/list", async (ctx, body) => {
  return await ctx.runQuery(api.projects.list, body);
});
cliRoute("/cli/projects/get", async (ctx, body) => {
  return await ctx.runQuery(api.projects.get, body);
});
cliRoute("/cli/projects/update", async (ctx, body) => {
  return await ctx.runMutation(api.projects.update, body);
});
cliRoute("/cli/projects/post", async (ctx, body) => {
  return await ctx.runMutation(api.projectUpdates.post, body);
});
cliRoute("/cli/projects/updates", async (ctx, body) => {
  return await ctx.runQuery(api.projectUpdates.listUpdates, body);
});
cliRoute("/cli/projects/comment-update", async (ctx, body) => {
  return await ctx.runMutation(api.projectUpdates.comment, body);
});
cliRoute("/cli/projects/timeline", async (ctx, body) => {
  return await ctx.runQuery(api.projectUpdates.timeline, body);
});

// Anchors (standing agent members)
cliRoute("/cli/anchor/create", async (ctx, body) => {
  return await ctx.runMutation(api.anchors.provisionAnchor, body);
});
cliRoute("/cli/anchor/list", async (ctx, body) => {
  return await ctx.runQuery(api.anchors.listAnchors, body);
});
cliRoute("/cli/anchor/wake", async (ctx, body) => {
  return await ctx.runMutation(api.anchors.wakeAnchor, body);
});
cliRoute("/cli/anchor/resolve", async (ctx, body) => {
  return await ctx.runQuery(api.anchors.resolveAnchorForScope, body);
});
cliRoute("/cli/anchor/brief", async (ctx, body) => {
  return await ctx.runMutation(api.anchors.rebriefAnchor, body);
});
cliRoute("/cli/anchor/decommission", async (ctx, body) => {
  return await ctx.runMutation(api.anchors.decommissionAnchor, body);
});
cliRoute("/cli/anchor/link-channel", async (ctx, body) => {
  return await ctx.runAction(api.slack.linkChannel, body);
});
cliRoute("/cli/anchor/unlink-channel", async (ctx, body) => {
  return await ctx.runMutation(api.slack.unlinkChannel, body);
});
cliRoute("/cli/anchor/channels", async (ctx, body) => {
  return await ctx.runQuery(api.slack.listChannels, body);
});
cliRoute("/cli/anchor/say", async (ctx, body) => {
  return await ctx.runAction(api.slack.postMessage, body);
});
// The anchor speaking in codecast chat on its own: a channel post, a thread
// reply, or a DM. Authorizes the caller as the anchor's host inside.
cliRoute("/cli/anchor/say-chat", async (ctx, body) => {
  return await ctx.runMutation(api.chat.sendAsAnchor, body);
});

// Team chat. Every one of these authorizes the caller inside the function — this
// route only forwards the request body, so the mutation's own argument list is
// what keeps identity and scope out of the caller's hands.
cliRoute("/cli/chat/channels", async (ctx, body) => {
  return await ctx.runQuery(api.chat.listChannels, body);
});
cliRoute("/cli/chat/create-channel", async (ctx, body) => {
  return await ctx.runMutation(api.chat.createChannel, body);
});
cliRoute("/cli/chat/read", async (ctx, body) => {
  return await ctx.runQuery(api.chat.listMessages, body);
});
cliRoute("/cli/chat/thread", async (ctx, body) => {
  return await ctx.runQuery(api.chat.getThread, body);
});
cliRoute("/cli/chat/message", async (ctx, body) => {
  return await ctx.runQuery(api.chat.getMessage, body);
});
cliRoute("/cli/chat/search", async (ctx, body) => {
  return await ctx.runQuery(api.chat.searchMessages, body);
});
cliRoute("/cli/chat/send", async (ctx, body) => {
  return await ctx.runMutation(api.chat.sendMessage, body);
});
cliRoute("/cli/chat/mark-read", async (ctx, body) => {
  return await ctx.runMutation(api.chat.markRead, body);
});
// What the anchor runs to fill the placeholder already showing in the thread.
cliRoute("/cli/chat/reply", async (ctx, body) => {
  return await ctx.runMutation(api.chat.replyAsAnchor, body);
});
// Stop the anchor answering plain replies in one thread, or hand it a thread it
// has not spoken in. body: { api_token, root_id, follow }.
cliRoute("/cli/chat/anchor-follow", async (ctx, body) => {
  return await ctx.runMutation(api.chat.setAnchorFollow, body);
});
cliRoute("/cli/chat/react", async (ctx, body) => {
  return await ctx.runMutation(api.chat.toggleReaction, body);
});
// Stop one in-flight anchor turn now, instead of waiting out the deadline.
// body: { api_token, message_id } — the thinking placeholder's id.
cliRoute("/cli/chat/stop", async (ctx, body) => {
  return await ctx.runMutation(api.chat.stopAnchorReply, body);
});
// Archive (or restore) a channel. body: { api_token, channel_id, archived }.
cliRoute("/cli/chat/archive", async (ctx, body) => {
  return await ctx.runMutation(api.chat.archiveChannel, body);
});

// Tasks
cliRoute("/cli/work/create", async (ctx, body) => {
  return await ctx.runMutation(api.tasks.create, body);
});
cliRoute("/cli/calls/list", async (ctx, body) => {
  return await ctx.runQuery(api.transcripts.cliListCalls, body);
});
cliRoute("/cli/calls/get", async (ctx, body) => {
  return await ctx.runQuery(api.transcripts.cliGetCall, body);
});
cliRoute("/cli/work/list", async (ctx, body) => {
  return await ctx.runQuery(api.tasks.list, body);
});
cliRoute("/cli/work/get", async (ctx, body) => {
  return await ctx.runQuery(api.tasks.get, body);
});
cliRoute("/cli/work/update", async (ctx, body) => {
  return await ctx.runMutation(api.tasks.update, body);
});
cliRoute("/cli/work/comment", async (ctx, body) => {
  return await ctx.runMutation(api.tasks.addComment, body);
});
cliRoute("/cli/work/dep", async (ctx, body) => {
  return await ctx.runMutation(api.tasks.addDep, body);
});
cliRoute("/cli/work/undep", async (ctx, body) => {
  return await ctx.runMutation(api.tasks.removeDep, body);
});
cliRoute("/cli/work/context", async (ctx, body) => {
  return await ctx.runQuery(api.tasks.context, body);
});
cliRoute("/cli/work/promote", async (ctx, body) => {
  return await ctx.runMutation(api.tasks.promote, body);
});
cliRoute("/cli/work/snippet", async (ctx, body) => {
  return await ctx.runQuery(api.tasks.snippet, body);
});
cliRoute("/cli/work/heartbeat", async (ctx, body) => {
  return await ctx.runMutation(api.tasks.heartbeat, body);
});

cliRoute("/cli/work/mine", async (ctx, body) => {
  return await ctx.runAction(internal.taskMining.backfillDocsFromMessages, { user_id: body.user_id });
});

cliRoute("/cli/work/mine-all", async (_ctx, _body) => {
  return await _ctx.runAction(internal.taskMining.backfillAllTeams, {});
});

// Plans
cliRoute("/cli/plans/create", async (ctx, body) => {
  return await ctx.runMutation(api.plans.create, body);
});
cliRoute("/cli/plans/list", async (ctx, body) => {
  return await ctx.runQuery(api.plans.list, body);
});
cliRoute("/cli/plans/get", async (ctx, body) => {
  return await ctx.runQuery(api.plans.get, body);
});
cliRoute("/cli/plans/update", async (ctx, body) => {
  return await ctx.runMutation(api.plans.update, body);
});
cliRoute("/cli/plans/bind", async (ctx, body) => {
  return await ctx.runMutation(api.plans.bindSession, body);
});
cliRoute("/cli/plans/unbind", async (ctx, body) => {
  return await ctx.runMutation(api.plans.unbindSession, body);
});

// Unified comment route
cliRoute("/cli/plans/comment", async (ctx, body) => {
  return await ctx.runMutation(api.plans.addComment, body);
});
// Legacy routes — translate to addComment (only pass known args)
cliRoute("/cli/plans/log", async (ctx, body) => {
  return await ctx.runMutation(api.plans.addComment, {
    api_token: body.api_token, short_id: body.short_id,
    content: body.entry || body.content, type: "progress",
    session_id: body.session_id,
  });
});
cliRoute("/cli/plans/decide", async (ctx, body) => {
  return await ctx.runMutation(api.plans.addComment, {
    api_token: body.api_token, short_id: body.short_id,
    content: body.decision || body.content, type: "decision",
    rationale: body.rationale, session_id: body.session_id,
  });
});
cliRoute("/cli/plans/discover", async (ctx, body) => {
  return await ctx.runMutation(api.plans.addComment, {
    api_token: body.api_token, short_id: body.short_id,
    content: body.finding || body.content, type: "discovery",
    session_id: body.session_id,
  });
});
cliRoute("/cli/plans/pointer", async (ctx, body) => {
  return await ctx.runMutation(api.plans.addComment, {
    api_token: body.api_token, short_id: body.short_id,
    content: body.label || body.content, type: "reference",
    path_or_url: body.path_or_url,
  });
});
cliRoute("/cli/plans/status", async (ctx, body) => {
  return await ctx.runMutation(api.plans.updateStatus, body);
});
cliRoute("/cli/plans/snippet", async (ctx, body) => {
  return await ctx.runQuery(api.plans.snippet, body);
});
cliRoute("/cli/plans/drive-state", async (ctx, body) => {
  return await ctx.runMutation(api.plans.updateDriveState, body);
});
cliRoute("/cli/plans/drive-findings", async (ctx, body) => {
  return await ctx.runMutation(api.plans.recordDriveFindings, body);
});
cliRoute("/cli/plans/orchestration-status", async (ctx, body) => {
  return await ctx.runQuery(api.plans.getOrchestrationStatus, body);
});
cliRoute("/cli/plans/escalation", async (ctx, body) => {
  return await ctx.runMutation(api.plans.addEscalation, body);
});
cliRoute("/cli/plans/recalc", async (ctx, body) => {
  return await ctx.runMutation(api.plans.recalcPlanProgress, body);
});
cliRoute("/cli/plans/save-retro", async (ctx, body) => {
  return await ctx.runMutation(api.plans.saveRetro, body);
});
cliRoute("/cli/plans/share", async (ctx, body) => {
  return await ctx.runMutation(api.plans.generateShareLink, body);
});
cliRoute("/cli/plans/unshare", async (ctx, body) => {
  return await ctx.runMutation(api.plans.unsharePlan, body);
});
cliRoute("/cli/orchestration/emit", async (ctx, body) => {
  return await ctx.runMutation(api.orchestrationEvents.emit, body);
});
cliRoute("/cli/orchestration/events", async (ctx, body) => {
  return await ctx.runQuery(api.orchestrationEvents.listByPlan, body);
});
cliRoute("/cli/progress/append", async (ctx, body) => {
  return await ctx.runMutation(api.progressEvents.append, body);
});
cliRoute("/cli/progress/replay", async (ctx, body) => {
  return await ctx.runQuery(api.progressEvents.replay, body);
});
cliRoute("/cli/progress/latest", async (ctx, body) => {
  return await ctx.runQuery(api.progressEvents.latest, body);
});

// Docs
cliRoute("/cli/docs/create", async (ctx, body) => {
  return await ctx.runMutation(api.docs.create, body);
});
cliRoute("/cli/docs/list", async (ctx, body) => {
  return await ctx.runQuery(api.docs.list, body);
});
cliRoute("/cli/docs/get", async (ctx, body) => {
  return await ctx.runQuery(api.docs.get, body);
});
cliRoute("/cli/docs/update", async (ctx, body) => {
  const result = await ctx.runMutation(api.docs.update, body);
  // The mutation returns the content it stored whenever the text changed — a
  // title edit rewrites the heading line, so it resets the editor snapshot too.
  if (result.content !== undefined) {
    await ctx.runMutation(api.docs.resetSync, { api_token: body.api_token, id: body.id, content: result.content });
  }
  return result;
});
cliRoute("/cli/docs/comment", async (ctx, body) => {
  return await ctx.runMutation(api.docs.addComment, body);
});
cliRoute("/cli/docs/search", async (ctx, body) => {
  return await ctx.runQuery(api.docs.search, body);
});
cliRoute("/cli/docs/share", async (ctx, body) => {
  return await ctx.runMutation(api.docs.generateShareLink, body);
});
cliRoute("/cli/docs/unshare", async (ctx, body) => {
  return await ctx.runMutation(api.docs.unshare, body);
});
cliRoute("/cli/docs/delete", async (ctx, body) => {
  return await ctx.runMutation(api.docs.remove, body);
});
cliRoute("/cli/docs/patch", async (ctx, body) => {
  const result = await ctx.runMutation(api.docs.patch, body);
  if (result.content) {
    await ctx.runMutation(api.docs.resetSync, { api_token: body.api_token, id: body.id, content: result.content });
  }
  return result;
});

// Workflows
cliRoute("/cli/workflows/upsert", async (ctx, body) => {
  return await ctx.runMutation(api.workflows.upsert, body);
});
cliRoute("/cli/workflows/list", async (ctx, body) => {
  return await ctx.runMutation(api.workflows.list, body);
});

// Workflow Runs
cliRoute("/cli/workflow-runs/create", async (ctx, body) => ctx.runMutation(api.workflow_runs.createFromCli, body));
cliRoute("/cli/workflow-runs/get", async (ctx, body) => ctx.runMutation(api.workflow_runs.getForDaemon, body));
cliRoute("/cli/workflow-runs/progress", async (ctx, body) => ctx.runMutation(api.workflow_runs.updateProgress, body));
cliRoute("/cli/workflow-runs/gate", async (ctx, body) => ctx.runMutation(api.workflow_runs.pauseAtGate, body));
cliRoute("/cli/workflow-runs/poll-gate", async (ctx, body) => ctx.runMutation(api.workflow_runs.pollGateResponse, body));
cliRoute("/cli/workflow-runs/set-primary", async (ctx, body) => ctx.runMutation(api.workflow_runs.setPrimarySession, body));
cliRoute("/cli/workflow-runs/respond-gate", async (ctx, body) => ctx.runMutation(api.workflow_runs.respondToGateFromCli, body));
cliRoute("/cli/workflow-runs/ingest", async (ctx, body) => ctx.runMutation(api.workflow_runs.ingestSnapshot, body));
cliRoute("/cli/workflow-runs/by-external", async (ctx, body) => ctx.runQuery(api.workflow_runs.getByExternalRun, body));

// Session-to-session messaging
cliRoute("/cli/messages/send", async (ctx, body) => ctx.runMutation(api.pendingMessages.sendSessionMessage, body));

// Session labels (personal filing). List the catalog, file/unfile a session,
// and manage the label catalog itself.
cliRoute("/cli/labels/list", async (ctx, body) => ctx.runQuery(api.buckets.cliListLabels, body));
cliRoute("/cli/labels/set", async (ctx, body) => ctx.runMutation(api.buckets.cliSetLabel, body));
cliRoute("/cli/labels/clear", async (ctx, body) => ctx.runMutation(api.buckets.cliClearLabel, body));
cliRoute("/cli/labels/create", async (ctx, body) => ctx.runMutation(api.buckets.cliCreateLabel, body));
cliRoute("/cli/labels/rename", async (ctx, body) => ctx.runMutation(api.buckets.cliRenameLabel, body));
cliRoute("/cli/labels/remove", async (ctx, body) => ctx.runMutation(api.buckets.cliArchiveLabel, body));

// Spawn a fresh, inbox-visible session (cast spawn). `api.spawn` is filled in by
// codegen on deploy; cast to any so the committed _generated typecheck stays green
// until then.
cliRoute("/cli/spawn", async (ctx, body) => ctx.runMutation((api as any).spawn.createSessionFromCli, body));

// Session OWNERS (cast own / disown / owners, or scripts routing an agent-run
// session into a human's inbox). A session has a SET of owners — it can sit in
// several teammates' inboxes at once — so `own` ADDS and `disown` REMOVES one,
// leaving the others alone. `owners/set` replaces the set wholesale (the web
// multi-select, and `cast disown --all`).
// body: { api_token, session_id, owner: "<email|name>" | "me" }.
// Inbox visibility (cast dismiss / undismiss / kill): hide a session from the
// user's inbox (agent keeps running), restore it, or retire it (teardown +
// Killed bucket). One mutation, action pinned per route so the URLs stay
// self-documenting. body: { api_token, session }.
cliRoute("/cli/sessions/dismiss", async (ctx, body) => ctx.runMutation(api.conversations.cliSetSessionVisibility, { ...body, action: "dismiss" }));
cliRoute("/cli/sessions/undismiss", async (ctx, body) => ctx.runMutation(api.conversations.cliSetSessionVisibility, { ...body, action: "undismiss" }));
cliRoute("/cli/sessions/kill", async (ctx, body) => ctx.runMutation(api.conversations.cliSetSessionVisibility, { ...body, action: "kill" }));

// Resume (cast resume <session> --tmux): bring the agent up in its managed pane
// without killing a live one. body: { api_token, session }.
cliRoute("/cli/sessions/resume", async (ctx, body) => ctx.runMutation(api.conversations.cliResumeSession, body));

// Restart (cast restart <session>): kill the agent and resume it through the
// daemon's resume ladder — the web header's "Restart session", from a shell.
// body: { api_token, session, repair? }.
cliRoute("/cli/sessions/restart", async (ctx, body) => ctx.runMutation(api.conversations.cliRestartSession, body));

// In-place agent/model switch (cast switch): stay on this conversation, drop a
// divider, reconstitute as the new agent. body: { api_token, session, agent_type?, model?, effort? }.
cliRoute("/cli/sessions/switch", async (ctx, body) => ctx.runMutation(api.conversations.switchSessionAgent, body));

// Rename (cast rename): set a session's title with the custom flag so the
// auto-titler never overwrites it. body: { api_token, session, title }.
cliRoute("/cli/sessions/rename", async (ctx, body) => ctx.runMutation(api.conversations.cliRenameSession, body));

// Pinned thread state (cast state): the agent's standing "where this stands"
// line, shown pinned above the composer and on the inbox card. Empty text
// clears it. body: { api_token, session, text? }.
cliRoute("/cli/sessions/state/set", async (ctx, body) => ctx.runMutation(api.conversations.setThreadState, body));
cliRoute("/cli/sessions/state/get", async (ctx, body) => ctx.runQuery(api.conversations.getThreadState, body));

cliRoute("/cli/sessions/own", async (ctx, body) => ctx.runMutation(api.sessionOwnership.addSessionOwner, body));
cliRoute("/cli/sessions/disown", async (ctx, body) => ctx.runMutation(api.sessionOwnership.removeSessionOwner, body));
cliRoute("/cli/sessions/owners/set", async (ctx, body) => ctx.runMutation(api.sessionOwnership.setSessionOwners, body));
cliRoute("/cli/sessions/owners", async (ctx, body) => ctx.runQuery(api.sessionOwnership.listOwners, body));

// Cross-user device reparent (cast pull): pull a session you run or own — or a
// team-visible one (see findPullableConversation) — onto the
// caller's OWN device. Account follows device — user_id becomes the caller, the
// author is pinned. body: { api_token, session_id, device_id }.
cliRoute("/cli/sessions/reparent", async (ctx, body) => ctx.runMutation(api.devices.reparentSessionToDevice, body), { forwardDeviceId: true });

// CC account switching: route the swap + blocked-session revive through the
// daemon fleet / nudge limit-parked sessions after a window reset.
cliRoute("/cli/accounts/switch", async (ctx, body) => ctx.runMutation(api.accountSwitch.requestAccountSwitch, body), { forwardDeviceId: true });
cliRoute("/cli/accounts/continue-blocked", async (ctx, body) => ctx.runMutation(api.accountSwitch.continueAllBlocked, body));
cliRoute("/cli/accounts/save", async (ctx, body) => ctx.runMutation(api.accountSwitch.saveAccountProfile, body), { forwardDeviceId: true });
cliRoute("/cli/accounts/publish", async (ctx, body) => ctx.runMutation(api.accountSwitch.publishDeviceAccounts, body), { forwardDeviceId: true });
cliRoute("/cli/accounts/recovery-status", async (ctx, body) => ctx.runQuery(api.accountSwitch.recoveryStatus, body));

// --- Published HTML artifacts (cast publish → codecast.sh/a/<slug>) ---
// All handlers live in artifactsHttp.ts (they need Web Crypto + storage.store,
// which only actions have). Pages/presentation: artifactPages.ts. Data:
// artifacts.ts. Every POST here is callable from the sandboxed artifact pages
// (opaque origin), so each registers a CORS preflight too.

import {
  publish as artifactPublish,
  serve as artifactServe,
  unlock as artifactUnlock,
  emailUnlock as artifactEmailUnlock,
  manage as artifactManage,
  rollback as artifactRollback,
  edit as artifactEdit,
  comment as artifactComment,
  identity as artifactIdentity,
  view as artifactView,
  corsPreflight as artifactCors,
} from "./artifactsHttp";

const artifactPost = (path: string, handler: typeof artifactPublish) => {
  http.route({ path, method: "POST", handler });
  http.route({ path, method: "OPTIONS", handler: artifactCors });
};

artifactPost("/cli/artifacts/publish", artifactPublish);
artifactPost("/cli/artifacts/unlock", artifactUnlock);
artifactPost("/cli/artifacts/email-unlock", artifactEmailUnlock);
artifactPost("/cli/artifacts/manage", artifactManage);
artifactPost("/cli/artifacts/rollback", artifactRollback);
artifactPost("/cli/artifacts/edit", artifactEdit);
artifactPost("/cli/artifacts/comment", artifactComment);
artifactPost("/cli/artifacts/identity", artifactIdentity);
artifactPost("/cli/artifacts/view", artifactView);

// Vault remote mirror — the daemon's push channel (packages/cli/src/vault/
// vaultMirror.ts). Mirroring is opt-in per vault; a vault nobody turned on
// never reaches these routes at all. The body upload URL deliberately reuses
// images.generateUploadUrl: it is the generic "give this authenticated user a
// storage upload URL" mutation, and a vault-specific twin of it would be the
// same function under a second name.
cliRoute("/cli/vault/register", async (ctx, body) => ctx.runMutation(api.vaultMirror.cliRegisterMirror, body), { forwardDeviceId: true });
cliRoute("/cli/vault/upsert", async (ctx, body) => ctx.runMutation(api.vaultMirror.cliUpsertNotes, body), { forwardDeviceId: true });
cliRoute("/cli/vault/upload-url", async (ctx, body) => ctx.runMutation(api.images.generateUploadUrl, body));

// Remote pane watching — the daemon's frame push (packages/cli/src/terminal/
// paneStream.ts). Only reached while a viewer holds a lease on the pane; the
// reply carries that lease, so the capture loop learns when to stop from the
// request it was already making.
cliRoute("/cli/terminal/frame", async (ctx, body) => ctx.runMutation(api.terminalStream.cliPushFrame, body), { forwardDeviceId: true });
// The viewer half, for callers with a token instead of a browser session.
cliRoute("/cli/terminal/watch", async (ctx, body) => ctx.runMutation(api.terminalStream.watchPane, body), { forwardDeviceId: true });
cliRoute("/cli/terminal/pane", async (ctx, body) => ctx.runQuery(api.terminalStream.getPane, body), { forwardDeviceId: true });
cliRoute("/cli/terminal/input", async (ctx, body) => ctx.runMutation(api.terminalStream.sendPaneInput, body), { forwardDeviceId: true });

// Image sharing (cast image): upload a screenshot/image to storage, then
// resolve its stable public /api/storage/<uuid> URL for inline embedding in
// message markdown and cast-canvas blocks. Same generic mutations as above.
cliRoute("/cli/images/upload-url", async (ctx, body) => ctx.runMutation(api.images.generateUploadUrl, body));
cliRoute("/cli/images/url", async (ctx, body) => ({ url: await ctx.runQuery(api.images.getImageUrl, body) }));

cliRoute("/cli/artifacts/list", async (ctx, body) => ctx.runQuery(api.artifacts.listFromCLI, body));
cliRoute("/cli/artifacts/delete", async (ctx, body) => ctx.runMutation(api.artifacts.deleteFromCLI, body));

// Raw artifact HTML + assets. Lives under /cli/ because the Caddy proxy in
// front of the self-hosted backend forwards only that prefix (plus
// auth/webhooks) to the HTTP-action upstream. codecast.sh/a/<slug> 302s to the
// a.codecast.sh edge cache, which fetches this origin.
//
// CSP `sandbox` makes the document an opaque origin even when opened directly:
// scripts run, but the page can never touch convex.codecast.sh state.
http.route({ pathPrefix: "/cli/a/", method: "GET", handler: artifactServe });

// One-click unsubscribe for the notification digest (emails/digest.ts). Lives
// under /cli/ because Caddy forwards only that prefix to HTTP actions. GET
// serves the human clicking the footer link; POST serves RFC 8058 one-click
// (Gmail/Yahoo fire it without opening a page). Token-bearing and idempotent.
const emailUnsubscribe = httpAction(async (ctx, request) => {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const result: { ok: boolean } = await ctx.runMutation(
    internal.emails.digest.unsubscribeByToken,
    { token },
  );
  return unsubscribeResponse({
    ok: result.ok,
    method: request.method,
    brand: BRAND,
    settingsUrl: `${BRAND.url}/settings/notifications`,
  });
});
http.route({ path: "/cli/email/unsubscribe", method: "GET", handler: emailUnsubscribe });
http.route({ path: "/cli/email/unsubscribe", method: "POST", handler: emailUnsubscribe });

export default http;
