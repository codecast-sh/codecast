// Codecast's run anatomy, the tabs its host adds under a run (host.tsx
// useRunPanels): every model call, the agent's transcript, what the dry-run
// guard caught, and the run folder with one file open. These read codecast's
// own run folder (callN/, agentN/, calls.log, GET /run/:id/file), so they stay
// in codecast while the run page they sit under is shared.

import { useState } from "react";
import type { RunResponse } from "@codecast/shared/contracts/evalsApi";
import type { RunPanel, RunPanelContext } from "@platform/evals/react";
import { useEvalsResource } from "../../lib/evals/hooks";
import { AgentTranscript } from "./AgentTranscript";
import { CallPane } from "./CallPane";
import { GuardLog } from "./GuardLog";
import { RunFiles } from "./RunFiles";

export type AnatomyTab = "calls" | "agent" | "guard" | "files";

const ANATOMY_TAB_WORDS: Record<AnatomyTab, string> = { calls: "Calls", agent: "Agent", guard: "Guard", files: "Files" };

/** The anatomy tabs a rep has: Calls when it made calls, Agent and Guard on agent routes, and always Files. */
export function anatomyTabs(run: Pick<RunResponse, "run" | "calls" | "agents" | "guard">): AnatomyTab[] {
  const agent = run.run.route === "agent" || run.agents.length > 0;
  return [...(run.calls.length || !agent ? (["calls"] as const) : []), ...(agent ? (["agent"] as const) : []), ...(agent || run.guard.length ? (["guard"] as const) : []), "files"];
}

export function useCodecastRunPanels(run: RunResponse, { previousEpoch }: RunPanelContext): RunPanel[] {
  const row = run.row;
  // The open file belongs to one run: a different run opens with none.
  const [open, setOpen] = useState<{ run: string; path: string } | null>(null);
  const path = open?.run === row.id ? open.path : null;
  const file = useEvalsResource("GET /run/:id/file", path ? { params: { id: row.id }, query: { path } } : null);

  const body: Record<AnatomyTab, RunPanel["body"]> = {
    calls: run.calls.length ? (
      <div className="flex flex-col gap-4">
        {run.calls.map((c) => (
          <CallPane key={c.n} call={c} runId={row.id} dry={row.status === "dry"} previousEpochRun={previousEpoch.id} previousWhy={previousEpoch.why} />
        ))}
      </div>
    ) : (
      <div className="ev-card ev-empty-note">{row.status === "crash" ? "The rep crashed before its first call landed." : "This rep made no model calls."}</div>
    ),
    agent: run.agents.length ? (
      <div className="flex flex-col gap-6">
        {run.agents.map((a) => (
          <AgentTranscript key={a.n} agent={a} runId={row.id} previousEpochRun={previousEpoch.id} previousWhy={previousEpoch.why} />
        ))}
      </div>
    ) : (
      <div className="ev-card ev-empty-note">{row.status === "crash" ? "The rep crashed before the agent wrote a turn." : "No agent folder in this run."}</div>
    ),
    guard: <GuardLog entries={run.guard} counts={row.guard} />,
    files: (
      <RunFiles
        files={run.files}
        open={path ? { path, data: file.data?.path === path ? file.data : null, loading: file.loading, error: file.error } : null}
        onOpen={(p) => setOpen({ run: row.id, path: p })}
      />
    ),
  };
  const read = row.guard.live > 0 || run.guard.some((g) => g.status === "LIVE");
  const extra: Record<AnatomyTab, Pick<RunPanel, "count" | "flag">> = {
    calls: { count: run.calls.length },
    agent: {},
    guard: { count: run.guard.length, flag: read ? "It read the live workspace" : null },
    files: { count: run.files.filter((f) => f.kind === "file").length },
  };
  return anatomyTabs(run).map((id) => ({ id, label: ANATOMY_TAB_WORDS[id], ...extra[id], body: body[id] }));
}
