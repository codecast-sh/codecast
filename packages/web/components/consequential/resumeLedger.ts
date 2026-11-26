// The confirm for resuming a stopped personal Ship at Land (lib/ship/resumeAt.ts): it may push the change to main and
// deploy it, so it is never one bare press (AGENTS.md, consequential presses). The web's Ship bar shows it as a review,
// the phone as an alert of the same lines.
import type { SwitchLedger } from "./ConsequentialSwitch";
import type { ResumeAt } from "../../lib/ship/resumeAt";

export function resumeAtLedger(resume: ResumeAt): SwitchLedger {
  return {
    name: `Resume at ${resume.label}`,
    subject: "This run",
    shift: null,
    figures: [],
    rows: [
      { k: "First", v: "Reads origin's main" },
      { k: "If it landed", v: "Records it, then deploys", tone: "warn" },
      { k: "If not", v: "Pushes it to main, then deploys", tone: "warn" },
      { k: "Asks you", v: "Never: it was reviewed" },
    ],
    stop: "Cancel the run",
    confirm: `Resume at ${resume.label}`,
    keep: "Not now",
  };
}
