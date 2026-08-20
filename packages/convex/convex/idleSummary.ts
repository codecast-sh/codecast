import { internalMutation, internalAction, internalQuery } from "./functions";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { isLowSignalPrompt } from "./titleGeneration";

// Which rows carry human-readable conversation: real user/assistant text, not
// tool-result carriers or machine noise (task notifications, interruption
// markers, bare image sends). Mirrors titleGeneration's filtering — without
// it, an agentic session's tail can be 100% plumbing, and asking the model to
// summarize a conversation containing none stores its refusal prose
// ("I don't see a recent conversation to analyze…") as the idle_summary.
export function isSummarizableMessage(m: {
  role?: string;
  content?: string | null;
  tool_results?: unknown[] | null;
}): boolean {
  return (
    (m.role === "user" || m.role === "assistant") &&
    !!m.content?.trim() &&
    !m.tool_results?.length &&
    !isLowSignalPrompt(m.content)
  );
}

// The prompt states hard rules — start with a verb, one sentence, never
// "please"/"the user" — but never enforced them, so rule-breaking output
// (in practice always refusal/meta prose) sailed into storage. First-person
// openers are the refusal signature; a verb-first summary never needs one.
export function isUsableIdleSummary(text: string): boolean {
  const t = text.trim();
  if (!t || t.length >= 300) return false;
  if (/^i['\s]/i.test(t)) return false;
  if (/\b(please|the user)\b/i.test(t)) return false;
  return true;
}

// Refusal prose in a TITLE or SUBTITLE (fields idleSummary never writes but
// the same model-refusal class polluted before the write guards existed):
// first-person opener. Legit subtitles are "- " bullets and legit titles are
// noun phrases, so /^I /-shaped text is unambiguous refusal residue.
export function isRefusalProse(text: string): boolean {
  return /^i['\s]/i.test(text.trim());
}

// Candidate finder for the cleanup below: search the display-field indexes
// for refusal-shaped text and return only rows the write guards would reject
// today. Over-matching is fine — cleanup re-validates every field itself.
export const findRefusalSummaryCandidates = internalQuery({
  args: { searchQuery: v.string() },
  handler: async (ctx, args) => {
    const [byIdle, bySubtitle] = await Promise.all([
      ctx.db
        .query("conversations")
        .withSearchIndex("search_idle_summary", (q) => q.search("idle_summary", args.searchQuery))
        .take(100),
      ctx.db
        .query("conversations")
        .withSearchIndex("search_subtitle", (q) => q.search("subtitle", args.searchQuery))
        .take(100),
    ]);
    const seen = new Set<string>();
    const out: Array<{ id: string; idle_summary?: string; subtitle?: string }> = [];
    for (const c of [...byIdle, ...bySubtitle]) {
      if (seen.has(c._id)) continue;
      seen.add(c._id);
      const badIdle = !!c.idle_summary && !isUsableIdleSummary(c.idle_summary);
      const badSubtitle = !!c.subtitle && isRefusalProse(c.subtitle);
      if (badIdle || badSubtitle) {
        out.push({ id: c._id, idle_summary: c.idle_summary, subtitle: c.subtitle?.slice(0, 160) });
      }
    }
    return out;
  },
});

// One-time cleanup of pre-guard residue: model refusals stored as display
// fields. Takes candidate ids (cheap to over-supply — typically from the
// title/subtitle/idle_summary search index) and re-validates each field with
// the same guards that now gate writes, clearing only what fails. A bad value
// otherwise persists forever: generation only OVERWRITES on usable output, so
// a session whose tail is all tool-plumbing never self-heals.
export const cleanupUnusableSummaries = internalMutation({
  args: {
    conversation_ids: v.array(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const cleared: Array<{ id: string; fields: string[] }> = [];
    for (const id of args.conversation_ids.slice(0, 200)) {
      const conv = await ctx.db.get(id);
      if (!conv) continue;
      const patch: Record<string, undefined> = {};
      if (conv.idle_summary && !isUsableIdleSummary(conv.idle_summary)) {
        patch.idle_summary = undefined;
      }
      if (conv.subtitle && isRefusalProse(conv.subtitle)) {
        patch.subtitle = undefined;
      }
      if (conv.title && !conv.title_is_custom && isRefusalProse(conv.title)) {
        patch.title = undefined;
      }
      const fields = Object.keys(patch);
      if (fields.length) {
        await ctx.db.patch(id, patch);
        cleared.push({ id, fields });
      }
    }
    return cleared;
  },
});

// The settle verdicts the classifier may return — the who-acts-next answer for
// a settle the agent did not declare itself. Anything else the model says maps
// to null (no verdict written), so the row falls to needs-input, the safe side
// of the asymmetry: a blocked session misfiled as done stalls work silently,
// while a finished one misfiled as needs-input is merely today's noise.
//
// "dormant" is deliberately NOT a classifier verdict. Dormancy needs a wake the
// system can verify — a declaration, an open background task, an armed trigger,
// the user's own gesture. A model reading prose cannot verify one, and its first
// live misfire was exactly the fine line this feature must not cross: an agent
// ending on "the standup decides between A and B" was filed as dormant because
// "standup" read like a wake, when it was a human's decision. So the model only
// says done or needs_input; a stale stored "dormant" (pre-rule rows) is ignored.
export const SETTLE_VERDICTS = ["done", "needs_input"] as const;
export type SettleVerdict = (typeof SETTLE_VERDICTS)[number];

export function parseSettleVerdict(raw: string | null | undefined): SettleVerdict | null {
  const word = (raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (SETTLE_VERDICTS as readonly string[]).includes(word) ? (word as SettleVerdict) : null;
}

// Split the classifier's two-line reply. Tolerates a missing VERDICT line (older
// prompt shape, or a model that skipped it) by returning the whole text as the
// summary with no verdict.
export function parseSettleReply(raw: string): { verdict: SettleVerdict | null; summary: string } {
  const text = raw.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let verdict: SettleVerdict | null = null;
  const summaryLines: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*verdict\s*:\s*(.+)$/i);
    if (m && verdict === null) {
      verdict = parseSettleVerdict(m[1]);
      continue;
    }
    summaryLines.push(line.replace(/^\s*summary\s*:\s*/i, ""));
  }
  const summary = summaryLines
    .join("\n")
    .trim()
    .replace(/\s*\.{3,}\s*$/, "")
    .replace(/\s+to\s*$/, "")
    .trim();
  return { verdict, summary };
}

export const setIdleSummary = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    idle_summary: v.optional(v.string()),
    settle_verdict: v.optional(v.union(...SETTLE_VERDICTS.map((s) => v.literal(s)))),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {};
    if (args.idle_summary !== undefined) patch.idle_summary = args.idle_summary;
    // Stamped now, after the settle it describes, so isSettleVerdictCurrent
    // holds until the next turn bumps updated_at past it.
    if (args.settle_verdict !== undefined) {
      patch.settle_verdict = args.settle_verdict;
      patch.settle_verdict_at = Date.now();
    }
    if (Object.keys(patch).length) await ctx.db.patch(args.conversation_id, patch);
  },
});

