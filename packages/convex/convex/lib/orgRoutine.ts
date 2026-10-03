// A role's routine (docs/architecture/org-staffing.md S25): the one recurring
// trigger on its standing session that wakes it on a schedule. Leaf module,
// read by org.brief and org.health as well as the role writers.

import { ORG_AREA_CHANGE_EVENT, SESSION_NEEDS_INPUT_EVENT } from "@codecast/shared/contracts";
import { COMPANY_REVIEW_TITLE } from "@codecast/shared/contracts/orgReview";
import { isHeadOfPeopleRole } from "./orgAccess";

export { COMPANY_REVIEW_TITLE };
export const COMPANY_REVIEW_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

// The routine's prompt (org-staffing.md S26): reviewing the structure is one
// of the Head of People's jobs, run in its own thread
// whose brief is `cast org review` (it prints the review prompt with what it
// needs to act), and the Head of People brings the answer to the person.
export const COMPANY_REVIEW_PROMPT = "Company review. Run `cast org review` and do the review it describes, here in your own thread: open the conversation with the person you report to, each proposal's short id alone on its line, and carry it on from there.";

// A role wakes on a schedule through one ordinary recurring trigger on its
// standing session: daily for a role, the weekly company review for the Head
// of People. The prompt is short and stays at principle level: the role knows
// who it is from its first turn, and `cast brief` is its memory. The brief
// only names what moved, so the check reads the moved work before it writes
// a line about it (red list #20, ct-55713).

export const ROLE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const ROLE_CHECK_PROMPT = [
  `Check your area. Run \`cast brief\`: it points to what moved since you last looked, which of your sessions wait on a person, and how the people who report to you are doing against their goals.`,
  `The brief names what moved, not where it stands: your own lines and a session's pinned state were written before the move. Read each session that moved (\`cast read <id>\`) and write your lines from what it says now.`,
  `Act on what is yours to act on. Put in front of the person what needs them, with your recommendation; the rest belongs in your brief. When nothing needs doing, say so in one line and end the turn.`,
].join("\n");

export function roleRoutineFor(role: { handle: string; name: string }): { title: string; prompt: string; every_ms: number } {
  if (isHeadOfPeopleRole(role)) return { title: COMPANY_REVIEW_TITLE, prompt: COMPANY_REVIEW_PROMPT, every_ms: COMPANY_REVIEW_EVERY_MS };
  return { title: `Check ${role.name}'s area`, prompt: ROLE_CHECK_PROMPT, every_ms: ROLE_CHECK_EVERY_MS };
}

// The route up (org-staffing.md S28) is a trigger too: one event trigger on
// the role's standing session, fired when a session that reports to the role
// needs input. The person edits, pauses or cancels it like the routine. The
// run names the waiting session itself, so the prompt says only what to do
// about it, and it still reads whole on a run a person starts by hand.
export const ROLE_NEEDS_INPUT_TITLE = "A session under you needs input";
export const ROLE_NEEDS_INPUT_PROMPT = [
  `A session that reports to you is waiting and cannot continue on its own. Read what it needs with \`cast read <its id>\`, and answer it with \`cast send\` when the answer is yours to give. When it posted a decision, read it with \`cast decide show <its id>\` and answer it if you hold the grant, or recommend an option with \`cast decide recommend\`.`,
  `When it needs a person, raise it here in your own thread with your recommendation. \`cast brief\` lists every session waiting under you.`,
].join("\n");

/** An event trigger of a role: what fires it, and the words it carries. The
 *  needs-input one every role has (S28), and the area change one only the
 *  Head of People has (S29). */
export type RoleEventSpec = { event: string; title: string; prompt: string };
export const ROLE_NEEDS_INPUT_SPEC: RoleEventSpec = { event: SESSION_NEEDS_INPUT_EVENT, title: ROLE_NEEDS_INPUT_TITLE, prompt: ROLE_NEEDS_INPUT_PROMPT };

// The area watch (org-staffing.md S29) tells the Head of People, through one
// event trigger on its standing session, about a change that lasted: an area
// stuck or overloaded at two checks in a row, or a project with work and no
// owner. The run names the change itself, so the prompt says what to do
// about it; the person edits, pauses or cancels the trigger like any other.
export const HEAD_AREA_CHANGE_TITLE = "An area needs your review";
export const HEAD_AREA_CHANGE_PROMPT = [
  `Something in the company changed and it lasted: the run names it. Read that area as it stands now (\`cast org health\`, the role's brief, its sessions) and decide whether the structure or the owner should change, or whether the role only needs telling.`,
  `When a change is warranted, open it with the person you report to here in your thread as a small proposal, its short id alone on its line, with the evidence beside it. When the role can settle it itself, write to it (\`cast role wake @handle "<what changed and what you expect>"\`). When nothing is warranted, say so in one line and end the turn.`,
].join("\n");
export const HEAD_AREA_CHANGE_SPEC: RoleEventSpec = { event: ORG_AREA_CHANGE_EVENT, title: HEAD_AREA_CHANGE_TITLE, prompt: HEAD_AREA_CHANGE_PROMPT };

