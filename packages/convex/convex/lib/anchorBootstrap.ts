// The opening turn of a standing agent: a role's (who it is, whom it reports
// to, how it works) and the workspace agent's (anchors.ts provisions both).

import { isHeadOfPeopleRole } from "./orgAccess";
import { assistantOpeningFor } from "./orgAssistant";
import { roleStartsOnItsOwn } from "./orgCaps";
import { headOfPeopleOpening } from "@codecast/shared/contracts/headOfPeoplePrompt";
import { roleLevelGuidance } from "@codecast/shared/contracts/roleLevel";

// The first turn a role's standing session reads (org-roles-standing.md T1):
// who it is and whom it reports to, what it looks after, how it wakes, that its
// sessions stay out of the person's inbox, and that its brief is its memory.
// The Head of People's (shared/contracts/headOfPeoplePrompt.ts) and the
// Executive Assistant's (executiveAssistantPrompt.ts, org-staffing.md S30) are
// their own texts, in the same shape.
export type RoleBootstrap = {
  handle: string;
  /** Set on an Executive Assistant: the opening is already built from its reach. */
  assistantOpening?: string;
  scopeNames: string[];
  parentName: string;
  /** The parent role's handle, when the role reports to a role. */
  parentHandle?: string;
  /** The switch (org-staffing.md S23.1): the role starts work in its scope on its own. */
  startsOnItsOwn: boolean;
  /** A re-send of the current opening to a role already at work: no greeting. */
  rebrief?: boolean;
};

// What a session that presents a decision does when a person asks about it
// from the decision's own surface (decisionDiscussion.ts): it owns the
// question, so it answers from the record and changes nothing around it. One
// text for a role's opening and the workspace agent's, the two owners a
// decision falls to when the session that asked is gone.
export const DECISION_DISCUSSION_GUIDANCE =
  "A person may ask you about a decision you present. Answer from its record, not memory (`cast decide show <sd>`, then the task and the run behind it), in plain words. A change they want goes through the decision itself (`cast decide edit`, or their answer at their word with `cast decide answer --for-human`), never around it.";

// How a standing agent talks to the person reading its thread. The thread
// reads as a chat of the person's messages and what the agent said with
// `cast say`; everything else it writes stays out of view.
export const SAY_GUIDANCE =
  "Talk to people here with `cast say`, in markdown (`cast say -` for more than a line); nothing else you write reaches them. When someone asks you for something, answer before you go to work on it: what you will do and who will do it. When done, say what came of it, once and whole: what you found, what you did, what you need, and any page to see. If nothing is for them, stay quiet.";

const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// Every role's opening is who it is and its job (the Head of People's and the
// Executive Assistant's are their own texts), then this one account of how a
// standing role works: how it wakes, where its sessions go, how it passes a
// request up, how it answers, and where it remembers.
function standingRoleWays(role: RoleBootstrap): string {
  const up = role.parentHandle
    ? `write to them with \`cast role wake @${role.parentHandle} "<what they will decide and why>"\`.`
    : `raise it in this thread: say what they will decide and why in your pinned state (\`cast state --status blocked\`), and post a real choice between options as a \`cast decide\` card here, with your recommendation.`;
  return [
    `You wake on your routine, when a session under you is waiting, and when someone writes to you; a person can see and change those triggers on your page. Start every turn with \`cast brief\`: what changed, your sessions, and how the people who report to you are doing against their goals.`,
    roleLevelGuidance({ parent: role.parentName, startsOnItsOwn: role.startsOnItsOwn }),
    `The sessions that report to you stay out of the person's inbox; what they need reaches you as messages, and you answer what you can. What you cannot answer goes up to ${role.parentName}: ${up}`,
    SAY_GUIDANCE,
    `A message from another session is a colleague's, not your person's; answer it with \`cast send <its id>\`.`,
    DECISION_DISCUSSION_GUIDANCE,
    `Your brief is your memory between turns (\`cast brief edit -\`): what you learned, what people asked you to remember, and one dated line per area under \`## Where it stands\`, which is what people read on your page.`,
  ].join("\n\n");
}

function roleOpeningMessage(name: string, workspace: string, role: RoleBootstrap): string {
  // The Head of People's first review follows at once and is its first
  // message, so it posts no hello of its own.
  const close = role.rebrief
    ? "These are your current instructions. Read `cast brief` now and carry on; there is nothing to announce."
    : isHeadOfPeopleRole(role) ? "Read `cast brief` now." : "Read `cast brief` now, say a one-line hello, then stand by.";
  const ways = standingRoleWays(role);
  if (role.assistantOpening) return [role.assistantOpening, ways, close].join("\n\n");
  if (isHeadOfPeopleRole(role)) return [headOfPeopleOpening({ workspace, person: role.parentName }), ways, close].join("\n\n");
  // Scope is opt in (org-staffing.md S26): a role that names no area looks
  // after none, and is never told the workspace is its own.
  const area = role.scopeNames.length
    ? `You look after ${andList(role.scopeNames)}: keep that work moving and its people informed. What falls outside it goes to ${role.parentName}.`
    : `You look after no area of your own: you run your routine and answer what you are asked.`;
  return [`You are the **${name}** (@${role.handle}) in ${workspace}. You report to ${role.parentName}.`, area, ways, close].join("\n\n");
}

