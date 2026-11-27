"use client";
// The priority change card (plan pl-1131): a priorities pass proposes every
// change to the person's priorities on one decision, and this draws it. One
// grid holds every line (rank gutter | icon | text | checkbox), so a
// priority's header and its change rows line up and nothing zigzags. Each row
// is one click to tick or untick; the answers below are the proposal's own
// option rows. Presentational: the caller owns the ticks and the answer.
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowDown, ArrowUp, CheckCheck, CircleCheck, CircleDot, CircleX, Flag, GitMerge, PenLine, Plus, Quote, RotateCcw, Sparkles, SquarePlus, Target,
  type LucideIcon,
} from "lucide-react";
import {
  CHANGE_NAME, CHANGE_PREFIX,
  type PriorityCard, type PriorityCardGroup, type PriorityChange, type PriorityChangeKind, type PriorityEvidence, type PriorityWordsRow,
} from "@codecast/shared/contracts/priorityCard";
import type { DecisionOption } from "../../store/inboxStore";
import { DecisionOptionList } from "./DecisionOptionList";
import { acceptLabel, toggleTicked } from "../../lib/priorityCardTicks";
import { priorityCardHeadline } from "../../lib/priorityCardDecision";
import { MilestoneMark } from "../priorities/parts";
import { TooltipProvider } from "../ui/tooltip";
import { LegendButton, Mark } from "../Mark";
import { changeMarkId } from "../../lib/marks/changes";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import "./changeCard.css";
import "./priorityCard.css";

export type PriorityCardAnswer = { kind: "accept"; ids: string[] } | { kind: "none" } | { kind: "text"; text: string };

/**
 * How the card was answered: which answer (some changes accepted, none, or the
 * person's own words instead), the changes that landed, and the person's words
 * with the change they were about, when known.
 */
export type PriorityCardAnswered = { kind: "accept" | "none" | "text"; ids: string[]; text?: string; about?: string; at?: number };

/** One icon per kind, toned by what it does. A move points the way it goes. */
const ICON: Record<PriorityChangeKind, { icon: LucideIcon; tone: string }> = {
  move: { icon: ArrowUp, tone: "up" },
  rename: { icon: PenLine, tone: "edit" },
  new_priority: { icon: SquarePlus, tone: "new" },
  done: { icon: CheckCheck, tone: "up" },
  reopen: { icon: RotateCcw, tone: "down" },
  serves: { icon: Target, tone: "blue" },
  merge: { icon: GitMerge, tone: "edit" },
  new_milestone: { icon: Plus, tone: "new" },
  rename_milestone: { icon: PenLine, tone: "edit" },
  milestone_done: { icon: CircleCheck, tone: "up" },
  milestone_reopen: { icon: RotateCcw, tone: "down" },
  to_critical: { icon: Flag, tone: "edit" },
  to_polish: { icon: Sparkles, tone: "mute" },
  drop_milestone: { icon: CircleX, tone: "red" },
};

const movesDown = (c: PriorityChange) => c.kind === "move" && Number(c.to) > Number(c.from);

function iconOf(c: PriorityChange) {
  if (movesDown(c)) return { icon: ArrowDown, tone: "down" };
  return ICON[c.kind];
}

const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
/** A time on the reference day reads as the clock alone, one in the week before leads with its weekday, an older one is a date. */
function when(at: number, ref: number) {
  if (sameDay(at, ref)) return timeFmt.format(at);
  return Math.abs(ref - at) < 6 * 86_400_000 ? `${dayFmt.format(at)} ${timeFmt.format(at)}` : dateFmt.format(at);
}

/** An existing thing the row names (a milestone, a priority, an initiative): an outlined chip, never plain text. */
function Chip({ title, state }: { title: string; state?: "open" | "done" }) {
  return (
    <span className="pcc-chip" data-pcc-chip>
      {state && <MilestoneMark done={state === "done"} />}
      <span className="pcc-chip-title">{title}</span>
    </span>
  );
}

