// The pattern mining behind composer suggestions (composerSuggestions.ts): the
// phrases a person keeps saying to models, their repeated whole inputs, and
// their newest distinct ones, ranked into the profile the suggester reads.
// Pure, so the ranking is testable without a database or a model.

// Boundary trim for mined n-grams: leading/trailing glue words carry no
// meaning, so "add a regression test to" and "a regression test" collapse
// toward the same core phrase before counting.
const PHRASE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "at", "by", "is", "are", "was", "were", "be", "it", "this", "that", "i",
  "we", "you", "me", "my", "your", "our", "as", "so", "do", "does", "did",
  "can", "could", "should", "would", "will", "have", "has", "had", "not",
  "its", "if", "then", "than", "also", "just", "like",
]);

// Recurring multi-word fragments across the user's inputs — the "things I say
// to models" ("add a regression test", "work hard on this", "make it
// beautiful"). Exact-equal whole-input matching misses these: the phrase
// recurs, the sentence around it never does. Each phrase counts once per
// input so one rambling message can't inflate it; when a longer phrase has
// support close to a contained shorter one, the longer (more specific) wins.
export function minePhrases(inputs: string[]): Array<{ text: string; count: number }> {
  const counts = new Map<string, number>();
  for (const input of inputs) {
    const words = input
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/\[image[^\]]*\]/g, " ")
      .replace(/[^a-z0-9' -]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const seen = new Set<string>();
    for (let n = 3; n <= 7; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n);
        let lo = 0;
        let hi = gram.length;
        while (lo < hi && PHRASE_STOPWORDS.has(gram[lo])) lo++;
        while (hi > lo && PHRASE_STOPWORDS.has(gram[hi - 1])) hi--;
        const core = gram.slice(lo, hi);
        if (core.length < 3) continue;
        const text = core.join(" ");
        if (text.length >= 10) seen.add(text);
      }
    }
    for (const p of seen) counts.set(p, (counts.get(p) || 0) + 1);
  }
  const candidates = [...counts.entries()]
    .filter(([, c]) => c >= 3)
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.text.length - a.text.length);
  const kept: Array<{ text: string; count: number }> = [];
  for (const cand of candidates) {
    const container = kept.find((k) => k.text.includes(cand.text));
    if (container && container.count >= cand.count * 0.8) continue;
    kept.push(cand);
  }
  return kept
    .sort((a, b) => b.count - a.count || b.text.length - a.text.length)
    .slice(0, 25);
}

// Rank raw inputs into the profile: mined recurring phrases, repeated whole
// multi-word inputs (with a recency boost), and the newest distinct inputs in
// order (style evidence even when nothing repeats). One- and two-word inputs
// ("continue", "go", "do it") are deliberately excluded from `frequent` —
// they dominate any frequency count but carry nothing worth suggesting.
export function rankInputs(rows: Array<{ text: string; ts: number }>, now: number): {
  frequent: Array<{ text: string; count: number }>;
  phrases: Array<{ text: string; count: number }>;
  recent: string[];
} {
  const byKey = new Map<string, { text: string; count: number; lastTs: number }>();
  for (const r of rows) {
    const key = r.text.toLowerCase().replace(/\s+/g, " ");
    const e = byKey.get(key);
    if (e) {
      e.count++;
      if (r.ts > e.lastTs) {
        e.lastTs = r.ts;
        e.text = r.text;
      }
    } else {
      byKey.set(key, { text: r.text, count: 1, lastTs: r.ts });
    }
  }
  const day = 24 * 60 * 60 * 1000;
  const score = (e: { count: number; lastTs: number }) =>
    e.count + (now - e.lastTs < 7 * day ? 1.5 : 0) + (now - e.lastTs < day ? 1 : 0);
  const frequent = [...byKey.values()]
    .filter((e) => e.count >= 2 && e.text.trim().split(/\s+/).length >= 3)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 15)
    .map((e) => ({ text: e.text, count: e.count }));

  const phrases = minePhrases(rows.map((r) => r.text));

  const seen = new Set<string>();
  const recent: string[] = [];
  for (const r of [...rows].sort((a, b) => b.ts - a.ts)) {
    const key = r.text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    recent.push(r.text);
    if (recent.length >= 12) break;
  }
  return { frequent, phrases, recent };
}
