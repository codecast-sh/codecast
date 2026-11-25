// A person's profile proposed from what they did (docs/architecture/org-people.md
// P5): the change the Head of People's people pass posts, with the evidence
// counts it read. A leaf: orgProposal.ts carries the change in its union and
// reads these, so nothing here imports it. Applying one writes the profile
// through orgPeople.performSetProfile; it never touches what anyone can read.

import { cleanProfilePatch, type PersonProfile } from "./personProfile";

/** The kinds that describe people; a proposal of them is its own work. */
export const ORG_PEOPLE_KINDS: readonly string[] = ["person_profile"];

export const PROFILE_FIELDS = ["title", "focus", "labels", "about"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** What the profile was read from: the window's counts and the projects the
 *  person's sessions and tasks touched, busiest first. */
export type OrgPersonEvidence = {
  window_days: number;
  sessions: number;
  commits: number;
  tasks_closed: number;
  decisions_answered: number;
  calls_led: number;
  projects: string[];
};
export const EVIDENCE_COUNTS = ["sessions", "commits", "tasks_closed", "decisions_answered", "calls_led"] as const;

/** `person` is "@handle" or the member's name as the inputs print it. The
 *  server stamps `user_id`, `name` and `before` (the profile as it stood) when
 *  the proposal is posted, so the card reads before and after cold. */
export type OrgPersonProfileChange = {
  kind: "person_profile";
  person: string;
  evidence: OrgPersonEvidence;
  user_id?: string;
  name?: string;
  before?: PersonProfile;
} & PersonProfile;

export const proposedProfile = (c: PersonProfile): PersonProfile =>
  Object.fromEntries(PROFILE_FIELDS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]])) as PersonProfile;

/** The fields whose proposed value differs from `before`. */
export function movedProfileFields(c: OrgPersonProfileChange): ProfileField[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return PROFILE_FIELDS.filter((k) => c[k] !== undefined && !same(c[k], c.before?.[k]));
}

const count = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;

export function personProfileChangeError(raw: any): string | null {
  if (typeof raw.person !== "string" || !raw.person.trim()) return 'person_profile needs person: "@handle" or the member\'s name';
  if (!PROFILE_FIELDS.some((k) => raw[k] !== undefined)) return "person_profile proposes at least one of title, focus, labels, about";
  for (const k of ["title", "focus", "about"] as const) if (raw[k] !== undefined && typeof raw[k] !== "string") return `person_profile ${k} is a string`;
  if (raw.labels !== undefined && !(Array.isArray(raw.labels) && raw.labels.every((l: unknown) => typeof l === "string"))) return "person_profile labels is a list of words";
  const cleaned = cleanProfilePatch(proposedProfile(raw));
  if (!cleaned.ok) return `person_profile: ${cleaned.error}`;
  const e = raw.evidence;
  if (!e || typeof e !== "object") return `person_profile needs evidence: { window_days, ${EVIDENCE_COUNTS.join(", ")}, projects }, the counts it was read from`;
  if (!(count(e.window_days) && e.window_days > 0)) return "person_profile evidence.window_days is the window in days";
  for (const k of EVIDENCE_COUNTS) if (!count(e[k])) return `person_profile evidence.${k} is a whole number`;
  if (!(Array.isArray(e.projects) && e.projects.every((p: unknown) => typeof p === "string"))) return "person_profile evidence.projects is the project titles they touched";
  return null;
}

export const personOf = (c: OrgPersonProfileChange) => c.name?.trim() || c.person.trim();

/** "12 sessions · 30 commits · 4 tasks closed · 2 decisions · 1 call led, over 30 days". */
export function evidenceWords(e: OrgPersonEvidence): string {
  const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;
  return `${[n(e.sessions, "session"), n(e.commits, "commit"), `${n(e.tasks_closed, "task")} closed`, n(e.decisions_answered, "decision"), `${n(e.calls_led, "call")} led`].join(" · ")}, over ${e.window_days} days`;
}

/** One line per change, the words the CLI walk and the log use. */
export function describePersonProfile(c: OrgPersonProfileChange): string {
  const parts = PROFILE_FIELDS.filter((k) => c[k] !== undefined).map((k) => k === "labels" ? `labels ${(c.labels ?? []).join(", ") || "none"}` : k === "about" ? "about" : `${k} "${c[k]}"`);
  return `profile ${personOf(c)}: ${parts.join(", ")}`;
}

/** The card's verb first clause: write a first profile, or change the fields that drifted. */
export function personProfileClause(c: OrgPersonProfileChange): string {
  const had = !!c.before && PROFILE_FIELDS.some((k) => c.before![k] !== undefined && c.before![k] !== "");
  const moved = movedProfileFields(c);
  if (!had) return `write ${personOf(c)}'s profile`;
  if (!moved.length) return `keep ${personOf(c)}'s profile as it is`;
  const words = moved.map((k) => (k === "about" ? "longer description" : k));
  return `change ${personOf(c)}'s ${words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0]}`;
}

export const PERSON_PROFILE_EFFECT = "Every session reads the new profile at start and `cast org person` prints it. Nothing about what anyone can read or decide changes.";

/** The change's shape as the Head of People's reference prints it. */
export const PERSON_PROFILE_SHAPE = 'person_profile: { person: "@handle", title?, focus?, labels?, about?, evidence: { window_days, sessions, commits, tasks_closed, decisions_answered, calls_led, projects: [titles] } }: a member\'s profile, read from their own work; only the fields it changes';

/** True when every live change is a profile of `userId`: changes the person
 *  may decide without being an admin (org-people.md P5). The server's check
 *  and the phone's gate both read this. */
export function ownProfilesOnly(userId: string | null | undefined, rows: ReadonlyArray<{ status: string; change: { kind: string; user_id?: string } }>): boolean {
  const live = rows.filter((r) => r.status !== "removed");
  return !!userId && live.length > 0 && live.every((r) => r.change.kind === "person_profile" && r.change.user_id === String(userId));
}
