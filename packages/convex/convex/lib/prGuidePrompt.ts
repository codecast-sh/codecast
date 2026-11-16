// The request that asks a model to write a change guide for a pull request
// whose author did not write one (the PR page's Guide tab). Pure, so the evals
// can replay exactly what prod sends. The reply is the same markdown an author
// writes with `cast task handoff --guide`, parsed by parseChangeGuide, so a
// generated guide and an author's guide are one shape and one renderer.

import { parseChangeGuide, type ChangeGuide } from "@codecast/shared/contracts/changeGuide";
import { STRONG_MODEL, type SurfaceRequest } from "./anthropic";

export const PR_GUIDE_PROMPT_VERSION = "pr-guide-2";
export const PR_GUIDE_MODEL = STRONG_MODEL;
/** The strong model's thinking counts toward max_tokens; only tokens used are billed. */
export const PR_GUIDE_MAX_TOKENS = 12_000;
/** Diff text sent in all, and per file, so one generated file cannot crowd out the rest. */
export const PR_GUIDE_DIFF_CHARS = 150_000;
export const PR_GUIDE_FILE_CHARS = 24_000;

export type PrGuideFile = { filename: string; status: string; additions: number; deletions: number; patch?: string };
export type PrGuideInput = { repository: string; number: number; title: string; body: string; files: PrGuideFile[] };

const SYSTEM = `You write a guide that walks a reviewer through a pull request. Someone reading it top to bottom should understand what changed and why, in the order that makes the change easiest to follow: the core change first, then what follows from it, then the mechanical or low-signal changes (renames, generated files, fixtures, config, docs) last.

Say only what the diff, the title and the description support. When a reason is neither stated nor evident from the code, describe what the code does rather than guess at a motive. Write plainly, for a colleague who knows the codebase but not this change.

Format, exactly:
- Optionally, first, two or three sentences on what the pull request does as a whole.
- Then one \`##\` heading per step: a few words saying what the step does, followed on the same line by its location in backticks, \`path/to/file.ts:start-end\`, using the new-file line numbers printed in the diff. For a deleted file, or a step about a whole file, give the path alone.
- Under each heading, a short paragraph on what that piece does and why it exists.

A step is one range in one file; a file may appear in several steps. Cover every file with a meaningful change; small related changes can share a final step that names the most representative one. Reply with the guide and nothing else.`;

/** A file's patch with each new-side line numbered, so a step can cite real line numbers. Removed lines carry no number. */
export function numberPatch(patch: string): string {
  const out: string[] = [];
  let next = 0;
  for (const line of patch.split("\n")) {
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      next = Number(header[1]);
      out.push(line);
    } else if (line.startsWith("-")) {
      out.push(`      ${line}`);
    } else if (line.startsWith("\\")) {
      out.push(`      ${line}`);
    } else {
      out.push(`${String(next).padStart(5)} ${line}`);
      next++;
    }
  }
  return out.join("\n");
}

function fileBlock(f: PrGuideFile, budget: number): { text: string; used: number } {
  const head = `### ${f.filename} (${f.status}, +${f.additions} -${f.deletions})`;
  if (!f.patch) return { text: `${head}\n(no diff text: binary, too large for GitHub, or a rename)`, used: 0 };
  if (budget <= 0) return { text: `${head}\n(diff left out to fit the request)`, used: 0 };
  const numbered = numberPatch(f.patch);
  const cap = Math.min(budget, PR_GUIDE_FILE_CHARS);
  if (numbered.length <= cap) return { text: `${head}\n${numbered}`, used: numbered.length };
  return { text: `${head}\n${numbered.slice(0, cap)}\n(diff cut here to fit the request)`, used: cap };
}

export function prGuideRequest(input: PrGuideInput): SurfaceRequest {
  let budget = PR_GUIDE_DIFF_CHARS;
  const blocks = input.files.map((f) => {
    const b = fileBlock(f, budget);
    budget -= b.used;
    return b.text;
  });
  const prompt = [
    `Pull request ${input.repository}#${input.number}: ${input.title}`,
    "",
    "Description:",
    input.body.trim() || "(none)",
    "",
    `Changed files (${input.files.length}):`,
    "",
    blocks.join("\n\n"),
  ].join("\n");
  return { model: PR_GUIDE_MODEL, max_tokens: PR_GUIDE_MAX_TOKENS, system: SYSTEM, prompt };
}

/**
 * The reply as a guide, each step's hunk focused from the PR's own patch. A
 * step naming a file the PR does not change is dropped (a guide only walks
 * this diff); a reply with no step left throws, naming why.
 */
export function parsePrGuideReply(reply: string, files: PrGuideFile[]): ChangeGuide {
  const byName = new Map(files.map((f) => [f.filename, f]));
  const guide = parseChangeGuide(reply, (file) => byName.get(file)?.patch ?? null);
  const steps = guide.steps.filter((s) => byName.has(s.file));
  if (!steps.length) throw new Error("the model's guide named no file this pull request changes");
  return { ...guide, steps };
}
