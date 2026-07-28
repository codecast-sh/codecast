import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import {
  defineCompleteView,
  type CompleteViewContract,
  type CompleteViewContractResult,
} from "./contracts";
import type { SourceCoverage } from "./types";

/**
 * The standard envelope every v2 view query returns (see Convex
 * `smallViewContracts.grantedView` and friends). Non-granted variants are
 * already in the shape the materializer contract expects, so they pass
 * through decode untouched.
 */
type StandardViewEnvelope =
  | { contractId: string; viewKey: string; access: "unauthenticated" }
  | {
      contractId: string;
      viewKey: string;
      access: "missing";
      releasedGrantKeys: readonly string[];
      removals: readonly never[];
    }
  | {
      contractId: string;
      viewKey: string;
      access: "forbidden";
      revokedGrantKeys: readonly string[];
    }
  | {
      contractId: string;
      viewKey: string;
      access: "granted";
      grantKeys: readonly string[];
      viewRevision: number;
      coverage?: SourceCoverage;
    };

type GrantedResult<Query extends FunctionReference<"query">> =
  Extract<FunctionReturnType<Query>, { access: "granted" }>;

export type QueryViewDefinition<
  Query extends FunctionReference<"query">,
  TArgs,
  TRow,
> = {
  id: string;
  /** The Convex view query this contract subscribes to. */
  query: Query;
  key(args: TArgs): string;
  /** Maps contract args to query args; identity when omitted. */
  queryArgs?(args: TArgs): FunctionArgs<Query>;
  /** Selects the domain rows out of one granted envelope. */
  rows(granted: GrantedResult<Query>): readonly TRow[];
  entityKey(row: TRow): string;
  /** Stored value per row; the row itself when omitted. */
  projection?(row: TRow): unknown;
};

export type QueryViewContract<
  Query extends FunctionReference<"query">,
  TArgs,
  TRow,
> = CompleteViewContract<string, TArgs, FunctionReturnType<Query>, TRow> & {
  storage: "projection";
  query: Query;
  queryArgs(args: TArgs): FunctionArgs<Query>;
};

/**
 * A complete projection-owned view over one standard-envelope Convex query.
 *
 * The server result type is derived from the query reference itself, so a
 * contract declares only what is genuinely view-specific: identity, key
 * derivation, row selection, and entity keys. Decode, coverage, and
 * normalization are the same for every standard envelope and live here once.
 */
export function defineQueryView<
  Query extends FunctionReference<"query">,
  TArgs,
  TRow,
>(definition: QueryViewDefinition<Query, TArgs, TRow>): QueryViewContract<Query, TArgs, TRow> {
  const contract = defineCompleteView<string, TArgs, FunctionReturnType<Query>, TRow>({
    id: definition.id,
    storage: "projection",
    key: definition.key,
    decode(result: FunctionReturnType<Query>): CompleteViewContractResult<TRow> {
      const envelope = result as StandardViewEnvelope;
      if (envelope.access !== "granted") {
        return envelope as CompleteViewContractResult<TRow>;
      }
      return {
        contractId: envelope.contractId,
        viewKey: envelope.viewKey,
        access: "granted",
        grantKeys: envelope.grantKeys,
        // Servers deployed before coverage joined the granted envelope still
        // prove the same view-revision; derive the identical coverage locally.
        coverage: envelope.coverage ?? {
          kind: "view-revision",
          revision: String(envelope.viewRevision),
          revisionOrder: envelope.viewRevision,
        },
        rows: definition.rows(result as GrantedResult<Query>),
      };
    },
    normalize(row: TRow, context) {
      return {
        entityKey: definition.entityKey(row),
        grantKeys: context.grantKeys,
        projection: definition.projection ? definition.projection(row) : row,
      };
    },
  });
  return Object.freeze({
    ...contract,
    query: definition.query,
    queryArgs: definition.queryArgs ?? ((args: TArgs) => args as FunctionArgs<Query>),
  }) as QueryViewContract<Query, TArgs, TRow>;
}
