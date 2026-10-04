"use client";

import { useState, type ReactNode } from "react";
import { KeyCap } from "@/components/KeyboardShortcutsHelp";
import { SOL } from "../../blog/blogChrome";
import { PhoneFrame } from "../../productMocks";
import { AnswerBubble, DefaultTag, FoldPill, LINE, MUTED, DIM, TEXT, OptionRow, Question, QueueRow, Reasoning, ReportEmbed, StackChecklistMock, TypeAnswer, EscapeHatch } from "./mocks";
import { at, B, C, Dot, Label, Note, Section, Shell, sh, Y } from "./kit";

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
            {s.label && <span className="text-[10px] font-mono whitespace-nowrap truncate" style={{ color: SOL.base3 }}>{s.label}</span>}
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
      lede={<>It can stop and ask, which pulls you out of your own work to read a transcript. Or it can pick alone, and you find out after code depends on the choice. <C>cast decide</C> puts the question in a queue instead. A queued question costs you almost nothing to receive, so the bar for asking drops: a choice the agent would have made silently and mentioned in passing goes to the queue.</>}
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
        <Lane name="cast decide" accent={Y} verdict="The agent asks once with the evidence. You answer in a sitting you chose.">
          <Track d={0.4} who="you" segs={[{ from: 0, to: 0.62, color: you, label: "your work, uninterrupted" }, { from: 0.63, to: 0.69, color: Y }, { from: 0.71, to: 1, color: you }]} marks={[{ at: 0.66, label: "clear the queue", color: Y }]} />
          <Track d={0.5} who="agent" segs={[{ from: 0, to: 0.2, color: agent, label: "working" }, { from: 0.2, to: 0.66, color: agent, label: "other work, or parked", striped: true }, { from: 0.68, to: 1, color: agent, label: "on your answer" }]} marks={[{ at: 0.2, label: "asks", color: Y }]} />
        </Lane>
      </div>
    </Section>
  );
}

/* ── 2. Anatomy: the command and the card it becomes ──────────────────────── */

type Part = "q" | "o" | "ctx" | "report" | "mode" | null;

