// Throwaway harness: mounts the real CastCommandBlock for every cast mutation
// shape that carries prose, so the body block can be screenshot-verified without
// hunting a live transcript. Delete before finishing.
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { MemoryRouter } from "react-router";
import "./app/globals.css";
import { CastCommandBlock } from "./components/ConversationView";
import { CONVEX_URL } from "./lib/localAuth";

const convex = new ConvexReactClient(CONVEX_URL);

const REPORT = `LIVE SHAKEDOWN REPORT — freeze-and-simulate harness (ct-42217)

Ran the full horizon against prod data. Four findings, one fix landed:

1. **Cone contacts** drifted 3% from the sim baseline — expected, the seed moved.
2. Report counter bug: "agent runs" counted a sim-event kind nothing emits — always 0. Fixed to count real \`agent_runs\` rows on cone contacts (report now correctly says 21).

CHECKLIST CLOSE-OUT:
- E2E sentinel: PASS (v6, full horizon, all assertions, teardown-clean).
- Eval-suite gate: inherited — the pre-blip full run's sims layer was 48/48 PASS.

\`\`\`ts
const cone = await ctx.db.query("agent_runs").withIndex("by_contact").collect();
\`\`\``;

const cmd = (command: string, id = Math.random().toString(36).slice(2)) => ({
  id,
  name: "Bash",
  input: JSON.stringify({ command }),
});

const CASES: Array<{ title: string; command: string; output?: string }> = [
  {
    title: "task comment — long heredoc report (the screenshot case)",
    command: `cast task comment ct-42217 - <<'EOF'\n${REPORT}\nEOF`,
  },
  {
    title: "task comment — short quoted body",
    command: `cast task comment ct-40004 "wired the parser, deploying next" -t progress`,
  },
  {
    title: "plan comment — decision with rationale",
    command: `cast plan comment pl-88 "use postgres for the ledger" -d -r "convex has no joins and the report needs three"`,
  },
  {
    title: "task done — summary note",
    command: `cast task done ct-40004 -m "verified end to end on prod; regression test added"`,
  },
  {
    title: "plan create — goal and body",
    command: `cast plan create "Rewrite the sync layer" -g "one write path for every table" -b "## Steps\\n1. registry\\n2. cutover"`,
  },
  {
    title: "trigger add — multi-line prompt",
    command: `cast trigger add - --every 4h --title "Growth audit" <<'EOF'\nAudit budget allocation across markets.\n\n1. Verify the plan matches achievable yield.\n2. Measure growth per dollar for markets funded in the last 14 days.\n\nEscalate only strategic decisions to the founder.\nEOF`,
  },
  {
    title: "state — pinned thread state",
    command: `cast state - <<'EOF'\nStatus: sync layer rewritten, tests green\nBlocked: needs a prod key before the last check\nNext: deploy once the key lands\nEOF`,
  },
  {
    title: "task comment — shell-expanded body (nothing honest to quote)",
    command: `cast task comment ct-40004 "$(cat /tmp/notes.md)"`,
  },
  {
    title: "task ls — a query carries no body",
    command: `cast task ls -q "auth"`,
    output: "ct-40004  open  Fix the auth race\nct-42217  done  Freeze harness",
  },
];

createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <ConvexProvider client={convex}>
    <div className="bg-sol-bg text-sol-text p-8 min-h-screen">
      <div className="max-w-[760px] space-y-6">
        {CASES.map((c, i) => (
          <div key={i}>
            <div className="text-[10px] uppercase tracking-wider text-sol-text-dim mb-1">{c.title}</div>
            <div className="rounded border border-sol-border/40 bg-sol-bg-alt/30 px-3 py-2">
              <CastCommandBlock
                tool={cmd(c.command, `t${i}`) as any}
                result={c.output ? ({ id: `t${i}`, content: c.output } as any) : undefined}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
    </ConvexProvider>
  </MemoryRouter>,
);
