// When the voice speaks. Every agent in every huddle stays quiet until
// someone says its name; the one exception is a call with a single person in
// it, where there is nobody else they could be talking to. Being named also
// ends a quiet the model asked for (go_quiet). Nothing else opens a turn: no
// follow-up window after it spoke, and no telling the room on its own what
// its session found (Convex hands the voice only replies to turns someone
// asked for, convex/callChat.ts mirrorAgentTurn).

/** Matchers for a spoken name: a whole word, case folded, so "ember" in
 *  "remember" does not count. Speech comes from a recognizer, so nothing
 *  relies on punctuation. Mirrors shared addressesAgent. */
export function nameMatchers(names) {
  return names
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu"));
}

/** What to do with one finished line from the room: "answer" it, and whether
 *  it lifts a quiet. `alone` is whether one person is in the call. */
export function turnVerdict({ transcript, named, quiet, alone }) {
  if (named.some((re) => re.test(transcript))) return { answer: true, quiet: false };
  return { answer: !quiet && alone, quiet };
}