// The tail the classifier reads: a handful of earlier turns for context, and
// the FINAL assistant message nearly whole. The verdict lives at the END of
// that message — "so the open question is…", "let me know which…" — and the
// first cut of this fed the model 500 chars of every message: it saw the
// opening of a long closing report and none of its ask, plus an earlier turn's
// "I'll be re-invoked when it completes", and filed a decision as dormant.
export const SETTLE_TAIL_MESSAGES = 30;
export const SETTLE_FINAL_HEAD_CHARS = 900;
export const SETTLE_FINAL_TAIL_CHARS = 3200;
export const SETTLE_CONTEXT_CHARS = 350;

export type SettleTailMessage = { role: string; content: string; isFinal: boolean };

// Rendered pages, canvases and long code blocks carry no verdict signal and
// swamp the window; keep a marker so the model knows a report was delivered.
function stripBulkyBlocks(text: string): string {
  return text
    .replace(/```cast-canvas[\s\S]*?```/g, "[canvas report]")
    .replace(/```(?:html|svg)[\s\S]*?```/g, "[rendered block]")
    .replace(/```[\w-]*\n([\s\S]{600,}?)```/g, (m) => `[code block, ${m.length} chars]`);
}

// Keep the END of a long final message (that is where the ask is), with a
// short head so the model still knows what the message opened with.
export function shapeFinalMessage(text: string): string {
  const t = stripBulkyBlocks(text);
  if (t.length <= SETTLE_FINAL_HEAD_CHARS + SETTLE_FINAL_TAIL_CHARS) return t;
  return `${t.slice(0, SETTLE_FINAL_HEAD_CHARS)}\n[… ${t.length - SETTLE_FINAL_HEAD_CHARS - SETTLE_FINAL_TAIL_CHARS} chars omitted …]\n${t.slice(-SETTLE_FINAL_TAIL_CHARS)}`;
}

