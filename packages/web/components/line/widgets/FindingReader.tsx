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
import { dayTimeWords, escalationFinding, escalationWords, eventFinding, eventFindingWords, evidenceLinkWords, findingBlocks, findingCut, findingCutWords, dropMessageRefs, type EventFinding } from "../../../lib/line/problemPage";
import { useInboxStore } from "../../../store/inboxStore";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useLineNav } from "./parts";
import { useTeamRosterIdentity } from "../../../hooks/useTeamRoster";
import { EventGroupFinding } from "./EventGroupFinding";
import { SwitchReview } from "../../consequential/ConsequentialSwitch";
import { moveFindingLedger } from "../../../lib/line/findingLedger";
import { MomentView } from "./MomentView";
import { isEmptyFinding } from "../../../lib/line/findingEvidence";
import { ProductView, ProductViewPill } from "./ProductView";
import { callWordsShort, callsIn, textWithCalls } from "../../../lib/line/findingCalls";
import { citedTimes, quotesIn } from "../../../lib/line/callRecord";
import { CallRecord } from "./CallRecord";
import { slackParts } from "../../../lib/line/slackParts";
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
  /** How many findings this row stands for: others said the same words (findingEvidence listedFindings). */
  times?: number;
  /** It came after the fix reached production. */
  since?: boolean;
  /** It cites another expectation than the problem's: about something else. */
  off?: boolean;
  /** A run split it off to this problem (ct-N), which was then merged back here: why a finding a run moved still counts. */
  back?: string | null;
  /** The problem's expectation in full: a finding's line restating it is left out. */
  expectation?: string | null;
  /** On a problem's page: the finding can be moved out of it ("Not this problem"). `count`: the findings that leave with
   *  it (the same key); `left`: the findings the problem keeps. */
  moveOut?: { problem: string; count: number; left: number; /** Probably filed here by mistake: moving it out is the main act. */ misfiled?: boolean } | null;
};

const norm = (t: string) => t.toLowerCase().replace(/[\s.…]+$/g, "").replace(/\s+/g, " ");

/** What opening a finding shows beyond its row: the moment it read, the error group it was filed for, its own words
 *  that the row does not already say, and its acts. Empty means the row is the whole finding. */
function findingBody(s: ReaderSignal, said: string, event: EventFinding | null, expectation?: string | null) {
  const blocks = s.moment || event ? [] : findingBlocks(s, expectation).filter((b) => norm(b.text) !== norm(said));
  // A judge's own finding can be marked wrong; a case made against a judge (case_of) is not one of its findings.
  const judged = !!s.judge && !s.case_of;
  return { blocks, judged, has: !!s.moment || !!event || blocks.length > 0 || judged || !!s.evidence_url };
}

/** Past this a finding's words are a paragraph, not a one-line objection: they take the row's whole width under who and when. */
const LONG_WORDS = 160;

export const FindingReader = memo(function FindingReader({ signal: s, open, onToggle, who, lead, since, off, back, expectation, moveOut, times = 1 }: FindingReaderProps) {
  const at = s.observed_at || s.created_at;
  const event = useMemo(() => eventFinding(s), [s]);
  const escalation = useMemo(() => escalationFinding(s), [s]);
  // An escalation says who and what a person was asked to do; findings that share a title (the host passes a lead) and
  // come from an event source say what happened to the group. Never the filer's text.
  // A finding that says nothing ("placeholder") is no evidence, and its row says so rather than quoting the stub.
  const empty = useMemo(() => !event && !escalation && !s.moment && isEmptyFinding(s), [s, event, escalation]);
  const words = empty ? "Empty finding" : escalation ? escalationWords(escalation) : event && lead != null ? eventFindingWords(event) : dropMessageRefs(lead || findingTitle(s));
  const found = useMemo(() => (empty ? { blocks: [], judged: false, has: !!s.evidence_url } : findingBody(s, words, event, expectation)), [s, words, event, expectation, empty]);
  const body = moveOut && !found.has ? { ...found, has: true } : found;
  const head = <>
    <span className="fr-who">{who}</span>
    <time className="fr-at" dateTime={new Date(at).toISOString()}>{dayTimeWords(at)}{times > 1 && <span className="fr-times" title={`${times} findings say this`}> ×{times}</span>}</time>
    <span className="fr-words">{callWordsShort(words)}</span>
    {off && <span className="fr-off">about something else</span>}
    {back && <span className="fr-off" title={`A run split it off to ${back}, which was merged back into this problem`} data-line-finding-back={back}>back from {back}</span>}
  </>;
  return (
    <li className="fr" data-open={open && body.has ? "" : undefined} data-long={words.length > LONG_WORDS ? "" : undefined} data-empty={empty ? "" : undefined} data-line-finding={s.short_id ?? s._id} data-since={since ? "" : undefined} data-whole={body.has ? undefined : ""}>
      {/* A finding whose row is all of it opens nothing. */}
      {body.has ? (
        <button type="button" className="fr-row" onClick={onToggle} aria-expanded={open}><span className="lw-chev" aria-hidden />{head}</button>
      ) : <div className="fr-row"><span aria-hidden />{head}</div>}
      {open && body.has && <FindingOpen signal={s} event={event} blocks={body.blocks} judged={body.judged} said={words} moveOut={moveOut ?? null} />}
    </li>
  );
});

