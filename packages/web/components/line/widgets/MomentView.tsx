"use client";
// The moment a codecast judge read (learning-loop.md LL8, line-workspace.md
// LW1, line-journeys.md LJ6.3), shown as the people in it saw it: its header
// (kind, subject, time), the product's own screen of it when the app frames
// one (a conversation, a match), and the conversation itself, its messages as
// messages with quoted email history folded, opened on the line the judge
// flagged with the judge's one-sentence reason beside it. What only the
// grader read (the facts and notes it was handed, every judge's run, the
// ids) sits behind one "What the judge saw" disclosure.
import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { useInboxStore } from "../../../store/inboxStore";
import { useAction } from "convex/react";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ExternalLink } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import type { MomentBlock, MomentRecord } from "@codecast/shared/contracts/moments";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { deliveryBadge, isoToWords } from "../../../lib/line/momentWords";
import { momentViewRef } from "../../../lib/productViewRefs";
import { ProductView } from "./ProductView";
import { ReviewSession } from "../workspace/stages/AgentReviews";
import "./momentView.css";

type MomentRow = NonNullable<FunctionReturnType<typeof api.lineMoments.momentForWeb>>;
type Run = MomentRow["runs"][number];

/** Bodies already read this page load, by viewer and moment: a moment reopened paints at once, and a body read under
 *  one account is never served to the next (the cache empties when the viewer changes). */
const bodies = new Map<string, Promise<MomentRecord | null>>();
let bodiesOf: string | null = null;

function useMomentBody(moment: string, kept: boolean): { body: MomentRecord | null; loading: boolean } {
  const read = useAction(api.lineMoments.momentBodyForWeb);
  const viewer = useInboxStore((s) => s.currentUser?._id?.toString?.() ?? null);
  const [state, setState] = useState<{ key: string; body: MomentRecord | null } | null>(null);
  useWatchEffect(() => {
    if (!kept || !viewer) return;
    if (bodiesOf !== viewer) { bodies.clear(); bodiesOf = viewer; }
    let live = true;
    const key = `${viewer}:${moment}`;
    let p = bodies.get(key);
    if (!p) {
      p = read({ moment }).catch(() => null);
      bodies.set(key, p);
      // A failed read is not remembered: the next open asks again.
      void p.then((b) => { if (!b) bodies.delete(key); });
    }
    void p.then((body) => { if (live) setState({ key: moment, body }); });
    return () => { live = false; };
  }, [moment, kept, viewer]);
  const body = state?.key === moment ? state.body : null;
  return { body, loading: kept && state?.key !== moment };
}

const time = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** `text` laid out for loose matching (curly quotes straight, whitespace single, lower case), with each of its
 *  characters' place in `text`, so a match found loosely marks the original span. */
function looseMap(text: string): { norm: string; at: number[] } {
  let norm = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text[i].replace(/[\u2018\u2019]/, "'").replace(/[\u201c\u201d]/, '"').toLowerCase();
    if (/\s/.test(c)) { if (norm.endsWith(" ")) continue; c = " "; }
    norm += c;
    at.push(i);
  }
  return { norm, at };
}

/** `text` with every quoted span marked, matched the way flaggedBlock finds the block (loose: quotes, whitespace and
 *  case aside; a long quote by its first 80 characters), so the block it opens on always shows its mark. A quote
 *  shorter than 4 characters marks nothing, and of two spans that overlap the earlier one is kept whole. */