// Pure shaping over the newest-first raw rows, shared by the query below and
// the eval script (scripts/settle-eval.ts) so what the model is graded on is
// what it sees in prod.
export function shapeSettleTail(
  newestFirst: Array<{ role?: string; content?: string | null; tool_results?: unknown[] | null; tool_calls?: unknown[] | null }>,
): SettleTailMessage[] {
  const kept = newestFirst.filter(isSummarizableMessage).reverse();
  const lastAssistant = [...kept].reverse().find((m) => m.role === "assistant");
  const shaped: SettleTailMessage[] = kept.map((m) => {
    const isFinal = m === lastAssistant;
    const raw = m.content || "";
    return {
      role: m.role || "user",
      isFinal,
      content: isFinal ? shapeFinalMessage(raw) : stripBulkyBlocks(raw).slice(0, SETTLE_CONTEXT_CHARS),
    };
  });
  // The transcript's very last entry is a tool CALL that never got its result:
  // the agent halted mid-work (died, was killed, lost its process) with no
  // closing message. Said out loud, because the last TEXT it wrote ("OTA is
  // live. Now the native build:") reads like a delivery when nothing after it
  // finished. Deliberately NOT triggered by a trailing tool RESULT — an agent
  // that writes its report, then runs `cast state` / a task comment as its
  // last action, ends on a result and settled on purpose.
  // …and not when a user-side TEXT message (a teammate's shutdown request, a
  // human's note) arrived after the final text: the stop then answered
  // something external, and the halted call is a wrap-up, not the work.
  const newest = newestFirst[0];
  const finalIdx = lastAssistant ? newestFirst.indexOf(lastAssistant as any) : -1;
  const textArrivedAfterFinal = finalIdx > 0 && newestFirst.slice(0, finalIdx).some(
    (m) => m.role === "user" && !!(m.content || "").trim() && !m.tool_results?.length,
  );
  const haltedMidCall =
    !!newest && newest.role === "assistant" && !!newest.tool_calls?.length && !(newest.content || "").trim() && !textArrivedAfterFinal;
  if (haltedMidCall && shaped.length) {
    shaped.push({ role: "note", isFinal: false, content: "After the final message the agent issued a tool call and stopped before it returned — it halted mid-work with no closing message." });
  }
  return shaped;
}

export const getMessagesForSummary = internalQuery({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    // 30, not 10: agentic tails are mostly tool-result carriers, and a window
    // that filters down to nothing produces no summary at all.
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("desc")
      .take(SETTLE_TAIL_MESSAGES);
    return shapeSettleTail(messages as any[]);
  },
});

