"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { InstallTabs } from "@/components/install-tabs";
import { featureHref, getFeatureDeepDive } from "../catalog";
import { AGX_CSS } from "./agentsStyles";
import { TreeHero } from "./TreeHero";
import { Chooser } from "./Chooser";
import { ForkHistoryMock, HandoffMock, InboxNestMock, SettleMock, StatesLegend, SwitchMock } from "./mocks";
import { ExecTerm, SendMock, WakeGateTerm, WatchTerm, WorktreeMock } from "./more";
import { ACCENT, AGENT_COLOR, AgentTag, C, CopyCmd, Fact, RailSection, T, Term } from "./parts";

const SPAWN_BACKENDS = ["claude", "codex", "cursor", "gemini", "grok", "opencode", "pi"];

export default function AgentsPage() {
  const [isStatic, setStatic] = useState(false);
  useEffect(() => { setStatic(new URLSearchParams(window.location.search).has("static")); }, []);
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
    <section className="agx-grid-bg relative overflow-hidden" style={{ borderBottom: `1px solid ${SOL.base2}` }}>
      <div className="mx-auto grid grid-cols-1 max-w-6xl gap-12 px-5 pb-16 pt-14 sm:px-8 sm:pt-20 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-14 lg:pb-24">
        <div className="agx-hero-copy min-w-0 flex flex-col self-start lg:sticky lg:top-24 lg:pt-6">
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
          <div className="mt-8 grid grid-cols-1 max-w-xl gap-2">
            <CopyCmd cmd={'cast spawn --subagent --agent codex -- "<task>"'} />
            <CopyCmd cmd={'cast fork "<approach A>" "<approach B>"'} />
          </div>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 font-mono text-[12.5px]">
            <a href="#which" className="underline decoration-1 underline-offset-4" style={{ color: SOL.base01 }}>Which one do I want?</a>
            <a href="#reference" className="underline decoration-1 underline-offset-4" style={{ color: SOL.base01 }}>Command reference</a>
          </div>
        </div>
        <div className="min-w-0">
          <TreeHero />
        </div>
      </div>
    </section>
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
        A thread a person will steer on their own is a fork or a plain spawn. Your agents follow the same rule, because it is written into the instructions codecast installs.
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

/** A mock and a terminal side by side, then the facts in one row beneath. */
function Two({ left, right, facts, flip = false }: { left: ReactNode; right: ReactNode; facts?: ReactNode; flip?: boolean }) {
  return (
    <>
      <div className={`grid grid-cols-1 items-start gap-8 lg:grid-cols-2 lg:gap-10${flip ? " [&>*:first-child]:lg:order-2" : ""}`}>{left}{right}</div>
      {facts && <div className="mt-10 grid gap-x-8 gap-y-7 grid-cols-[repeat(auto-fit,minmax(230px,1fr))]">{facts}</div>}
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
        <C>cast spawn --subagent</C> starts a fresh session under yours, on whichever backend suits the job. It knows only the brief you give it.
        It stays out of the inbox and out of top-level lists, nested under the session that started it. When it finishes, blocks, stops or waits on a
        permission, your session gets a message saying so.
      </>}
    >
      <Two
        left={<div className="grid grid-cols-1 gap-4"><InboxNestMock /><SettleMock /></div>}
        right={<div className="grid grid-cols-1 gap-6">
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
          </div>}
        facts={<>
              <Fact label="Siblings settle as one turn">Workers that finish together reach the parent as one message, not five. Each shows as a live session row with what it settled on.</Fact>
              <Fact label="Any backend"><C>--agent</C> takes {SPAWN_BACKENDS.join(", ")}. Add <C>--model</C> and <C>--effort</C>, or <C>--as &lt;definition&gt;</C> for a saved role.</Fact>
              <Fact label="Briefs survive formatting">A <C>-</C> reads the brief from stdin. Several <C>-</C> split one heredoc on lines holding only <C>---</C>, so a whole fan-out fits in one call.</Fact>
              <Fact label="Where it runs"><C>-C &lt;dir&gt;</C> for another repo, <C>--isolated</C> for a worktree each, <C>--device</C> for another machine, <C>--cloud</C> for your cloud host.</Fact>
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
        Every session has a work state, and the state answers one question: who acts next. <C>cast sessions -w</C> prints nothing until a state changes,
        then one line per change, so it is safe to leave running in the background and wake on output. <C>cast read --ask</C> answers a question from
        one session&apos;s transcript with line citations, instead of you reading all of it.
      </>}
    >
      <Two
        left={<WatchTerm />}
        right={<div className="grid grid-cols-1 gap-7">
            <div className="rounded-xl p-5" style={{ backgroundColor: "#fffdf6", border: `1px solid ${SOL.base2}` }}>
              <StatesLegend />
            </div>
          </div>}
        facts={<>
              <Fact label="Watch by set or label" color={SOL.cyan}><C>cast sessions &lt;id&gt; &lt;id&gt; -w</C> or <C>--label fleet -w</C>. With <C>--json</C> each line is one event: new, transition or gone.</Fact>
              <Fact label="Reading is free" color={SOL.cyan}><C>cast read</C> and <C>cast diff</C> cost the other session nothing. A message costs it a turn.</Fact>
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
        <C>cast fork</C> branches this conversation. Each branch keeps everything up to the fork point and then heads off in its own direction as a live
        session in the inbox. With two or more directions, this thread takes the first and keeps going, so you never stop to pick.
      </>}
    >
      <Two
        left={<ForkHistoryMock />}
        right={<div className="grid grid-cols-1 gap-6">
            <Term label="forking">
              {T.cmd('cast fork "use Redis" "use Postgres" "keep it in-memory"')}
              {T.dim("# this thread takes Redis; two branches\n\n")}
              {T.cmd('cast fork --all-branches "use Redis" "use Postgres"')}
              {T.dim("# two branches; this thread stays out\n\n")}
              {T.cmd('cast fork --at 42 "what if we cache" "what if we don\'t"')}
              {T.dim("# branch from message 42\n")}
            </Term>
          </div>}
        facts={<>
              <Fact label="The request stays out" color={AGENT_COLOR.claude}>By default the fork point is just before your latest message, so &ldquo;fork this three ways&rdquo; never enters a branch. <C>--tip</C> keeps everything, for an agent forking on its own initiative.</Fact>
              <Fact label="Branches report to no one" color={AGENT_COLOR.claude}>A branch receives its direction as its human&apos;s next message. It does not know it is a fork. You steer it from the inbox like any thread.</Fact>
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
        <C>cast switch</C> keeps the conversation and its id and changes who is answering. A divider lands in the thread where the agent changed.
        Use it for a second opinion from a different model, or when one backend is better at the next step.
      </>}
    >
      <Two
        flip
        left={<SwitchMock />}
        right={<div className="grid grid-cols-1 gap-6">
            <Term label="switching">
              {T.cmd("cast switch --agent codex")}
              {T.cmd("cast switch --model opus")}
              {T.cmd("cast switch --agent claude --model sonnet")}
              {T.cmd("cast switch --agent codex --fork")}
              {T.dim("# a new session instead\n")}
            </Term>
          </div>}
        facts={<>
              <Fact label="Provider switch">Moving between providers replaces the agent process. The new agent continues from the thread.</Fact>
              <Fact label="Agents"><C>--agent</C> accepts claude, codex, cursor, gemini, grok, opencode, pi and muse.</Fact>
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
        A long thread gets heavy. <C>cast handoff --to codex</C> has the server write a brief of this session, starts a new one from it in the same
        directory, links the two, binds the new one to the same task or plan, and pins this one done.
      </>}
    >
      <Two
        left={<HandoffMock />}
        right={<div className="grid grid-cols-1 gap-6">
            <Term label="handing off">
              {T.cmd('cast handoff --to gemini -m "finish the tests first"')}
              {T.cmd("cast handoff --model sonnet")}
              {T.dim("# same agent, another model\n")}
              {T.cmd("cast handoff --to codex --dry-run")}
              {T.dim("# print the composed prompt, start nothing\n")}
            </Term>
          </div>}
        facts={<>
              <Fact label="Switch or handoff?">Switch keeps every message. Handoff keeps the conclusions. Pick handoff when the history is more noise than help.</Fact>
              <Fact label="Without --to"><C>cast handoff</C> alone prints a context transfer document, to stdout or a file with <C>-o</C>.</Fact>
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
        <C>cast exec</C> is print mode for every harness codecast launches. It runs a prompt, prints the result and exits. The process is the session:
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
        <C>cast send</C> injects text into another session as a new turn, attributed to the sender so the recipient and the dashboard both see who sent it.
        It reaches any session you can see in the feed, your own or a teammate&apos;s shared one. If the target is offline the message queues until its machine comes back.
      </>}
    >
      <SendMock />
      <div className="mt-8 grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <WakeGateTerm />
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
        Several agents in one checkout step on each other. <C>--isolated</C> gives each spawned session its own git worktree. <C>cast ws</C> manages them by hand:
        it copies gitignored files like <C>.env</C>, runs the project&apos;s setup commands and allocates ports per worktree. Labels file sessions under a name you can filter and watch.
      </>}
    >
      <Two
        flip
        left={<WorktreeMock />}
        right={<div className="grid grid-cols-1 gap-6">
            <Term label="isolating and filing">
              {T.cmd('cast spawn --subagent --isolated "refactor the store" "rewrite the router"')}
              {T.cmd("cast ws acquire fix-auth-bug")}
              {T.cmd('cd "$(cast ws path fix-auth-bug)"')}
              {T.cmd('cast spawn --subagent --label rollout "task A" "task B"')}
              {T.cmd("cast sessions --label rollout -w --json")}
            </Term>
          </div>}
        facts={<>
              <Fact label="Labels nest nothing">A label groups sessions. It does not make one a worker; only <C>--subagent</C> does.</Fact>
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
      <h2 className="font-mono text-[26px] font-bold tracking-[-0.02em] sm:text-[34px]" style={{ color: SOL.base03 }}>Command reference</h2>
      <p className="mt-3 max-w-2xl text-[15.5px] leading-[1.7]" style={{ color: SOL.base00 }}>
        Every command takes <C>--help</C> with examples. Multi-line text goes through <C>-</C> and a heredoc, never <C>&quot;$(cat file)&quot;</C>.
      </p>
      <div className="mt-8 overflow-hidden rounded-xl" style={{ border: `1px solid ${SOL.base2}` }}>
        {REF.map(([cmd, what], i) => (
          <div key={cmd} className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-6 sm:px-5" style={{ backgroundColor: i % 2 ? SOL.base3 : "#fffdf6", borderTop: i ? `1px solid ${SOL.base2}` : undefined }}>
            <code className="min-w-0 break-words font-mono text-[12.5px] font-medium" style={{ color: SOL.base02 }}>{cmd}</code>
            <span className="text-[14px] leading-[1.55]" style={{ color: SOL.base01 }}>{what}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const LIMITS: [string, ReactNode][] = [
  ["Does a worker see my conversation?", <>No. Spawned sessions start with no shared history. The brief is everything it knows, so write it like a ticket for someone who was not there. If it needs the history, fork instead.</>],
  ["Do the backends need to be installed?", <>Yes. codecast launches the agent CLIs you already have and are signed in to. It does not ship Codex, Cursor, Gemini or the rest.</>],
  ["Can I fork a session that is not mine?", <><C>cast fork -s &lt;id&gt;</C> forks another session you can see. Branches are always new sessions; the original is untouched.</>],
  ["Will workers edit the same files?", <>They can, if they share a checkout. Use <C>--isolated</C> or <C>cast ws</C> for parallel edits, and merge the results yourself.</>],
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
        {RELATED.map((slug) => {
          const f = getFeatureDeepDive(slug);
          if (!f) return null;
          return (
            <Link key={slug} href={featureHref(slug)} className="agx-card group block rounded-xl p-4 hover:-translate-y-0.5" style={{ backgroundColor: "#fffdf6", border: `1px solid ${SOL.base2}`, borderLeft: `3px solid ${f.color}` }}>
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
            Install the CLI, then ask your agent to hand a piece of its task to a Codex worker. It already knows the commands.
          </p>
        </div>
        <div className="min-w-0 rounded-xl p-4" style={{ backgroundColor: SOL.base3 }}>
          <InstallTabs location="feature-agents" compact />
        </div>
      </div>
    </section>
  );
}
