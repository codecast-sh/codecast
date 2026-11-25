// The CLI routes for production's pause, lift and rollback (docs/architecture/deploys.md DP17 to DP19), kept out of
// http.ts, which may not grow.
import type { HttpRouter } from "convex/server";
import { api } from "../_generated/api";
import { registerCliRoute } from "./cliRoute";

export function registerDeployPauseRoutes(http: HttpRouter): void {
  registerCliRoute(http, "/cli/deploys/pause/status", async (ctx, body) => ctx.runQuery(api.deployPause.status, body));
  registerCliRoute(http, "/cli/deploys/pause", async (ctx, body) => ctx.runMutation(api.deployPause.pause, body));
  registerCliRoute(http, "/cli/deploys/pause/lift", async (ctx, body) => ctx.runMutation(api.deployPause.lift, body));
  registerCliRoute(http, "/cli/deploys/pause/grant", async (ctx, body) => ctx.runMutation(api.deployPause.grant, body));
  registerCliRoute(http, "/cli/deploys/rollback", async (ctx, body) => ctx.runMutation(api.deployRollback.rollback, body));
}
