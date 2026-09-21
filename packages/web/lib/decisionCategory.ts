import { isHumanOnlyCategory } from "@codecast/convex/convex/lib/decisionCategory";

// What a category is FOR, in the words that matter to the reader: who is
// allowed to answer. The bare word plus "assigned by the server" said
// neither. `unknown` is not a warning — it means the asker proposed nothing,
// so it stays a person's to answer; it reads as a plain sentence, not a red
// chip demanding attention the decision itself deserves.
export function categoryMeaning(category: string | undefined): string {
  if (!category || category === "unknown") return "the asker proposed none, so a person answers it";
  if (category === "limit") return "a usage limit — always a person";
  return isHumanOnlyCategory(category) ? "always a person, never a role" : "a role can earn the right to answer these";
}
