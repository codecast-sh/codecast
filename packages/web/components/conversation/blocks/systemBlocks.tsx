import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, memo } from "react";
import { getCommandType, cleanContent, extractSkillInfo, isHiddenSystemNotice, isWarningSystemNotice } from "../../../lib/conversationProcessor";
import { getBuiltinCommands } from "../../../lib/builtinCommands";
import { ShortcutTooltip } from "../../KeyboardShortcutsHelp";
import { toast } from "sonner";
import { fmtDuration, fmtClock } from "../../triggerCadence";
import { TriggerPromptView } from "../../TriggerPromptView";
import { CollapsibleBody, ExpandableLine } from "../../CollapsibleBody";
import { isMonitorEventNotification, isMonitorEndedNotification, isOrphanSummaryNotification, monitorNotificationDescription, parseNotificationSummary, decodeEntities } from "../../monitorRows";
import { DynamicRunView, wfStatusMeta, wfFmtTokens } from "../../DynamicRunView";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { copyToClipboard } from "../../../lib/utils";
import { useWorkflowRun } from "../../../hooks/useSyncWorkflows";
import { EntityIdPill, TextWithMentions } from "../../EntityIdPill";
import { EstablishedRefsProvider } from "../../../hooks/entityMentionScope";
import { FormattedSummary } from "../../FormattedSummary";
import { entityRemarkPlugins } from "../../../lib/remarkEntityIds";
import { MESSAGE_MD_REHYPE, MESSAGE_MD_COMPONENTS } from "../../messageMarkdown";
import { useJumpToSendingMessage } from "../../../hooks/useJumpToSendingMessage";
import { isTeammateFramingOnly, parseSpawnedTaskPrompt, type ChatWakePrompt, type HuddleSummaryTag } from "../../sessionMessage";
import { CallTranscriptDisclosure } from "../../calls/TranscriptTurns";
import { useInboxStore, useTrackedStore } from "../../../store/inboxStore";
import { DecisionCompactCard } from "../../decisions/DecisionCompactCard";
import { MessageSquare, Users, Hash, ChevronDown, ChevronRight, Clock, CornerDownRight, Workflow, Zap, Radar, Bot, PhoneCall, ArrowUpRight } from "lucide-react";
import { sessionMessageQueueLabel } from "../../../lib/pendingBanner";
import { PlanBlock } from "./planBlock";
import { UserIcon, agentBorderMap, agentColorMap, agentTextMap } from "./shared";
import { cleanCommandExpansion, cleanStickyContent, parseCommandInvocation, parseTaskNotification, parseTeammateMessages } from "../classify";
import { formatFullTimestamp, formatRelativeTime, stripAnsiCodes } from "../format";
import { CMD_MD_COMPONENTS, MD_COMPONENTS_NO_IMG, MD_COMPONENTS_NO_PRE, ReactMarkdown, hasRichMarkdown } from "../markdown";
import { TimelineRule } from "../sessionChrome";
import type { ToolCall, ToolResult } from "../types";

function CommandStatusLine({ content: rawContent, timestamp }: { content: string; timestamp: number }) {
  const content = rawContent.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, '').trim();
  const cmdType = getCommandType(content);
  const cmdNameMatch = content.match(/<command-name>([^<]*)<\/command-name>/) || content.match(/<command-message>([^<]*)<\/command-message>/) || content.trim().match(/^\/([\w-]+)/);
  const cmdName = cmdNameMatch?.[1]?.replace(/^\//, "");
  const cleaned = cleanContent(content);
  const rawDisplay = cleaned.slice(0, 100) || content.replace(/<[^>]+>/g, "").slice(0, 100);
  const displayText = cmdName ? rawDisplay.replace(new RegExp(`(/?${cmdName}\\s*)+`), "").trim() : rawDisplay;

  if (cmdName) {
    return (
      <div className="mb-2 px-3 py-1.5 flex items-center gap-2 text-xs">
        <svg className="w-3 h-3 text-sol-cyan/70 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
        </svg>
        <span className="font-mono text-sol-cyan/80 font-medium">/{cmdName}</span>
        {displayText && <span className="text-[11px] text-sol-text-dim truncate">{displayText}</span>}
        <span className="text-sol-text-dim text-[10px] ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
    );
  }

  return (
    <div className="mb-2 px-3 py-1.5 flex items-center gap-2 text-xs text-sol-text-dim">
      <span className="text-sol-text-dim" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      <span className="px-1.5 py-0.5 rounded bg-sol-bg-alt/50 text-sol-text-muted font-mono text-[10px]">
        {cmdType || "status"}
      </span>
      <span className="font-mono truncate">{displayText}</span>
    </div>
  );
}

