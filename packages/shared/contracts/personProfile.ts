// What a person does at the company (docs/architecture/org-people.md P4): a
// short version every session reads at start, and a long one read on demand
// (`cast org person`). Stored on the person's team membership, so it is per
// workspace: the same person can be Founder in one team and Advisor in another.

export const PROFILE_TITLE_MAX = 60;
export const PROFILE_FOCUS_MAX = 140;
export const PROFILE_LABELS_MAX = 8;
export const PROFILE_LABEL_MAX = 24;
export const PROFILE_ABOUT_MAX = 6000;

export type PersonProfile = {
  title?: string;
  focus?: string;
  labels?: string[];
  about?: string;
};

/** A label as the team vocabulary keeps it: lower case, words joined by dashes. */
export function normalizeLabel(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, PROFILE_LABEL_MAX);
}

export function normalizeLabels(raw: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const r of raw.flatMap((s) => s.split(","))) {
    const l = normalizeLabel(r);
    if (l && !out.includes(l)) out.push(l);
  }
  return out.slice(0, PROFILE_LABELS_MAX);
}

/** Checks a profile patch and returns it cleaned, or the reason it cannot be
 *  stored. An empty string clears a field. */
export function cleanProfilePatch(p: PersonProfile): { ok: true; patch: PersonProfile } | { ok: false; error: string } {
  const patch: PersonProfile = {};
  if (p.title !== undefined) {
    const t = p.title.trim().replace(/\s+/g, " ");
    if (t.length > PROFILE_TITLE_MAX) return { ok: false, error: `A title is at most ${PROFILE_TITLE_MAX} characters; put the rest in focus or about` };
    patch.title = t;
  }
  if (p.focus !== undefined) {
    const f = p.focus.trim().replace(/\s+/g, " ");
    if (f.length > PROFILE_FOCUS_MAX) return { ok: false, error: `Focus is one line, at most ${PROFILE_FOCUS_MAX} characters; put the rest in about` };
    patch.focus = f;
  }
  if (p.labels !== undefined) patch.labels = normalizeLabels(p.labels);
  if (p.about !== undefined) {
    const a = p.about.trim();
    if (a.length > PROFILE_ABOUT_MAX) return { ok: false, error: `About is at most ${PROFILE_ABOUT_MAX} characters` };
    patch.about = a;
  }
  return { ok: true, patch };
}

export type PersonLine = {
  name: string;
  handle?: string;
  role?: string;
  is_me?: boolean;
  title?: string;
  focus?: string;
  labels?: string[];
  reports_to?: string;
};

/** One person in one line, the short version: who, the title, what they look
 *  after, who they report to. Every session reads this at start. */
export function personShortLine(p: PersonLine): string {
  const tags = [p.role && p.role !== "member" ? p.role : "", p.is_me ? "your person" : ""].filter(Boolean);
  const who = `${p.name}${p.handle ? ` @${p.handle}` : ""}${tags.length ? ` (${tags.join(", ")})` : ""}`;
  const focus = p.focus || (p.labels?.length ? p.labels.join(", ") : "");
  return [who, p.title, focus, p.reports_to ? `reports to ${p.reports_to}` : ""].filter(Boolean).join(" · ");
}

/** The long version (`cast org person`), from orgPeople.person. */
export type PersonLong = PersonLine & {
  about?: string;
  areas: string[];
  takes_decisions: boolean;
  /** Everyone they report to, all equal (org-people.md P3). */
  reports_to: string[];
  reports: string[];
  roles: string[];
  profile_updated: { by: string; at: number } | null;
};

export function personLongLines(p: PersonLong): string[] {
  const out = [personShortLine({ ...p, reports_to: undefined })];
  if (p.labels?.length) out.push(`Labels: ${p.labels.join(", ")}`);
  out.push(`Decides for: ${p.areas.length ? p.areas.join(", ") : "no projects named"}${p.takes_decisions ? "" : " (takes no decisions)"}`);
  out.push(`Reports to: ${p.reports_to.length ? p.reports_to.join(", ") : "nobody"}`);
  if (p.reports.length || p.roles.length) out.push(`Reporting to them: ${[...p.reports, ...p.roles].join(", ")}`);
  out.push("", p.about || (p.title || p.focus
    ? "No longer description yet."
    : `No profile yet. Set one: cast org person ${p.handle ? `@${p.handle}` : `"${p.name}"`} --title "..." --focus "..." --about -`));
  if (p.profile_updated) out.push("", `Profile last changed by ${p.profile_updated.by}, ${new Date(p.profile_updated.at).toISOString().slice(0, 10)}`);
  return out;
}

/** What waits on a person who reports to a role, in that role's area
 *  (org-people.md P2): decisions in their queue past a day, the open tasks
 *  assigned to them, and of those the ones in review past a day. */
export type ReportWaits = { decisions_over_day: number; open_tasks: number; review_over_day: number };

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The waits in words, most pressing first; empty when nothing waits. */
export function reportWaitsWords(w: ReportWaits): string[] {
  return [
    w.decisions_over_day ? `${count(w.decisions_over_day, "decision")} waiting over a day` : "",
    w.review_over_day ? `${count(w.review_over_day, "task")} in review over a day` : "",
    w.open_tasks ? count(w.open_tasks, "open task") : "",
  ].filter(Boolean);
}

/** The people who report to a role, from the org tree's people rows (each
 *  carries `managers`), as short lines (org-people.md P2). */
export function roleReportLines(roleId: string, people: ReadonlyArray<PersonLine & { managers?: ReadonlyArray<{ kind: string; role_id?: unknown }> }>): string[] {
  return people
    .filter((p) => (p.managers ?? []).some((m) => m.kind === "role" && String(m.role_id) === String(roleId)))
    .map((p) => personShortLine({ ...p, is_me: false, reports_to: undefined }));
}