/** The finding itself: the moment a judge read, the error group an event source reported, else its own words in full;
 *  then its acts. The problem's title is never repeated here: the page says it once. A finding nothing filed leads its
 *  acts with where it can be acted on now (Open in Union) and offers to make it a problem. */
function FindingOpen({ signal: s, event, blocks, judged, said, moveOut }: { signal: ReaderSignal; event: EventFinding | null; blocks: ReturnType<typeof findingBlocks>; judged: boolean; said: string; moveOut: FindingReaderProps["moveOut"] }) {
  const unfiled = !s.task_id && !s.case_of;
  const calls = useMemo(() => callsIn([said, ...blocks.filter((b) => b.kind !== "code").map((b) => b.text)].join("\n")), [said, blocks]);
  const text = !s.moment && !event && blocks.length > 0;
  const whole = useWholeDetail(s, text);
  // A call is cited by the finding's whole words (its quotes and the [mm:ss] times it names), never by its row alone.
  const cites = useMemo(() => { const all = [said, whole.whole ?? s.detail_md ?? ""].join("\n"); return { quotes: quotesIn(all), times: citedTimes(all) }; }, [said, whole.whole, s.detail_md]);
  // A cut text says so on its own line, with the link to the whole beside it; the acts then do not repeat the link.
  const cutLinked = text && !!whole.cut && !!s.evidence_url;
  const link = s.evidence_url && !cutLinked ? (
    <a className="lw-link fr-link" href={s.evidence_url} target="_blank" rel="noreferrer" data-line-finding-link>
      {evidenceLinkWords(s.evidence_url)}<ArrowUpRight className="w-3 h-3" aria-hidden />
    </a>
  ) : null;
  return (
    <div className="fr-open" data-line-finding-open={s.moment ? "moment" : event ? "event" : s.evidence_url ? "text+link" : "text"}>
      {/* A judge's finding is the moment it read: the message itself with the judged words marked and the judge's verdict on it. */}
      {s.moment ? <MomentView moment={s.moment} cited={s.subject ?? null} foldAt={420} /> : event ? <EventGroupFinding event={event} said={s.title} /> : text && <WholeText signal={s} blocks={blocks} said={said} whole={whole} />}
      {/* The call a finding names, as its app shows it (Union's own call screen), read in place, with its own Open link.
          When the app cannot frame it, the call is read through the app's history reader instead: its transcript, with
          the lines the finding quotes marked. */}
      {!s.moment && calls[0] && <div className="fr-call" data-line-finding-call={calls[0].id}><ProductView viewRef={calls[0]} hideWhenNone fallbackNames fallback={<CallRecord viewRef={calls[0]} marks={cites.quotes} times={cites.times} />} /></div>}
      {(judged || link || unfiled || moveOut) && (
        <div className="fr-acts">
          {unfiled && link}
          {unfiled && <MakeProblem signal={s} />}
          {judged && <JudgeIsWrong signal={s} />}
          {moveOut && !unfiled && <NotThisProblem signal={s} {...moveOut} />}
          {!unfiled && link}
        </div>
      )}
    </div>
  );
}

/** The feeds carry a finding's opening words, cut with "…"; open, it reads the whole as the finder wrote it, and says
 *  where the words it shows end cut (problemPage findingCut). */
function useWholeDetail(s: ReaderSignal, on = true) {
  const feedCut = on && /…\s*$/.test(s.detail_md ?? "");
  const { data, error, retry } = useQueryNoThrow(api.signals.detailForWeb, feedCut ? { signal: s._id as Id<"signals"> } : "skip");
  return { whole: typeof data === "string" ? data : null, cut: on ? findingCut(s.detail_md, { data, error: !!error }) : null, retry };
}
type WholeDetail = ReturnType<typeof useWholeDetail>;

function WholeText({ signal: s, blocks, said, whole: w }: { signal: ReaderSignal; blocks: ReturnType<typeof findingBlocks>; said: string; whole: WholeDetail }) {
  const { whole, cut } = w;
  const shown = useMemo(() => (whole ? findingBlocks({ ...s, detail_md: whole }).filter((b) => norm(b.text) !== norm(said)) : blocks), [whole, s, blocks, said]);
  return <>
    <FindingText blocks={shown} source={s.source} />
    {cut && (
      <p className="fr-cut" data-line-finding-cut={cut.kind}>
        <span>{findingCutWords(cut, s.evidence_url)}</span>
        {cut.kind === "failed" && <button type="button" className="lw-link" onClick={w.retry}>Try again</button>}
        {cut.kind !== "loading" && s.evidence_url && (
          <a className="lw-link fr-link" href={s.evidence_url} target="_blank" rel="noreferrer" data-line-finding-link>
            {evidenceLinkWords(s.evidence_url)}<ArrowUpRight className="w-3 h-3" aria-hidden />
          </a>
        )}
      </p>
    )}
  </>;
}

