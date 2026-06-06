// The single source of truth for "what is this session about?" card text.
//
// idle_summary is the purpose-built one-liner (the AI-generated session-insight
// headline, copied onto the conversation for cheap reads). When it's absent the
// card falls back to the first bullet of `subtitle` — a 2-4 bullet block that's
// too long to show whole. Returns "" when nothing usable exists.
export function sessionCardSummary(s: {
  idle_summary?: string | null;
  subtitle?: string | null;
}): string {
  return (
    s.idle_summary?.trim()
    || s.subtitle?.split("\n").find((l) => l.trim())?.replace(/^[-*]\s*/, "").trim()
    || ""
  );
}
