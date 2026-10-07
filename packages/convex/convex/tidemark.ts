// tidemark's store on this deployment (@platform/tidemark/stores/convex). An
// action reaches the store through these two functions, one call each: reads
// through `read`, writes through `write`, each its own transaction. Both stay
// internal and check nothing themselves: a read is kept to one conversation
// by the history reader's viewer, inside the calling action, and a write
// trusts its internal caller. No client may ever reach the store directly.
import { v } from "convex/values";
import { convexStore, remoteStore, serveStoreOp, type ConvexHistoryStore } from "@platform/tidemark/stores/convex";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./functions";

const opArgs = { op: v.string(), args: v.string() };

export const read = internalQuery({
  args: opArgs,
  returns: v.string(),
  handler: async (ctx, a) => await serveStoreOp(convexStore(ctx.db), "read", a.op, a.args),
});

export const write = internalMutation({
  args: opArgs,
  returns: v.string(),
  handler: async (ctx, a) => await serveStoreOp(convexStore(ctx.db), "write", a.op, a.args),
});

/** The store from an action. */
export function actionStore(ctx: { runQuery: (ref: any, args: any) => Promise<any>; runMutation: (ref: any, args: any) => Promise<any> }): ConvexHistoryStore {
  return remoteStore({
    query: (op, args) => ctx.runQuery(internal.tidemark.read, { op, args }),
    mutation: (op, args) => ctx.runMutation(internal.tidemark.write, { op, args }),
  });
}