/** "Make this a problem" (LJ9 item 9): a finding nothing filed becomes a problem of its own, with every finding held
 *  under its key; the button turns into the problem it opened. */
function MakeProblem({ signal: s }: { signal: ReaderSignal }) {
  const nav = useLineNav();
  const [state, setState] = useState<"idle" | "making" | { ref: string | null; id: string } | { error: string }>("idle");
  const make = () => {
    setState("making");
    useInboxStore.getState().makeProblemOfFinding(s._id)
      .then((r) => setState(r ? { ref: r.task_short_id, id: r.task_id } : { error: "The server did not answer" }))
      .catch((e: unknown) => setState({ error: (e instanceof Error ? e.message : String(e)).replace(/^.*ConvexError:\s*/, "").split("\n")[0] || "The server refused it" }));
  };
  if (typeof state === "object" && "id" in state) {
    return <button type="button" className="lw-link" onClick={() => nav?.openCase?.(state.id)} data-line-finding-made={state.ref ?? state.id}>Filed to {state.ref ?? "a new problem"}</button>;
  }
  return (
    <>
      {typeof state === "object" && <span className="lw-act-error" role="alert">{state.error}</span>}
      <button type="button" className="lw-act" disabled={state === "making"} onClick={make} data-line-make-problem={s.short_id ?? s._id}>{state === "making" ? "Making it a problem" : "Make this a problem"}</button>
    </>
  );
}

/** What a quote in a finding is, as its caption says it: the words the finder read, by where it read them. A
 *  conversation judge quotes a message from the conversation; Union's desk quotes the expert who ruled; other finders
 *  quote whoever they name. */
export const quoteSource = (source: string | null | undefined): string => (source === "agentwatch" ? "Quoted from the conversation" : source === "union.desk" ? "The expert's words" : source === "union.escalation" ? "The escalation, as sent" : "Quoted");

/** A finding's words; a call it names by id is a pill that opens the call in its app. Each quote says what it is. */
function FindingText({ blocks, source }: { blocks: ReturnType<typeof findingBlocks>; source?: string | null }) {
  // Slack markup a finding quotes reads as names and links: a person by the team's Slack roster, else the name Slack
  // wrote beside the id, else "someone" (an id from another workspace names no one a reader knows).
  const people = useInboxStore((st) => (st as { chatSlackPeople?: Record<string, { name?: string; real_name?: string }> }).chatSlackPeople);
  const words = (text: string) => slackParts(text).flatMap((sp, j) => {
    if (typeof sp !== "string") {
      if ("link" in sp) return [<a key={`s${j}`} className="lw-link" href={sp.link} target="_blank" rel="noreferrer">{sp.label}</a>];
      const who = people?.[sp.mention];
      return [<b key={`s${j}`}>@{who?.real_name || who?.name || sp.name || "someone"}</b>];
    }
    return textWithCalls(sp).map((part, i) => typeof part === "string" ? part : <ProductViewPill key={`${j}-${i}`} viewRef={part} />);
  });
  return (
    <div className="fr-text">
      {blocks.map((b, i) => b.kind === "quote" ? <figure key={i} className="fr-quote"><figcaption>{b.from ?? quoteSource(source)}</figcaption><blockquote>{words(b.text)}</blockquote></figure> : b.kind === "code" ? <pre key={i}>{b.text}</pre> : <p key={i}>{words(b.text)}</p>)}
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

/** "Not this problem": the finding (and its problem's findings under the same key) leaves for a problem of its own,
 *  through the one review every consequential act goes through. It leaves this page at once. */
function NotThisProblem({ signal: s, problem, count, left, misfiled }: { signal: ReaderSignal; problem: string; count: number; left: number; misfiled?: boolean }) {
  const [reviewing, setReviewing] = useState(false);
  const ledger = useMemo(() => moveFindingLedger({ problem, count, left }), [problem, count, left]);
  return (
    <>
      <button type="button" className="lw-act" data-primary={misfiled ? "" : undefined} aria-haspopup="dialog" onClick={() => setReviewing(true)} data-line-not-this-problem={s.short_id ?? s._id}>{misfiled ? "Move to its own problem…" : "Not this problem…"}</button>
      {reviewing && <SwitchReview ledger={ledger} onClose={() => setReviewing(false)} onConfirm={() => { setReviewing(false); void useInboxStore.getState().moveFindingOut(s._id); }} />}
    </>
  );
}

