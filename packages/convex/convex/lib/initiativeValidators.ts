// Validators for an initiative's measured and written record
// (initiatives-projects-role-page.md I4, I5), read by the initiatives schema.
// The shapes are @codecast/shared/contracts/initiative; the assertions at the
// bottom fail the typecheck when the two disagree. A leaf: it imports nothing
// from the functions graph, so the schema loads it on its own.
import { v, type Infer } from "convex/values";
import {
  INTENT_SOURCE_KINDS,
  type InitiativeDecision,
  type InitiativeMilestone,
  type InitiativeQuestion,
  type InitiativeScore,
  type IntentSource,
  type IntentSourceKind,
} from "@codecast/shared/contracts/initiative";

const [firstKind, secondKind, ...otherKinds] = INTENT_SOURCE_KINDS.map((k) => v.literal<IntentSourceKind>(k));

/** Who said it and where (IntentSource). */
export const intentSourceValidator = v.object({
  kind: v.union(firstKind, secondKind, ...otherKinds),
  ref: v.optional(v.string()),
  quote: v.optional(v.string()),
  by: v.optional(v.string()),
  at: v.optional(v.number()),
});

export const milestoneValidator = v.object({
  key: v.string(),
  title: v.string(),
  date: v.optional(v.number()),
  done_at: v.optional(v.number()),
  source: v.optional(intentSourceValidator),
});

export const questionValidator = v.object({
  key: v.string(),
  text: v.string(),
  at: v.number(),
  by: v.optional(v.string()),
  source: v.optional(intentSourceValidator),
  answer: v.optional(v.string()),
  answered_at: v.optional(v.number()),
});

export const decisionValidator = v.object({
  key: v.string(),
  text: v.string(),
  at: v.number(),
  by: v.optional(v.string()),
  source: v.optional(intentSourceValidator),
});

/** A reported value: the template scoreboard's own shape. */
export const scoreValidator = v.object({ value: v.string(), observed_at: v.number(), source: v.string() });

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type _InitiativeRecordShapesAgree = [
  Assert<Same<Infer<typeof intentSourceValidator>, IntentSource>>,
  Assert<Same<Infer<typeof milestoneValidator>, InitiativeMilestone>>,
  Assert<Same<Infer<typeof questionValidator>, InitiativeQuestion>>,
  Assert<Same<Infer<typeof decisionValidator>, InitiativeDecision>>,
  Assert<Same<Infer<typeof scoreValidator>, InitiativeScore>>,
];
