// Team instruction fragments: each enabled `authored/<team>/instructions/<name>`
// item becomes one owned section in every agent instruction file on this
// machine (getSnippetTargets: ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md when
// Codex is installed), through the driver's markdown_section arm. The section
// is headed with the team and item name and closed by a marker carrying the
// slug, so the same writer and the same hand-edit model serve builtin
// snippets and team fragments.
//
// The reconciler calls exactly this:
//
//   applyInstructionFragments({
//     home: string,
//     fragments: Array<{ slug: string; teamName: string; name: string; body: string; hash: string; projectRoot?: string }>,
//     dryRun?: boolean,
//     hold?: string[],
//     projectWrites?: "off" | "ignored_only" | "all",
//     log?: (line: string) => void,
//   }): InstructionFragmentsOutcome
//
// `fragments` is the COMPLETE enabled set for this pass: a slug this module
// wrote before that is absent from it (and from `hold`) has its section cut.
// Put a slug that is still enabled but whose version could not be fetched this
// beat in `hold`, so a network blip never cuts and re-adds a section.
// `body` is the item's main_body; a leading heading line in it is dropped, since
// the section's own heading names the team and the item. `projectRoot` scopes a
// fragment to one repository's CLAUDE.md / AGENTS.md, written only where
// projectWrites.ts allows (never a tracked file).
//
// The ledger of what was written lives beside the other capability state, in
// ~/.codecast/capabilities/sections.json, and is read and written here so the
// caller holds nothing. The caller holds the capability lock.

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFile } from "../atomicWrite.js";
import { apply, planSections, type DesiredSection, type DriverLedger, type PlannedOp } from "./driver.js";
import type { ProjectWritesSetting } from "./projectWrites.js";

export interface InstructionFragment {
  slug: string;
  teamName: string;
  name: string;
  body: string;
  /** The version's folder_hash; reported, not compared (the region's own
   *  content decides whether anything is written). */
  hash: string;
  projectRoot?: string;
}

export interface InstructionFragmentsInput {
  home: string;
  fragments: InstructionFragment[];
  dryRun?: boolean;
  hold?: string[];
  projectWrites?: ProjectWritesSetting;
  log?: (line: string) => void;
}

export interface InstructionFragmentsOutcome {
  /** Every planned op, conflicts included (the applied-ops report). */
  ops: PlannedOp[];
  /** Files whose bytes changed by a write. Empty in a dry run. */
  wrote: string[];
  /** Files a section was cut from. Empty in a dry run. */
  removed: string[];
  /** locally_modified, locally_removed, project_write_refused, invalid_slug. */
  conflicts: Array<{ slug: string; reason: string; detail?: string }>;
}

export function sectionsLedgerPath(home: string): string {
  return path.join(home, ".codecast", "capabilities", "sections.json");
}

function readLedger(file: string): DriverLedger {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return { files: {}, sections: raw && typeof raw.sections === "object" ? raw.sections : {} };
  } catch {
    return { files: {}, sections: {} };
  }
}

/** A published section usually carries its own heading line; the region's
 *  heading replaces it. */
function withoutLeadingHeading(body: string): string {
  return body.replace(/^\s*#{1,6}\s[^\n]*\n?/, "");
}

export function fragmentSection(f: InstructionFragment): DesiredSection {
  return {
    slug: f.slug,
    heading: `${f.teamName}: ${f.name}`,
    body: withoutLeadingHeading(f.body),
    ...(f.projectRoot ? { projectRoot: f.projectRoot } : {}),
  };
}

export function applyInstructionFragments(input: InstructionFragmentsInput): InstructionFragmentsOutcome {
  const ledgerFile = sectionsLedgerPath(input.home);
  const ledger = readLedger(ledgerFile);
  const ops = planSections(input.fragments.map(fragmentSection), ledger, {
    home: input.home,
    hold: input.hold,
    projectWrites: input.projectWrites,
    log: input.log,
  });
  const conflicts = ops.flatMap((op) => (op.op === "conflict" ? [{ slug: op.slug, reason: op.reason, detail: op.detail }] : []));
  if (input.dryRun) return { ops, wrote: [], removed: [], conflicts };

  const outcome = apply(ops, ledger);
  if (JSON.stringify(outcome.ledger.sections ?? {}) !== JSON.stringify(ledger.sections ?? {})) {
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    atomicWriteFile(ledgerFile, JSON.stringify({ sections: outcome.ledger.sections ?? {} }, null, 2) + "\n");
  }
  return { ops, wrote: outcome.wrote, removed: outcome.removed, conflicts };
}
