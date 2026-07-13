import { useEffect, useMemo, useState } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import { getFunctionName } from "convex/server";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { convexToJson, type Value } from "convex/values";

// Returned (as a stable instance — consumers may use it in memo deps) when the
// circuit breaker drops a subscription that never resolved. Renders through the
// same error paths as a terminal server error.
export const queryCircuitOpenError = new Error(
  "Query did not resolve within the deadline; subscription dropped."
);

// Drop-in useQuery that returns terminal server errors instead of throwing them
// during render. convex's useQuery is useQueries plus a re-throw — a query that
// fails with a non-retryable error (e.g. searchConversations exceeding the
// backend's syscall budget, ct-37627) crashes the subscribing component into
// its ErrorBoundary. Use this for queries where a server failure should degrade
// the feature, not unmount the surface (search panels, optional enrichment).
//
// breakAfterMs (opt-in) adds a circuit breaker for the OTHER failure class:
// errors convex considers retryable (InternalServerError under backend
// saturation) are never surfaced — the client silently re-sends the query
// forever, and on the self-hosted backend each failed execution closes the
// shared websocket (1011), degrading every live subscription in the app every
// few seconds. If the query hasn't resolved within the deadline, we UNSUBSCRIBE
// it (that's what actually stops the re-send loop) and return
// queryCircuitOpenError. The breaker re-arms when the args change.
export function useQueryNoThrow<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query> | "skip",
  opts?: { breakAfterMs?: number },
): { data: FunctionReturnType<Query> | undefined; error: Error | undefined } {
  const skip = args === "skip";
  const queryName = getFunctionName(query);
  // Key the memo on serialized args, not object identity: useQueries treats a
  // fresh record object as a whole new query set and re-subscribes mid-render
  // (React "too many re-renders"). Mirrors convex's own useQuery internals.
  const argsJson = JSON.stringify(skip ? {} : convexToJson(args as Record<string, Value>));
  const key = `${queryName}:${argsJson}`;
  const [brokenKey, setBrokenKey] = useState<string | null>(null);
  const broken = !skip && brokenKey === key;
  const subscribed = !skip && !broken;
  const queries = useMemo<RequestForQueries>(
    () => (subscribed ? { value: { query, args: args as Record<string, Value> } } : ({} as RequestForQueries)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [argsJson, queryName, subscribed],
  );
  const results = useQueries(queries);
  const value = subscribed ? results.value : undefined;
  const loading = subscribed && value === undefined;

  const breakAfterMs = opts?.breakAfterMs;
  useEffect(() => {
    if (!breakAfterMs || !loading) return;
    const timer = setTimeout(() => setBrokenKey(key), breakAfterMs);
    return () => clearTimeout(timer);
  }, [key, loading, breakAfterMs]);

  if (broken) return { data: undefined, error: queryCircuitOpenError };
  if (value instanceof Error) return { data: undefined, error: value };
  return { data: value, error: undefined };
}
