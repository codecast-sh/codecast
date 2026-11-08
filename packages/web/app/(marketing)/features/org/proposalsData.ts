import { SOL, tint } from "./model";
import type { IconKey } from "./icons";

/*
 * The proposals section's data: op-7 from Maya's Head of People, the four
 * subjects it decides, and how a set of answers reads on the card and on the
 * chart. Modelled on the app's proposal ledger (ProposalSubjectCard,
 * StagedBand, orgStaffingFixture), with the illustrative org's names.
 */

export type Sid = "platform" | "move" | "area" | "filing";
export type Verdict = "approve" | "reject";
export type Outcome = "applied" | "rejected";

export type Row = { label: string; before?: string; after: string };
export type Subject = {
  id: Sid;
  /** Verb-first; `name` is set bold inside it. */
  sentence: string;
  name: string;
  face: { k: IconKey } | { sessions: number };
  rows: Row[];
  why: string;
  evidence: string[];
  /** Applies only once the Head of Platform exists. */
  needsPlatform?: boolean;
};

export const SUBJECTS: Subject[] = [
  {
    id: "platform",
    sentence: "Hire a Head of Platform.",
    name: "Head of Platform",
    face: { k: "server rack" },
    rows: [
      { label: "Handle", after: "@platform" },
      { label: "Reports to", after: "Maya Chen" },
      { label: "Area", after: "Platform: the sync layer, the daemon, CLI releases" },
      { label: "Sessions", after: "14 report to @platform and leave Needs You" },
    ],
    why: "Platform has 14 open tasks and no owner role. Its sessions report straight to you, and three asked you for a decision this week.",
    evidence: ["14 open tasks in Platform", "3 decisions waiting", "22 sessions in ~/src/platform"],
  },
  {
    id: "move",
    sentence: "Move Release Captain under Head of Platform.",
    name: "Release Captain",
    face: { k: "rocket launch" },
    rows: [{ label: "Reports to", before: "Engineering lead", after: "Head of Platform" }],
    why: "All 9 releases this month shipped the CLI, which is platform work.",
    evidence: ["9 releases in October", "pl-61 CLI release train"],
    needsPlatform: true,
  },
  {
    id: "area",
    sentence: "Give the CMO the Pricing page project.",
    name: "CMO",
    face: { k: "billboard" },
    rows: [{ label: "Area", before: "Site, ads, social", after: "Site, ads, social, the pricing page" }],
    why: "The Pricing page project has 5 open tasks and no lead, and its last 4 sessions started from the CMO's thread.",
    evidence: ["5 open tasks in Pricing page", "4 sessions from @cmo"],
  },
  {
    id: "filing",
    sentence: "File 12 loose sessions where they belong.",
    name: "12 loose sessions",
    face: { sessions: 12 },
    rows: [
      { label: "To @platform", after: "7 sessions" },
      { label: "To @social", after: "3 sessions" },
      { label: "Done", after: "2 sessions" },
    ],
    why: "These started in your inbox this week and nothing places them.",
    evidence: ["12 sessions under no role"],
    needsPlatform: true,
  },
];

/** The revision after Maya's reply on the move. */
export const REPLY_TEXT = "Keep Release under Eng until 2.0 ships.";
export const REVISED: Subject = {
  id: "move",
  sentence: "Give Head of Platform a daily Release check.",
  name: "Head of Platform",
  face: { k: "server rack" },
  rows: [{ label: "Routine", after: "Release check, daily at 9:00" }],
  why: "You asked to keep Release under Eng until 2.0 ships. A daily check lets Platform watch the releases from where it sits.",
  evidence: ["9 releases in October"],
  needsPlatform: true,
};
export const REVISION_NOTE = { removed: "Move Release Captain under Head of Platform", added: "Release check routine for @platform" };

export type State = {
  answers: Partial<Record<Sid, Verdict>>;
  outcome: Partial<Record<Sid, Outcome>>;
  revised: boolean;
  /** Bumped on each send, so freshly applied nodes replay their entrance. */
  sends: number;
};
export const START: State = { answers: {}, outcome: {}, revised: false, sends: 0 };

export const subjectsOf = (s: State) => SUBJECTS.map((x) => (x.id === "move" && s.revised ? REVISED : x));

