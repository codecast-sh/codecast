import type {
  ApplyCompleteViewInput,
  MaterializedState,
  MaterializedView,
  TransitionOutcome,
} from "./types";

/**
 * Apply a complete authoritative view without consulting React, IndexedDB, or
 * the network. Persistence owns publication; this function only defines the
 * deterministic state transition that will be committed.
 */
export function applyCompleteView(
  state: MaterializedState,
  input: ApplyCompleteViewInput,
): TransitionOutcome {
  if (input.capturedPrincipalEpoch !== state.principalEpoch) {
    return { kind: "stale", reason: "principal", state };
  }
  if (input.capturedSourceEpoch !== input.activeSourceEpoch) {
    return { kind: "stale", reason: "source", state };
  }

  const current = state.views[input.viewKey];
  if (current && (
    input.writerEpoch < current.writerEpoch ||
    (input.writerEpoch === current.writerEpoch && input.capturedSourceEpoch !== current.sourceEpoch) ||
    (input.writerEpoch === current.writerEpoch &&
      input.capturedSourceEpoch === current.sourceEpoch &&
      input.sourceSequence <= current.sourceSequence)
  )) {
    return { kind: "stale", reason: "source", state };
  }

  if (input.result.access === "unavailable" || input.result.access === "unauthenticated") {
    return { kind: "retained", reason: input.result.access, state };
  }

  if (input.result.access === "forbidden") {
    const views = { ...state.views };
    delete views[input.viewKey];
    const grants = { ...state.grants };
    for (const grantKey of input.result.revokedGrantKeys) delete grants[grantKey];
    return { kind: "revoked", state: { ...state, views, grants } };
  }

  if (input.result.access === "missing") {
    if (!current) return { kind: "missing", state };
    const views = { ...state.views };
    delete views[input.viewKey];
    const grants = { ...state.grants };
    for (const grantKey of input.result.releasedGrantKeys) delete grants[grantKey];
    return { kind: "missing", state: { ...state, views, grants } };
  }

  const members: Record<string, true> = {};
  const projections: Record<string, unknown> = {};
  for (const member of input.result.value.members) {
    members[member.entityKey] = true;
    if (member.projection !== undefined) projections[member.entityKey] = member.projection;
  }
  const nextView: MaterializedView = {
    contractId: input.contractId,
    viewKey: input.viewKey,
    grantKeys: input.result.grantKeys,
    revision: input.result.value.revision,
    writerEpoch: input.writerEpoch,
    sourceEpoch: input.capturedSourceEpoch,
    sourceSequence: input.sourceSequence,
    coverage: input.coverage,
    members,
    projections,
  };
  return {
    kind: "applied",
    state: {
      ...state,
      views: { ...state.views, [input.viewKey]: nextView },
      grants: {
        ...state.grants,
        ...Object.fromEntries(input.result.grantKeys.map((grantKey) => [grantKey, true])),
      },
    },
  };
}
