// The word anchor leaves the product (docs/architecture/org-staffing.md S12,
// S22): the workspace's agent is its root role, its anchors row carries
// `org_role_id`, and every `cast anchor` verb but `say` is an alias of the
// role verb. This maps a verb to the role route it forwards to, so the CLI
// says so once and does the role thing.

import { HEAD_OF_PEOPLE_HANDLE } from "@codecast/shared/contracts/orgLead";
export { HEAD_OF_PEOPLE_HANDLE };

export type AnchorVerb = "create" | "ls" | "wake" | "brief" | "rm";

export type HeadForward = {
  /** The one line the CLI prints before forwarding. */
  note: string;
  /** The role verb this is an alias of, for the note and for `--json`. */
  roleVerb: string;
  /** The CLI route and body to post instead of the anchor route; null when
   *  the anchor verb has no act to forward (create, ls). */
  route: string | null;
  body: Record<string, unknown>;
};

const ROLE_VERB: Record<AnchorVerb, { verb: string; route: string | null }> = {
  create: { verb: "org staff", route: null },
  ls: { verb: "role show", route: null },
  wake: { verb: "role wake", route: "/cli/role/wake" },
  // A re-brief for a role is a restart: the next frame carries the charter
  // and the brief in full (org-roles-standing.md T4).
  brief: { verb: "role restart", route: "/cli/role/restart" },
  rm: { verb: "role retire", route: "/cli/org/retire" },
};

export function isSeatedAnchor(row: { org_role_id?: string | null } | null | undefined): boolean {
  return !!row?.org_role_id;
}

/** The forward for an anchor verb, or null when the anchor is still a plain
 *  anchor (no head of people stands) and the verb runs as before. */
export function headForward(
  row: { org_role_id?: string | null } | null | undefined,
  verb: AnchorVerb,
  extra: { message?: string; from_session?: string | null } = {},
): HeadForward | null {
  if (!isSeatedAnchor(row)) return null;
  const { verb: roleVerb, route } = ROLE_VERB[verb];
  const body: Record<string, unknown> = { role_id: row!.org_role_id };
  if (verb === "wake") {
    body.message = extra.message ?? "";
    if (extra.from_session) body.from_session = extra.from_session;
  }
  // `cast anchor rm` asks for the agent to go. Retiring the Head of People keeps its
  // standing session by default (S16), which would leave the assistant
  // running while the CLI says it was retired, so this door names the choice.
  if (verb === "rm") body.standing_session = "retire";
  return {
    note: `the workspace's agent is its root role (@${HEAD_OF_PEOPLE_HANDLE})${route ? ` · forwarding to cast ${roleVerb} ${HEAD_OF_PEOPLE_HANDLE}` : ` · use cast ${roleVerb} ${verb === "ls" ? HEAD_OF_PEOPLE_HANDLE : ""}`.trimEnd()}`,
    roleVerb,
    route,
    body,
  };
}
