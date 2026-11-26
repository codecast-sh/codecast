// Workflow templates the CLI ships. A compiled binary carries no source tree,
// so each template is a text import (bun inlines it, dev and compiled alike;
// see bundledSkills.ts for the same pattern). `cast workflow run <name>` and
// `cast workflow list` resolve these by name; a path on disk still wins.
import lineCast from "./templates/line.cast" with { type: "text" };
import lineGround from "./templates/line/ground.md" with { type: "text" };
import linePlan from "./templates/line/plan.md" with { type: "text" };
import lineAnalyze from "./templates/line/analyze.md" with { type: "text" };
import lineProve from "./templates/line/prove.md" with { type: "text" };
import lineProveLine from "./templates/line/prove_line.md" with { type: "text" };
import lineImplement from "./templates/line/implement.md" with { type: "text" };
import lineImplementLine from "./templates/line/implement_line.md" with { type: "text" };
import lineReview from "./templates/line/review.md" with { type: "text" };
import lineCardWrite from "./templates/line/card_write.md" with { type: "text" };
import linePark from "./templates/line/park.sh" with { type: "text" };
import lineRed from "./templates/line/red.sh" with { type: "text" };
import lineGreen from "./templates/line/green.sh" with { type: "text" };
import lineEval from "./templates/line/eval.sh" with { type: "text" };
import lineShip from "./templates/line/ship.sh" with { type: "text" };
import lineDissolve from "./templates/line/dissolve.sh" with { type: "text" };
import lineRebase from "./templates/line/rebase.sh" with { type: "text" };
import lineDiagnose from "./templates/line/diagnose.md" with { type: "text" };
import judgeReviewCast from "./templates/judge-review.cast" with { type: "text" };
import lineDeployCast from "./templates/line-deploy.cast" with { type: "text" };
import lineUnproven from "./templates/line/unproven.sh" with { type: "text" };
import checkCast from "./templates/check.cast" with { type: "text" };
import reviewCast from "./templates/review.cast" with { type: "text" };
import evalCast from "./templates/eval.cast" with { type: "text" };
import decideCast from "./templates/decide.cast" with { type: "text" };
import shipCast from "./templates/ship.cast" with { type: "text" };
import deployCast from "./templates/deploy.cast" with { type: "text" };
import proveImplementCast from "./templates/prove-implement.cast" with { type: "text" };
import changeCast from "./templates/change.cast" with { type: "text" };
import judgeCast from "./templates/judge.cast" with { type: "text" };
import judgeRisk from "./templates/judge/risk.md" with { type: "text" };
import intentCast from "./templates/intent.cast" with { type: "text" };
import intentAsker from "./templates/intent/asker.md" with { type: "text" };
import climbCast from "./templates/climb.cast" with { type: "text" };
import climbFrame from "./templates/climb/frame.md" with { type: "text" };
import climbPropose from "./templates/climb/propose.md" with { type: "text" };
import climbReview from "./templates/climb/review.md" with { type: "text" };
import climbPromote from "./templates/climb/promote.md" with { type: "text" };
import climbPromoteLine from "./templates/climb/promote_line.md" with { type: "text" };
import climbRecord from "./templates/climb/record.sh" with { type: "text" };
import changeReview from "./templates/change/review.md" with { type: "text" };
import changeBrief from "./templates/change/brief.md" with { type: "text" };
import changeDirectFix from "./templates/change/direct_fix.md" with { type: "text" };
import changeDirectReview from "./templates/change/direct_review.md" with { type: "text" };
import changeDirectRevise from "./templates/change/direct_revise.md" with { type: "text" };
import changeDirectConflict from "./templates/change/direct_conflict.md" with { type: "text" };
import changeDirectCiRed from "./templates/change/direct_ci_red.md" with { type: "text" };
import changeDirectReturn from "./templates/change/direct_return.md" with { type: "text" };
import changeConflict from "./templates/change/conflict.md" with { type: "text" };
import changeCiConflict from "./templates/change/ci_conflict.md" with { type: "text" };
import personalCast from "./templates/personal.cast" with { type: "text" };
import personalRound from "./templates/personal/round.sh" with { type: "text" };
import personalFindCheck from "./templates/personal/find_check.md" with { type: "text" };
import personalReview from "./templates/personal/review.md" with { type: "text" };
import personalVerdicts from "./templates/personal/verdicts.sh" with { type: "text" };
import personalLand from "./templates/personal/land.sh" with { type: "text" };
import personalAfterFix from "./templates/personal/after_fix.sh" with { type: "text" };
import personalLanded from "./templates/personal/landed.sh" with { type: "text" };
import personalDeploy from "./templates/personal/deploy.md" with { type: "text" };
import personalBrief from "./templates/personal/brief.md" with { type: "text" };
import personalConflict from "./templates/personal/conflict.md" with { type: "text" };
import personalDeployFix from "./templates/personal/deploy_fix.md" with { type: "text" };
import featureCast from "../../workflows/feature/workflow.cast" with { type: "text" };
import planAutopilotCast from "../../workflows/plan-autopilot/workflow.cast" with { type: "text" };
import { JUDGE_REVIEW_GRAPH } from "@codecast/shared/contracts/judgeReview";
import { LINE_DEPLOY_GRAPH } from "@codecast/shared/contracts/lineDeploy";
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
  "line/prove_line.md": lineProveLine,
  "line/implement.md": lineImplement,
  "line/implement_line.md": lineImplementLine,
  "line/review.md": lineReview,
  "line/card_write.md": lineCardWrite,
  "line/park.sh": linePark,
  "line/red.sh": lineRed,
  "line/green.sh": lineGreen,
  "line/eval.sh": lineEval,
  "line/ship.sh": lineShip,
  "line/dissolve.sh": lineDissolve,
  "line/rebase.sh": lineRebase,
  // The diagnosis of a wrong finding, which the line runs beside its causes
  // (judge-review.cast, learning-loop.md LL11).
  "line/diagnose.md": lineDiagnose,
  "line/unproven.sh": lineUnproven,
  // The change flow's reviewer, and what it sends back to the session a change came from (flows.md FL4).
  "change/review.md": changeReview,
  "change/brief.md": changeBrief,
  "change/direct_fix.md": changeDirectFix,
  "change/direct_review.md": changeDirectReview,
  "change/direct_revise.md": changeDirectRevise,
  "change/direct_conflict.md": changeDirectConflict,
  "change/direct_ci_red.md": changeDirectCiRed,
  "change/direct_return.md": changeDirectReturn,
  "change/conflict.md": changeConflict,
  "change/ci_conflict.md": changeCiConflict,
  // The personal workspace's Ship (personal.cast): its stations and what it sends back to the session.
  "personal/round.sh": personalRound,
  "personal/find_check.md": personalFindCheck,
  "personal/review.md": personalReview,
  "personal/verdicts.sh": personalVerdicts,
  "personal/land.sh": personalLand,
  "personal/after_fix.sh": personalAfterFix,
  "personal/landed.sh": personalLanded,
  "personal/deploy.md": personalDeploy,
  "personal/brief.md": personalBrief,
  "personal/conflict.md": personalConflict,
  "personal/deploy_fix.md": personalDeployFix,
  // What the blind risk judge reads (judge.cast).
  "judge/risk.md": judgeRisk,
  // What the intent segment's model reads (intent.cast).
  "intent/asker.md": intentAsker,
  // The climb's stations (climb.cast, flows.md FL10).
  "climb/frame.md": climbFrame,
  "climb/propose.md": climbPropose,
  "climb/review.md": climbReview,
  "climb/promote.md": climbPromote,
  "climb/promote_line.md": climbPromoteLine,
  "climb/record.sh": climbRecord,
};

