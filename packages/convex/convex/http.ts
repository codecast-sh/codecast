import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { internal, api } from "./_generated/api";

const http = httpRouter();

auth.addHttpRoutes(http);


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

      if (signature !== expectedSignature) {
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
        share_url: `https://codecast.sh/share/${result.share_token}`,
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
      const { api_token, query, limit, context_before, context_after, project_path, user_only } = body;

      if (!api_token || !query) {
        return new Response(JSON.stringify({ error: "Missing api_token or query" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.conversations.searchForCLI, {
        api_token,
        query,
        limit,
        context_before,
        context_after,
        project_path,
        user_only,
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
      const { api_token, conversation_id, start_line, end_line } = body;

      if (!api_token || !conversation_id) {
        return new Response(JSON.stringify({ error: "Missing api_token or conversation_id" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.conversations.readConversationMessages, {
        api_token,
        conversation_id,
        start_line,
        end_line,
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
      const { api_token, limit, offset, start_time, end_time, query, project_path } = body;

      if (!api_token) {
        return new Response(JSON.stringify({ error: "Missing api_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const result = await ctx.runMutation(api.conversations.feedForCLI, {
        api_token,
        limit,
        offset,
        start_time,
        end_time,
        query,
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

export default http;
