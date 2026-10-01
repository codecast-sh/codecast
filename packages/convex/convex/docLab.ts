import { v } from "convex/values";
import { action } from "./functions";
import { api } from "./_generated/api";
import { callModel, parseJsonBlock } from "./lib/anthropic";
import {
  LAB_FLAGS,
  LAB_TRIMS,
  applyLabResult,
  stripDrafting,
  wordCount,
  type LabRequest,
  type LabResult,
  type TrimLevel,
} from "@codecast/shared/docs";

// The doc Lab: model help for a writer that never rewrites their text. The
// model only points at exact stretches of the writer's own words (to dim, to
// flag, to fix) or offers alternatives for one stretch; the result lands as
// drafting markup (@codecast/shared/docs drafting) the writer keeps or drops.
// The web applies results in the live editor; `cast doc lab` applies them to
// the stored markdown through the same applyLabResult.

const LAB_MODEL = "claude-sonnet-5-5";
const LAB_TIMEOUT_MS = 90_000;

const SYSTEM = `You help a writer edit their own draft. You never rewrite the draft and never add ideas to it. You answer with JSON only.

Whenever you point at text in the draft, copy it exactly, character for character, including punctuation and capitalization, so it can be found by plain string search. Keep each quoted stretch inside one paragraph.`;

function trimPct(level: TrimLevel): number {
  return LAB_TRIMS.find((t) => t.level === level)?.pct ?? 10;
}

function flagLabel(flag: string): string {
  return LAB_FLAGS.find((f) => f.flag === flag)?.label ?? `Mark ${flag}`;
}

export function labPrompt(req: LabRequest, text: string): { prompt: string; max_tokens: number } {
  if (req.tool === "alternatives") {
    return {
      max_tokens: 800,
      prompt: `The writer wants other ways to say one stretch of their draft. Offer up to 6 alternatives for the target that drop into the same spot and read naturally in the surrounding sentence: same grammatical role, same length class (a word for a word, a sentence for a sentence, a paragraph for a paragraph), in the writer's voice. Vary them; skip near duplicates and the target itself.

Surrounding text:
"""
${req.context}
"""

Target:
"""
${req.target}
"""

Answer as {"options": ["...", "..."]}.`,
    };
  }
  if (req.tool === "trim") {
    const pct = trimPct(req.level);
    const words = wordCount(text);
    return {
      max_tokens: 4000,
      prompt: `The writer wants this draft about ${pct}% shorter, roughly ${Math.round((words * pct) / 100)} of its ${words} words gone, without a single word rewritten. Choose what could be cut: redundant clauses, filler, repetition, asides that don't earn their place, whole sentences when the cut is large. What remains must still read as correct, natural prose with every cut removed, so take a stretch's leading or trailing punctuation and spaces with it when that keeps the remainder clean. Keep headings and the writer's key points.

Draft:
"""
${text}
"""

Answer as {"cuts": ["exact stretch", ...]}.`,
    };
  }
  if (req.tool === "flag") {
    return {
      max_tokens: 3000,
      prompt: `${flagLabel(req.flag)} in this draft, and say briefly why for each. Mark only what a careful editor would really raise; an empty list is a fine answer for a clean draft.

Draft:
"""
${text}
"""

Answer as {"items": [{"text": "exact stretch", "note": "why, in a few words"}]}.`,
    };
  }
  return {
    max_tokens: 3000,
    prompt: `Find typos, misspellings and punctuation mistakes in this draft. For each, give the smallest exact stretch that contains the mistake (a word or a few) and the corrected stretch. Leave style and word choice alone.

Draft:
"""
${text}
"""

Answer as {"fixes": [{"old": "exact stretch", "new": "corrected"}]}.`,
  };
}

const strings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : [];

export function parseLabReply(req: LabRequest, raw: string): LabResult | null {
  const json = parseJsonBlock(raw) as any;
  if (!json || typeof json !== "object") return null;
  if (req.tool === "alternatives") {
    const target = req.target.trim();
    return { tool: "alternatives", options: [...new Set(strings(json.options).map((s) => s.trim()))].filter((s) => s !== target).slice(0, 8) };
  }
  if (req.tool === "trim") return { tool: "trim", level: req.level, cuts: strings(json.cuts) };
  if (req.tool === "flag") {
    const items = Array.isArray(json.items) ? json.items : [];
    return {
      tool: "flag",
      flag: req.flag,
      items: items
        .filter((i: any) => typeof i?.text === "string" && i.text.trim())
        .map((i: any) => ({ text: i.text, ...(typeof i.note === "string" && i.note.trim() ? { note: i.note.trim() } : {}) })),
    };
  }
  const fixes = Array.isArray(json.fixes) ? json.fixes : [];
  return {
    tool: "typos",
    fixes: fixes.filter((f: any) => typeof f?.old === "string" && typeof f?.new === "string" && f.old && f.old !== f.new),
  };
}