export function Anatomy() {
  const [on, setOn] = useState<Part>(null);
  const flag = (p: Exclude<Part, null>, children: ReactNode) => (
    <span className="dq-flag rounded px-0.5 -mx-0.5 cursor-default" data-on={on === p} onMouseEnter={() => setOn(p)} onMouseLeave={() => setOn(null)}>
      {children}
    </span>
  );
  const part = (p: Exclude<Part, null>, children: ReactNode, cls = "") => (
    <div className={`dq-part ${cls}`} data-on={on === p} onMouseEnter={() => setOn(p)} onMouseLeave={() => setOn(null)}>{children}</div>
  );
  return (
    <Section
      id="anatomy"
      tone="sand"
      title="The agent writes the whole card. You never open the session."
      lede={<>One question, 2 to 9 options, and the reasoning: what it found, what each option costs, and why it cannot pick. Text after <C>::</C> in an option becomes the consequence printed under its label, so you compare outcomes where you click. Point at a flag to see where it lands.</>}
      aside={<>The CLI refuses a question with no <C>--context</C>, <C>--report</C> or <C>--doc</C>. It prints the card back to the agent, and warns when the context is under 200 characters or when no option says what happens if chosen.</>}
    >
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6 items-start">
        <div className="min-w-0">
          <Label>the agent runs</Label>
          <Shell>
            {sh.prompt(<>cast decide {flag("q", sh.str('"Which schema wins?"'))} \</>)}{"\n"}
            {"  "}{flag("o", <>{sh.flag("-o")} {sh.str('"Frontmatter wins :: renames keep the id, the daemon changes"')}</>)} \{"\n"}
            {"  "}{flag("o", <>{sh.flag("-o")} {sh.str('"Path wins :: the web index changes, old links break"')}</>)} \{"\n"}
            {"  "}{flag("report", <>{sh.flag("--report")} id-audit.html</>)} \{"\n"}
            {"  "}{flag("ctx", <>{sh.flag("--context")} - &lt;&lt;&apos;EOF&apos;</>)}{"\n"}
            {flag("ctx", <>{sh.dim("The daemon writes note ids from the file path. The web index")}{"\n"}{sh.dim("derives them from frontmatter. A rename keeps one id and changes")}{"\n"}{sh.dim("the other, so the same note indexes twice. Either side can be")}{"\n"}{sh.dim("authoritative.")}{"\n"}{sh.dim("EOF")}</>)}{"\n"}
            {"\n"}
            {sh.ok("Decision posted:")} Which schema wins?{"\n"}
            {sh.dim("  id: sd-41")}{"\n"}
            {sh.dim("  1. Frontmatter wins — renames keep the id, the daemon changes")}{"\n"}
            {sh.dim("  2. Path wins — the web index changes, old links break")}{"\n"}
            {sh.dim("  report: https://codecast.sh/a/id-audit")}{"\n"}
            {"\n"}
            {flag("mode", sh.dim("Blocking: end your turn now. The answer arrives as a user message."))}
          </Shell>
          <div className="mt-4 flex flex-wrap gap-2 text-[12px]">
            {([["q", "the question"], ["o", "-o, :: consequence"], ["ctx", "--context"], ["report", "--report"], ["mode", "blocking"]] as const).map(([p, l]) => (
              <button key={p} type="button" className="dq-flag font-mono px-2 py-1 rounded border" data-on={on === p} style={{ borderColor: LINE, color: SOL.base01 }} onMouseEnter={() => setOn(p)} onMouseLeave={() => setOn(null)} onFocus={() => setOn(p)} onBlur={() => setOn(null)}>{l}</button>
            ))}
          </div>
        </div>
        <div className="min-w-0">
          <Label>you see</Label>
          <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: SOL.base3, borderColor: LINE }}>
            <div className="border-b px-4 sm:px-5 h-10 flex items-center gap-2.5" style={{ borderColor: LINE }}>
              {part("mode", <span className="flex items-center gap-2 px-1 py-0.5"><Dot tier={1} /><span className="text-[13px]" style={{ color: TEXT }}>Note ids drift on rename</span></span>)}
              <span className="ml-auto text-[11px]" style={{ color: DIM }}>decision 1 of 2</span>
            </div>
            <div className="px-4 sm:px-5 pt-4 pb-5 space-y-4">
              {part("q", <div className="p-1"><Question>Which schema wins?</Question></div>)}
              {part("ctx", <div className="p-1"><Reasoning><p>The daemon writes note ids from the file path. The web index derives them from frontmatter. A rename keeps one id and changes the other, so the same note indexes twice. Either side can be authoritative.</p></Reasoning></div>)}
              {part("report", <div className="p-1"><ReportEmbed slug="id-audit" title="Where each id comes from" rows={[["daemon", "file path"], ["web index", "frontmatter"], ["notes indexed twice", "38"]]} /></div>)}
              {part("o", <div className="p-1 space-y-2">
                <OptionRow n={0} primary option={{ label: "Frontmatter wins", description: "renames keep the id, the daemon changes" }} />
                <OptionRow n={1} option={{ label: "Path wins", description: "the web index changes, old links break" }} />
                <TypeAnswer />
              </div>)}
            </div>
          </div>
        </div>
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
      lede={<>Blocking is the default: the agent posts and ends its turn, and the session stays parked until you answer. <C>--advisory --default n</C> lets the agent carry on with option n while your answer can still override it.</>}
      aside={<>The rule the agent is given: advisory only when the default is cheap to undo. Answers often land an hour later and disagree, and everything built on the default in that hour is work to unwind. If reversing costs more than waiting, block.</>}
    >
      <div className="grid md:grid-cols-2 gap-5">
        <div className="rounded-xl border p-5 flex flex-col" style={{ borderColor: "rgba(181,137,0,.45)", backgroundColor: SOL.base3 }}>
          <div className="flex items-center gap-2 mb-1"><Dot tier={1} /><span className="font-mono font-bold text-[15px]" style={{ color: TEXT }}>blocking</span></div>
          <Note className="mb-4">The session is waiting on your decision. The queue opens it as the full sheet, and it sorts to the top while the session can still take an answer.</Note>
          <Shell className="mb-4" wrap>
            {sh.prompt(<>cast decide {sh.str('"Approve dropping agent_runs_v1?"')} \</>)}{"\n"}
            {"  "}{sh.flag("-o")} {sh.str('"Approve :: frees the last migration"')} {sh.flag("-o")} {sh.str('"Hold"')} \{"\n"}
            {"  "}{sh.flag("--context")} {sh.str('"Nothing wrote to it in 40 days."')}{"\n"}
            {sh.dim("Blocking: end your turn now. The answer arrives as a user message.")}
          </Shell>
          <div className="mt-auto rounded-lg border p-3 space-y-3" style={{ borderColor: LINE }}>
            <div className="text-[11px] font-mono" style={{ color: DIM }}>in the session</div>
            <div className="flex items-center gap-2 text-[12.5px]" style={{ color: TEXT }}><Dot tier={1} />Waiting on your decision</div>
            <div className="text-[11px] font-mono" style={{ color: DIM }}>when you answer</div>
            <AnswerBubble label="Hold" question="Approve dropping agent_runs_v1?" />
          </div>
        </div>
        <div className="rounded-xl border p-5 flex flex-col" style={{ borderColor: "rgba(38,139,210,.4)", backgroundColor: SOL.base3 }}>
          <div className="flex items-center gap-2 mb-1"><Dot tier={3} /><span className="font-mono font-bold text-[15px]" style={{ color: B }}>advisory</span></div>
          <Note className="mb-4">The agent keeps working on its default. In the session view the ask folds to one pill above the composer, so the thread stays the main event. It sorts after every blocking ask in the queue.</Note>
          <Shell className="mb-4" wrap>
            {sh.prompt(<>cast decide {sh.str('"Back off or switch keys?"')} \</>)}{"\n"}
            {"  "}{sh.flag("-o")} {sh.str('"Back off"')} {sh.flag("-o")} {sh.str('"Switch keys"')} {sh.flag("--advisory --default 1")} \{"\n"}
            {"  "}{sh.flag("--context")} {sh.str('"429s for 4m. Backing off costs ~20m of throughput."')}{"\n"}
            {sh.dim("Advisory: continue with your default. The human's answer")}{"\n"}
            {sh.dim("arrives as a message and may override you.")}
          </Shell>
          <div className="mt-auto rounded-lg border p-3 space-y-3" style={{ borderColor: LINE }}>
            <div className="text-[11px] font-mono" style={{ color: DIM }}>above the composer, folded</div>
            <div className="flex justify-end"><FoldPill label="Asked for your steer" /></div>
            <div className="space-y-1.5">
              <OptionRow compact n={0} primary option={{ label: "Back off" }} tag={<DefaultTag />} />
              <OptionRow compact n={1} option={{ label: "Switch keys" }} />
            </div>
          </div>
        </div>
      </div>
      <Note className="mt-6 max-w-3xl"><C>cast decide edit --blocking</C> turns an advisory ask into a blocking one and clears its default. A blocking ask never answers itself; only an advisory member of a stack with an auto default policy does.</Note>
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
      lede={<>A decision that deserves proof gets a page. <C>--report</C> publishes an HTML or markdown file through the same path as <C>cast publish</C> and embeds it under the question. <C>--option-page</C> gives each option its own page, so two designs sit side by side. <C>--doc</C> attaches a long markdown body.</>}
      aside={<>A card with a document, option pages or an answer kind beyond a single choice links to its own page at <C>/decisions/sd-N</C>, where there is room to read.</>}
    >
      <div className="grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-6 items-start">
        <div className="min-w-0 space-y-4">
          <Shell>
            {sh.prompt(<>cast decide {sh.str('"Which layout?"')} {sh.flag("-o")} {sh.str('"Dense"')} {sh.flag("-o")} {sh.str('"Roomy"')} \</>)}{"\n"}
            {"  "}{sh.flag("--context")} {sh.str('"Both pass review."')} \{"\n"}
            {"  "}{sh.flag("--option-page")} 1=dense.html {sh.flag("--option-page")} 2=roomy.html
          </Shell>
          <Note>A file publishes like <C>--report</C>. A slug or a codecast page URL attaches a page that already exists, and the server refuses a slug that is not published.</Note>
          <Note>Beyond one choice, <C>--kind</C> asks for several (<C>multi</C>), an order (<C>rank</C>) or a short <C>form</C>, and <C>--line</C> asks for one line of text. <C>--spec</C> takes the whole decision as JSON, with cost, risk and evidence links per option.</Note>
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
      lede={<>The queue is ordered by a rule, not a score. Blocked asks whose session can still take an answer come first. Blocked asks on a stopped session come next. Advisory asks come last. Inside each group the oldest is first, because a parked agent costs more the longer it waits.</>}
      aside={<>Every ask shows its age two ways: wall clock, and how many messages the session has written since. A blocking ask with traffic after it means someone already answered in the thread.</>}
    >
      <div className="grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] gap-8 items-start">
        <div className="min-w-0 space-y-6">
          <div>
            <Label>/questions, in order</Label>
            <div className="space-y-2">
              <QueueRow tier={1} session="Retire agent_runs_v1" question="Approve dropping agent_runs_v1?" age="2h ago" />
              <QueueRow tier={1} session="Retry webhook deliveries" question="Exponential backoff or a fixed 30s retry?" age="52m ago" />
              <QueueRow tier={2} session="Search index rebuild" question="Rebuild tonight or after the freeze?" age="3h ago" />
              <QueueRow tier={3} session="Settings page copy" question="Keep short toggle labels, or write sentences?" age="1h ago" />
            </div>
          </div>
          <div>
            <Label>keys in step mode</Label>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
              {KEYS.map(([k, v]) => (
                <div key={k} className="flex items-center gap-3 text-[13.5px]" style={{ color: MUTED }}>
                  <span className="w-14 shrink-0 flex gap-1">{k === "1–9" ? <><KeyCap>1</KeyCap><span style={{ color: DIM }}>–</span><KeyCap>9</KeyCap></> : <KeyCap>{k}</KeyCap>}</span>
                  <span>{v}</span>
                </div>
              ))}
            </div>
            <Note className="mt-5">An answer marks the row answered at once and sends a normal user message into the asking session, <C>Decision: &lt;label&gt;</C>, rendered as an answer linked back to the ask. Answers from a shell (<C>cast decide answer sd-41 2</C>) write the same message. The first answer wins; a second one changes nothing.</Note>
            <Note className="mt-3">A permission prompt and an agent&apos;s terminal question wait in the same queue. On a permission card the digits are off and only <KeyCap size="xs">y</KeyCap> and <KeyCap size="xs">n</KeyCap> answer, so a digit meant for the previous card can never approve something.</Note>
          </div>
        </div>
        <div className="min-w-0 flex flex-col items-center">
          <PhoneFrame className="w-[268px]" screenClassName="">
            <PhoneDecisionScreen />
          </PhoneFrame>
          <Note className="mt-5 text-center max-w-xs">The phone app walks the same queue one decision at a time, and moves to the next one when you answer, skip or dismiss.</Note>
        </div>
      </div>
    </Section>
  );
}

