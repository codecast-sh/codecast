// Change-feed write interceptor.
//
// Drop-in replacements for `mutation` / `internalMutation` from
// `./_generated/server`. They behave identically EXCEPT that every insert /
// patch / replace / delete to a tracked table (conversations/tasks/docs/plans)
// also upserts that entity's row in `change_log` — see changeLog.ts. Completeness
// comes from this ONE interception point: any mutation that imports its builder
// from here emits automatically, no matter how it writes (direct ctx.db,
// createDataContext, its .raw / .unscoped escape hatches — all bottom out at the
// wrapped ctx.db). The guard test (functions.guard.test.ts) fails CI if a file
// that writes a tracked table imports the raw builders instead, so the discipline
// requirement is machine-checked rather than remembered.
//
// No external dependency: we wrap the handler ourselves and swap ctx.db for a
// proxy. The interceptor's own change_log writes go through the RAW db, so they
// never re-enter the proxy (no recursion; change_log is untracked anyway).
import {
  mutation as rawMutation,
  internalMutation as rawInternalMutation,
} from "./_generated/server";
import { makeChangeTrackedDb } from "./changeLog";

function withChangeLog(ctx: any): any {
  return { ...ctx, db: makeChangeTrackedDb(ctx.db) };
}

function wrapDefinition(def: any): any {
  if (typeof def === "function") {
    return (ctx: any, args: any) => def(withChangeLog(ctx), args);
  }
  return { ...def, handler: (ctx: any, args: any) => def.handler(withChangeLog(ctx), args) };
}

// Same call signatures as the generated builders (cast preserves the rich
// validator/typing surface; the runtime wrapper only swaps ctx.db).
export const mutation = ((def: any) => rawMutation(wrapDefinition(def))) as typeof rawMutation;
export const internalMutation = ((def: any) =>
  rawInternalMutation(wrapDefinition(def))) as typeof rawInternalMutation;

// Re-export the rest of the builder surface so a writer file imports its whole
// toolkit from "./functions" with a single path swap — and so anything that
// later imports from here gets the change-tracking mutation by default. Only
// mutation/internalMutation above are wrapped; the rest are plain pass-throughs
// (queries and actions have no ctx.db to intercept).
export { query, internalQuery, action, internalAction } from "./_generated/server";
export type { QueryCtx, MutationCtx, ActionCtx } from "./_generated/server";
