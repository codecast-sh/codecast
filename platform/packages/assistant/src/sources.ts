// A web search's sources as its result text lists them: search_web
// (web.ts) writes the list after its summary, and a client reads it back to
// show the sources under the reply. One module owns the format both ways.
// Dependency free, so a browser bundle imports it without the harness.

export type Source = { url: string; title?: string };

/** The heading search_web's result puts over its source list. */
const SOURCES_HEADING = "Sources:";

/** The source list a search_web result ends with, one "- Title: url" line
 *  each. parseSources reads it back, so the two stay one format. */
export function formatSources(sources: Source[]): string {
  return sources.length ? `\n\n${SOURCES_HEADING}\n${sources.map((s) => `- ${s.title ? `${s.title}: ` : ""}${s.url}`).join("\n")}` : "";
}

/** The sources a search_web result lists (formatSources), in order, for a
 *  client that shows them under the reply. Empty when it lists none. */
export function parseSources(result: string): Source[] {
  const at = result.lastIndexOf(`\n${SOURCES_HEADING}\n`);
  if (at < 0) return [];
  const out: Source[] = [];
  for (const line of result.slice(at + SOURCES_HEADING.length + 2).split("\n")) {
    const m = line.match(/^- (?:(.*): )?(https?:\/\/\S+)$/);
    if (!m) continue;
    out.push({ url: m[2], ...(m[1] ? { title: m[1] } : {}) });
  }
  return out;
}