export function marked(text: string, quotes: ReadonlyArray<string>): ReactNode {
  const spans: Array<[number, number]> = [];
  const { norm, at } = looseMap(text);
  for (const raw of quotes) {
    const whole = loose(raw);
    if (whole.length < 4) continue;
    const q = norm.includes(whole) ? whole : whole.slice(0, 80);
    for (let i = norm.indexOf(q); i >= 0; i = norm.indexOf(q, i + q.length)) spans.push([at[i], at[i + q.length - 1] + 1]);
  }
  if (!spans.length) return text;
  spans.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let pos = 0;
  for (const [s0, e] of spans) {
    if (s0 < pos) continue;
    if (s0 > pos) out.push(text.slice(pos, s0));
    out.push(<mark key={s0} className="mv-mark">{text.slice(s0, e)}</mark>);
    pos = e;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

/** How a message is tied to a match, from the tag that leads its body: the email that set the link, a later one on a
 *  thread that only inherits it, or a reply on the match's own introduction thread. */
export type MatchTie = "about" | "thread" | "intro";
const MATCH_TAGS: ReadonlyArray<[MatchTie, RegExp]> = [
  ["about", /^\[About the match with (.+?) \(match ([0-9a-f]+)\)\]\s*/i],
  ["thread", /^\[On a thread linked on \d{4}-\d{2}-\d{2} to the match with (.+?) \(match ([0-9a-f]+)\); this message only inherits the link\]\s*/i],
  ["intro", /^\[On the introduction thread of the match with (.+?) \(match ([0-9a-f]+)\), introduced \d{4}-\d{2}-\d{2}\]\s*/i],
];
const TIE_WORD: Record<MatchTie, string> = { about: "match", thread: "thread", intro: "intro thread" };
const TIE_TITLE: Record<MatchTie, string> = { about: "This message is about the match", thread: "On a thread linked to the match: it only inherits the link", intro: "A reply on the match's introduction thread" };

/** The match tag a message's body leads with, and the words after it. */
export function matchTag(body: string): { match: string | null; id: string | null; tie: MatchTie | null; rest: string } {
  for (const [tie, re] of MATCH_TAGS) {
    const m = re.exec(body);
    if (m) return { match: m[1], id: m[2], tie, rest: body.slice(m[0].length) };
  }
  return { match: null, id: null, tie: null, rest: body };
}

/** Where an email's quoted history starts: a "On <date>, <who> wrote:" line, a quoted ("> ") line, an "Original
 *  Message" rule, or a reply flattened onto one line ("... > > ..."). -1 when it quotes nothing, or is all quote. */
export function quotedFrom(body: string): number {
  const at = [
    /(?:^|\n|\s)(On [^\n]{4,200}? wrote:)/.exec(body),
    /(?:^|\n)([ \t]*>)/.exec(body),
    /(-{2,}\s*Original Message\s*-{2,})/i.exec(body),
    /(\s>\s?>\s)/.exec(body),
  ].flatMap((m) => (m ? [m.index + m[0].indexOf(m[1])] : []));
  const i = at.length ? Math.min(...at) : -1;
  return i > 0 && body.slice(0, i).trim() ? i : -1;
}

/** A message's body: its own words, and the history it quotes folded under one toggle (open when a judge quoted from it). */
function MessageBody({ body, quotes }: { body: string; quotes: ReadonlyArray<string> }) {
  const at = quotedFrom(body);
  const quoted = at > 0 ? body.slice(at).replace(/^[ \t]*(?:>[ \t]?)+/gm, "").replace(/\s>\s?(?=>|\S)/g, "\n").trim() : "";
  const cites = quoted ? quotes.some((q) => loose(q).length >= 4 && loose(quoted).includes(loose(q).slice(0, 80))) : false;
  const [open, setOpen] = useState(cites);
  if (!quoted) return <div className="mv-msg-body">{marked(body, quotes)}</div>;
  return (
    <div className="mv-msg-body">
      {marked(body.slice(0, at).trimEnd(), quotes)}
      <button type="button" className="mv-quoted-t" aria-expanded={open} onClick={() => setOpen(!open)} data-line-moment-quoted>{open ? "Hide quoted history" : "Quoted history"}</button>
      {open && <div className="mv-quoted">{marked(quoted, quotes)}</div>}
    </div>
  );
}

function Block({ b, quotes, prior }: { b: MomentBlock; quotes: ReadonlyArray<string>; prior?: boolean }) {
  if (b.type === "message") {
    const In = b.direction === "in";
    const badge = deliveryBadge(b.delivery);
    const tag = matchTag(b.body);
    return (
      <div className="mv-msg" data-dir={b.direction} data-prior={prior ? "" : undefined}>
        <div className="mv-msg-meta">
          {In ? <ArrowDownLeft aria-hidden /> : <ArrowUpRight aria-hidden />}
          <b>{b.sender ?? (In ? "customer" : "product")}</b>
          <span>{b.channel}</span>
          <span className="lw-num">{clock(b.at)}</span>
          {badge && <span className="mv-deliv-badge" data-tone={badge.tone} title={b.delivery}>{badge.words}</span>}
          {tag.match && tag.tie && <span className="mv-ref" data-tie={tag.tie} title={`${TIE_TITLE[tag.tie]} (match ${tag.id})`}><i>{TIE_WORD[tag.tie]}</i>{tag.match}</span>}
        </div>
        <MessageBody body={tag.rest} quotes={quotes} />
      </div>
    );
  }
  if (b.type === "facts") {
    return (
      <div className="mv-block">
        {b.title && <h5 className="mv-bt">{b.title}</h5>}
        <dl className="mv-facts">
          {b.facts.map((f, i) => <div key={i}><dt>{f.label}</dt><dd>{marked(isoToWords(f.value), quotes)}</dd></div>)}
        </dl>
      </div>
    );
  }
  return (
    <div className="mv-block">
      {b.title && <h5 className="mv-bt">{b.title}</h5>}
      <pre className="mv-text">{marked(isoToWords(b.text), quotes)}</pre>
    </div>
  );
}

/** A block's words, for finding a quote in it. */
const blockText = (b: MomentBlock) => (b.type === "message" ? b.body : b.type === "facts" ? b.facts.map((f) => f.value).join("\n") : b.text);
/** Quotes and bodies compared loosely: curly quotes straight, whitespace single. */
const loose = (t: string) => t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();

/** The block a judge flagged: the first holding one of `quotes` (the cited finding's first), else -1. */
export function flaggedBlock(blocks: ReadonlyArray<MomentBlock>, quotes: ReadonlyArray<string>): number {
  const qs = quotes.map(loose).filter((q) => q.length >= 4).map((q) => q.slice(0, 80));
  if (!qs.length) return -1;
  const texts = blocks.map((b) => loose(blockText(b)));
  for (const q of qs) {
    const i = texts.findIndex((t) => t.includes(q));
    if (i >= 0) return i;
  }
  return -1;
}

/** Looks like a machine id (a UUID, a long hex or base32 key): kept behind the ids toggle. */
/** A value a person cannot read: an id, a hash, a slug ("72298db", "ex-agentwatch-trial-3"). Words have spaces. */
const isMachineId = (v: string) => !/\s/.test(v.trim());
/** A machine word as a person says it: "contact-conversation" reads "Contact conversation", "email_sent" "email sent". */
const plainWords = (v: string) => v.replace(/[-_]+/g, " ").trim();

const sevTone = (s: number) => (s >= 7 ? "hi" : s >= 4 ? "mid" : "lo");

function RunLine({ r, cited, above }: { r: Run; cited?: string | null; above?: { judge: string; quote?: string | null; expectation: string } | null }) {
  const verdict = r.status !== "ok" ? r.status : r.findings.length ? `${r.findings.length} miss${r.findings.length === 1 ? "" : "es"}` : "met";
  const tone = r.status === "failed" ? "bad" : r.status === "skipped" ? "none" : r.findings.length ? "warn" : "ok";
  return (
    <div className="mv-run" data-line-moment-run={r.judge}>
      <div className="mv-run-h">
        <b>{r.judge}</b>
        <span className="mv-dim" title={`version ${r.judge_version}`}>{r.judge_version.slice(0, 7)}</span>
        {r.mode === "shadow" && <span className="mv-chip">shadow</span>}
        <span className="mv-verdict" data-tone={tone}>{verdict}</span>
        {r.filed > 0 && <span className="mv-dim">{r.filed} filed</span>}
        {r.reason && <span className="mv-reason" title={r.reason}>{r.reason}</span>}
        <span className="mv-sp" />
        <span className="mv-dim" title={`${r.model}, $${r.cost_usd.toFixed(4)}`}>{time(r.at)}</span>
      </div>
      {r.findings.length > 0 && (
        <ul className="mv-cites">
          {r.findings.map((f, i) => above && above.judge === r.judge && above.expectation === f.expectation && above.quote === f.quote ? (
            <li key={i} className="mv-above" data-cited={cited && f.expectation === cited ? "" : undefined}>
              <span className="mv-sev" data-tone={sevTone(f.severity)}>{f.severity}</span>
              <code className="mv-exp">{f.expectation}</code>
              <span className="mv-dim">on the flagged message</span>
            </li>
          ) : (
            <li key={i} data-cited={cited && f.expectation === cited ? "" : undefined}>
              <span className="mv-sev" data-tone={sevTone(f.severity)}>{f.severity}</span>
              <code className="mv-exp">{f.expectation}</code>
              <span className="mv-what">{f.what_happened}</span>
              {f.quote && <q className="mv-quote">{f.quote}</q>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The conversation a moment carries as text (a match's parties and their conversations with Union, one block each):
 *  the block holding the judged words, else the first conversation block; null when the moment carries messages or no
 *  such block. */
export function conversationBlock(blocks: ReadonlyArray<MomentBlock>, quotes: ReadonlyArray<string>): MomentBlock | null {
  if (blocks.some((b) => b.type === "message")) return null;
  const at = flaggedBlock(blocks, quotes);
  const b = at >= 0 ? blocks[at] : blocks.find((x) => x.type === "text" && /conversation/i.test(x.title ?? ""));
  return b && b.type === "text" ? b : null;
}

/** A conversation carried as text, whole, in its own scroller opened at the first judged words. */
function ConversationText({ b, quotes }: { b: Extract<MomentBlock, { type: "text" }>; quotes: ReadonlyArray<string> }) {
  const box = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    const el = box.current;
    const m = el?.querySelector<HTMLElement>(".mv-mark");
    if (el && m) el.scrollTop = Math.max(0, m.offsetTop - 80);
  }, [b, quotes]);
  return (
    <div className="mv-block" data-line-moment-conversation>
      {b.title && <h5 className="mv-bt">{b.title}</h5>}
      <div ref={box} className="mv-conv" style={{ position: "relative", maxHeight: 420, overflow: "auto" }}>
        <pre className="mv-text">{marked(isoToWords(b.text), quotes)}</pre>
      </div>
    </div>
  );
}

export type MomentViewProps = {
  /** The moment's short id (mo-N), as the finding carries it. */
  moment: string;
  /** The expectation the finding being read cites: its line in the judge runs is lit. */
  cited?: string | null;
  /** Folded height in px; Expand shows the whole. */
  foldAt?: number;
};

export const MomentView = memo(function MomentView({ moment, cited, foldAt = 300 }: MomentViewProps) {
  const { data: m, error } = useQueryNoThrow(api.lineMoments.momentForWeb, { moment });
  // Kept means a body was stored and is still inside its 30 days, judged on this clock: the query's own would go stale.
  const now = useCoarseNow(60_000);
  const expired = !!m?.kept && m.body_expires_at != null && m.body_expires_at <= now;
  const kept = !!m?.kept && !expired;
  const { body, loading } = useMomentBody(moment, kept);
  const [open, setOpen] = useState(false);
  const [saw, setSaw] = useState(false);
  // An agent judge's review session opened in place: its transcript, both turns.
  const [session, setSession] = useState<string | null>(null);
  // A backend from before agent reviews answers without the list.
  const reviews = m?.reviews ?? [];
  // The cited finding's own quote leads, so the block opened on is the one this finding is about.
  const flags = useMemo(() => {
    const all = (m?.runs ?? []).flatMap((r) => r.findings.map((f) => ({ ...f, judge: r.judge })));
    return [...all.filter((f) => cited && f.expectation === cited), ...all.filter((f) => !cited || f.expectation !== cited)];
  }, [m, cited]);
  const quotes = useMemo(() => flags.map((f) => f.quote).filter((q): q is string => !!q), [flags]);
  const blocks = body?.blocks ?? [];
  // The conversation as people saw it: the messages. The facts and notes beside them were the judge's context.
  const messages = useMemo(() => blocks.filter((b) => b.type === "message"), [blocks]);
  // A moment carried as text has its conversation in one of those blocks: that block is the thing, shown whole.
  const textual = useMemo(() => conversationBlock(blocks, quotes), [blocks, quotes]);
  const context = useMemo(() => blocks.filter((b) => b.type !== "message" && b !== textual), [blocks, textual]);
  const flagged = useMemo(() => flaggedBlock(messages, quotes), [messages, quotes]);
  // The judge's reason: on the flagged message when it quoted one, else the cited finding's on its own.
  const verdict = (flagged >= 0 ? flags.find((f) => f.quote && loose(blockText(messages[flagged])).includes(loose(f.quote).slice(0, 80))) : null) ?? flags[0] ?? null;
  const flagRef = useRef<HTMLDivElement>(null);
  useWatchEffect(() => { if (open && flagged >= 0) flagRef.current?.scrollIntoView?.({ block: "center" }); }, [open, flagged]);

  if (m === undefined && !error) return <div className="mv" data-line-moment="reading"><span className="mv-dim"><span className="lw-spin" aria-hidden /> {moment}</span></div>;
  if (!m) return <div className="mv" data-line-moment="none"><span className="mv-dim">{moment} not readable here</span></div>;

  const asOf = body?.at ?? m.event_at;
  // The subject as the product itself renders it, as of the moment (Union's conversation or match page), above our text.
  const appView = momentViewRef({ source: m.source, kind: m.kind, subject: m.subject, at: asOf });
  const links = (body?.refs ?? []).filter((r) => r.url || r.id !== m.subject);
  // The event's refs, less what the header and the body's own refs already say; its `trigger` leads.
  const said = new Set([m.subject, ...links.map((r) => r.id)]);
  const named = m.refs.trigger ?? null;
  const trigger = Object.entries(m.refs).filter(([k, val]) => k !== "trigger" && k !== "as_of" && !said.has(val));
  const held = m.status !== "ready" ? m.status : !kept ? (m.storage === "host" && !m.kept ? "body on host" : "body expired") : null;
  const subjectReads = !isMachineId(m.subject);
  // Folded on the flagged message: one above and one below, the rest counted.
  const from = flagged >= 0 ? Math.max(0, flagged - 1) : 0;
  const to = flagged >= 0 ? Math.min(messages.length, flagged + 2) : messages.length;
  const shown = open || flagged < 0 ? messages.map((b, i) => [b, i] as const) : messages.slice(from, to).map((b, i) => [b, from + i] as const);
  const why = verdict && (
    <div className="mv-flag-why" data-line-moment-why>
      <span className="mv-sev" data-tone={sevTone(verdict.severity)}>{verdict.severity}</span>
      <span className="mv-what"><b>{verdict.judge}</b> {verdict.what_happened}{flagged < 0 && verdict.quote ? <> <q className="mv-quote">{verdict.quote}</q></> : null}</span>
    </div>
  );
  return (
    <div className="mv" data-line-moment={m.short_id}>
      <div className="mv-head">
        <span className="mv-kind">{plainWords(m.kind).replace(/^\w/, (c) => c.toUpperCase())}</span>
        {subjectReads && <b className="mv-subject" title={m.subject}>{m.subject}</b>}
        {named && <b className="mv-trig-name" title="What woke the judge">{plainWords(named)}</b>}
        <span className="lw-num" title={`As of ${new Date(asOf).toLocaleString()}`}>{time(asOf)}</span>
        {links.filter((r) => r.url).map((r) => <a key={`${r.label}:${r.id}`} className="mv-ref" href={r.url!} target="_blank" rel="noreferrer" title={r.id}>{r.label}<ExternalLink aria-hidden /></a>)}
      </div>

      {/* Our own text of the moment below is the thing: an app view that cannot be framed says nothing over it. */}
      {appView && <ProductView viewRef={appView} hideWhenNone hideWhenUnframed={!held && !!body} />}

      {held ? (
        <div className="mv-held" data-state={m.status}>{held}{m.error ? `: ${m.error}` : ""}</div>
      ) : loading ? (
        <div className="mv-held"><span className="lw-spin" aria-hidden /> Reading the conversation</div>
      ) : !body ? (
        <div className="mv-held">{m.body_expires_at != null && m.body_expires_at <= now ? "body expired" : "body unreadable"}</div>
      ) : textual?.type === "text" ? (
        <div className="mv-body-wrap" data-open="">
          <ConversationText b={textual} quotes={quotes} />
          {why}
        </div>
      ) : messages.length > 0 ? (
        <div className="mv-body-wrap" data-open={open || flagged >= 0 ? "" : undefined}>
          <div className="mv-body" style={open || flagged >= 0 ? (open ? { maxHeight: 640, overflow: "auto" } : undefined) : { maxHeight: foldAt }}>
            {!open && flagged >= 0 && from > 0 && <button type="button" className="mv-more" onClick={() => setOpen(true)}>{from} earlier</button>}
            {shown.map(([b, i]) => i === flagged ? (
              <div key={i} ref={flagRef} className="mv-flag" data-line-moment-flagged>
                <Block b={b} quotes={quotes} />
                {why}
              </div>
            ) : <Block key={i} b={b} quotes={quotes} prior={!open && i < flagged} />)}
            {!open && flagged >= 0 && to < messages.length && <button type="button" className="mv-more" onClick={() => setOpen(true)}>{messages.length - to} later</button>}
          </div>
          {flagged < 0 && why}
          {(messages.length > to - from || open) && (
            <button type="button" className="mv-expand" onClick={() => setOpen(!open)} aria-expanded={open}>
              <ChevronDown aria-hidden />{open ? "Fold" : `All ${messages.length} messages`}
            </button>
          )}
        </div>
      ) : why}

      {/* What only the grader read: the facts and notes it was handed, every judge's run, the ids. */}
      <button type="button" className="mv-saw-t" aria-expanded={saw} onClick={() => setSaw(!saw)} data-line-moment-saw-toggle>
        <ChevronDown aria-hidden />What the judge saw
      </button>
      {saw && (
        <div className="mv-saw" data-line-moment-saw>
          {context.length > 0 && (
            <div className="mv-body mv-context">
              {context.map((b, i) => <Block key={i} b={b} quotes={quotes} />)}
            </div>
          )}
          {reviews.length > 0 && (session ? <ReviewSession review={session} back="Moment" onBack={() => setSession(null)} /> : (
            <div className="mv-runs" data-line-moment-reviews={reviews.length}>
              {reviews.map((r) => (
                <div key={r.review} className="mv-run mv-run-h">
                  <span className="mv-ref"><i>review</i>{r.review}</span>
                  <span>{r.judge}</span>
                  <span className="mv-dim">{r.status === "done" ? `${r.findings ?? 0} found${r.took_ms ? ` · ${(r.took_ms / 60_000).toFixed(1)} min` : ""}` : r.status}</span>
                  {r.transcript && <button type="button" className="lw-chip" onClick={() => setSession(r.review)} data-line-moment-review-open={r.review}>Open session</button>}
                </div>
              ))}
            </div>
          ))}
          {m.runs.length > 0 && (
            <div className="mv-runs" data-line-moment-runs={m.runs.length}>
              {m.runs.map((r, i) => <RunLine key={i} r={r} cited={cited} above={flagged >= 0 ? verdict : null} />)}
            </div>
          )}
          <div className="mv-trig" data-line-moment-ids>
            <span className="mv-ref"><i>moment</i>{m.short_id}</span>
            {m.source && <span className="mv-ref"><i>source</i>{m.source}</span>}
            <span className="mv-ref"><i>subject</i>{m.subject}</span>
            {trigger.map(([k, val]) => <span key={k} className="mv-ref"><i>{k}</i>{val}</span>)}
            {links.filter((r) => !r.url).map((r) => <span key={`${r.label}:${r.id}`} className="mv-ref"><i>{r.label}</i>{r.id}</span>)}
            {m.gap_ms != null && m.gap_ms > 60_000 && <span className="mv-dim" title="How long after the newest event the facts were read">read +{Math.round(m.gap_ms / 60_000)}m</span>}
            {m.events > 1 && <span className="mv-dim">{m.events} events</span>}
          </div>
        </div>
      )}
    </div>
  );
});
