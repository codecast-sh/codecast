// A journey in a person's words (journey.ts): the bar's and a run row's few words for where a change is, who acts, what
// a wait waits on, and why a run stopped, read from the journey a run made. Pure, with relative imports only: the web's
// Ship panel and run card, the inbox card and the phone's run card all say a run with these.
import { jsonOf } from "./personalRound";
import type { DeployHold, Journey, JourneyStage, JourneyWait, StageWho } from "./journey";
import type { SessionAsk } from "./sessionAsk";

/** A run that stopped on its session's ask, in the past tense: the run ended, so nobody waits on it any more. Older
 *  runners said "<station> is waiting on a person" for a killed session's ask too. */
export function askStopWhy(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/^\S+ stopped: its session was killed while it waited on a person$/.test(raw)) return "Its session was killed while it waited on a person";
  return /^\S+ is waiting on a person$/.test(raw) ? "Its session asked a person, and the run stopped" : null;
}

/** A stop reason a person can read: its leading "Stopped:" and any JSON or a trailing cut word taken off. `whole` keeps
 *  every word (an own-results round's stop, whose words say all of how the change stands). */
export function readableWhy(raw: string | null | undefined, whole = false): string | null {
  if (!raw) return null;
  let s = raw.replace(/^Stopped:\s*/, "").replace(/\s*\{[^{}]*"[a-z_]+"\s*:[^{}]*\}\s*$/i, "").trim();
  if (!whole && s.length > 280) s = s.slice(0, 280).replace(/\s+\S*$/, "") + "…";
  return s || null;
}

/** Why an own-results round stopped, whole: the words before a result's JSON, then its note, or a rejection's findings. */
export function stopWhy(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const body = raw.replace(/^Stopped:\s*/, "");
  const start = body.indexOf("{");
  const o = start >= 0 ? jsonOf(body.slice(start)) : null;
  const said = typeof o?.note === "string" && o.note.trim() ? o.note.trim()
    : Array.isArray(o?.findings) && o.findings.length ? o.findings.map(String).join("; ")
    : null;
  if (!said) return readableWhy(raw, true);
  const before = body.slice(0, start).trim().replace(/:$/, "");
  return !before ? said : /[.!?]$/.test(before) ? `${before} ${said}` : `${before}: ${said}`;
}

/** Whether a bar shows its reason whole, never clamped: a personal Ship's stop, whose last words are what the person
 *  does next, and its end short of Live (Deployed, unverified; Landed); and any flow's stop whose runner words name its
 *  one restart (`whole`: a worktree something moved). Every other one clamps. */
export const wholeWhy = (j: Journey): boolean =>
  ((j.now.kind === "stopped" || j.now.kind === "failed") && !!j.now.whole)
  || (!!j.personal && (j.now.kind === "stopped" || j.now.kind === "failed" || j.now.kind === "unlanded" || (j.now.kind === "merged" && !!j.now.end)));

/** Why a run stopped or ended short of Live, whole, as its bar says it: a list row's reason. */
export function journeyWhy(j: Journey): string | null {
  const n = j.now;
  return n.kind === "stopped" || n.kind === "failed" ? n.why : n.kind === "merged" ? n.why ?? null : null;
}

/** What a stage's result said, as a card with no hover says it under the stage (the phone's run card; the web shows it
 *  on the stage's hover and in its steps): its note, unless the bar under the track says those words already. */
export const stageNote = (s: Pick<JourneyStage, "note">, j: Journey): string | null => (s.note && s.note !== journeyWhy(j) ? s.note : null);

/** The few words for who acts at a stage. */
export const WHO_WORDS: Record<StageWho, string> = { session: "This session", agent: "Agent", you: "You", person: "Person", auto: "Automatic" };

/** A wait in a few words: "CI · 9 of 14 jobs · 7m · due in 13m". `age` formats a span of milliseconds. */
export function waitWords(w: JourneyWait, now: number, age: (ms: number) => string): string {
  const parts = [w.on, w.line, w.since ? age(Math.max(0, now - w.since)) : null];
  if (w.deadline) parts.push(w.deadline > now ? `due in ${age(w.deadline - now)}` : `${age(now - w.deadline)} past its deadline`);
  return parts.filter(Boolean).join(" · ");
}

/** "CI and review": station names as one phrase, an acronym kept as written. */
const phrase = (labels: string[]) => labels.map((l) => (l !== l.toUpperCase() ? l.toLowerCase() : l)).join(" and ");

export type JourneyTone = "idle" | "working" | "agent" | "session" | "you" | "wait" | "ok" | "bad";

