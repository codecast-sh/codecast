"use client";

import { commandLine, type CommandRun } from "@codecast/shared/contracts/commandRun";

// The command a `cast decide --run` card runs (shared/contracts/commandRun.ts):
// exactly what Run executes, then how it went. `line` is the queue row's one
// truncated line; `full` is the sheet and the decision page, with the output.

const STATE: Record<CommandRun["state"], { label: string; tone: string } | null> = {
  waiting: null,
  queued: { label: "Sent to the machine", tone: "text-sol-text-dim" },
  running: { label: "Running", tone: "text-sol-yellow" },
  done: { label: "Ran", tone: "text-sol-green" },
  failed: { label: "Failed", tone: "text-sol-red" },
  skipped: { label: "Not run", tone: "text-sol-text-dim" },
};

export function CommandRunView({ run, density = "full" }: { run: CommandRun; density?: "full" | "line" }) {
  const line = commandLine(run.argv);
  const state = STATE[run.state];
  const exit = run.exit_code !== undefined && run.state !== "done" ? ` · exit ${run.exit_code}` : "";
  if (density === "line") {
    return (
      <div className="mt-1 flex items-baseline gap-2 min-w-0 font-mono text-xs" data-command-run={run.state}>
        <span className="truncate text-sol-text-muted" title={line}>{line}</span>
        {state && <span className={`shrink-0 ${state.tone}`}>{state.label}{exit}</span>}
      </div>
    );
  }
  return (
    <div className="space-y-2" data-command-run={run.state}>
      <pre className="m-0 rounded border border-sol-border bg-sol-bg-alt px-3 py-2 font-mono text-xs text-sol-text whitespace-pre-wrap break-all">
        <span className="select-none text-sol-text-dim">$ </span>{line}
      </pre>
      {state && <div className={`text-xs ${state.tone}`}>{state.label}{exit}</div>}
      {run.output && (
        <pre className="m-0 max-h-64 overflow-auto rounded border border-sol-border px-3 py-2 font-mono text-[11px] text-sol-text-muted whitespace-pre-wrap break-all">{run.output}</pre>
      )}
    </div>
  );
}
