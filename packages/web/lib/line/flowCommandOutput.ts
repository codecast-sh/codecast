// What a `cast flow` command in a transcript names (docs/architecture/flows.md
// FL6): the flow it ran or showed, and the run it started. Read from the
// command's own words and the CLI's output (`run <id> · cast workflow runs`,
// or `--json`'s `"run_id"`). Pure.

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

export type FlowCommandTarget = { flow: string | null; runId: string | null; dryRun: boolean };

export function flowCommandTarget(subcommand: string, args: string, output: string, isError: boolean): FlowCommandTarget {
  // Words as the shell reads them: a quoted label ("Union fix flow") is one.
  const words = [...args.trim().matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  const text = stripAnsi(output);
  // `show <live flow>` may name it by label or id: its block's first line names the flow's slug (`● on   Union fix flow  agentwatch`).
  const liveSlug = subcommand === "show" && !isError ? (text.match(/^[●○] (?:on |off)  .*  (\S+)$/m)?.[1] ?? null) : null;
  // The flag a value follows is skipped with it; `show @handle`, from an older CLI, named a role's flow: no graph to draw.
  const named = subcommand === "run" || subcommand === "show" ? (words.find((w, i) => !w.startsWith("-") && !/^--(title|task|branch|pr|only|team|session)$/.test(words[i - 1] ?? "") && !/^ct-\d+$/.test(w)) ?? null) : null;
  const flow = liveSlug ?? (named && !/^(@|or-\d)/.test(named) ? named : null);
  const dryRun = words.includes("--dry-run");
  const runId = subcommand === "run" && !isError && !dryRun ? (text.match(/"run_id"\s*:\s*"([a-z0-9]+)"/)?.[1] ?? text.match(/\brun ([a-z0-9]{20,})\b/)?.[1] ?? null) : null;
  return { flow, runId, dryRun };
}
