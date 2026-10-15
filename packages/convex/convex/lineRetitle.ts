// A problem keeps a title its findings no longer hold (learning-loop.md LL9).
// A problem opens titled after its first finding, and a line run's refine
// station retitles it after what it read. Findings then leave (judged again,
// moved, merged) and others join, until none of the findings a title was
// written from is still on it: ct-59239 kept "The 30 September email to Sefi
// ..." over eleven calls that quote a fee percentage, ct-59328 a recap-email
// title over two calls that close on a date. Such a problem is renamed from
// the findings on it now, by one call charged to the team's grouping budget.
//
// What a title was written from lives on the cause (`titled`: the title and
// the findings on the problem when it was written). A title someone changed
// since (a person, a run's refine station) takes the findings on it at that
// moment as its own, so a person's or a run's title is never overwritten
// while a finding it was written over stays.
//
// Every title also gets a list name beside it (`cause.named`), from the same
// pass and budget: a finder's title carries its evidence (call ids, hashes,
// thread timestamps, a judge's whole sentence) and lists and decision heads
// show the name. The title stays whole for the problem's page.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { CHEAP_MODEL, parseJsonBlock, type SurfaceRequest } from "./lib/anthropic";
import { patchTask } from "./lib/taskWrite";
import { insertTaskComment } from "./tasks";
import { runModelCall } from "./modelCalls";

/** Problems one pass reads and at most how many it renames. */
export const RETITLE_SCAN = 80;
export const RETITLE_BATCH = 5;
/** Findings a rename reads, newest first. */
export const RETITLE_FINDINGS = 20;
const TITLE_MAX = 90;
/** Longest list name the naming call may write. */
export const LIST_NAME_MAX = 80;
export const RETITLE_AUTHOR = "retitle";

const OPEN_STATUSES = ["open", "in_progress", "in_review"] as const;

export type Titled = { title: string; from: string[] };

/**
 * What a problem's title needs, from the findings on it now: `baseline` when
 * nothing records what it was written from (or someone retitled it since), so
 * the findings on it now become its source; `retitle` when none of the
 * findings it was written from is still on it; null when it stands.
 */
export function retitleDue(title: string, titled: Titled | undefined, live: string[]): "baseline" | "retitle" | null {
  if (!live.length) return null;
  if (!titled || titled.title !== title) return "baseline";
  const now = new Set(live);
  return titled.from.some((id) => now.has(id)) ? null : "retitle";
}

/** Whether a problem needs a list name: no name was written for its title as it stands. */
export function nameDue(title: string, named: { for: string } | undefined): boolean {
  return named?.for !== title;
}

const NAME_SYSTEM = `You name a problem in a product's quality review. The list of problems shows only this name, and a busy executive scans it to pick one to open: one plain clause under ${LIST_NAME_MAX} characters saying what went wrong, in the product's terms. Keep the problem's own subject (what failed, for whom) and leave out its evidence: no ids, call or thread numbers, timestamps, dates, quotes or people's names. Never shorten the meaning into a vaguer one; a title that already says it that way keeps its own words.

Answer with JSON only: {"name": "..."}`;

/** The naming call for one problem; ./evals could replay exactly it. */
export function nameRequest(title: string): SurfaceRequest {
  return { model: CHEAP_MODEL, system: NAME_SYSTEM, prompt: `The problem's title:\n${title.replace(/^not met:\s*/i, "")}`, max_tokens: 200 };
}

/** A naming reply as the name, or null when it cannot be used. */
export function parseName(text: string | undefined): string | null {
  const j = parseJsonBlock(text ?? "") as { name?: unknown } | null;
  const name = typeof j?.name === "string" ? j.name.trim().replace(/\.$/, "") : "";
  return name && name.length <= LIST_NAME_MAX ? name : null;
}

const SYSTEM = `You name a problem in a product's quality review from the findings filed on it. A busy executive reads the title first and decides from it whether to look, so it says what the contacts or customers in these findings got, in their terms, in under 80 characters: the shared miss, not one person's story, not a guessed cause, no names of people or dates. When the findings do not share one miss, name the one most of them share. The description is one or two plain sentences: how many conversations and what happened in them, then nothing else.

Answer with JSON only: {"title": "...", "description": "..."}`;

export type RetitleFinding = { title: string; quote?: string };

