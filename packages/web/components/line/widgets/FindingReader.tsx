"use client";
// One finding, opened in place (line-journeys.md LJ6.3). The row says who
// raised it, when, and the objection in full. Open, it shows the real thing as
// far as the finding's data goes: a judge's finding carries the moment it read
// (MomentView frames the product's own screen and marks the judged words); any
// other finding shows its own words whole and one link named for where it
// leads. Shared by the problem page and a finder's step page. The host mounts
// the findings feed (useSyncTaskSignals) and owns which row is open.
import { memo, useMemo, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { LineSignal } from "../../../lib/lineFlow";
import { findingJudgeLabel, findingStepId, findingTitle, sourceLabel } from "../../../lib/line/loopSteps";
import { lineLabelKey } from "../../../lib/line/lineLabels";
import { dayTimeWords, eventFinding, eventFindingWords, evidenceLinkWords, findingBlocks, type EventFinding } from "../../../lib/line/problemPage";
import { useInboxStore } from "../../../store/inboxStore";
import { useTeamRosterIdentity } from "../../../hooks/useTeamRoster";
import { EventGroupFinding } from "./EventGroupFinding";
import { MomentView } from "./MomentView";
import "./findingReader.css";

export type ReaderSignal = LineSignal & { user_id?: string };

/** The finder's one name, on every surface: the judge ("Comms judge"), the person or agent account that filed it
 *  ("Aivery"), else the source ("Escalation"). */
/** What naming a finder reads off a finding. */
type Finder = { source: string; judge?: string | null; subject?: string | null; user_id?: string };

export function useFinderName(): (s: Finder) => string {
  const roster = useTeamRosterIdentity();
  const names = useMemo(() => new Map(roster.map((m) => [m._id, (m.name ?? m.email ?? "").split(/[\s@]/)[0]] as [string, string]).filter(([, n]) => !!n)), [roster]);
  return useMemo(() => (s: Finder) => {
    if (s.source === "person") return (s.user_id && names.get(s.user_id)) || "A person";
    const judge = findingJudgeLabel(s);
    return judge && judge !== "Expectation check" ? judge : sourceLabel(s.source);
  }, [names]);
}

export type FindingReaderProps = {
  signal: ReaderSignal;
  open: boolean;
  onToggle: () => void;
  /** The finder's one name (useFinderName), given by the host so a list reads the roster once. */
  who: string;
  /** What the row leads with when the problem's findings share a title: what this one says. Defaults to its title. */
  lead?: string | null;
  /** It came after the fix reached production. */
  since?: boolean;
  /** It cites another expectation than the problem's: about something else. */
  off?: boolean;
};

const norm = (t: string) => t.toLowerCase().replace(/[\s.…]+$/g, "").replace(/\s+/g, " ");

/** What opening a finding shows beyond its row: the moment it read, the error group it was filed for, its own words
 *  that the row does not already say, and its acts. Empty means the row is the whole finding. */
function findingBody(s: ReaderSignal, said: string, event: EventFinding | null) {
  const blocks = s.moment || event ? [] : findingBlocks(s).filter((b) => norm(b.text) !== norm(said));
  // A judge's own finding can be marked wrong; a case made against a judge (case_of) is not one of its findings.
  const judged = !!s.judge && !s.case_of;
  return { blocks, judged, has: !!s.moment || !!event || blocks.length > 0 || judged || !!s.evidence_url };
}

export const FindingReader = memo(function FindingReader({ signal: s, open, onToggle, who, lead, since, off }: FindingReaderProps) {
  const at = s.observed_at || s.created_at;
  const event = useMemo(() => eventFinding(s), [s]);
  // Findings that share a title (the host passes a lead) and come from an event source say what happened to the group,
  // never the filer's text.
  const words = event && lead != null ? eventFindingWords(event) : lead || findingTitle(s);
  const body = useMemo(() => findingBody(s, words, event), [s, words, event]);
  const head = <>
    <span className="fr-who">{who}</span>
    <time className="fr-at" dateTime={new Date(at).toISOString()}>{dayTimeWords(at)}</time>
    <span className="fr-words">{words}</span>
    {off && <span className="fr-off">about something else</span>}
  </>;
  return (
    <li className="fr" data-open={open && body.has ? "" : undefined} data-line-finding={s.short_id ?? s._id} data-since={since ? "" : undefined} data-whole={body.has ? undefined : ""}>
      {/* A finding whose row is all of it opens nothing. */}
      {body.has ? (
        <button type="button" className="fr-row" onClick={onToggle} aria-expanded={open}><span className="lw-chev" aria-hidden />{head}</button>
      ) : <div className="fr-row"><span aria-hidden />{head}</div>}
      {open && body.has && <FindingOpen signal={s} event={event} blocks={body.blocks} judged={body.judged} />}
    </li>
  );
});

/** The finding itself: the moment a judge read, the error group an event source reported, else its own words in full;
 *  then its acts. The problem's title is never repeated here: the page says it once. */
function FindingOpen({ signal: s, event, blocks, judged }: { signal: ReaderSignal; event: EventFinding | null; blocks: ReturnType<typeof findingBlocks>; judged: boolean }) {
  return (
    <div className="fr-open" data-line-finding-open={s.moment ? "moment" : event ? "event" : s.evidence_url ? "text+link" : "text"}>
      {/* A judge's finding is the moment it read: the message itself with the judged words marked and the judge's verdict on it. */}
      {s.moment ? <MomentView moment={s.moment} cited={s.subject ?? null} foldAt={420} /> : event ? <EventGroupFinding event={event} said={s.title} /> : blocks.length > 0 && <FindingText blocks={blocks} />}
      {(judged || s.evidence_url) && (
        <div className="fr-acts">
          {judged && <JudgeIsWrong signal={s} />}
          {s.evidence_url && (
            <a className="lw-link fr-link" href={s.evidence_url} target="_blank" rel="noreferrer" data-line-finding-link title={evidenceLinkWords(s.evidence_url)}>
              {evidenceSite(s.evidence_url)}<ArrowUpRight className="w-3 h-3" aria-hidden />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** The evidence link's label: where it goes, in a word ("Union", "Slack", "GitHub"); its title names the target in full. */
function evidenceSite(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (/unionmatching\.com$/.test(host)) return "Union";
    if (/slack\.com$/.test(host)) return "Slack";
    if (/github\.com$/.test(host)) return "GitHub";
    return host;
  } catch { return "Evidence"; }
}

function FindingText({ blocks }: { blocks: ReturnType<typeof findingBlocks> }) {
  return (
    <div className="fr-text">
      {blocks.map((b, i) => b.kind === "quote" ? <blockquote key={i}>{b.text}</blockquote> : b.kind === "code" ? <pre key={i}>{b.text}</pre> : <p key={i}>{b.text}</p>)}
    </div>
  );
}

/** Mark a judge's finding wrong, with what it should have seen: the judge's test set and its wrong rate read it. */
function JudgeIsWrong({ signal: s }: { signal: ReaderSignal }) {
  const step = findingStepId(s);
  const mine = useInboxStore((st) => {
    const me = String(st.currentUser?._id ?? "");
    if (!me) return null;
    const key = lineLabelKey(s._id, step, me);
    const l = Object.values((st as unknown as { lineLabels?: Record<string, { key: string; verdict: string; note?: string }> }).lineLabels ?? {}).find((x) => x.key === key);
    return l ? `${l.verdict}|${l.note ?? ""}` : null;
  });
  const wrong = mine?.startsWith("wrong") ?? false;
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const box = useRef<HTMLInputElement>(null);
  const label = (verdict: "wrong" | null, text?: string) => useInboxStore.getState().labelDecision(s._id, step, verdict, text ?? null);
  if (noting) {
    return (
      <form className="fr-wrong" onSubmit={(e) => { e.preventDefault(); label("wrong", note); setNoting(false); }} data-line-judge-wrong="noting">
        <input ref={box} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should it have seen? (optional)" aria-label="What the judge should have seen" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setNoting(false); } }} />
        <button type="submit" className="lw-act" data-primary="">Mark wrong</button>
        <button type="button" className="lw-act" onClick={() => setNoting(false)}>Cancel</button>
      </form>
    );
  }
  return wrong ? (
    <span className="fr-wrong" data-line-judge-wrong="set">
      <span className="lw-oc" data-tone="bad">You marked the judge wrong</span>
      <button type="button" className="lw-link" onClick={() => label(null)}>Undo</button>
    </span>
  ) : (
    <button type="button" className="lw-act" onClick={() => { setNote(""); setNoting(true); }} data-line-judge-wrong="open">Judge is wrong</button>
  );
}

/** A finding the feed has not brought yet: a row of the same height, so the list does not jump when it lands. */
export function FindingPlaceholder() {
  return <li className="fr fr-wait" aria-hidden><span className="fr-row"><span className="fr-ph" style={{ width: "9ch" }} /><span className="fr-ph" style={{ width: "13ch" }} /><span className="fr-ph" style={{ width: "58%" }} /></span></li>;
}
