// Readiness of a template role's routines (docs/architecture/org-hire.md H4, H6).
// One computation, read by the CLI (instructions header, activate), the server
// (the instance row's readiness field) and the web (routine rows). No I/O.

export type ReadinessRoutine = { id: string; mode?: "propose" | "apply"; requires?: { authority?: string[]; evidence?: string[] } };
export type ReadinessAuthorityDecl = { id: string; kind: "spend" | "publish" | "write" | "connect" };
export type ReadinessEvidenceDecl = { id: string; max_age_ms: number };
export type ReadinessManifest = { routines: ReadinessRoutine[]; authority?: ReadinessAuthorityDecl[]; evidence?: ReadinessEvidenceDecl[] };

export type HeldAuthority = { id: string; expires_at?: number };
export type EvidenceRecord = { check: string; status: "pass" | "fail"; observed_at: number };
export type ReadinessState = { trust: "understand" | "decide" | "direct"; authority: HeldAuthority[]; evidence: EvidenceRecord[] };

export type RoutineReadiness = {
  ready: boolean;
  /** The mode the routine runs in now: the manifest's, lowered to propose by trust or a lapse. */
  mode: "propose" | "apply";
  /** What keeps it from ready, or from apply, in the order a person should clear it. */
  missing: string[];
};

/** Authority kinds that act on money or the public: apply mode needs trust decide or above (H4). */
const ACTING_KINDS = new Set(["spend", "publish"]);

export function routineReadiness(manifest: ReadinessManifest, routine: ReadinessRoutine, state: ReadinessState, now = Date.now()): RoutineReadiness {
  const missing: string[] = [];
  const authorityKinds = new Map((manifest.authority ?? []).map((a) => [a.id, a.kind]));
  const evidenceAges = new Map((manifest.evidence ?? []).map((e) => [e.id, e.max_age_ms]));
  const held = new Map(state.authority.map((a) => [a.id, a]));
  const latest = new Map<string, EvidenceRecord>();
  for (const record of state.evidence) {
    const seen = latest.get(record.check);
    if (!seen || record.observed_at > seen.observed_at) latest.set(record.check, record);
  }
  for (const id of routine.requires?.authority ?? []) {
    const grant = held.get(id);
    if (!grant) missing.push(`authority ${id} not granted`);
    else if (grant.expires_at !== undefined && grant.expires_at <= now) missing.push(`authority ${id} expired`);
  }
  for (const id of routine.requires?.evidence ?? []) {
    const record = latest.get(id);
    const maxAge = evidenceAges.get(id);
    if (!record || record.status !== "pass") missing.push(`evidence ${id} has no pass`);
    else if (maxAge !== undefined && now - record.observed_at > maxAge) missing.push(`evidence ${id} is ${describeAge(now - record.observed_at)} old`);
  }
  const wantsApply = routine.mode === "apply";
  const acts = (routine.requires?.authority ?? []).some((id) => ACTING_KINDS.has(authorityKinds.get(id) ?? ""));
  // Ready means activation may be offered. An unmet requirement, whether never
  // met or lapsed after activation, also lowers an apply routine to propose:
  // an active routine keeps its schedule and stops acting until it is met.
  const ready = missing.length === 0;
  let mode: "propose" | "apply" = wantsApply && ready ? "apply" : "propose";
  // The trust note lowers the mode and never stops activation being offered (H4).
  if (wantsApply && acts && state.trust === "understand") { mode = "propose"; missing.push("runs as propose: trust is understand"); }
  return { ready, mode, missing };
}

export function instanceReadiness(manifest: ReadinessManifest, state: ReadinessState, now = Date.now()): Record<string, RoutineReadiness> {
  return Object.fromEntries(manifest.routines.map((r) => [r.id, routineReadiness(manifest, r, state, now)]));
}

function describeAge(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  if (hours < 48) return `${Math.max(1, hours)} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}
