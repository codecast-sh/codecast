"use client";

import type { ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { AGENT_COLOR, AgentTag, T, Term } from "./parts";

const PAPER = "#fffdf6";
const frame = { backgroundColor: PAPER, border: `1px solid ${SOL.base2}`, boxShadow: "0 22px 44px -32px rgba(0,43,54,0.45)" };

/** `cast sessions -w --json`: silent until something changes, then one NDJSON line per change. */
export function WatchTerm() {
  const ev = (to: string, id: string, color: string) => (
    <span>
      {T.dim('{"event":"transition","id":"')}{T.c(id, SOL.base1)}{T.dim('","to":"')}{T.c(to, color)}{T.dim('",…}')}{"\n"}
    </span>
  );
  return (
    <Term label="parent session" wrap>
      {T.cmd('cast spawn --subagent --agent codex -- \\')}
      {T.c('    "load test the retry path" "fuzz the parser"\n', SOL.base2)}
      {T.c("✓", SOL.green)}{T.c(" spawned 2 sessions in ", SOL.base0)}{T.dim("~/src/api")}{T.c(" — nested under ", SOL.base0)}{T.c("jx7r3tq", SOL.cyan)}{T.c(" as subagent rows:\n", SOL.base0)}
      {"  "}{T.c("jx7aa21", SOL.cyan)}{T.c("  load test the retry path\n", SOL.base0)}
      {"  "}{T.c("jx7aa22", SOL.cyan)}{T.c("  fuzz the parser\n\n", SOL.base0)}
      {T.cmd("cast sessions jx7aa21 jx7aa22 -w --json")}
      {T.dim("# prints nothing until a state changes\n")}
      {ev("done", "jx7aa21", SOL.green)}
      {ev("needs_input", "jx7aa22", SOL.orange)}
      {"\n"}
      {T.cmd('cast read jx7aa22 --ask "what is it blocked on?"')}
      {T.c("It needs a corpus path. The brief named none (line 4).\n\n", SOL.base0)}
      {T.cmd('cast send jx7aa22 "use testdata/fuzz, then stop at 10 minutes"')}
      {T.c("✓", SOL.green)}{T.dim(" sent to ")}{T.c("jx7aa22", SOL.cyan)}{T.dim(" from ")}{T.c("jx7r3tq", SOL.cyan)}{"\n"}
    </Term>
  );
}

/** Two sessions side by side, with a message crossing between them. */
export function SendMock() {
  const Lane = ({ agent, title, id, children }: { agent: string; title: string; id: string; children: ReactNode }) => (
    <div className="min-w-0 rounded-xl overflow-hidden" style={frame}>
      <div className="flex items-center gap-2 px-3 py-2 font-mono text-[11px]" style={{ borderBottom: `1px solid ${SOL.base2}`, color: SOL.base1 }}>
        <AgentTag agent={agent} size="xs" />
        <span className="min-w-0 truncate font-semibold" style={{ color: SOL.base02 }}>{title}</span>
        <span className="ml-auto shrink-0">{id}</span>
      </div>
      <div className="grid grid-cols-1 gap-2.5 px-3 py-3">{children}</div>
    </div>
  );
  const Line = ({ who, children }: { who: string; children: ReactNode }) => (
    <div className="text-[12.5px] leading-[1.55]" style={{ color: SOL.base01 }}>
      <span className="mr-1.5 font-mono text-[10.5px] font-semibold" style={{ color: AGENT_COLOR[who] }}>{who}</span>{children}
    </div>
  );
  const Envelope = ({ from, children }: { from: string; children: ReactNode }) => (
    <div className="rounded-md px-2.5 py-2" style={{ borderLeft: `2px solid ${SOL.cyan}`, backgroundColor: "rgba(42,161,152,0.07)" }}>
      <div className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-wide" style={{ color: SOL.cyan }}>
        <span aria-hidden>↳</span>Message from
        <span className="rounded border px-1.5 py-px normal-case tracking-normal" style={{ borderColor: `${SOL.cyan}55`, backgroundColor: PAPER }}>{from}</span>
      </div>
      <div className="mt-0.5 text-[12.5px] leading-[1.5]" style={{ color: SOL.base01 }}>{children}</div>
    </div>
  );
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2" role="img" aria-label="An API session sends a message to a web session, which answers with the commit it made">
      <Lane agent="claude" title="Rename the user endpoint" id="jx7c6zk">
        <Line who="claude">Renamed <span className="font-mono">/v1/user</span> to <span className="font-mono">/v1/account</span>. The web client still calls the old path.</Line>
        <div className="rounded-md px-2.5 py-1.5 font-mono text-[11px] overflow-x-auto whitespace-nowrap" style={{ backgroundColor: SOL.base03, color: SOL.base2 }}>
          <span style={{ color: SOL.green }}>$ </span>cast send jx7d1mp &quot;/v1/user is now /v1/account&quot;
        </div>
        <Envelope from="jx7d1mp">Done in a4c91e2. Both calls moved, typecheck green.</Envelope>
      </Lane>
      <Lane agent="codex" title="Settings page polish" id="jx7d1mp">
        <Envelope from="jx7c6zk">/v1/user is now /v1/account. Your settings page calls it twice.</Envelope>
        <Line who="codex">Updating both calls before I touch the form.</Line>
        <div className="rounded-md px-2.5 py-1.5 font-mono text-[11px] overflow-x-auto whitespace-nowrap" style={{ backgroundColor: SOL.base03, color: SOL.base2 }}>
          <span style={{ color: SOL.green }}>$ </span>cast send jx7c6zk &quot;Done in a4c91e2. …&quot;
        </div>
      </Lane>
    </div>
  );
}

