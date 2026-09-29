// A role's routine (docs/architecture/org-staffing.md S25): the one recurring
// trigger on its standing session that wakes it on a schedule. Leaf module,
// read by org.brief and org.health as well as the role writers.

import { SESSION_NEEDS_INPUT_EVENT } from "@codecast/shared/contracts";
import { CHIEF_OF_STAFF_HANDLE } from "./orgAccess";

export const COMPANY_REVIEW_TITLE = "Company review";
export const COMPANY_REVIEW_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

// The routine's prompt (org-staffing.md S26): reviewing the structure is one
// of the Chief of Staff's jobs, run in its own thread
// whose brief is `cast org review` (it prints the review prompt with what it
// needs to act), and the Chief of Staff brings the answer to the person.
export const COMPANY_REVIEW_PROMPT = "Company review. Run `cast org review` and do the review it describes, here in your own thread: open the conversation with the person you report to, each proposal's short id alone on its line, and carry it on from there.";

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

// The route up (org-staffing.md S28) is a trigger too: one event trigger on
// the role's standing session, fired when a session that reports to the role
// needs input. The person edits, pauses or cancels it like the routine. The
// run names the waiting session itself, so the prompt says only what to do
// about it, and it still reads whole on a run a person starts by hand.
export const ROLE_NEEDS_INPUT_TITLE = "A session under you needs input";
export const ROLE_NEEDS_INPUT_PROMPT = [
  `A session that reports to you is waiting and cannot continue on its own. Read what it needs with \`cast read <its id>\`, and answer it with \`cast send\` when the answer is yours to give.`,
  `When it needs a person, raise it here in your own thread with your recommendation. \`cast brief\` lists every session waiting under you.`,
].join("\n");

const isNeedsInputTrigger = (t: any) => t.schedule_type === "event" && t.event_filter?.event_type === SESSION_NEEDS_INPUT_EVENT;

/** The role's needs-input trigger in whatever status it stands, a live one
 *  first, or null when the seat never had one. Found by its event, never its
 *  title, so a person may rename it; one they cancelled is still found, which
 *  is what keeps a cancel from being undone by the next arming. */
export async function findRoleNeedsInputTrigger(ctx: { db: any }, standing: { _id: any } | null): Promise<any | null> {
  if (!standing) return null;
  const rows: any[] = (await ctx.db
    .query("agent_tasks")
    .withIndex("by_originating_conversation", (q: any) => q.eq("originating_conversation_id", standing._id))
    .collect()).filter(isNeedsInputTrigger);
  return rows.find((t) => t.status === "scheduled" || t.status === "running") ?? rows.find((t) => t.status === "paused") ?? rows[0] ?? null;
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
