"use client";

import { commandLine, runFolder, type CommandRun } from "@codecast/shared/contracts/commandRun";
import { deviceDisplayName } from "@codecast/shared/contracts";
import { useDevices } from "../DeviceBadge";

// The command a `cast decide --run` card runs (shared/contracts/commandRun.ts):
// exactly what Run executes and where (the machine and the folder), then how
// it went. `line` is the queue row's one truncated line; `full` is the sheet
// and the decision page, with the output.

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
  const device = useDevices().byId.get(run.device_id ?? "");
  const where = [device ? deviceDisplayName(device) : run.device_id ? `machine ${run.device_id.slice(0, 8)}` : "the session's machine", runFolder(run.cwd)].filter(Boolean).join(" · ");
  const state = STATE[run.state];
  const exit = run.exit_code !== undefined && run.state !== "done" ? ` · exit ${run.exit_code}` : "";
  if (density === "line") {
    return (
      <div className="mt-1 flex items-baseline gap-2 min-w-0 font-mono text-xs" data-command-run={run.state}>
        <span className="truncate text-sol-text-muted" title={`${line}\n${where}`}>{line}</span>
        {state && <span className={`shrink-0 ${state.tone}`}>{state.label}{exit}</span>}
      </div>
    );
  }
  return (
    <div className="space-y-2" data-command-run={run.state}>
      <pre className="m-0 rounded border border-sol-border bg-sol-bg-alt px-3 py-2 font-mono text-xs text-sol-text whitespace-pre-wrap break-all">
        <span className="select-none text-sol-text-dim">$ </span>{line}
      </pre>
      <div className="text-xs text-sol-text-dim" data-command-run-where>on {where}</div>
      {state && <div className={`text-xs ${state.tone}`}>{state.label}{exit}</div>}
      {run.output && (
        <pre className="m-0 max-h-64 overflow-auto rounded border border-sol-border px-3 py-2 font-mono text-[11px] text-sol-text-muted whitespace-pre-wrap break-all">{run.output}</pre>
      )}
    </div>
  );
}
