// The eval loop doctrine: how an agent working on a product built on
// @platform/evals reads what happened and proves a change. Principles only;
// the command reference is the app's own snippet (`@platform/evals/snippet`).

export const EVALS_LOOP_END = "<!-- /platform-doctrine-evals-loop -->";

export const EVALS_LOOP_BODY = `
## Reading conversations and proving a change

Read what people and the assistant said through the product's eval CLI, never
by querying the database: the CLI numbers every message so you and the reader
can point at one, and what it cannot show is a gap to fix in it. A moment the
assistant got wrong is frozen, given pass criteria in plain words, replayed
against the prompts in this tree before and after the change, and compared;
a judged freeze stays as a regression guard. A scenario is run forward against
the whole product with simulated people, never with a fake of the assistant.
Read a score as its gates first: a gate is decided in code and any one failing
is zero, whatever the judged checks say; a gate that held with nothing to
search is not a pass on the merits. Keep the evidence: a verdict that cannot
be re-read is an opinion.

${EVALS_LOOP_END}
`;

import type { SnippetDefinition } from "../src/types";

export const EVALS_LOOP: SnippetDefinition = {
  slug: "platform-doctrine-evals-loop",
  name: "Reading conversations and proving a change",
  desc: "The eval loop: read through the CLI, freeze, judge, replay before and after, keep the evidence",
  detail: "Stamped into AGENTS.md by stampDoctrine for every app on @platform/evals.",
  writesTo: "AGENTS.md, a ## Reading conversations and proving a change section",
  shipped: "2026-09-06",
  enabledKey: "doctrine.evalsLoop",
  versionKey: "doctrine.evalsLoop_version",
  section: {
    spec: { headings: ["## Reading conversations and proving a change"], endMarker: EVALS_LOOP_END },
    body: EVALS_LOOP_BODY,
  },
};
