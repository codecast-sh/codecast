// Reading the priority pass's reply (lib/priorityPass.ts): what of it names
// records the input shows, and what is left out and why. Pure.

import type { PriorityPassOutput, PriorityProposal, PriorityRef, PriorityRefKind, PriorityStepTier } from "@codecast/shared/contracts/priorities";
import { parseJsonBlock } from "./anthropic";
import type { PriorityPassInput } from "./priorityPass";

export function taskStatusMap(input: PriorityPassInput): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of input.step_tasks) out.set(t.short_id, t.status);
  for (const s of input.sessions) for (const t of s.tasks) out.set(t.short_id, t.status);
  return out;
}

/** Every ref the input shows, as "kind:id": a reply may point only at these. */
function knownRefs(input: PriorityPassInput): Set<string> {
  const known = new Set<string>();
  for (const t of input.step_tasks) known.add(`task:${t.short_id}`);
  for (const p of input.priorities) {
    for (const st of p.steps) for (const r of st.refs) known.add(`${r.kind}:${r.id}`);
    for (const s of p.sessions) known.add(`session:${s.id}`);
  }
  for (const s of input.sessions) {
    known.add(`session:${s.id}`);
    for (const t of s.tasks) known.add(`task:${t.short_id}`);
    for (const pr of s.prs) known.add(`pr:${pr.ref}`);
  }
  return known;
}

const REF_KINDS: PriorityRefKind[] = ["task", "session", "pr", "commit"];
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
/** The most `why` excerpts kept per priority or step, and the most characters of each. */
const WHY_MAX = 5;
const WHY_CHARS = 500;
/** A reply's `why` (asked only behind the priority cards experiment): its excerpts, as a field to spread, or nothing. */
const whyOf = (v: unknown): { why?: string[] } => {
  const why = (Array.isArray(v) ? v : []).map(str).filter((s): s is string => !!s && s.length <= WHY_CHARS).slice(0, WHY_MAX);
  return why.length ? { why } : {};
};

/**
 * The reply as a pass output, keeping only what names records the input
 * shows. Null when the reply is not a pass output at all (the caller keeps
 * its cursor). `dropped` says what was left out and why.
 *
 * A proposal naming an unknown short id becomes a new priority (a dropped
 * proposal would lose its sessions for good: the next pass reads only newer
 * work). An existing short id is claimed once, by the first proposal that
 * keeps it or merges it away; a later claim becomes a new priority for the
 * same reason. A session is listed under one priority only, and a session a
 * priority lists or a step points at is never also unassigned.
 */
