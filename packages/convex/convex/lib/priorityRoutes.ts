// `cast priorities` on the CLI router (http.ts): what each person is driving
// at, and their own controls over it (priorities.ts).
import type { HttpRouter } from "convex/server";
import { api } from "../_generated/api";
import { registerCliRoute } from "./cliRoute";

const QUERIES = { list: "cliList", show: "cliShow", history: "cliHistory" } as const;
const MUTATIONS = { rank: "cliRank", step: "cliSetStepTier", "set-aside": "cliSetAside", restore: "cliRestore", run: "cliRun" } as const;

export function registerPriorityRoutes(http: HttpRouter): void {
  // Codegen catches up on the next push.
  const fns = (api as any).priorities;
  for (const [route, fn] of Object.entries(QUERIES)) registerCliRoute(http, `/cli/priorities/${route}`, async (ctx, body) => ctx.runQuery(fns[fn], body));
  for (const [route, fn] of Object.entries(MUTATIONS)) registerCliRoute(http, `/cli/priorities/${route}`, async (ctx, body) => ctx.runMutation(fns[fn], body));
}
