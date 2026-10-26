// A gate whose asking station posted its own decision (workflow `asker=`):
// that decision's options, in the order the session wrote them, matched onto
// the gate's edges, so an answer by option index routes the run. An option
// names its edge by label, or leads with it ("Revise: tighten the close
// note"), else by verdict; one that names no edge carries no key, and its
// label routes as text.
import { verdictOfOption } from "@codecast/shared/contracts/changeCard";

export type GateChoice = { key: string; label: string; description?: string; target: string };

const bare = (s: string) => s.replace(/^\s*\[?[A-Za-z0-9]{1,3}\]\s*/, "").trim().toLowerCase();

export function alignGateChoices(options: ReadonlyArray<{ label: string }>, choices: ReadonlyArray<GateChoice>): Array<GateChoice | null> {
  const taken = new Set<string>();
  const pick = (test: (c: GateChoice) => boolean) => {
    const c = choices.find((x) => !taken.has(x.key) && test(x));
    if (c) taken.add(c.key);
    return c ?? null;
  };
  return options.map((o) => {
    const label = bare(o.label);
    const verdict = verdictOfOption(o.label);
    const leads = (c: GateChoice) => { const g = bare(c.label); return label === g || label.startsWith(`${g} `) || label.startsWith(`${g}:`); };
    return pick((c) => bare(c.label) === label) ?? pick(leads) ?? (verdict ? pick((c) => verdictOfOption(c.label) === verdict) : null);
  });
}

// The card a gate decides on is the one its presenting station posted; the
// gate asks no question of its own. That card stands while it waits on a
// person, and once a person answered it after the station last started
// presenting: answered before the run reached its gate (sd-1600, answered 26 s
// after it was posted and 3 s before its gate paused), or on an earlier pass
// of a run resumed at its gate. An answer from before the station's latest
// visit was to a card the station has replaced since.
export async function standingCard(
  ctx: { db: any },
  run: { _id: string; node_statuses?: Array<{ session_id?: string; started_at?: number }> },
  stationId: string,
  nodeId: string,
  askerRef: string | undefined,
) {
  const presentedAt = run.node_statuses?.find((n) => !!askerRef && n.session_id === askerRef)?.started_at ?? Infinity;
  const ofStation = (status: string) => ctx.db.query("session_decisions").withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", stationId).eq("status", status)).collect();
  const [pending, answered] = await Promise.all([ofStation("pending"), ofStation("answered")]);
  const forThisGate = (d: any) => !d.workflow_run_id || (String(d.workflow_run_id) === String(run._id) && d.gate_node_id === nodeId);
  const stands = (d: any) => d.status === "pending" || ((d.resolved_at ?? 0) >= presentedAt && (d.answer_index !== undefined || !!d.answer_text?.trim()));
  return [...pending, ...answered].filter((d: any) => forThisGate(d) && stands(d)).sort((a: any, b: any) => b.created_at - a.created_at)[0] ?? null;
}

// What an answer hands the runner as gate_response (the-line.md L4): the
// chosen option's key; a note typed beside it after the key, so the runner
// routes on the key and hands the note to the next node; the note or the
// option's words alone when the option names no edge.
export function gateResponseOf(key: string | undefined, note: string | undefined, label: string | undefined): string {
  const text = note?.trim();
  if (!key) return text || label || "";
  if (!text) return key;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\[?${escaped}\\]?([:\\s]|$)`, "i").test(text) ? text : `${key}: ${text}`;
}
