import type { ConvexReactClient } from "convex/react";
import type { FunctionReference } from "convex/server";

/**
 * Stamps live query results with the backend log timestamp they are valid at.
 *
 * Soundness: the Convex client maintains ONE consistent snapshot — after each
 * applied transition, every subscribed query's local result is simultaneously
 * valid at `getMaxObservedTimestamp()`. Reading `(localQueryResult, maxTs)`
 * synchronously inside an update callback therefore yields a consistent pair:
 * the result IS the authoritative value at that log position. Timestamps are
 * backend log positions — monotonic per connection and globally comparable
 * across tabs, devices, and reconnects — which is exactly what the durable
 * writer fence's monotonic-coverage comparison requires.
 *
 * The watch created here also holds the query subscription open, so consumers
 * do not need a parallel `useQuery` for lifecycle.
 *
 * Constraint: never attach Convex-level optimistic updates to a query
 * materialized through this stamper — the local result would include
 * unconfirmed state and the stamp would claim server authority for it. The
 * durable command journal is the only optimistic layer for these views.
 *
 * Internal-surface note (the ONLY one in the log-ts design): the public React
 * client does not re-export its underlying `BaseConvexClient`, whose
 * `getMaxObservedTimestamp()` is itself public API. The shipped `sync` getter
 * is load-bearing inside convex-js (the paginated client is built on it), so
 * this single cast is stable in practice; blessing it in types is part of the
 * filed upstream ask (convex-js #182). Everything else here is public API.
 */
type TimestampSource = {
  getMaxObservedTimestamp(): { toString(): string } | undefined;
};

function timestampSourceOf(client: ConvexReactClient): TimestampSource {
  return (client as unknown as { sync: TimestampSource }).sync;
}

export type StampedResult = {
  /** The query's current authoritative result (never optimistic). */
  result: unknown;
  /** Backend log position (u64 decimal string) the result is valid at. */
  logTs: string;
};

export class TransitionStamper {
  constructor(private readonly client: ConvexReactClient) {}

  /**
   * Subscribe to a query and deliver every authoritative result stamped with
   * its log timestamp, starting with the currently-cached result when one
   * exists. `onError` receives query evaluation errors (the view keeps its
   * durable state; the error is diagnostic).
   */
  register(
    query: FunctionReference<"query">,
    args: Record<string, unknown>,
    onStamped: (stamped: StampedResult) => void,
    onError: (error: unknown) => void = () => {},
  ): () => void {
    const watch = this.client.watchQuery(query, args as never);
    const deliver = () => {
      let result: unknown;
      try {
        result = watch.localQueryResult();
      } catch (error) {
        onError(error);
        return;
      }
      if (result === undefined) return;
      const ts = timestampSourceOf(this.client).getMaxObservedTimestamp();
      // No observed timestamp means no transition has arrived yet, so any
      // locally cached value cannot be stamped; the first real transition
      // will deliver it.
      if (ts === undefined) return;
      onStamped({ result, logTs: ts.toString() });
    };
    const unsubscribe = watch.onUpdate(deliver);
    // A result may already be cached (the same query subscribed elsewhere, or
    // a warm client) — onUpdate only fires on CHANGES, so deliver it now.
    deliver();
    return unsubscribe;
  }
}

const stampers = new WeakMap<ConvexReactClient, TransitionStamper>();

/** One stamper per Convex client; the client owns the underlying query set. */
export function transitionStamperFor(client: ConvexReactClient): TransitionStamper {
  let stamper = stampers.get(client);
  if (!stamper) {
    stamper = new TransitionStamper(client);
    stampers.set(client, stamper);
  }
  return stamper;
}