/** What the row says after its prefix: plain words describe the change, chips name what already exists. */
function rowBody(c: PriorityChange, card: PriorityCard): ReactNode {
  const ms = c.milestone ? <Chip title={c.milestone.title} state={c.milestone.state} /> : null;
  switch (c.kind) {
    case "move": return `to #${c.to} from #${c.from}`;
    case "rename": return `${c.to}`;
    case "new_priority": return c.to == null ? "New priority" : `New priority at #${c.to}`;
    case "done": case "reopen": return card.groups.find((g) => g.priority === c.priority)?.title ?? c.priority;
    case "serves": return c.to ? <><Chip title={String(c.to)} />{c.from ? <> instead of <Chip title={String(c.from)} /></> : null}</> : "no goal";
    case "merge": return <>absorbs <Chip title={String(c.from ?? c.target ?? "")} /></>;
    case "new_milestone": return `${c.to}`;
    case "rename_milestone": return <>{ms ?? <Chip title={String(c.from)} />} → {`${c.to}`}</>;
    default: return ms ?? "";
  }
}

function Evidence({ e, runAt }: { e: PriorityEvidence; runAt: number }) {
  if (e.kind === "quote") {
    return (
      <div className="pcc-ev" data-pcc-evidence="quote">
        <em className="pcc-ev-text">"{e.text}"</em>{" "}
        <span className="pcc-ev-meta">You · <span title={e.session}>{e.session_title}</span> · <span className="pcc-ev-at">{when(e.at, runAt)}</span></span>
      </div>
    );
  }
  return (
    <div className="pcc-ev is-event" data-pcc-evidence="event">
      <span className="pcc-ev-text">{e.text}</span>
      {e.ref && <> <span className="pcc-ev-ref">{e.ref}</span></>}
      {e.at !== undefined && <span className="pcc-ev-meta"> · <span className="pcc-ev-at">{when(e.at, runAt)}</span></span>}
    </div>
  );
}

function ChangeRow({ c, card, on, quotes, onToggle, after }: {
  c: PriorityChange;
  card: PriorityCard;
  on: boolean;
  quotes: boolean;
  /** Absent once answered: the row is a record, not a control. */
  onToggle?: () => void;
  /** What sits under the row besides its evidence (the person's correction, once answered). */
  after?: ReactNode;
}) {
  const { icon: Icon, tone } = iconOf(c);
  const prefix = CHANGE_PREFIX[c.kind];
  const press = (e: KeyboardEvent) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); onToggle?.(); }
  };
  return (
    <div
      className={`pcc-row ${on ? "" : "is-off"}`}
      data-pcc-row={c.id}
      data-kind={c.kind}
      {...(onToggle ? { role: "checkbox", "aria-checked": on, tabIndex: 0, onClick: onToggle, onKeyDown: press } : {})}
    >
      <Mark id={changeMarkId(c.kind, movesDown(c))} side="left">
        <span className={`pcc-icon pcc-tone-${tone}`} aria-label={CHANGE_NAME[c.kind]} data-pcc-icon><Icon aria-hidden /></span>
      </Mark>
      <div className="pcc-text">
        <span className="pcc-line" data-pcc-line>
          {prefix && <b className="pcc-prefix">{prefix}:</b>}{prefix && " "}{rowBody(c, card)}
        </span>
        {quotes && c.evidence.map((e, i) => <Evidence key={i} e={e} runAt={card.run.at} />)}
        {after}
      </div>
      {onToggle && <span className="pcc-box" aria-hidden data-pcc-box />}
    </div>
  );
}

function GroupHead({ g, card }: { g: PriorityCardGroup; card: PriorityCard }) {
  const isNew = g.rank === null && g.changes.some((id) => card.changes.find((c) => c.id === id)?.kind === "new_priority");
  return (
    <div className="pcc-head" data-pcc-group={g.priority}>
      <span className={`pcc-rank ${isNew ? "is-new" : ""}`}>{g.rank ?? (isNew ? "NEW" : "–")}</span>
      <span className="pcc-title">{g.title}</span>
    </div>
  );
}

type SortKey = "rank" | "title" | "share";
const pct = (share: number) => `${Math.round(share * 100)}%`;

