"use client";

import type { ReactNode } from "react";
import { KeyCap } from "@/components/KeyboardShortcutsHelp";
import { SOL } from "../../blog/blogChrome";
import { PhoneFrame } from "../../productMocks";
import { AnswerBubble, DefaultTag, FoldPill, LINE, MUTED, DIM, TEXT, OptionRow, Question, QueueRow, StackChecklistMock, EscapeHatch } from "./mocks";
import { at, B, C, Dot, Label, Note, Section, Y } from "./kit";
import { Shot } from "../kit";

/* ── 1. Three ways through a fork ─────────────────────────────────────────── */

type Seg = { from: number; to: number; color: string; label?: string; striped?: boolean };
const HOURS = ["1pm", "2pm", "3pm", "4pm", "5pm"];

function Track({ who, segs, marks = [], d }: { who: string; segs: Seg[]; marks?: { at: number; label: string; color: string }[]; d: number }) {
  return (
    <div className="grid grid-cols-[72px_1fr] sm:grid-cols-[96px_1fr] items-center gap-3">
      <span className="text-[11.5px] font-mono text-right" style={{ color: DIM }}>{who}</span>
      <div className="relative h-7 rounded-md" style={{ backgroundColor: "rgba(147,161,161,.12)" }}>
        {segs.map((s, i) => (
          <span
            key={i}
            className="dq-bar absolute top-1 bottom-1 rounded-[4px] flex items-center px-1.5 overflow-hidden"
            style={at(d + i * 0.08, {
              left: `${s.from * 100}%`, width: `${(s.to - s.from) * 100}%`, backgroundColor: s.color,
              backgroundImage: s.striped ? "repeating-linear-gradient(135deg, rgba(255,255,255,.28) 0 5px, transparent 5px 10px)" : undefined,
            })}
          >
            {s.label && <span className="hidden sm:inline text-[10px] font-mono whitespace-nowrap truncate" style={{ color: SOL.base3 }}>{s.label}</span>}
          </span>
        ))}
        {marks.map((m, i) => (
          <span key={i} className="absolute -top-1 -bottom-1 w-[2px] rounded" style={{ left: `${m.at * 100}%`, backgroundColor: m.color }} title={m.label} />
        ))}
      </div>
    </div>
  );
}

