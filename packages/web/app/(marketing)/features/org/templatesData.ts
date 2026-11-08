import type { IconKey } from "./icons";

/*
 * The hire gallery's catalog, read from the real manifests
 * (~/src/platform/packs/*\/org-template.json and packages/cli/org-templates/line):
 * names, versions, descriptions, routine titles and cadences, and the counts of
 * what each asks for. "Answers" are the form's non-secret inputs; "must" are
 * the required ones with no default. Permissions are the manifest's authority
 * grants by kind. Setup counts only the steps whose `who` is a person.
 */

export type Every = "1h" | "2h" | "4h" | "6h" | "1d" | "2d" | "3d" | "7d" | "30d";
export type Mode = "acts" | "proposes" | "reads";
/** `onChange`: fires only when a watch that runs at `every` sees something change. */
export type Routine = { title: string; every: Every; mode: Mode; onChange?: boolean };
export type PermKind = "spend" | "publish" | "write" | "connect";

export type Hire = {
  id: string;
  name: string;
  handle: string;
  k: IconKey;
  builtin?: boolean;
  version?: string;
  line: string;
  routines: Routine[];
  answers: number;
  must: number;
  secrets: string[];
  perms: Partial<Record<PermKind, number>>;
  /** Setup steps only a person can do (what the product counts). */
  setup: number;
  /** Every setup step in the manifest, the role's own included. */
  setupAll: number;
  /** The first setup steps only a person can do, in the manifest's order. */
  steps: string[];
  /** Where the role sits once seated. */
  seat: string;
};

export const HOURS: Record<Every, number> = { "1h": 1, "2h": 2, "4h": 4, "6h": 6, "1d": 24, "2d": 48, "3d": 72, "7d": 168, "30d": 720 };

export const cadenceWords = (e: Every): string =>
  ({ "1h": "hourly", "2h": "every 2h", "4h": "every 4h", "6h": "every 6h", "1d": "daily", "2d": "every 2 days", "3d": "every 3 days", "7d": "weekly", "30d": "every 30 days" })[e];

/** Runs in a 168-hour week (a 30-day routine counts as the one it may land in). */
export const perWeek = (e: Every): number => Math.max(1, Math.round(168 / HOURS[e]));

const r = (title: string, every: Every, mode: Mode = "acts"): Routine => ({ title, every, mode });

