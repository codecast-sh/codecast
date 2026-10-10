// Products and tools that report into a line, written the way their makers
// write them (learning-loop.md LL6: plain words, the reader's names). A leaf,
// so the graph, step and page code can all read it without an import cycle.
const NAMES: Record<string, string> = { agentwatch: "AgentWatch", posthog: "PostHog", sentry: "Sentry", github: "GitHub" };

/** A known product's own spelling for a source or graph name, else null. */
export const knownName = (raw: string): string | null => NAMES[raw.trim().toLowerCase()] ?? null;