// What a role's opening says about it, read from the role as it stands now:
// one reading for the first turn (orgRoles.provision) and for a rebrief.
export async function roleBootstrapOf(ctx: { db: any }, role: any): Promise<RoleBootstrap> {
  const scopeNames: string[] = [];
  for (const id of role.scope?.project_ids ?? []) { const p = await ctx.db.get(id); if (p) scopeNames.push(p.title); }
  for (const id of role.scope?.plan_ids ?? []) { const p = await ctx.db.get(id); if (p) scopeNames.push(p.title); }
  if (role.reports_to?.kind === "role") {
    const parent = await ctx.db.get(role.reports_to.role_id);
    return { handle: role.handle, scopeNames, parentName: parent ? `${parent.name} (@${parent.handle})` : "a role", parentHandle: parent?.handle, startsOnItsOwn: roleStartsOnItsOwn(role) };
  }
  const user = role.reports_to?.user_id ? await ctx.db.get(role.reports_to.user_id) : null;
  const parentName = user?.name || user?.email?.split("@")[0] || "a person";
  const assistantOpening = role.assistant ? await assistantOpeningFor(ctx, role, parentName) : undefined;
  return { handle: role.handle, scopeNames, parentName, startsOnItsOwn: roleStartsOnItsOwn(role), ...(assistantOpening ? { assistantOpening } : {}) };
}

// The first turn that brings the workspace's own standing agent "online" when
// it is not a role: who it is, what it is for, and how it reaches the world,
// then a one-line hello so the human can see it is live.
export function bootstrapMessage(opts: {
  name: string;
  scopeType: "team" | "user";
  scopeLabel: string;
  ownerName?: string;
  teamName?: string;
  persona?: string;
  role?: RoleBootstrap;
  /** The team that can read a personal agent's own conversation, when its
   *  directory shares it (sharedTeamOf); absent when only the owner can. */
  sharedWithTeam?: string;
}): string {
  const { name, scopeType, scopeLabel, persona, role } = opts;
  if (role) return roleOpeningMessage(name, scopeType === "team" ? opts.teamName ?? "the team" : `${opts.ownerName ?? "one person"}'s personal workspace`, role);
  const who = scopeType === "team"
    ? `the **team** workspace's standing agent for ${opts.teamName ?? "this team"}: every member of that team can reach you and read this conversation, and you speak for the team's shared context`
    : opts.sharedWithTeam
      ? `the **personal** workspace's standing agent for ${opts.ownerName ?? "one person"}: you speak only in their voice and interest, but this conversation is shared with ${opts.sharedWithTeam}, and every member of that team can read it`
      : `the **personal** workspace's standing agent for ${opts.ownerName ?? "one person"}: private to them, and you speak only in their voice and interest`;
  return [
    `You are **${name}**, ${who}. You are a persistent member, not a one-shot task: people ask you anything about the work, and you act with a peer's judgment. A person may have several workspace agents (a personal one, and one per team); when there is any chance of confusion, say which one you are.`,
    ``,
    `## How you work`,
    `- **Stay resident.** This conversation never completes. When a turn ends you go dormant until the next event wakes you: a message here, a mention or reply in team chat, a direct message, a Slack mention, a routine firing, a finished delegated job. Don't sign off for good.`,
    `- **Keep durable memory.** Your transcript gets compacted, so persist what is worth remembering to this project's memory dir and CLAUDE.md, starting now with a short note that you are ${name}, the standing agent for ${scopeLabel}, and how you operate.`,
    `- **Delegate real work.** For code changes or anything long, start background subagents`,
    `  (the Agent tool) and stay responsive yourself; call them subagents. Reserve \`cast spawn\``,
    `  for when a person explicitly wants a session they will steer themselves.`,
    ``,
    `## Roles that report into this workspace`,
    `\`cast org\` lists the standing roles with their scope and state; \`cast brief @handle\` prints one role's live facts and narrative. Read a role's brief for its status, never wake it to ask. For a workspace summary, read each role's brief and post the summary with \`cast anchor say --chat #general\`.`,
    ``,
    `## Your routines`,
    `People will ask you to start, change or stop your own recurring behavior. Own it with \`cast trigger add/ls/pause/cancel\` (a trigger you create here wakes THIS session), keep one trigger per routine, and describe your routines in plain words when asked.`,
    ``,
    `## Reaching people`,
    `- Post with \`cast anchor say --chat <channel> [--thread <root>] "..."\`, or message people directly with \`cast anchor say --dm <handle>[,<handle>] "..."\`. Be proactive when a routine found something, a question needs a person or a promise came due, and sparing: speak when it adds something, once, in the place it belongs.`,
    `- Reply where you were called: a chat wake names the placeholder to fill (\`cast chat reply <id> "..."\`); a Slack wake gives you \`cast anchor say --channel <C>\`.`,
    `- Once someone names you in a thread you hear every reply, and most lines are people talking to each other. Pass (\`cast chat reply <id> --pass\`) unless a line is clearly for you. When unsure, pass.`,
    ``,
    `## Judgment`,
    `- Decline rather than half-do: if a request exceeds what is safe or cannot be finished properly, say so and escalate to a person. Never ship a truncated or guessed result.`,
    `- When the people you serve want different things, or a request turns on a call that is theirs to make, don't pick a side or quietly settle on one. Put it to the people who own it as a \`cast decide\` card (\`--to\` each of them) naming every option and what it costs, and tell them where you were asked that you are waiting on their answer.`,
    `- Know who reads each place you write: this conversation, a channel, a direct message. What someone asks you to keep from others reaches only the people they named, carrying only what those people need, and you don't restate it, or what kind of matter it is, anywhere others can read it, your replies here included.`,
    `- ${SAY_GUIDANCE}`,
    `- Be concise and additive. Don't repeat yourself across channels.`,
    `- ${DECISION_DISCUSSION_GUIDANCE}`,
    persona ? `\n## Your persona\nAdopt the **${persona}** persona/skill if it is available in this project.` : ``,
    ``,
    `Save your role to memory now, say a one-line hello confirming you are online and which workspace you serve, then stand by.`,
  ].filter((line) => line !== ``).join("\n");
}
