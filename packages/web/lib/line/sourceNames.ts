// Products and tools that report into a line, written the way their makers
// write them (learning-loop.md LL6: plain words, the reader's names). A leaf,
// so the graph, step and page code can all read it without an import cycle.
const NAMES: Record<string, string> = { agentwatch: "AgentWatch", posthog: "PostHog", sentry: "Sentry", github: "GitHub" };

/** A known product's own spelling for a source or graph name, else null. */
export const knownName = (raw: string): string | null => NAMES[raw.trim().toLowerCase()] ?? null;

const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w);
/** "evalReds" → "Eval reds", "call_eval" → "Call eval". */
export const humanize = (id: string) => cap(id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_.]+/g, " ").trim().toLowerCase());

/** A source's one name, by its id, on every surface and in every process: the product's spelling, else its last part
 *  ("union.invariant" reads "Invariant", "sdk:posthog" reads "PostHog", "app:checkout" reads "Checkout app"). */
export function sourceName(source: string): string {
  const bare = source.replace(/^sdk:/, "");
  const known = knownName(bare);
  if (known) return known;
  const s = bare.toLowerCase();
  if (s === "person") return "Person";
  if (s === "lesson") return "Lessons";
  // Codecast's own judges file as `judge:<name>`: named with their product, as a product's judges are.
  if (s.startsWith("judge:")) return judgeName("Codecast", bare.slice("judge:".length));
  const prefixed = bare.match(/^([\w-]+):(.+)$/);
  if (prefixed) return `${humanize(prefixed[2])} ${prefixed[1].toLowerCase()}`;
  return humanize(bare.split(".").pop() || bare);
}

/** A judge's one name on every surface: its product, then what it judges ("Codecast comms judge", "AgentWatch comms
 *  judge", "AgentWatch call eval"), so two products' judges of one thing never read as one name, nor one judge as two. */
export function judgeName(product: string, judge: string): string {
  const words = judge.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_.]+/g, " ").trim().toLowerCase();
  return /\b(judge|eval|check|review)$/.test(`${product.toLowerCase()} ${words}`) || /judge/i.test(product) ? `${product} ${words}` : `${product} ${words} judge`;
}
