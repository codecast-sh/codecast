"use client";

import { useState, type ReactNode } from "react";
import { Frame, Section, Tile } from "./kit";
import { BODY, DIM, INK, LINE, MUTED, SAND, SOL, TEXT, tint } from "./model";
import { ProposalsChart } from "./ProposalsChart";
import {
  counts, GREEN_WASH, metaWords, PROPOSALS_STYLE, RED_WASH, REPLY_TEXT, REVISION_NOTE, send, START, subjectsOf, trayWords, VIOLET,
  willApply, SUBJECTS, type Outcome, type Sid, type State, type Subject, type Verdict,
} from "./proposalsData";

/*
 * The proposal card from the Head of People, op-7, beside the chart it would
 * change. Approve stages an answer (the band with Undo), Reply asks the author
 * and gets an answer or a revision, and Send applies the approvals: the
 * chart's ghosts solidify and the rejected ones fade. Resting state is the
 * proposal open with nothing decided and every proposed change drawn.
 */

const CSS = PROPOSALS_STYLE;

/** What the author says back to a reply on each card; the move gets revised instead. */
const REPLIES: Record<Sid, { ask: string; answer?: string }> = {
  platform: { ask: "Who watches the daemon at night?", answer: "Head of Infrastructure keeps the pager. Platform owns the code and the releases." },
  move: { ask: REPLY_TEXT },
  area: { ask: "Why not Engineering?", answer: "Its tasks are copy and pricing tests. The two code changes it needs go to @eng as tasks." },
  filing: { ask: "Which two are done?", answer: "The two pricing page fixes. Both merged on Tuesday." },
};

const btn = "og-press inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium leading-none";

function Controls({ onAnswer, onReply, replying }: { onAnswer: (v: Verdict) => void; onReply: () => void; replying: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      <button type="button" className={`${btn} border`} style={{ borderColor: replying ? MUTED : LINE, color: TEXT, backgroundColor: replying ? tint(SAND, 60) : "transparent" }} aria-expanded={replying} onClick={onReply}>Reply</button>
      <button type="button" className={btn} style={{ color: MUTED }} onClick={() => onAnswer("reject")}>Reject</button>
      <button type="button" className={btn} style={{ backgroundColor: SOL.green, color: "#fffdf6" }} onClick={() => onAnswer("approve")}>Approve</button>
    </span>
  );
}

function Band({ verdict, waits, onUndo }: { verdict: Verdict; waits: boolean; onUndo: () => void }) {
  const ok = verdict === "approve";
  return (
    <div role="status" className="og-prop-in mt-2.5 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12.5px] leading-[18px]" style={{ backgroundColor: ok ? GREEN_WASH : RED_WASH }}>
      <span aria-hidden className="font-bold" style={{ color: ok ? SOL.green : SOL.red }}>{ok ? "✓" : "×"}</span>
      <span className="min-w-0 flex-1" style={{ color: BODY }}>
        <b style={{ color: ok ? SOL.green : SOL.red }}>{ok ? "Approved." : "Rejected."}</b>{" "}
        {ok ? (waits ? "Applies once Head of Platform is approved." : "Applies when you send.") : "Goes to Head of People when you send."}
      </span>
      <button type="button" className={`${btn} -mr-1.5 h-6 text-meta`} style={{ color: MUTED }} onClick={onUndo}>Undo</button>
    </div>
  );
}

function ReplyField({ text, onSend, onClose }: { text: string; onSend: () => void; onClose: () => void }) {
  return (
    <div className="og-prop-in mt-2.5 flex items-center gap-2 rounded-md border px-2.5 py-1.5" style={{ borderColor: tint(VIOLET, 55) }}>
      <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: TEXT }}>{text}<span aria-hidden className="og-prop-caret" style={{ color: VIOLET }}>|</span></span>
      <button type="button" className={`${btn} h-6 text-meta`} style={{ color: MUTED }} onClick={onClose}>Close</button>
      <button type="button" className={`${btn} h-6 text-meta`} style={{ backgroundColor: INK, color: "#fffdf6" }} onClick={onSend} autoFocus>Send reply</button>
    </div>
  );
}

/** A change that applies only once the hire it depends on is approved. */
function NeedsChip() {
  return (
    <span className="mr-auto inline-flex h-[22px] items-center gap-1.5 rounded-full border pl-0.5 pr-2 text-meta" style={{ borderColor: tint(VIOLET, 35), color: VIOLET, backgroundColor: tint(VIOLET, 6) }}>
      <Tile k="server rack" size={16} style={{ borderRadius: 999, opacity: 0.6 }} />
      Needs Head of Platform
    </span>
  );
}

