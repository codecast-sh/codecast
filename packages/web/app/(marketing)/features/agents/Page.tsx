"use client";

import Link from "next/link";
import { type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { InstallTabs } from "@/components/install-tabs";
import { featureHref, featureDeepDives } from "../catalog";
import { AGX_CSS } from "./agentsStyles";
import { TreeHero } from "./TreeHero";
import { Chooser } from "./Chooser";
import { ForkHistoryMock, HandoffMock, InboxNestMock, SettleMock, StatesLegend, SwitchMock } from "./mocks";
import { ExecTerm, SendMock, WakeGateTerm, WatchTerm, WorktreeMock } from "./more";
import { ACCENT, AGENT_COLOR, AgentTag, C, Fact, ForScripts, RailSection, ShapeGlyph, T, Term, type Shape } from "./parts";
import { useStillMode, Whole, Shot } from "../kit";

const SPAWN_BACKENDS = ["claude", "codex", "cursor", "gemini", "grok", "opencode", "pi"];

export default function AgentsPage() {
  const isStatic = useStillMode();
  return (
    <main className="agx relative" style={{ backgroundColor: SOL.base3 }} data-static={isStatic ? "" : undefined}>
      <style>{AGX_CSS}</style>
      <Hero />
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <ChooserSection />
        <Trunk>
          <Workers />
          <Manage />
          <Fork />
          <Switch />
          <Handoff />
          <Exec />
          <Messaging />
          <Isolation />
        </Trunk>
        <Reference />
        <Limits />
        <Related />
      </div>
      <Closing />
    </main>
  );
}

/* ───────────────────────── hero ───────────────────────── */

function Hero() {
  return (
    <section className="agx-grid-bg relative overflow-x-clip" style={{ borderBottom: `1px solid ${SOL.base2}` }}>
      <div className="mx-auto grid grid-cols-1 max-w-6xl gap-12 px-5 pb-16 pt-14 sm:px-8 sm:pt-20 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-14 lg:pb-24">
        <div className="agx-hero-copy min-w-0 flex flex-col self-start lg:pt-6">
          <div className="flex flex-wrap items-center gap-1.5">
            {SPAWN_BACKENDS.map((a) => <AgentTag key={a} agent={a} size="xs" />)}
          </div>
          <h1 className="mt-6 font-mono text-[34px] font-bold leading-[1.08] tracking-[-0.03em] sm:text-[48px] [text-wrap:balance]" style={{ color: SOL.base03 }}>
            One thread you steer. As many agents as the work needs.
          </h1>
          <p className="mt-6 max-w-xl text-[17.5px] leading-[1.7]" style={{ color: SOL.base00 }}>
            Hand a piece to a worker on any backend and get woken when it settles. Branch a conversation to try two approaches at once.
            Move a session to another agent mid-thread without losing a line. Every one of them is a real session you can read, message and steer.
          </p>
          <p className="mt-6 max-w-xl text-[15.5px] leading-[1.7]" style={{ color: SOL.base01 }}>
            Most of it starts with a sentence to your agent: &ldquo;hand the tests to a Codex worker&rdquo;, &ldquo;fork this three ways&rdquo;. The rest is in the app: <b>Fork from here</b> on any message, and <b>Switch agent</b>, <b>Fork as</b> and <b>Hand off to</b> in the model menu at the top of every conversation.
          </p>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 font-mono text-[12.5px]">
            <a href="#which" className="underline decoration-1 underline-offset-4" style={{ color: SOL.base01 }}>Which one do I want?</a>
            <a href="#reference" className="underline decoration-1 underline-offset-4" style={{ color: SOL.base01 }}>For scripts and agents</a>
          </div>
          <HeroKey />
        </div>
        <div className="min-w-0">
          <TreeHero />
        </div>
      </div>
    </section>
  );
}

/** How to read the tree beside it; desktop only, where the tree runs taller than the copy. */
function HeroKey() {
  const rows: { shape: Shape; color: string; name: string; text: string }[] = [
    { shape: "fork", color: SOL.blue, name: "Solid branch", text: "A fork. It carries the whole history and runs as its own inbox thread." },
    { shape: "worker", color: AGENT_COLOR.codex, name: "Dashed branch", text: "A worker. It starts from your brief alone and reports back when it settles." },
    { shape: "switch", color: AGENT_COLOR.codex, name: "Diamond", text: "A switch. Same session, same id, another agent answering." },
  ];
  return (
    <div className="mt-14 hidden max-w-xl lg:block">
      <div className="font-mono text-[12px] font-semibold" style={{ color: SOL.base01 }}>Reading the tree</div>
      <div className="mt-4 grid grid-cols-1 gap-4">
        {rows.map((r) => (
          <div key={r.name} className="flex items-start gap-3.5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: SOL.base2 }}><ShapeGlyph shape={r.shape} size={30} color={r.color} /></span>
            <p className="text-[14px] leading-[1.6]" style={{ color: SOL.base00 }}><span className="font-mono font-semibold" style={{ color: SOL.base02 }}>{r.name}.</span> {r.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── chooser ───────────────────────── */

function ChooserSection() {
  return (
    <section id="which" className="scroll-mt-20 pt-20 sm:pt-28">
      <h2 className="max-w-3xl font-mono text-[26px] font-bold leading-[1.15] tracking-[-0.02em] sm:text-[34px] [text-wrap:balance]" style={{ color: SOL.base03 }}>
        Six ways to start another agent. One question picks between them: who reads the result?
      </h2>
      <p className="mt-4 max-w-2xl text-[16.5px] leading-[1.7]" style={{ color: SOL.base00 }}>
        Parallelism, a fresh context, a different model or a worktree do not decide it. Ownership does. Work you delegate and report on is a worker.
        A thread a person will steer on their own is a fork or a plain spawn. Your agents follow the same rule, because it is written into the instructions codecast installs, so asking in plain words picks the right one.
      </p>
      <div className="mt-10">
        <Chooser />
      </div>
    </section>
  );
}

/** The page's own trunk: a vertical rail the primitive sections hang off. */
function Trunk({ children }: { children: ReactNode }) {
  return (
    <div className="relative mt-8">
      <div className="absolute bottom-0 left-[17px] top-24 w-[2.5px] sm:left-[23px]" style={{ background: `linear-gradient(${ACCENT}, ${ACCENT}55 85%, transparent)` }} aria-hidden />
      {children}
    </div>
  );
}

/* ───────────────────────── sections ───────────────────────── */

/** What you see in the app beside its CLI form, then the facts beneath on the same two columns. */
function Two({ left, right, facts, flip = false }: { left: ReactNode; right: ReactNode; facts?: ReactNode; flip?: boolean }) {
  return (
    <>
      <div className={`grid grid-cols-1 items-start gap-8 lg:grid-cols-2 lg:gap-10${flip ? " [&>*:first-child]:lg:order-2" : ""}`}>{left}{right}</div>
      {facts && <div className="mt-10 grid grid-cols-1 gap-x-10 gap-y-7 sm:grid-cols-2">{facts}</div>}
    </>
  );
}

function Workers() {
  return (
    <RailSection
      id="workers"
      shape="worker"
      title={<>Workers: delegate a piece, get woken when it settles</>}
      lede={<>
        Ask your agent to delegate a piece, and it starts a worker: a fresh session under yours, on whichever backend suits the job, knowing only the brief it was given.
        In the inbox a worker sits under its parent as a <b>Subagent</b> row instead of a card of its own. When it finishes, blocks, stops or waits on a
        permission, your session gets a message saying so, and the parent conversation shows one report row per worker.
      </>}
    >
      <Two
        left={<div className="grid grid-cols-1 gap-4"><InboxNestMock /><SettleMock /></div>}
        right={<div className="grid grid-cols-1 gap-6">
            <ForScripts note="An agent fans out three workers in one call. Each brief is split on a line holding only ---.">
            <Term label="one call, three workers">
              {T.cmd("cast spawn --subagent -- - - - <<'EOF'")}
              {T.c("Write a load test that reproduces the retry pileup.\n", SOL.base0)}
              {T.c("Acceptance: fails on main, passes with the fix.\n", SOL.base0)}
              {T.dim("---\n")}
              {T.c("Audit every caller of enqueue(). File and line for each.\n", SOL.base0)}
              {T.dim("---\n")}
              {T.c("Draft the backoff section of docs/webhooks.md.\n", SOL.base0)}
              {T.c("EOF\n", SOL.base0)}
            </Term>
            </ForScripts>
          </div>}
        facts={<>
              <Fact label="Siblings settle as one turn">Workers that finish together reach the parent as one message, not five. Each shows as a live session row with what it settled on.</Fact>
              <Fact label="Any backend">A worker can run on {SPAWN_BACKENDS.join(", ")}, with its own model and effort, or as a saved agent definition. Name it in the request.</Fact>
              <Fact label="Show or hide them">The fork button at the top of the session list shows or hides subagent sessions. The parent&apos;s overflow menu lists its <b>Subagents</b> with a link to each.</Fact>
              <Fact label="Where it runs">Another repo, a worktree of its own, another machine, or your cloud host. Say which in the request.</Fact>
        </>}
      />
    </RailSection>
  );
}

function Manage() {
  return (
    <RailSection
      id="manage"
      shape="room"
      color={SOL.cyan}
      title={<>Watch the fleet without paging through it</>}
      lede={<>
        Every session has a work state, and the state answers one question: who acts next. The inbox shows it on every row, so you can tell at a glance which
        sessions wait on you and which are still working. To learn what a long session concluded, press <b>A</b> in it and ask: <b>Ask this session</b> answers
        from its transcript and cites the messages, instead of you reading all of it.
      </>}
    >
      <Two
        left={<ForScripts note="An agent that started workers watches them without polling: nothing prints until a state changes."><WatchTerm /></ForScripts>}
        right={<div className="grid grid-cols-1 gap-7">
            <div className="rounded-xl p-5" style={{ backgroundColor: "#fffdf6", border: `1px solid ${SOL.base2}` }}>
              <StatesLegend />
            </div>
          </div>}
        facts={<>
              <Fact label="Reading is free" color={SOL.cyan}>Opening a session, asking it a question or reading its changes costs it nothing. A message costs it a turn.</Fact>
              <Fact label="Ask is in the CLI too" color={SOL.cyan}>Agents ask other sessions the same way, with <C>cast read &lt;id&gt; --ask</C>, before they message them.</Fact>
        </>}
      />
    </RailSection>
  );
}

function Fork() {
  return (
    <RailSection
      id="fork"
      shape="fork"
      color={AGENT_COLOR.claude}
      title={<>Fork: one conversation, several directions, all with the history</>}
      lede={<>
        Right-click a message and choose <b>Fork from here</b> to branch the conversation at that point, or pick <b>Fork as</b> in the model menu to branch onto another agent.
        Each branch keeps everything up to the fork point and heads off as its own live session in the inbox, marked <b>Fork</b>. Ask your agent to fork several ways and
        this thread takes the first direction and keeps going, so you never stop to pick.
      </>}
    >
      <Two
        left={<ForkHistoryMock />}
        right={<div className="grid grid-cols-1 gap-6">
            <ForScripts note="What an agent runs when you ask it to fork several ways.">
            <Term label="forking">
              {T.cmd('cast fork "use Redis" "use Postgres" "keep it in-memory"')}
              {T.dim("# this thread takes Redis; two branches\n\n")}
              {T.cmd('cast fork --all-branches "use Redis" "use Postgres"')}
              {T.dim("# two branches; this thread stays out\n\n")}
              {T.cmd('cast fork --at 42 "what if we cache" "what if we don\'t"')}
              {T.dim("# branch from message 42\n")}
            </Term>
            </ForScripts>
          </div>}
        facts={<>
              <Fact label="The request stays out" color={AGENT_COLOR.claude}>When an agent forks for you, the fork point is just before your latest message, so &ldquo;fork this three ways&rdquo; never enters a branch.</Fact>
              <Fact label="Branches report to no one" color={AGENT_COLOR.claude}>A branch receives its direction as its human&apos;s next message, and its first message reads <b>forked from</b> the parent. You steer it from the inbox like any thread.</Fact>
        </>}
      />
    </RailSection>
  );
}

function Switch() {
  return (
    <RailSection
      id="switch"
      shape="switch"
      title={<>Switch: same session, another agent or model</>}
      lede={<>
        Open the model menu at the top of the conversation and pick <b>Switch agent</b>. The conversation and its id stay; who is answering changes, and a
        <b> now using</b> divider lands in the thread where it did. The same menu changes the model and effort in place. Use it for a second opinion from a different model, or when one backend is better at the next step.
      </>}
    >
      <Two
        flip
        left={<SwitchMock />}
        right={<div className="grid grid-cols-1 gap-6">
            <Shot src="/features/agents/switch-agent.webp" alt="The Switch agent step of the menu: Claude (current), Codex, Cursor greyed with can't rebuild history, OpenCode, pi, Grok, Muse Spark greyed" width={672} height={606} className="max-w-sm" caption={<>The <b>Switch agent</b> step of the model menu.</>} />
            <ForScripts>
            <Term label="switching">
              {T.cmd("cast switch --agent codex")}
              {T.cmd("cast switch --model opus")}
              {T.cmd("cast switch --agent claude --model sonnet")}
              {T.cmd("cast switch --agent codex --fork")}
              {T.dim("# a new session instead\n")}
            </Term>
            </ForScripts>
          </div>}
        facts={<>
              <Fact label="Provider switch">Moving between providers replaces the agent process. The new agent continues from the thread.</Fact>
              <Fact label="Agents">The list shows the agents this machine can run. One that cannot rebuild a thread&apos;s history from another agent is greyed out with the reason.</Fact>
        </>}
      />
    </RailSection>
  );
}

function Handoff() {
  return (
    <RailSection
      id="handoff"
      shape="handoff"
      title={<>Handoff: end here, start fresh with a brief</>}
      lede={<>
        A long thread gets heavy. <b>Hand off to</b> in the model menu has the server write a brief of this session, starts a new one from it on the agent you pick, in the same
        directory, links the two, binds the new one to the same task or plan, and pins this one done.
      </>}
    >
      <Two
        left={<HandoffMock />}
        right={<div className="grid grid-cols-1 gap-6">
            <Shot src="/features/agents/session-menu.webp" alt="The model menu in a codecast conversation header: Claude Code on opus-5-5, a Model list (Default, Fable, Opus, Sonnet, Haiku), Effort from low to max, and Move this session: Switch agent, Fork as, Hand off to" width={672} height={1160} className="max-w-[300px]" caption={<>The model menu at the top of every conversation. <b>Hand off to</b> is the last row.</>} />
            <ForScripts>
            <Term label="handing off">
              {T.cmd('cast handoff --to gemini -m "finish the tests first"')}
              {T.cmd("cast handoff --model sonnet")}
              {T.dim("# same agent, another model\n")}
              {T.cmd("cast handoff --to codex --dry-run")}
              {T.dim("# print the composed prompt, start nothing\n")}
            </Term>
            </ForScripts>
          </div>}
        facts={<>
              <Fact label="Switch or handoff?">Switch keeps every message. Handoff keeps the conclusions. Pick handoff when the history is more noise than help.</Fact>
              <Fact label="A brief with a steer">The handoff step has a <b>Direction</b> box for a line to the new session, like &ldquo;finish the tests first&rdquo;. From the CLI, <C>--dry-run</C> prints the brief without starting anything.</Fact>
        </>}
      />
    </RailSection>
  );
}

function Exec() {
  return (
    <RailSection
      id="exec"
      shape="exec"
      title={<>Exec: one answer, inside a script</>}
      lede={<>
        This one is CLI-only on purpose. <C>cast exec</C> is print mode for every harness codecast launches. It runs a prompt, prints the result and exits. The process is the session:
        stdout is the answer, the exit code is the agent&apos;s, and nothing lands in the inbox. The same flags map onto each client&apos;s own headless form.
      </>}
    >
      <Two
        left={<ExecTerm />}
        right={
          <div className="grid grid-cols-1 gap-x-8 gap-y-7 sm:grid-cols-2">
            <Fact label="Parallel"><C>-j 4</C> runs each prompt as its own run, at most four at once.</Fact>
            <Fact label="Chains"><C>--chain &lt;name&gt;</C> runs saved agent definitions in order; each step&apos;s output feeds the next.</Fact>
            <Fact label="Structured"><C>--output-format json</C> for machine output; <C>--json-schema</C> constrains the final answer (claude, grok).</Fact>
            <Fact label="Safety rails"><C>--timeout 10m</C> kills a long run. <C>--dry-run</C> prints the resolved command without running it.</Fact>
          </div>
        }
      />
    </RailSection>
  );
}

function Messaging() {
  return (
    <RailSection
      id="messaging"
      shape="send"
      color={SOL.cyan}
      title={<>Sessions talk to each other, and every message costs a turn</>}
      lede={<>
        Agents message each other. A message arrives in the other session as a new turn marked <b>Message from</b> and the sender, so you see in both threads who said what.
        It reaches any session you can see, your own or a teammate&apos;s shared one. If the target is offline the message queues until its machine comes back.
      </>}
    >
      <SendMock />
      <div className="mt-8 grid grid-cols-1 items-start gap-8 lg:grid-cols-2 lg:gap-10">
        <ForScripts note="An agent sends with cast send. A stale session is held unless it adds --wake."><WakeGateTerm /></ForScripts>
        <div className="grid grid-cols-1 gap-6">
          <Fact label="Stale sessions are held" color={SOL.cyan}>A session idle past its hour of prompt cache, or one that was killed, is not woken by default. The send stops and names the cost. Reporting back to the session that started you always goes through.</Fact>
          <Fact label="What earns a message" color={SOL.cyan}>Changing the recipient&apos;s next action, answering its question, preventing a real conflict, or delivering finished work. Progress notes stay in your own thread.</Fact>
          <Fact label="No acknowledgments" color={SOL.cyan}>An inbound message that asks nothing needs no reply. Agents are told never to acknowledge an acknowledgment.</Fact>
        </div>
      </div>
    </RailSection>
  );
}

function Isolation() {
  return (
    <RailSection
      id="isolation"
      shape="worktree"
      title={<>Worktrees and labels keep a fan-out tidy</>}
      lede={<>
        Several agents in one checkout step on each other. Ask for workers in their own worktrees and each gets a git worktree with gitignored files like <C>.env</C> copied,
        the project&apos;s setup commands run and its own ports. Labels file sessions under a name: they show as chips above the session list.
        Agents and the CLI create worktrees; the repo view&apos;s <b>Worktrees</b> tab lists them, with <b>Compare</b> to see one&apos;s changes.
      </>}
    >
      <Two
        flip
        left={<WorktreeMock />}
        right={<div className="grid grid-cols-1 gap-6">
            <ForScripts>
            <Term label="isolating and filing" wrap>
              {T.cmd('cast spawn --subagent --isolated "refactor the store" "rewrite the router"')}
              {T.cmd("cast ws acquire fix-auth-bug")}
              {T.cmd('cd "$(cast ws path fix-auth-bug)"')}
              {T.cmd('cast spawn --subagent --label rollout "task A" "task B"')}
              {T.cmd("cast sessions --label rollout -w --json")}
            </Term>
            </ForScripts>
          </div>}
        facts={<>
              <Fact label="Labels nest nothing">A label groups sessions. It does not make one a worker; only delegating does.</Fact>
              <Fact label="Personal">A session carries at most one label. Labels are yours; teammates never see them.</Fact>
        </>}
      />
    </RailSection>
  );
}

/* ───────────────────────── reference ───────────────────────── */

const REF: [string, string][] = [
  ['cast spawn --subagent -- "<task>"', "Worker under this session; reports back when it settles"],
  ["cast spawn --subagent --agent codex", "Worker on another backend (--model, --effort, --as)"],
  ["cast spawn --subagent --isolated", "One git worktree per worker"],
  ['cast spawn "<task>"', "Independent inbox thread, for when a person asked for one"],
  ['cast fork "<a>" "<b>"', "This thread takes a; b becomes a branch with the history"],
  ["cast fork --all-branches | --at <n> | --tip", "Keep this thread out; pick the fork point"],
  ["cast switch --agent <a> --model <m>", "Same session, another agent or model"],
  ["cast handoff --to <agent> [-m <text>]", "Brief, new linked session, this one pinned done"],
  ['cast exec [--agent a] "<prompt>"', "Run, print, exit; no inbox card (-j, --chain, --json-schema)"],
  ['cast send <id> "<text>"', "Message a session as a new turn (--wake for stale ones)"],
  ["cast read <id> [range] | --ask", "Read a transcript, or ask it a question with citations"],
  ["cast sessions <id>… -w --json", "Stream state changes for a set or a --label"],
  ["cast label set <name> [id]", "File a session under a personal label"],
  ["cast ws acquire | path | ls | destroy", "Manage isolated worktrees with env, setup and ports"],
];

function Reference() {
  return (
    <section id="reference" className="scroll-mt-20 pt-24 sm:pt-32">
      <h2 className="font-mono text-[26px] font-bold tracking-[-0.02em] sm:text-[34px]" style={{ color: SOL.base03 }}>For scripts and agents</h2>
      <p className="mt-3 max-w-2xl text-[15.5px] leading-[1.7]" style={{ color: SOL.base00 }}>
        Your agents run these when you ask in plain words, and they work from any shell. Every command takes <C>--help</C> with examples. Multi-line text goes through <C>-</C> and a heredoc, never <C>&quot;$(cat file)&quot;</C>.
      </p>
      <div className="mt-8 overflow-hidden rounded-xl" style={{ border: `1px solid ${SOL.base2}` }}>
        {REF.map(([cmd, what], i) => (
          <div key={cmd} className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-6 sm:px-5" style={{ backgroundColor: i % 2 ? SOL.base3 : "#fffdf6", borderTop: i ? `1px solid ${SOL.base2}` : undefined }}>
            <code className="min-w-0 font-mono text-[12.5px] font-medium" style={{ color: SOL.base02 }}><Whole text={cmd} /></code>
            <span className="text-[14px] leading-[1.55]" style={{ color: SOL.base01 }}><Whole text={what} /></span>
          </div>
        ))}
      </div>
    </section>
  );
}

const LIMITS: [string, ReactNode][] = [
  ["Does a worker see my conversation?", <>No. Spawned sessions start with no shared history. The brief is everything it knows, so write it like a ticket for someone who was not there. If it needs the history, fork instead.</>],
  ["Do the backends need to be installed?", <>Yes. codecast launches the agent CLIs you already have and are signed in to. It does not ship Codex, Cursor, Gemini or the rest.</>],
  ["Can I fork a session that is not mine?", <>Yes, any session you can see: open it and use <b>Fork from here</b>. Branches are always new sessions; the original is untouched.</>],
  ["Will workers edit the same files?", <>They can, if they share a checkout. Ask for a worktree each for parallel edits, and merge the results yourself.</>],
  ["Does a switch keep tool history?", <>The conversation and its id stay. A provider switch starts the other agent&apos;s process, which continues from the thread rather than from the first agent&apos;s internal state.</>],
  ["Is there a cap on workers?", <>Not from codecast. Your machine, your agent accounts&apos; usage limits and your attention are the real limits. Each worker is a full agent session.</>],
];

function Limits() {
  return (
    <section className="pt-24 sm:pt-32">
      <h2 className="font-mono text-[26px] font-bold tracking-[-0.02em] sm:text-[34px]" style={{ color: SOL.base03 }}>Honest limits</h2>
      <div className="mt-8 grid grid-cols-1 gap-x-10 gap-y-8 md:grid-cols-2">
        {LIMITS.map(([q, a]) => (
          <div key={q}>
            <h3 className="font-mono text-[15px] font-semibold" style={{ color: SOL.base02 }}>{q}</h3>
            <p className="mt-2 text-[15px] leading-[1.7]" style={{ color: SOL.base00 }}>{a}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const RELATED = ["cloud", "triggers", "memory", "decisions"];

function Related() {
  return (
    <section className="pt-24 sm:pt-32">
      <h2 className="font-mono text-[22px] font-bold tracking-[-0.02em] sm:text-[26px]" style={{ color: SOL.base03 }}>Works with</h2>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {featureDeepDives(RELATED).map((f) => {
          return (
            <Link key={f.slug} href={featureHref(f.slug)} className="agx-card group block rounded-xl p-4 hover:-translate-y-0.5" style={{ backgroundColor: "#fffdf6", border: `1px solid ${SOL.base2}`, borderLeft: `3px solid ${f.color}` }}>
              <div className="font-mono text-[13px] font-semibold" style={{ color: f.color }}>{f.name}</div>
              <div className="mt-1 text-[14px] leading-[1.55]" style={{ color: SOL.base01 }}>{f.dek}</div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section className="mt-24 sm:mt-32" style={{ backgroundColor: SOL.base03 }}>
      <div className="mx-auto grid grid-cols-1 max-w-6xl gap-10 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-2 lg:items-center">
        <div>
          <h2 className="font-mono text-[28px] font-bold leading-[1.15] tracking-[-0.02em] sm:text-[36px]" style={{ color: SOL.base3 }}>
            Start with one worker.
          </h2>
          <p className="mt-4 max-w-md text-[16px] leading-[1.7]" style={{ color: SOL.base1 }}>
            Install codecast, then ask your agent to hand a piece of its task to a Codex worker. It already knows how, and the worker shows up under its session.
          </p>
        </div>
        <div className="min-w-0 rounded-xl p-4" style={{ backgroundColor: SOL.base3 }}>
          <InstallTabs location="feature-agents" compact />
        </div>
      </div>
    </section>
  );
}
