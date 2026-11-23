// The one way http.ts registers a `cast` CLI route: POST with permissive CORS
// and its OPTIONS preflight, the token's device binding asked before the
// handler runs, and every error answered in the CLI's shape (cliErrorReply).
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { cliErrorReply } from "./cliErrorStatus";

const CLI_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export type CliRouteOptions = { forwardDeviceId?: boolean };

export function registerCliRoute(
  http: HttpRouter,
  path: string,
  handler: (ctx: any, body: any) => Promise<any>,
  // forwardDeviceId: this route's own function takes device_id as a real
  // argument (cast pull's destination, a terminal pane's machine, …), so the
  // field must survive into the body instead of being stripped. It is only
  // ever an argument: the device a token is presented FROM rides inside
  // api_token itself (@platform/auth tokenFormat), so a route whose argument
  // names a different machine than the caller's is fine.
  opts?: CliRouteOptions,
) {
  const corsHeaders = CLI_CORS_HEADERS;
  http.route({
    path,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      try {
        const body = await request.json();
        // Device binding, asked here ahead of the handler so a request from the
        // wrong machine gets a 403 that names the fix. The handler's own
        // verifyApiToken enforces the same rule on api_token as it arrived, so
        // this is the better error, not the only check: a direct Convex call
        // that never passes through here is refused just the same.
        if (typeof body?.api_token === "string") {
          const allowed = await ctx.runQuery(internal.apiTokens.deviceBindingAllows, {
            api_token: body.api_token,
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
        // A device_id body field is only forwarded on routes that declare it
        // (forwardDeviceId). Most cliRoute handlers pass the body straight
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
        const reply = cliErrorReply(error, path);
        return new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }),
  });
  registerCliPreflight(http, path);
}

/** The OPTIONS preflight a `cast` route answers: permissive CORS for POST. */
export function registerCliPreflight(http: HttpRouter, path: string) {
  http.route({ path, method: "OPTIONS", handler: cliPreflight });
}

const cliPreflight = httpAction(async () => new Response(null, { status: 204, headers: CLI_CORS_HEADERS }));