/** The cost gate on waking a stale session. */
export function WakeGateTerm() {
  return (
    <Term label="sending to a session idle for three hours" wrap>
      {T.cmd('cast send jx7q0ve "can you rebase onto main?"')}
      {T.c("Not sent. ", SOL.yellow)}{T.dim("jx7q0ve has not run for 3h, so its prompt cache has expired. Your message would make it rebuild its whole context (about 412k tokens, 41% of its context window) before it reads a word, and sessions idle this long rarely have anything to add. To learn what it did, read it instead: cast read jx7q0ve, cast diff jx7q0ve. If it has to act on this and nobody else can, send again with --wake.\n")}
    </Term>
  );
}

/** cast exec in a script: stdout is the answer, exit code is the agent's. */
export function ExecTerm() {
  return (
    <Term label="scripts/precommit.sh" wrap>
      {T.cmd('git diff --cached | cast exec --agent codex --effort high "review this diff; list real bugs only"')}
      {T.c("1. retry.ts:48 compares ms to seconds, so the cap never applies.\n\n", SOL.base0)}
      {T.cmd("cast exec --output-format json --json-schema schema.json \"classify these failures\" < ci.log")}
      {T.c('{"flaky":3,"real":1,"infra":0}\n\n', SOL.base0)}
      {T.cmd('cast exec -j 4 "audit auth" "audit billing" "audit uploads" "audit search"')}
      {T.dim("# four runs, at most four at once\n\n")}
      {T.cmd('cast exec --chain review-then-fix "the retry cap ignores config"')}
      {T.dim("# each named step's output feeds the next\n")}
    </Term>
  );
}

/** Isolated fan-out: one worktree per worker, its own ports and env. */
export function WorktreeMock() {
  const rows = [
    { name: "refactor-store", agent: "claude", port: "3210", state: "working" },
    { name: "rewrite-router", agent: "codex", port: "3220", state: "working" },
    { name: "fix-auth-bug", agent: "gemini", port: "3230", state: "done" },
  ];
  return (
    <div className="rounded-xl overflow-hidden font-mono" style={frame} role="img" aria-label="Three worktrees, one per worker, each with its own port">
      <div className="flex items-center gap-2 px-3.5 py-2 text-[11px]" style={{ borderBottom: `1px solid ${SOL.base2}`, color: SOL.base1 }}>
        <span className="font-semibold" style={{ color: SOL.base01 }}>~/src/app</span>
        <span>main checkout</span>
        <span className="ml-auto">cast ws ls</span>
      </div>
      <div className="px-3.5 py-2.5">
        {rows.map((r) => (
          <div key={r.name} className="flex items-center gap-2.5 py-1.5 text-[12px]">
            <span style={{ color: SOL.base1 }}>└</span>
            <span className="min-w-0 flex-1 truncate" style={{ color: SOL.base02 }}>.codecast/worktrees/{r.name}</span>
            <span className="hidden sm:inline text-[10.5px]" style={{ color: SOL.base1 }}>:{r.port}</span>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: AGENT_COLOR[r.agent] }} />
            <span className="w-14 shrink-0 text-right text-[10.5px]" style={{ color: r.state === "done" ? SOL.green : SOL.yellow }}>{r.state}</span>
          </div>
        ))}
      </div>
      <div className="px-3.5 py-2 text-[10.5px]" style={{ borderTop: `1px solid ${SOL.base2}`, backgroundColor: SOL.base3, color: SOL.base1 }}>
        .env copied · setup commands run · ports from .codecast/workspace.toml
      </div>
    </div>
  );
}
