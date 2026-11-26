// What a station reported when it finished, as its result JSON says it (pl-1111): the whole of its result_preview, or
// the first ```json fence in it. `outcome: "skipped"` is a station that ran and found nothing to do there (no checks
// documented, no deploy documented); `left_for_you` is one step it could not take itself and leaves to the person.
// Pure, with no imports: the journey, the flow diagram and the phone read a station's result here.

export type StationResult = { outcome: string | null; note: string | null; leftForYou: string | null };

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A station's result JSON, when its output carries one with an outcome or a step left; null for any other output. */
export function stationResult(preview: string | null | undefined): StationResult | null {
  const raw = preview?.trim();
  if (!raw) return null;
  const body = raw.startsWith("{") ? raw : raw.match(/```json[ \t]*\n([\s\S]*?)\n[ \t]*```/)?.[1];
  if (!body) return null;
  let json: unknown;
  try { json = JSON.parse(body); } catch { return null; }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const result = { outcome: text(o.outcome), note: text(o.note), leftForYou: text(o.left_for_you) };
  return result.outcome || result.leftForYou ? result : null;
}

/** The words for a step a station left to the person. */
export const leftWords = (step: string) => `One step left for you: ${step}`;
