// What a template instance knows about itself between runs (org-hire.md H5,
// H6, H7): the setup list, evidence records and the scoreboard. Pure
// functions over the manifest and the receipt's state; the verbs in
// orgTemplateRun.ts hold the lock, the file and the server calls.
import { instanceReadiness, type EvidenceRecord, type HeldAuthority, type RoutineReadiness } from "@codecast/shared/contracts/orgTemplateReadiness";
import { intervalMs, type OrgTemplate } from "./orgTemplateArtifact.js";

export type EvidenceState = { status: "pass" | "fail"; observed_at: number; source: string; detail?: Record<string, string> };
export type ScoreState = { value: string; observed_at: number; source: string };
export type SetupState = { status: "open" | "done" | "skipped"; done_at?: number; evidence?: string };
export type InstanceState = {
  evidence?: Record<string, EvidenceState>;
  scoreboard?: Record<string, ScoreState>;
  setup?: Record<string, SetupState>;
  /** Authority a person granted, cached from the role row; absent until granted. */
  authority?: HeldAuthority[];
};

const href = (value: string | undefined, label: string): string => {
  if (!value || !/^(https?:\/\/|ct-\d+|pl-\d+|tr-\d+|doc:[a-z0-9]+|jx[a-z0-9]+)/i.test(value)) throw new Error(`${label} must be a link or a codecast short id a person can open`);
  return value;
};
function pairs(raw: string[] = [], label: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw) {
    const at = entry.indexOf("=");
    if (at <= 0) throw new Error(`${label} must be key=value: ${entry}`);
    out[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return out;
}

/** One record per check, replacing the last (H6). A pass without an openable source is refused. */
export function recordEvidence(manifest: OrgTemplate, state: InstanceState, check: string, input: { status: string; source?: string; detail?: string[]; now?: number }): EvidenceState {
  if (!(manifest.evidence ?? []).some((e) => e.id === check)) throw new Error(`Not an evidence check of this template: ${check}`);
  if (input.status !== "pass" && input.status !== "fail") throw new Error("--status must be pass or fail");
  const record: EvidenceState = { status: input.status, observed_at: input.now ?? Date.now(), source: href(input.source, "--source") };
  const detail = pairs(input.detail, "--detail");
  if (Object.keys(detail).length) record.detail = detail;
  (state.evidence ??= {})[check] = record;
  return record;
}

/** Scoreboard values the manifest declares, each with a source (H7). */
export function recordScores(manifest: OrgTemplate, state: InstanceState, entries: string[], input: { source?: string; observedAt?: number }): Record<string, ScoreState> {
  const declared = new Set((manifest.scoreboard ?? []).map((s) => s.key));
  const values = pairs(entries, "A scoreboard value");
  if (!Object.keys(values).length) throw new Error("Give at least one key=value");
  const source = href(input.source, "--source");
  const written: Record<string, ScoreState> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!declared.has(key)) throw new Error(`Not a scoreboard key of this template: ${key}`);
    if (!value.trim()) throw new Error(`Empty value for ${key}`);
    written[key] = (state.scoreboard ??= {})[key] = { value, observed_at: input.observedAt ?? Date.now(), source };
  }
  return written;
}

/**
 * Setup items (H5). A `role` item is the role's to mark; a `human` item is a
 * person's, so a call from an agent session is refused. Done needs evidence
 * a person can open; reopening clears it.
 */
export function markSetup(manifest: OrgTemplate, state: InstanceState, id: string, input: { status: string; evidence?: string; fromAgent: boolean; now?: number }): SetupState {
  const item = (manifest.setup ?? []).find((s) => s.id === id);
  if (!item) throw new Error(`Not a setup item of this template: ${id}`);
  if (!["open", "done", "skipped"].includes(input.status)) throw new Error("Status must be open, done or skipped");
  if (item.who === "human" && input.fromAgent) throw new Error(`${id} is a person's step: they mark it from their own terminal or the role page`);
  const next: SetupState = input.status === "done"
    ? { status: "done", done_at: input.now ?? Date.now(), evidence: item.who === "role" ? href(input.evidence, "--evidence") : input.evidence }
    : { status: input.status as "open" | "skipped" };
  (state.setup ??= {})[id] = next;
  return next;
}

export type SetupRow = { id: string; title: string; who: "human" | "role"; status: SetupState["status"]; unlocks: string[]; price?: string; how?: string; evidence?: string };
export function setupRows(manifest: OrgTemplate, state: InstanceState): SetupRow[] {
  return (manifest.setup ?? []).map((item) => ({ id: item.id, title: item.title, who: item.who, status: state.setup?.[item.id]?.status ?? "open", unlocks: item.unlocks ?? [], price: item.price, how: item.how, evidence: state.setup?.[item.id]?.evidence }));
}
/** The one ask (H5): the first open human item in the manifest's order, which is the author's value order. */
export function nextHumanAsk(manifest: OrgTemplate, state: InstanceState): SetupRow | undefined {
  return setupRows(manifest, state).find((row) => row.who === "human" && row.status === "open");
}

export function readiness(manifest: OrgTemplate, state: InstanceState, trust: "understand" | "decide" | "direct", now = Date.now()): Record<string, RoutineReadiness> {
  const evidence: EvidenceRecord[] = Object.entries(state.evidence ?? {}).map(([check, r]) => ({ check, status: r.status, observed_at: r.observed_at }));
  return instanceReadiness({
    routines: manifest.routines,
    authority: (manifest.authority ?? []).map((a) => ({ id: a.id, kind: a.kind })),
    evidence: (manifest.evidence ?? []).map((e) => ({ id: e.id, max_age_ms: intervalMs(e.max_age) })),
  }, { trust, authority: state.authority ?? [], evidence }, now);
}

/** The lines the loader prepends for a routine, so the run knows its mode and why (H6). */
export function readinessHeader(routine: string, r: RoutineReadiness | undefined): string {
  if (!r) return "";
  const lines = [`Mode now: ${r.mode}.`];
  if (r.missing.length) lines.push(`Not met for ${routine}: ${r.missing.join("; ")}.`);
  if (r.mode === "propose") lines.push("Propose mode: read, draft and report; make no external change, spend nothing, publish nothing.");
  return lines.join("\n");
}