// The classifier prompt, pure so the eval script grades the exact prod text.
export function buildSettlePrompt(messages: SettleTailMessage[]): string {
  const messageText = messages
    .map((m) => {
      if (m.role === "note") return `Note: ${m.content}`;
      const who = m.role === "assistant" ? "Assistant" : "User";
      return m.isFinal ? `${who} [FINAL MESSAGE — the settle]: ${m.content}` : `${who}: ${m.content}`;
    })
    .join("\n\n");

  return `An agent session just went quiet after its FINAL MESSAGE below. Decide who acts next, then describe the moment in one sentence.

Reply with exactly two lines:
VERDICT: <needs_input | done>
SUMMARY: <one sentence>

How to decide — read the FINAL MESSAGE first and let it decide; earlier messages are context only (a wait or a plan mentioned earlier is superseded by whatever the final message says):
- needs_input: the final message asks the human anything, offers options or a recommendation to choose from, defers a decision to a person or a meeting ("standup decides", "your call", "let me know"), hands the human an item to do — even as a plain statement, no question mark ("Yours: verify the domain", "what ships it: you commit and push", "on your side: sign in") — reports being blocked (missing access, credentials, a failing step it cannot resolve), or says it is waiting on someone. Any request, open question, or assigned item directed at the human = needs_input, however small, wherever it sits in the message.
- done: the final message reports FINISHED work — the change built and verified, the question answered, the deliverable produced — and nothing remains for anyone: no ask, no options to pick, no item handed to the human, no unresolved blocker. A closing "next steps" list the AGENT will do itself, or a courtesy "shout if you want changes", is still done; a real question or an item for the human is not.
- A plan is not a delivery: a final message that lays out an approach, proposal, design, diagnosis or estimate for work NOT yet executed ("here's how I'd fix it", a spec awaiting implementation, a proposed migration) is the start of the work, not its end — proceeding is the human's call, so needs_input even when it asks nothing.
- A final message that stops mid-plan — it announces what it is about to do ("Now the native build:", "Let me check the logs") and a Note says the agent then halted mid-work — is NOT a delivery: the agent stopped with work unfinished, so needs_input (a human has to look).
Findings are not asks: an audit or report that lists problems it found, gaps, risks or recommendations is a delivery (done) — the human reads it. It becomes needs_input only when the message hands the human a decision or an item ("three calls for you: whether to…", "confirm X before I continue", "which do you want").
The test is whether the thing ASKED FOR is finished. An audit asked for as an audit is finished when the report lands, even one recommending future work (done). A fix, feature or change is finished only when it is built — a root cause found, a plan written, an approach proposed on the way to it leaves the work ahead (needs_input).
A machine message after the final message that acknowledges or harvests it (a teammate shutdown_request, "report received") means the delivery landed: done.
When in doubt choose needs_input: misfiling a blocked agent as done stalls its work silently, while misfiling a finished one as needs_input only costs the human a glance.

SUMMARY rules — for needs_input write the imperative action the human should take, starting with a verb ("Confirm the exact UI change needed", "Choose between the two proposed approaches"); for done summarize what was last completed, starting with a verb ("Deployed auth fix and verified tests pass"). Never use "please", "the user", or "you". Be specific. One sentence. No quotes or JSON.

Conversation:
${messageText}`;
}

export const generateIdleSummary = internalAction({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;

    const messages = await ctx.runQuery(internal.idleSummary.getMessagesForSummary, {
      conversation_id: args.conversation_id,
    });

    if (messages.length === 0) return;

    const prompt = buildSettlePrompt(messages);

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 200,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        console.error("Idle summary API error:", response.status);
        return;
      }

      const data = await response.json();
      const raw = data.content?.[0]?.text?.trim() ?? "";
      const { verdict, summary } = parseSettleReply(raw);
      const usableSummary = summary && isUsableIdleSummary(summary) ? summary : undefined;

      // The verdict is written even when the summary line fails the prose
      // guards — the two are independent claims about the same settle. A
      // missing verdict writes nothing, so the row keeps its needs-input default.
      if (usableSummary || verdict) {
        await ctx.runMutation(internal.idleSummary.setIdleSummary, {
          conversation_id: args.conversation_id,
          idle_summary: usableSummary,
          settle_verdict: verdict ?? undefined,
        });
      }
      if (usableSummary) {
        await ctx.runAction(internal.sessionInsights.generateSessionInsight, {
          conversation_id: args.conversation_id,
          reason: "idle",
        });
      }
    } catch (error) {
      console.error("Failed to generate idle summary:", error);
    }
  },
});