// Renders a slash command as a single user-message-styled block: the command chip +
// the args the user typed (in full), with the command's .md body tucked behind a
// disclosure. Replaces the old two-pill rendering (invocation status line + a separate
// skill-expansion block). Falls back to the lightweight CommandStatusLine for command
// *output* (local-command-stdout/stderr, caveats), which carries no command name.
export function CommandMessageBlock({
  content, expansion, timestamp, userName, avatarUrl, agentType, messageId,
}: {
  content: string;
  expansion?: string;
  timestamp: number;
  userName?: string;
  avatarUrl?: string | null;
  agentType?: string;
  messageId?: string;
}) {
  const [showSource, setShowSource] = useState(false);
  const { cmdName, args } = parseCommandInvocation(content);

  if (!cmdName) return <CommandStatusLine content={content} timestamp={timestamp} />;

  const source = expansion ? cleanCommandExpansion(expansion) : "";
  const argsNorm = args.replace(/\s+/g, " ").trim();
  const sourceNorm = source.replace(/\s+/g, " ").trim();
  // Skip the disclosure when the expansion is empty or just re-echoes the args
  // (some commands expand to "/cmd <args>" with no body of their own).
  const hasSource =
    sourceNorm.length > 0 &&
    sourceNorm !== argsNorm &&
    !(argsNorm.length > 0 && sourceNorm.endsWith(argsNorm) && sourceNorm.length <= argsNorm.length + cmdName.length + 4);

  const builtinDesc = getBuiltinCommands(agentType).find(c => c.name === cmdName)?.description;
  const argsIsMarkdown = hasRichMarkdown(args);

  const handleCopy = () => {
    const full = `/${cmdName}${args ? " " + args : ""}`;
    setTimeout(() => { copyToClipboard(full).then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  };

  // Chip contents: sparkle + /name, plus a disclosure chevron when an instruction body exists.
  const chipInner = (
    <>
      <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /></svg>
      /{cmdName}
      {hasSource && <svg className={`w-3 h-3 shrink-0 text-sol-cyan/60 transition-transform ${showSource ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>}
    </>
  );

  return (
    <div data-cc-message="user" id={messageId ? `msg-${messageId}` : undefined} className="group relative scroll-mt-20 bg-sol-blue/10 -mx-4 px-4 py-4 rounded-lg border border-sol-blue/30 mb-6">
      <div className="absolute -top-2 right-0 opacity-0 group-hover:opacity-100 transition-opacity bg-sol-bg rounded shadow-md px-0.5 z-10">
        <button onClick={handleCopy} className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary" title="Copy command" aria-label="Copy command">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
        </button>
      </div>

      <div data-cc-message-who className="flex items-center gap-2 mb-2">
        <UserIcon avatarUrl={avatarUrl} />
        <span className="text-sol-blue text-xs font-medium">{userName || "You"}</span>
        <span className="text-sol-text-dim text-xs" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>

      <div className="pl-8">
        <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
          {hasSource ? (
            <button
              onClick={() => setShowSource(s => !s)}
              className="inline-flex items-center gap-1 font-mono text-xs text-sol-cyan bg-sol-cyan/10 border border-sol-cyan/25 rounded px-1.5 py-0.5 hover:bg-sol-cyan/20 hover:border-sol-cyan/40 transition-colors cursor-pointer"
              title={showSource ? "Hide command instructions" : "Show command instructions"}
            >
              {chipInner}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 font-mono text-xs text-sol-cyan bg-sol-cyan/10 border border-sol-cyan/25 rounded px-1.5 py-0.5">
              {chipInner}
            </span>
          )}
          {builtinDesc && <span className="text-[11px] text-sol-text-dim">{builtinDesc}</span>}
        </div>

        {args && (
          <div className={`text-sol-text text-sm break-words ${argsIsMarkdown ? "prose prose-invert prose-sm max-w-none" : "whitespace-pre-wrap"}`}>
            {argsIsMarkdown
              ? <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={CMD_MD_COMPONENTS}>{args}</ReactMarkdown>
              : <TextWithMentions text={args} />}
          </div>
        )}

        {hasSource && showSource && (
          <div className="mt-2 rounded-md bg-sol-bg-alt/30 border border-sol-border/20 p-3 text-xs text-sol-text-muted leading-relaxed prose prose-invert prose-sm max-w-none overflow-x-auto">
            <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={CMD_MD_COMPONENTS}>{source}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

// `!` bash mode: the user ran a shell command straight from the Claude Code
// composer. The transcript records it as two user messages (<bash-input>, then
// <bash-stdout>/<bash-stderr>); commandExpansionMap pairs them so they render
// as ONE terminal-style card. Either half can appear alone at a page boundary.
export function BashCommandBlock({ command, stdout, stderr, timestamp, userName, avatarUrl, messageId }: {
  command?: string;
  stdout?: string;
  stderr?: string;
  timestamp: number;
  userName?: string;
  avatarUrl?: string | null;
  messageId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const out = stripAnsiCodes(stdout || "").trimEnd();
  const err = stripAnsiCodes(stderr || "").trimEnd();
  const hasOutput = stdout !== undefined || stderr !== undefined;
  const lineCount = (out ? out.split("\n").length : 0) + (err ? err.split("\n").length : 0);
  const isLong = lineCount > 12 || out.length + err.length > 1500;

  const handleCopy = () => {
    const text = command ? `!${command}` : out || err;
    setTimeout(() => { copyToClipboard(text).then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  };

  return (
    <div data-cc-message="user" id={messageId ? `msg-${messageId}` : undefined} className="group relative scroll-mt-20 bg-sol-blue/10 -mx-4 px-4 py-4 rounded-lg border border-sol-blue/30 mb-6">
      <div className="absolute -top-2 right-0 opacity-0 group-hover:opacity-100 transition-opacity bg-sol-bg rounded shadow-md px-0.5 z-10">
        <button onClick={handleCopy} className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary" title="Copy command" aria-label="Copy command">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
        </button>
      </div>

      <div data-cc-message-who className="flex items-center gap-2 mb-2">
        <UserIcon avatarUrl={avatarUrl} />
        <span className="text-sol-blue text-xs font-medium">{userName || "You"}</span>
        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-sol-magenta/80 bg-sol-magenta/10 border border-sol-magenta/25 rounded px-1.5 py-px" title="Shell command run from the composer">bash</span>
        <span className="text-sol-text-dim text-xs" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>

      <div className="pl-8">
        <div className="rounded-md bg-sol-bg-alt/50 border border-sol-border/40 font-mono text-xs overflow-hidden">
          {command !== undefined && (
            <div className="flex items-start gap-2 px-3 py-2">
              <span className="text-sol-magenta font-semibold select-none shrink-0">!</span>
              <span className="text-sol-text whitespace-pre-wrap break-all min-w-0">{command}</span>
            </div>
          )}
          {hasOutput && (
            <div className={`px-3 py-2 ${command !== undefined ? "border-t border-sol-border/30" : ""}`}>
              {out || err ? (
                <>
                  <pre className={`whitespace-pre-wrap break-all text-sol-text-muted leading-relaxed ${isLong && !expanded ? "max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]" : ""}`}>
                    {out}
                    {err && <span className="text-sol-red/90">{out ? "\n" : ""}{err}</span>}
                  </pre>
                  {isLong && (
                    <button onClick={() => setExpanded(e => !e)} className="mt-1 text-[11px] text-sol-text-dim hover:text-sol-text-secondary transition-colors">
                      {expanded ? "show less" : `show all ${lineCount} lines`}
                    </button>
                  )}
                </>
              ) : (
                <span className="text-sol-text-dim italic">no output</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function SkillExpansionBlock({ content, timestamp, cmdName, collapsed }: { content: string; timestamp: number; cmdName?: string; collapsed?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const info = extractSkillInfo(content);
  const skillName = cmdName || info?.name || "skill";

  if (collapsed) {
    return (
      <div className="px-3 py-1.5 flex items-center gap-2 text-xs">
        <svg className="w-3 h-3 text-sol-cyan/70 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
        </svg>
        <span className="font-mono text-sol-cyan/80 font-medium">/{skillName}</span>
        <span className="text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
    );
  }

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(e => !e)}
        className="group flex items-center gap-2 px-3 py-2 rounded-md bg-sol-bg-alt/40 border border-sol-border/30 hover:border-sol-cyan/30 transition-colors w-full text-left"
      >
        <svg className="w-3.5 h-3.5 text-sol-cyan/70 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
        </svg>
        <span className="font-mono text-xs text-sol-cyan/80 font-medium">/{skillName}</span>
        {info?.preview && !expanded && (
          <span className="text-[11px] text-sol-text-dim truncate">{info.preview}</span>
        )}
        <span className="ml-auto text-sol-text-dim text-[10px] shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
        <svg className={`w-3 h-3 text-sol-text-dim transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-1 rounded-md bg-sol-bg-alt/25 border border-sol-border/20 p-3 text-xs text-sol-text-muted overflow-y-auto leading-relaxed prose prose-invert prose-sm max-w-none">
          <ReactMarkdown
            remarkPlugins={entityRemarkPlugins}
            rehypePlugins={MESSAGE_MD_REHYPE}
            components={MESSAGE_MD_COMPONENTS}
          >{content
            .replace(/<command-name>[^<]*<\/command-name>\s*/g, "")
            .replace(/<command-message>[^<]*<\/command-message>\s*/g, "")
            .replace(/^Base directory for this skill:[^\n]*\n?/, "")
            .replace(/<[^>]+>/g, "")
            .trim()}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

export function InterruptStatusLine({ label = "user interrupted", tone = "sky" }: { label?: string; tone?: "sky" | "amber" }) {
  const lineClass = tone === "amber"
    ? "flex-1 h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent"
    : "flex-1 h-px bg-gradient-to-r from-transparent via-sky-400/40 to-transparent";
  const textClass = tone === "amber" ? "text-xs text-amber-500 font-medium" : "text-xs text-sky-400 font-medium";
  return (
    <div className="my-6 flex items-center gap-3">
      <div className={lineClass} />
      <span className={textClass}>{label}</span>
      <div className={lineClass} />
    </div>
  );
}

// A bare nudge ("continue") the human typed to keep the agent moving. It carries
// no ask, so it renders as one slim line instead of a full prompt bubble, and a
// run of the same nudge shows once with its count.
export function NudgeLine({ messageId, text, count, timestamp, userName, avatarUrl }: { messageId: string; text: string; count: number; timestamp: number; userName?: string; avatarUrl?: string | null }) {
  const title = count > 1 ? `${userName ?? "You"} sent "${text}" ${count} times in a row · last at ${formatFullTimestamp(timestamp)}` : `${userName ?? "You"} · ${formatFullTimestamp(timestamp)}`;
  return (
    <div data-cc-message="user" id={`msg-${messageId}`} className="my-3 flex items-center gap-3 scroll-mt-20" title={title}>
      <span className="inline-flex items-center gap-2 pl-1 pr-2.5 py-1 rounded-full border border-sol-border/70 bg-sol-bg-alt/60 text-xs text-sol-text-muted">
        <UserIcon avatarUrl={avatarUrl} size="w-4 h-4" />
        <svg className="w-3 h-3 text-sol-text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14m0 0l-5-5m5 5l-5 5" />
        </svg>
        <span className="font-medium">{text}</span>
        {count > 1 && (
          <span className="ml-0.5 px-1.5 rounded-full bg-sol-blue/15 text-sol-blue text-[11px] font-semibold tabular-nums">×{count}</span>
        )}
      </span>
      <span className="text-[11px] text-sol-text-dim">{formatRelativeTime(timestamp)}</span>
    </div>
  );
}

// One captioned rule for an in-place switch (agent or machine). Clicking
// discloses the notice text the agent was given.
function SwitchDivider({
  caption, fromLabel, content, extra, timestamp,
}: {
  caption: string;
  fromLabel?: string;
  content: string;
  extra?: string;
  timestamp: number;
}) {
  const [open, setOpen] = useState(false);
  const details = [content.trim(), extra?.trim()].filter(Boolean).join("\n\n");
  const hasDetails = details.includes("\n");
  return (
    <div className="my-5">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((o) => !o)}
        className={`w-full ${hasDetails ? "cursor-pointer group" : "cursor-default"}`}
        title={`${formatFullTimestamp(timestamp)}${hasDetails ? " — click for details" : ""}`}
      >
        <TimelineRule color="var(--sol-violet)" label={caption}>
          <span className="flex items-center gap-1.5 text-[11px] text-sol-text-dim group-hover:text-sol-text-muted transition-colors">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
            </svg>
            {caption}
            {fromLabel && <span className="text-sol-text-dim/70">was {fromLabel}</span>}
          </span>
        </TimelineRule>
      </button>
      {open && hasDetails && (
        <div className="mt-2 mx-auto max-w-2xl px-4 py-3 rounded-md border border-sol-border bg-sol-card text-xs text-sol-text-muted whitespace-pre-wrap leading-relaxed">
          {details}
        </div>
      )}
    </div>
  );
}

export function MachineMoveDivider({
  content, destination, fromLabel, machineChanged, extra, timestamp,
}: {
  content: string;
  destination?: string;
  fromLabel?: string;
  machineChanged: boolean;
  extra?: string;
  timestamp: number;
}) {
  const caption = machineChanged
    ? `now running on ${destination ?? "another machine"}`
    : "moved to another directory";
  return (
    <SwitchDivider
      caption={caption}
      fromLabel={fromLabel}
      content={content}
      extra={extra}
      timestamp={timestamp}
    />
  );
}

export function AgentSwitchDivider({
  toLabel, fromLabel, content, timestamp,
}: {
  toLabel: string;
  fromLabel?: string;
  content: string;
  timestamp: number;
}) {
  return (
    <SwitchDivider
      caption={`now using ${toLabel}`}
      fromLabel={fromLabel}
      content={content}
      timestamp={timestamp}
    />
  );
}

// Alarm colour is reserved for outcomes the reader has to act on. A command
// that FAILED is red; one somebody KILLED mid-flight is orange, because the
// work it was doing stopped early. "stopped" is neither: it is the harness
// tidying its books — background watches from a previous process that left no
// completion record, marked closed on the way in. Nothing is wrong and nothing
// is owed, so it wears the same quiet grey as the "monitor ended" line, and the
// unknown-status fallback lands there too rather than crying wolf.
const taskStatusConfig: Record<string, { icon: string; color: string; bg: string; accent: string; eyebrow: string; chip: string }> = {
  completed: { icon: '\u2713', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', accent: 'border-emerald-500/60 bg-emerald-500/5', eyebrow: 'text-emerald-400/70', chip: 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10' },
  killed: { icon: '\u25A0', color: 'text-sol-orange', bg: 'bg-sol-orange/10 border-sol-orange/20', accent: 'border-sol-orange/60 bg-sol-orange/5', eyebrow: 'text-sol-orange/70', chip: 'border-sol-orange/40 text-sol-orange bg-sol-orange/10' },
  failed: { icon: '\u2717', color: 'text-sol-red', bg: 'bg-sol-red/10 border-sol-red/20', accent: 'border-sol-red/60 bg-sol-red/5', eyebrow: 'text-sol-red/70', chip: 'border-sol-red/40 text-sol-red bg-sol-red/10' },
  running: { icon: '\u25B6', color: 'text-sol-blue', bg: 'bg-sol-blue/10 border-sol-blue/20', accent: 'border-sol-blue/60 bg-sol-blue/5', eyebrow: 'text-sol-blue/70', chip: 'border-sol-blue/40 text-sol-blue bg-sol-blue/10' },
  stopped: { icon: '\u25A0', color: 'text-sol-text-dim', bg: 'bg-sol-bg-alt/30 border-sol-border/40', accent: 'border-sol-border/60 bg-sol-bg-alt/30', eyebrow: 'text-sol-text-dim', chip: 'border-sol-border/60 text-sol-text-dim bg-sol-bg-alt/40' },
};

// The statuses whose notification the harness injects as a NEW user turn \u2014 the
// message the reader is looking at is what pulled the agent back to work, and
// the turn below it is the response. Those rows grow the elbow arrow pointing
// at that turn. "stopped" is excluded: those notices are resume-time
// bookkeeping riding a turn that was starting anyway.
const WAKE_STATUSES = new Set(['completed', 'failed', 'killed']);

export function TaskNotificationLine({ content, timestamp, agentNameToChildMap }: { content: string; timestamp: number; agentNameToChildMap?: Record<string, string> }) {
  const parsed = parseTaskNotification(content);
  const router = useRouter();
  if (!parsed) return null;

  // Monitor traffic wears the monitor identity (radar, blue), not the generic
  // task line: an event shows WHAT the watch saw, the stream end reads as the
  // watch quietly folding — both tie back to their MonitorBlock by description.
  if (isMonitorEventNotification(parsed) && parsed.event) {
    const desc = monitorNotificationDescription(parsed);
    return (
      <div data-cc-feed-card className="mb-2 px-3 py-1.5 flex items-start gap-2 text-xs border rounded border-sol-blue/20 bg-sol-blue/5">
        <Radar className="w-3.5 h-3.5 shrink-0 mt-0.5 text-sol-blue/70" />
        <span data-cc-tech className="text-[10px] font-medium tracking-wide uppercase text-sol-blue/70 shrink-0 mt-px">monitor</span>
        <ExpandableLine
          text={decodeEntities(parsed.event)}
          className="text-sol-text-muted"
          title={desc ? `Monitor: ${desc}` : undefined}
        />
        <span className="text-sol-text-dim shrink-0 whitespace-nowrap" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
    );
  }
  if (isMonitorEndedNotification(parsed)) {
    const desc = monitorNotificationDescription(parsed);
    return (
      <div data-cc-feed-card className="mb-2 px-3 py-1.5 flex items-start gap-2 text-xs border rounded border-sol-border/40 bg-sol-bg-alt/30">
        <Radar className="w-3.5 h-3.5 shrink-0 mt-0.5 text-sol-text-dim" />
        <span className="text-[10px] font-medium tracking-wide uppercase text-sol-text-dim shrink-0 mt-px">monitor ended</span>
        {desc && <ExpandableLine text={desc} className="text-sol-text-dim" />}
        <span className="text-sol-text-dim shrink-0 whitespace-nowrap ml-auto" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
    );
  }

  const cfg = taskStatusConfig[parsed.status] || taskStatusConfig.stopped;

  let childId: string | undefined;
  const nameMatch = parsed.summary.match(/['\u201c\u201d"](.*?)['\u201c\u201d"]/);
  const agentName = nameMatch?.[1];
  if (agentName && agentNameToChildMap?.[agentName]) {
    childId = agentNameToChildMap[agentName];
  }

  // The machine sentence split into visual parts (kind eyebrow, prominent
  // description, status chip) \u2014 the unquoted prose notices (orphan cleanup)
  // have no parts and keep the sentence. The wake cue marks the rows whose
  // injection is what pulled the agent back to work.
  const parts = parseNotificationSummary(parsed.summary);
  const woke = WAKE_STATUSES.has(parsed.status);

  if (parts) {
    const chipText = `${parsed.status}${parts.exitCode ? ` \u00b7 exit ${parts.exitCode}` : ''}`;
    return (
      /* Same anatomy as a session-message card (left accent, header line) \u2014
         both are machine deliveries into this thread, so they share one
         visual language. */
      <div
        data-cc-feed-card
        data-status={parsed.status}
        className={`mb-1.5 mx-1 rounded border-l-2 ${cfg.accent}${childId ? " cursor-pointer hover:brightness-125 transition-all" : ""}`}
        onClick={childId ? () => router.push(`/conversation/${childId}`) : undefined}
      >
        <div className="flex items-start gap-2 px-3 py-2 text-xs">
          {woke ? (
            /* The wake cue takes the status glyph's slot: a corner arrow
               pointing down and into the row below \u2014 the turn this
               notification pulled the agent back for. The status itself still
               reads from the chip on the right. */
            <CornerDownRight
              className={`w-3.5 h-3.5 shrink-0 mt-px ${cfg.color}`}
              strokeWidth={2.25}
              aria-label="Woke the agent"
            />
          ) : (
            <span className={`font-mono text-sm leading-none shrink-0 mt-0.5 ${cfg.color}`}>{cfg.icon}</span>
          )}
          <span data-cc-tech className={`text-[10px] font-medium tracking-wide uppercase shrink-0 mt-px ${cfg.eyebrow}`}>{parts.kind}</span>
          <ExpandableLine text={parts.description} className="text-sol-text font-medium" title={parsed.summary} />
          <span className={`px-1 py-0 rounded border text-[9px] font-semibold shrink-0 mt-px ${cfg.chip}`}>{chipText}</span>
          {childId && (
            <svg className={`w-3 h-3 shrink-0 mt-0.5 ${cfg.color}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          )}
          <span data-cc-tech className="text-sol-text-dim font-mono text-[10px] shrink-0">{parsed.taskId}</span>
          <span className="text-sol-text-dim shrink-0 whitespace-nowrap" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-cc-feed-card
      data-status={parsed.status}
      className={`mb-2 px-3 py-2 flex items-start gap-2.5 text-xs border rounded ${cfg.bg}${childId ? " cursor-pointer hover:brightness-125 transition-all" : ""}`}
      onClick={childId ? () => router.push(`/conversation/${childId}`) : undefined}
    >
      <span className={`font-mono text-sm leading-none shrink-0 mt-0.5 ${cfg.color}`}>{cfg.icon}</span>
      <ExpandableLine text={parsed.summary} className="text-sol-text-muted" />
      {childId && (
        <svg className={`w-3 h-3 shrink-0 mt-0.5 ${cfg.color}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      )}
      {/* A batch notice names its tasks inside the summary itself, so pinning
          one id on the row would read as if the rest weren't there. */}
      {!isOrphanSummaryNotification(parsed) && (
        <span data-cc-tech className="text-sol-text-dim font-mono text-[10px] shrink-0">{parsed.taskId}</span>
      )}
      <span className="text-sol-text-dim shrink-0 whitespace-nowrap" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
    </div>
  );
}

// Renders BOTH scheduled-run delivery formats: the `<scheduled-task>` wrapper an
// inject-type schedule drops into an existing conversation, and the plain-text
// prompt header (taskScheduler.buildPrompt) that opens a spawned run's transcript.
// Same block so the two paths read identically; the spawned format additionally
// carries mode, prior-run outcome, and completion-protocol boilerplate (collapsed —
// it's machine plumbing, not something the user should wade through).
export function ScheduledTaskBlock({ content: rawContent, timestamp }: { content: string; timestamp: number }) {
  const [showPlumbing, setShowPlumbing] = useState(false);
  const content = rawContent.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const spawned = parseSpawnedTaskPrompt(content);
  const match = spawned ? null : content.match(/<scheduled-task\s+title="([^"]*)"(?:\s+task-id="([^"]*)")?[^>]*>([\s\S]*?)<\/scheduled-task>/);
  const title = spawned?.title || match?.[1]?.replace(/&quot;/g, '"') || "Trigger Run";
  const prompt = spawned?.prompt ?? (match?.[3]?.trim() || cleanStickyContent(content));
  const prevFailed = !!spawned?.previousRun && /^Failed/i.test(spawned.previousRun.summary);

  return (
    <div className="mb-2 mx-1 rounded border-l-2 border-sol-violet/60 bg-sol-violet/5">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <Zap className="w-3.5 h-3.5 text-sol-violet/70 shrink-0" />
        <span className="text-[11px] font-medium tracking-wide uppercase text-sol-violet/70 shrink-0">{spawned ? "Trigger run" : "Trigger"}</span>
        {/* Apply is the norm and unmarked; read-only runs get the chip. */}
        {spawned && spawned.mode !== "apply" && (
          <ShortcutTooltip label="Read-only run — investigates and reports, changes nothing" hint="file-editing tools are disabled">
            <span className="px-1 py-0 rounded border text-[9px] font-semibold shrink-0 border-sol-cyan/40 text-sol-cyan/90 bg-sol-cyan/10">
              read-only
            </span>
          </ShortcutTooltip>
        )}
        <span className="text-xs text-sol-text-muted truncate">{title}</span>
        <span className="text-[10px] text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
      {/* The prompt is authored markdown in both wire formats (spawn header
          and <scheduled-task> inject) — render it as prose either way. A trigger
          briefing is often long, so it starts clipped behind an Expand. */}
      <CollapsibleBody className="px-3 pb-2" toggleClassName="mt-1">
        <div className="text-sm text-sol-text prose prose-invert prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={MD_COMPONENTS_NO_IMG}>{prompt}</ReactMarkdown>
        </div>
      </CollapsibleBody>
      {spawned?.contextSummary && (
        <div className="mx-3 mb-2 rounded border border-sol-border/30 bg-sol-bg/40 px-2 py-1.5 text-[11px] leading-relaxed text-sol-text-muted">
          <span className="font-medium text-sol-text-dim">Context from originating session: </span>
          {spawned.contextSummary}
        </div>
      )}
      {spawned?.previousRun && (
        <div className={`mx-3 mb-2 rounded border px-2 py-1.5 text-[11px] leading-relaxed ${prevFailed ? "border-sol-red/30 bg-sol-red/5 text-sol-red/90" : "border-sol-border/30 bg-sol-bg/40 text-sol-text-muted"}`}>
          <span className={`font-medium ${prevFailed ? "text-sol-red" : "text-sol-text-dim"}`}>Previous run ({spawned.previousRun.ago}): </span>
          {spawned.previousRun.summary}
        </div>
      )}
      {spawned?.instructions && (
        <div className="px-3 pb-2">
          <button
            onClick={() => setShowPlumbing(!showPlumbing)}
            className="flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-text-muted transition-colors"
          >
            {showPlumbing ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
            run instructions
          </button>
          {showPlumbing && (
            <pre className="mt-1 whitespace-pre-wrap break-words rounded border border-sol-border/30 bg-sol-bg/60 p-2 text-[10px] leading-relaxed text-sol-text-dim font-mono">{spawned.instructions}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// The /loop heartbeat, in the trigger family's visual language. A
// ScheduleWakeup call is the agent arming its own next fire — standing intent,
// same anatomy as the trigger blocks above (violet accent, Zap identity) so a
// self-pacing loop reads as what it is instead of a raw tool row. stop:true is
// the loop's deliberate end. The tool result adds nothing the input doesn't
// already say (the fire time), so it only surfaces on error.
export function ScheduleWakeupBlock({ tool, result, timestamp }: { tool: ToolCall; result?: ToolResult; timestamp: number }) {
  const [showPrompt, setShowPrompt] = useState(false);
  let input: { delaySeconds?: number; reason?: string; prompt?: string; stop?: boolean } = {};
  try {
    input = JSON.parse(tool.input || "{}");
  } catch { /* malformed input renders as an empty arm */ }

  if (input.stop) {
    return (
      <div className="mb-2 mx-1 rounded border-l-2 border-sol-violet/40 bg-sol-violet/5">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <Zap className="w-3.5 h-3.5 text-sol-violet/50 shrink-0" />
          <span className="text-[11px] font-medium tracking-wide uppercase text-sol-violet/60 shrink-0">Loop ended</span>
          <span className="text-xs text-sol-text-muted truncate">the agent stopped scheduling wakeups</span>
          <span className="text-[10px] text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
        </div>
      </div>
    );
  }

  const delayMs = Math.max(0, (input.delaySeconds ?? 0) * 1000);
  const wakeAt = timestamp + delayMs;
  return (
    <div className="mb-2 mx-1 rounded border-l-2 border-sol-violet/60 bg-sol-violet/5">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <Zap className="w-3.5 h-3.5 text-sol-violet/70 shrink-0" />
        <span className="text-[11px] font-medium tracking-wide uppercase text-sol-violet/70 shrink-0">Wakeup</span>
        {delayMs > 0 && (
          <ShortcutTooltip label={`Fires at ${fmtClock(wakeAt)}`}>
            <span className="px-1 py-0 rounded border text-[9px] font-semibold shrink-0 tabular-nums border-sol-violet/40 text-sol-violet/90 bg-sol-violet/10">
              in {fmtDuration(delayMs)}
            </span>
          </ShortcutTooltip>
        )}
        {input.reason && <span className="text-xs text-sol-text-muted truncate">{input.reason}</span>}
        <span className="text-[10px] text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
      {result?.is_error && (
        <div className="mx-3 mb-2 rounded border border-sol-red/30 bg-sol-red/5 px-2 py-1.5 text-[11px] leading-relaxed text-sol-red/90">
          {result.content.slice(0, 300)}
        </div>
      )}
      {input.prompt && (
        <div className="px-3 pb-2">
          <button
            onClick={() => setShowPrompt(!showPrompt)}
            className="flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-text-muted transition-colors"
          >
            {showPrompt ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
            wakeup prompt
          </button>
          {showPrompt && <TriggerPromptView prompt={input.prompt} className="mt-1" />}
        </div>
      )}
    </div>
  );
}

export function SessionMessageBlock({ from, name, body, timestamp, pendingStatus, pendingReason, recipientConversationId, variant = "session", color, summary, linkToConversationId }: { from: string; name?: string; body: string; timestamp?: number; pendingStatus?: string; pendingReason?: string; recipientConversationId?: string; variant?: "session" | "teammate" | "agent"; color?: string; summary?: string; linkToConversationId?: string }) {
  const s = useTrackedStore([
    st => pendingStatus && recipientConversationId ? st.sessions[recipientConversationId]?.agent_status : undefined,
  ]);
  const recipientStatus = recipientConversationId ? s.sessions[recipientConversationId]?.agent_status : undefined;
  const isPending = !!pendingStatus;
  const queueLabel = sessionMessageQueueLabel(pendingStatus, pendingReason, recipientStatus);
  // The SAME card renders an inter-agent teammate broadcast and a subagent's report to the
  // session that launched it — only slightly distinct: a Users icon + "From teammate" + the
  // sender's own color, or a Bot icon + "Report from" + violet, vs. cast send's
  // CornerDownRight + "Message from" + fixed cyan. Neither a teammate id nor a subagent name
  // is a real session, so both render as a plain badge (not an EntityIdPill) that clicks
  // through when the sender resolves to a conversation. A teammate's summary attribute rides
  // in the header as a secondary label.
  const isTeammate = variant === "teammate";
  const isAgentReport = variant === "agent";
  const namedSender = isTeammate || isAgentReport;
  const HeaderIcon = isTeammate ? Users : isAgentReport ? Bot : CornerDownRight;
  const badgeColor = isAgentReport
    ? agentColorMap.purple
    : agentColorMap[color || "blue"] || agentColorMap.blue;
  const accent = isPending
    ? "border-amber-500/50 bg-amber-500/5"
    : isTeammate
    ? `${agentBorderMap[color || "blue"] || agentBorderMap.blue} bg-sol-bg-alt/30`
    : isAgentReport
    ? "border-sol-violet/60 bg-sol-violet/5"
    : "border-sol-cyan/60 bg-sol-cyan/5";
  const labelText = isPending ? "text-amber-400/80" : isTeammate ? "text-sol-text-dim/70" : isAgentReport ? "text-sol-violet/70" : "text-sol-cyan/70";
  const iconText = isPending ? "text-amber-400/70" : isTeammate ? "text-sol-text-dim/60" : isAgentReport ? "text-sol-violet/70" : "text-sol-cyan/70";
  // Where the message was WRITTEN. A named sender carries its conversation on
  // linkToConversationId; a `cast send` names its sender by short id, which the
  // server resolves. Either way the jump lands on the turn that ran the send,
  // not at the tail of the sender's thread — see useJumpToSendingMessage.
  const senderRef = linkToConversationId ?? (!namedSender && from && from !== "unknown" ? from : undefined);
  const jumpToSendingMessage = useJumpToSendingMessage(senderRef, timestamp, body);
  const linkText = isPending
    ? "text-amber-400"
    : isTeammate
    ? agentTextMap[color || "blue"] || agentTextMap.blue
    : isAgentReport
    ? "text-sol-violet"
    : "text-sol-cyan";
  return (
    <div className={`mb-2 mx-1 rounded border-l-2 ${accent}`}>
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <HeaderIcon className={`w-3.5 h-3.5 shrink-0 ${iconText}`} />
        <span className={`text-[11px] font-medium tracking-wide uppercase shrink-0 ${labelText}`}>{isTeammate ? "From teammate" : isAgentReport ? "Report from" : "Message from"}</span>
        {namedSender ? (
          // A teammate id or a subagent name isn't a session id, so it can't be an
          // EntityIdPill — but when the sender is resolvable (team-lead → this
          // conversation's spawned_by parent, a subagent name → its child conversation)
          // the badge clicks through to that session.
          linkToConversationId ? (
            <button
              onClick={() => { void jumpToSendingMessage(); }}
              className={`px-1.5 py-0.5 rounded border text-[10px] font-mono shrink-0 cursor-pointer hover:underline underline-offset-2 ${badgeColor}`}
              title="Open the sender's session at the message that sent this"
            >
              {from}
            </button>
          ) : (
            <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono shrink-0 ${badgeColor}`}>{from}</span>
          )
        ) : from && from !== "unknown" ? (
          <EntityIdPill shortId={from} />
        ) : name ? (
          <span className="text-xs font-medium text-sol-cyan/90">{name}</span>
        ) : (
          <span className="text-xs text-sol-text-muted">another session</span>
        )}
        {/* The sender's identity says WHO wrote this; this says WHERE. Naming a
            session alone lands a reader at its tail, which is almost never the
            moment the message was written — so the card offers the turn itself,
            plainly, rather than hiding it behind the badge. */}
        {senderRef && (
          <button
            onClick={() => { void jumpToSendingMessage(); }}
            className={`inline-flex items-center gap-0.5 text-[11px] font-medium shrink-0 underline underline-offset-2 decoration-dotted hover:decoration-solid ${linkText}`}
            title="Open the sender's session at the message that sent this"
          >
            <ArrowUpRight className="w-3 h-3" />
            Open the sending message
          </button>
        )}
        {isTeammate && summary && (
          <span className="text-[10px] uppercase tracking-wider font-medium text-sol-text-dim/50 truncate">{summary}</span>
        )}
        {queueLabel && (
          <span className="inline-flex items-center gap-1 text-[10px] font-mono text-amber-400 bg-amber-500/15 border border-amber-500/25 rounded px-1.5 py-0.5 shrink-0">
            <Clock className="w-2.5 h-2.5" />{queueLabel}
          </span>
        )}
        {/* A queued message renders at the tail of the transcript, below turns
            that arrived after it, because it has not entered the thread yet —
            it is still waiting to be delivered. Its time is therefore how long
            it has waited, not where it belongs, and saying so is what stops
            the row reading as history that jumped out of order. */}
        {timestamp != null && timestamp > 0 && (
          <span className="text-[10px] text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{isPending ? `waiting ${formatRelativeTime(timestamp)}` : formatRelativeTime(timestamp)}</span>
        )}
      </div>
      {/* A message from another session is someone else's context, not this
          thread's — it starts clipped so a long handoff doesn't bury the reply. */}
      <CollapsibleBody className="px-3 pb-2" toggleClassName="mt-1">
        <div className={`text-sm text-sol-text prose prose-invert prose-sm max-w-none ${isPending ? "opacity-70" : ""}`}>
          {/* The header just named the sender, so its mentions in the body are
              repeats and render as the short name. */}
          <EstablishedRefsProvider ids={[namedSender ? null : from]}>
            <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE}
              components={MESSAGE_MD_COMPONENTS}
            >{body}</ReactMarkdown>
          </EstablishedRefsProvider>
        </div>
      </CollapsibleBody>
    </div>
  );
}

// ── Team chat: the anchor's inbound wake and its outbound reply ─────────────
// A mention in team chat wakes the anchor session with a plain-text prompt
// (convex/chat.ts buildAnchorWake): the channel, who asked, the quoted thread,
// and the `cast chat reply` it should run. The transcript shows the exchange
// the way chat does — a channel pill, the thread's lines by speaker — and hides
// the framing that exists only to brief the agent.

// Where a chat card clicks through: the channel, positioned on a message when
// one is known. Mirrors convex/chatText.ts chatPermalink.
export function chatHref(channelId?: string, messageId?: string): string | null {
  if (!channelId) return null;
  return messageId ? `/chat/${channelId}?m=${messageId}` : `/chat/${channelId}`;
}

export function ChatChannelPill({ name, href }: { name: string; href: string | null }) {
  const cls = "inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-sol-magenta/30 bg-sol-magenta/10 text-sol-magenta text-[11px] font-mono shrink-0";
  const inner = <><Hash className="w-3 h-3" />{name}</>;
  return href ? (
    <Link href={href} className={`${cls} hover:bg-sol-magenta/20 hover:underline underline-offset-2`} title="Open in team chat">{inner}</Link>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

// A huddle that ended in this session's room. The same turn woke the agent
// with the summary and the `cast call` pointer; this renders it the way the
// human should read it — the digest, and the transcript unfoldable under it.
export function HuddleSummaryBlock({ huddle, timestamp }: { huddle: HuddleSummaryTag; timestamp?: number }) {
  // The header already names the call and who was on it; drop the digest's own
  // lead line so the card doesn't say it twice.
  const body = huddle.body.replace(/^\*\*[^\n]*\n+/, "");
  return (
    <div className="mb-2 mx-1 rounded border-l-2 border-sol-green/60 bg-sol-green/5">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 flex-wrap">
        <PhoneCall className="w-3.5 h-3.5 shrink-0 text-sol-green/70" />
        <span className="text-[11px] font-medium tracking-wide uppercase shrink-0 text-sol-green/70">Huddle</span>
        <span className="text-xs font-medium text-sol-text truncate">{huddle.title}</span>
        <span className="text-[11px] text-sol-text-dim truncate">
          {huddle.minutes > 0 ? `${huddle.minutes} min` : ""}
          {huddle.minutes > 0 && huddle.speakers.length > 0 ? " · " : ""}
          {huddle.speakers.join(", ")}
        </span>
        {timestamp != null && timestamp > 0 && (
          <span className="text-[10px] text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
        )}
      </div>
      <CollapsibleBody className="px-3" toggleClassName="mt-1">
        <div className="text-sm text-sol-text prose prose-invert prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE}
            components={MESSAGE_MD_COMPONENTS}
          >{body}</ReactMarkdown>
        </div>
      </CollapsibleBody>
      <CallTranscriptDisclosure transcriptId={huddle.transcriptId} className="px-3 pb-2 pt-1" />
    </div>
  );
}

export function ChatWakeBlock({ wake, timestamp }: { wake: ChatWakePrompt; timestamp?: number }) {
  // Land on the thread. A permalink to a REPLY opens the thread panel; the root
  // alone would only scroll the channel — so prefer the anchor's placeholder,
  // which is always a reply, and fall back to the root.
  const href = chatHref(wake.channelId, wake.placeholderId ?? wake.threadRootId);
  return (
    <div className="mb-2 mx-1 rounded border-l-2 border-sol-magenta/60 bg-sol-magenta/5">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 flex-wrap">
        <MessageSquare className="w-3.5 h-3.5 shrink-0 text-sol-magenta/70" />
        <span className="text-[11px] font-medium tracking-wide uppercase shrink-0 text-sol-magenta/70">Team chat</span>
        <ChatChannelPill name={wake.channelName} href={href} />
        <span className="text-xs text-sol-text-muted truncate">
          <span className="text-sol-text font-medium">{wake.askerName}</span>
          {wake.addressed ? " mentioned you" : " replied in a thread"}
        </span>
        {timestamp != null && timestamp > 0 && (
          <span className="text-[10px] text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
        )}
      </div>
      <CollapsibleBody className="px-3 pb-2" toggleClassName="mt-1">
        <div className="space-y-1.5">
          {wake.entries.map((entry, i) => (
            <div key={i} className="flex gap-2 text-sm">
              <span className={`shrink-0 font-medium ${entry.self ? "text-sol-magenta/80" : "text-sol-text"}`}>
                {entry.self ? "You" : entry.name}
              </span>
              <div className="min-w-0 text-sol-text prose prose-invert prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE}
                  components={MESSAGE_MD_COMPONENTS}
                >{entry.content}</ReactMarkdown>
              </div>
            </div>
          ))}
          {wake.entries.length === 0 && (
            <span className="text-xs text-sol-text-dim italic">thread excerpt not available</span>
          )}
        </div>
      </CollapsibleBody>
    </div>
  );
}

export function TeammateEventsBlock({ content, timestamp, spawnedByConversationId, agentNameToChildMap }: { content: string; timestamp: number; spawnedByConversationId?: string; agentNameToChildMap?: Record<string, string> }) {
  const parts = parseTeammateMessages(content);
  return (
    <div className="my-1 space-y-1">
      {parts.map((part, i) => {
        if (part.type === 'teammate') {
          return <TeammateMessageCard key={i} teammateId={part.teammateId} color={part.color} summary={part.summary} content={part.content} timestamp={timestamp} spawnedByConversationId={spawnedByConversationId} agentNameToChildMap={agentNameToChildMap} />;
        }
        // Drop the harness's framing boilerplate ("Another Claude session sent a
        // message:" / the "permission laundering" disclaimer) — it's machine instruction
        // to the receiving agent, not content. Keep any genuinely incidental prose.
        const text = part.content.trim();
        if (!text || isTeammateFramingOnly(text)) return null;
        return <span key={i} className="text-xs text-sol-text-dim whitespace-pre-wrap">{part.content}</span>;
      })}
    </div>
  );
}

export function TeammateMessageCard({ teammateId, color, summary, content, timestamp, spawnedByConversationId, agentNameToChildMap }: { teammateId: string; color?: string; summary?: string; content: string; timestamp?: number; spawnedByConversationId?: string; agentNameToChildMap?: Record<string, string> }) {
  const safeContent = content || '';
  let parsed: any = null;
  try { if (safeContent) parsed = JSON.parse(safeContent); } catch {}

  if (parsed?.type === "idle_notification") {
    const idleSummary = parsed.summary;
    if (idleSummary) {
      return (
        <div className="py-1.5 px-2.5 text-xs rounded bg-sol-bg-alt/30 border border-sol-border/10">
          <div className="flex items-center gap-2 mb-1">
            <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${agentColorMap[color || "blue"] || agentColorMap.blue}`}>
              {teammateId}
            </span>
            <svg className="w-2.5 h-2.5 text-sol-text-dim/40 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-[10px] uppercase tracking-wider text-sol-text-dim/60 font-medium">idle</span>
          </div>
          <div className="text-sol-text-dim leading-relaxed whitespace-pre-line">
            <FormattedSummary text={idleSummary} />
          </div>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 py-0.5 px-2 text-xs text-sol-text-dim opacity-40">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${agentColorMap[color || "blue"] || agentColorMap.blue}`}>
          {teammateId}
        </span>
        <span className="italic">idle</span>
      </div>
    );
  }

  if (parsed?.type === "task_assignment") {
    const badgeColor = agentColorMap[color || "blue"] || agentColorMap.blue;
    return (
      <div className="flex items-center gap-2 py-1.5 px-2.5 rounded-md bg-sol-bg-alt/50 border border-sol-border/20">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono shrink-0 ${badgeColor}`}>
          {parsed.assignedBy || teammateId}
        </span>
        <svg className="w-3 h-3 text-sol-text-dim/40 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
        </svg>
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-sol-bg-highlight border border-sol-border/30 text-sol-text-secondary shrink-0">
          #{parsed.taskId}
        </span>
        <span className="text-xs text-sol-text-secondary truncate">{parsed.subject}</span>
      </div>
    );
  }

  if (parsed?.type === "shutdown_request" || parsed?.type === "shutdown_approved") {
    const isApproved = parsed.type === "shutdown_approved";
    return (
      <div className="flex items-center gap-2 py-1.5 px-2.5 rounded-md bg-red-500/5 border border-red-500/15">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono shrink-0 ${agentColorMap[color || "red"] || agentColorMap.red}`}>
          {parsed.from || teammateId}
        </span>
        <svg className="w-3 h-3 text-red-400/60 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" />
        </svg>
        <span className="text-xs text-red-400/80 font-medium">{isApproved ? "shutdown approved" : "shutdown request"}</span>
      </div>
    );
  }

  if (parsed?.type === "teammate_terminated") {
    return (
      <div className="flex items-center gap-2 py-1.5 px-2.5 rounded-md bg-sol-bg-alt/30 border border-sol-border/15">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono shrink-0 ${agentColorMap[color || "blue"] || agentColorMap.blue}`}>
          {teammateId}
        </span>
        <svg className="w-3 h-3 text-sol-text-dim/40 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
        </svg>
        <span className="text-xs text-sol-text-dim">{parsed.message || "terminated"}</span>
      </div>
    );
  }

  // A substantive teammate broadcast reuses the cast-send card (SessionMessageBlock) via its
  // teammate variant — the same format and code, only slightly distinct.
  return (
    // Both directions resolve: the lead a worker reports to is this session's
    // spawned_by parent, and a sibling worker's name is in the team's roster.
    <SessionMessageBlock variant="teammate" from={teammateId} color={color} summary={summary} body={content} timestamp={timestamp} linkToConversationId={teammateId === "team-lead" ? spawnedByConversationId : agentNameToChildMap?.[teammateId]} />
  );
}

function ToolResultMessage({ toolResults, toolName }: { toolResults: ToolResult[]; toolName?: string }) {
  // Don't render separate result messages - results are shown inline with tool calls
  // This component was showing duplicate content with the 1→ line number format
  return null;
}

function SystemBlockImpl({ content, subtype, timestamp, messageUuid, messageId, conversationId, onOpenComments, onStartShareSelection }: { content: string; subtype?: string; timestamp?: number; messageUuid?: string; messageId?: string; conversationId?: Id<"conversations">; onOpenComments?: (messageId: string) => void; onStartShareSelection?: (messageId: string) => void }) {
  if (isHiddenSystemNotice(content, subtype)) return null;

  if (subtype === "compact_boundary") {
    return (
      <div className="my-6 flex items-center gap-3">
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent" />
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/30">
          <svg className="w-3.5 h-3.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          <span className="text-xs text-amber-500 font-medium">Context compacted</span>
        </div>
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent" />
      </div>
    );
  }

  if (subtype === "scheduled_task_prompt" && content) {
    return <ScheduledTaskBlock content={content} timestamp={timestamp || Date.now()} />;
  }

  // A /loop wakeup firing ("Claude resuming /loop wakeup (Jul 29 5:07pm)") —
  // the harness-side twin of a trigger injection, so it wears the same violet
  // trigger anatomy as ScheduledTaskBlock/ScheduleWakeupBlock instead of the
  // generic gray system row.
  if (subtype === "scheduled_task_fire" && content) {
    return (
      <div className="mb-2 mx-1 rounded border-l-2 border-sol-violet/60 bg-sol-violet/5">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <Zap className="w-3.5 h-3.5 text-sol-violet/70 shrink-0" />
          <span className="text-[11px] font-medium tracking-wide uppercase text-sol-violet/70 shrink-0">Wakeup fired</span>
          <span className="text-xs text-sol-text-muted truncate">{stripAnsiCodes(content)}</span>
          {timestamp && (
            <span className="text-[10px] text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
          )}
        </div>
      </div>
    );
  }

  if (subtype === "compaction_summary" && content) {
    return <CompactionSummaryBlock content={content} />;
  }

  if (subtype === "plan" && content) {
    return <PlanBlock content={content} timestamp={timestamp || Date.now()} messageId={messageId} conversationId={conversationId} onOpenComments={onOpenComments} onStartShareSelection={onStartShareSelection} />;
  }

  if (subtype === "pull_request" && content) {
    const prMatch = content.match(/^#(\d+)\s+(.*)/);
    const prNum = prMatch ? prMatch[1] : "";
    const prTitle = prMatch ? prMatch[2] : content;
    return (
      <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-sol-violet/5 border border-sol-violet/20 rounded text-xs">
        <svg className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
        {prNum && <span className="text-sol-violet font-mono font-medium">#{prNum}</span>}
        <span className="text-sol-text-secondary truncate">{prTitle}</span>
        {timestamp && <span className="text-sol-text-dim ml-auto flex-shrink-0">{formatRelativeTime(timestamp)}</span>}
      </div>
    );
  }

  if (subtype === "commit" && content) {
    const sha = messageUuid?.slice(0, 7) || "";
    return (
      <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-emerald-500/5 border border-emerald-500/20 rounded text-xs">
        <svg className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m0 0l4-4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
        {sha && <span className="text-emerald-500 font-mono font-medium">{sha}</span>}
        <span className="text-sol-text-secondary truncate">{content}</span>
        {timestamp && <span className="text-sol-text-dim ml-auto flex-shrink-0">{formatRelativeTime(timestamp)}</span>}
      </div>
    );
  }

  if ((subtype === "stop_hook_summary" || subtype === "local_command") && content) {
    if (subtype === "local_command") {
      const cmdName = content.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.replace(/^\//, "")
        || content.match(/<command-message>([^<]*)<\/command-message>/)?.[1]?.replace(/^\//, "");
      const stdout = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)?.[1]?.trim();
      const stderr = content.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/)?.[1]?.trim();
      const output = stripAnsiCodes(stdout || stderr || "");
      return (
        <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-sol-bg-alt/30 border-l-2 border-sol-cyan/30 text-xs">
          <svg className="w-3 h-3 text-sol-cyan/60 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <polyline points="4 17 10 11 4 5" />
          </svg>
          {cmdName && <span className="font-mono text-sol-cyan/80 font-medium">/{cmdName}</span>}
          {output && <span className="text-sol-text-muted font-mono truncate">{output.slice(0, 150)}</span>}
          {!cmdName && !output && <span className="text-sol-text-dim font-mono truncate">{stripAnsiCodes(content.replace(/<[^>]+>/g, "")).slice(0, 150)}</span>}
        </div>
      );
    }
    const trimmed = stripAnsiCodes(content).slice(0, 200);
    return (
      <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-sol-bg-alt/30 border-l-2 border-sol-border text-xs">
        <span className="text-[10px] text-sol-text-dim bg-sol-bg-highlight px-1.5 py-0.5 rounded font-mono">hook</span>
        <span className="text-sol-text-muted font-mono truncate">{trimmed}</span>
      </div>
    );
  }

  if (subtype === "away_summary" && content) {
    const text = stripAnsiCodes(content).trim();
    return (
      <div className="my-2 rounded-lg bg-sol-bg-alt/40 border border-sol-border/40 px-4 py-3">
        <div className="flex items-center gap-1.5 mb-2">
          <svg className="w-3 h-3 text-sol-text-dim/50 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
          </svg>
          <span className="text-[10px] uppercase tracking-wider font-medium text-sol-text-dim/60">away summary</span>
        </div>
        <div className="text-[13px] text-sol-text-secondary break-words leading-relaxed whitespace-pre-line">
          <FormattedSummary text={text} />
        </div>
      </div>
    );
  }

  const cleanText = stripAnsiCodes(content.replace(/<[^>]+>/g, "")).slice(0, 200);
  if (!cleanText) return null;

  // Usage-limit notices share the amber warning tone of ApiErrorCard's limit
  // banner; every other status line keeps the neutral system gray.
  const warning = isWarningSystemNotice(content, subtype);
  return (
    <div className={`mb-4 px-3 py-2 border-l-2 text-xs ${warning ? "bg-amber-500/10 border-amber-500/40" : "bg-sol-bg-alt/20 border-sol-border"}`}>
      {subtype && (
        <span className={`text-[10px] mr-2 ${warning ? "text-amber-500" : "text-sol-text-dim"}`}>
          {warning ? "warning" : subtype.replace(/_/g, " ")}
        </span>
      )}
      <span className={`font-mono ${warning ? "text-amber-500" : "text-sol-text-muted"}`}>
        {cleanText}
        {content.length > 200 && "..."}
      </span>
    </div>
  );
}

// Inline conversation card for a dynamic-workflow run. Reads live run state by id
// (posted once as an anchor message), so it updates as the run progresses.
function DynamicRunCard({ runId, name }: { runId?: string; name?: string }) {
  const run = useWorkflowRun(runId);
  const status = run?.status as string | undefined;
  const sm = wfStatusMeta(status);
  return (
    <div data-cc-feed-card className="my-2 rounded-lg border border-sol-cyan/25 bg-sol-cyan/[0.06] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-sol-cyan/15">
        <Workflow className="w-3.5 h-3.5 text-sol-cyan flex-shrink-0" />
        <span data-cc-tech className="text-[10px] text-sol-cyan uppercase tracking-wider font-semibold">Workflow</span>
        <span className="text-xs text-sol-text-muted truncate">{run?.workflow_name || name || "workflow"}</span>
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          {run?.agent_count != null && <span data-cc-tech className="text-[10px] text-sol-text-dim">{run.agent_count} agents</span>}
          {run?.total_tokens ? <span data-cc-tech className="text-[10px] text-sol-text-dim/70">{wfFmtTokens(run.total_tokens)} tok</span> : null}
          {status && (
            <span className={`text-[10px] flex items-center gap-1 ${sm.cls}`}>
              {sm.dot ? <span className={`w-1.5 h-1.5 rounded-full ${sm.dot}`} /> : sm.icon}
              {status}
            </span>
          )}
        </div>
      </div>
      <div className="px-3 py-2">
        {run ? <DynamicRunView run={run} compact /> : <span className="text-[11px] text-sol-text-dim">loading run…</span>}
      </div>
    </div>
  );
}

export function WorkflowEventBlock({ content, workflowRun, onGateChoice, gateResponding }: {
  content: string;
  workflowRun?: { _id: string; status: string; gate_response?: string | null } | null;
  onGateChoice?: (key: string) => void;
  gateResponding?: boolean;
}) {
  let event: Record<string, any> = {};
  try { event = JSON.parse(content); } catch { return null; }

  const wf = event.__wf as string;

  if (wf === "started") {
    return (
      <div className="my-2 flex items-center gap-2.5 px-3 py-2 rounded-lg bg-sol-violet/10 border border-sol-violet/25 text-xs">
        <svg className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span className="text-sol-text-muted">Workflow started</span>
        {event.goal && <span className="text-sol-text-dim truncate">— {event.goal}</span>}
      </div>
    );
  }

  if (wf === "node_start" || wf === "node_done" || wf === "node_failed") {
    const label = event.node_label || event.node_id;
    const nodeType = event.node_type || "agent";
    const isDone = wf === "node_done";
    const isFailed = wf === "node_failed";
    const isRunning = wf === "node_start";

    const typeColors: Record<string, { bg: string; border: string; text: string }> = {
      agent:   { bg: "bg-sol-green/20", border: "border-sol-green/50", text: "text-sol-green" },
      command: { bg: "bg-sol-yellow/20", border: "border-sol-yellow/50", text: "text-sol-yellow" },
      human:   { bg: "bg-sol-magenta/20", border: "border-sol-magenta/50", text: "text-sol-magenta" },
      prompt:  { bg: "bg-sol-violet/20", border: "border-sol-violet/50", text: "text-sol-violet" },
    };
    const tc = typeColors[nodeType] || typeColors.agent;

    return (
      <div className="my-0.5">
        <div className="flex items-center gap-1.5 text-xs">
          {isDone && <span className="text-emerald-400 text-[10px]">{"\u2713"}</span>}
          {isFailed && <span className="text-sol-red text-[10px]">{"\u2717"}</span>}
          {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse flex-shrink-0" />}
          <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${tc.bg} border ${tc.border} ${tc.text}`}>
            {nodeType}
          </span>
          <span className={`text-xs ${isFailed ? "text-sol-red/80" : "text-sol-text-muted"}`}>{label}</span>
          {isRunning && <span className="text-sol-text-dim/50 text-[10px]">running…</span>}
          {event.session_id && isDone && (
            <Link
              href={`/conversation/${event.session_id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-sol-cyan hover:text-sol-cyan text-[10px] font-medium underline underline-offset-2"
            >
              view
            </Link>
          )}
        </div>
      </div>
    );
  }

  if (wf === "workflow_run") {
    return <DynamicRunCard runId={event.run_id} name={event.name} />;
  }

  if (wf === "gate") {
    const choices = event.choices as Array<{ key: string; label: string; target: string }> | undefined;
    const isResolved = !workflowRun || workflowRun.status !== "paused";
    // A gate IS a decision (the-line.md L4): the message carries the
    // session_decisions id, and the card renders that row with the same
    // answer path every other surface uses. The choice buttons below stay
    // only for a gate posted before decisions existed (no decision id).
    if (typeof event.decision_id === "string" && event.decision_id) {
      return <GateDecisionBlock decisionId={event.decision_id} shortId={event.decision_short_id} prompt={event.prompt} resolved={isResolved} />;
    }
    return (
      <div className="my-3 rounded-lg border border-sol-magenta/40 bg-sol-magenta/8 overflow-hidden">
        <div className="px-3 py-2 border-b border-sol-magenta/20 flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-sol-magenta flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-[10px] text-sol-magenta uppercase tracking-wider font-semibold">Human Gate</span>
          {isResolved
            ? <span className="ml-auto text-[10px] text-sol-green">responded</span>
            : <span className="ml-auto text-[10px] text-sol-magenta/70 animate-pulse">waiting…</span>
          }
        </div>
        <div className="px-3 py-2.5">
          <p className="text-sm text-sol-text">{event.prompt}</p>
          {!isResolved && choices && choices.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {choices.map(choice => (
                <button
                  key={choice.key}
                  onClick={() => onGateChoice?.(choice.key)}
                  disabled={gateResponding}
                  className="px-2 py-0.5 text-xs font-medium text-sol-text border border-sol-border/30 rounded hover:bg-sol-bg-highlight hover:border-sol-magenta/40 transition-colors disabled:opacity-40"
                >
                  <span className="font-mono text-sol-magenta mr-1">[{choice.key}]</span>
                  {choice.label.replace(/^\[.\]\s*/, "")}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
// The gate's decision card in the transcript: the live store row when the
// viewer holds it (pending or just answered); otherwise a link to the
// decision page, which reads for anyone who can read the run.
function GateDecisionBlock({ decisionId, shortId, prompt, resolved }: { decisionId: string; shortId?: string; prompt?: string; resolved: boolean }) {
  const row = useInboxStore((s) => s.sessionDecisions[decisionId]);
  if (row) {
    return <div className="my-3" data-gate-decision={decisionId}><DecisionCompactCard decision={row} showTask /></div>;
  }
  return (
    <div className="my-3 rounded-lg border border-sol-magenta/40 bg-sol-magenta/8 px-3 py-2.5 text-sm" data-gate-decision={decisionId}>
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider font-semibold text-sol-magenta">
        Human gate
        <span className={`ml-auto normal-case tracking-normal font-normal ${resolved ? "text-sol-green" : "text-sol-magenta/70 animate-pulse"}`}>{resolved ? "responded" : "waiting…"}</span>
      </div>
      {prompt && <p className="mt-1 text-sol-text">{prompt.split("\n")[0]}</p>}
      <Link href={`/decisions/${shortId ?? decisionId}`} className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-sol-blue hover:underline">
        Open the decision {shortId ?? ""}
      </Link>
    </div>
  );
}

export const SystemBlock = memo(SystemBlockImpl);

export const CompactionSummaryBlock = memo(function CompactionSummaryBlock({ content }: { content: string }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="mb-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-xs text-sol-text-dim hover:text-sol-text-muted transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-amber-500/70">Previous context summary</span>
      </button>
      {isExpanded && (
        <div className="mt-2 px-3 py-2 bg-sol-bg-alt/20 border-l-2 border-amber-500/30 text-xs prose prose-invert prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={entityRemarkPlugins} components={MD_COMPONENTS_NO_PRE}>
            {content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
});