function Face({ s }: { s: Subject }) {
  if ("k" in s.face) return <Tile k={s.face.k} size={18} style={{ verticalAlign: "-4px", marginRight: 6 }} />;
  return <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md px-1 mr-1.5 font-mono text-meta font-bold" style={{ backgroundColor: tint(VIOLET, 12), color: VIOLET, verticalAlign: "1px" }}>{s.face.sessions}</span>;
}

function Sentence({ s }: { s: Subject }) {
  const [a, b] = s.sentence.split(s.name);
  return <>{a}<b style={{ color: INK }}>{s.name}</b>{b}</>;
}

function Entry({ s, n, state, lit, replying, answered, onLit, onAnswer, onUndo, onReply, onSendReply }: {
  s: Subject; n: number; state: State; lit: boolean; replying: boolean; answered: boolean;
  onLit: (v: boolean) => void; onAnswer: (v: Verdict) => void; onUndo: () => void; onReply: () => void; onSendReply: () => void;
}) {
  const outcome: Outcome | undefined = state.outcome[s.id];
  const answer = state.answers[s.id];
  const open = !outcome;
  const waitsOnHire = !!s.needsPlatform && open && state.answers.platform !== "approve" && state.outcome.platform !== "applied";
  const revised = s.id === "move" && state.revised;
  const reply = REPLIES[s.id];
  return (
    <div
      className="og-prop-subject -mx-2 rounded-lg px-2 py-3 border-t first:border-t-0"
      style={{ borderColor: tint(LINE, 70), backgroundColor: lit ? tint(VIOLET, 7) : "transparent" }}
      onMouseEnter={() => onLit(true)} onMouseLeave={() => onLit(false)} onFocus={() => onLit(true)} onBlur={() => onLit(false)}
    >
      <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-2">
        <span className="font-mono text-meta leading-[22px] tabular-nums" style={{ color: DIM }}>{n}</span>
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-3">
            <p key={s.sentence} className={`m-0 min-w-0 text-[14px] leading-[22px] ${revised ? "og-prop-in" : ""}`} style={{ color: outcome === "rejected" ? DIM : TEXT }}><Face s={s} /><Sentence s={s} /></p>
            {outcome && <span className="og-prop-in shrink-0 text-[12.5px] leading-[22px] font-medium" style={{ color: outcome === "applied" ? SOL.green : DIM }}>{outcome === "applied" ? "Applied" : "Rejected"}</span>}
          </div>
          {revised && open && (
            <div className="og-prop-in mt-1.5 text-meta leading-[17px]">
              <span className="font-semibold" style={{ color: VIOLET }}>Revised</span>
              <span style={{ color: MUTED }}> · removed </span><s style={{ color: DIM }}>{REVISION_NOTE.removed}</s>
              <span style={{ color: MUTED }}> · added </span><span style={{ color: TEXT }}>{REVISION_NOTE.added}</span>
            </div>
          )}
          {outcome !== "rejected" && (
            <dl className="m-0 mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12.5px] leading-[19px]">
              {s.rows.map((r) => (
                <Row key={r.label} label={r.label}>
                  {r.before
                    ? <>{outcome === "applied" ? null : <><span style={{ color: DIM }}>{r.before}</span><span className="mx-[1ch] font-medium" style={{ color: MUTED }}>→</span></>}<span style={{ color: TEXT }}>{r.after}</span></>
                    : <span style={{ color: TEXT }}>{r.after}</span>}
                </Row>
              ))}
              {open && <Row label="Why"><span style={{ color: BODY }}>{s.why}</span></Row>}
              {open && (
                <Row label="Sources">
                  <span className="flex flex-wrap gap-1">
                    {s.evidence.map((e) => <span key={e} className="rounded-md border px-1.5 text-meta leading-[18px]" style={{ borderColor: LINE, color: MUTED, backgroundColor: tint(SAND, 40) }}>{e}</span>)}
                  </span>
                </Row>
              )}
            </dl>
          )}
          {answered && reply.answer && open && (
            <div className="og-prop-in mt-2 text-[12px] leading-[18px] space-y-0.5">
              <p className="m-0"><span style={{ color: DIM }}>You: </span><span style={{ color: TEXT }}>{reply.ask}</span></p>
              <p className="m-0 flex items-start gap-1.5"><Tile k="org chart" size={14} style={{ marginTop: 2 }} /><span style={{ color: BODY }}>{reply.answer}</span></p>
            </div>
          )}
          {revised && open && <p className="og-prop-in m-0 mt-2 text-[12px] leading-[18px]"><span style={{ color: DIM }}>You: </span><span style={{ color: TEXT }}>{REPLY_TEXT}</span></p>}
          {replying && open && !answer && <ReplyField text={reply.ask} onSend={onSendReply} onClose={onReply} />}
          {answer && open && <Band verdict={answer} waits={answer === "approve" && !willApply(state, s.id)} onUndo={onUndo} />}
          {open && !answer && (
            <div className="mt-2.5 flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5">
              {waitsOnHire && <NeedsChip />}
              <Controls onAnswer={onAnswer} onReply={onReply} replying={replying} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="whitespace-nowrap text-meta" style={{ color: DIM }}>{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}

function ProposalCard({ state, setState, lit, setLit }: { state: State; setState: (s: State) => void; lit: Sid | null; setLit: (id: Sid | null) => void }) {
  const [replying, setReplying] = useState<Sid | null>(null);
  const [answered, setAnswered] = useState<Partial<Record<Sid, true>>>({});
  const c = counts(state);
  const tray = trayWords(state);
  const answer = (id: Sid, v: Verdict | null) => {
    const answers = { ...state.answers };
    if (v) answers[id] = v; else delete answers[id];
    setState({ ...state, answers });
    setReplying(null);
  };
  const sendReply = (id: Sid) => {
    setReplying(null);
    if (id === "move") { const answers = { ...state.answers }; delete answers.move; setState({ ...state, answers, revised: true }); }
    else setAnswered({ ...answered, [id]: true });
  };
  const rest = () => {
    const answers = { ...state.answers };
    for (const s of SUBJECTS) if (!state.outcome[s.id] && !answers[s.id]) answers[s.id] = "approve";
    setState({ ...state, answers });
  };
  const subjects = subjectsOf(state);

  return (
    <div className="px-4 sm:px-5 pt-4 pb-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono font-bold text-[15px] leading-snug" style={{ color: INK }}>Give Platform an owner and file 12 loose sessions</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta" style={{ color: MUTED }}>
            <span key={metaWords(state)} className="og-prop-in">{metaWords(state)}</span>
            <span aria-hidden style={{ color: DIM }}>·</span>
            <span style={{ color: DIM }}>from</span>
            <span className="inline-flex items-center gap-1 rounded-full border pl-0.5 pr-2 h-[22px]" style={{ borderColor: LINE }}>
              <Tile k="org chart" size={18} style={{ borderRadius: 999 }} />
              <span style={{ color: TEXT }}>Head of People</span>
            </span>
          </div>
        </div>
        <span className="font-mono text-meta rounded-md px-1.5 py-0.5" style={{ color: VIOLET, backgroundColor: tint(VIOLET, 10) }}>op-7</span>
      </div>

      <p className="m-0 mt-3 text-[13px] leading-[20px]" style={{ color: BODY }}>
        Platform has no owner, the Pricing page project has no lead, and 12 sessions sit loose in your inbox. One hire, one move, one area change and a filing place all of them.
      </p>
      <p className="m-0 mt-1.5 text-[12px] leading-[18px]" style={{ color: MUTED }}>4 changes: 1 new role, 1 reporting change, 1 area change, 12 sessions filed</p>

      <div className="mt-2">
        {subjects.map((s, i) => (
          <Entry
            key={s.id} s={s} n={i + 1} state={state} lit={lit === s.id} replying={replying === s.id} answered={!!answered[s.id]}
            onLit={(v) => setLit(v ? s.id : null)}
            onAnswer={(v) => answer(s.id, v)} onUndo={() => answer(s.id, null)}
            onReply={() => setReplying(replying === s.id ? null : s.id)} onSendReply={() => sendReply(s.id)}
          />
        ))}
      </div>

      <div className="mt-1 border-t pt-3" style={{ borderColor: tint(LINE, 100) }}>
        {tray && <p key={tray} className="og-prop-in m-0 mb-2.5 text-[12px] leading-[18px]" style={{ color: BODY }}>{tray}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {c.undecided > 0 && <button type="button" className={btn} style={{ color: MUTED }} onClick={rest}>{c.staged ? "Approve the rest" : `Approve all ${c.open}`}</button>}
          {c.open === 0 && <span className="text-[12.5px]" style={{ color: MUTED }}>Nothing left to decide</span>}
          <button
            type="button"
            disabled={!c.staged}
            className={`${btn} ml-auto h-8 px-3 disabled:cursor-not-allowed`}
            style={{ backgroundColor: c.staged ? INK : tint(SAND, 70), color: c.staged ? "#fffdf6" : DIM }}
            onClick={() => { setState(send(state)); setReplying(null); }}
          >
            {c.apply ? `Send and apply ${c.apply}` : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Changes the org already took, before op-7. */
const PAST = [
  { what: "Hired Head of People", ref: "op-3", when: "Oct 31" },
  { what: "Moved Social lead under CMO", ref: "op-5", when: "Nov 2" },
  { what: "Filed 18 sessions where they belong", ref: "op-6", when: "Nov 4" },
];

/** The org's History beside the chart: what op-7 applied on top, each with Undo, then what came before. */
function History({ state, setState }: { state: State; setState: (s: State) => void }) {
  const applied = subjectsOf(state).filter((s) => state.outcome[s.id] === "applied");
  const undo = (id: Sid) => {
    const outcome = { ...state.outcome };
    delete outcome[id];
    if (id === "platform") for (const s of SUBJECTS) if (s.needsPlatform && outcome[s.id] === "applied") delete outcome[s.id];
    setState({ ...state, outcome });
  };
  const row = "flex items-center gap-2.5 px-3 h-9 border-t first:border-t-0 text-[12px]";
  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: LINE, backgroundColor: "#fffdf6" }}>
      <div className="flex items-center px-3 h-8 border-b font-mono text-meta" style={{ borderColor: LINE, color: MUTED, backgroundColor: tint(SAND, 40) }}>
        <span style={{ color: TEXT }}>History</span>
        <span className="ml-auto">{applied.length + PAST.length} changes</span>
      </div>
      {applied.map((s) => (
        <div key={`${s.id}-${state.sends}`} className={`${row} og-prop-in`} style={{ borderColor: tint(LINE, 70), backgroundColor: tint(SOL.green, 5, "#fffdf6") }}>
          <span aria-hidden style={{ color: SOL.green }}>✓</span>
          <span className="min-w-0 flex-1 truncate" style={{ color: TEXT }}>{s.sentence.replace(/\.$/, "")}</span>
          <span className="font-mono text-meta" style={{ color: VIOLET }}>op-7</span>
          <span className="text-meta w-12 text-right" style={{ color: DIM }}>just now</span>
          <button type="button" className={`${btn} -mr-1.5 h-6 text-meta`} style={{ color: MUTED }} onClick={() => undo(s.id)}>Undo</button>
        </div>
      ))}
      {PAST.map((p) => (
        <div key={p.ref} className={row} style={{ borderColor: tint(LINE, 70) }}>
          <span aria-hidden style={{ color: DIM }}>✓</span>
          <span className="min-w-0 flex-1 truncate" style={{ color: BODY }}>{p.what}</span>
          <span className="font-mono text-meta" style={{ color: DIM }}>{p.ref}</span>
          <span className="text-meta w-12 text-right" style={{ color: DIM }}>{p.when}</span>
          <span aria-hidden className="w-[38px] shrink-0" />
        </div>
      ))}
    </div>
  );
}


export function Proposals() {
  const [state, setState] = useState<State>(START);
  const [lit, setLit] = useState<Sid | null>(null);
  const [gen, setGen] = useState(0);
  const changed = state !== START;
  return (
    <Section
      id="proposals"
      title="The chart changes when you approve"
      lede={
        <p>Every week the Head of People posts what it would change as one proposal, a card per change with its reason and sources. Approve stages an answer and applies nothing. One send applies your approvals in order and gives the author your rejections. Reply on a card and it answers or revises in place.</p>
      }
    >
      <style>{CSS}</style>
      <Frame
        label={
          <>
            <Tile k="org chart" size={16} />
            <span>Head of People</span>
            <span style={{ color: DIM }}>· weekly Company review</span>
            <button type="button" className="og-press ml-auto rounded px-2 h-6 font-mono text-meta disabled:opacity-40" style={{ color: MUTED }} disabled={!changed} onClick={() => { setState(START); setLit(null); setGen(gen + 1); }}>Reset</button>
          </>
        }
      >
        <div className="grid lg:grid-cols-[minmax(0,52fr)_minmax(0,48fr)]">
          <div key={gen} className="min-w-0 lg:border-r" style={{ borderColor: LINE }}>
            <ProposalCard state={state} setState={setState} lit={lit} setLit={setLit} />
          </div>
          <div className="min-w-0 og-grid border-t lg:border-t-0 flex flex-col" style={{ borderColor: LINE }}>
            <div className="flex items-center gap-3 px-4 h-9 border-b font-mono text-meta" style={{ borderColor: LINE, color: MUTED, backgroundColor: tint(SAND, 35) }}>
              <span style={{ color: TEXT }}>Org</span>
              <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: tint(VIOLET, 30), boxShadow: `inset 0 0 0 1px ${VIOLET}` }} />proposed</span>
              <span className="ml-auto">{counts(state).applied ? `${counts(state).applied} applied` : "nothing applied yet"}</span>
            </div>
            <div className="flex-1 flex flex-col justify-center px-4 py-6 space-y-6">
              <div className="overflow-x-auto">
                <ProposalsChart state={state} lit={lit} />
              </div>
              <History state={state} setState={setState} />
            </div>
          </div>
        </div>
      </Frame>
    </Section>
  );
}