const platformReady = (s: State) => s.outcome.platform === "applied" || s.answers.platform === "approve";
/** An approval the next send would apply: a dependent waits on the hire. */
export const willApply = (s: State, id: Sid) => s.answers[id] === "approve" && (!SUBJECTS.find((x) => x.id === id)!.needsPlatform || platformReady(s));

export function send(s: State): State {
  const outcome = { ...s.outcome };
  const answers: State["answers"] = {};
  for (const x of SUBJECTS) {
    const a = s.answers[x.id];
    if (!a) continue;
    if (a === "reject") outcome[x.id] = "rejected";
    else if (willApply(s, x.id)) outcome[x.id] = "applied";
    else answers[x.id] = a; // still waits on the hire
  }
  // A rejected hire takes the work that needed it off the table.
  if (outcome.platform === "rejected") for (const x of SUBJECTS) if (x.needsPlatform && !outcome[x.id]) { outcome[x.id] = "rejected"; delete answers[x.id]; }
  return { ...s, answers, outcome, sends: s.sends + 1 };
}

export function counts(s: State) {
  const open = SUBJECTS.filter((x) => !s.outcome[x.id]);
  const apply = open.filter((x) => willApply(s, x.id)).length;
  const answers = open.filter((x) => s.answers[x.id] === "reject").length;
  const staged = open.filter((x) => s.answers[x.id]).length;
  const applied = SUBJECTS.filter((x) => s.outcome[x.id] === "applied").length;
  const rejected = SUBJECTS.filter((x) => s.outcome[x.id] === "rejected").length;
  return { open: open.length, apply, answers, staged, applied, rejected, undecided: open.length - staged };
}

/** The meta line under the title: what waits, or what happened. */
export function metaWords(s: State): string {
  const c = counts(s);
  const done = [c.applied && `${c.applied} applied`, c.rejected && `${c.rejected} rejected`].filter(Boolean).join(", ");
  if (c.open === 0) return done;
  const left = c.staged ? `${c.undecided} of ${c.open} to decide` : `${c.open} to decide`;
  const stagedApprove = c.staged - c.answers;
  const tail = [stagedApprove && `${stagedApprove} approved`, c.answers && `${c.answers} rejected`].filter(Boolean).join(", ");
  return [c.undecided ? left : null, tail || null, done || null].filter(Boolean).join(" · ") || left;
}

export function trayWords(s: State): string | null {
  const c = counts(s);
  if (!c.staged) return null;
  const ch = c.apply ? `${c.apply} ${c.apply === 1 ? "change" : "changes"} will apply when you send` : "Nothing applies yet";
  const an = c.answers ? `, and ${c.answers} ${c.answers === 1 ? "answer goes" : "answers go"} with them` : "";
  return ch + an;
}

// ---- Look ------------------------------------------------------------------

export const VIOLET = SOL.violet;
export const GHOST_FILL = tint(VIOLET, 7);
export const GHOST_EDGE = tint(VIOLET, 45);
export const GREEN_WASH = tint(SOL.green, 10);
export const RED_WASH = tint(SOL.red, 8);

export const PROPOSALS_STYLE = `
.og-prop-node { transition: left .7s var(--og-ease), top .7s var(--og-ease), opacity .5s ease, transform .5s var(--og-ease), border-color .4s ease, background-color .4s ease, box-shadow .2s ease; }
.og-prop-node[data-mode="gone"] { opacity: 0; transform: scale(.94); pointer-events: none; }
.og-prop-line { transition: opacity .5s ease, stroke .4s ease; }
.og-prop-land { animation: og-pop .55s cubic-bezier(.3,1.4,.5,1) both; }
.og-prop-in { animation: og-prop-in .18s cubic-bezier(.2,.8,.2,1) both; }
@keyframes og-prop-in { from { opacity: 0; transform: translateY(-4px) scale(.98); } to { opacity: 1; transform: none; } }
.og-prop-subject { transition: background-color .15s ease; }
.og-prop-caret { animation: og-prop-blink 1s steps(1) infinite; }
@keyframes og-prop-blink { 50% { opacity: 0; } }
.og-root[data-static] .og-prop-land, .og-root[data-static] .og-prop-in { animation: none; }
@media (prefers-reduced-motion: reduce) {
  .og-prop-land, .og-prop-in, .og-prop-caret { animation: none; }
  .og-prop-node, .og-prop-line, .og-prop-subject { transition: none; }
}
`;
