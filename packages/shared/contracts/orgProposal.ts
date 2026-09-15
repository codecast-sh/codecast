// Org proposals (docs/architecture/org-init.md O2): the machine-readable half
// of a decision `cast org init` or `cast org update` posts. The analyzer writes
// one fenced JSON block into the decision's context; `cast org apply` reads
// the block back and acts on the answer. The CLI prompt, the Convex apply
// path and both tests share this one reading of the block and of the option
// order, so an option index means the same thing everywhere.

export const ORG_PROPOSAL_FENCE = "org-proposal";

export type OrgProposalCaps = { hands_per_day?: number; wakes_per_day?: number; tokens_per_day?: number };

export type OrgProposalScope = {
  /** Project refs: a short id, an id, or a title substring unique in the workspace. */
  projects?: string[];
  /** Plan refs: pl-N or an id. */
  plans?: string[];
};

export type OrgRoleProposal = {
  kind: "role";
  name: string;
  handle: string;
  scope?: OrgProposalScope;
  /** "@handle" or "or-N" for a role, "me" or a member's name for a person; absent = the person applying. */
  reports_to?: string;
  charter?: string;
  trust?: "understand";
  caps?: OrgProposalCaps;
  /** The counts and session titles the proposal rests on; prose for the reader. */
  evidence?: string[];
};

export type OrgProjectChange =
  | { op: "create"; title: string; description?: string; project_path?: string }
  | { op: "merge"; from: string; into: string };

export type OrgProjectsProposal = { kind: "projects"; changes: OrgProjectChange[] };

export type OrgMoveProposal = {
  kind: "move";
  handle: string;
  reports_to?: string;
  scope_add?: string[];
  scope_remove?: string[];
  reason?: string;
};

export type OrgRetireProposal = { kind: "retire"; handle: string; reason?: string };

export type OrgProposal = OrgRoleProposal | OrgProjectsProposal | OrgMoveProposal | OrgRetireProposal;

export const ORG_PROPOSAL_KINDS = ["role", "projects", "move", "retire"] as const;

// ── Staffing changes (docs/architecture/org-staffing.md S4) ──────────────────
// A proposal (op-N) is a list of changes decided one by one. The four stack
// kinds above are changes too; these six are the staffing additions. One
// validator per kind, one apply order, one describer: the CLI walk, the
// server's create mutation and the ghost nodes on the org page read these.

export type OrgTrustStage = "understand" | "decide" | "direct";
export type OrgPriority = "p0" | "p1" | "p2" | "p3";

export type OrgScopeChange = { kind: "scope"; handle: string; add?: string[]; remove?: string[] };
export type OrgBudgetChange = { kind: "budget"; handle: string; caps: OrgProposalCaps };
export type OrgTrustChange = { kind: "trust"; handle: string; trust: OrgTrustStage };
export type OrgRoutineChange = { kind: "routine"; handle: string; title: string; prompt: string; every: string };
export type OrgProjectMetaChange = {
  kind: "project_meta";
  project: string;
  goal?: string;
  success_metrics?: string[];
  priority?: OrgPriority;
  /** "@handle" of the owner role. */
  owner?: string;
  non_goals?: string[];
  risks?: string[];
};
/** This session becomes the role's standing session (the analyzer offering to be the chief of staff). */
export type OrgAdoptChange = { kind: "adopt"; handle: string; conversation: string };
/** File a plan under a project (plans.project_id), so a role's scope can see it. Both are refs. */
export type OrgFileChange = { kind: "file"; plan: string; project: string };

export type OrgChange = OrgProposal | OrgScopeChange | OrgBudgetChange | OrgTrustChange | OrgRoutineChange | OrgProjectMetaChange | OrgAdoptChange | OrgFileChange;

export const ORG_CHANGE_KINDS = [...ORG_PROPOSAL_KINDS, "file", "scope", "budget", "trust", "routine", "project_meta", "adopt"] as const;
export type OrgChangeKind = OrgChange["kind"];

/** Accept order (S4): projects first, then roles (parents before children in
 *  the proposal's own order), then project charters (an owner may be a role
 *  the same proposal creates), then moves, scope, budget, trust, routines,
 *  adopt, retire. A retirement goes last so a move off the retiring role
 *  lands first; adopt goes after the role it names exists. */
export const ORG_CHANGE_APPLY_RANK: Record<OrgChangeKind, number> = {
  projects: 0, file: 1, role: 2, project_meta: 3, move: 4, scope: 5, budget: 6, trust: 7, routine: 8, adopt: 9, retire: 10,
};

