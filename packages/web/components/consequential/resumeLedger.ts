// The confirm for resuming a stopped run at the station its stop names (lib/ship/resumeAt.ts): a personal Ship at Land
// may push the change to main and deploy it, and a change run resumed at PR runs CI and a review again, then goes on
// to merge and deploy, so it is never one bare press (AGENTS.md, consequential presses). The web's Ship bar shows it as a review,
// the phone as an alert of the same lines.
import type { SwitchLedger } from "./ConsequentialSwitch";
import type { ResumeAt } from "../../lib/ship/resumeAt";

export function resumeAtLedger(resume: ResumeAt): SwitchLedger {
  const frame = { name: `Resume at ${resume.label}`, subject: "This run", shift: null, figures: [], stop: "Cancel the run", confirm: `Resume at ${resume.label}`, keep: "Not now" };
  // A personal Ship's Land: the push may or may not have happened.
  if (resume.at === "land") {
    return {
      ...frame,
      rows: [
        { k: "First", v: "Reads origin's main" },
        { k: "If it landed", v: "Records it, then deploys", tone: "warn" },
        { k: "If not", v: "Pushes it to main, then deploys", tone: "warn" },
        { k: "Asks you", v: "Never: it was reviewed" },
      ],
    };
  }
  // A change run whose change was ready when a station stopped it (CI never reported, main stayed red): a resume is a
  // new attempt, so its round runs again from PR.
  return {
    ...frame,
    rows: [
      { k: "First", v: resume.at === "pr" ? "Runs CI and a fresh review again on the same change" : `Runs ${resume.label} again on the same change` },
      { k: "Then", v: "Goes on as the run would: merge, then deploy", tone: "warn" },
      { k: "Asks you", v: "Only where the run asks a person" },
    ],
  };
}