import { PhoneDecision as PhoneDecisionScreen } from "./mocks";

/* ── 6. Stacks ────────────────────────────────────────────────────────────── */

export function Stacks() {
  return (
    <Section
      id="stacks"
      tone="sand"
      title="Stacks: an ordered set you clear in one go."
      lede={<>A stack groups related asks, like everything a launch needs from you, into a checklist with an id such as <C>ds-7</C>. An agent creates one and appends to it, or you tick cards in the queue and group them yourself.</>}
      aside={<>Blocking members never get an automatic answer. The auto default only answers advisory members, from a server job every 5 minutes, counted from when each joined the stack.</>}
    >
      <div className="grid lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] gap-6 items-start">
        <StackChecklistMock />
        <div className="min-w-0 space-y-4">
          <Shell wrap>
            {sh.prompt(<>cast stack create {sh.str('"Launch checklist"')} {sh.flag("--policy")} auto-default:24h</>)}{"\n"}
            {sh.prompt(<>cast decide {sh.str('"Send the launch email?"')} {sh.flag("-o")} ... {sh.flag("--stack")} ds-7</>)}{"\n"}
            {sh.prompt(<>cast stack policy ds-7 {sh.flag("--due")} tomorrow</>)}{"\n"}
            {sh.prompt(<>cast stack reorder ds-7 sd-43,sd-41,sd-42</>)}{"\n"}
            {sh.prompt(<>cast stack delegate ds-7 @release-lead</>)}
          </Shell>
          <ul className="space-y-3 text-[14.5px] leading-6" style={{ color: SOL.base01 }}>
            <li><b style={{ color: TEXT }}>Due.</b> <C>--due 3h</C>, <C>tomorrow</C> or a date records when you mean to clear it. Overdue stacks sort first.</li>
            <li><b style={{ color: TEXT }}>Auto default.</b> <C>--auto-default 24h</C> answers advisory members with their default after the deadline. The checklist also answers them all at once.</li>
            <li><b style={{ color: TEXT }}>Keys.</b> <KeyCap size="xs">1</KeyCap> to <KeyCap size="xs">9</KeyCap> answer the current member, <KeyCap size="xs">n</KeyCap> and <KeyCap size="xs">p</KeyCap> move between them.</li>
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
      lede={<>A posted decision belongs to the agent. When the facts change it rewrites the card in place with <C>cast decide edit</C>, which keeps the id, the age and the spot in your queue. When the question stops mattering it withdraws it with <C>cast decide cancel</C>. A stale question costs your attention and earns nothing.</>}
      aside={<>Staleness is measured. Each ask records the session&apos;s message count when it was posted; after 2 hours or 30 messages the CLI tells the agent to edit or cancel it. Posting the same question again updates the open row instead of adding a second.</>}
    >
      <Shell>
        {sh.prompt("cast decide ls")}{"\n"}
        ● sd-41  Which schema wins?{"\n"}
        {"    "}still open — asked 3h ago, 42 messages since{"\n"}
        {"      "}1. Frontmatter wins — renames keep the id, the daemon changes{"\n"}
        {"      "}2. Path wins — the web index changes, old links break{"\n"}
        ○ sd-39  Ship the migration tonight?{"\n"}
        {"    "}answered: Ship{"\n"}
        {"    "}✓ 1. Ship{"\n"}
        {"      "}2. Wait for Monday{"\n"}
        {"\n"}
        {sh.dim("The work has likely moved past an open decision. Withdraw the ones that no longer apply")}{"\n"}
        {sh.dim("(cast decide cancel <id>), or bring them up to date (cast decide edit <id>) — a stale")}{"\n"}
        {sh.dim("question in your human's queue costs attention and earns nothing.")}{"\n"}
        {"\n"}
        {sh.prompt(<>cast decide edit sd-41 {sh.flag("--context")} - &lt;&lt;&apos;EOF&apos;</>)}{"\n"}
        {sh.dim("The web index already moved to path ids in #482, so only the daemon is left...")}{"\n"}
        {sh.dim("EOF")}{"\n"}
        {sh.ok("Decision updated:")} sd-41{"\n"}
        {sh.dim("  changed: context_md")}
      </Shell>
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
      lede={<>The decide snippet (<C>cast install decide</C>) teaches agents where the line is. Because the queue does not interrupt you, the bar sits lower than for an inline question: if the agent would have picked a direction and mentioned it in passing, it queues it.</>}
      aside={<>The card is the whole message. After posting, the agent writes nothing more about it; a reply that only repeats the card ends the turn.</>}
    >
      <div className="grid md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] gap-5">
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
  ["--stack ds-N · --task ct-N · --to @handle", "Append to a stack, bind to a task, address a person"],
  ["cast decide ls [--mine]", "This session's asks with ids, answers and staleness"],
  ["cast decide edit [id] [flags]", "Rewrite the open ask in place; --blocking clears the default"],
  ["cast decide cancel [id]", "Withdraw it; the conversation shows it as withdrawn"],
  ["cast decide show <sd> · answer <sd> <n>", "One decision in full; answer from a shell"],
  ['cast stack create "<title>" [--policy auto-default:24h]', "Start a stack"],
  ["cast stack add | remove | reorder | show | ls", "Shape and read stacks"],
  ["cast stack policy ds-N --due <when> | --auto-default <dur>", "When you mean to clear it; when advisory members default"],
];

export function Reference() {
  return (
    <Section id="reference" title="Command reference" lede={<>Every flag on this page, in one place. <C>cast decide --help</C> and <C>cast stack --help</C> print the rest.</>}>
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: LINE }}>
        {REF.map(([c, d], i) => (
          <div key={c} className="dq-ref-row grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-x-6 gap-y-1 px-4 sm:px-5 py-3 border-b last:border-b-0" style={{ borderColor: LINE, backgroundColor: i % 2 ? "rgba(238,232,213,.35)" : SOL.base3 }}>
            <code className="font-mono text-[12.5px] [overflow-wrap:anywhere]" style={{ color: SOL.base02 }}>{c}</code>
            <span className="text-[13.5px]" style={{ color: MUTED }}>{d}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ── 10. Limits and questions ─────────────────────────────────────────────── */

const FAQ: [string, ReactNode][] = [
  ["What happens when I dismiss?", <>The row resolves as dismissed and leaves your queue. The agent is not told. If it should hear no, answer instead, or type a reply with <KeyCap size="xs">t</KeyCap>.</>],
  ["Can two people answer the same ask?", <>The first answer wins. A second answer to a row that is no longer pending changes nothing, and the CLI says the first answer stands.</>],
  ["Who receives it?", <>By default, whoever the asking session reports to: its owners and the first person its reporting line reaches. <C>--to</C> names people in the session&apos;s workspace instead.</>],
  ["Can an agent answer for me?", <>On teams using the org chart, a role can recommend an option, and a role holding a grant for that kind of question may answer it. Production, billing, data, access, external and product questions always stay with a person, and a person&apos;s answer always wins the race.</>],
  ["How many options?", <>2 to 9, mapped to the keys 1 to 9. For more structure use <C>--kind multi</C>, <C>rank</C> or <C>form</C>.</>],
  ["What if the agent crashes and retries?", <>Posting the same question from the same session updates the open row, so a retry does not create a duplicate.</>],
];

export function Limits() {
  return (
    <Section id="faq" tone="sand" title="Limits and questions" lede="The parts people ask about first.">
      <div className="grid md:grid-cols-2 gap-x-10 gap-y-8">
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
