// Where new work lands (docs/architecture/org-staffing.md S35 "Routing").
// ONE rule, read by the server (`orgRoute.route`, `/cli/route`), the CLI's
// output and org health's attribution, so every landing says the same line:
//
//   1. Named.    Work addressed to a person or a role goes there.
//   2. Anchored. Work that names a task, a plan or a project is owned by
//                `ownerOf` over that anchor (S26).
//   3. Started.  Work with no anchor and no name stays with whoever started it.
//   4. Read.     A request that is none of these is read by the semantic
//                router, which files where it is confident and otherwise
//                returns the top choices.
//
// Pure and generic over the caller's role rows, like orgLead.

import { isWholeWorkspaceRole, ownerOf, type LeadRole, type OwnedWork, type WorkOwner } from "./orgLead";

export type RouteOwner<R> = { kind: "role"; role: R } | { kind: "user"; user_id: string };

export type RouteInput<R> = {
  /** Line 1: `--to @role`, `--to me`, an @mention, `--assignee`, a reparent. */
  to?: RouteOwner<R> | null;
  /** Line 2: the task's, plan's or project's work. */
  anchor?: OwnedWork | null;
  /** Line 3: who started it (a session's starter, a request's sender). */
  starter?: string | null;
};

export type RouteLanding<R> =
  | { line: 1; owner: RouteOwner<R>; why: string }
  | { line: 2; owner: RouteOwner<R>; why: string }
  /** Two or more roles watch the anchor and none is closer (S26 watchers): the choice is theirs to make. */
  | { line: 2; owner: null; choices: R[]; why: string }
  | { line: 3; owner: RouteOwner<R>; why: string }
  /** Nothing placed it: the semantic router reads it (S35). */
  | { line: 4; owner: null; why: string };

const named = (work: OwnedWork) => (work.plan_id ? "plan" : work.project_id ? "project" : "nothing");

export function routeWork<R extends LeadRole>(input: RouteInput<R>, roles: readonly R[] | null | undefined): RouteLanding<R> {
  if (input.to) return { line: 1, owner: input.to, why: input.to.kind === "role" ? `named @${input.to.role.handle ?? "role"}` : "named a person" };
  const anchor = input.anchor;
  if (anchor && (anchor.plan_id || anchor.project_id)) {
    const owner: WorkOwner<R> = ownerOf(anchor, roles);
    if (owner.kind === "owner") {
      const whole = isWholeWorkspaceRole(owner.role);
      return { line: 2, owner: { kind: "role", role: owner.role }, why: whole ? `no role names its ${named(anchor)}; @${owner.role.handle} looks after the rest` : `@${owner.role.handle} names its ${named(anchor)}` };
    }
    if (owner.kind === "watchers") return { line: 2, owner: null, choices: owner.roles, why: `${owner.roles.length} roles watch its ${named(anchor)} and none is closer` };
    if (input.starter) return { line: 3, owner: { kind: "user", user_id: input.starter }, why: `no role covers its ${named(anchor)}; it stays with whoever started it` };
    return { line: 4, owner: null, why: `no role covers its ${named(anchor)}` };
  }
  if (input.starter) return { line: 3, owner: { kind: "user", user_id: input.starter }, why: "no task, plan or project; it stays with whoever started it" };
  return { line: 4, owner: null, why: "no name, no task, no plan, no project" };
}

/** The one-line form every surface prints: `→ @cold-email · line 2: @cold-email names its plan`. */
export function landingLine<R extends LeadRole & { handle?: string }>(landing: RouteLanding<R>, personName?: (userId: string) => string): string {
  const who = landing.owner
    ? landing.owner.kind === "role" ? `@${landing.owner.role.handle}` : personName?.(landing.owner.user_id) ?? "you"
    : "choices" in landing ? landing.choices.map((r) => `@${r.handle}`).join(" or ") : "nobody yet";
  return `→ ${who} · line ${landing.line}: ${landing.why}`;
}
