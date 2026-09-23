// The folding now lives in @codecast/shared/diff so `cast diff` draws the same
// tree; re-exported here to keep the web import paths.
export { computeCumulativeDiff, getCumulativeDiffForFile, type CumulativeDiff } from "@codecast/shared/diff";
