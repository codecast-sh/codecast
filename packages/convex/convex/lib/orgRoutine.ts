// A role's routine (docs/architecture/org-staffing.md S25): the one recurring
// trigger on its standing session that wakes it on a schedule. Leaf module,
// read by org.brief and org.health as well as the role writers.

import { CHIEF_OF_STAFF_HANDLE } from "./orgAccess";

export const COMPANY_REVIEW_TITLE = "Company review";
export const COMPANY_REVIEW_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

// The routine's prompt: the standing session runs the review and proposes only
// when the stability rules warrant it.
export const COMPANY_REVIEW_PROMPT = [
  `Company review. Run \`cast org review\` (it reads \`cast org health --json\` and the inputs) and read each role's brief, then open the conversation with the person you report to: the reporting structure as it stands and as you would change it, in short plain messages, asking what the records cannot settle, and posting each thing that is ready to agree to as a small proposal with its short id on its own line.`,
  `Propose changes only when the stability rules in your charter warrant them: a bottleneck the flags show more than once, a role idle past the retire window while the company works, a project with no owner or no charter. A program role whose end has arrived (health flags it \`program_ended\`) is due rather than a judgement call: propose the retirement or the review its tenure names. When nothing warrants a change, say so in one line and end the turn; a quiet review is a good review.`,
  `Hold the evidence behind every change and give it when asked. You apply nothing.`,
].join("\n");

// A role wakes on a schedule through one ordinary recurring trigger on its
// standing session: daily for a role, the weekly company review for the chief
// of staff. The prompt is short and stays at principle level: the role knows
// who it is from its first turn, and `cast brief` is its memory.

export const ROLE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const ROLE_CHECK_PROMPT = [
  `Check your area. Run \`cast brief\`: it shows what changed since you last looked, which of your sessions wait on a person, and how the people who report to you are doing against their goals.`,
  `Act on what your switch and your grants let you act on. Put in front of the person what needs them, with your recommendation. When nothing needs doing, say so in one line and end the turn.`,
].join("\n");

export function roleRoutineFor(role: { handle: string; name: string }): { title: string; prompt: string; every_ms: number } {
  if (role.handle === CHIEF_OF_STAFF_HANDLE) return { title: COMPANY_REVIEW_TITLE, prompt: COMPANY_REVIEW_PROMPT, every_ms: COMPANY_REVIEW_EVERY_MS };
  return { title: `Check ${role.name}'s area`, prompt: ROLE_CHECK_PROMPT, every_ms: ROLE_CHECK_EVERY_MS };
}


/** Every live trigger armed on a role's standing session. */
export async function liveRoutinesOf(ctx: { db: any }, standing: { _id: any }): Promise<any[]> {
  const rows: any[] = await ctx.db
    .query("agent_tasks")
    .withIndex("by_originating_conversation", (q: any) => q.eq("originating_conversation_id", standing._id))
    .collect();
  return rows.filter((t) => t.status === "scheduled" || t.status === "running" || t.status === "paused");
}

/** The role's own routine as it stands (read only), or null before provision. */
export async function findRoleRoutine(ctx: { db: any }, role: { handle: string; name: string }, standing: { _id: any } | null): Promise<any | null> {
  if (!standing) return null;
  const title = roleRoutineFor(role).title;
  return (await liveRoutinesOf(ctx, standing)).find((t) => t.title === title) ?? null;
}
