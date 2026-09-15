// The staffing pane's arithmetic (docs/architecture/org-staffing.md S5), pure
// so the tests pin it without a DOM: which mode the pane is in, how far a
// proposal is decided, the one line a change reads as, the company's flags
// with the node each one points at, span of control per person, and the roles
// that are bottlenecks. The pane renders these; it computes nothing itself.
import { PERSON_SPAN } from "@codecast/shared/contracts/orgCapacity";
import { describeOrgChange, orderOrgChanges } from "@codecast/shared/contracts/orgProposal";
import type { OrgRole, OrgTree } from "./orgTypes";
import { parentNodeId } from "./orgLayout";
import {
  CHIEF_OF_STAFF_HANDLE,
  type HealthFlag,
  type OrgChange,
  type OrgChangeStatus,
  type OrgHealth,
  type OrgProposalChange,
  type OrgProposalRow,
} from "./orgStaffingTypes";

// ---------------------------------------------------------------- mode

export type StaffingMode = "proposal" | "health" | "no_chief";

/** The chief of staff, when hired: a live role with the reserved handle. */
export function findChiefOfStaff(tree: OrgTree | null): OrgRole | null {
  return tree?.roles.find((r) => r.handle === CHIEF_OF_STAFF_HANDLE && r.status !== "retired") ?? null;
}

/** Open proposals, newest first. */
export function openProposals(rows: OrgProposalRow[]): OrgProposalRow[] {
  return rows.filter((p) => p.status === "open").sort((a, b) => b.created_at - a.created_at);
}

/** What the pane shows (S5): a proposal when one is open, else the health
 *  summary, else, with no chief of staff at all, the two hire buttons. */
export function staffingMode(tree: OrgTree | null, proposal: OrgProposalRow | null): StaffingMode {
  if (proposal) return "proposal";
  return findChiefOfStaff(tree) ? "health" : "no_chief";
}

// ---------------------------------------------------------------- progress

export type ProposalProgress = { decided: number; total: number; remaining: number; applied: number; skipped: number; failed: number };

/** "N of M decided": everything that is no longer `proposed` counts. */
export function proposalProgress(p: Pick<OrgProposalRow, "changes">): ProposalProgress {
  const total = p.changes.length;
  let decided = 0, applied = 0, skipped = 0, failed = 0;
  for (const c of p.changes) {
    if (c.status !== "proposed") decided += 1;
    if (c.status === "applied") applied += 1;
    if (c.status === "skipped") skipped += 1;
    if (c.status === "failed") failed += 1;
  }
  return { decided, total, remaining: total - decided, applied, skipped, failed };
}

/** The changes still waiting on a verdict, in apply order. */
export function remainingChanges(p: Pick<OrgProposalRow, "changes">): OrgProposalChange[] {
  return orderChanges(p.changes.filter((c) => c.status === "proposed"));
}

/** Changes in the order accept all applies them (S4), seq inside a kind. */
export function orderChanges(changes: OrgProposalChange[]): OrgProposalChange[] {
  return orderOrgChanges([...changes].sort((a, b) => a.seq - b.seq), (c) => c.change);
}

/** The change list grouped by kind, groups in apply order, empty kinds dropped. */
export function groupChanges(changes: OrgProposalChange[]): { kind: OrgChange["kind"]; label: string; changes: OrgProposalChange[] }[] {
  const ordered = orderChanges(changes);
  const out: { kind: OrgChange["kind"]; label: string; changes: OrgProposalChange[] }[] = [];
  for (const c of ordered) {
    const last = out[out.length - 1];
    if (last && last.kind === c.change.kind) last.changes.push(c);
    else out.push({ kind: c.change.kind, label: KIND_LABEL[c.change.kind], changes: [c] });
  }
  return out;
}

export const KIND_LABEL: Record<OrgChange["kind"], string> = {
  projects: "Projects",
  role: "Roles",
  move: "Moves",
  scope: "Scope",
  budget: "Budget",
  trust: "Trust",
  routine: "Routines",
  project_meta: "Charters",
  adopt: "Adopt",
  retire: "Retire",
};

