// A Convex document holds at most 1 MiB, and a GitHub delivery can be bigger
// (a push touching thousands of files, a PR with a huge body). Storing such a
// payload as-is threw, so the delivery was lost whole: ~24 a day on
// 2026-11-12. fitWebhookPayload shortens the biggest lists and strings until
// the JSON fits, which keeps every identifying field (repository, refs, shas,
// numbers) a processor routes on. Pure, loads without the Convex runtime.

export const WEBHOOK_PAYLOAD_MAX_BYTES = 900_000;

const bytes = (s: string) => new TextEncoder().encode(s).length;

function shrink(value: unknown, maxString: number, maxItems: number): unknown {
  if (typeof value === "string") return value.length > maxString ? value.slice(0, maxString) : value;
  if (Array.isArray(value)) return value.slice(0, maxItems).map((v) => shrink(v, maxString, maxItems));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v, maxString, maxItems)]));
  }
  return value;
}

/** The payload unchanged when it fits; otherwise the same JSON with long strings and lists cut until it does. */
export function fitWebhookPayload(payload: string, maxBytes = WEBHOOK_PAYLOAD_MAX_BYTES): string {
  if (bytes(payload) <= maxBytes) return payload;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return "{}";
  }
  for (let maxString = 8192, maxItems = 500; maxString >= 64; maxString >>= 1, maxItems >>= 1) {
    const fitted = JSON.stringify(shrink(parsed, maxString, Math.max(maxItems, 1)));
    if (bytes(fitted) <= maxBytes) return fitted;
  }
  return "{}";
}
