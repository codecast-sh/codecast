// The current round of a run whose round routes on its branches' own results (ownRound.ts: the personal Ship), as one
// view every surface reads: the journey, the diagram, a station's panel and the run report. A run row keeps one entry
// per station, its latest visit, and a fan-out's script branch is reported only when it ends, so an entry alone does
// not say which round it is from. The rule, once, here:
//
// - The round started when the station that opens it (the one the start leads to: Round) last started.
// - An entry counts for this round only if it is running, or it completed after that; a reviewer's pin counts only
//   when its `round` is the nonce the round printed. A station a run enters once (Find check) counts in every round.
// - Inside the fan-out, a branch with no entry of this round runs (its script reports only when it ends).
// - What a station found is its result: pass or ship is done, skipped is nothing, fail or changes goes back to the
//   session (or stops a run that ended there), rejected stops.
// - While the session's own fix station runs, the station that sent it the work is back.
// - The change landed at the latest Land result that says so (landed, or pushed and not recorded), in any round: a later
//   landing shows its own sha.
//
// Pure, with relative imports only: the phone reads it through the journey and the diagram.
import { stationResult, type StationResult } from "./stationResult";
import { roundsOnOwnResults } from "./ownRound";

/** `unknown`: it may or may not have done its work, and the run stopped to say so (Land at Landing unknown: the push's
 *  answer was lost and origin could not be read). Neither failed nor done. */
export type RoundState = "idle" | "running" | "done" | "failed" | "back" | "stopped" | "nothing" | "unknown";
export type RoundStation = {
  state: RoundState; result: StationResult | null; note: string | null;
  /** What the run's end says in place of a station's own words: a station that reported live on a run that ended short
   *  of Live (Deployed, unverified), one whose way out left the run (Left the run), or a Land that pushed though the run
   *  stopped after it (Landing not recorded, Land cut off), which says `landed`. No surface calls the first live, the
   *  second failed, or the third stopped. */
  endSays?: { end: string; why: string | null };
};

type Graph = { own_results?: boolean; source?: string | null; nodes: ReadonlyArray<{ id: string; type?: string; label?: string; backend?: string; fold?: boolean; stop?: string }>; edges: ReadonlyArray<{ from: string; to: string; label?: string; condition?: string }> };
type Entry = { node_id: string; status: string; result_preview?: string | null; started_at?: number; completed_at?: number };
type Run = { status: string; current_node_id?: string | null; node_statuses?: ReadonlyArray<Entry> | null };

export type RoundView = {
  /** When the round started: Round's latest start. */
  start: number;
  /** The round's nonce, from Round's own JSON, once it has printed it. */
  nonce: string | null;
  /** Where the run stands while it goes on. */
  current: string | null;
  /** The session's fix station running now, and the station that sent it the work. */
  fixing: { station: string; from: string | null } | null;
  /** The sha the change landed at, from the latest Land result that says so. */
  landed: string | null;
  /** A station's state in this round. */
  station: (id: string) => RoundStation;
  /** Whether a station's entry belongs to this round. */
  ofRound: (id: string) => boolean;
  /** Each bookkeeping station a station finishes its work with (Landed for Land, Left for you for Deploy, Verdicts for
   *  the fan-out): while it runs, that station is still at work. */
  tailOf: Record<string, string>;
};

const IDLE: RoundStation = { state: "idle", result: null, note: null };
/** The personal Ship's ends for a landing that may have happened (personal.cast `unknown` from Land, `unknown_cut` from
 *  a Land its station cut off; both "Landing unknown"). */
const UNKNOWN_ENDS = new Set(["unknown", "unknown_cut"]);
/** The sha an entry says it landed: a Land result (or the bookkeeping that read a cut-off Land's markers) that landed, or
 *  pushed and could not record it (unrecorded): the change is on main either way. */
const landingOf = (n: Entry | undefined): string | null => {
  const sha = n && ["landed", "unrecorded"].includes(stationResult(n.result_preview)?.outcome ?? "") ? jsonOf(n.result_preview)?.sha : null;
  return typeof sha === "string" && sha ? sha : null;
};
/** The JSON object a text is, or leads with on its first line; null for any other text. */
export function jsonOf(text: string | null | undefined): Record<string, any> | null {
  const t = text?.trim();
  if (!t?.startsWith("{")) return null;
  for (const body of [t, t.split("\n")[0]]) { try { const o = JSON.parse(body); if (o && typeof o === "object" && !Array.isArray(o)) return o; } catch { /* the next */ } }
  return null;
}

