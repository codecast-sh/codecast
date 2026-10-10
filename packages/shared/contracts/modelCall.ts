// The model call contract (docs/architecture/learning-loop.md LL1, LL8): one
// prompt, one answer, no tools. A graph's call node, a codecast judge and the
// grouping step all speak it, and the server runs every one of them through
// convex/lib/anthropic.ts on the deployment's key, charged to the team's
// monthly model budget (LL10). A call never starts a session.

export const MODEL_CALL_OUTPUTS = ["json", "text"] as const;
export type ModelCallOutput = (typeof MODEL_CALL_OUTPUTS)[number];

export interface ModelCallSpec {
  model: string;
  max_tokens: number;
  system?: string;
  prompt: string;
  /** json: the answer must hold one JSON value, kept parsed beside the text. */
  output: ModelCallOutput;
}

export interface ModelCallUsage {
  input_tokens: number;
  output_tokens: number;
}

export type ModelCallResult =
  | { ok: true; text: string; json?: unknown; usage: ModelCallUsage; cost_usd: number; model: string; stop_reason?: string | null }
  /** budget: the team's budget had no room, nothing was sent. failed: the call failed or the answer was not what `output` asked for. */
  | { ok: false; reason: "budget" | "failed"; error: string; cost_usd: number; model: string };

export const MODEL_CALL_LIMITS = {
  prompt_chars: 400_000,
  system_chars: 60_000,
  max_tokens: 16_000,
} as const;

/** Why a call spec cannot be sent, or null. */
export function modelCallProblem(spec: Partial<ModelCallSpec>): string | null {
  if (!spec.model || !/^[a-z0-9][a-z0-9.\-]{2,80}$/i.test(spec.model)) return "a call needs a model id";
  if (!Number.isInteger(spec.max_tokens) || spec.max_tokens! < 1 || spec.max_tokens! > MODEL_CALL_LIMITS.max_tokens) return `max_tokens is a whole number from 1 to ${MODEL_CALL_LIMITS.max_tokens}`;
  if (typeof spec.prompt !== "string" || !spec.prompt.trim()) return "a call needs a prompt";
  if (spec.prompt.length > MODEL_CALL_LIMITS.prompt_chars) return `the prompt is over ${MODEL_CALL_LIMITS.prompt_chars} characters`;
  if (spec.system !== undefined && (typeof spec.system !== "string" || spec.system.length > MODEL_CALL_LIMITS.system_chars)) return `the system prompt is over ${MODEL_CALL_LIMITS.system_chars} characters`;
  if (!MODEL_CALL_OUTPUTS.includes(spec.output as ModelCallOutput)) return `output is ${MODEL_CALL_OUTPUTS.join(" or ")}`;
  return null;
}

/**
 * The JSON value a reply starts with. A model that answers `[]` and then
 * explains why it stayed silent has still answered; the explanation is
 * dropped, not the answer. Fences are stripped the same way.
 */
export function parseJsonBlock(raw: string): unknown | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[\[{]/);
    if (start < 0) return null;
    const open = cleaned[start];
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inString = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }
}

// ── The team's model budget (LL10) ──

/** What a team's model budget pays for, each tallied apart. */
export const BUDGET_PURPOSES = ["judge", "grouping", "call"] as const;
export type BudgetPurpose = (typeof BUDGET_PURPOSES)[number];

/** The budget's month, in UTC: "2026-10". */
export function budgetMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

export interface BudgetSummary {
  /** The monthly cap in dollars; 0 is off, and nothing that needs the budget runs. */
  cap_usd: number;
  month: string;
  spent_usd: number;
  /** Reserved by calls in flight. */
  held_usd: number;
  by_purpose: Record<BudgetPurpose, number>;
  /** Calls the cap refused this month, and the last time. */
  refused: number;
  last_refused_at?: number;
  history: Array<{ month: string; spent_usd: number }>;
}

const usd = (n: number) => (n >= 10 || n === 0 ? `$${n.toFixed(0)}` : n >= 0.995 ? `$${n.toFixed(2)}` : `${Math.round(n * 100)}¢`);
const PURPOSE_WORDS: Record<BudgetPurpose, string> = { judge: "judging", grouping: "grouping", call: "graph calls" };

/** The budget in one sentence a person reads. */
export function budgetWords(b: BudgetSummary): string {
  if (b.cap_usd <= 0) return b.spent_usd > 0 ? `Off. ${usd(b.spent_usd)} was spent this month before it was turned off.` : "Off. Judging and grouping wait until a monthly budget is set.";
  const parts = BUDGET_PURPOSES.filter((p) => b.by_purpose[p] > 0).map((p) => `${PURPOSE_WORDS[p]} ${usd(b.by_purpose[p])}`);
  const head = `${usd(b.spent_usd)} of ${usd(b.cap_usd)} spent this month`;
  const tail = b.refused > 0 ? `; ${b.refused} call${b.refused === 1 ? " was" : "s were"} skipped because it was spent` : "";
  return `${head}${parts.length ? ` (${parts.join(", ")})` : ""}${tail}.`;
}
