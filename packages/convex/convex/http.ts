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

    if (webhookSecret && signature) {
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
      const { api_token, query, limit, offset, start_time, end_time, context_before, context_after, project_path, user_only } = body;

      if (!api_token || !query) {
        return new Response(JSON.stringify({ error: "Missing api_token or query" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
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

      const result = await ctx.runQuery(api.conversations.feedForCLI, {
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

export default http;
