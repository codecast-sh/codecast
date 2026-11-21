import { isHumanOnlyCategory } from "@codecast/convex/convex/lib/decisionCategory";

// What a category is FOR, in the words that matter to the reader: who is
// allowed to answer. The bare word plus "assigned by the server" said
// neither. No category and `unknown` are not warnings — a person answers
// those (an older card whose asker proposed none, a run's card the flow gave no
// category, or a word outside the vocabulary); they read as a plain sentence,
// not a red chip demanding attention the decision itself deserves.
export function categoryMeaning(category: string | undefined): string {
  if (!category) return "the asker proposed none, so a person answers it";
  if (category === "unknown") return "a person answers it: a run's card, or a category outside the list";
  if (category === "limit") return "a usage limit — always a person";
  return isHumanOnlyCategory(category) ? "always a person, never a role" : "a role can earn the right to answer these";
}