/** A template file's text with each line that is only `@include <file>` replaced by that file, as the parser takes them in from disk. */
export function withTemplateIncludes(text: string, ref: string, files: Readonly<Record<string, string>>): string {
  return text.replace(/^@include[ \t]+(\S+)[ \t]*$/gm, (_line, rel: string) => {
    const key = path.posix.join(path.posix.dirname(ref), rel);
    const part = files[key];
    if (part === undefined) throw new Error(`${ref}: @include ${rel}: no template file ${key}`);
    return withTemplateIncludes(part.replace(/\n$/, ""), key, files);
  });
}

/** Replace each quoted `"@<file>"` value naming one of `files` with that file's text as a DOT string. */
export function inlineTemplateFiles(source: string, files: Readonly<Record<string, string>>): string {
  return source.replace(/"@([\w./-]+)"/g, (whole, ref: string) => {
    const raw = files[ref];
    if (raw === undefined) return whole;
    const text = withTemplateIncludes(raw, ref, files);
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  });
}

export const BUILTIN_WORKFLOW_TEMPLATES: Readonly<Record<string, string>> = {
  line: inlineTemplateFiles(lineCast, LINE_TEMPLATE_FILES),
  [JUDGE_REVIEW_GRAPH]: inlineTemplateFiles(judgeReviewCast, LINE_TEMPLATE_FILES),
  // A deploy's steps as stations (deploys.md DP8).
  [LINE_DEPLOY_GRAPH]: lineDeployCast,
  // The pool's starter flows (flows.md FL2): segments cut from the line's own
  // stations, and the change line that strings them together.
  check: inlineTemplateFiles(checkCast, LINE_TEMPLATE_FILES),
  review: inlineTemplateFiles(reviewCast, LINE_TEMPLATE_FILES),
  judge: inlineTemplateFiles(judgeCast, LINE_TEMPLATE_FILES),
  intent: inlineTemplateFiles(intentCast, LINE_TEMPLATE_FILES),
  eval: inlineTemplateFiles(evalCast, LINE_TEMPLATE_FILES),
  decide: decideCast,
  ship: inlineTemplateFiles(shipCast, LINE_TEMPLATE_FILES),
  deploy: deployCast,
  "prove-implement": inlineTemplateFiles(proveImplementCast, LINE_TEMPLATE_FILES),
  change: inlineTemplateFiles(changeCast, LINE_TEMPLATE_FILES),
  // The change line of a personal workspace: check and review, land on main, deploy as the docs say.
  personal: inlineTemplateFiles(personalCast, LINE_TEMPLATE_FILES),
  // Hill-climbing one goal metric through its environments (flows.md FL10).
  climb: inlineTemplateFiles(climbCast, LINE_TEMPLATE_FILES),
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
