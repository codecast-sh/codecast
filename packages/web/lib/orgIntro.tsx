import type { AvatarKey } from "@codecast/shared/contracts/orgAvatars";

/** A line's text carries its own emphasis between double asterisks: the
 *  subject it leads with, and the one or two words that carry it. Nothing
 *  else is marked, so a person scanning sees the five parts before reading. */
export type OrgIntroLine = { face: AvatarKey; text: string };

/** S20's five sentences, in its order, each with the face that stands for it. */
export const ORG_INTRO_LINES: readonly OrgIntroLine[] = [
  { face: "fox", text: "**Roles.** Your organization has roles: agents that each keep watching one area of work, with a face, a boss, sessions that report to them and tasks they own." },
  { face: "owl", text: "**A chief of staff** reads your workspace, commits, sessions, plans and tasks, and proposes the roles it needs. You decide, and nothing changes until you **accept**." },
  { face: "bear", text: "**Only what needs you.** A role triages its own sessions and puts in front of you only what needs you, with **one line saying why**." },
  { face: "hare", text: "**Talk and hover.** You can talk to any role from its page, and hover any role anywhere to see what it looks after." },
  { face: "crane", text: "**From any session.** All of this works from any session too: type /cast-org." },
];

/** The line as plain words, emphasis marks dropped. */
export function orgIntroPlain(text: string): string {
  return text.replace(/\*\*/g, "");
}

/** The line as React: strong for the marked runs, plain text between. */
export function renderOrgIntroLine(text: string) {
  return text.split(/\*\*/).map((run, i) => (i % 2 === 1 ? <strong key={i} className="font-semibold" style={{ color: "var(--sol-text)" }}>{run}</strong> : run));
}

/** The chief of staff sits above the rail; the other four stand on it. */
export const ORG_INTRO_CHIEF: AvatarKey = "owl";

/** One name for one thing: the page is Org, the feature is the organization,
 *  so the card and this screen both say it. */
export const ORG_INTRO_TITLE = "Meet your organization";

/** How long the screen takes to leave (globals.css, org-intro-leave). */
export const ORG_INTRO_LEAVE_MS = 260;

// ---------------------------------------------------------------- seen, on the store

type SeenPrefs = { org_intro_seen?: boolean; org_upsell_seen?: boolean };

export type OrgSeenStore = { clientState: { ui?: SeenPrefs | null }; updateClientUI: (partial: SeenPrefs) => void };

/** Seeing the org page by any route sells the feature (S20): the card that
 *  introduces it elsewhere never rises afterwards. One write, only when unset. */
export function markOrgUpsellSeen(st: OrgSeenStore) {
  if (!st.clientState.ui?.org_upsell_seen) st.updateClientUI({ org_upsell_seen: true });
}

/** Either action on the first visit: seen once per person, and sold, in one
 *  write of whichever prefs are still unset. */
export function markOrgIntroSeen(st: OrgSeenStore) {
  const ui = st.clientState.ui;
  const patch: SeenPrefs = {};
  if (!ui?.org_intro_seen) patch.org_intro_seen = true;
  if (!ui?.org_upsell_seen) patch.org_upsell_seen = true;
  if (Object.keys(patch).length) st.updateClientUI(patch);
}

/** The start action's label, by whether the workspace has roles. */
export function orgIntroStartLabel(hasRoles: boolean): string {
  return hasRoles ? "Open the chart" : "Ask the chief of staff to look at my workspace";
}
