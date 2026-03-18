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
      const { api_token, query, limit, offset, start_time, end_time, context_before, context_after, project_path, user_only, member_name } = body;

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
      const { api_token, conversation_id, start_line, end_line, full_content } = body;

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
      const { api_token, limit, offset, start_time, end_time, query, project_path, member_name, live_only } = body;

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
        live_only,
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
      const { api_token, version, platform, pid, autostart_enabled, has_tmux } = body;

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
      const { api_token, conversation_id, message_uuid } = body;
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
      const result = await ctx.runMutation(api.agentTasks.createTask, body);
      return new Response(JSON.stringify({ task_id: result }), {
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

// --- Task Layer Routes ---

function cliRoute(path: string, handler: (ctx: any, body: any) => Promise<any>) {
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
        const result = await handler(ctx, body);
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

// Tasks
cliRoute("/cli/work/create", async (ctx, body) => {
  return await ctx.runMutation(api.tasks.create, body);
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
cliRoute("/cli/work/context", async (ctx, body) => {
  return await ctx.runQuery(api.tasks.context, body);
});
cliRoute("/cli/work/promote", async (ctx, body) => {
  return await ctx.runMutation(api.tasks.promote, body);
});
cliRoute("/cli/work/snippet", async (ctx, body) => {
  return await ctx.runQuery(api.tasks.snippet, body);
});
cliRoute("/cli/work/backfill", async (ctx, body) => {
  return await ctx.runMutation(api.tasks.backfillTeamScope, body);
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
cliRoute("/cli/plans/log", async (ctx, body) => {
  return await ctx.runMutation(api.plans.addLogEntry, body);
});
cliRoute("/cli/plans/decide", async (ctx, body) => {
  return await ctx.runMutation(api.plans.addDecision, body);
});
cliRoute("/cli/plans/discover", async (ctx, body) => {
  return await ctx.runMutation(api.plans.addDiscovery, body);
});
cliRoute("/cli/plans/pointer", async (ctx, body) => {
  return await ctx.runMutation(api.plans.addPointer, body);
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
cliRoute("/cli/orchestration/emit", async (ctx, body) => {
  return await ctx.runMutation(api.orchestrationEvents.emit, body);
});
cliRoute("/cli/orchestration/events", async (ctx, body) => {
  return await ctx.runQuery(api.orchestrationEvents.listByPlan, body);
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
  return await ctx.runMutation(api.docs.update, body);
});
cliRoute("/cli/docs/search", async (ctx, body) => {
  return await ctx.runQuery(api.docs.search, body);
});

export default http;
