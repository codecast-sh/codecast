import { useEffect, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { usePrincipalLocalState } from "@/components/PrincipalLocalStateProvider";
import {
  LocalViewSession,
  type LocalViewPublication,
} from "@/store/local-first/localViewSession";
import type { QueryViewContract } from "@/store/local-first/queryView";
import { transitionStamperFor } from "@/store/local-first/transitionStamper";

const EMPTY: LocalViewPublication<never> = Object.freeze({
  status: "loading",
  rows: [],
  activeCommandIds: [],
  head: 0,
});

/**
 * Reactive local read of one declared complete view.
 *
 * Durable rows render immediately (offline included); the contract's server
 * query streams authorized results into the principal store; optimistic
 * command overlays are already folded into the published rows. Feature code
 * supplies a contract and args — merging, coverage, epochs, and persistence
 * stay behind this boundary.
 *
 * Contracts with `coverageSource: "stamped-log-ts"` are fed by the transition
 * stamper (which also holds the query subscription): every granted result is
 * applied with the backend log timestamp it is valid at. Other contracts use
 * the ordinary subscription with envelope-decoded coverage.
 *
 *   const comments = useLocalView(commentsByConversationView, { conversationId });
 */
export function useLocalView<
  Query extends FunctionReference<"query">,
  TArgs,
  TRow,
>(
  contract: QueryViewContract<Query, TArgs, TRow>,
  args: TArgs,
  options: { enabled?: boolean } = {},
): LocalViewPublication<TRow> {
  const enabled = options.enabled ?? true;
  const { runtime, state } = usePrincipalLocalState();
  const convex = useConvex();
  const engine = enabled &&
    (state.phase === "offline-ready" || state.phase === "server-verified")
    ? runtime.materializer
    : null;
  const viewKey = contract.key(args);
  const stamped = contract.coverageSource === "stamped-log-ts";

  const [publication, setPublication] = useState<LocalViewPublication<TRow>>(EMPTY);
  const [session, setSession] = useState<LocalViewSession<TArgs, unknown, TRow> | null>(null);

  useEffect(() => {
    if (!engine) {
      setSession(null);
      setPublication(EMPTY);
      return;
    }
    const next = new LocalViewSession(engine, contract, args, setPublication);
    setSession(next);
    return () => {
      next.close();
      setPublication(EMPTY);
    };
    // The view key uniquely encodes the args; the engine instance changes on
    // every principal transition, closing this session before a successor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, contract, viewKey]);

  const serverResult = useQuery(
    contract.query,
    engine && !stamped ? contract.queryArgs(args) : ("skip" as const),
  );
  useEffect(() => {
    if (!session || stamped || serverResult === undefined) return;
    session.deliver(serverResult);
  }, [session, stamped, serverResult]);

  useEffect(() => {
    if (!session || !stamped || !convex) return;
    const stamper = transitionStamperFor(convex);
    return stamper.register(
      contract.query,
      contract.queryArgs(args) as Record<string, unknown>,
      ({ result, logTs }) => {
        void session.deliverStamped(result, logTs);
      },
      (error) => console.error(`[local-first] stamped query ${viewKey} failed`, error),
    );
    // Args identity is encoded by viewKey, same as the session effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, stamped, convex, contract, viewKey]);

  return publication;
}
