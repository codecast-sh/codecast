// Workflow templates the CLI ships. A compiled binary carries no source tree,
// so each template is a text import (bun inlines it, dev and compiled alike;
// see bundledSkills.ts for the same pattern). `cast workflow run <name>` and
// `cast workflow list` resolve these by name; a path on disk still wins.
import lineCast from "./templates/line.cast" with { type: "text" };
import lineGround from "./templates/line/ground.md" with { type: "text" };
import linePlan from "./templates/line/plan.md" with { type: "text" };
import lineAnalyze from "./templates/line/analyze.md" with { type: "text" };
import lineProve from "./templates/line/prove.md" with { type: "text" };
import lineImplement from "./templates/line/implement.md" with { type: "text" };
import lineReview from "./templates/line/review.md" with { type: "text" };
import lineCardWrite from "./templates/line/card_write.md" with { type: "text" };
import linePark from "./templates/line/park.sh" with { type: "text" };
import lineRed from "./templates/line/red.sh" with { type: "text" };
import lineGreen from "./templates/line/green.sh" with { type: "text" };
import lineEvalScope from "./templates/line/eval_scope.sh" with { type: "text" };
import lineEval from "./templates/line/eval.sh" with { type: "text" };
import featureCast from "../../workflows/feature/workflow.cast" with { type: "text" };
import planAutopilotCast from "../../workflows/plan-autopilot/workflow.cast" with { type: "text" };
import * as fs from "fs";
import * as path from "path";

// The files a template's `prompt="@<file>"` and `script="@<file>"` attributes
// name, keyed by their path beside the template. A run of the template file
// reads them from disk (parseWorkflowSource with its dir); a builtin has no
// dir, so they are inlined into its source here, and every reader of the
// builtin (run, push, the daemon, graph_hash) sees the same text.
export const LINE_TEMPLATE_FILES: Readonly<Record<string, string>> = {
  "line/ground.md": lineGround,
  "line/plan.md": linePlan,
  "line/analyze.md": lineAnalyze,
  "line/prove.md": lineProve,
  "line/implement.md": lineImplement,
  "line/review.md": lineReview,
  "line/card_write.md": lineCardWrite,
  "line/park.sh": linePark,
  "line/red.sh": lineRed,
  "line/green.sh": lineGreen,
  "line/eval_scope.sh": lineEvalScope,
  "line/eval.sh": lineEval,
};

/** Replace each quoted `"@<file>"` value naming one of `files` with that file's text as a DOT string. */
export function inlineTemplateFiles(source: string, files: Readonly<Record<string, string>>): string {
  return source.replace(/"@([\w./-]+)"/g, (whole, ref: string) => {
    const text = files[ref];
    if (text === undefined) return whole;
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  });
}

export const BUILTIN_WORKFLOW_TEMPLATES: Readonly<Record<string, string>> = {
  line: inlineTemplateFiles(lineCast, LINE_TEMPLATE_FILES),
  feature: featureCast,
  "plan-autopilot": planAutopilotCast,
};

export interface ResolvedWorkflowSource {
  source: string;
  /** Where @file prompt references resolve from; absent for a builtin. */
  dir?: string;
  /** The on-disk path, or `builtin:<name>`. */
  label: string;
}

/**
 * `line`, `line.cast`, `./flow.cast`, `workflows/x/workflow.cast`: an existing
 * file resolves as a file; otherwise the bare name (with or without `.cast`)
 * resolves to a builtin. Returns null when neither matches.
 */
export function resolveWorkflowSource(fileOrName: string, cwd = process.cwd()): ResolvedWorkflowSource | null {
  const filePath = path.resolve(cwd, fileOrName);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return { source: fs.readFileSync(filePath, "utf-8"), dir: path.dirname(filePath), label: filePath };
  }
  const name = path.basename(fileOrName).replace(/\.cast$/, "");
  if (!fileOrName.includes("/") && Object.prototype.hasOwnProperty.call(BUILTIN_WORKFLOW_TEMPLATES, name)) {
    return { source: BUILTIN_WORKFLOW_TEMPLATES[name], label: `builtin:${name}` };
  }
  return null;
}