/** The event triggers a role is armed with: every role hears for its waiting
 *  sessions; the Head of People also hears the area watch. */
export function roleEventSpecsFor(role: { handle: string }): RoleEventSpec[] {
  return isHeadOfPeopleRole(role) ? [ROLE_NEEDS_INPUT_SPEC, HEAD_AREA_CHANGE_SPEC] : [ROLE_NEEDS_INPUT_SPEC];
}

const isEventTrigger = (event: string) => (t: any) => t.schedule_type === "event" && t.event_filter?.event_type === event;
export const isLiveTrigger = (t: any) => t.status === "scheduled" || t.status === "running" || t.status === "paused";

/** Every trigger ever armed on a standing session, in whatever status. */
async function triggersOf(ctx: { db: any }, standing: { _id: any }): Promise<any[]> {
  return await ctx.db
    .query("agent_tasks")
    .withIndex("by_originating_conversation", (q: any) => q.eq("originating_conversation_id", standing._id))
    .collect();
}

// A live one first, so a lookup in any status never picks a dead row over the
// one that runs.
const liveFirst = (rows: any[]): any | null =>
  rows.find((t) => t.status === "scheduled" || t.status === "running") ?? rows.find((t) => t.status === "paused") ?? rows[0] ?? null;

// A dead row counts only when it carries this role's id, so the trigger of an
// earlier role that stood in the same session never stops a new role from
// getting its own, while one the person cancelled for THIS role is still
// found and the next arming leaves it cancelled (S25).
const ofRole = (role: { _id: any }) => (t: any) => isLiveTrigger(t) || String(t.role_id ?? "") === String(role._id);

/** The role's needs-input trigger in whatever status it stands, a live one
 *  first, or null when the role never had one on this session. Found by its
 *  event, never its title, so a person may rename it. Without `role`, any
 *  needs-input trigger ever armed on the session. */
export async function findRoleNeedsInputTrigger(ctx: { db: any }, standing: { _id: any } | null, role?: { _id: any }): Promise<any | null> {
  return findRoleEventTrigger(ctx, standing, SESSION_NEEDS_INPUT_EVENT, role);
}

/** A role's event trigger for `event`, by the same rule. */
export async function findRoleEventTrigger(ctx: { db: any }, standing: { _id: any } | null, event: string, role?: { _id: any }): Promise<any | null> {
  if (!standing) return null;
  return liveFirst((await triggersOf(ctx, standing)).filter((t) => isEventTrigger(event)(t) && (!role || ofRole(role)(t))));
}

/** Every live trigger armed on a role's standing session. */
export async function liveRoutinesOf(ctx: { db: any }, standing: { _id: any }): Promise<any[]> {
  return (await triggersOf(ctx, standing)).filter(isLiveTrigger);
}

/** The role's own routine as it stands (read only), or null before provision. */
export async function findRoleRoutine(ctx: { db: any }, role: { handle: string; name: string }, standing: { _id: any } | null): Promise<any | null> {
  if (!standing) return null;
  const title = roleRoutineFor(role).title;
  return (await liveRoutinesOf(ctx, standing)).find((t) => t.title === title) ?? null;
}

/** The role's routine in whatever status it stands, a live one first, by the
 *  same rule as its needs-input trigger (ofRole). */
export async function findRoleRoutineInAnyStatus(ctx: { db: any }, role: { _id: any; handle: string; name: string }, standing: { _id: any }): Promise<any | null> {
  const title = roleRoutineFor(role).title;
  return liveFirst((await triggersOf(ctx, standing)).filter((t) => t.title === title && ofRole(role)(t)));
}