/** The rename call for one problem; ./evals could replay exactly it. */
export function retitleRequest(was: string, findings: RetitleFinding[], conversations: number): SurfaceRequest {
  const lines = findings.map((f, i) => `${i + 1}. ${f.title}${f.quote ? `\n   quoted: "${f.quote.slice(0, 200)}"` : ""}`).join("\n");
  return {
    model: CHEAP_MODEL,
    system: SYSTEM,
    prompt: `The problem was titled "${was}", but none of the findings that title was written from is on it any more.\n\nIts ${findings.length} findings now, over ${conversations} conversations:\n${lines}`,
    max_tokens: 400,
  };
}

/** A rename reply as fields, or null when it cannot be used. */
export function parseRetitle(text: string | undefined): { title: string; description: string } | null {
  const j = parseJsonBlock(text ?? "") as { title?: unknown; description?: unknown } | null;
  const title = typeof j?.title === "string" ? j.title.trim().replace(/\.$/, "") : "";
  const description = typeof j?.description === "string" ? j.description.trim() : "";
  if (!title || title.length > TITLE_MAX || !description) return null;
  return { title, description };
}

const quoteOf = (md: string | undefined) => /^> (.+)$/m.exec(md ?? "")?.[1]?.trim();

type RetitleJob = { kind?: "name"; task_id: Id<"tasks">; title: string; from: string[]; workspace: string; team_id?: Id<"teams">; project_id?: Id<"projects">; findings: RetitleFinding[]; conversations: number };

/** A job's call is charged to its workspace's budget and its problem's project. */
const scopeOfJob = (job: RetitleJob) => ({ workspace: job.workspace, ...(job.team_id ? { team_id: job.team_id } : {}), ...(job.project_id ? { project_id: job.project_id } : {}) });

/** One pass's reads: baselines are written by `baseline`, renames come back as jobs. */
export const due = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ baselines: Array<{ task_id: Id<"tasks">; titled: Titled }>; jobs: RetitleJob[] }> => {
    const baselines: Array<{ task_id: Id<"tasks">; titled: Titled }> = [];
    const jobs: RetitleJob[] = [];
    for (const status of OPEN_STATUSES) {
      const tasks: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_source_status_readiness", (q: any) => q.eq("source", "signal").eq("status", status)).take(RETITLE_SCAN);
      for (const task of tasks) {
        if (!task.cause || !task.workspace) continue;
        const live: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).order("desc").take(50);
        const ids = live.map((s) => s.short_id);
        const need = retitleDue(task.title, task.cause.titled, ids);
        if (need === "baseline") baselines.push({ task_id: task._id, titled: { title: task.title, from: ids } });
        if (need === "retitle" && jobs.length < RETITLE_BATCH) {
          jobs.push({
            task_id: task._id,
            title: task.title,
            from: ids,
            workspace: task.workspace,
            ...(task.team_id ? { team_id: task.team_id } : {}),
            ...(task.project_id ? { project_id: task.project_id } : {}),
            findings: live.slice(0, RETITLE_FINDINGS).map((s) => ({ title: s.title, ...(quoteOf(s.detail_md) ? { quote: quoteOf(s.detail_md) } : {}) })),
            conversations: new Set(live.map((s) => s.moment ?? s.fingerprint)).size,
          });
        } else if (nameDue(task.title, task.cause.named) && jobs.length < RETITLE_BATCH) {
          jobs.push({ kind: "name", task_id: task._id, title: task.title, from: ids, workspace: task.workspace, ...(task.team_id ? { team_id: task.team_id } : {}), ...(task.project_id ? { project_id: task.project_id } : {}), findings: [], conversations: 0 });
        }
      }
    }
    return { baselines, jobs };
  },
});

export const baseline = internalMutation({
  args: { items: v.array(v.object({ task_id: v.id("tasks"), titled: v.object({ title: v.string(), from: v.array(v.string()) }) })) },
  handler: async (ctx, { items }) => {
    for (const it of items) {
      const task: Doc<"tasks"> | null = await ctx.db.get(it.task_id);
      // Written only over the title it was read with: a rename or a person's edit since wins.
      if (!task?.cause || task.title !== it.titled.title) continue;
      await ctx.db.patch(task._id, { cause: { ...task.cause, titled: it.titled } });
    }
  },
});

/**
 * A rename lands only on the title it was read with: a person or a run that
 * renamed the problem meanwhile keeps theirs. An open problem no run holds is
 * grounded again (lineGround), since its note spoke of the findings that left.
 */