// ---------------------------------------------------------------- one line per change

/** The one line a change reads as in the list: the shared describer (the
 *  words the CLI walk and the ghost chips use), sentence cased. */
export function changeLine(change: OrgChange): string {
  const line = describeOrgChange(change);
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** The handle a change acts on, when it names one. */
export function changeHandle(change: OrgChange): string | null {
  return "handle" in change ? change.handle : null;
}

export const CHANGE_STATUS_META: Record<OrgChangeStatus, { label: string; color: string }> = {
  proposed: { label: "proposed", color: "var(--sol-violet)" },
  accepted: { label: "accepted", color: "var(--sol-cyan)" },
  applied: { label: "applied", color: "var(--sol-green)" },
  skipped: { label: "skipped", color: "var(--sol-text-dim)" },
  failed: { label: "failed", color: "var(--sol-red)" },
};

/** The layout node a change focuses when its subject already exists on the
 *  chart. A change whose subject is still a ghost has none: the page focuses
 *  the ghost through orgFocusChangeId instead. */
export function changeNodeId(change: OrgChange, tree: OrgTree | null): string | null {
  const handle = changeHandle(change);
  if (!handle || !tree) return null;
  const role = tree.roles.find((r) => r.handle === handle && r.status !== "retired");
  return role ? parentNodeId({ kind: "role", role_id: role._id }) : null;
}

// ---------------------------------------------------------------- health

export type FlagSubject =
  | { kind: "role"; role_id: string; handle: string; nodeId: string }
  | { kind: "person"; user_id: string; name: string; nodeId: string }
  | { kind: "company" };

export type HealthFlagRow = { id: string; flag: HealthFlag; subject: FlagSubject };

const SEVERITY_RANK = { blocker: 0, warn: 1, info: 2 } as const;

/** Every flag org.health raised, worst first, each with the node it points at. */
export function collectHealthFlags(health: OrgHealth | null, tree: OrgTree | null): HealthFlagRow[] {
  if (!health) return [];
  const out: HealthFlagRow[] = [];
  for (const r of health.roles) {
    for (const [i, flag] of r.flags.entries()) out.push({ id: `r:${r.role_id}:${i}`, flag, subject: { kind: "role", role_id: r.role_id, handle: r.handle, nodeId: parentNodeId({ kind: "role", role_id: r.role_id }) } });
  }
  for (const p of health.people) {
    const name = tree?.people.find((x) => x.user_id === p.user_id)?.name ?? "person";
    for (const [i, flag] of p.flags.entries()) out.push({ id: `p:${p.user_id}:${i}`, flag, subject: { kind: "person", user_id: p.user_id, name, nodeId: parentNodeId({ kind: "user", user_id: p.user_id }) } });
  }
  for (const [i, flag] of health.company.flags.entries()) out.push({ id: `c:${i}`, flag, subject: { kind: "company" } });
  return out.sort((a, b) => SEVERITY_RANK[a.flag.severity] - SEVERITY_RANK[b.flag.severity]);
}

export type SpanRow = { user_id: string; name: string; nodeId: string; direct_roles: number; limit: number; wide: boolean };

/** Span of control per person: direct roles against the model's limit. Reads
 *  the tree when health has no row for a person, so the summary is complete. */
export function spanOfControl(health: OrgHealth | null, tree: OrgTree | null): SpanRow[] {
  if (!tree) return [];
  const limit = PERSON_SPAN.direct_roles.value;
  return tree.people.map((p) => {
    const fromHealth = health?.people.find((h) => h.user_id === p.user_id)?.direct_roles;
    const direct = fromHealth ?? tree.roles.filter((r) => r.status !== "retired" && r.reports_to.kind === "user" && r.reports_to.user_id === p.user_id).length;
    return { user_id: p.user_id, name: p.name, nodeId: parentNodeId({ kind: "user", user_id: p.user_id }), direct_roles: direct, limit, wide: direct > limit };
  }).sort((a, b) => b.direct_roles - a.direct_roles);
}

export type BottleneckRow = { role_id: string; handle: string; nodeId: string; worst: HealthFlag["severity"]; flags: HealthFlag[] };

/** Roles carrying a warn or blocker flag, worst first. */
export function bottleneckRoles(health: OrgHealth | null): BottleneckRow[] {
  if (!health) return [];
  const out: BottleneckRow[] = [];
  for (const r of health.roles) {
    const flags = r.flags.filter((f) => f.severity !== "info");
    if (flags.length === 0) continue;
    const worst = flags.some((f) => f.severity === "blocker") ? "blocker" : "warn";
    out.push({ role_id: r.role_id, handle: r.handle, nodeId: parentNodeId({ kind: "role", role_id: r.role_id }), worst, flags });
  }
  return out.sort((a, b) => SEVERITY_RANK[a.worst] - SEVERITY_RANK[b.worst] || b.flags.length - a.flags.length);
}

export const SEVERITY_COLOR: Record<HealthFlag["severity"], string> = {
  blocker: "var(--sol-red)",
  warn: "var(--sol-orange)",
  info: "var(--sol-text-dim)",
};

/** A short label for a flag code, for badges. */
export const FLAG_LABEL: Record<HealthFlag["code"], string> = {
  overloaded: "overloaded",
  wide_span: "wide span",
  idle: "idle",
  slow_to_recommend: "slow to recommend",
  review_stall: "review stall",
  cap_hit: "cap hit",
  unowned: "unowned",
  no_charter: "no charter",
  chatter: "chatter",
};

/** The `?proposal=` value a URL carries: "op-N", else null. */
export function proposalParam(search: string | null | undefined): string | null {
  if (!search) return null;
  try {
    const v = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("proposal");
    return v && /^op-\d+$/i.test(v) ? v.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The proposal a URL asked for, by short id, else the newest open one. */
export function pickProposal(rows: OrgProposalRow[], shortId: string | null): OrgProposalRow | null {
  if (shortId) {
    const hit = rows.find((p) => p.short_id === shortId);
    if (hit) return hit;
  }
  return openProposals(rows)[0] ?? null;
}

// ---------------------------------------------------------------- inline edit

export type ChangeField = { key: string; label: string; kind: "text" | "number" | "list"; value: string };

/** The editable fields of a change, flattened one level ("caps.tokens_per_day")
 *  so the inline form (S5: Edit on anything but a role) is one input per field.
 *  `kind` is not editable; a change stays what it is. */
export function changeFields(change: OrgChange): ChangeField[] {
  const out: ChangeField[] = [];
  const push = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) out.push({ key, label: key.replace(/[._]/g, " "), kind: "list", value: v.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(", ") });
    else if (typeof v === "number") out.push({ key, label: key.replace(/[._]/g, " "), kind: "number", value: String(v) });
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) push(`${key}.${k}`, x);
    else out.push({ key, label: key.replace(/[._]/g, " "), kind: "text", value: String(v) });
  };
  for (const [k, v] of Object.entries(change)) if (k !== "kind") push(k, v);
  return out;
}

/** The edits a form produced, as the nested object `decide` takes: only the
 *  fields whose text changed, parsed back to their kind. Empty when nothing did. */
export function changeEdits(change: OrgChange, fields: ChangeField[]): Record<string, unknown> {
  const original = changeFields(change);
  const edits: Record<string, unknown> = {};
  for (const f of fields) {
    const was = original.find((o) => o.key === f.key);
    if (was && was.value === f.value) continue;
    const value = f.kind === "number" ? Number(f.value) : f.kind === "list" ? f.value.split(",").map((s) => s.trim()).filter(Boolean) : f.value;
    if (f.kind === "number" && Number.isNaN(value)) continue;
    const path = f.key.split(".");
    let cur: Record<string, unknown> = edits;
    for (const p of path.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
    cur[path[path.length - 1]] = value;
  }
  return edits;
}

/** The `?compose=` text a URL carries for the chief of staff's composer (a
 *  charter empty state links here with "draft a charter for X"), else null. */
export function composeParam(search: string | null | undefined): string | null {
  if (!search) return null;
  try {
    const v = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("compose");
    const text = v?.trim() ?? "";
    return text ? text : null;
  } catch {
    return null;
  }
}