export function parsePriorityPassOutput(raw: unknown, input: PriorityPassInput): { output: PriorityPassOutput | null; dropped: string[] } {
  const obj = typeof raw === "string" ? parseJsonBlock(raw) : raw;
  const dropped: string[] = [];
  if (!obj || typeof obj !== "object" || !Array.isArray((obj as any).priorities)) return { output: null, dropped: ["reply: not a pass output"] };
  const existing = new Set(input.priorities.map((p) => p.short_id));
  const setAside = new Set(input.priorities.filter((p) => p.status === "set_aside").map((p) => p.short_id));
  const personDone = new Set(input.priorities.filter((p) => p.status_set_by === "person").map((p) => p.short_id));
  const initiatives = new Set(input.initiatives.map((i) => i.short_id));
  const sessions = new Set([...input.sessions.map((s) => s.id), ...input.priorities.flatMap((p) => p.sessions.map((s) => s.id))]);
  const refs = knownRefs(input);

  const proposals: PriorityProposal[] = [];
  const claimed = new Set<string>(); // existing short ids proposed or merged away
  const mapped = new Set<string>();
  const refMapped = new Set<string>(); // sessions a step points at: the merge maps them too
  for (const [i, p] of ((obj as any).priorities as unknown[]).entries()) {
    const at = `priority ${i + 1}`;
    if (!p || typeof p !== "object") { dropped.push(`${at}: not an object`); continue; }
    const r = p as Record<string, unknown>;
    const title = str(r.title);
    const status = r.status;
    if (!title || (status !== "active" && status !== "done" && status !== "quiet")) { dropped.push(`${at}: no title or a status the pass may not set (${String(status)})`); continue; }
    let short_id = str(r.short_id) ?? undefined;
    if (short_id && !existing.has(short_id)) { dropped.push(`${at}: unknown short id ${short_id}, kept as a new priority`); short_id = undefined; }
    if (short_id && claimed.has(short_id)) { dropped.push(`${at}: ${short_id} already proposed or merged, kept as a new priority`); short_id = undefined; }
    if (short_id) claimed.add(short_id);

    const merges: string[] = [];
    for (const m of Array.isArray(r.merges) ? r.merges : []) {
      const id = str(m);
      if (!id || !existing.has(id) || id === short_id || claimed.has(id)) { dropped.push(`${at}: merge of ${String(m)} (unknown, itself or already claimed)`); continue; }
      if (setAside.has(id)) { dropped.push(`${at}: merge of ${id}, which the person set aside`); continue; }
      if (personDone.has(id)) { dropped.push(`${at}: merge of ${id}, which the person marked done`); continue; }
      claimed.add(id);
      merges.push(id);
    }
    let serves = str(r.serves);
    if (serves && !initiatives.has(serves)) { dropped.push(`${at}: serves unknown goal ${serves}`); serves = null; }

    const steps: PriorityProposal["steps"] = [];
    for (const [k, s] of (Array.isArray(r.steps) ? r.steps : []).entries()) {
      const sr = (s ?? {}) as Record<string, unknown>;
      const stepTitle = str(sr.title);
      if (!stepTitle || (sr.tier !== "critical" && sr.tier !== "polish")) { dropped.push(`${at} step ${k + 1}: no title or tier`); continue; }
      const stepRefs: PriorityRef[] = [];
      for (const ref of Array.isArray(sr.refs) ? sr.refs : []) {
        const kind = (ref as any)?.kind;
        const id = str((ref as any)?.id);
        if (!id || !REF_KINDS.includes(kind) || !refs.has(`${kind}:${id}`)) { dropped.push(`${at} step ${k + 1}: unknown ref ${String(kind)} ${String(id)}`); continue; }
        stepRefs.push({ kind, id });
        if (kind === "session") refMapped.add(id);
      }
      steps.push({
        key: str(sr.key) ?? undefined,
        title: stepTitle,
        tier: sr.tier,
        refs: stepRefs,
        ...(typeof sr.done_judged === "boolean" ? { done_judged: sr.done_judged } : {}),
        ...whyOf(sr.why),
      });
    }

    const mappedHere: PriorityProposal["sessions"] = [];
    for (const s of Array.isArray(r.sessions) ? r.sessions : []) {
      const id = str((s as any)?.session);
      if (!id || !sessions.has(id)) { dropped.push(`${at}: unknown session ${String(id)}`); continue; }
      if (mapped.has(id)) { dropped.push(`${at}: session ${id} already mapped`); continue; }
      mapped.add(id);
      const step = str((s as any)?.step);
      mappedHere.push(step ? { session: id, step } : { session: id });
    }

    const rank = Number.isInteger(r.rank) && (r.rank as number) >= 1 ? (r.rank as number) : proposals.length + 1;
    proposals.push({
      ...(short_id ? { short_id } : {}),
      title,
      summary: str(r.summary) ?? "",
      status,
      ...(merges.length ? { merges } : {}),
      serves,
      rank,
      steps,
      sessions: mappedHere,
      ...whyOf(r.why),
    });
  }

  const unassigned: PriorityPassOutput["unassigned"] = [];
  for (const u of Array.isArray((obj as any).unassigned) ? (obj as any).unassigned : []) {
    const id = str(u?.session);
    if (!id || !sessions.has(id) || (u.kind !== "standing" && u.kind !== "one_off")) { dropped.push(`unassigned: unknown session or kind ${String(id)}`); continue; }
    if (mapped.has(id) || refMapped.has(id)) { dropped.push(`unassigned: ${id} is mapped to a priority`); continue; }
    unassigned.push({ session: id, kind: u.kind });
  }
  return { output: { priorities: proposals, unassigned }, dropped };
}