export async function applyRetitleCore(ctx: any, taskId: Id<"tasks">, was: string, from: string[], named: { title: string; description: string }, now: number): Promise<boolean> {
  const task: Doc<"tasks"> | null = await ctx.db.get(taskId);
  if (!task?.cause || task.title !== was) return false;
  const reground = task.status === "open" && !task.workflow_run_id && !!task.readiness;
  await patchTask(ctx, task, {
    title: named.title,
    description: named.description,
    cause: { ...task.cause, titled: { title: named.title, from } },
    ...(reground ? { goal_ref: undefined, category: undefined, risk: undefined, readiness: undefined, readiness_note: undefined } : {}),
    updated_at: now,
  });
  await insertTaskComment(ctx, task._id, { author: RETITLE_AUTHOR, comment_type: "note", text: `Renamed from the ${from.length} ${from.length === 1 ? "finding" : "findings"} on it now: none of the findings "${was}" was written from is still here.` });
  return true;
}

/** A list name lands only on the title it was written for; the title itself is never touched. */
export async function applyNameCore(ctx: any, taskId: Id<"tasks">, title: string, name: string): Promise<boolean> {
  const task: Doc<"tasks"> | null = await ctx.db.get(taskId);
  if (!task?.cause || task.title !== title) return false;
  await ctx.db.patch(task._id, { cause: { ...task.cause, named: { name, for: title } } });
  return true;
}

export const applyName = internalMutation({
  args: { task_id: v.id("tasks"), title: v.string(), name: v.string() },
  handler: async (ctx, a) => applyNameCore(ctx, a.task_id, a.title, a.name),
});

export const apply = internalMutation({
  args: { task_id: v.id("tasks"), was: v.string(), from: v.array(v.string()), title: v.string(), description: v.string() },
  handler: async (ctx, a) => applyRetitleCore(ctx, a.task_id, a.was, a.from, { title: a.title, description: a.description }, Date.now()),
});

/** One pass (crons.ts): record what every title was written from, and rename the problems none of whose findings are left. */
export const sweep = internalAction({
  args: { dry: v.optional(v.boolean()) },
  handler: async (ctx, { dry }): Promise<{ baselined: number; renamed: Array<{ task_id: string; was: string; title?: string; error?: string }> }> => {
    const { baselines, jobs } = await ctx.runQuery(internal.lineRetitle.due, {});
    if (!dry && baselines.length) await ctx.runMutation(internal.lineRetitle.baseline, { items: baselines });
    const renamed: Array<{ task_id: string; was: string; title?: string; error?: string }> = [];
    for (const job of jobs) {
      if (job.kind === "name") {
        const req = nameRequest(job.title);
        const reply = await runModelCall(ctx, scopeOfJob(job), "grouping", { model: req.model, system: req.system, prompt: req.prompt, max_tokens: req.max_tokens, output: "json" }, "Problem name", 30_000);
        if (!reply.ok) { renamed.push({ task_id: String(job.task_id), was: job.title, error: reply.reason }); continue; }
        // An unusable answer is stored as "" (asked, no name; the list cuts the title): asking again mostly gets the same answer.
        const name = parseName(reply.text) ?? "";
        if (!dry) await ctx.runMutation(internal.lineRetitle.applyName, { task_id: job.task_id, title: job.title, name });
        renamed.push({ task_id: String(job.task_id), was: job.title, ...(name ? { title: name } : { error: "unreadable reply" }) });
        continue;
      }
      const req = retitleRequest(job.title, job.findings, job.conversations);
      const reply = await runModelCall(ctx, scopeOfJob(job), "grouping", { model: req.model, system: req.system, prompt: req.prompt, max_tokens: req.max_tokens, output: "json" }, "Problem rename", 30_000);
      const named = reply.ok ? parseRetitle(reply.text) : null;
      if (!named) { renamed.push({ task_id: String(job.task_id), was: job.title, error: reply.ok ? "unreadable reply" : reply.reason }); continue; }
      if (!dry) await ctx.runMutation(internal.lineRetitle.apply, { task_id: job.task_id, was: job.title, from: job.from, ...named });
      renamed.push({ task_id: String(job.task_id), was: job.title, title: named.title });
    }
    return { baselined: baselines.length, renamed };
  },
});
