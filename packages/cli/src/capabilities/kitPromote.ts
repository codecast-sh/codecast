// The work behind `cast cap promote` (promote.ts registers the verb): move guidance out of a person's own instruction file to
// where it belongs, a repository's CLAUDE.md or a team instructions item.
//
// A model reads the personal file beside both destinations and proposes which
// lines move where; nothing here matches keywords. Lines whose meaning is
// already at the destination are named and skipped. The person accepts or
// declines each proposal, and only accepted lines are written: repository
// lines into the repo file under the section the model named, team lines as a
// new version of a team instructions item, published through
// `cast cap publish --instructions`. Removing the moved lines from the
// personal file is a separate question asked once at the end.
//
// The personal file's codecast-owned sections (builtin snippets and installed
// team kit items) are not the person's lines: they are never proposed, and
// the team items among them are what the model reads as the team destination.

import * as fs from "fs";
import * as path from "path";
import { REFERENCES_SECTION, SNIPPET_CATALOG } from "@codecast/shared/contracts";
import type { ModelCallResult, ModelCallSpec } from "@codecast/shared/contracts/modelCall";
import { parseJsonBlock } from "@codecast/shared/contracts/modelCall";
import { writeHarnessFile } from "../harness.js";
import { findOwnedSections } from "../snippets.js";
import { findKitSections } from "./driver.js";
import { headingSlug } from "./kitPublish.js";

export const PROMOTE_MODEL = "claude-sonnet-5-5";

export interface PromoteDeps {
  home: string;
  /** The personal instruction file; ~/.claude/CLAUDE.md when absent. */
  personalFile?: string;
  /** The repository root, or null outside one (team is then the only destination). */
  repoRoot: string | null;
  model: (spec: ModelCallSpec) => Promise<ModelCallResult>;
  modelId?: string;
  /** One question to the person; resolves to their answer. */
  ask: (question: string) => Promise<string>;
  /** Publish `file#heading` as a team instructions item; resolves to whether it published. */
  publishInstructions: (file: string, heading: string) => Promise<boolean>;
  print: (line: string) => void;
  /** List the proposals without asking or writing. */
  scan?: boolean;
}

export interface PromoteMove {
  lines: number[];
  destination: "repo" | "team";
  section?: string;
  item?: string;
  already_present?: string;
  conflicts?: string;
}

export interface PromoteReport {
  proposed: PromoteMove[];
  skipped: PromoteMove[];
  accepted: PromoteMove[];
  declined: PromoteMove[];
  /** Files written or items published. */
  wrote: string[];
  removedFromPersonal: number;
}

const SYSTEM = `You sort the guidance in one person's personal agent instruction file. Everything in that file is read by every session the person runs, in every repository, so guidance that is really about one repository, or that the person's whole team should follow, is in the wrong place: the right sessions miss it and the personal file fills with things that are not about the person.

Decide, for each unit of guidance (one line, or consecutive lines that state one rule together), whether it belongs in the repository's instructions, in the team's shared instructions, or stays personal. How the person likes to work, communicate and be answered, and anything about their own accounts, machines or private tools, stays personal. Guidance tied to this repository's code, commands, layout or conventions belongs to the repository. Guidance about how the team works that holds across its repositories belongs to the team. When a unit could be either personal or shared, leave it personal: moving a line publishes it to other people.

Read each destination's current text before proposing a move there. When a unit's meaning is already present at its destination in any wording, report it as already present and say where, rather than proposing to add it again.

For a repository move, name the existing section heading of the repository file it fits under, or a short new heading. For a team move, name the existing team item it extends, or a short name for a new item.

When a personal unit contradicts what its destination says, it is not a move: report it with what it contradicts, so the person can correct the personal line.

Answer with one JSON object and nothing else. Its "moves" field is a list; each entry has "lines" (the unit's line numbers as plain integers), "destination" ("repo" or "team"), "section" for a repository move, "item" for a team move, "already_present" (where the meaning already is) only when it is already there, and "conflicts" (what at the destination it contradicts) only when it contradicts it. Leave out every unit that stays personal.`;

const SCHEMA = {
  type: "object",
  properties: {
    moves: {
      type: "array",
      items: {
        type: "object",
        properties: {
          lines: { type: "array", items: { type: "integer" } },
          destination: { type: "string", enum: ["repo", "team"] },
          section: { type: "string" },
          item: { type: "string" },
          already_present: { type: "string" },
          conflicts: { type: "string" },
        },
        required: ["lines", "destination"],
      },
    },
  },
  required: ["moves"],
};

/** Line numbers (1-based) that sit inside a codecast-owned region. */
function ownedLines(text: string): Set<number> {
  const blocks = [
    ...[...SNIPPET_CATALOG.flatMap((s) => (s.section ? [s.section.spec] : [])), REFERENCES_SECTION].flatMap((spec) => findOwnedSections(text, spec)),
    ...findKitSections(text),
  ];
  const owned = new Set<number>();
  for (const b of blocks) {
    const first = text.slice(0, b.start).split("\n").length;
    const last = text.slice(0, b.end).replace(/\n+$/, "").split("\n").length;
    for (let n = first; n <= last; n++) owned.add(n);
  }
  return owned;
}

