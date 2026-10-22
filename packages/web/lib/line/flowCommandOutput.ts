// What a `cast flow` command in a transcript names (docs/architecture/flows.md
// FL6): the flow it ran or showed, and the run it started. Read from the
// command's own words and the CLI's output (`run <id> · cast workflow runs`,
// or `--json`'s `"run_id"`). Pure.

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

export type FlowCommandTarget = { flow: string | null; runId: string | null; dryRun: boolean };

export function flowCommandTarget(subcommand: string, args: string, output: string, isError: boolean): FlowCommandTarget {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const flow = subcommand === "run" || subcommand === "show" ? (words.find((w) => !w.startsWith("-") && !/^ct-\d+$/.test(w)) ?? null)?.replace(/^["']|["']$/g, "") ?? null : null;
  const dryRun = words.includes("--dry-run");
  const text = stripAnsi(output);
  const runId = subcommand === "run" && !isError && !dryRun ? (text.match(/"run_id"\s*:\s*"([a-z0-9]+)"/)?.[1] ?? text.match(/\brun ([a-z0-9]{20,})\b/)?.[1] ?? null) : null;
  return { flow, runId, dryRun };
}
