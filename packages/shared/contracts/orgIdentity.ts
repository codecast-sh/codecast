// How a role is named to a person (org-staffing.md S30): a person like name
// with the role as its subtitle, "Ada · Executive Assistant, global", "Rowan ·
// Head of People", "Ember · Growth lead". The stored `org_roles.name` is the
// role TITLE (every older reader keeps working); `given_name` is the name a
// person chose, and until they do the role wears the character name of its
// face from the bank sessions use, hashed from its id, so every role has a
// name on every device and no migration invents one. One reader for every
// surface: the org node, the scope page header, the inbox card, the chat
// pill, the wake card, the header pin and `cast role show`.

import { EXECUTIVE_ASSISTANT_NAME, HEAD_OF_PEOPLE_NAME, LEGACY_HEAD_OF_PEOPLE_NAME, isHeadOfPeopleRole, type AssistantReach } from "./orgLead";
import { avatarOf } from "./orgAvatars";
import { characterNameFor, cleanCharacterName } from "./sessionCharacter";

export type IdentityRole = {
  _id: unknown;
  /** The role title ("Head of People", "Growth lead"). */
  name: string;
  handle: string;
  avatar?: string | null;
  given_name?: string | null;
  assistant?: AssistantReach<unknown> | null;
  scope_type?: "team" | "user";
};

export type RoleIdentity = {
  /** The person like name. */
  name: string;
  /** The role, as the row titles it. */
  title: string;
  /** The title with an assistant's reach appended: "Executive Assistant, global". */
  subtitle: string;
  /** False while the name is the hash default. */
  chosen: boolean;
};

/** "global", the team's name, or "personal, <team>" for a person's own assistant
 *  that looks after one team (its row is personal, its reach is a team). */
export function assistantReachWords(role: Pick<IdentityRole, "assistant" | "scope_type">, teamName?: string | null): string {
  if (!role.assistant) return "";
  if (role.assistant.reach === "global") return "global";
  const team = teamName ?? "team";
  return role.scope_type === "user" ? `personal, ${team}` : team;
}

export function roleIdentity(role: IdentityRole, opts: { teamName?: string | null } = {}): RoleIdentity {
  const chosen = cleanCharacterName(role.given_name);
  const name = chosen ?? characterNameFor(String(role._id), avatarOf(role));
  // A Head of People row from before the rename (handle `chief-of-staff`,
  // birth name "Chief of Staff", not yet migrated) reads under its new name;
  // a name a person chose stays theirs.
  const title = role.assistant ? EXECUTIVE_ASSISTANT_NAME : isHeadOfPeopleRole(role) && role.name === LEGACY_HEAD_OF_PEOPLE_NAME ? HEAD_OF_PEOPLE_NAME : role.name;
  const reach = assistantReachWords(role, opts.teamName);
  return { name, title, subtitle: reach ? `${title}, ${reach}` : title, chosen: chosen !== null };
}

/** "Ada · Executive Assistant, global": the one line a compact surface prints. */
export function roleIdentityLine(role: IdentityRole, opts: { teamName?: string | null } = {}): string {
  const id = roleIdentity(role, opts);
  return `${id.name} · ${id.subtitle}`;
}
