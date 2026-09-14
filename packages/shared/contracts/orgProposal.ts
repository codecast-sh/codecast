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
