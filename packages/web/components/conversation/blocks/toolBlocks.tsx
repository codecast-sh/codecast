import { sessionRepository } from "../../../lib/repoNavigation";
import { commitPageHref } from "../../../lib/repoView";
import { commandLeavesCheckout, gitToolOutcome, type GitToolOutcome } from "../../../lib/gitToolOutcome";
import Link from "next/link";
import { canOpenBeside, openBrowserPane } from "../../../lib/stage";
import { useRouter } from "next/navigation";
import { useRef, useState, useMemo } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { createPortal } from "react-dom";
import { BrowserTabPill } from "../../browser/BrowserTabPill";
import { BROWSER_ROW_PILL } from "../../../hooks/useBrowserTabActions";
import { formatModel } from "../../../lib/conversationProcessor";
import { extractNestedActions, formatToolName, isAskTool, isEditTool, isGlobTool, isGrepTool, isReadTool, isShellTool, isTodoTool, isWriteTool, shortenUrl, splitBrowserBatchResult, stripLineNumbers, structuredPayloadSummary, summarizeNestedActions, toolPathFromInput, toolSummary as sharedToolSummary, BROWSER_BATCH_TOOL, truncateStr, getRelativePath } from "@codecast/shared/render";
import { useFullWidthExpand } from "../../../hooks/useFullWidthExpand";
import { useDiffViewerStore } from "../../../store/diffViewerStore";
import { editStringsFromInput } from "../../../lib/fileChangeExtractor";
import { parseWorkflowScriptMeta, parseWorkflowLaunch } from "../../../lib/workflowLaunch";
import { DiffView } from "../../DiffView";
import { useQuery } from "convex/react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { DynamicRunView, wfStatusMeta, wfFmtTokens } from "../../DynamicRunView";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toggleBrowserWatch, useBrowserWatchOpen } from "../../browser/BrowserWatchSplit";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { isMarkdownFile, isPlanFile } from "../../../lib/markdownFiles";
import { EntityIdPill } from "../../EntityIdPill";
import { entityRemarkPlugins } from "../../../lib/remarkEntityIds";
import { MESSAGE_MD_REHYPE } from "../../messageMarkdown";
import { FilePathLink } from "../../FilePathLink";
import { unwrapShellCommand, browserTabOf, type BrowserRowState } from "../../castCommand";
import { useInboxStore } from "../../../store/inboxStore";
import { getToolPatchInputs, parseApplyPatchSections } from "../../../lib/applyPatchParser";
import { parseFileChangeSummary, parseUnifiedDiffSections } from "../../../lib/unifiedDiffParser";
import { ChevronDown, ChevronUp, Workflow, MoveHorizontal, GitCommitHorizontal, GitPullRequest } from "lucide-react";
import { ImageBlock } from "./interactiveBlocks";
import { PlanBlock } from "./planBlock";
import { FooterIconButton, FullscreenIcon, NestedStepList, toolColorClass } from "./shared";
import { findMatchingChild, getFileExtension, parseSpawnResult, summarizeBashCommand } from "../classify";
import { renderAnsi, safeString } from "../format";
import { MD_COMPONENTS_CODE_LINK, MD_COMPONENTS_NO_PRE, ReactMarkdown } from "../markdown";
import type { ImageData, TaskRecordMaps, ToolCall, ToolChangeRange, ToolResult } from "../types";

const api = _typedApi as any;

