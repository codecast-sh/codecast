// The confirm review for writing a pull request's guide (components/pr/PRGuide):
// what the press spends and what the model reads, as data, so it is testable
// without a browser.
import { priceFor, usageCost } from "@platform/agent/meter";
import type { SwitchLedger } from "../components/consequential/ConsequentialSwitch";
import { usd } from "../components/consequential/lineStartLedger";
import { prettifyModelId } from "@codecast/shared/contracts/modelOptions";

export type PrGuideFile = { filename: string; additions: number; deletions: number; patch?: string };
export type PrGuideLedgerPr = { number: number; files?: PrGuideFile[] };

const GUIDE_MODEL = "claude-sonnet-5-5";
/** What prGuidePrompt sends at most, and what a guide's reply plus thinking tends to use; for the estimate only. */
const DIFF_CHARS = 150_000;
const PROMPT_OVERHEAD_TOKENS = 1_500;
const REPLY_TOKENS = 6_000;
const DAILY_CAP_USD = 5;

/** A rough price for writing this PR's guide, from the diff text it would send. */
export function estimateGuideCost(files: readonly PrGuideFile[]): number {
  const chars = Math.min(DIFF_CHARS, files.reduce((n, f) => n + (f.patch?.length ?? 0) * 1.1, 0));
  const input = Math.round(chars / 3.5) + PROMPT_OVERHEAD_TOKENS;
  return usageCost({ input, output: REPLY_TOKENS, cacheRead: 0, cacheWrite: 0 }, priceFor(GUIDE_MODEL));
}

export function writeGuideLedger(pr: PrGuideLedgerPr, rewrite: boolean): SwitchLedger {
  const files = pr.files ?? [];
  const lines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  return {
    name: rewrite ? "Rewrite the guide" : "Write a guide",
    subject: `PR #${pr.number}`,
    shift: null,
    figures: [
      { value: `~${usd(estimateGuideCost(files))}`, label: "estimated", tone: "warn" },
      { value: String(files.length), label: files.length === 1 ? "file" : "files" },
      { value: lines.toLocaleString("en-US"), label: "lines changed" },
    ],
    rows: [
      { k: "Model", v: prettifyModelId(GUIDE_MODEL) },
      { k: "Reads", v: "Title, description, diff" },
      { k: "Visible to", v: "Your team" },
      { k: "Team spend", v: `up to ${usd(DAILY_CAP_USD)} a day` },
    ],
    confirm: rewrite ? "Rewrite guide" : "Write guide",
  };
}

