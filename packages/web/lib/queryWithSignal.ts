import type { ConvexReactClient } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";

export async function queryWithSignal<Query extends FunctionReference<"query">>(
  client: Pick<ConvexReactClient, "watchQuery">,
  query: Query,
  args: FunctionArgs<Query>,
  signal: AbortSignal,
): Promise<FunctionReturnType<Query>> {
  if (signal.aborted) throw signal.reason;
  const watch = client.watchQuery(query, args);
  const cached = watch.localQueryResult();
  if (cached !== undefined) return cached;
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      signal.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    const read = () => {
      void Promise.resolve().then(() => watch.localQueryResult()).then(
        (value) => { if (value !== undefined) finish(() => resolve(value)); },
        (error) => finish(() => reject(error)),
      );
    };
    unsubscribe = watch.onUpdate(read);
    if (settled) unsubscribe();
    if (signal.aborted) abort();
    else read();
  });
}