// ── Morning agenda (org-staffing.md S33) ────────────────────────────────────
// A role with people reporting to it sets the day's agenda with each of them:
// one recurring trigger on its standing session, daily at the person's
// morning, controllable on the role's page like its check. The run reads the
// people's goals and sessions through `cast brief` and sends each person ONE
// card they answer in a line (`cast decide --to`, a form with one text field).
export const ROLE_AGENDA_TITLE = "Morning agenda";
export const ROLE_AGENDA_EVERY_MS = 24 * 60 * 60 * 1000;
export const ROLE_AGENDA_HOUR_LOCAL = 9;
export const ROLE_AGENDA_PROMPT = [
  `Set the day's agenda with each person who reports to you. Run \`cast brief\`: for each of them it lists their goals and what moved in their sessions since yesterday.`,
  `Send each person ONE card and nothing else: \`cast decide --to <their name or email> "Agenda for today" --form plan=text:"Your plan for today" --context -\`, where the context says, in plain words, how they progressed against each goal since yesterday and names up to three things for today, each one line, most important first. Their answer is a line; read it when it arrives and keep their goals in your brief current from it.`,
  `A person with no goals in your brief gets a card that asks for one goal instead of a plan. Nothing here goes to the person you report to.`,
].join("\n");

/** The next morning at `hour` in a timezone (IANA name; UTC when missing or
 *  unknown), strictly after `now`. */
export function nextMorningAt(now: number, timezone: string | null | undefined, hour = ROLE_AGENDA_HOUR_LOCAL): number {
  const zone = timezone || "UTC";
  let parts: Intl.DateTimeFormat;
  try { parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  catch { parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  const read = (t: number) => Object.fromEntries(parts.formatToParts(new Date(t)).map((p) => [p.type, p.value])) as Record<string, string>;
  const local = read(now);
  // The zone's offset at `now`: the wall clock read back as UTC, minus now.
  const wall = Date.UTC(+local.year, +local.month - 1, +local.day, +local.hour % 24, +local.minute, +local.second);
  const offset = wall - Math.floor(now / 1000) * 1000;
  let target = Date.UTC(+local.year, +local.month - 1, +local.day, hour, 0, 0) - offset;
  if (target <= now) target += ROLE_AGENDA_EVERY_MS;
  return target;
}

// ── Knowledge handoff (org-staffing.md S32) ─────────────────────────────────
// When an area moves from one role to another, codecast copies the outgoing
// role's standing lines for it into the receiver's brief, and the outgoing
// role gets one trigger, run once in its own thread, to hand over what the
// lines do not say. The receiver's name and the moved area are in the title
// and the prompt, so the run reads whole when a person starts it by hand.
export const ROLE_HANDOFF_TITLE_PREFIX = "Hand over ";
export type HandoffReceiverSpec = { handle: string; areas: string[] };

export function roleHandoffTitle(receivers: HandoffReceiverSpec[]): string {
  const to = receivers.map((r) => `@${r.handle}`).join(" and ");
  return `${ROLE_HANDOFF_TITLE_PREFIX}${receivers.length === 1 ? receivers[0].areas.join(", ") : "your areas"} to ${to}`;
}

export function roleHandoffPrompt(receivers: HandoffReceiverSpec[], reason: "retire" | "split" | "scope", deadline: number): string {
  const lines = receivers.map((r) => `- @${r.handle} takes ${r.areas.join(", ")}`);
  const why = reason === "retire" ? "Your role is being retired and waits for this handoff before it is decommissioned" : reason === "split" ? "Your role was split into two leads" : "Part of your area moved to another role";
  return [
    `${why}. Your "Where it stands" lines for the moved areas were already copied into each receiver's brief, marked as yours.`,
    ...lines,
    `Hand each receiver what the lines do not say: decisions made and why, the direction you were taking, what is verified and what is not, open questions, people and threads to know, the next steps in order. Write it for a role reading it cold, the way \`cast handoff\` writes a brief, one section per area.`,
    `Deliver it with \`cast role handoff @<receiver> -\` and the text on stdin, once per receiver; it lands in their brief and wakes them. Then end the turn. The deadline is ${new Date(deadline).toISOString().slice(0, 16).replace("T", " ")} UTC; after it the handoff closes with whatever was written.`,
  ].join("\n");
}

// ── Merge report (the-line.md L12) ──────────────────────────────────────────
// The line's merge step records each merge on the role's standing session so
// the role reports it to the person it reports to in its own words.
export function mergeReportLine(args: { task_short_id: string; task_title: string; branch: string; sha: string; into: string; used: number; limit: number }): string {
  return `The line merged ${args.task_short_id} (${args.task_title}) from ${args.branch} into ${args.into} at ${args.sha.slice(0, 10)}: merge ${args.used} of ${args.limit} today. Report it in one line to the person you report to, with the task's id, and end the turn.`;
}
