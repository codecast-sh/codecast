// The one shape a charter budget takes on the wire, on the row and in the
// store draft: keys in sorted order (hands, then tokens), undefined entries
// dropped, and nothing at all (undefined) when neither is set. Sorted because
// that is how Convex hands an object back: a row written as
// { tokens_per_day, hands_per_day } reads as { hands_per_day, tokens_per_day },
// so the insertion order the server used is not the echo's order. The web
// block builds its patch through this and the server writes the row through
// it, so the optimistic draft and the echo are the same JSON: the store's
// field lock compares protected objects by JSON.stringify, which is key
// order sensitive, and a draft that spells the same budget in another order
// would re-assert itself over every push until the lock settled. No imports:
// this module is bundled into the web client.
export type CharterBudget = { tokens_per_day?: number; hands_per_day?: number };

export function cleanBudget(b: CharterBudget | null | undefined): CharterBudget | undefined {
  if (!b) return undefined;
  const out: CharterBudget = {};
  if (b.hands_per_day !== undefined) out.hands_per_day = b.hands_per_day;
  if (b.tokens_per_day !== undefined) out.tokens_per_day = b.tokens_per_day;
  return Object.keys(out).length === 0 ? undefined : out;
}