const requestArgs = {
  tool: v.union(v.literal("alternatives"), v.literal("trim"), v.literal("flag"), v.literal("typos")),
  target: v.optional(v.string()),
  context: v.optional(v.string()),
  level: v.optional(v.string()),
  flag: v.optional(v.string()),
};

function toRequest(args: { tool: string; target?: string; context?: string; level?: string; flag?: string }): LabRequest {
  if (args.tool === "alternatives") {
    if (!args.target?.trim()) throw new Error("Alternatives need the text they are for");
    return { tool: "alternatives", target: args.target, context: args.context ?? args.target };
  }
  if (args.tool === "trim") {
    const level = (LAB_TRIMS.find((t) => t.level === args.level)?.level ?? "slight") as TrimLevel;
    return { tool: "trim", level };
  }
  if (args.tool === "flag") {
    if (!LAB_FLAGS.some((f) => f.flag === args.flag)) throw new Error(`Unknown flag; use one of ${LAB_FLAGS.map((f) => f.flag).join(", ")}`);
    return { tool: "flag", flag: args.flag! };
  }
  return { tool: "typos" };
}

async function runLab(req: LabRequest, text: string): Promise<LabResult> {
  const { prompt, max_tokens } = labPrompt(req, text);
  const reply = await callModel({ system: SYSTEM, prompt, max_tokens, model: LAB_MODEL, label: "Doc lab", timeout_ms: LAB_TIMEOUT_MS });
  if (!reply) throw new Error("The Lab could not reach its model; try again");
  const result = parseLabReply(req, reply.text);
  if (!result) throw new Error("The Lab's model answered in a shape it could not read; try again");
  return result;
}

/**
 * The web editor's Lab. The editor sends its own current text (it is ahead of
 * the stored markdown while the writer types) and lands the result itself.
 */
export const run = action({
  args: { ...requestArgs, text: v.string() },
  handler: async (ctx, args): Promise<LabResult> => {
    if (!(await ctx.auth.getUserIdentity())) throw new Error("Unauthorized");
    return runLab(toRequest(args), args.text);
  },
});

/**
 * `cast doc lab`: run a Lab tool on a stored doc and write the result into it,
 * through the same access checks and snapshot reset as `cast doc edit`.
 */
export const runOnDoc = action({
  args: { api_token: v.string(), id: v.id("docs"), session_id: v.optional(v.string()), occurrence: v.optional(v.number()), ...requestArgs },
  handler: async (ctx, args): Promise<{ result: LabResult; applied: number; missed: string[]; words_before: number; words_after: number }> => {
    const doc: any = await ctx.runQuery(api.docs.get, { api_token: args.api_token, id: args.id });
    if (!doc) throw new Error("Doc not found");
    const req = toRequest(args);
    const md: string = doc.content ?? "";
    const clean = stripDrafting(md);
    const context = req.tool === "alternatives" ? surrounding(clean, req.target) : "";
    const result = await runLab(req.tool === "alternatives" ? { ...req, context } : req, clean);
    const landed = applyLabResult(md, result, { target: req.tool === "alternatives" ? req.target : undefined, occurrence: args.occurrence });
    if (landed.md !== md) {
      await ctx.runMutation(api.docs.update, { api_token: args.api_token, id: args.id, content: landed.md, session_id: args.session_id });
      await ctx.runMutation(api.docs.resetSync, { api_token: args.api_token, id: args.id, content: landed.md });
    }
    return {
      result,
      applied: landed.applied,
      missed: landed.missed,
      words_before: wordCount(clean),
      words_after: wordCount(stripDrafting(landed.md, { dropGhosts: true })),
    };
  },
});

/** The paragraph around `target`, which is what the model needs to fit an alternative in. */
function surrounding(md: string, target: string): string {
  const at = md.indexOf(target);
  if (at < 0) return target;
  const start = md.lastIndexOf("\n\n", at);
  const end = md.indexOf("\n\n", at + target.length);
  return md.slice(start < 0 ? 0 : start + 2, end < 0 ? md.length : end).trim();
}