/** The current round's view of a run, or null for a flow whose round routes on a verdicts step (every other flow). */
export function personalRound(graph: Graph, run: Run | null | undefined): RoundView | null {
  if (!run || !roundsOnOwnResults(graph)) return null;
  const statuses = run.node_statuses ?? [];
  const entryOf = (id: string) => statuses.filter((n) => n.node_id === id).reduce<Entry | undefined>((best, n) => (!best || (n.started_at ?? 0) >= (best.started_at ?? 0) ? n : best), undefined);
  const live = run.status === "running" || run.status === "paused" || run.status === "pending";
  const failedRun = run.status === "failed";
  const start = graph.nodes.find((n) => n.type === "start");
  const opener = start ? graph.edges.find((e) => e.from === start.id)?.to ?? null : null;
  const openEntry = opener ? entryOf(opener) : undefined;
  const roundStart = openEntry?.started_at ?? 0;
  const nonce = openEntry?.status === "completed" ? (typeof jsonOf(openEntry.result_preview)?.round === "string" ? jsonOf(openEntry.result_preview)!.round : null) : null;
  const fans = graph.nodes.filter((n) => n.type === "parallel_fanout" && !n.id.includes("__")).map((n) => n.id);
  const branchOf = new Map(graph.edges.filter((e) => fans.includes(e.from)).map((e) => [e.to, e.from]));
  const current = live ? run.current_node_id ?? null : null;
  const inFan = (branch: string) => !!current && (current === branchOf.get(branch) || branchOf.get(current) === branchOf.get(branch));
  const subject = (id: string | null) => !!id && graph.nodes.find((n) => n.id === id)?.backend === "subject";
  const sourceOf = (fix: string) => graph.edges.filter((e) => e.to === fix && !subject(e.from) && !!entryOf(e.from)).map((e) => e.from)
    .sort((a, b) => (entryOf(b)!.started_at ?? 0) - (entryOf(a)!.started_at ?? 0))[0] ?? null;
  let fixing = subject(current) ? { station: current!, from: sourceOf(current!) } : null;
  // A step only the session's fixes lead to (After the fix, Read the fix) checks the newest fix: the station that sent
  // the work is at work again.
  const ins = current ? graph.edges.filter((e) => e.to === current) : [];
  const fixedBy = !fixing && ins.length > 0 && ins.every((e) => subject(e.from))
    ? ins.map((e) => e.from).filter((f) => entryOf(f)).sort((a, b) => (entryOf(b)!.started_at ?? 0) - (entryOf(a)!.started_at ?? 0))[0] : undefined;
  // A fix that failed (it could not be frozen) is still the session's: the station that sent it the work is back.
  const fixFailed = !!fixedBy && entryOf(fixedBy)?.status === "failed";
  const checking = fixedBy && !fixFailed ? sourceOf(fixedBy) : null;
  if (fixFailed) fixing = { station: fixedBy!, from: sourceOf(fixedBy!) };

  // A station a run enters once (its way in reads `<id>.visits = 0`: Find check) belongs to every round once it ran.
  const once = (id: string) => graph.edges.some((e) => e.to === id && new RegExp(`\\b${id}\\.visits\\s*=\\s*0\\b`).test(e.condition ?? ""));
  const ofRound = (id: string): boolean => {
    const n = entryOf(id);
    if (!n) return false;
    if (once(id) && n.status === "completed") return true;
    if (n.status === "running" || n.status === "pending") return (n.started_at ?? 0) >= roundStart;
    if ((n.completed_at ?? n.started_at ?? 0) < roundStart) return false;
    // A reviewer's pin is this round's only when it carries this round's nonce.
    const pin = jsonOf(n.result_preview);
    return !(pin && typeof pin.verdict === "string" && typeof pin.round === "string" && nonce && pin.round !== nonce);
  };

  // Bookkeeping a station finishes its work with: a fold station whose one way in is from it (a fan-out's join is the fan-out).
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const fanOfJoin = (join: string) => fans.find((f) => graph.edges.some((e) => e.from === f && graph.edges.some((x) => x.from === e.to && x.to === join))) ?? null;
  const tailOf: Record<string, string> = {};
  for (const n of graph.nodes) {
    if (!n.fold) continue;
    const ins = [...new Set(graph.edges.filter((e) => e.to === n.id).map((e) => e.from))];
    // A verdict step is reached from its join (and from a branch that failed): the join's fan-out holds it.
    const join = ins.find((i) => byId.get(i)?.type === "parallel_fanin");
    const from = join ? byId.get(join) : ins.length === 1 ? byId.get(ins[0]) : undefined;
    if (!from || from.fold || from.backend === "subject" || from.type === "start") continue;
    const holder = from.type === "parallel_fanin" ? fanOfJoin(from.id) : from.id;
    if (holder) tailOf[n.id] = holder;
  }
  const runningNow = (id: string) => { const n = entryOf(id); return !!n && (n.status === "running" || n.status === "pending") && (n.started_at ?? 0) >= roundStart; };
  // The stop a run that ended came to, and the station whose output it could not read or that sent it there.
  const stopExit = failedRun && run.current_node_id && byId.get(run.current_node_id)?.type === "exit" ? run.current_node_id : null;
  const ledToStop = (id: string) => !!stopExit && graph.edges.some((e) => e.from === id && e.to === stopExit);
  // The end a run that completed came to short of Live (Deployed, unverified; Landed).
  const ended = run.status === "completed" && run.current_node_id ? byId.get(run.current_node_id) : undefined;
  const offEnd = ended?.type === "exit" && !ended.stop && ended.label !== "Live" ? ended.label ?? ended.id : null;
  const landingIds = new Set<string>();

  // The stations a station holds as its own: a fan-out's branches, and the bookkeeping it finishes with.
  const tailsOf = (id: string) => Object.entries(tailOf).filter(([, holder]) => holder === id).map(([tail]) => tail);
  const branchesOf = (fan: string) => [...branchOf].filter(([, f]) => f === fan).map(([b]) => b);
  // The steps that open the round before its fan-out: Round, and a station a run enters once (Find check).
  const heads = [opener, ...graph.nodes.filter((n) => once(n.id)).map((n) => n.id)].filter((x): x is string => !!x);

  const own = (id: string): RoundStation => {
    const n = entryOf(id);
    const result = n ? stationResult(n.result_preview) : null;
    const note = n ? noteOf(n) : null;
    if (fixing?.from === id) return { state: "back", result, note };
    if (checking === id) return { state: "running", result: null, note: null };
    // Still at work while the bookkeeping it finishes with runs.
    if (n?.status !== "failed" && tailsOf(id).some(runningNow)) return { state: "running", result: null, note: null };
    if (!n || !ofRound(id)) {
      if (branchOf.has(id) && inFan(id)) return { ...IDLE, state: "running" };
      // A run that ended after it landed, in a later round (its fix left the run), still landed.
      if (n && !live && landingIds.has(id)) return { state: "done", result, note };
      return IDLE;
    }
    if (n.status === "running" || n.status === "pending") return { ...IDLE, state: "running" };
    if (n.status === "failed") {
      // A station whose way out took the run to leave (Land, when the session pushed the change itself) did not fail:
      // it says what the run's end says.
      const left = failedRun ? graph.edges.map((e) => e.from === id ? entryOf(e.to) : undefined).find((t) => !!t && !!byId.get(t.node_id)?.fold && ledToStop(t.node_id) && (t.started_at ?? 0) >= (n.started_at ?? 0)) : undefined;
      // One that may have done its work, which the run stopped to say (Landing unknown, straight from Land or through
      // the bookkeeping that reads a Land cut off), is unknown: never failed, never done.
      if (stopExit && UNKNOWN_ENDS.has(stopExit) && (ledToStop(id) || left)) return { state: "unknown", result, note, endSays: { end: byId.get(stopExit)?.label ?? stopExit, why: (left ? noteOf(left) : null) ?? note } };
      // One that pushed, which the run stopped after (Landing not recorded, Land cut off after its push), landed.
      if (landingOf(n) || landingOf(left)) return { state: "done", result, note, endSays: { end: "landed", why: note ?? (left ? noteOf(left) : null) } };
      if (left) return { state: "stopped", result, note, endSays: { end: byId.get(stopExit!)?.label ?? stopExit!, why: noteOf(left) ?? (left.result_preview?.trim() || null) } };
      return { state: failedRun ? "stopped" : "failed", result, note };
    }
    const word = result?.outcome ?? (typeof jsonOf(n.result_preview)?.verdict === "string" ? jsonOf(n.result_preview)!.verdict : null);
    // The bookkeeping that found a landing may have happened (Land cut off) says so: unknown, as Land is.
    if (word === "unknown" && stopExit && UNKNOWN_ENDS.has(stopExit)) return { state: "unknown", result, note };
    // A station whose output its round could not read (a branch with no outcome or verdict), that sent the run to its
    // stop, or whose bookkeeping did, did not pass; a landing did, whatever its bookkeeping found after (Main unchecked).
    if (!["landed", "unrecorded"].includes(word ?? "") && (ledToStop(id) || tailsOf(id).some((t) => ledToStop(t) && ofRound(t)))) return { state: "stopped", result, note };
    if (!word && branchOf.has(id)) return { state: failedRun ? "stopped" : "failed", result, note };
    if (word === "skipped" && !result?.leftForYou) return { state: "nothing", result, note };
    if (word === "rejected") return { state: "stopped", result, note };
    // Found work goes back to the session once the run sent it there; until then it is a failure of this round.
    if (word === "fail" || word === "failed" || word === "changes") return { state: failedRun ? "stopped" : fixing ? "back" : "failed", result, note };
    if (word === "live" && offEnd) return { state: "done", result, note, endSays: { end: offEnd, why: shortWhy(n.result_preview, landedSha ?? "") } };
    return { state: "done", result, note };
  };

  const station = (id: string): RoundStation => {
    if (!fans.includes(id)) return own(id);
    // A fan-out is its round's work: back when the session fixes what its verdict found, as its opening steps are when
    // they stopped or went back, running while a branch or its bookkeeping runs, else what its branches found.
    const head = heads.map(own).find((h) => h.state === "back" || h.state === "stopped");
    if ((fixing?.from && (fixing.from === id || tailsOf(id).includes(fixing.from))) || head?.state === "back") return { state: "back", result: null, note: null };
    if (head) return head;
    const parts = [...branchesOf(id), ...tailsOf(id)].map(own);
    if (parts.some((p) => p.state === "running")) return { ...IDLE, state: "running" };
    // The round is in while the run is in the fan-out or at its join: its verdict step has yet to speak.
    const join = graph.edges.find((e) => branchesOf(id).includes(e.from) && byId.get(e.to)?.type === "parallel_fanin")?.to;
    if (live && !!current && (current === id || branchOf.get(current) === id || current === join)) return { ...IDLE, state: "running" };
    if (parts.some((p) => p.state === "stopped")) return { ...IDLE, state: "stopped" };
    if (parts.some((p) => p.state === "failed" || p.state === "back")) return { ...IDLE, state: failedRun ? "stopped" : "failed" };
    const mine = branchesOf(id).map(own);
    if (mine.length && mine.every((p) => p.state === "nothing")) return { ...IDLE, state: "nothing" };
    if (mine.length && mine.every((p) => p.state === "done" || p.state === "nothing")) return { ...IDLE, state: "done" };
    return own(id);
  };

  const landings = statuses.filter((n) => landingOf(n));
  const landing = landings.reduce<Entry | undefined>((best, n) => (!best || (n.completed_at ?? n.started_at ?? 0) >= (best.completed_at ?? best.started_at ?? 0) ? n : best), undefined);
  for (const n of landings) landingIds.add(n.node_id);
  const landedSha: string | null = landing ? landingOf(landing) : null;
  return { start: roundStart, nonce, current, fixing, landed: landedSha, station, ofRound, tailOf };
}

