/**
 * @platform/evals/analysis: the one implementation of the run-set verdict
 * (separation, flips, footing), stats, epochs, attribution and bisect math.
 * Pure and isomorphic: it may read ./contract, never node, React or the DOM.
 * Whether a rep passed and which ruler judged it are the product's to say:
 * makeVerdict binds a VerdictPolicy once, and every function outside
 * verdict.ts that needs it takes the bound kit as its first argument.
 */
export * from './rng';
export * from './stats';
export * from './evalResult';
export * from './verdict';
export * from './flips';
// epochs and bisect each key renders their own way; bisect's renderKeys keeps the name.
export { epochPromptDiffs, epochsOf, footingMarkers, promptPairs, renderKeys as epochRenderKeys, sortPromptFiles, timeline } from './epochs';
export type { EpochRow, PromptReader } from './epochs';
export * from './attribution';
export * from './bisect';
export * from './liveness';