export function TaskToolBlock({ tool, result, childConversationId, childConversations }: { tool: ToolCall; result?: ToolResult; childConversationId?: string; childConversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }> }) {
  const isCompleted = !!result;
  const [expanded, setExpanded] = useState(false);

  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}

  const subagentType = String(parsedInput.subagent_type || "unknown");
  const description = String(parsedInput.description || "");
  const prompt = String(parsedInput.prompt || "");
  const model = parsedInput.model ? String(parsedInput.model) : null;
  const name = parsedInput.name ? String(parsedInput.name) : null;
  const runInBackground = Boolean(parsedInput.run_in_background || parsedInput.background);

  const resolvedChildId = childConversationId || findMatchingChild(prompt, childConversations);
  const router = useRouter();

  const subagentColors: Record<string, { bg: string; border: string; text: string }> = {
    Explore: { bg: "bg-sol-green/20", border: "border-sol-green/50", text: "text-sol-green" },
    Plan: { bg: "bg-sol-cyan/20", border: "border-sol-cyan/50", text: "text-sol-cyan" },
    implementor: { bg: "bg-sol-yellow/20", border: "border-sol-yellow/50", text: "text-sol-yellow" },
    "general-purpose": { bg: "bg-sol-bg-alt/60", border: "border-sol-border/50", text: "text-sol-text-secondary" },
    "claude-code-guide": { bg: "bg-sol-violet/20", border: "border-sol-violet/50", text: "text-sol-violet" },
    "code-reviewer": { bg: "bg-sol-red/20", border: "border-sol-red/50", text: "text-sol-red" },
    "code-explorer": { bg: "bg-sol-cyan/20", border: "border-sol-cyan/50", text: "text-sol-cyan" },
    "code-architect": { bg: "bg-sol-magenta/20", border: "border-sol-magenta/50", text: "text-sol-magenta" },
    "code-simplifier": { bg: "bg-sol-cyan/20", border: "border-sol-cyan/50", text: "text-sol-cyan" },
  };

  const colors = subagentColors[subagentType] || { bg: "bg-sol-bg-alt/60", border: "border-sol-border/50", text: "text-sol-text-muted" };

  const spawnInfo = result?.content ? parseSpawnResult(result.content) : null;

  const resultSummary = result?.content && !spawnInfo
    ? result.content.length > 200 ? result.content.slice(0, 200) + "..." : result.content
    : null;

  if (isCompleted && spawnInfo) {
    return (
      <div className="my-0.5">
        <div
          className={`flex items-center gap-1.5 text-xs${resolvedChildId ? " cursor-pointer rounded px-1.5 py-1 -mx-1 hover:bg-sol-bg-highlight/50 transition-colors" : ""}`}
          onClick={resolvedChildId ? () => router.push(`/conversation/${resolvedChildId}`) : undefined}
        >
          <span className="text-emerald-400 text-[10px]">{"\u2713"}</span>
          <span className={`font-mono text-xs ${colors.text}`}>Task</span>
          <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${colors.bg} border ${colors.border} ${colors.text}`}>
            {subagentType}
          </span>
          {(spawnInfo.agentName || name) && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 font-mono">
              @{spawnInfo.agentName || name}
            </span>
          )}
          {description && <span className="text-sol-text-dim truncate flex-1">{description}</span>}
        </div>
      </div>
    );
  }

  if (isCompleted) {
    return (
      <div className={`my-3 rounded-lg ${result?.is_error ? "bg-sol-red/10 border-sol-red/30" : `${colors.bg} ${colors.border}`} border`}>
        <div
          className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-sol-bg-highlight/50 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className={`text-[10px] ${result?.is_error ? "text-sol-red" : "text-emerald-400"}`}>
            {result?.is_error ? "\u2717" : "\u2713"}
          </span>
          <span className={`font-mono text-xs font-medium ${result?.is_error ? "text-sol-red" : colors.text}`}>
            Task
          </span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors.bg} border ${colors.border} ${colors.text}`}>
            {subagentType}
          </span>
          {description && (
            <span className="text-sol-text-muted text-xs truncate flex-1">
              {description}
            </span>
          )}
          <span className="text-sol-text-dim text-[10px] ml-auto">
            {expanded ? "collapse" : "expand"}
          </span>
        </div>

        {expanded && (
          <>
            {prompt && (
              <div className="border-t border-sol-border/30 px-3 py-2">
                <div className="text-[10px] text-sol-text-dim mb-1">Prompt</div>
                <div className="text-sol-text-dim text-xs font-mono whitespace-pre-wrap break-words leading-relaxed max-h-40 overflow-y-auto">
                  {prompt}
                </div>
              </div>
            )}
            {result && (
              <div className="border-t border-sol-border/30 px-3 py-2">
                <div className="text-[10px] text-sol-text-dim mb-1">Result</div>
                <div className={`text-xs max-h-96 overflow-y-auto ${
                  result.is_error ? "text-sol-red font-mono whitespace-pre-wrap" : "text-sol-text-secondary prose prose-sm prose-invert max-w-none [&_pre]:bg-sol-bg/50 [&_pre]:border [&_pre]:border-sol-border/30 [&_pre]:rounded [&_pre]:text-[11px] [&_code]:text-[11px] [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h1]:mt-2 [&_h2]:mt-2 [&_h3]:mt-1"
                }`}>
                  {result.is_error ? safeString(result.content) : (
                    <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={MD_COMPONENTS_CODE_LINK}>
                      {safeString(result.content)}
                    </ReactMarkdown>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {resolvedChildId && (
          <div className="border-t border-sol-border/30 px-2 py-1.5 flex justify-end">
            <span
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium cursor-pointer hover:brightness-125 transition ${colors.text} ${colors.bg} border ${colors.border}`}
              onClick={(e) => { e.stopPropagation(); router.push(`/conversation/${resolvedChildId}`); }}
            >
              open
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </span>
          </div>
        )}
      </div>
    );
  }

  const truncatedPrompt = prompt.length > 300 && !expanded ? prompt.slice(0, 300) + "..." : prompt;

  return (
    <div className={`my-3 rounded-lg ${colors.bg} border ${colors.border}`}>
      <div
        className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-sol-bg-highlight/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin ${colors.text} opacity-60`} />
        <span className={`font-mono text-xs font-semibold ${colors.text}`}>
          Task
        </span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors.bg} border ${colors.border} ${colors.text}`}>
          {subagentType}
        </span>
        {description && (
          <span className="text-sol-text-muted text-xs truncate flex-1">
            {description}
          </span>
        )}
        {model && (
          <span className="text-sol-text-dim text-[10px] font-mono">
            {formatModel(model)}
          </span>
        )}
        {name && (
          <span className="text-sol-text-dim text-[10px] font-mono">
            {name}
          </span>
        )}
        {runInBackground && (
          <span className="text-sol-text-dim text-[10px]">background</span>
        )}
        <span className="text-sol-text-dim text-[10px] ml-auto">
          {expanded ? "collapse" : "expand"}
        </span>
      </div>

      <div className="px-3 pb-2">
        <div className="text-sol-text-secondary text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
          {truncatedPrompt}
        </div>
        {prompt.length > 300 && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="text-[10px] text-sol-text-dim hover:text-sol-text-muted mt-1"
          >
            show more
          </button>
        )}
      </div>

      {resolvedChildId && (
        <div className="border-t border-sol-border/30 px-2 py-1.5 flex justify-end">
          <span
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium cursor-pointer hover:brightness-125 transition ${colors.text} ${colors.bg} border ${colors.border}`}
            onClick={(e) => { e.stopPropagation(); router.push(`/conversation/${resolvedChildId}`); }}
          >
            open
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </span>
        </div>
      )}
    </div>
  );
}

// ── Workflow tool (dynamic-workflow launcher) ───────────────────────────────
// The Workflow tool's result is a plain-text launch receipt ("Workflow launched in
// background. Task ID: … Run ID: wf_…"). Parse it plus the script's meta literal into
// the same card language as DynamicRunCard, and resolve the live run by its wf_ id so
// the card shows real status/progress instead of the raw blob.

export function WorkflowToolBlock({ tool, result }: { tool: ToolCall; result?: ToolResult }) {
  const [expanded, setExpanded] = useState(false);

  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}

  const script = typeof parsedInput.script === "string" ? parsedInput.script : "";
  const scriptPath = typeof parsedInput.scriptPath === "string" ? parsedInput.scriptPath : "";
  const resumeFromRunId = typeof parsedInput.resumeFromRunId === "string" ? parsedInput.resumeFromRunId : "";
  const namedWorkflow = typeof parsedInput.name === "string" ? parsedInput.name : "";

  const meta = script ? parseWorkflowScriptMeta(script) : {};
  const isError = !!result?.is_error;
  const launch = result && !isError ? parseWorkflowLaunch(safeString(result.content)) : {};

  const scriptBase = (launch.scriptFile || scriptPath).split("/").pop() || "";
  const name = meta.name || namedWorkflow || scriptBase.replace(/(-wf_[\w-]+)?\.[cm]?js$/, "") || "workflow";
  const summary = meta.description || launch.summary || "";
  const externalRunId = launch.runId || resumeFromRunId;

  const run = useQuery(
    api.workflow_runs.getByExternalRunForUser,
    externalRunId ? { external_run_id: externalRunId } : "skip"
  );
  const sm = wfStatusMeta(run?.status);

  const frame = isError
    ? { border: "border-sol-red/30", bg: "bg-sol-red/10", divider: "border-sol-red/20" }
    : { border: "border-sol-cyan/25", bg: "bg-sol-cyan/[0.06]", divider: "border-sol-cyan/15" };

  return (
    <div data-cc-feed-card className={`my-2 rounded-lg border ${frame.border} ${frame.bg} overflow-hidden`}>
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-sol-bg-highlight/40 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Workflow className={`w-3.5 h-3.5 flex-shrink-0 ${isError ? "text-sol-red" : "text-sol-cyan"}`} />
        <span data-cc-tech className={`text-[10px] uppercase tracking-wider font-semibold ${isError ? "text-sol-red" : "text-sol-cyan"}`}>
          Workflow
        </span>
        <span className="text-xs text-sol-text-muted truncate">{name}</span>
        {resumeFromRunId && (
          <span data-cc-tech className="px-1 py-0.5 rounded text-[10px] font-medium bg-sol-cyan/15 border border-sol-cyan/25 text-sol-cyan flex-shrink-0">
            resume
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          {run?.agent_count != null && <span data-cc-tech className="text-[10px] text-sol-text-dim">{run.agent_count} agents</span>}
          {run?.total_tokens ? <span data-cc-tech className="text-[10px] text-sol-text-dim/70">{wfFmtTokens(run.total_tokens)} tok</span> : null}
          {launch.taskId && <span data-cc-tech className="text-[10px] text-sol-text-dim/70 font-mono">{launch.taskId}</span>}
          {isError ? (
            <span className="text-[10px] flex items-center gap-1 text-sol-red">{"✗"} failed</span>
          ) : run ? (
            <span className={`text-[10px] flex items-center gap-1 ${sm.cls}`}>
              {sm.dot ? <span className={`w-1.5 h-1.5 rounded-full ${sm.dot}`} /> : sm.icon}
              {run.status}
            </span>
          ) : result ? (
            <span className="text-[10px] flex items-center gap-1 text-sol-cyan/80">
              <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan/60" />
              launched
            </span>
          ) : (
            <span className="text-[10px] flex items-center gap-1 text-sol-text-dim">
              <span className="w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin text-sol-cyan opacity-60" />
              launching
            </span>
          )}
          <span data-cc-tech className="text-sol-text-dim text-[10px]">{expanded ? "collapse" : "expand"}</span>
        </div>
      </div>

      {summary && (
        <div data-cc-wf-summary className="px-3 pb-2 -mt-0.5">
          <div className={`text-xs text-sol-text-dim ${expanded ? "" : "line-clamp-2"}`}>{summary}</div>
        </div>
      )}

      {/* Live agent tree only on expand — the daemon's anchor message (DynamicRunCard)
          already carries it inline, so the default state stays a compact receipt. */}
      {run && expanded && (
        <div className={`border-t ${frame.divider} px-3 py-2`}>
          <DynamicRunView run={run} compact />
        </div>
      )}

      {expanded && (
        <>
          {script && (
            <div className={`border-t ${frame.divider} px-3 py-2`}>
              <div className="text-[10px] text-sol-text-dim mb-1">Script</div>
              <div className="text-sol-text-secondary text-[11px] font-mono whitespace-pre-wrap break-words leading-relaxed max-h-80 overflow-y-auto">
                {script}
              </div>
            </div>
          )}
          {(launch.scriptFile || scriptPath) && (
            <div className={`border-t ${frame.divider} px-3 py-2`}>
              <div className="text-[10px] text-sol-text-dim mb-1">Script file</div>
              <div className="text-sol-text-dim text-[11px] font-mono break-all">{launch.scriptFile || scriptPath}</div>
            </div>
          )}
          {parsedInput.args !== undefined && (
            <div className={`border-t ${frame.divider} px-3 py-2`}>
              <div className="text-[10px] text-sol-text-dim mb-1">Args</div>
              <div className="text-sol-text-dim text-[11px] font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                {JSON.stringify(parsedInput.args, null, 2)}
              </div>
            </div>
          )}
          {result && (
            <div className={`border-t ${frame.divider} px-3 py-2`}>
              <div className="text-[10px] text-sol-text-dim mb-1">{isError ? "Error" : "Result"}</div>
              <div className={`text-[11px] font-mono whitespace-pre-wrap break-words leading-relaxed max-h-60 overflow-y-auto ${isError ? "text-sol-red" : "text-sol-text-dim"}`}>
                {safeString(result.content)}
              </div>
            </div>
          )}
          <div className={`border-t ${frame.divider} px-3 py-1.5 flex justify-end`}>
            <Link
              href="/workflows"
              onClick={(e) => e.stopPropagation()}
              className="text-[10px] text-sol-cyan hover:underline underline-offset-2"
            >
              all workflows {"→"}
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The object a shell call produced, as its reference: a commit pill that
 * resolves once the commit row exists (a push, the daemon's publish) and a
 * plain link to the commit page until then; a pull request pill that falls
 * back to the GitHub URL the command printed.
 */
function GitOutcomeRow({ outcome, repository }: { outcome: GitToolOutcome; repository: string | null }) {
  const label = outcome.kind === "commit"
    ? <><span className="font-mono">{outcome.hash.slice(0, 7)}</span>{outcome.subject && <span className="truncate">{outcome.subject}</span>}</>
    : <span className="font-mono">{outcome.ref}</span>;
  const plain = "inline-flex items-center gap-1.5 min-w-0 max-w-full text-[11px] text-sol-text-muted hover:text-sol-text";
  const fallback = outcome.kind === "commit"
    ? repository
      ? <Link href={commitPageHref(repository, outcome.hash)} className={plain} onClick={(e) => e.stopPropagation()}><GitCommitHorizontal className="w-3 h-3 shrink-0 text-sol-yellow" />{label}</Link>
      : <span className={plain}><GitCommitHorizontal className="w-3 h-3 shrink-0 text-sol-yellow" />{label}</span>
    : <a href={outcome.url} target="_blank" rel="noopener noreferrer" className={plain} onClick={(e) => e.stopPropagation()}><GitPullRequest className="w-3 h-3 shrink-0 text-sol-green" />{label}</a>;
  const ref = outcome.kind === "commit" ? (repository ? `${repository}@${outcome.hash}` : null) : outcome.ref;
  // Sits in the tool card's header strip, so it reads on a collapsed card; the
  // click must not toggle the card.
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0 max-w-[24rem] text-[11px]" onClick={(e) => e.stopPropagation()}>
      <span className="text-sol-text-dim flex-shrink-0">{outcome.kind === "commit" ? "committed" : "opened"}</span>
      {ref ? <EntityIdPill type={outcome.kind} id={ref} fallback={fallback} /> : fallback}
    </span>
  );
}

export function ToolBlock({ tool, result, changeIndex, changeRange, shareSelectionMode, messageId, conversationId, onStartShareSelection, onOpenComments, collapsed, timestamp, images, globalImageMap }: { tool: ToolCall; result?: ToolResult; changeIndex?: number; changeRange?: ToolChangeRange; shareSelectionMode?: boolean; messageId?: string; conversationId?: Id<"conversations">; onStartShareSelection?: (messageId: string) => void; onOpenComments?: () => void; collapsed?: boolean; timestamp?: number; images?: ImageData[]; globalImageMap?: Record<string, ImageData[]> }) {
  // opencode + pi name their built-in tools in lowercase (`edit`/`read`/`bash`/…);
  // gemini's glob matches too. Included alongside Claude's capitalized names and
  // codex's synonyms so every client's file/shell/search tools hit the same
  // specialized cards (DiffView, syntax read, bash styling) instead of the generic
  // fallback. Lowercase ids don't collide with claude/codex spellings.
  const rawToolInput = tool.input || "";
  const patchInputs = useMemo(() => getToolPatchInputs({ name: tool.name, input: rawToolInput }), [tool.name, rawToolInput]);
  const applyPatchDiffs = useMemo(() => patchInputs.flatMap(parseApplyPatchSections), [patchInputs]);
  const isEmbeddedPatch = tool.name !== "apply_patch" && applyPatchDiffs.length > 0;
  const isApplyPatch = tool.name === "apply_patch" || isEmbeddedPatch;
  const isStandardEdit = isEditTool(tool.name) || isWriteTool(tool.name);
  const isFileChange = tool.name === "fileChange";
  const isEdit = isStandardEdit || isApplyPatch || isFileChange;
  const [expandedOverride, setExpanded] = useState<boolean>();
  const expanded = expandedOverride ?? isEdit;
  const isRead = isReadTool(tool.name);
  const isBash = isShellTool(tool.name);
  const isGlob = isGlobTool(tool.name);
  const isGrep = isGrepTool(tool.name);
  const isCodeSearch = tool.name === "code_search" || tool.name === "code_analysis";
  // Workflow subagents return their typed result by CALLING StructuredOutput:
  // the input is the whole payload and the result is boilerplate, so rendering
  // inverts — show the input, hide the result unless it's a validation error.
  const isStructuredOutput = tool.name === "StructuredOutput";

  const { selectedChangeIndex, rangeStart, rangeEnd, selectChange, selectRange } = useDiffViewerStore();

  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}
  // A wrapper tool call (Codex `exec`, the extension's `browser_batch`) renders
  // as its inner steps: the row is named after the one step when there is one,
  // summarised by the steps otherwise, and expands to a per-step list.
  const nestedActions = useMemo(
    () => extractNestedActions(tool),
    [tool.name, rawToolInput],
  );
  const isCodexExec = tool.name === "exec";
  const isBrowserBatch = tool.name === BROWSER_BATCH_TOOL;
  const isNested = (isCodexExec || isBrowserBatch) && !isEmbeddedPatch;

  // claude uses file_path, codex uses path, opencode/pi use filePath (camelCase),
  // grok read_file uses target_file and list_dir uses target_directory.
  const filePath = toolPathFromInput(parsedInput);
  // Whichever names this client gives the two halves of a replacement — muse
  // writes {find, replace}, Claude {old_string, new_string}.
  const editStrings = editStringsFromInput(parsedInput);
  const relativePath = getRelativePath(filePath);
  // Enables inline line comments on the agent's edits (see DiffView). Scoped to a
  // live conversation; comments land in the shared review batch keyed by the
  // conversation and ride out on the user's next reply. Per-file anchor so a
  // multi-file patch keeps each file's comments separate.
  const lineCommentCtx = (path: string) =>
    conversationId ? { conversationId: String(conversationId), anchorKey: `diff:${tool.id}:${path}`, filePath: getRelativePath(path) } : undefined;
  const language = getFileExtension(filePath);
  const applyPatchInput = patchInputs.join("\n");
  const fileChangePaths = useMemo(
    () => (tool.name === "fileChange" ? parseFileChangeSummary(String(parsedInput.changes || "")) : []),
    [tool.name, parsedInput.changes],
  );
  const fileChangeDiffs = useMemo(
    () => (tool.name === "fileChange" ? parseUnifiedDiffSections(result?.content || "", fileChangePaths) : []),
    [tool.name, result?.content, fileChangePaths],
  );
  // Empty while the call is still streaming in (partial JSON fails to parse).
  const structuredJson = useMemo(
    () => (isStructuredOutput && Object.keys(parsedInput).length > 0 ? JSON.stringify(parsedInput, null, 2) : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isStructuredOutput, rawToolInput],
  );

  // Markdown file detection
  const isMarkdown = isMarkdownFile(filePath);
  const content = isRead ? (result?.content || "") : String(parsedInput.content || "");
  const isPlan = isMarkdown && isPlanFile(filePath, content);
  const isPlanWrite = isWriteTool(tool.name) && filePath.includes('.claude/plans/');
  const [viewMode, setViewMode] = useState<'raw' | 'rendered'>(isMarkdown ? 'rendered' : 'raw');
  const [mdExpanded, setMdExpanded] = useState(false);
  const [mdFullscreen, setMdFullscreen] = useState(false);
  const [codeFullscreen, setCodeFullscreen] = useState(false);
  const fullWidth = useFullWidthExpand(`tool-${tool.id}`);
  const mdContainerRef = useRef<HTMLDivElement>(null);
  const [mdOverflowing, setMdOverflowing] = useState(false);
  const MD_COLLAPSED_HEIGHT = 600;

  useWatchEffect(() => {
    if (!mdContainerRef.current || mdExpanded || viewMode !== 'rendered') return;
    // Measure synchronously (layout is committed by effect time) — rAF never
    // fires in occluded/background tabs, which left the clamp + footer missing.
    // The rAF pass re-checks after fonts/images settle.
    const measure = () => {
      if (mdContainerRef.current) {
        setMdOverflowing(mdContainerRef.current.scrollHeight > MD_COLLAPSED_HEIGHT);
      }
    };
    measure();
    requestAnimationFrame(measure);
  }, [content, mdExpanded, viewMode, expanded]);

  useWatchEffect(() => {
    if (!mdFullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMdFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [mdFullscreen]);

  useWatchEffect(() => {
    if (!codeFullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCodeFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [codeFullscreen]);

  const getToolSummary = () => {
    if (isApplyPatch) {
      if (applyPatchDiffs.length > 0) {
        const firstPath = getRelativePath(applyPatchDiffs[0].filePath);
        return applyPatchDiffs.length > 1 ? `${firstPath} (+${applyPatchDiffs.length - 1})` : firstPath;
      }
      const fileMatch = applyPatchInput.match(/\*\*\* (?:Update|Add|Delete) File:\s+(.+)/);
      if (fileMatch) return getRelativePath(fileMatch[1].trim());
      return "Apply patch";
    }
    if (isNested) {
      if (nestedActions.length === 1) {
        const inner = nestedActions[0];
        if (isShellTool(inner.name)) {
          let innerInput: Record<string, unknown> = {};
          try { innerInput = JSON.parse(inner.input); } catch {}
          const cmd = unwrapShellCommand(String(innerInput.command || innerInput.cmd || ""));
          if (cmd) return summarizeBashCommand(cmd);
        }
        return sharedToolSummary(inner);
      }
      return summarizeNestedActions(nestedActions);
    }
    if (isStandardEdit || isRead) return relativePath;
    if (isBash) {
      const cmd = unwrapShellCommand(String(parsedInput.command || parsedInput.cmd || ""));
      if (cmd) return summarizeBashCommand(cmd);
    }
    if (isGlob) return parsedInput.pattern ? String(parsedInput.pattern) : relativePath;
    if (isGrep && parsedInput.pattern) return String(parsedInput.pattern);
    if (isCodeSearch && parsedInput.query) return truncateStr(String(parsedInput.query), 40);
    if (isStructuredOutput) return structuredPayloadSummary(parsedInput) || null;

    if (tool.name === "file_read" || tool.name === "file_write" || tool.name === "file_edit") {
      return getRelativePath(String(parsedInput.file_path || parsedInput.path || ""));
    }
    if (tool.name === "fileChange") {
      if (fileChangeDiffs.length > 0) {
        const firstPath = getRelativePath(fileChangeDiffs[0].filePath);
        return fileChangeDiffs.length > 1 ? `${firstPath} (+${fileChangeDiffs.length - 1})` : firstPath;
      }
      if (fileChangePaths.length > 0) {
        const rel = getRelativePath(fileChangePaths[0]);
        return fileChangePaths.length > 1 ? `${rel} (+${fileChangePaths.length - 1})` : rel;
      }
      return "File changes";
    }

    if (tool.name === "mcp__claude-in-chrome__computer") {
      const action = String(parsedInput.action || "");
      if (action === "screenshot") return "Screenshot";
      if (action === "left_click") {
        const coord = parsedInput.coordinate as number[] | undefined;
        return coord ? `Click (${coord[0]}, ${coord[1]})` : "Click";
      }
      if (action === "type") return `Type "${truncateStr(String(parsedInput.text || ""), 20)}"`;
      if (action === "key") return `Key: ${String(parsedInput.text || "")}`;
      if (action === "scroll") return `Scroll ${String(parsedInput.scroll_direction || "")}`;
      if (action === "wait") return `Wait ${String(parsedInput.duration || "")}s`;
      return action || "Browser";
    }
    if (tool.name === "mcp__claude-in-chrome__navigate") {
      const url = String(parsedInput.url || "");
      if (url === "back") return "Back";
      if (url === "forward") return "Forward";
      return url ? shortenUrl(url) : "Navigate";
    }
    if (tool.name === "mcp__claude-in-chrome__read_page") {
      if (parsedInput.ref_id) return `Element ${String(parsedInput.ref_id)}`;
      if (parsedInput.filter === "interactive") return "Interactive elements";
      return "Page content";
    }
    if (tool.name === "mcp__claude-in-chrome__find") {
      return parsedInput.query ? `"${truncateStr(String(parsedInput.query), 30)}"` : "Find";
    }
    if (tool.name === "mcp__claude-in-chrome__form_input") {
      const ref = parsedInput.ref ? String(parsedInput.ref) : "";
      const val = parsedInput.value;
      if (ref && val !== undefined) return `${ref} = "${truncateStr(String(val), 20)}"`;
      return "Set form";
    }
    if (tool.name === "mcp__claude-in-chrome__javascript_tool") {
      return parsedInput.text ? truncateStr(String(parsedInput.text), 40) : "Execute JS";
    }
    if (tool.name === "mcp__claude-in-chrome__tabs_context_mcp") return "Get tabs";
    if (tool.name === "mcp__claude-in-chrome__tabs_create_mcp") return "Create tab";
    if (tool.name === "mcp__claude-in-chrome__update_plan") {
      const domains = parsedInput.domains as string[] | undefined;
      if (Array.isArray(domains) && domains.length) {
        return domains.slice(0, 2).join(", ") + (domains.length > 2 ? "..." : "");
      }
      return "Plan";
    }
    if (tool.name === "mcp__claude-in-chrome__gif_creator") return String(parsedInput.action || "Record");
    if (tool.name === "mcp__claude-in-chrome__read_console_messages") {
      return parsedInput.pattern ? `Filter: ${String(parsedInput.pattern)}` : "Console";
    }
    if (tool.name === "mcp__claude-in-chrome__read_network_requests") {
      return parsedInput.urlPattern ? `Filter: ${String(parsedInput.urlPattern)}` : "Network";
    }
    if (tool.name === "mcp__claude-in-chrome__get_page_text") return "Extract text";
    if (tool.name === "mcp__claude-in-chrome__upload_image") return parsedInput.filename ? String(parsedInput.filename) : "Upload";
    if (tool.name === "mcp__claude-in-chrome__resize_window") return parsedInput.width && parsedInput.height ? `${parsedInput.width}x${parsedInput.height}` : "Resize";
    if (tool.name === "mcp__claude-in-chrome__shortcuts_list") return "List shortcuts";
    if (tool.name === "mcp__claude-in-chrome__shortcuts_execute") return parsedInput.command ? `/${String(parsedInput.command)}` : "Shortcut";

    if (tool.name === "TaskCreate") return parsedInput.subject ? truncateStr(String(parsedInput.subject), 50) : "New task";
    if (tool.name === "TaskUpdate") {
      const id = parsedInput.taskId ? `#${parsedInput.taskId}` : "";
      const status = parsedInput.status ? String(parsedInput.status) : "";
      if (id && status) return `${id} \u2192 ${status}`;
      return id || "Update task";
    }
    if (tool.name === "TaskList") {
      if (result) {
        const lines = result.content.split("\n").filter((l: string) => l.match(/#\d+\s+\[/));
        if (lines.length > 0) return `${lines.length} tasks`;
      }
      return "Tasks";
    }
    if (tool.name === "TaskGet") return parsedInput.taskId ? `#${parsedInput.taskId}` : "Get task";
    if (tool.name === "TeamCreate") return parsedInput.team_name ? String(parsedInput.team_name) : "New team";
    if (tool.name === "TeamDelete") return "Cleanup";
    if (tool.name === "SendMessage") {
      if (parsedInput.summary) return truncateStr(String(parsedInput.summary), 40);
      if (parsedInput.recipient) return `to ${String(parsedInput.recipient)}`;
      if (parsedInput.type === "broadcast") return "broadcast";
      return "Message";
    }

    if (tool.name === "WebSearch" || tool.name === "web_search") return parsedInput.query ? truncateStr(String(parsedInput.query), 40) : "Search";
    if (tool.name === "WebFetch" || tool.name === "web_fetch") return parsedInput.url ? shortenUrl(String(parsedInput.url)) : "Fetch";
    if (tool.name === "NotebookEdit") return parsedInput.notebook_path ? getRelativePath(String(parsedInput.notebook_path)) : "Notebook";
    if (tool.name === "Skill") return parsedInput.skill ? `/${String(parsedInput.skill)}` : "Skill";
    if (tool.name === "EnterPlanMode" || tool.name === "enter_plan_mode") return "Plan mode";
    if (tool.name === "ExitPlanMode" || tool.name === "exit_plan_mode") return "Exit plan";
    if (tool.name === "TaskOutput") return parsedInput.task_id ? `task ${String(parsedInput.task_id).slice(0, 8)}` : "Output";
    if (tool.name === "TaskStop") return parsedInput.task_id ? `stop ${String(parsedInput.task_id).slice(0, 8)}` : "Stop";
    if (isTodoTool(tool.name)) {
      const todos = parsedInput.todos as any[];
      return `${todos?.length || 0} tasks`;
    }
    if (isAskTool(tool.name)) {
      const questions = parsedInput.questions as any[];
      return questions?.[0]?.question ? truncateStr(String(questions[0].question), 50) : "Question";
    }

    if (tool.name.startsWith("mcp__")) {
      const parts = tool.name.split("__");
      const method = parts[2] || "";
      const displayMethod = method.replace(/_/g, " ");
      if (parsedInput.url) return shortenUrl(String(parsedInput.url));
      if (parsedInput.query) return truncateStr(String(parsedInput.query), 30);
      return displayMethod || parts[1] || "MCP";
    }

    return null;
  };

  const getResultSummary = () => {
    if (!result) return null;
    if (result.is_error) return "(error)";
    if (isEdit) {
      const match = result.content.match(/with (\d+) additions? and (\d+) removals?/);
      if (match) return `(+${match[1]} -${match[2]})`;
      return result.content.includes("has been updated") ? "(ok)" : "";
    }
    if (isRead) {
      const lines = result.content.split("\n").length;
      return `(${lines} lines)`;
    }
    if (isGlob || isGrep || isCodeSearch) {
      const lines = result.content.trim().split("\n").filter(l => l.trim()).length;
      return `(${lines} matches)`;
    }
    if (isBash && result.content) {
      const lines = result.content.trim().split("\n").length;
      if (lines > 1) return `(${lines} lines)`;
    }
    if (tool.name === "TaskList") {
      const taskLines = result.content.split("\n").filter((l: string) => l.match(/#\d+\s+\[/));
      if (taskLines.length > 0) return `(${taskLines.length} tasks)`;
    }
    return null;
  };

  const summary = getToolSummary();
  const resultSummary = getResultSummary();
  const displayToolName = isApplyPatch ? formatToolName("apply_patch") : isNested && nestedActions.length === 1
    ? formatToolName(nestedActions[0].name)
    : formatToolName(tool.name);

  const browserTab = useMemo(() => browserTabOf(tool, null, result?.content, EMPTY_BROWSER_ROWS), [tool, result?.content]);

  // A shell call that made a commit or opened a pull request shows that object
  // on the call itself — exact attribution, no second row in the transcript.
  const shellCommand = isBash ? String(parsedInput.command || parsedInput.cmd || "") : "";
  const gitOutcome = useMemo(
    () => (shellCommand && result ? gitToolOutcome(shellCommand, safeString(result.content), result.is_error) : null),
    [shellCommand, result],
  );
  // The session's repository names the commit only when the command stayed in
  // the session's checkout; one that changed directory may have committed
  // anywhere, so its pill stays unlinked rather than pointing at the wrong repo.
  const outcomeRepository = useInboxStore((s) =>
    gitOutcome && conversationId && !commandLeavesCheckout(shellCommand)
      ? sessionRepository((s.conversations[conversationId as string] ?? s.sessions?.[conversationId as string] ?? {}) as any)
      : null,
  );

  // Process result content - strip line numbers for Read tool, strip Tab Context from MCP chrome results
  const rawResultContent = result ? safeString(result.content) : "";
  const processedContent = result ? (isRead ? stripLineNumbers(rawResultContent) : tool.name.startsWith("mcp__claude-in-chrome__") ? rawResultContent.replace(/\n?\n?Tab Context:[\s\S]*$/, "").trim() : rawResultContent) : "";

  const isCodeTool = isBash || isEdit || isRead || isGlob || isGrep || isCodeSearch;
  const isMarkdownResult = result && !isCodeTool && typeof processedContent === 'string' && (
    processedContent.includes('###') || processedContent.includes('**') || processedContent.includes('```')
  );

  // Extract starting line number from Edit result (format: "   42→content")
  const getStartLine = () => {
    if (isRead) {
      const offset = parsedInput.offset;
      if (offset && typeof offset === 'number') return offset;
      if (result?.content) {
        const match = result.content.match(/^\s*(\d+)\t/m);
        if (match) return parseInt(match[1], 10);
      }
      return 1;
    }
    if (!isStandardEdit || !result) return 1;
    const match = result.content.match(/^\s*(\d+)→/m);
    return match ? parseInt(match[1], 10) : 1;
  };
  const startLine = getStartLine();

  const toolColor = toolColorClass(isApplyPatch ? "apply_patch" : tool.name);

  const targetStart = changeRange?.start ?? changeIndex;
  const targetEnd = changeRange?.end ?? changeIndex;
  const hasTargetRange = targetStart !== undefined && targetEnd !== undefined;
  const isClickable = isEdit && hasTargetRange;
  const isSelected = isClickable && (
    (selectedChangeIndex !== null &&
      targetStart !== undefined &&
      targetEnd !== undefined &&
      selectedChangeIndex >= targetStart &&
      selectedChangeIndex <= targetEnd) ||
    (rangeStart !== null &&
      rangeEnd !== null &&
      targetStart !== undefined &&
      targetEnd !== undefined &&
      Math.max(rangeStart, targetStart) <= Math.min(rangeEnd, targetEnd))
  );

  const handleClick = (e: React.MouseEvent) => {
    if (shareSelectionMode) {
      return;
    }
    if (isClickable && targetStart !== undefined && targetEnd !== undefined) {
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey) {
        if (selectedChangeIndex !== null) {
          selectRange(selectedChangeIndex, targetEnd);
        } else {
          selectRange(targetStart, targetEnd);
        }
      } else {
        if (targetStart !== targetEnd) {
          selectRange(targetStart, targetEnd);
        } else {
          selectChange(targetStart);
        }
      }
    } else {
      setExpanded(!expanded);
    }
  };

  if (isPlanWrite && content) {
    return <PlanBlock content={content} timestamp={timestamp || Date.now()} collapsed={collapsed} messageId={messageId} conversationId={conversationId} onOpenComments={onOpenComments} onStartShareSelection={onStartShareSelection} />;
  }

  const isCodecastImageRead = isRead && /codecast\/images\//.test(filePath);
  if (isCodecastImageRead) {
    return (
      <div className="my-0.5 flex items-center gap-1.5 text-xs">
        <svg className="w-3.5 h-3.5 text-sol-blue/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.64 0 8.577 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.64 0-8.577-3.007-9.963-7.178z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span className="text-sol-text-dim italic">Viewing your image</span>
      </div>
    );
  }

  return (
    <div className="my-0.5">
      <div
        className={`flex items-center gap-1.5 group text-xs ${
          isClickable
            ? 'cursor-pointer hover:bg-sol-bg-highlight/30 rounded px-1 -mx-1 transition-colors'
            : 'cursor-pointer'
        } ${
          isSelected
            ? 'bg-sol-blue/10 border border-sol-blue/30 rounded px-1 -mx-1'
            : ''
        }`}
        onClick={handleClick}
      >
        <span className={`font-mono flex-shrink-0 group-hover:underline ${toolColor}`}>{displayToolName}</span>
        {summary && (
          <span className="text-sol-text-muted font-mono truncate min-w-0">
            {(isStandardEdit || isRead) && filePath ? (
              // The file a Read/Edit touched, linked into Files. Stop the click
              // so it opens the file rather than toggling the row.
              <FilePathLink path={filePath} onClick={(e) => e.stopPropagation()}>{summary}</FilePathLink>
            ) : summary}
          </span>
        )}
        {browserTab && <BrowserTabPill tab={browserTab} />}
        {gitOutcome && <GitOutcomeRow outcome={gitOutcome} repository={outcomeRepository} />}
        {resultSummary && (
          <span className={`font-mono flex-shrink-0 whitespace-nowrap ${result?.is_error ? "text-sol-red/80" : "text-sol-text-dim"}`}>
            {resultSummary}
          </span>
        )}
      </div>

      {(() => {
        // A command can hand back several images at once (`cast browser shot
        // --viewports`); side by side they read as the comparison they are,
        // stacked they read as a sequence. Each keeps its own lightbox click.
        let toolImages = images?.filter(img => img.tool_use_id === tool.id) ?? [];
        if (!toolImages.length) toolImages = globalImageMap?.[tool.id] ?? [];
        if (!toolImages.length) return null;
        if (toolImages.length === 1) return <ImageBlock image={toolImages[0]} />;
        return (
          <div className="flex gap-2 items-start">
            {toolImages.map((img, i) => (
              <div key={i} className="flex-1 min-w-0 max-w-md">
                <ImageBlock image={img} />
              </div>
            ))}
          </div>
        );
      })()}

      {expanded && (
        <div
          ref={fullWidth.containerRef}
          style={fullWidth.style}
          className="mt-1 rounded border border-sol-border/30 bg-sol-bg-inset transition-all duration-200"
        >
          {/* Markdown toggle header */}
          {isMarkdown && (isRead || (isWriteTool(tool.name) && Boolean(parsedInput.content))) && (
            <div className="flex items-center justify-between px-2 py-1 border-b border-sol-border/20 bg-sol-bg-highlight/30">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-sol-text-dim">{language}</span>
                {isPlan && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-sol-bg-highlight text-sol-text-muted font-medium">
                    PLAN
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 text-[10px]">
                <button
                  onClick={(e) => { e.stopPropagation(); setViewMode('raw'); }}
                  className={`px-1.5 py-0.5 rounded transition-colors ${
                    viewMode === 'raw'
                      ? 'bg-sol-bg-highlight text-sol-text'
                      : 'text-sol-text-dim hover:text-sol-text-muted'
                  }`}
                >
                  Raw
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setViewMode('rendered'); }}
                  className={`px-1.5 py-0.5 rounded transition-colors ${
                    viewMode === 'rendered'
                      ? 'bg-sol-bg-highlight text-sol-text'
                      : 'text-sol-text-dim hover:text-sol-text-muted'
                  }`}
                >
                  Rendered
                </button>
              </div>
            </div>
          )}
          {isNested ? (
            <div className="max-h-80 overflow-auto">
              {nestedActions.length > 0 ? (
                <NestedStepList
                  steps={nestedActions.map((action) => ({ label: formatToolName(action.name), summary: sharedToolSummary(action) }))}
                  outcomes={isBrowserBatch ? splitBrowserBatchResult(rawResultContent, nestedActions.length) : undefined}
                  labelClass="text-sol-cyan/80"
                />
              ) : (
                <pre className="border-b border-sol-border/20 bg-sol-bg-highlight/20 p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap text-sol-text-muted">
                  {String(parsedInput.input || parsedInput.code || parsedInput.script || "Codex action")}
                </pre>
              )}
              {/* A batch's result is already spread across its steps; only the
                  Codex program keeps its result as one block underneath. */}
              {isBrowserBatch && nestedActions.length > 0 ? (
                !result && <div className="p-2 text-xs text-sol-text-dim">Running</div>
              ) : processedContent && processedContent.trim() ? (
                <pre className={`p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap ${result?.is_error ? "text-sol-red" : "text-sol-text-secondary"}`}>
                  {renderAnsi(processedContent)}
                </pre>
              ) : (
                <div className="p-2 text-xs text-sol-text-dim">No output</div>
              )}
            </div>
          ) : isEdit && editStrings ? (
            <DiffView
              oldStr={editStrings.oldStr}
              newStr={editStrings.newStr}
              startLine={startLine}
              language={language}
              commentContext={lineCommentCtx(filePath)}
            />
          ) : isWriteTool(tool.name) && !!parsedInput.content ? (
            isMarkdown && viewMode === 'rendered' ? (
              <>
                <div
                  ref={mdContainerRef}
                  className="relative p-3"
                  style={!mdExpanded && mdOverflowing ? { maxHeight: MD_COLLAPSED_HEIGHT, overflowY: 'hidden' } : undefined}
                >
                  <MarkdownRenderer content={String(parsedInput.content)} filePath={filePath} />
                  {!mdExpanded && mdOverflowing && (
                    <div className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none bg-gradient-to-b from-transparent to-[var(--sol-bg-inset)]" />
                  )}
                </div>
                {(mdOverflowing || mdExpanded) && (
                  <div className="flex items-center gap-1 px-2 py-1 border-t border-sol-border/20">
                    <FooterIconButton
                      onClick={(e) => { e.stopPropagation(); setMdFullscreen(true); }}
                      title="Fullscreen"
                      label="Full Screen"
                    >
                      <FullscreenIcon />
                    </FooterIconButton>
                    <FooterIconButton
                      onClick={(e) => { e.stopPropagation(); setMdExpanded(v => !v); }}
                      title={mdExpanded ? "Collapse" : "Expand"}
                    >
                      {mdExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </FooterIconButton>
                  </div>
                )}
                {mdFullscreen && createPortal(
                  <div className="fixed inset-0 z-[10001] bg-sol-bg overflow-auto" onClick={() => setMdFullscreen(false)}>
                    <div className="conv-col mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-between mb-6">
                        <span className="text-sol-text-secondary text-sm font-medium">{filePath.split('/').pop()}</span>
                        <button
                          onClick={() => setMdFullscreen(false)}
                          className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                          title="Close (Esc)"
                        >
                          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                      <MarkdownRenderer content={String(parsedInput.content)} filePath={filePath} />
                    </div>
                  </div>,
                  document.body
                )}
              </>
            ) : (
              <DiffView
                oldStr=""
                newStr={String(parsedInput.content)}
                startLine={1}
                language={language}
                commentContext={lineCommentCtx(filePath)}
              />
            )
          ) : isApplyPatch || isFileChange ? (
            (isApplyPatch ? applyPatchDiffs : fileChangeDiffs).length > 0 ? (
              <div className="max-h-80 overflow-auto">
                {(isApplyPatch ? applyPatchDiffs : fileChangeDiffs).map((diff, idx) => {
                  const diffLanguage = getFileExtension(diff.filePath);
                  const diffStartLine = diff.hunks[0]?.oldStart || diff.hunks[0]?.newStart || 1;
                  return (
                    <div key={`${diff.filePath}-${idx}`} className={idx > 0 ? "border-t border-sol-border/20" : ""}>
                      <div className="px-2 py-1 border-b border-sol-border/20 bg-sol-bg-highlight/20">
                        <span className="text-xs font-mono text-sol-text-dim truncate">{getRelativePath(diff.filePath)}</span>
                      </div>
                      <DiffView
                        oldStr={diff.oldContent}
                        newStr={diff.newContent}
                        startLine={diffStartLine}
                        language={diffLanguage}
                        commentContext={lineCommentCtx(diff.filePath)}
                      />
                    </div>
                  );
                })}
              </div>
            ) : isApplyPatch && applyPatchInput.trim() ? (
              <div className="max-h-80 overflow-auto">
                <pre className="p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap text-sol-text-secondary">
                  {applyPatchInput}
                </pre>
              </div>
            ) : tool.name === "fileChange" && processedContent && processedContent.trim() ? (
              <div className="max-h-80 overflow-auto">
                <pre className="p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap text-sol-text-secondary">
                  {processedContent}
                </pre>
              </div>
            ) : (
              <div className="p-2 text-xs text-sol-text-dim">
                {tool.name === "fileChange" ? "Patch diff unavailable" : "Patch input unavailable"}
              </div>
            )
          ) : isBash && (parsedInput.command || parsedInput.cmd) ? (
            <div className="max-h-80 overflow-auto">
              <div className="px-1.5 sm:px-2 py-1 sm:py-1.5 border-b border-sol-border/20 bg-sol-bg-highlight/30">
                <pre className="text-[11px] sm:text-xs font-mono text-sol-green whitespace-pre-wrap break-all">
                  $ {unwrapShellCommand(String(parsedInput.command || parsedInput.cmd || ""))}
                </pre>
              </div>
              {processedContent && processedContent.trim() ? (
                <pre className={`p-1.5 sm:p-2 text-[11px] sm:text-xs font-mono overflow-x-auto whitespace-pre-wrap ${result?.is_error ? "text-sol-red" : "text-sol-text-secondary"}`}>
                  {renderAnsi(processedContent)}
                </pre>
              ) : (
                <div className="p-2 text-xs text-sol-text-dim">No output</div>
              )}
            </div>
          ) : isRead && language && processedContent && processedContent.trim() ? (
            <>
              <DiffView
                oldStr={processedContent}
                newStr={processedContent}
                startLine={startLine}
                language={language}
                showLineNumbers
                commentContext={lineCommentCtx(filePath)}
              />
              <div className="flex items-center gap-1 px-2 py-1 border-t border-sol-border/20">
                <FooterIconButton
                  onClick={(e) => { e.stopPropagation(); setCodeFullscreen(true); }}
                  title="Fullscreen"
                  label="Full Screen"
                >
                  <FullscreenIcon />
                </FooterIconButton>
                <FooterIconButton
                  onClick={(e) => { e.stopPropagation(); fullWidth.toggle(); }}
                  title={fullWidth.expanded ? "Normal width" : "Full width"}
                  label={fullWidth.expanded ? "Normal Width" : "Full Width"}
                >
                  <MoveHorizontal className="w-4 h-4" />
                </FooterIconButton>
                <FooterIconButton
                  onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
                  title="Collapse"
                >
                  <ChevronUp className="w-4 h-4" />
                </FooterIconButton>
              </div>
              {codeFullscreen && createPortal(
                <div className="fixed inset-0 z-[10001] bg-sol-bg overflow-auto" onClick={() => setCodeFullscreen(false)}>
                  <div className="max-w-6xl mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-between mb-4">
                      <span className="text-sol-text-secondary text-sm font-mono">{relativePath}</span>
                      <button
                        onClick={() => setCodeFullscreen(false)}
                        className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                        title="Close (Esc)"
                      >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    <div className="rounded border border-sol-border/30 bg-sol-bg-inset">
                      <DiffView
                        oldStr={processedContent}
                        newStr={processedContent}
                        startLine={startLine}
                        maxLines={99999}
                        language={language}
                        showLineNumbers
                      />
                    </div>
                  </div>
                </div>,
                document.body
              )}
            </>
          ) : isStructuredOutput ? (
            <div className="max-h-80 overflow-auto">
              {structuredJson ? (
                <DiffView oldStr={structuredJson} newStr={structuredJson} language="json" />
              ) : rawToolInput ? (
                <pre className="p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap text-sol-text-secondary">{rawToolInput}</pre>
              ) : (
                <div className="p-2 text-xs text-sol-text-dim">No output</div>
              )}
              {result?.is_error && processedContent && (
                <pre className="p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap text-sol-red border-t border-sol-border/20">
                  {renderAnsi(processedContent)}
                </pre>
              )}
            </div>
          ) : processedContent && processedContent.trim() ? (
            <div className="max-h-80 overflow-auto">
              {isMarkdown && viewMode === 'rendered' ? (
                <div className="p-3">
                  <MarkdownRenderer content={processedContent} filePath={filePath} />
                </div>
              ) : isMarkdownResult ? (
                <div className="p-2 prose prose-invert prose-sm max-w-none text-xs">
                  <ReactMarkdown remarkPlugins={entityRemarkPlugins} components={MD_COMPONENTS_NO_PRE}>{processedContent}</ReactMarkdown>
                </div>
              ) : (
                <>
                  {!isMarkdown && language && (
                    <div className="text-[10px] px-2 py-1 border-b border-sol-border/20 text-sol-text-dim">
                      {language}
                    </div>
                  )}
                  <pre className={`p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap ${result?.is_error ? "text-sol-red" : "text-sol-text-secondary"}`}>
                    {renderAnsi(processedContent)}
                  </pre>
                </>
              )}
            </div>
          ) : (
            <div className="p-2 text-xs text-sol-text-dim">No output</div>
          )}
          {(isEmbeddedPatch || (isApplyPatch && result?.is_error)) && (
            <details open={result?.is_error || undefined} className="border-t border-sol-border/20">
              <summary className="cursor-pointer px-2 py-1 text-xs text-sol-text-dim">Execution details</summary>
              <div className="max-h-80 overflow-auto">
                {nestedActions.length > 1 && (
                  <NestedStepList
                    steps={nestedActions.map((action) => ({ label: formatToolName(action.name), summary: sharedToolSummary(action) }))}
                    labelClass="text-sol-cyan/80"
                  />
                )}
                {shellCommand && <pre className="p-2 text-xs font-mono whitespace-pre-wrap text-sol-text-muted">{shellCommand}</pre>}
                {processedContent.trim() ? (
                  <pre className={`p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap ${result?.is_error ? "text-sol-red" : "text-sol-text-secondary"}`}>
                    {renderAnsi(processedContent)}
                  </pre>
                ) : <div className="p-2 text-xs text-sol-text-dim">{result ? "No output" : "Running"}</div>}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export function TodoWriteBlock({ tool }: { tool: ToolCall }) {
  let parsedInput: { todos?: Array<{ content: string; status: string; activeForm?: string }> } = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}

  const todos = parsedInput.todos || [];
  if (todos.length === 0) return null;

  const completed = todos.filter(t => t.status === 'completed').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;

  return (
    <div className="my-2">
      <div className="flex items-center gap-2 py-0.5">
        <span className="w-1.5 h-1.5 rounded-full bg-pink-500 flex-shrink-0" />
        <span className="font-mono text-sm font-medium text-pink-600 dark:text-sol-magenta">
          {formatToolName(tool.name)}
        </span>
        <span className="text-sol-text-dim text-sm font-mono">
          {completed}/{todos.length} done
          {inProgress > 0 && `, ${inProgress} in progress`}
        </span>
      </div>
      <div className="ml-3.5 mt-1 space-y-0.5">
        {todos.map((todo, i) => (
          <div key={i} className="flex items-start gap-2 text-sm">
            {todo.status === 'completed' ? (
              <svg className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : todo.status === 'in_progress' ? (
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-sol-text-dim flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <circle cx="12" cy="12" r="9" strokeWidth={2} />
              </svg>
            )}
            <span className={`${
              todo.status === 'completed' ? 'text-sol-text-dim line-through' :
              todo.status === 'in_progress' ? 'text-sol-text-secondary' :
              'text-sol-text-muted'
            }`}>
              {todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TaskListBlock({ tool, result, taskRecordMap }: { tool: ToolCall; result?: ToolResult; taskRecordMap?: TaskRecordMaps }) {
  const router = useRouter();
  if (!result) return null;
  const lines = result.content.split("\n");
  const items: Array<{ id: string; status: string; subject: string; owner?: string; blockedBy?: string[] }> = [];
  for (const line of lines) {
    const match = line.match(/#(\d+)\s+\[(\w+)]\s+(.+?)(?:\s+\(([^)]+)\))?(?:\s+\[blocked by ([^\]]+)])?$/);
    if (match) {
      items.push({
        id: match[1], status: match[2], subject: match[3].trim(),
        owner: match[4]?.trim(),
        blockedBy: match[5]?.split(",").map(s => s.trim().replace("#", "")),
      });
    }
  }
  if (items.length === 0) return null;

  const completed = items.filter(t => t.status === "completed").length;
  const inProgress = items.filter(t => t.status === "in_progress").length;

  return (
    <div className="my-2">
      <div className="flex items-center gap-2 py-0.5">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
        <span className="font-mono text-sm font-medium text-emerald-600 dark:text-emerald-400">TaskList</span>
        <span className="text-sol-text-dim text-sm font-mono">
          {completed}/{items.length} done{inProgress > 0 && `, ${inProgress} active`}
        </span>
      </div>
      <div className="ml-3.5 mt-1 space-y-0.5">
        {items.map(task => {
          const isBlocked = task.blockedBy && task.blockedBy.length > 0;
          const matched = taskRecordMap?.byTitle[task.subject] || taskRecordMap?.byLocalId[task.id];
          const clickable = !!matched;
          return (
            <div
              key={task.id}
              className={`flex items-start gap-2 text-sm ${isBlocked ? "opacity-50" : ""}${clickable ? " cursor-pointer rounded px-1.5 py-0.5 -mx-1 hover:bg-sol-bg-highlight/50 transition-colors" : ""}`}
              onClick={clickable ? () => router.push(`/tasks/${matched._id}`) : undefined}
            >
              {task.status === "completed" ? (
                <svg className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : task.status === "in_progress" ? (
                <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : isBlocked ? (
                <svg className="w-4 h-4 text-sol-text-dim flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-sol-text-dim flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <circle cx="12" cy="12" r="9" strokeWidth={2} />
                </svg>
              )}
              <span className="text-sol-text-dim text-xs font-mono mt-0.5">#{task.id}</span>
              <span className={
                task.status === "completed" ? "text-sol-text-dim line-through" :
                task.status === "in_progress" ? "text-sol-text-secondary" :
                "text-sol-text-muted"
              }>
                {task.subject}
              </span>
              {task.owner && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20 font-mono">
                  @{task.owner}
                </span>
              )}
              {isBlocked && (
                <span className="text-[10px] text-sol-text-dim mt-0.5">
                  blocked by {task.blockedBy!.map(id => `#${id}`).join(", ")}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TaskCreateUpdateBlock({ tool, result, taskSubjectMap, taskRecordMap }: { tool: ToolCall; result?: ToolResult; taskSubjectMap?: Record<string, string>; taskRecordMap?: TaskRecordMaps }) {
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}
  const router = useRouter();

  const isCreate = tool.name === "TaskCreate";
  const subject = parsedInput.subject;
  const taskId = parsedInput.taskId;
  const status = parsedInput.status;
  const owner = parsedInput.owner;
  const activeForm = parsedInput.activeForm;

  let resultId = "";
  if (result) {
    const idMatch = result.content.match(/Task #(\d+)/);
    if (idMatch) resultId = idMatch[1];
  }

  const resolvedSubject = subject || (taskId && taskSubjectMap?.[taskId]);
  const matchedTask = resolvedSubject
    ? taskRecordMap?.byTitle[String(resolvedSubject)]
    : taskId
    ? taskRecordMap?.byLocalId[String(taskId)]
    : undefined;
  const isClickable = !!matchedTask;

  const handleClick = () => {
    if (matchedTask) router.push(`/tasks/${matchedTask._id}`);
  };

  const displaySubject = resolvedSubject || matchedTask?.title;

  if (!isCreate && displaySubject) {
    return (
      <div className="my-0.5">
        <div
          className={`flex items-center gap-1.5 text-xs${isClickable ? " cursor-pointer rounded px-1.5 py-0.5 -mx-1 hover:bg-sol-bg-highlight/50 transition-colors" : ""}`}
          onClick={isClickable ? handleClick : undefined}
        >
          <span className="text-sol-text-muted">{String(displaySubject).slice(0, 60)}</span>
          {status && (
            <span className={`px-1 py-0.5 rounded text-[10px] font-mono ${
              status === "completed" ? "bg-emerald-500/15 text-emerald-400" :
              status === "in_progress" ? "bg-amber-500/15 text-amber-400" :
              status === "deleted" ? "bg-red-500/15 text-red-400" :
              "bg-gray-500/15 text-gray-400"
            }`}>
              {status}
            </span>
          )}
          {owner && <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20 font-mono">@{owner}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="my-0.5">
      <div
        className={`flex items-center gap-1.5 text-xs${isClickable ? " cursor-pointer rounded px-1.5 py-0.5 -mx-1 hover:bg-sol-bg-highlight/50 transition-colors" : ""}`}
        onClick={isClickable ? handleClick : undefined}
      >
        <span className="font-mono text-emerald-500/80">{tool.name}</span>
        {isCreate ? (
          <>
            {resultId && <span className="text-sol-text-dim font-mono">#{resultId}</span>}
            {subject && <span className="text-sol-text-muted">{String(subject).slice(0, 60)}</span>}
            {activeForm && <span className="text-sol-text-dim italic">({activeForm})</span>}
          </>
        ) : (
          <>
            {taskId && <span className="text-sol-text-dim font-mono">#{taskId}</span>}
            {status && (
              <span className={`px-1 py-0.5 rounded text-[10px] font-mono ${
                status === "completed" ? "bg-emerald-500/15 text-emerald-400" :
                status === "in_progress" ? "bg-amber-500/15 text-amber-400" :
                status === "deleted" ? "bg-red-500/15 text-red-400" :
                "bg-gray-500/15 text-gray-400"
              }`}>
                {status}
              </span>
            )}
            {owner && <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20 font-mono">@{owner}</span>}
          </>
        )}
      </div>
    </div>
  );
}

// The "open tab" pill lives in browser/BrowserTabPill.tsx; "watch live" below
// shares its pill styling so the two read as one pair of controls.
const EMPTY_BROWSER_ROWS: Record<string, BrowserRowState> = {};

/**
 * "watch live" on a `cast browser` row: opens the stream of the tab this agent
 * is driving. Rendered on every browser row — whether a stream actually exists
 * is the daemon's call, and the stream reports it honestly on connect.
 *
 * Two homes for the same picture. A stage pane (/browser?watch=…) is the
 * default: it is resizable, it survives a reload with the tab, and it leaves
 * the transcript its own width. The dock above the transcript is the fallback
 * for a window too narrow to hold two panes, and stays available on the
 * chevron for anyone who prefers it there.
 */
export function BrowserWatchButton({ conversationId }: { conversationId: Id<"conversations"> }) {
  const convKey = conversationId.toString();
  const open = useBrowserWatchOpen(convKey);
  // The pane is addressed by the agent's own session uuid, not the
  // conversation id — the daemon follows the SESSION's tab.
  const sessionUuid = useInboxStore((s) => s.sessions[convKey]?.session_id ?? null);
  const dock = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleBrowserWatch(convKey);
  };
  const watch = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Nothing to address the pane with, or no room for one: the dock needs
    // neither, and it is the same stream.
    if (open || !sessionUuid || !canOpenBeside()) {
      toggleBrowserWatch(convKey);
      return;
    }
    openBrowserPane({ kind: "watch", sessionUuid });
  };
  return (
    <span className="inline-flex items-center gap-0.5 flex-shrink-0">
      <button
        onClick={watch}
        className={`${BROWSER_ROW_PILL} ${open ? "text-sol-red border-sol-red/40 hover:text-sol-red/80" : ""}`}
        title={
          open
            ? "Close the live browser view"
            : "Watch what this agent's browser shows, live, in a pane beside this thread — take control to sign in for it"
        }
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span>{open ? "watching" : "watch live"}</span>
      </button>
      {!open && (
        <button
          type="button"
          onClick={dock}
          className="text-[10px] leading-4 px-0.5 rounded-full text-sol-text-dim hover:text-sol-text-muted"
          title="Dock the live view above the transcript instead"
          aria-label="Dock the live view above the transcript"
        >
          <ChevronDown className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

export function SendMessageBlock({ tool, agentNameToChildMap }: { tool: ToolCall; agentNameToChildMap?: Record<string, string> }) {
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const type = parsedInput.type || "message";
  const recipient = parsedInput.recipient;
  const summary = parsedInput.summary;
  const content = parsedInput.content;
  const childId = recipient && agentNameToChildMap?.[recipient];

  const isShutdown = type === "shutdown_request";
  const isBroadcast = type === "broadcast";

  const typeConfig = isShutdown
    ? { icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" /></svg>, color: "text-red-400/80", bg: "bg-red-500/8 border-red-500/15", label: "shutdown" }
    : isBroadcast
    ? { icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" /></svg>, color: "text-orange-400/80", bg: "bg-orange-500/8 border-orange-500/15", label: "broadcast" }
    : { icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>, color: "text-amber-400/80", bg: "bg-amber-500/8 border-amber-500/15", label: "message" };

  const displayText = summary || (content && String(content).slice(0, 80)) || "";

  return (
    <div className="my-0.5">
      <div className={`flex items-center gap-1.5 text-xs py-1.5 px-2.5 rounded-md border ${typeConfig.bg}`}>
        <span className={typeConfig.color}>{typeConfig.icon}</span>
        {isShutdown ? (
          <>
            {recipient && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20 font-mono">@{recipient}</span>}
            <span className="text-red-400/80 font-medium text-xs">shutdown request</span>
          </>
        ) : (
          <>
            {recipient && (
              childId ? (
                <Link href={`/conversation/${childId}`} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20 font-mono hover:bg-amber-500/25 hover:text-amber-300 transition-colors" onClick={e => e.stopPropagation()}>@{recipient}</Link>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20 font-mono">@{recipient}</span>
              )
            )}
            {isBroadcast && <span className="text-[10px] px-1 py-0.5 rounded bg-orange-500/15 text-orange-400 font-mono">all</span>}
            {displayText && <span className="text-sol-text-muted truncate">{displayText}</span>}
          </>
        )}
      </div>
    </div>
  );
}

export function TeamCreateBlock({ tool }: { tool: ToolCall }) {
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const isDelete = tool.name === "TeamDelete";

  return (
    <div className="my-0.5">
      <div className={`flex items-center gap-1.5 text-xs py-1.5 px-2.5 rounded-md border ${isDelete ? "bg-red-500/5 border-red-500/15" : "bg-cyan-500/8 border-cyan-500/15"}`}>
        <svg className={`w-3 h-3 shrink-0 ${isDelete ? "text-red-400/70" : "text-cyan-400/70"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
        <span className={`font-mono text-xs font-medium ${isDelete ? "text-red-400/80" : "text-cyan-400/80"}`}>
          {isDelete ? "Team dissolved" : "Team created"}
        </span>
        {parsedInput.team_name && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-cyan-500/15 text-cyan-400 border border-cyan-500/20">
            {parsedInput.team_name}
          </span>
        )}
        {parsedInput.description && <span className="text-sol-text-dim truncate">{String(parsedInput.description).slice(0, 60)}</span>}
      </div>
    </div>
  );
}

export function SkillBlock({ tool }: { tool: ToolCall }) {
  let parsedInput: { skill?: string; args?: string } = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}
  const skillName = parsedInput.skill || "skill";
  return (
    <div className="my-0.5">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-mono text-sol-cyan/80">/{skillName}</span>
        {parsedInput.args && <span className="text-sol-text-dim">{parsedInput.args}</span>}
      </div>
    </div>
  );
}