function repoInstructionFile(root: string): string {
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(root, "CLAUDE.md");
}

function read(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

/** The kit heading is "<team>: <item>"; the item is what a person names. */
function itemName(heading: string): string {
  const flat = heading.replace(/^#+\s*/, "");
  const colon = flat.indexOf(": ");
  return colon === -1 ? flat : flat.slice(colon + 2);
}

export function buildPrompt(input: {
  lines: Array<{ n: number; text: string }>;
  repo: { root: string; file: string; text: string } | null;
  team: Array<{ heading: string; body: string }>;
}): string {
  const parts = [
    "Personal instruction file, one numbered line each (blank lines and codecast's own sections omitted):",
    input.lines.map((l) => `L${l.n}: ${l.text}`).join("\n"),
    "",
  ];
  if (input.repo) {
    parts.push(`Repository: ${path.basename(input.repo.root)} (${input.repo.root})`);
    parts.push(`Its instruction file, ${path.basename(input.repo.file)}:`);
    parts.push(input.repo.text.trim() || "(empty)");
  } else {
    parts.push("No repository: the team is the only destination.");
  }
  parts.push("");
  parts.push("Team instruction items installed for this person:");
  parts.push(input.team.length ? input.team.map((t) => `### ${itemName(t.heading)}\n${t.body}`).join("\n\n") : "(none yet)");
  return parts.join("\n");
}

/** Keep only moves the reply could mean: known personal lines, a destination
 *  that exists, each line in at most one move. */
export function validMoves(raw: unknown, candidates: Set<number>, hasRepo: boolean): PromoteMove[] {
  const list = (raw as { moves?: unknown })?.moves;
  if (!Array.isArray(list)) return [];
  const used = new Set<number>();
  const out: PromoteMove[] = [];
  for (const m of list as any[]) {
    if (m?.destination !== "repo" && m?.destination !== "team") continue;
    if (m.destination === "repo" && !hasRepo) continue;
    const lines = (Array.isArray(m.lines) ? m.lines : []).filter((n: unknown) => Number.isInteger(n) && candidates.has(n as number) && !used.has(n as number));
    if (lines.length === 0) continue;
    lines.sort((a: number, b: number) => a - b);
    for (const n of lines) used.add(n);
    out.push({
      lines,
      destination: m.destination,
      ...(typeof m.section === "string" && m.section.trim() ? { section: m.section.trim() } : {}),
      ...(typeof m.item === "string" && m.item.trim() ? { item: m.item.trim() } : {}),
      ...(typeof m.already_present === "string" && m.already_present.trim() ? { already_present: m.already_present.trim() } : {}),
      ...(typeof m.conflicts === "string" && m.conflicts.trim() ? { conflicts: m.conflicts.trim() } : {}),
    });
  }
  return out.sort((a, b) => a.lines[0]! - b.lines[0]!);
}

/** `lines` appended to the end of the section headed `section`, or under a new
 *  heading at the end of the file when no such section exists. */
export function insertUnderSection(text: string, section: string | undefined, lines: string[]): string {
  const heading = (section ?? "Guidance").replace(/^#+\s*/, "").trim();
  const rows = text.split("\n");
  let inFence = false;
  const headings: Array<{ i: number; level: number; title: string }> = [];
  rows.forEach((row, i) => {
    if (/^\s*(```|~~~)/.test(row)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.+?)\s*$/.exec(row);
    if (m) headings.push({ i, level: m[1]!.length, title: m[2]! });
  });
  const hit = headings.find((h) => h.title.toLowerCase() === heading.toLowerCase());
  if (!hit) {
    const base = text.replace(/\n+$/, "");
    return `${base}${base ? "\n\n" : ""}## ${heading}\n\n${lines.join("\n")}\n`;
  }
  let end = headings.find((h) => h.i > hit.i && h.level <= hit.level)?.i ?? rows.length;
  while (end > hit.i + 1 && rows[end - 1]!.trim() === "") end--;
  const rest = rows.slice(end);
  const next = rest.findIndex((r) => r.trim());
  const tail = next === -1 ? [] : ["", ...rest.slice(next)];
  return [...rows.slice(0, end), ...lines, ...tail].join("\n").replace(/\n*$/, "\n");
}

function describe(move: PromoteMove, repoFile: string | null): string {
  const at = move.lines.length === 1 ? `L${move.lines[0]}` : `L${move.lines[0]}-${move.lines[move.lines.length - 1]}`;
  const where = move.destination === "repo" ? `${repoFile ? path.basename(repoFile) : "repo"} § ${move.section ?? "Guidance"}` : `team item "${move.item ?? "Guidance"}"`;
  return `${at} → ${where}`;
}

export async function runPromote(deps: PromoteDeps): Promise<PromoteReport> {
  const report: PromoteReport = { proposed: [], skipped: [], accepted: [], declined: [], wrote: [], removedFromPersonal: 0 };
  const personalFile = deps.personalFile ?? path.join(deps.home, ".claude", "CLAUDE.md");
  const personal = read(personalFile);
  if (!personal.trim()) {
    deps.print(`Nothing to promote: ${personalFile} is empty or missing.`);
    return report;
  }
  const rows = personal.split("\n");
  const owned = ownedLines(personal);
  const lines = rows.map((text, i) => ({ n: i + 1, text })).filter((l) => l.text.trim() && !owned.has(l.n));
  const candidates = new Set(lines.map((l) => l.n));
  const team = findKitSections(personal);
  const repoFile = deps.repoRoot ? repoInstructionFile(deps.repoRoot) : null;
  const repo = deps.repoRoot && repoFile ? { root: deps.repoRoot, file: repoFile, text: read(repoFile) } : null;

  const result = await deps.model({
    model: deps.modelId ?? PROMOTE_MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    prompt: buildPrompt({ lines, repo, team }),
    output: "json",
    output_schema: SCHEMA,
  });
  if (!result.ok) throw new Error(`the model call failed: ${result.error}`);
  const moves = validMoves(result.json ?? parseJsonBlock(result.text), candidates, !!repo);
  report.proposed = moves;
  const textOf = (m: PromoteMove) => m.lines.map((n) => rows[n - 1]!);

  for (const m of moves.filter((m) => m.already_present || m.conflicts)) {
    report.skipped.push(m);
    const why = m.conflicts ? `contradicts it (${m.conflicts})` : `already there (${m.already_present})`;
    deps.print(`skip  ${describe(m, repoFile)}: ${why}`);
    for (const t of textOf(m)) deps.print(`      ${t}`);
  }
  const open = moves.filter((m) => !m.already_present && !m.conflicts);
  if (open.length === 0) {
    deps.print(moves.length ? "Nothing new to move." : "The model proposed no moves: everything reads as personal.");
    return report;
  }
  if (deps.scan) {
    for (const m of open) {
      deps.print(`move  ${describe(m, repoFile)}`);
      for (const t of textOf(m)) deps.print(`      ${t}`);
    }
    return report;
  }

  for (const m of open) {
    deps.print("");
    deps.print(describe(m, repoFile));
    for (const t of textOf(m)) deps.print(`  ${t}`);
    const answer = (await deps.ask("Move it? [y/N/q] ")).trim().toLowerCase();
    if (answer === "q") break;
    (answer === "y" || answer === "yes" ? report.accepted : report.declined).push(m);
  }
  if (report.accepted.length === 0) return report;

  const landed: PromoteMove[] = [];
  const toRepo = report.accepted.filter((m) => m.destination === "repo");
  if (toRepo.length && repo) {
    let text = repo.text;
    for (const m of toRepo) text = insertUnderSection(text, m.section, textOf(m));
    writeHarnessFile(repo.file, text, "promote");
    report.wrote.push(repo.file);
    landed.push(...toRepo);
    deps.print(`wrote ${toRepo.length} move${toRepo.length === 1 ? "" : "s"} to ${repo.file}`);
  }

  const byItem = new Map<string, PromoteMove[]>();
  for (const m of report.accepted.filter((m) => m.destination === "team")) {
    const name = m.item ?? "Guidance";
    byItem.set(name, [...(byItem.get(name) ?? []), m]);
  }
  for (const [name, items] of byItem) {
    const existing = team.find((t) => headingSlug(itemName(t.heading)) === headingSlug(name));
    const heading = existing ? itemName(existing.heading) : name;
    const body = [existing?.body, items.flatMap(textOf).join("\n")].filter(Boolean).join("\n\n");
    const file = path.join(deps.home, ".codecast", "capabilities", "promote", `${headingSlug(heading) || "guidance"}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `## ${heading}\n\n${body}\n`);
    if (await deps.publishInstructions(file, heading)) {
      report.wrote.push(`team item ${heading}`);
      landed.push(...items);
    } else {
      deps.print(`team item "${heading}" did not publish; its lines stay in ${personalFile}`);
    }
  }

  if (landed.length) {
    const drop = new Set(landed.flatMap((m) => m.lines));
    const answer = (await deps.ask(`Remove the ${drop.size} moved line${drop.size === 1 ? "" : "s"} from ${personalFile}? [y/N] `)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      const current = read(personalFile).split("\n");
      // Only lines still exactly as the model read them: the file may have
      // moved under the prompt.
      const kept = current.filter((t, i) => !(drop.has(i + 1) && rows[i] === t));
      report.removedFromPersonal = current.length - kept.length;
      writeHarnessFile(personalFile, kept.join("\n"), "promote");
    }
  }
  return report;
}
