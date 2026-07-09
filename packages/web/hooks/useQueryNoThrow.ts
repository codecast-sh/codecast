import { useMemo } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import { getFunctionName } from "convex/server";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { convexToJson, type Value } from "convex/values";

// Drop-in useQuery that returns terminal server errors instead of throwing them
// during render. convex's useQuery is useQueries plus a re-throw — a query that
// fails with a non-retryable error (e.g. searchConversations exceeding the
// backend's syscall budget, ct-37627) crashes the subscribing component into
// its ErrorBoundary. Use this for queries where a server failure should degrade
// the feature, not unmount the surface (search panels, optional enrichment).
export function useQueryNoThrow<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query> | "skip",
): { data: FunctionReturnType<Query> | undefined; error: Error | undefined } {
  const skip = args === "skip";
  const queryName = getFunctionName(query);
  // Key the memo on serialized args, not object identity: useQueries treats a
  // fresh record object as a whole new query set and re-subscribes mid-render
  // (React "too many re-renders"). Mirrors convex's own useQuery internals.
  const argsJson = JSON.stringify(skip ? {} : convexToJson(args as Record<string, Value>));
  const queries = useMemo<RequestForQueries>(
    () => (skip ? ({} as RequestForQueries) : { value: { query, args: args as Record<string, Value> } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [argsJson, queryName, skip],
  );
  const results = useQueries(queries);
  const value = skip ? undefined : results.value;
  if (value instanceof Error) return { data: undefined, error: value };
  return { data: value, error: undefined };
}
