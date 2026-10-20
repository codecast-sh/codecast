// Wake signatures — subscribe to a SIGNATURE of churny store state, not the raw
// object, so a component re-renders only on the changes it actually branches on.
//
// The primitives live in @platform/engine (wakeSig there), including the full
// rationale: rowSigExcluding for one watched row (denylist, fail-safe),
// makeCollectionSig for a whole collection (allowlist projection, memoized by
// collection ref), and stableRefId for folding object-valued fields into a
// signature. Codecast's canonical users: sessionsWakeSig (inbox sidebar) and
// useConversationMessages (open conversation vs heartbeats). TIME-driven
// transitions are not field changes — pair a signature with hooks/useCoarseNow,
// never widen it back out to churny fields.
export { stableRefId, rowSigExcluding, makeCollectionSig } from "@platform/engine";
