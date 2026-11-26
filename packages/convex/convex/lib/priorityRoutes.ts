// `cast priorities` on the CLI router (http.ts): what each person is driving
// at, and their own controls over it (priorities.ts).
import type { HttpRouter } from "convex/server";
import { api } from "../_generated/api";
import { registerCliRoute } from "./cliRoute";

const QUERIES = { list: "cliList", show: "cliShow", history: "cliHistory" } as const;
const MUTATIONS = {
  move: "cliMove",
  step: "cliSetStepTier",
  milestone: "cliMilestone",
  "set-aside": "cliSetAside",
  restore: "cliRestore",
  done: "cliDone",
  merge: "cliMerge",
  "session-move": "cliMoveSession",
  "session-not-this": "cliSessionNotThis",
  correct: "cliCorrect",
  "correction-delete": "cliDeleteCorrection",
  run: "cliRun",
} as const;

export function registerPriorityRoutes(http: HttpRouter): void {
  // Codegen catches up on the next push.
  const fns = (api as any).priorities;
  for (const [route, fn] of Object.entries(QUERIES)) registerCliRoute(http, `/cli/priorities/${route}`, async (ctx, body) => ctx.runQuery(fns[fn], body));
  for (const [route, fn] of Object.entries(MUTATIONS)) registerCliRoute(http, `/cli/priorities/${route}`, async (ctx, body) => ctx.runMutation(fns[fn], body));
}
