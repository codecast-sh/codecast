// A built card read back and held to its contract, for every reader: `cast
// decide --card` and a gate node's card attribute. A change card
// (shared/contracts/changeCard.ts) is what a decision rules on; a proposal
// card (shared/contracts/proposalCard.ts) is the proposal gate's. Never
// exits, so a runner can carry on without the card.
import * as fs from "fs";
import * as path from "path";
import { validateChangeCard, type ChangeCard } from "@codecast/shared/contracts/changeCard";
import { isProposalCard, validateProposalCard, type ProposalCard } from "@codecast/shared/contracts/proposalCard";

function readJsonFile(file: string): { raw: unknown } | { error: string } {
  try {
    return { raw: JSON.parse(fs.readFileSync(path.resolve(file), "utf-8")) };
  } catch (err) {
    return { error: `Could not read card ${file}: ${err instanceof Error ? err.message : err}` };
  }
}

export function readCardFile(file: string): { card: ChangeCard } | { error: string } {
  const read = readJsonFile(file);
  if ("error" in read) return read;
  const checked = validateChangeCard(read.raw);
  return checked.ok ? { card: checked.card } : { error: `The card in ${file} is not ready:\n  ${checked.errors.join("\n  ")}` };
}

/** A gate's card attribute: a change card, or a proposal card for the proposal gate. */
export function readGateCard(file: string): { card: ChangeCard } | { proposal: ProposalCard } | { error: string } {
  const read = readJsonFile(file);
  if ("error" in read) return read;
  if (!isProposalCard(read.raw)) return readCardFile(file);
  const checked = validateProposalCard(read.raw);
  return checked.ok ? { proposal: checked.card } : { error: `The proposal card in ${file} is not ready:\n  ${checked.errors.join("\n  ")}` };
}