/** Where the person's typing went, by priority; any header sorts. */
function WordsTable({ rows }: { rows: PriorityWordsRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "share", dir: -1 });
  const top = Math.max(0.01, ...rows.map((r) => r.share));
  const sorted = [...rows].sort((a, b) => {
    if (sort.key === "rank") {
      // Rows off the list keep to the bottom whichever way the column runs.
      if (a.rank === null || b.rank === null) return (a.rank === null ? 1 : 0) - (b.rank === null ? 1 : 0);
      return sort.dir * (a.rank - b.rank);
    }
    return sort.dir * (sort.key === "title" ? a.title.localeCompare(b.title) : a.share - b.share);
  });
  const head = (key: SortKey, label: string, className = "") => {
    const active = sort.key === key;
    return (
      <th className={`${className} ${active ? "is-on" : ""}`} aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
        <button type="button" data-pcc-sort={key} onClick={() => setSort(active ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: key === "share" ? -1 : 1 })}>
          {label}{active ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
        </button>
      </th>
    );
  };
  return (
    <section className="pcc-panel" data-pcc-words>
      <div className="pcc-panel-label">Where your words went</div>
      <table className="pcc-words">
        <thead><tr>{head("rank", "#")}{head("title", "Priority")}{head("share", "Share", "is-r")}</tr></thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.priority ?? `none-${i}`} className={r.rank !== null && r.share === 0 ? "is-warn" : ""} data-pcc-word={r.priority ?? "none"}>
              <td className="pcc-words-rank">{r.rank ?? "–"}</td>
              <td className="pcc-words-title" title={r.title}>{r.title}</td>
              <td className="pcc-words-share is-r">
                <span className="pcc-bar" aria-hidden><i className={r.priority ? "" : "is-none"} style={{ width: `${(r.share / top) * 100}%` }} /></span>{pct(r.share)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RunFacts({ run }: { run: PriorityCard["run"] }) {
  const facts: [string, ReactNode][] = [
    ["When", when(run.at, run.at)],
    ["Sessions read", run.sessions],
    ["Calls read", run.calls],
    ["Cost", `$${run.cost_usd.toFixed(2)}`],
    ["Runs today", run.runs_today],
    ["Runs since last card", run.runs_since_last_card],
  ];
  return (
    <dl className="pcc-facts" data-pcc-facts>
      {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && b.every((id) => a.includes(id));

/** The card's own answers, in the proposal's option rows; the third opens a box for the person's words. */
function Answers({ total, ticked, suggested, onAnswer, keys }: { total: number; ticked: string[]; suggested: string[]; onAnswer: (a: PriorityCardAnswer) => void; keys: boolean }) {
  const [writing, setWriting] = useState(false);
  // Uncontrolled: a keystroke here re-renders nothing.
  const box = useRef<HTMLTextAreaElement>(null);
  const options: DecisionOption[] = [
    // Nothing ticked: the first answer is held and says why, with no count and no suggestion.
    ticked.length === 0
      ? { label: "Accept" }
      // Suggested names the pass's own pick: only while the ticks are exactly the ones the card opened with.
      : { label: `${acceptLabel(ticked.length, total)}${sameIds(ticked, suggested) ? " (Suggested)" : ""}`, description: "They show on your priorities page now. Undo from there." },
    { label: "Accept none", description: "These merges won't be proposed again." },
    { label: "Something else…", description: "Say what the pass got wrong." },
  ];
  const send = () => {
    const text = box.current?.value.trim();
    if (text) onAnswer({ kind: "text", text });
  };
  return (
    <div className="pcc-answers" data-pcc-answers>
      <DecisionOptionList
        options={options}
        keys={keys}
        tone={(n) => (n === 0 ? "primary" : "plain")}
        held={(n) => (n === 0 && ticked.length === 0 ? "Nothing ticked" : undefined)}
        onPick={(n) => {
          if (n === 0) onAnswer({ kind: "accept", ids: ticked });
          else if (n === 1) onAnswer({ kind: "none" });
          else setWriting(true);
        }}
      />
      {writing && (
        <div className="pcc-write" data-pcc-write>
          <Textarea ref={box} autoFocus rows={3} placeholder="What should change instead?" />
          <div className="pcc-write-actions">
            <Button type="button" variant="ghost" size="sm" onClick={() => setWriting(false)}>Cancel</Button>
            <Button type="button" size="sm" onClick={send} data-pcc-send>Send</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Correction({ text, at, now }: { text: string; at?: number; now: number }) {
  return (
    <div className="pcc-ev" data-pcc-correction>
      <em className="pcc-ev-text">"{text}"</em>{" "}
      <span className="pcc-ev-meta">You{at !== undefined && <> · <span className="pcc-ev-at">{when(at, now)}</span></>}</span>
    </div>
  );
}


export function PriorityChangeCard({ card, ticked, onToggle, answered, onAnswer, question, context, keys = false, now = Date.now() }: {
  card: PriorityCard;
  /** The ticked change ids. */
  ticked: string[];
  /** The ticks after a row is pressed (cascade applied, card order), and the row pressed. */
  onToggle: (next: string[], id: string) => void;
  /** Set once the card is answered: the list becomes the record of what was accepted. */
  answered?: PriorityCardAnswered | null;
  onAnswer: (answer: PriorityCardAnswer) => void;
  /** The decision's question; the card's headline. */
  question?: string;
  /** One short line of case under the headline. */
  context?: string;
  /** Whether the digit keys answer on this surface (shows them as key caps). */
  keys?: boolean;
  /** The instant an answered card's times read against (today shows the clock alone). */
  now?: number;
}) {
  const [quotes, setQuotes] = useState(true);
  const byId = new Map(card.changes.map((c) => [c.id, c]));
  const total = card.changes.length;
  const accepted = new Set(answered ? answered.ids : ticked);
  // Answered in the person's own words: nothing was applied, and their words lead the card instead of a count.
  const corrected = answered?.kind === "text";
  // A correction beside accepted changes sits under the change it was about, else at the end of the list.
  const loose = !corrected && answered?.text && !(answered.about && byId.has(answered.about));

  const list = (
    <div className={`pcc-list ${answered ? "is-answered" : ""} ${corrected ? "is-unapplied" : ""}`} data-pcc-list>
      {corrected && <div className="pcc-list-label" data-pcc-unapplied>Not applied</div>}
      {card.groups.map((g) => (
        <section key={g.priority} className="pcc-group">
          <GroupHead g={g} card={card} />
          {g.changes.map((id) => {
            const c = byId.get(id);
            if (!c) return null;
            return (
              <ChangeRow
                key={id}
                c={c}
                card={card}
                on={corrected || accepted.has(id)}
                quotes={!answered && quotes}
                onToggle={answered ? undefined : () => onToggle(toggleTicked(card, ticked, id), id)}
                after={!corrected && answered?.text && answered.about === id ? <Correction text={answered.text} at={answered.at} now={now} /> : null}
              />
            );
          })}
        </section>
      ))}
      {loose && <div className="pcc-loose"><Correction text={answered!.text!} at={answered!.at} now={now} /></div>}
    </div>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <article className="pcc" data-priority-card data-answered={answered ? "" : undefined}>
        <div className="pcc-page">
          <div className="pcc-main">
            <div className="pcc-topline">
              <span className="pcc-kind"><CircleDot aria-hidden />Priorities pass</span>
              <span className="pcc-when" data-pcc-when>· {answered
                ? [answered.kind === "none" ? "accepted none" : "answered", answered.at !== undefined ? when(answered.at, now) : null].filter(Boolean).join(" ")
                : `${dayFmt.format(card.run.at)} ${timeFmt.format(card.run.at)}`}</span>
              <span className="pcc-spacer" />
              {!answered && (
                <button type="button" className={`pcc-quotes ${quotes ? "is-on" : ""}`} aria-pressed={quotes} onClick={() => setQuotes(!quotes)} data-pcc-quotes>
                  <Quote aria-hidden />Quotes
                </button>
              )}
              <LegendButton lead="Priorities pass" />
            </div>
            {answered ? (
              <>
                <h1 className="pcc-headline" data-card-headline>{priorityCardHeadline(answered, total)}</h1>
                {corrected && answered.text && <p className="pcc-case pcc-correction" data-pcc-correction>{answered.text}</p>}
              </>
            ) : (
              <>
                <h1 className="pcc-headline" data-card-headline>{question ?? "Should your priorities follow what you worked on?"}</h1>
                {context && <p className="pcc-case">{context}</p>}
              </>
            )}
            {list}
            {!answered && <Answers total={total} ticked={ticked} suggested={card.suggested} onAnswer={onAnswer} keys={keys} />}
          </div>
          {!answered && (
            <aside className="pcc-side">
              <WordsTable rows={card.words} />
              <RunFacts run={card.run} />
            </aside>
          )}
        </div>
      </article>
    </TooltipProvider>
  );
}
