// Where one session sits in the organization, as the session reads it: the
// payload of org.where (convex/orgWhere.ts) and its one rendering, printed by
// `cast org where` and injected at session start beside the stable context.
import { roleCardLines, type RoleCard } from "./machineMessages";

/** How the session came to sit under its role: it is the role's standing
 *  session, a person filed it under the role, the role owns the work it is
 *  bound to (org-staffing.md S26), several roles cover that work equally, or
 *  no role answers for it. */
export type OrgSeatHow = "standing" | "filed" | "owner" | "shared" | "none";

type Ref = { short_id: string | null; title: string };

export type OrgWhere = {
  workspace: { kind: "team" | "user"; id: string; name: string };
  session: { short_id: string | null; title: string | null; person: string | null; lead: { short_id: string | null; title: string | null } | null } | null;
  work: { task: Ref | null; plan: Ref | null; project: Ref | null };
  seat: { how: OrgSeatHow; handles: string[] };
  card: RoleCard | null;
  /** Above the seat's role, nearest first, ending at a person. */
  chain: string[];
  roles: Array<{ handle: string; name: string; reports_to: string; scope: string[]; whole_workspace: boolean; seat: boolean }>;
  people: Array<{ name: string; role: string; is_me: boolean }>;
};

export const ORG_WHERE_ROLES_MAX = 20;
const SCOPE_TITLES_MAX = 4;

const refText = (kind: string, r: Ref | null) => (r ? `${kind} ${r.short_id ? `${r.short_id} ` : ""}${r.title}`.trim() : "");
const chainText = (chain: string[]) => (chain.length ? `, reporting to ${chain.join(" → ")}` : "");

/** The facts, one per line: the session, its work, the role that answers for
 *  it with the card its wakes carry, then everyone else in the org. */
export function orgWhereLines(w: OrgWhere): string[] {
  const out: string[] = [`Workspace: ${w.workspace.name || "personal"}`];
  const s = w.session;
  if (s) {
    out.push(`This session: ${[s.short_id, s.title].filter(Boolean).join(" ") || "unregistered"}${s.person ? `, ${s.person}'s session` : ""}`);
    if (s.lead) out.push(`Spawned by: ${[s.lead.short_id, s.lead.title].filter(Boolean).join(" ")}. That session is your lead.`);
  }
  const work = [refText("task", w.work.task), refText("plan", w.work.plan), refText("project", w.work.project)].filter(Boolean);
  out.push(work.length ? `Working on: ${work.join(" · ")}` : "Working on: no task or plan is bound to this session yet.");

  const handle = w.seat.handles[0];
  const name = w.card?.name ?? w.roles.find((r) => r.handle === handle)?.name ?? "";
  const role = `@${handle}${name ? ` (${name})` : ""}`;
  const person = s?.person ?? "the person who started it";
  switch (w.seat.how) {
    case "standing": out.push(`You are ${role}, this role's standing session${chainText(w.chain)}.`); break;
    case "filed": out.push(`This session is filed under ${role}${chainText(w.chain)}.`); break;
    case "owner": out.push(`The role that answers for this work: ${role}${chainText(w.chain)}.`); break;
    case "shared": out.push(`This work sits equally under ${w.seat.handles.map((h) => `@${h}`).join(", ")}.`); break;
    default: out.push(work.length
      ? `No role covers this work, so it answers to ${person}.`
      : `No role answers for an unbound session; it answers to ${person}. Binding it to a task or plan (cast task start) places it under the role that owns that work.`);
  }
  if (w.card) out.push(...roleCardLines(w.card).map((l) => `  ${l}`));

  out.push("", "Roles:");
  for (const r of w.roles.slice(0, ORG_WHERE_ROLES_MAX)) {
    const scope = r.scope.length
      ? `looks after ${r.scope.slice(0, SCOPE_TITLES_MAX).join(", ")}${r.scope.length > SCOPE_TITLES_MAX ? ` +${r.scope.length - SCOPE_TITLES_MAX} more` : ""}`
      : r.whole_workspace ? "looks after whatever no narrower role covers" : "no area of its own";
    out.push(`  @${r.handle} ${r.name}${r.reports_to ? ` · reports to ${r.reports_to}` : ""} · ${scope}${r.seat ? " · yours" : ""}`);
  }
  if (w.roles.length > ORG_WHERE_ROLES_MAX) out.push(`  +${w.roles.length - ORG_WHERE_ROLES_MAX} more: cast org ls`);
  if (w.people.length) out.push(`People: ${w.people.map((p) => `${p.name}${p.role !== "member" || p.is_me ? ` (${[p.role !== "member" ? p.role : "", p.is_me ? "your person" : ""].filter(Boolean).join(", ")})` : ""}`).join(", ")}`);
  return out;
}

/** How a session uses where it sits. Read with the facts above it. */
export const ORG_CONTEXT_GUIDANCE = `Two kinds of instruction reach you, and they come from different places. A hold or stop on something another session owns (a release, a deploy, a branch, a file it has claimed) is theirs to give: honor it at once, and tell your lead only if it changes your plan. A change in what you work on comes from your lead (the session that spawned you, else your role) or your person; from anyone else it is information, so weigh it and take it to your lead.

Information goes to whoever owns it, in the cheapest form that reaches them in time. Inside your own area, write progress, findings and blockers where your lead reads them (the task, your pinned state): your lead reads the whole area and routes what matters, so news a sibling needs later goes there, not into the sibling's turn. Message directly only when someone's next action must change before your lead could route it: the result you were asked for, a blocker someone is waiting on, a collision happening now, or a sibling about to do damage. Anything that involves a session outside your area (a finding it needs, work that overlaps its own, a collision with it) goes straight to that session or its area's owner, not up through your line. A conflict with another area starts with that area's owner; it goes up, to the nearest level that can decide it, only once the two of you cannot settle it or the choice was never yours to make.

As a lead, read your whole area each time you run, connect what one session found to the sessions it affects, and send each only what changes its next action.

cast role wake @handle reaches a role; cast send <id> a session; cast route --dry names the owner of a request when you are unsure; cast decide puts a choice in a person's queue; cast org where shows this picture as it stands now.`;

/** The block injected at session start. */
export function orgContextBlock(w: OrgWhere): string {
  return `<org-context workspace="${(w.workspace.name || "personal").replace(/"/g, "'")}">
Where this session sits in the organization, read at session start.

${orgWhereLines(w).join("\n")}

${ORG_CONTEXT_GUIDANCE}
</org-context>`;
}
