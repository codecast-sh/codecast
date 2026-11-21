// The confirm for proposing a pipeline edit from the page (pipeline.md PL5), in the shared confirm flow's terms.
import type { SwitchLedger } from "./ConsequentialSwitch";

/** Proposing an edit to a repo's pipeline (pipeline.md PL5): a session starts in the repo, runs the exact `cast flow edit`
 *  command, and ships the change through the flow it edits. Nothing changes until that lands. */
export function pipelineEditLedger(r: { repo: string; words: string; command: string; flow: string; machine: string | null; hits: { hits: number; total: number } | null }): SwitchLedger {
  return {
    name: `Edit ${r.repo}'s pipeline`,
    subject: r.words,
    shift: null,
    figures: [
      { value: "1", label: "agent session starts", tone: "warn" },
      ...(r.hits ? [{ value: `${r.hits.hits}/${r.hits.total}`, label: "recent changes it would have run on" }] : []),
    ],
    rows: [
      { k: "Starts", v: `A session in ${r.repo}${r.machine ? ` on ${r.machine}` : ""}` },
      { k: "It runs", v: r.command },
      { k: "Then", v: `Ships the edit through the ${r.flow} flow, like any change` },
      { k: "Until it lands", v: "The pipeline shows it as proposed" },
    ],
    stop: "Stop the session",
    confirm: "Start the edit session",
    keep: "Not now",
  };
}
