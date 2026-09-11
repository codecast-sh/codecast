// Workflow templates the CLI ships. A compiled binary carries no source tree,
// so each template is a text import (bun inlines it, dev and compiled alike;
// see bundledSkills.ts for the same pattern). `cast workflow run <name>` and
// `cast workflow list` resolve these by name; a path on disk still wins.
import lineCast from "./templates/line.cast" with { type: "text" };
import featureCast from "../../workflows/feature/workflow.cast" with { type: "text" };
import planAutopilotCast from "../../workflows/plan-autopilot/workflow.cast" with { type: "text" };
import * as fs from "fs";
import * as path from "path";

export const BUILTIN_WORKFLOW_TEMPLATES: Readonly<Record<string, string>> = {
  line: lineCast,
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
