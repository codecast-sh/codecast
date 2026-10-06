// Validators for the published line profile (line-profile.md LP3), read by
// the projects schema and by signals.publishProfile. The shape is
// @codecast/shared/contracts/lineProfile; the assertions at the bottom fail
// the typecheck when the two disagree.
import { v, type Infer } from "convex/values";
import type { LineFinderDecl, LineProfileFacts, PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";

const nullableString = v.union(v.string(), v.null());

export const lineFinderValidator = v.object({
  id: v.string(),
  source: v.string(),
  kind: v.union(v.literal("any"), v.array(v.string())),
  fingerprint: v.string(),
  runs: v.optional(v.string()),
});

// The repo's own line (line-map.md LX5): its parsed stations and routes ride
// as the runner's push shape, checked by the CLI's parser before a publish.
const repoLineValidator = v.object({
  file: v.string(),
  graph_hash: v.string(),
  name: v.string(),
  goal: v.optional(v.string()),
  stack: v.optional(v.string()),
  source: v.string(),
  nodes: v.array(v.any()),
  edges: v.array(v.any()),
  files: v.record(v.string(), v.object({ prompt: v.optional(v.string()), script: v.optional(v.string()) })),
});

const factFields = {
  team: nullableString,
  project: nullableString,
  principles: v.array(v.string()),
  prompting: v.string(),
  size_budget: v.number(),
  watch_days: v.number(),
  commands: v.object({ check: v.string(), prove: nullableString, eval: nullableString, ship: nullableString }),
  caps: v.object({ cards: v.number() }),
  merge: v.optional(v.object({ auto: v.boolean(), method: v.union(v.literal("squash"), v.literal("merge"), v.literal("rebase")) })),
  sources: v.record(v.string(), v.union(v.literal("file"), v.literal("default"))),
  notes: v.array(v.string()),
  warnings: v.array(v.string()),
  file: nullableString,
  line: v.optional(repoLineValidator),
};

/** What a publish sends besides its finder groups. */
export const lineProfileFactsValidator = v.object(factFields);

/** projects.line_profile. */
export const publishedLineProfileValidator = lineProfileFactsValidator
  .extend({ device_id: v.string(), publisher_user_id: v.string(), published_at: v.number() })
  .partial()
  .extend({
    finders: v.array(lineFinderValidator),
    root: v.optional(v.string()),
    default: v.optional(v.boolean()),
    changed_at: v.number(),
  });

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type _LineProfileShapesAgree = [
  Assert<Same<Infer<typeof lineFinderValidator>, LineFinderDecl>>,
  Assert<Same<Infer<typeof lineProfileFactsValidator>, LineProfileFacts>>,
  Assert<Same<Infer<typeof publishedLineProfileValidator>, PublishedLineProfile>>,
];