/** Why a personal run ended short of Live, from its Deploy's pin: the reason it gave for Deployed, unverified or for no
 *  deploy, else what it did not see (the landed commit running, or a commit other than the landed one). */
export function shortWhy(deployed: string | null | undefined, landed: string): string | null {
  const o = jsonOf(deployed);
  if (!o) return null;
  const note = typeof o.note === "string" && o.note.trim() ? o.note.trim() : null;
  if (o.outcome !== "live") return note;
  if (typeof o.sha === "string" && o.sha && !landed.startsWith(o.sha) && !o.sha.startsWith(landed)) return `It reported ${o.sha.slice(0, 10)} running, not the landed ${landed.slice(0, 10)}`;
  return "The landed commit was not seen running";
}

/** A station's words: its result's note, a reviewer's pin as its verdict and findings, a JSON's note, else nothing. */
export function noteOf(n: { result_preview?: string | null }): string | null {
  const r = stationResult(n.result_preview);
  if (r?.note) return r.note;
  const pin = jsonOf(n.result_preview);
  if (pin && typeof pin.verdict === "string") {
    const k = Array.isArray(pin.findings) ? pin.findings.length : 0;
    return `${VERDICT_WORDS[pin.verdict] ?? pin.verdict}${k ? ` · ${k} finding${k === 1 ? "" : "s"}` : ""}`;
  }
  return typeof pin?.note === "string" && pin.note.trim() ? pin.note.trim() : null;
}

/** A reviewer's pinned verdict in a person's words. */
export const VERDICT_WORDS: Record<string, string> = { ship: "Ship", changes: "Changes asked", rejected: "Rejected" };