function Lane({ name, verdict, children, accent }: { name: string; verdict: ReactNode; children: ReactNode; accent: string }) {
  return (
    <div className="rounded-xl border p-4 sm:p-5" style={{ borderColor: LINE, backgroundColor: SOL.base3 }}>
      <div className="flex items-baseline gap-3 flex-wrap mb-4">
        <span className="font-mono font-bold text-[15px]" style={{ color: accent }}>{name}</span>
        <span className="text-[13.5px]" style={{ color: MUTED }}>{verdict}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

export function ThreeWays() {
  const you = SOL.base01, agent = SOL.cyan;
  return (
    <Section
      id="why"
      title="An agent at a fork has two bad options. This is the third."
      lede={<>It can stop and ask, which pulls you out of your own work to read a transcript. Or it can pick alone, and you find out after code depends on the choice. Codecast puts the question in a queue instead. A queued question costs you almost nothing to receive, so the bar for asking drops: a choice the agent would have made silently and mentioned in passing goes to the queue.</>}
      aside={<>The tracks below are an illustrative afternoon, not a measurement. The shape is the point: who loses time, and when.</>}
    >
      <div className="grid grid-cols-[72px_1fr] sm:grid-cols-[96px_1fr] gap-3 mb-2">
        <span />
        <div className="flex justify-between text-[10.5px] font-mono" style={{ color: DIM }}>
          {HOURS.map((h) => <span key={h}>{h}</span>)}
        </div>
      </div>
      <div className="space-y-4">
        <Lane name="Stop and ask" accent={SOL.red} verdict="Your focus breaks at the agent's pace, not yours.">
          <Track d={0} who="you" segs={[{ from: 0, to: 0.18, color: you, label: "your work" }, { from: 0.2, to: 0.42, color: you }, { from: 0.45, to: 0.7, color: you }, { from: 0.73, to: 1, color: you }]} marks={[{ at: 0.19, label: "ping", color: SOL.red }, { at: 0.435, label: "ping", color: SOL.red }, { at: 0.715, label: "ping", color: SOL.red }]} />
          <Track d={0.1} who="agent" segs={[{ from: 0, to: 0.18, color: agent, label: "working" }, { from: 0.2, to: 0.42, color: agent }, { from: 0.45, to: 0.7, color: agent }, { from: 0.73, to: 1, color: agent }]} />
        </Lane>
        <Lane name="Decide alone" accent={SOL.orange} verdict="Nobody waits, and then the work comes undone.">
          <Track d={0.2} who="you" segs={[{ from: 0, to: 0.82, color: you, label: "your work, uninterrupted" }, { from: 0.84, to: 1, color: SOL.orange, label: "reading the diff" }]} />
          <Track d={0.3} who="agent" segs={[{ from: 0, to: 0.2, color: agent, label: "working" }, { from: 0.2, to: 0.84, color: agent, label: "building on its guess" }, { from: 0.86, to: 1, color: SOL.orange, label: "redo", striped: true }]} marks={[{ at: 0.2, label: "picks alone", color: SOL.orange }]} />
        </Lane>
        <Lane name="Queue it" accent={Y} verdict="The agent asks once with the evidence. You answer in a sitting you chose.">
          <Track d={0.4} who="you" segs={[{ from: 0, to: 0.62, color: you, label: "your work, uninterrupted" }, { from: 0.63, to: 0.69, color: Y }, { from: 0.71, to: 1, color: you }]} marks={[{ at: 0.66, label: "clear the queue", color: Y }]} />
          <Track d={0.5} who="agent" segs={[{ from: 0, to: 0.2, color: agent, label: "working" }, { from: 0.2, to: 0.66, color: agent, label: "other work, or parked", striped: true }, { from: 0.68, to: 1, color: agent, label: "on your answer" }]} marks={[{ at: 0.2, label: "asks", color: Y }]} />
        </Lane>
      </div>
      <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-[12px] font-mono" style={{ color: SOL.base00 }}>
        {([[you, "your work"], [agent, "agent working"], [SOL.red, "an interruption"], [SOL.orange, "rework"], [Y, "clearing the queue"]] as const).map(([c, l]) => (
          <span key={l} className="flex items-center gap-2"><span className="w-3 h-3 rounded-[3px]" style={{ backgroundColor: c }} />{l}</span>
        ))}
        <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-[3px]" style={{ backgroundColor: agent, backgroundImage: "repeating-linear-gradient(135deg, rgba(255,255,255,.35) 0 3px, transparent 3px 6px)" }} />parked or on other work</span>
      </div>
    </Section>
  );
}

/* ── 2. Anatomy: the card, as the app shows it ───────────────────────────── */

const PARTS: [string, string][] = [
  ["The question", "one, in large type, so you know what you are deciding before you read anything else"],
  ["The reasoning", "what the agent found, and why it cannot pick alone"],
  ["The options", "2 to 9, numbered for the keys, each with what happens if you choose it"],
  ["The evidence", "a report, a page per option or a long document, when a paragraph is not enough"],
  ["The answer", "a click or a number key, or Or answer in your own words"],
];

export function Anatomy() {
  return (
    <Section
      id="anatomy"
      tone="sand"
      title="The agent writes the whole card. You never open the session."
      lede={<>One question, 2 to 9 options, and the reasoning: what it found, what each option costs, and why it cannot pick. Each option carries its consequence under its label, so you compare outcomes where you click.</>}
      aside={<>An agent cannot post a bare question: codecast refuses one with no reasoning or evidence, and warns the agent when the reasoning is thin or an option does not say what happens if chosen.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] gap-8 items-start">
        <Shot
          src="/features/decisions/decision-page.webp"
          alt="A decision's page in codecast: the question in large type, the agent's reasoning, two numbered options each with its consequence, and the answer with who gave it"
          width={1600}
          height={1332}
          caption={<>Every decision has its own page, reached from the card. <b style={{ color: TEXT, fontWeight: 600 }}>Discuss</b> opens a thread about it, and once it is answered the page keeps the choice and who made it.</>}
        />
        <ul className="space-y-4">
          {PARTS.map(([h, d]) => (
            <li key={h} className="grid grid-cols-[18px_1fr] gap-2">
              <span className="mt-[9px] w-2 h-2 rounded-full" style={{ backgroundColor: Y }} />
              <span><span className="text-[15px] font-semibold" style={{ color: TEXT }}>{h}</span><span className="block text-[14px] leading-6" style={{ color: MUTED }}>{d}</span></span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

/* ── 3. Blocking or advisory ──────────────────────────────────────────────── */

export function Modes() {
  return (
    <Section
      id="modes"
      title="Wait for the answer, or keep going on a default."
      lede={<>Blocking is the default: the agent asks and stops, and the session shows <i>Waiting on your decision</i> until you answer. An advisory ask names a default and the agent carries on with it, while your answer can still override it.</>}
      aside={<>The rule the agent is given: advisory only when the default is cheap to undo. Answers often land an hour later and disagree, and everything built on the default in that hour is work to unwind. If reversing costs more than waiting, block.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-2 gap-5">
        <div className="rounded-xl border p-5 flex flex-col" style={{ borderColor: "rgba(181,137,0,.45)", backgroundColor: SOL.base3 }}>
          <div className="flex items-center gap-2 mb-1"><Dot tier={1} /><span className="font-mono font-bold text-[15px]" style={{ color: TEXT }}>blocking</span></div>
          <Note className="mb-4">The session is waiting on your decision. The queue opens it as the full sheet, and it sorts to the top while the session can still take an answer.</Note>
          <div className="rounded-lg border p-3 space-y-3" style={{ borderColor: LINE }}>
            <div className="text-[11px] font-mono" style={{ color: DIM }}>in the session</div>
            <div className="flex items-center gap-2 text-[12.5px]" style={{ color: TEXT }}><Dot tier={1} />Waiting on your decision</div>
            <div className="text-[11px] font-mono" style={{ color: DIM }}>when you answer</div>
            <AnswerBubble label="Hold" question="Approve dropping agent_runs_v1?" />
          </div>
        </div>
        <div className="rounded-xl border p-5 flex flex-col" style={{ borderColor: "rgba(38,139,210,.4)", backgroundColor: SOL.base3 }}>
          <div className="flex items-center gap-2 mb-1"><Dot tier={3} /><span className="font-mono font-bold text-[15px]" style={{ color: B }}>advisory</span></div>
          <Note className="mb-4">The agent keeps working on its default. In the session view the ask folds to one pill above the composer, so the thread stays the main event. It sorts after every blocking ask in the queue.</Note>
          <div className="rounded-lg border p-3 space-y-3" style={{ borderColor: LINE }}>
            <div className="text-[11px] font-mono" style={{ color: DIM }}>above the composer, folded</div>
            <div className="flex justify-end"><FoldPill label="Asked for your steer" /></div>
            <div className="space-y-1.5">
              <OptionRow compact n={0} primary option={{ label: "Back off" }} tag={<DefaultTag />} />
              <OptionRow compact n={1} option={{ label: "Switch keys" }} />
            </div>
          </div>
        </div>
      </div>
      <Note className="mt-6 max-w-3xl">The agent can turn an advisory ask into a blocking one, which clears its default. A blocking ask never answers itself; only an advisory member of a stack with an <b style={{ color: TEXT, fontWeight: 600 }}>Auto default</b> does.</Note>
    </Section>
  );
}

/* ── 4. Evidence ──────────────────────────────────────────────────────────── */

function OptionPage({ n, name, rows, tone }: { n: number; name: string; rows: number; tone: string }) {
  return (
    <div className="rounded-lg border overflow-hidden" style={{ borderColor: LINE, backgroundColor: SOL.base3 }}>
      <div className="aspect-[4/3] p-3 border-b" style={{ borderColor: LINE, backgroundColor: "#fffdf6" }}>
        <div className="h-2 w-1/2 rounded mb-3" style={{ backgroundColor: tone }} />
        <div className={rows > 6 ? "space-y-1" : "space-y-2.5"}>
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className={`${rows > 6 ? "h-2.5 w-2.5" : "h-4 w-4"} rounded-sm shrink-0`} style={{ backgroundColor: "rgba(147,161,161,.35)" }} />
              <span className={`${rows > 6 ? "h-1.5" : "h-2"} rounded flex-1`} style={{ backgroundColor: "rgba(147,161,161,.25)", maxWidth: `${60 + ((i * 17) % 35)}%` }} />
            </div>
          ))}
        </div>
      </div>
      <div className="px-3 py-2 flex items-center gap-2 text-[12.5px]">
        <KeyCap size="xs">{String(n)}</KeyCap><span style={{ color: TEXT }}>{name}</span>
        <span className="ml-auto text-[11px]" style={{ color: B }}>open ↗</span>
      </div>
    </div>
  );
}

export function Evidence() {
  return (
    <Section
      id="evidence"
      tone="sand"
      title="When a paragraph is not enough, the card carries the evidence."
      lede={<>A decision that deserves proof gets a page. The agent can attach a report that renders under the question, give each option its own page so two designs sit side by side, or attach a long document.</>}
      aside={<>A card with a document, option pages or an answer beyond a single choice links to the decision&apos;s own page, where there is room to read.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-6 items-start">
        <div className="min-w-0 space-y-4">
          <Note>Each option page opens full size from the card. A report or page can be one the agent built for this question, or a page already published in codecast.</Note>
          <Note>Beyond one choice, an ask can take several options, an order, a short form, or one line of text. Each option can also carry its cost, risk and links to evidence.</Note>
        </div>
        <div className="min-w-0 rounded-xl border p-4 sm:p-5" style={{ borderColor: LINE, backgroundColor: SOL.base3 }}>
          <div className="mb-3"><Question size="sm">Which layout?</Question></div>
          <div className="text-[11px] mb-2" style={{ color: DIM }}>the options, as pages</div>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <OptionPage n={1} name="Dense" rows={9} tone={SOL.cyan} />
            <OptionPage n={2} name="Roomy" rows={5} tone={SOL.violet} />
          </div>
          <div className="space-y-2">
            <OptionRow compact n={0} primary option={{ label: "Dense" }} />
            <OptionRow compact n={1} option={{ label: "Roomy" }} />
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ── 5. Clearing the queue ────────────────────────────────────────────────── */

const KEYS: [string, string][] = [
  ["1–9", "answer with that option"],
  ["t", "type your own answer"],
  ["s", "skip for now"],
  ["x", "dismiss; the agent is not told"],
  ["o", "open the session"],
  ["esc", "leave the queue"],
];

export function Clearing() {
  return (
    <Section
      id="queue"
      title="One sitting, in an order you can predict."
      lede={<><b style={{ color: TEXT, fontWeight: 600 }}>Questions</b> in the sidebar counts what is waiting on you and opens the queue as a list; <b style={{ color: TEXT, fontWeight: 600 }}>one at a time</b> walks it as full cards. The order is a rule, not a score. Blocked asks whose session can still take an answer come first. Blocked asks on a stopped session come next. Advisory asks come last. Inside each group the oldest is first, because a parked agent costs more the longer it waits.</>}
      aside={<>Every ask shows its age two ways: wall clock, and how many messages the session has written since. A blocking ask with traffic after it means someone already answered in the thread.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] gap-8 items-start">
        <div className="min-w-0 space-y-6">
          <div>
            <Label>Questions, in order</Label>
            <div className="space-y-2">
              <QueueRow tier={1} session="Retire agent_runs_v1" question="Approve dropping agent_runs_v1?" age="2h ago" />
              <QueueRow tier={1} session="Retry webhook deliveries" question="Exponential backoff or a fixed 30s retry?" age="52m ago" />
              <QueueRow tier={2} session="Search index rebuild" question="Rebuild tonight or after the freeze?" age="3h ago" />
              <QueueRow tier={3} session="Settings page copy" question="Keep short toggle labels, or write sentences?" age="1h ago" />
            </div>
          </div>
          <div>
            <Label>keys, one at a time</Label>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
              {KEYS.map(([k, v]) => (
                <div key={k} className="flex items-center gap-3 text-[13.5px]" style={{ color: MUTED }}>
                  <span className="w-14 shrink-0 flex gap-1">{k === "1–9" ? <><KeyCap>1</KeyCap><span style={{ color: DIM }}>–</span><KeyCap>9</KeyCap></> : <KeyCap>{k}</KeyCap>}</span>
                  <span>{v}</span>
                </div>
              ))}
            </div>
            <Note className="mt-5">An answer marks the row answered at once and sends a normal user message into the asking session, <C>Decision: &lt;label&gt;</C>, rendered as an answer linked back to the ask. An answer given from the command line writes the same message. The first answer wins; a second one changes nothing.</Note>
            <Note className="mt-3">A permission prompt and an agent&apos;s terminal question wait in the same queue. On a permission card the digits are off and only <KeyCap size="xs">y</KeyCap> and <KeyCap size="xs">n</KeyCap> answer, so a digit meant for the previous card can never approve something.</Note>
          </div>
        </div>
        <div className="min-w-0 flex flex-col items-center">
          <PhoneQueue />
          <Note className="mt-5 text-center max-w-xs">The phone app walks the same queue one decision at a time, and moves to the next one when you answer, skip or dismiss.</Note>
        </div>
      </div>
    </Section>
  );
}

import { PhoneDecision as PhoneDecisionScreen } from "./mocks";

/** The phone app walking the queue, one decision at a time. */
export function PhoneQueue() {
  return (
    <PhoneFrame className="w-[268px]" screenClassName="">
      <PhoneDecisionScreen />
    </PhoneFrame>
  );
}

/* ── 6. Stacks ────────────────────────────────────────────────────────────── */

export function Stacks() {
  return (
    <Section
      id="stacks"
      tone="sand"
      title="Stacks: an ordered set you clear in one go."
      lede={<>A stack groups related asks, like everything a launch needs from you, into a checklist with an id such as <C>ds-7</C>. An agent can build one as it asks, or you click <b style={{ color: TEXT, fontWeight: 600 }}>group into a stack</b> in the list, tick the cards and name it.</>}
      aside={<>Blocking members never get an automatic answer. The auto default only answers advisory members, from a server job every 5 minutes, counted from when each joined the stack.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] gap-6 items-start">
        <div className="min-w-0"><StackChecklistMock /></div>
        <div className="min-w-0 space-y-4">
          <ul className="space-y-3 text-[14.5px] leading-6" style={{ color: SOL.base01 }}>
            <li><b style={{ color: TEXT }}>Due.</b> Set on the stack&apos;s page: when you mean to clear it. Overdue stacks sort first.</li>
            <li><b style={{ color: TEXT }}>Auto default.</b> After that many hours, advisory members are answered with their default. The checklist also answers them all at once.</li>
            <li><b style={{ color: TEXT }}>Keys.</b> <KeyCap size="xs">1</KeyCap> to <KeyCap size="xs">9</KeyCap> answer the current member, <KeyCap size="xs">n</KeyCap> and <KeyCap size="xs">p</KeyCap> move between them.</li>
            <li><b style={{ color: TEXT }}>Delegate to a role.</b> Hands the stack to a role, which answers every open category for its members. Protected questions still come to a person.</li>
            <li><b style={{ color: TEXT }}>Done.</b> A stack closes when every member is resolved: answered, dismissed or withdrawn.</li>
          </ul>
        </div>
      </div>
    </Section>
  );
}

/* ── 7. Keeping an ask true ───────────────────────────────────────────────── */

export function KeepTrue() {
  return (
    <Section
      id="edit"
      title="An ask stays correct until someone answers it."
      lede={<>A posted decision belongs to the agent. When the facts change it rewrites the card in place, keeping its age and its spot in your queue. When the question stops mattering it withdraws it, and the conversation shows the ask as withdrawn. A stale question costs your attention and earns nothing.</>}
      aside={<>Staleness is measured. Each ask records how far the session had got when it was posted; after 2 hours or 30 messages the agent is told to update or withdraw it. Asking the same question again updates the open card instead of adding a second.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-2 gap-5">
        <div>
          <Label>rewritten in place, same spot in the queue</Label>
          <QueueRow tier={1} session="Note ids drift on rename" question="Which schema wins?" age="3h ago" />
          <Note className="mt-3">The reasoning now says the web index already moved to path ids, so only the daemon is left to change.</Note>
        </div>
        <div>
          <Label>withdrawn</Label>
          <div className="rounded-lg border px-4 py-3 flex items-center gap-3" style={{ borderColor: LINE, backgroundColor: "rgba(253,246,227,.55)" }}>
            <span className="text-[13.5px] line-through truncate" style={{ color: DIM }}>Rebuild the search index tonight or after the freeze?</span>
            <span className="ml-auto shrink-0 text-[11px] font-mono px-1.5 py-0.5 rounded border" style={{ borderColor: LINE, color: DIM }}>withdrawn</span>
          </div>
          <Note className="mt-3">It leaves your queue, and the transcript keeps the ask with its withdrawn mark.</Note>
        </div>
      </div>
    </Section>
  );
}

/* ── 8. What belongs in the queue ─────────────────────────────────────────── */

const ASK: [string, string][] = [
  ["Hard to reverse", "a schema, a data model, a protocol"],
  ["Spends money or quota", "or touches billing, auth, or anything user facing in prod"],
  ["Deletes or migrates data", "or drops something only a backup can bring back"],
  ["Taste, not evidence", "speed against correctness, breadth against depth"],
  ["A guess about the product", "what you want it to do, when nothing says"],
];
const NEVER: [string, string][] = [
  ["Anything more reading answers", "the code, the docs or past sessions already say"],
  ["A status update", "progress belongs on the task, not in your queue"],
  ["A probe, a test, a layout sample", "every ask reaches your real queue and phone"],
];

export function Belongs() {
  return (
    <Section
      id="rules"
      tone="sand"
      title="What an agent should queue, and what it should never queue."
      lede={<>Switching on <b style={{ color: TEXT, fontWeight: 600 }}>Decision queue</b> in <b style={{ color: TEXT, fontWeight: 600 }}>Agent features</b> teaches agents where the line is. Because the queue does not interrupt you, the bar sits lower than for an inline question: if the agent would have picked a direction and mentioned it in passing, it queues it.</>}
      aside={<>The card is the whole message. After posting, the agent writes nothing more about it; a reply that only repeats the card ends the turn.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] gap-5">
        <div className="rounded-xl border p-5 sm:p-6" style={{ borderColor: "rgba(181,137,0,.45)", backgroundColor: SOL.base3 }}>
          <div className="font-mono font-bold text-[14px] mb-4" style={{ color: Y }}>queue it</div>
          <ul className="space-y-3.5">
            {ASK.map(([h, d]) => (
              <li key={h} className="grid grid-cols-[18px_1fr] gap-2">
                <span className="mt-[9px] w-2 h-2 rounded-full" style={{ backgroundColor: Y }} />
                <span><span className="text-[15px] font-semibold" style={{ color: TEXT }}>{h}</span><span className="block text-[13.5px]" style={{ color: MUTED }}>{d}</span></span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border p-5 sm:p-6" style={{ borderColor: LINE, backgroundColor: "rgba(253,246,227,.55)" }}>
          <div className="font-mono font-bold text-[14px] mb-4" style={{ color: SOL.base01 }}>never queue it</div>
          <ul className="space-y-3.5">
            {NEVER.map(([h, d]) => (
              <li key={h} className="grid grid-cols-[18px_1fr] gap-2">
                <span className="mt-[8px] text-[12px] leading-none font-mono" style={{ color: SOL.red }}>×</span>
                <span><span className="text-[15px] font-semibold" style={{ color: TEXT }}>{h}</span><span className="block text-[13.5px]" style={{ color: MUTED }}>{d}</span></span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

/* ── 9. Reference ─────────────────────────────────────────────────────────── */

const REF: [string, string][] = [
  ['cast decide "<q>" -o "A :: why" -o "B"', "Ask one question with 2 to 9 options; text after :: is the consequence"],
  ["--context <md> | --context -", "The reasoning, in markdown; - reads a heredoc"],
  ["--report <file>", "Publish an HTML or markdown page and embed it under the question"],
  ["--option-page n=<file|slug|url>", "A page for option n"],
  ["--doc <file>", "A long markdown body; the card links to the decision page"],
  ["--advisory --default <n>", "Keep working on option n; the answer may override it"],
  ["--kind single|multi|rank|form, --line <label>", "Ask for one, several, an order, a form, or one line of text"],
  ["--card <card.json>", "Ask about a change card; without -o the options are Ship, Revise, Drop"],
  ["--stack ds-N · --task ct-N · --to @handle", "Append to a stack, bind to a task, address a person"],
  ["cast decide ls [--mine]", "This session's asks with ids, answers and staleness"],
  ["cast decide edit [id] [flags]", "Rewrite the open ask in place; --blocking clears the default"],
  ["cast decide cancel [id]", "Withdraw it; the conversation shows it as withdrawn"],
  ["cast decide show <sd> · answer <sd> <n>", "One decision in full; answer from a shell"],
  ['cast stack create "<title>" [--policy auto-default:24h]', "Start a stack"],
  ["cast stack add | remove | reorder | show | ls", "Shape and read stacks"],
  ["cast stack policy ds-N --due <when> | --auto-default <dur>", "When you mean to clear it; when advisory members default"],
  ["cast stack delegate ds-N @handle", "A role answers every open category for the stack's members"],
];

/** Words that wrap only at spaces, so a flag never splits at its own hyphen. */
function Toks({ text }: { text: string }) {
  return <>{text.split(" ").map((w, i) => <span key={i}>{i > 0 && " "}<span className="whitespace-nowrap">{w}</span></span>)}</>;
}

export function Reference() {
  return (
    <Section id="reference" title="For scripts and agents" lede={<>Agents ask through the <C>cast decide</C> command, and anything on this page can be scripted with it. <C>cast decide --help</C> and <C>cast stack --help</C> print the rest.</>}>
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: LINE }}>
        {REF.map(([c, d], i) => (
          <div key={c} className="dq-ref-row grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-x-6 gap-y-1 px-4 sm:px-5 py-3 border-b last:border-b-0" style={{ borderColor: LINE, backgroundColor: i % 2 ? "rgba(238,232,213,.35)" : SOL.base3 }}>
            <code className="font-mono text-[12.5px]" style={{ color: SOL.base02 }}><Toks text={c} /></code>
            <span className="text-[13.5px]" style={{ color: MUTED }}><Toks text={d} /></span>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ── 10. Limits and questions ─────────────────────────────────────────────── */

const FAQ: [string, ReactNode][] = [
  ["What happens when I dismiss?", <>The row resolves as dismissed and leaves your queue. The agent is not told. If it should hear no, answer instead, or type a reply with <KeyCap size="xs">t</KeyCap>.</>],
  ["Can two people answer the same ask?", <>The first answer wins. A second answer to a row that is no longer pending changes nothing, and the person who answered second is told the first answer stands.</>],
  ["Who receives it?", <>By default, whoever the asking session reports to: its owners and the first person its reporting line reaches. An agent can name people in the session&apos;s workspace instead.</>],
  ["Can an agent answer for me?", <>On teams using the org chart, a role can recommend an option, and a role holding a grant for that kind of question may answer it. Production, billing, data, access, external and product questions always stay with a person, and a person&apos;s answer always wins the race.</>],
  ["How many options?", <>2 to 9, mapped to the keys 1 to 9. For more structure an ask can take several choices, an order, or a short form.</>],
  ["Does blocking freeze the agent?", <>No. The agent is told to end its turn after asking. The session parks because the agent stops, not because anything locks it.</>],
  ["Can I change an answer?", <>No. Once a row is answered, an edit or cancel fails and prints the answer. To change course, send the session a message.</>],
  ["What if the agent crashes and retries?", <>Posting the same question from the same session updates the open row, so a retry does not create a duplicate.</>],
];

export function Limits() {
  return (
    <Section id="faq" tone="sand" title="Limits and questions" lede="The parts people ask about first.">
      <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-2 gap-x-10 gap-y-8">
        {FAQ.map(([q, a]) => (
          <div key={q}>
            <div className="font-mono font-bold text-[15px] mb-2" style={{ color: TEXT }}>{q}</div>
            <div className="text-[14.5px] leading-7" style={{ color: SOL.base01 }}>{a}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

export { EscapeHatch };