/** The words for a card nobody the viewer is may answer. */
/**
 * Who a handle is, as a person reads it: a role (`@handle`) by its title from the roster when the caller has it, the
 * Release Captain's (pl-1075 Words) when it does not; anyone else as named.
 */
export function whoWords(by: string | null | undefined, roles?: ReadonlyArray<{ handle?: string; name?: string }>): string | null {
  if (!by) return null;
  if (!by.startsWith("@")) return by;
  const title = roles?.find((r) => `@${r.handle}` === by)?.name;
  return title ?? (by === "@release" ? "Release Captain" : by);
}

/** A run waiting on its approval card, naming who answers it when the card says (never "paused": production's pause owns that word). */
export const gateWaitWords = (holder: "person" | "role", who?: string | null) => (who ? `Waiting for approval from ${whoWords(who)}` : "Waiting for approval");

/** A stop in a few words: the exit's own name when the run reached it off the main path, else the stage it stopped at. */
export function stopWords(n: { stage: string | null; end: string | null }): string {
  if (n.end) return `Stopped: ${/^[A-Z]{2,}\b/.test(n.end) ? n.end : n.end.charAt(0).toLowerCase() + n.end.slice(1)}`;
  return n.stage ? `Stopped at ${n.stage}` : "Stopped";
}

/** A stopped or failed run's title, as the bar and the run page's head both say it: one word for where it stopped. */
export const stopTitle = (n: { kind: "stopped" | "failed"; stage: string | null; end: string | null }) =>
  (n.kind === "failed" && !n.end ? `Failed${n.stage ? ` at ${n.stage}` : ""}` : stopWords(n));

/** A note a station or session wrote, as plain words for a bar: markdown headings and emphasis marks taken off. */
export const plainNote = (note: string) => note.replace(/^#{1,6}\s+/gm, "").replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/`([^`]+)`/g, "$1");

/** Who sent the work back, in the bar's words; while the session waits on a person, whom it waits on. */
export const sentBackWords = (n: { stage: string; by: string | null; blocked?: boolean; ask?: SessionAsk | null; what?: string }) =>
  (n.blocked ? (n.ask?.mine ? "Waiting on you" : "Waiting for a person") : n.what ? n.what : n.by ? `Sent back by ${n.by}` : `${n.stage} sent it back`);

/** A landed change's Deploy in a pill's words: "Deploying" only while a deploy carries it. */
export function holdWords(hold: DeployHold, roles?: ReadonlyArray<{ handle?: string; name?: string }>): { words: string; tone: "working" | "wait" } {
  if (hold.kind === "out") return { words: "Deploying", tone: "working" };
  if (hold.kind === "red") return { words: "Waiting for green main", tone: "wait" };
  if (hold.kind === "ci") return { words: "Waiting on main CI", tone: "wait" };
  if (hold.kind === "press") return { words: `Waiting for ${whoWords(hold.by, roles) ?? "a person"} to deploy`, tone: "wait" };
  return { words: "Waiting to deploy", tone: "wait" };
}

/** Where a session's change is, in the words and tone its Ship control and a run's row both show. */
export function journeyWords(j: Journey | null): { words: string; tone: JourneyTone } {
  if (!j) return { words: "Ship", tone: "idle" };
  const n = j.now;
  switch (n.kind) {
    case "working": {
      const tone = n.who === "agent" ? "agent" : "working";
      if (n.verb) return { words: n.verb, tone };
      if (n.role === "parallel") return { words: `In ${phrase(n.waits.length ? n.waits.map((w) => w.on) : n.stage.split(" + "))}`, tone };
      return { words: n.stage, tone };
    }
    case "starting": return { words: "Starting", tone: "working" };
    case "session": return n.blocked ? { words: sentBackWords(n), tone: n.ask?.mine ? "you" : "wait" } : { words: "Fixing", tone: "session" };
    case "gate": return n.mine ? { words: "Your call", tone: "you" } : { words: gateWaitWords(n.holder, n.who), tone: "wait" };
    case "landed": return holdWords(n.hold);
    case "deploying": return { words: "Deploying", tone: "working" };
    case "merged": return { words: n.end ?? "Merged", tone: "ok" };
    case "passed": return { words: "Done", tone: "ok" };
    case "unlanded": return { words: "Not merged", tone: "bad" };
    case "live": return { words: "Live", tone: "ok" };
    case "stopped": case "failed": return { words: stopWords(n), tone: "bad" };
    default: return { words: "Ship", tone: "idle" };
  }
}
