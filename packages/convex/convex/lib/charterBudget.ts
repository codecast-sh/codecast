// The one shape a charter budget takes on the wire, on the row and in the
// store draft: tokens first, then hands, undefined entries dropped, and
// nothing at all (undefined) when neither is set. The server writes the row
// through this and the web block builds its patch through it, so the
// optimistic draft and the echo are the same JSON: the store's field lock
// compares protected objects by JSON.stringify, which is key order sensitive,
// and a draft that spells the same budget in another order would never
// retire. No imports: this module is bundled into the web client.
export type CharterBudget = { tokens_per_day?: number; hands_per_day?: number };

export function cleanBudget(b: CharterBudget | null | undefined): CharterBudget | undefined {
  if (!b) return undefined;
  const out: CharterBudget = {};
  if (b.tokens_per_day !== undefined) out.tokens_per_day = b.tokens_per_day;
  if (b.hands_per_day !== undefined) out.hands_per_day = b.hands_per_day;
  return Object.keys(out).length === 0 ? undefined : out;
}