export const HIRES: Hire[] = [
  {
    id: "head-of-people", name: "Head of People", handle: "@head-of-people", k: "org chart", builtin: true,
    line: "Keeps the structure true to how the work runs. Reviews the company weekly and proposes; a person decides.",
    routines: [r("Company review", "7d", "proposes"), r("Look at the inbox, only on days with loose sessions", "1d", "proposes"), r("Check its area", "1d", "reads"), { title: "An area needs your review", every: "6h", mode: "proposes", onChange: true }],
    answers: 0, must: 0, secrets: [], perms: {}, setup: 0, setupAll: 0, steps: [],
    seat: "Reports to you. Runs its first review at once.",
  },
  {
    id: "executive-assistant", name: "Executive Assistant", handle: "@executive-assistant", k: "briefcase", builtin: true,
    line: "Answers anything you ask about any part of the work, routes requests to the lead, and brings you decisions with a recommendation.",
    routines: [],
    answers: 0, must: 0, secrets: [], perms: {}, setup: 0, setupAll: 0, steps: [],
    seat: "Yours, across every workspace you are in. Pinned in your header.",
  },
  {
    id: "on-call", name: "On-call Engineer", handle: "@app-oncall", k: "warning triangle", version: "1.3.0",
    line: "Triages every new production error against the deploy that caused it, pages you for real incidents, and writes the postmortem.",
    routines: [r("Triage new, regressed and escalating errors", "1h"), r("Write the postmortem for a resolved incident", "1d", "reads"), r("Weekly reliability review", "7d", "reads")],
    answers: 11, must: 0,
    secrets: ["Sentry token", "Uptime monitor key", "GitHub token", "Deploy log token", "Rollback token", "PagerDuty routing key"],
    perms: { write: 4, connect: 1 }, setup: 9, setupAll: 10,
    steps: ["Write your severity levels and what pages at night", "Create a Sentry integration and bind its token", "Connect the uptime monitor and confirm it pages your phone"],
    seat: "Reports to the Engineering Lead of App.",
  },
  {
    id: "release-captain", name: "Release Captain", handle: "@app-captain", k: "rocket launch", version: "1.3.0",
    line: "Merges approved, green pull requests in a safe order, ships a weekly release with notes, and checks each deploy.",
    routines: [r("Merge pass", "4h"), r("Deploy health check", "1d"), r("Stale pull request sweep", "3d"), r("Cut, note and ship the weekly release", "7d")],
    answers: 5, must: 0,
    secrets: ["GitHub App id", "GitHub App private key", "Deploy provider token", "Sentry token"],
    perms: { write: 1, publish: 2 }, setup: 9, setupAll: 12,
    steps: ["Create the captain's GitHub App and install it", "Protect the base branch", "Check the release window and release checks"],
    seat: "Reports to the Engineering Lead of App.",
  },
  {
    id: "eng-lead", name: "Engineering Lead", handle: "@app-eng", k: "terminal window", version: "1.3.0",
    line: "Triages new issues within a day, keeps a short queue of small tasks for the line, and reviews every pull request.",
    routines: [r("Review pull requests at their current head", "4h"), r("Triage new issues and prune the backlog", "1d"), r("Shape the ready queue for the line", "1d"), r("Weekly engineering review", "7d", "reads")],
    answers: 14, must: 0, secrets: [],
    perms: { write: 2, publish: 1 }, setup: 4, setupAll: 6,
    steps: ["Install the codecast GitHub app on the repository", "Import the issue tracker with automatic starts off", "Optional: protect the default branch"],
    seat: "Becomes the lead of App, reporting to you.",
  },
  {
    id: "growth", name: "CMO", handle: "@app-cmo", k: "billboard", version: "2.4.2",
    line: "Sets positioning and measurement, then runs search, paid ads, social and the blog inside the budget you grant.",
    routines: [r("Paid search health and measurement", "1d"), r("Social reconciliation", "2d"), r("Search health and discovery", "7d"), r("Evidence-led content review", "7d"), r("Portfolio and access review", "7d", "reads")],
    answers: 21, must: 2, secrets: ["Google Ads API credentials", "Publora API key"],
    perms: { spend: 1, publish: 1, write: 1 }, setup: 7, setupAll: 9,
    steps: ["Verify the domain in Google Search Console", "Reveal the Google Ads developer token", "Connect the brand accounts in Publora"],
    seat: "Leads Growth, reporting to you.",
  },
  {
    id: "quality-lead", name: "Quality Lead", handle: "@app-quality", k: "clipboard check", version: "1.3.0",
    line: "Keeps main green and trusted, checks critical flows on production, and turns every escaped bug into a test.",
    routines: [r("Critical flows on production", "6h"), r("Main health, flakes and quarantine", "1d"), r("Escaped bugs become regression tests", "7d"), r("AI feature evals against the baseline", "7d"), r("Quality review", "7d", "reads")],
    answers: 20, must: 0,
    secrets: ["Synthetic account login", "GitHub token", "Sentry token", "Checkly key", "Stripe read key", "Model API key"],
    perms: { write: 3, connect: 2, spend: 1 }, setup: 9, setupAll: 13,
    steps: ["Create a GitHub token for the repository and bind it", "Confirm the critical flows the role drafted", "Create the synthetic production account"],
    seat: "Reports to the Engineering Lead of App.",
  },
  {
    id: "security-lead", name: "Security Lead", handle: "@app-security", k: "padlock", version: "1.3.0",
    line: "Ranks advisories by what is exploited and reachable, keeps dependencies current, and reviews every push for secrets.",
    routines: [r("Secret scan and risky change review", "6h"), r("Advisory triage and fix PRs", "1d"), r("Grouped dependency upgrades", "7d"), r("Weekly risk list and the one open ask", "7d"), r("Access, token and expiry review", "30d", "proposes")],
    answers: 16, must: 0, secrets: ["GitHub token", "GitHub App key", "Cloudflare read token"],
    perms: { write: 3 }, setup: 9, setupAll: 11,
    steps: ["Turn on Dependabot alerts and secret scanning", "Give the role its GitHub credential", "Name who approves security PRs"],
    seat: "Reports to the Engineering Lead of App.",
  },
  {
    id: "support-lead", name: "Support Lead", handle: "@app-support", k: "customer check", version: "1.3.0",
    line: "Answers the support mailbox from the product's code and docs, as drafts you send until you allow it to send.",
    routines: [r("Support inbox pass", "2h"), r("Tell customers when their bug is fixed and live", "1d"), r("Repeat questions become help pages", "7d"), r("Support weekly", "7d", "proposes")],
    answers: 14, must: 1, secrets: ["Gmail sign-in", "Stripe read key", "Sentry read token"],
    perms: { publish: 1, write: 1, connect: 1 }, setup: 7, setupAll: 10,
    steps: ["Sign in to the support mailbox for the role", "Finish the support policy the role started", "Later: let it send replies on its own"],
    seat: "Leads Support, reporting to you.",
  },
  {
    id: "line", name: "Flow lead", handle: "@app-line", k: "funnel", version: "1.2.0",
    line: "Owns one project's flow: grounds the causes its finders raise in the project's goals and runs the weekly lessons.",
    routines: [r("Finder health", "1d"), r("Expectations", "1d"), r("Weekly fix loop", "7d"), r("Weekly lessons", "7d")],
    answers: 1, must: 0, secrets: [], perms: {}, setup: 0, setupAll: 1, steps: [],
    seat: "Reports to the Engineering Lead of App.",
  },
];

export const DEFAULT_HIRE = "on-call";
export const PERM_KINDS: PermKind[] = ["spend", "publish", "write", "connect"];
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
