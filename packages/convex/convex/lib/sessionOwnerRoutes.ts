// The CLI routes for a session's owners (`cast own`, `cast disown`, `cast owners`), kept out of http.ts, which may not grow.
import type { HttpRouter } from "convex/server";
import { api } from "../_generated/api";
import { registerCliRoute } from "./cliRoute";

export function registerSessionOwnerRoutes(http: HttpRouter): void {
  registerCliRoute(http, "/cli/sessions/own", async (ctx, body) => ctx.runMutation(api.sessionOwnership.addSessionOwner, body));
  registerCliRoute(http, "/cli/sessions/disown", async (ctx, body) => ctx.runMutation(api.sessionOwnership.removeSessionOwner, body));
  registerCliRoute(http, "/cli/sessions/owners/set", async (ctx, body) => ctx.runMutation(api.sessionOwnership.setSessionOwners, body));
  registerCliRoute(http, "/cli/sessions/owners", async (ctx, body) => ctx.runQuery(api.sessionOwnership.listOwners, body));
  registerCliRoute(http, "/cli/sessions/owners/apply", async (ctx, body) => ctx.runMutation(api.sessionOwnership.applyOwnersChange, body));
  // `cast own <s> --pass-up`: the agent owner sends the session's wait to its people.
  registerCliRoute(http, "/cli/sessions/pass-up", async (ctx, body) => ctx.runMutation(api.notifications.passWaitUp, body));
}