/** Stable sort by apply rank; ties keep their given order. */
export function orderOrgChanges<T>(rows: T[], changeOf: (row: T) => OrgChange | null | undefined): T[] {
  const rank = (row: T) => { const c = changeOf(row); return c ? ORG_CHANGE_APPLY_RANK[c.kind] : 11; };
  return rows.map((row, i) => ({ row, i, r: rank(row) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.row);
}

const ORG_TRUST_STAGES: readonly string[] = ["understand", "decide", "direct"];
const ORG_PRIORITIES: readonly string[] = ["p0", "p1", "p2", "p3"];
const HANDLE_RE = /^[a-z0-9-]{2,32}$/;
const EVERY_RE = /^\d+(m|h|d|w)$/;

/** A routine's cadence ("7d", "12h", "30m", "2w") in milliseconds; null when it is not one. */
export function orgEveryToMs(every: string): number | null {
  const m = /^(\d+)(m|h|d|w)$/.exec((every ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2] as "m" | "h" | "d" | "w"];
  return n > 0 ? n * unit : null;
}

const nonEmpty = (x: any): x is string => typeof x === "string" && x.trim().length > 0;
const strings = (x: any): boolean => Array.isArray(x) && x.every(nonEmpty);
const optStrings = (x: any): boolean => x === undefined || strings(x);
const optString = (x: any): boolean => x === undefined || typeof x === "string";
const capsOk = (x: any): boolean => !!x && typeof x === "object" && !Array.isArray(x) &&
  ["hands_per_day", "wakes_per_day", "tokens_per_day"].every((k) => x[k] === undefined || (typeof x[k] === "number" && x[k] >= 0)) &&
  ["hands_per_day", "wakes_per_day", "tokens_per_day"].some((k) => typeof x[k] === "number");

/** Why a change is not one, or null when it is. One message, the first fault. */
export function orgChangeError(raw: any): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "a change is an object with a kind";
  if (!ORG_CHANGE_KINDS.includes(raw.kind)) return `unknown change kind ${JSON.stringify(raw.kind)}; one of ${ORG_CHANGE_KINDS.join(", ")}`;
  const handle = (): string | null => nonEmpty(raw.handle) ? (HANDLE_RE.test(raw.handle.replace(/^@/, "")) ? null : `handle ${JSON.stringify(raw.handle)} is not a-z, 0-9 and - (2 to 32 chars)`) : "handle is required";
  switch (raw.kind as OrgChangeKind) {
    case "role": case "projects": case "move": case "retire":
      return isOrgProposal(raw) ? (raw.kind === "role" ? handle() : null) : `${raw.kind} is missing its required fields`;
    case "scope": {
      const h = handle(); if (h) return h;
      if (!optStrings(raw.add) || !optStrings(raw.remove)) return "scope add and remove are lists of project or plan refs";
      if (!(raw.add?.length || raw.remove?.length)) return "scope needs at least one ref to add or remove";
      return null;
    }
    case "budget": {
      const h = handle(); if (h) return h;
      return capsOk(raw.caps) ? null : "budget caps needs at least one of hands_per_day, wakes_per_day, tokens_per_day as a non-negative number";
    }
    case "trust": {
      const h = handle(); if (h) return h;
      return ORG_TRUST_STAGES.includes(raw.trust) ? null : `trust is one of ${ORG_TRUST_STAGES.join(", ")}`;
    }
    case "routine": {
      const h = handle(); if (h) return h;
      if (!nonEmpty(raw.title) || !nonEmpty(raw.prompt)) return "routine needs a title and a prompt";
      return nonEmpty(raw.every) && EVERY_RE.test(raw.every) ? null : "routine every is a duration like 7d, 1d, 12h";
    }
    case "project_meta": {
      if (!nonEmpty(raw.project)) return "project_meta needs a project ref";
      if (!optString(raw.goal) || !optStrings(raw.success_metrics) || !optStrings(raw.non_goals) || !optStrings(raw.risks)) return "project_meta goal is a string; success_metrics, non_goals and risks are lists of strings";
      if (raw.priority !== undefined && !ORG_PRIORITIES.includes(raw.priority)) return `priority is one of ${ORG_PRIORITIES.join(", ")}`;
      if (raw.owner !== undefined && !nonEmpty(raw.owner)) return "owner is a role handle";
      if (![raw.goal, raw.success_metrics, raw.priority, raw.owner, raw.non_goals, raw.risks].some((x) => x !== undefined)) return "project_meta changes nothing";
      return null;
    }
    case "adopt": {
      const h = handle(); if (h) return h;
      return nonEmpty(raw.conversation) ? null : "adopt needs the conversation (a session short id) that becomes the role's standing session";
    }
    case "file":
      return nonEmpty(raw.plan) && nonEmpty(raw.project) ? null : "file needs a plan ref and a project ref";
  }
  return null;
}

export function isOrgChange(raw: any): raw is OrgChange { return orgChangeError(raw) === null; }

export type OrgEvidenceLink = { label: string; href?: string };

/** A change row's status (S4). `accepted` is the optimistic beat between a
 *  verdict and its apply; `failed` is a refusal the apply core returned. */
export type OrgChangeStatus = "proposed" | "accepted" | "skipped" | "applied" | "failed";

/** The statuses a person can still decide (S4): a failed change stays open
 *  so it can be retried with edits or skipped. The server's decide, acceptAll
 *  and resolve gates and the web's action rows, counts and journal all read
 *  this one set, so "still to decide" means the same thing on both sides. */
export const ORG_DECIDABLE_STATUSES: readonly OrgChangeStatus[] = ["proposed", "failed"];
export function isOrgChangeDecidable(status: string): boolean {
  return (ORG_DECIDABLE_STATUSES as readonly string[]).includes(status);
}

/** One change as the spec carries it, with the reader's side. */
export type OrgSpecChange = {
  change: OrgChange;
  rationale: string;
  evidence?: OrgEvidenceLink[];
  expected_effect?: string;
  risk?: string;
};

export type OrgProposalMode = "init" | "review" | "request";
export const ORG_PROPOSAL_MODES: readonly OrgProposalMode[] = ["init", "review", "request"];

/** The file `cast org propose --spec` reads and `orgProposals.create` stores. */
export type OrgProposalSpec = {
  title: string;
  summary_md: string;
  mode: OrgProposalMode;
  changes: OrgSpecChange[];
};

/** Validate a spec. Every fault is reported, each naming the change by index
 *  and kind, so a long spec is fixed in one pass. */
export function parseOrgProposalSpec(raw: unknown): { spec: OrgProposalSpec; errors: [] } | { spec: null; errors: string[] } {
  const errors: string[] = [];
  const r: any = raw;
  if (!r || typeof r !== "object" || Array.isArray(r)) return { spec: null, errors: ["the spec is a JSON object with title, summary_md, mode and changes"] };
  if (!nonEmpty(r.title)) errors.push("title is required");
  if (!nonEmpty(r.summary_md)) errors.push("summary_md is required: the summary a founder reads on a phone");
  if (!ORG_PROPOSAL_MODES.includes(r.mode)) errors.push(`mode is one of ${ORG_PROPOSAL_MODES.join(", ")}`);
  if (!Array.isArray(r.changes) || r.changes.length === 0) errors.push("changes is a non-empty list");
  else r.changes.forEach((c: any, i: number) => {
    const at = `changes[${i}]${c?.change?.kind ? ` (${c.change.kind})` : ""}`;
    if (!c || typeof c !== "object") { errors.push(`${at}: an object with change and rationale`); return; }
    const fault = orgChangeError(c.change);
    if (fault) errors.push(`${at}: ${fault}`);
    if (!nonEmpty(c.rationale)) errors.push(`${at}: rationale is required`);
    if (c.evidence !== undefined && !(Array.isArray(c.evidence) && c.evidence.every((e: any) => e && nonEmpty(e.label) && optString(e.href)))) errors.push(`${at}: evidence is a list of { label, href? }`);
    if (!optString(c.expected_effect) || !optString(c.risk)) errors.push(`${at}: expected_effect and risk are strings`);
  });
  if (errors.length) return { spec: null, errors };
  return {
    spec: {
      title: r.title.trim(),
      summary_md: r.summary_md,
      mode: r.mode,
      changes: r.changes.map((c: any) => ({ change: c.change, rationale: c.rationale, ...(c.evidence ? { evidence: c.evidence } : {}), ...(c.expected_effect ? { expected_effect: c.expected_effect } : {}), ...(c.risk ? { risk: c.risk } : {}) })),
    },
    errors: [],
  };
}

const at = (h: string) => `@${h.replace(/^@/, "")}`;
const list = (xs?: string[]) => (xs ?? []).join(", ");

const isPlainObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * A person's edits laid over a change (S5 "accept with edits"). Object valued
 * keys (`caps`, `scope`) merge one level deep, so editing one cap keeps the
 * others; `kind` never changes. Pure and unvalidated: the server checks the
 * result with orgChangeError before applying, the org page draws it as is.
 */
export function editedOrgChange<T extends OrgChange>(change: T, edits: unknown): T {
  if (!isPlainObject(edits)) return change;
  const merged: Record<string, unknown> = { ...change };
  for (const [k, v] of Object.entries(edits)) {
    const cur = merged[k];
    merged[k] = isPlainObject(v) && isPlainObject(cur) ? { ...cur, ...v } : v;
  }
  merged.kind = change.kind;
  return merged as T;
}

/** One line per change, the words the CLI walk and the ghost chips use. */
export function describeOrgChange(c: OrgChange): string {
  switch (c.kind) {
    case "role": return `create role ${c.name} ${at(c.handle)}${c.reports_to ? ` reporting to ${c.reports_to}` : ""}${c.scope?.projects?.length || c.scope?.plans?.length ? ` over ${list([...(c.scope.projects ?? []), ...(c.scope.plans ?? [])])}` : ""}`;
    case "projects": return c.changes.map((x) => x.op === "create" ? `create project ${x.title}` : `merge project ${x.from} into ${x.into}`).join("; ");
    case "move": return `move ${at(c.handle)}${c.reports_to ? ` under ${c.reports_to}` : ""}${c.scope_add?.length ? ` +${list(c.scope_add)}` : ""}${c.scope_remove?.length ? ` -${list(c.scope_remove)}` : ""}`;
    case "retire": return `retire ${at(c.handle)}`;
    case "scope": return `scope ${at(c.handle)}${c.add?.length ? ` +${list(c.add)}` : ""}${c.remove?.length ? ` -${list(c.remove)}` : ""}`;
    case "budget": return `budget ${at(c.handle)} ${Object.entries(c.caps).filter(([, v]) => v !== undefined).map(([k, v]) => `${k.replace("_per_day", "")} ${v}/day`).join(", ")}`;
    case "trust": return `trust ${at(c.handle)} to ${c.trust}`;
    case "routine": return `routine on ${at(c.handle)}: ${c.title} every ${c.every}`;
    case "project_meta": return `charter ${c.project}${c.owner ? ` owner ${at(c.owner)}` : ""}${c.priority ? ` ${c.priority}` : ""}${c.goal ? `: ${c.goal}` : ""}`;
    case "adopt": return `adopt session ${c.conversation} as ${at(c.handle)}'s standing session`;
    case "file": return `file plan ${c.plan} under project ${c.project}`;
  }
}

/** Option order every org proposal decision uses. The index is the verdict. */
export const ORG_PROPOSAL_OPTIONS = {
  role: ["Create as proposed", "Create with changes", "Skip"],
  projects: ["Apply as proposed", "Apply with changes", "Skip"],
  move: ["Move as proposed", "Move with changes", "Skip"],
  retire: ["Retire as proposed", "Retire with changes", "Skip"],
} as const satisfies Record<OrgProposal["kind"], readonly [string, string, string]>;

export type OrgProposalVerdict = "apply" | "apply_with_changes" | "skip";

export function orgProposalVerdict(answerIndex: number | undefined): OrgProposalVerdict | null {
  if (answerIndex === 0) return "apply";
  if (answerIndex === 1) return "apply_with_changes";
  if (answerIndex === 2) return "skip";
  return null;
}

/** Render the block the decision context carries. */
export function orgProposalBlock(proposal: OrgProposal): string {
  return "```" + ORG_PROPOSAL_FENCE + "\n" + JSON.stringify(proposal, null, 2) + "\n```";
}

const FENCE_RE = new RegExp("```" + ORG_PROPOSAL_FENCE + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```");

/** The proposal inside a decision's context, or null when there is none or it is malformed. */
export function extractOrgProposal(md: string | undefined | null): OrgProposal | null {
  const m = FENCE_RE.exec(md ?? "");
  if (!m) return null;
  let raw: any;
  try { raw = JSON.parse(m[1]); } catch { return null; }
  return isOrgProposal(raw) ? raw : null;
}

export function isOrgProposal(raw: any): raw is OrgProposal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  switch (raw.kind) {
    case "role":
      return typeof raw.name === "string" && raw.name.trim().length > 0 && typeof raw.handle === "string" && raw.handle.trim().length > 0;
    case "projects":
      return Array.isArray(raw.changes) && raw.changes.every((c: any) =>
        c && ((c.op === "create" && typeof c.title === "string" && c.title.trim()) || (c.op === "merge" && typeof c.from === "string" && typeof c.into === "string")));
    case "move":
      return typeof raw.handle === "string" && raw.handle.trim().length > 0;
    case "retire":
      return typeof raw.handle === "string" && raw.handle.trim().length > 0;
    default:
      return false;
  }
}

// "Create with changes" carries the person's text in the answer. JSON with the
// proposal's own keys overrides fields; anything else is prose and rides along
// as a note the apply path folds into the charter (a role) or the reason.
export function applyProposalChanges<T extends OrgProposal>(proposal: T, answerText: string | undefined | null): { proposal: T; note?: string } {
  const text = (answerText ?? "").trim();
  if (!text) return { proposal };
  if (text.startsWith("{")) {
    try {
      const patch = JSON.parse(text);
      if (patch && typeof patch === "object" && !Array.isArray(patch)) {
        const merged = { ...proposal, ...patch, kind: proposal.kind };
        if (isOrgProposal(merged)) return { proposal: merged as T };
      }
    } catch { /* prose that happens to open with a brace */ }
  }
  return { proposal, note: text };
}