// ── Scheduling: the classifier's own entry point ──────────────────────────────
//
// The settle classifier used to be scheduled from inside the needs-input PUSH
// check, behind that check's etiquette filters (pinned, agent-spawned fleets,
// schedule runs, subagents never chime). Those filters are about who gets a
// notification, not about what a settled row IS — so whole populations (every
// `cast spawn` audit, every pinned thread) could never be classified and sat
// in Needs Input forever. This is the classifier's own gate: it runs for any
// top-level settled row with content whose agent made no declaration and whose
// verdict does not already cover this settle.
export const classifySettle = internalMutation({
  args: { conversation_id: v.id("conversations"), status_ts: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || !conv.message_count) return { scheduled: false, reason: "no_content" };
    if (conv.is_subagent || conv.is_workflow_sub) return { scheduled: false, reason: "subagent" };
    if (conv.inbox_killed_at) return { scheduled: false, reason: "killed" };
    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversation_id))
      .first();
    // Scheduled off a specific status change: a newer change has its own run.
    if (args.status_ts !== undefined && session?.agent_status_updated_at !== args.status_ts) {
      return { scheduled: false, reason: "superseded" };
    }
    // A declaration outranks the classifier; don't spend the call.
    const st = session?.agent_status;
    if (st === "dormant" || st === "done" || st === "waiting") return { scheduled: false, reason: "declared" };
    if (st && st !== "idle") return { scheduled: false, reason: `status_${st}` };
    if (conv.settle_verdict_at && conv.settle_verdict_at >= conv.updated_at) return { scheduled: false, reason: "current" };
    await ctx.scheduler.runAfter(0, internal.idleSummary.generateIdleSummary, { conversation_id: conv._id });
    return { scheduled: true };
  },
});

// One-off / periodic sweep for rows the entry point above never saw: settled
// conversations with content, no live daemon declaration, and no verdict for
// their current settle. Spaced so a backlog of hundreds does not burst the
// model API. Scoped to one user unless `all` is passed.
export const backfillSettleVerdicts = internalMutation({
  args: {
    user_id: v.optional(v.id("users")),
    since_ms: v.optional(v.number()),
    limit: v.optional(v.number()),
    spacing_ms: v.optional(v.number()),
    /** Re-classify rows whose verdict was stamped before this (a prompt change). */
    refresh_before_ms: v.optional(v.number()),
    /** Exactly these rows (e.g. the inbox set from `cast sessions --json`) instead of a recency window. */
    conversation_ids: v.optional(v.array(v.id("conversations"))),
  },
  handler: async (ctx, args) => {
    const since = args.conversation_ids ? 0 : (args.since_ms ?? Date.now() - 14 * 24 * 60 * 60 * 1000);
    const refreshBefore = args.refresh_before_ms ?? 0;
    const limit = args.limit ?? 200;
    const spacing = args.spacing_ms ?? 1500;
    const rows = args.conversation_ids
      ? (await Promise.all(args.conversation_ids.map((id) => ctx.db.get(id)))).filter((c): c is NonNullable<typeof c> => !!c)
      : args.user_id
        ? await ctx.db
            .query("conversations")
            .withIndex("by_user_updated", (q: any) => q.eq("user_id", args.user_id).gte("updated_at", since))
            .order("desc")
            .take(limit * 3)
        : await ctx.db.query("conversations").order("desc").take(limit * 3);
    let scheduled = 0;
    for (const conv of rows) {
      if (scheduled >= limit) break;
      if (!conv.message_count || conv.updated_at < since) continue;
      if (conv.is_subagent || conv.is_workflow_sub || conv.inbox_killed_at || conv.inbox_dismissed_at) continue;
      const current = !!conv.settle_verdict_at && conv.settle_verdict_at >= conv.updated_at;
      if (current && conv.settle_verdict_at! >= refreshBefore) continue;
      const session = await ctx.db
        .query("managed_sessions")
        .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
        .first();
      const st = session?.agent_status;
      if (st && st !== "idle" && st !== "stopped") continue; // declared, or mid-turn
      await ctx.scheduler.runAfter(scheduled * spacing, internal.idleSummary.generateIdleSummary, { conversation_id: conv._id });
      scheduled++;
    }
    return { scheduled, scanned: rows.length };
  },
});
