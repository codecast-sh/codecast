// Part of the Evals UI's wire contract (docs/architecture/evals-ui.md). Every
// party imports it through ../evalsApi.ts. Attribution from records (section
// 5, Tier 0) and the bisect that follows it (section 5): the whole part lives
// in @platform/evals/contract and is re-exported here. PURE isomorphic data:
// no Node or DOM APIs.

export type {
  Attribution,
  AttributionAnswer,
  AttributionClass,
  BisectAnswer,
  BisectPlan,
  BisectPlanRequest,
  BisectProbe,
  BisectRep,
  BisectStartRequest,
  BisectStartResponse,
  BisectState,
  BisectStatus,
  BisectStep,
  BisectSummary,
  Candidate,
  CostBound,
  Endpoint,
  ProbeReading,
  ProbeVerdict,
  RecordedProbe,
  RenderClass,
  SourceConfidence,
} from "@platform/evals/contract";

export {
  answerFreezeIds,
  ATTRIBUTION_CLASSES,
  attributionSearchable,
  flipReading,
  largestDrops,
  narrowByRecords,
  sourceConfidence,
} from "@platform/evals/contract";
