// A built change card (cast card build) read back and held to its contract
// (shared/contracts/changeCard.ts), for every reader: `cast decide --card` and
// a gate node's card attribute. Never exits, so a runner can carry on
// without the card.
import * as fs from "fs";
import * as path from "path";
import { validateChangeCard, type ChangeCard } from "@codecast/shared/contracts/changeCard";

export function readCardFile(file: string): { card: ChangeCard } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf-8"));
  } catch (err) {
    return { error: `Could not read card ${file}: ${err instanceof Error ? err.message : err}` };
  }
  const checked = validateChangeCard(raw);
  return checked.ok ? { card: checked.card } : { error: `The card in ${file} is not ready:\n  ${checked.errors.join("\n  ")}` };
}
