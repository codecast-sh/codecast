import { useState, useMemo, Fragment } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { hasDecodedSrc, markSrcDecoded } from "../../../hooks/useStorageImageUrl";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { ShortcutTooltip } from "../../KeyboardShortcutsHelp";
import { LivePulseDot } from "../../SessionActivityLine";
import { formatPlanFeedback } from "../../../lib/quoteFormat";
import { takeReviewBatch } from "../../../lib/reviewActions";
import { MessageReview } from "../../MessageReview";
import { fmtDuration } from "../../triggerCadence";
import { monitorRowsFor, effectiveMonitorStatus, isWatchHostDead, reportSaysDead, type MonitorStatus } from "../../monitorRows";
import { OptionPreview } from "../../tools/AskUserQuestionToolView";
import { buildPollPayload, pollKeyForOption, SYNTHETIC_POLL_OPTION } from "../../../lib/pollPayload";
import { useImageGallery, useGalleryMessageId } from "../../ImageGallery";
import { useInboxStore } from "../../../store/inboxStore";
import { Radar, Terminal } from "lucide-react";
import { formatFullTimestamp, formatRelativeTime } from "../../../lib/conversationFormat";
import { renderAssistantBody } from "../../../lib/renderAssistantBody";
import type { ImageData, ToolCall, ToolResult } from "../types";
import { useImageSrc } from "../../../hooks/useImageSrc";

// Live status badge + latest event for a Monitor or background-Bash block,
// derived from the conversation's message window (monitorRowsFor — one
// memoized scan shared by all blocks). Same anatomy as the trigger block
// above: identity accent + uppercase eyebrow + one-line gist, so standing
// machinery reads as one family.
const MONITOR_BADGE: Record<MonitorStatus, { label: string; cls: string }> = {
  watching: { label: "watching", cls: "bg-sol-green/10 text-sol-green border-sol-green/30" },
  ended: { label: "ended", cls: "bg-sol-bg-alt text-sol-text-dim border-sol-border/50" },
  timed_out: { label: "timed out", cls: "bg-sol-orange/10 text-sol-orange border-sol-orange/30" },
  stopped: { label: "stopped", cls: "bg-sol-bg-alt text-sol-text-dim border-sol-border/50" },
};
// A detached command "runs" rather than "watches", and finishing is its
// purpose ("done"), not a stream folding ("ended"). Workflow runs share the
// same voice.
const BACKGROUND_BADGE_LABEL: Record<MonitorStatus, string> = {
  watching: "running", ended: "done", timed_out: "timed out", stopped: "stopped",
};

export function MonitorBlock({ tool, conversationId }: { tool: ToolCall; conversationId?: string }) {
  const isBackground = tool.name !== "Monitor";
  let input: { command?: string; description?: string; timeout_ms?: number; persistent?: boolean } = {};
  try { input = JSON.parse(tool.input); } catch {}
  const [showCommand, setShowCommand] = useState(false);
  const messages = useInboxStore((s) => (conversationId ? s.messages[conversationId] : undefined));
  const row = useMemo(() => monitorRowsFor(messages).find((r) => r.toolUseId === tool.id), [messages, tool.id]);
  const now = useCoarseNow(30_000);
  // Background rows carry no timeout, so the scanner's defensive expiry never
  // fires for them — without this gate a dead session's block would claim
  // "running" forever. Narrow boolean subscription: re-renders only when the
  // verdict flips, never on heartbeat churn (see store/wakeSig.ts rules).
  const sessionDead = useInboxStore((s) => {
    if (!conversationId) return false;
    const sess = s.sessions[conversationId];
    return !!sess && isWatchHostDead(sess, now);
  });
  // The daemon's verdict on THIS watch: armed before its last verified report
  // and not in it means the shell is gone (a lost completion notice, a died
  // process) — the block must not claim "running". Narrow boolean subscription.
  const reportedDead = useInboxStore((s) => {
    if (!conversationId || !row) return false;
    const sess = s.sessions[conversationId];
    return !!sess && reportSaysDead(sess, row);
  });
  // Start of the process currently behind this session. A watch armed before it
  // died with the process that armed it — the session being alive says nothing
  // about a shell owned by its predecessor. Narrow numeric subscription.
  const agentStartedAt = useInboxStore((s) =>
    (conversationId ? s.sessions[conversationId]?.agent_started_at : undefined) ?? undefined,
  );
  const rawStatus: MonitorStatus = row ? effectiveMonitorStatus(row, now, agentStartedAt) : "watching";
  const status: MonitorStatus = rawStatus === "watching" && (sessionDead || reportedDead) ? "stopped" : rawStatus;
  const failed = isBackground && status === "ended" && (row?.exitCode ?? 0) > 0;
  const badge = failed
    ? { label: `exit ${row!.exitCode}`, cls: "bg-sol-red/10 text-sol-red border-sol-red/30" }
    : { cls: MONITOR_BADGE[status].cls, label: isBackground ? BACKGROUND_BADGE_LABEL[status] : MONITOR_BADGE[status].label };
  const watching = status === "watching";
  const commandFirstLine = (input.command || "").split("\n").find((l) => l.trim()) || "";
  const Icon = isBackground ? Terminal : Radar;

  return (
    <div data-cc-monitor-card className={`my-1 rounded border-l-2 ${watching ? "border-sol-blue/60 bg-sol-blue/5" : "border-sol-border/60 bg-sol-bg-alt/30"}`}>
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 min-w-0">
        <Icon className={`w-3.5 h-3.5 shrink-0 ${watching ? "text-sol-blue/70" : "text-sol-text-dim"}`} />
        <span data-cc-tech className={`text-[11px] font-medium tracking-wide uppercase shrink-0 ${watching ? "text-sol-blue/70" : "text-sol-text-dim"}`}>{isBackground ? "Background" : "Monitor"}</span>
        {input.persistent && (
          <ShortcutTooltip label="Runs until TaskStop or session end — not a one-shot watch">
            <span data-cc-tech className="px-1 py-0 rounded border text-[9px] font-semibold shrink-0 border-sol-blue/40 text-sol-blue/90 bg-sol-blue/10">persistent</span>
          </ShortcutTooltip>
        )}
        <span className="text-xs text-sol-text truncate min-w-0">{input.description || (isBackground ? "background command" : "background watch")}</span>
        {(row?.eventCount ?? 0) > 0 && (
          <span data-cc-tech className="ml-auto shrink-0 text-[10px] text-sol-text-dim tabular-nums">
            {row!.eventCount} event{row!.eventCount === 1 ? "" : "s"}
          </span>
        )}
        <span
          className={`${(row?.eventCount ?? 0) > 0 ? "" : "ml-auto "}shrink-0 inline-flex items-center gap-1 px-1.5 py-0 rounded text-[9px] font-semibold border ${badge.cls}`}
          title={input.timeout_ms !== undefined ? `Timeout: ${fmtDuration(input.timeout_ms)}` : undefined}
        >
          {watching && <LivePulseDot />}
          {badge.label}
        </span>
      </div>
      {input.command && (
        <button
          data-cc-tech
          onClick={() => setShowCommand((v) => !v)}
          className="w-full text-left px-3 pb-1.5 font-mono text-[11px] text-sol-text-dim hover:text-sol-text-muted transition-colors"
          title={showCommand ? "Collapse the watch command" : "Show the full watch command"}
        >
          {showCommand ? (
            <pre className="whitespace-pre-wrap break-words">{input.command}</pre>
          ) : (
            <span className="block truncate">{commandFirstLine}</span>
          )}
        </button>
      )}
      {row?.lastEvent && (
        <div data-cc-tech className="mx-3 mb-2 flex items-baseline gap-1.5 min-w-0 text-[11px] leading-snug">
          <span className={`truncate min-w-0 font-medium ${watching ? "text-sol-text-muted" : "text-sol-text-dim"}`}>
            <span className="mr-0.5 text-sol-blue/50">&gt;</span>
            {row.lastEvent}
          </span>
          {row.lastEventAt !== undefined && (
            <span className="ml-auto shrink-0 text-[10px] text-sol-text-dim whitespace-nowrap" title={formatFullTimestamp(row.lastEventAt)}>
              {formatRelativeTime(row.lastEventAt)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function PlanModeBlock({ tool, result, conversationId, messageId, onSendMessage }: { tool: ToolCall; result?: ToolResult; conversationId?: string; messageId?: string; onSendMessage?: (content: string) => void }) {
  const isEnter = tool.name === "EnterPlanMode" || tool.name === "enter_plan_mode";
  const isExit = tool.name === "ExitPlanMode" || tool.name === "exit_plan_mode";
  const isWaitingForApproval = isExit && !result && !!onSendMessage;
  const [sent, setSent] = useState(false);

  // The plan markdown the agent submitted. Rendered as an annotatable document
  // while it's awaiting approval so the user can quote/comment specific sections
  // (reusing MessageReview) and send those notes back as the rejection feedback.
  let plan = "";
  try { plan = JSON.parse(tool.input)?.plan ?? ""; } catch {}

  // Namespace the plan's review batch under its own key so its comments never
  // collide with comments on this message's prose body (both render their own
  // MessageReview with the same messageId otherwise).
  const reviewKey = conversationId && messageId ? `${messageId}#plan` : undefined;
  const canReview = isWaitingForApproval && !sent && !!plan && !!conversationId && !!reviewKey;
  const pendingCount = useInboxStore((s) =>
    reviewKey ? (s.reviewComments[conversationId!] ?? []).filter((c) => c.messageId === reviewKey).length : 0,
  );

  const requestChanges = () => {
    const batch = reviewKey ? takeReviewBatch(conversationId!, reviewKey) : "";
    setSent(true);
    onSendMessage!(JSON.stringify({ __cc_poll: true, keys: ["4"], text: formatPlanFeedback(batch), display: "Requested changes" }));
  };

  return (
    <div className="my-0.5">
      <div className="flex items-center gap-1.5 text-xs">
        <svg className="w-3 h-3 text-sol-violet/80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
        </svg>
        <span className="font-mono text-sol-violet font-semibold text-[11px]">Plan Mode</span>
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-sol-violet/15 text-sol-violet border border-sol-violet/30">
          {isEnter ? "enter" : "exit"}
        </span>
      </div>
      {canReview && (
        <div className="mt-2 rounded-lg border border-sol-violet/25 bg-sol-violet/[0.04] px-3.5 py-3 text-sol-text prose prose-invert prose-sm max-w-none">
          <MessageReview
            conversationId={conversationId!}
            messageId={reviewKey!}
            content={plan}
            renderBlock={renderAssistantBody}
          />
        </div>
      )}
      {isWaitingForApproval && !sent && (
        <>
          <div className="flex items-center gap-1.5 mt-2 ml-0.5 flex-wrap">
            <button
              onClick={() => { setSent(true); onSendMessage(JSON.stringify({ __cc_poll: true, keys: ["1"], display: "Start (clear context)" })); }}
              className="text-[11px] px-2.5 py-1 rounded border border-sol-border/40 bg-sol-bg-alt text-sol-text hover:border-sol-green/40 hover:bg-sol-green/10 hover:text-sol-green transition-colors cursor-pointer"
            >
              Start (clear context)
            </button>
            <button
              onClick={() => { setSent(true); onSendMessage(JSON.stringify({ __cc_poll: true, keys: ["3"], display: "Start (keep context)" })); }}
              className="text-[11px] px-2.5 py-1 rounded border border-sol-border/40 bg-sol-bg-alt text-sol-text hover:border-sol-green/40 hover:bg-sol-green/10 hover:text-sol-green transition-colors cursor-pointer"
            >
              Start (keep context)
            </button>
            <button
              onClick={requestChanges}
              disabled={canReview && pendingCount === 0}
              title={canReview && pendingCount === 0 ? "Quote a section of the plan first" : undefined}
              className="text-[11px] px-2.5 py-1 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed enabled:cursor-pointer border-sol-yellow/40 bg-sol-yellow/5 text-sol-yellow enabled:hover:bg-sol-yellow/15 enabled:hover:border-sol-yellow/60"
            >
              Request changes{pendingCount > 0 ? ` (${pendingCount})` : ""}
            </button>
          </div>
          {canReview && (
            <div className="text-[10px] text-sol-text-dim mt-1.5 ml-0.5 italic">
              {pendingCount > 0
                ? `${pendingCount} note${pendingCount === 1 ? "" : "s"} will be sent to the agent.`
                : "Hover any part of the plan to quote it, then request changes."}
            </div>
          )}
        </>
      )}
      {sent && (
        <div className="text-[10px] text-sol-text-dim mt-1 ml-0.5 italic">Message sent</div>
      )}
    </div>
  );
}

const _askUserSentState = new Map<string, Record<number, Array<{ key: string; label: string; text?: string }>>>();

// The poll wire format (option keys, free-text decline, submit chords) lives in
// lib/pollPayload so the decision queue answers polls the exact same way.

// The check glyph shown in a selected poll option's index slot / pill.
function PollCheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

export function AskUserQuestionBlock({ tool, result, onSendMessage }: { tool: ToolCall; result?: ToolResult; onSendMessage?: (content: string) => void }) {
  let parsedInput: { questions?: Array<{ question: string; header?: string; detail?: string; options: Array<{ label: string; description?: string; preview?: string }>; multiSelect?: boolean; multi_select?: boolean; isConfirmation?: boolean }>; answers?: Record<string, string> } = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}
  const [sent, setSent] = useState(() => _askUserSentState.has(tool.id));
  // Per-question selections. multiSelect questions hold several entries (checkbox
  // semantics); single-select questions hold at most one.
  const [selections, setSelections] = useState<Record<number, Array<{ key: string; label: string; text?: string }>>>(() => _askUserSentState.get(tool.id) ?? {});
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});

  const questions = (parsedInput.questions || []).map((q) => ({
    ...q,
    multiSelect: q.multiSelect ?? q.multi_select,
  }));
  if (questions.length === 0) return null;

  const isMultiQuestion = questions.length > 1;
  const isConfirmation = questions[0]?.isConfirmation;
  const anyMultiSelect = questions.some(q => q.multiSelect);
  // multiSelect answers can't auto-submit on first click, so they share the
  // multi-question "pick everything, then submit" flow.
  const needsSubmit = isMultiQuestion || anyMultiSelect;

  let answers: Record<string, string> = {};
  if (parsedInput.answers && typeof parsedInput.answers === "object") {
    answers = parsedInput.answers;
  } else if (result?.content) {
    const regex = /"([^"]+)"="([^"]+)"/g;
    let match;
    while ((match = regex.exec(result.content)) !== null) {
      answers[match[1]] = match[2];
    }
  }

  const isInteractive = !result && !!onSendMessage && !sent;
  const allAnswered = needsSubmit && questions.every((_, i) => (selections[i]?.length ?? 0) > 0);

  const buildPayload = (sels: typeof selections) => buildPollPayload(questions, sels);

  const handleSubmitAll = () => {
    if (!onSendMessage || !allAnswered) return;
    _askUserSentState.set(tool.id, selections);
    setSent(true);
    onSendMessage(buildPayload(selections));
  };

  const commitOther = (qIdx: number, text: string, optionsCount: number) => {
    const otherKey = String(optionsCount + 1);
    const sel = { key: otherKey, label: text, text };
    if (questions[qIdx]?.multiSelect) {
      // Joins the toggled options (replacing any previous custom entry); sent on Submit.
      setSelections(prev => ({ ...prev, [qIdx]: [...(prev[qIdx] ?? []).filter(s => s.text === undefined), sel] }));
    } else if (isMultiQuestion) {
      setSelections(prev => ({ ...prev, [qIdx]: [sel] }));
    } else {
      const newSels = { 0: [sel] };
      _askUserSentState.set(tool.id, newSels);
      setSelections(newSels);
      setSent(true);
      onSendMessage!(buildPayload(newSels));
    }
  };

  return (
    <div className="my-1.5 ml-1 border-l-2 border-sol-violet/30 pl-3 space-y-2.5">
      {questions.map((q, i) => {
        const answer = answers[q.question];
        // A multiSelect answer arrives as the chosen labels joined with ", " (the CLI's
        // own join) — split it back so each chosen option lights up individually.
        const answerParts = answer === undefined ? [] : q.multiSelect ? answer.split(", ") : [answer];
        const matchesOption = (part: string) => q.options.some(
          o => o.label === part || o.label.replace(" (Recommended)", "") === part
        );
        const customAnswer = answerParts.filter(p => !matchesOption(p)).join(", ");
        const isCustom = customAnswer !== "";
        const sels = selections[i] ?? [];
        const otherSel = sels.find(s => s.text !== undefined);
        const isOtherSelected = otherSel !== undefined;
        // Rich layout (numbered rows with stacked descriptions) when any option carries a
        // description or preview; otherwise compact borderless pills.
        const hasRich = q.options.some(o => o.description || o.preview);
        return (
          <div key={i} className="space-y-2">
            {q.header && (
              <div>
                <span className="inline-block text-[9px] uppercase tracking-[0.09em] font-semibold px-1.5 py-0.5 rounded bg-sol-violet/15 text-sol-violet">
                  {q.header}
                </span>
              </div>
            )}
            <div className="text-[13px] leading-snug font-medium text-sol-text-secondary">
              {q.question}
              {q.multiSelect && isInteractive && (
                <span className="ml-2 text-[10px] font-normal uppercase tracking-[0.07em] text-sol-text-dim">select all that apply</span>
              )}
            </div>
            {q.detail && (
              <div className="text-[12px] leading-relaxed text-sol-text-muted whitespace-pre-line max-w-prose">{q.detail}</div>
            )}
            <div className={hasRich ? "flex flex-col gap-0.5" : "flex flex-wrap gap-1.5"}>
              {q.options.map((opt, j) => {
                // Synthetic CLI menu chrome scraped as bare options — drop it. Keep the
                // index `j` so the surviving options retain their positional poll keys.
                if (SYNTHETIC_POLL_OPTION.test(opt.label.trim())) return null;
                const cleanLabel = opt.label.replace(" (Recommended)", "");
                const isSelected = answerParts.some(p => opt.label === p || cleanLabel === p);
                const isLocalSelected = sels.some(s => s.text === undefined && s.label === cleanLabel);
                const on = isSelected || isLocalSelected;
                const choose = () => {
                  setOtherOpen(prev => ({ ...prev, [i]: false }));
                  const pollKey = pollKeyForOption(j, isConfirmation);
                  const sel = { key: pollKey, label: cleanLabel };
                  if (q.multiSelect) {
                    // Checkbox semantics: clicking toggles; Submit sends.
                    setSelections(prev => {
                      const cur = prev[i] ?? [];
                      const has = cur.some(s => s.text === undefined && s.key === pollKey);
                      return { ...prev, [i]: has ? cur.filter(s => s.text !== undefined || s.key !== pollKey) : [...cur, sel] };
                    });
                  } else if (isMultiQuestion) {
                    setSelections(prev => ({ ...prev, [i]: [sel] }));
                  } else {
                    const newSels = { ...selections, [i]: [sel] };
                    _askUserSentState.set(tool.id, newSels);
                    setSelections(newSels);
                    setSent(true);
                    onSendMessage!(JSON.stringify({ __cc_poll: true, keys: [pollKey], display: cleanLabel }));
                  }
                };
                // Rich row: a numbered index slot (becomes a check when chosen) plus the
                // label stacked above its description — no per-option border, just a soft
                // hover/selected fill.
                // multiSelect renders the index slot as an empty checkbox outline so the
                // rows read as toggles, not a pick-one menu.
                const marker = (
                  <span className={`mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md text-[10px] font-semibold tabular-nums leading-none transition-colors ${
                    on
                      ? isInteractive ? "bg-sol-violet text-white" : "bg-sol-green text-white"
                      : q.multiSelect && isInteractive ? "border border-sol-violet/40 text-sol-violet/80 group-hover/opt:bg-sol-violet/15"
                      : isInteractive ? "bg-sol-violet/15 text-sol-violet/80 group-hover/opt:bg-sol-violet/25" : "bg-sol-border/15 text-sol-text-dim"
                  }`}>
                    {on ? <PollCheckIcon className="w-2.5 h-2.5" /> : j + 1}
                  </span>
                );
                const body = (
                  <span className="min-w-0 flex-1 leading-snug">
                    <span className={`text-xs font-medium ${
                      on ? (isInteractive ? "text-sol-violet" : "text-sol-green") : isInteractive ? "text-sol-violet/90" : "text-sol-text-dim"
                    }`}>{opt.label}</span>
                    {opt.description && (
                      <span className="mt-0.5 block text-xs leading-relaxed text-sol-text-dim">{opt.description}</span>
                    )}
                  </span>
                );
                const rowCls = `group/opt flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors ${
                  isInteractive ? "cursor-pointer " : ""
                }${on ? (isInteractive ? "bg-sol-violet/12" : "bg-sol-green/10") : (isInteractive ? "hover:bg-sol-violet/10" : "")}`;
                const node = hasRich ? (
                  isInteractive
                    ? <button type="button" onClick={choose} className={rowCls}>{marker}{body}</button>
                    : <div className={rowCls}>{marker}{body}</div>
                ) : isInteractive ? (
                  <button
                    type="button"
                    onClick={choose}
                    className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full transition-colors cursor-pointer ${
                      on ? "bg-sol-violet text-white" : "bg-sol-violet/12 text-sol-violet hover:bg-sol-violet/25"
                    }`}
                  >
                    {on && <PollCheckIcon className="w-3 h-3" />}
                    {opt.label}
                  </button>
                ) : (
                  <span className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full ${
                    on ? "bg-sol-green text-white" : "bg-sol-border/12 text-sol-text-dim"
                  }`}>
                    {on && <PollCheckIcon className="w-3 h-3" />}
                    {opt.label}
                  </span>
                );
                // An option's `preview` is the ASCII/mockup the terminal shows in a side
                // box — surface it so the web user sees the same detail. Show it while
                // interactive (read before clicking, since one click submits) and on the
                // chosen option once answered. In rich mode it sits indented under the label.
                const showPreview = !!opt.preview && (isInteractive || on);
                return showPreview ? (
                  <div key={j} className={hasRich ? "" : "w-full"}>
                    {node}
                    <div className={hasRich ? "pl-9 pr-2 pt-0.5" : "mt-1"}>
                      <OptionPreview preview={opt.preview!} />
                    </div>
                  </div>
                ) : (
                  <Fragment key={j}>{node}</Fragment>
                );
              })}
              {isInteractive && !otherOpen[i] && (
                hasRich ? (
                  <button
                    type="button"
                    onClick={() => {
                      setOtherOpen(prev => ({ ...prev, [i]: true }));
                      setSelections(prev => ({ ...prev, [i]: q.multiSelect ? (prev[i] ?? []).filter(s => s.text === undefined) : [] }));
                    }}
                    className={`group/opt flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer ${
                      isOtherSelected ? "bg-sol-blue/12" : "hover:bg-sol-blue/10"
                    }`}
                  >
                    <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md text-[12px] leading-none transition-colors ${
                      isOtherSelected ? "bg-sol-blue text-white" : "bg-sol-border/15 text-sol-text-dim group-hover/opt:bg-sol-blue/25 group-hover/opt:text-sol-blue"
                    }`}>
                      {isOtherSelected ? <PollCheckIcon className="w-2.5 h-2.5" /> : "+"}
                    </span>
                    <span className={`text-xs ${isOtherSelected ? "font-medium text-sol-blue" : "text-sol-text-dim group-hover/opt:text-sol-blue/90"}`}>
                      {isOtherSelected ? otherSel!.label : "Other"}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setOtherOpen(prev => ({ ...prev, [i]: true }));
                      setSelections(prev => ({ ...prev, [i]: q.multiSelect ? (prev[i] ?? []).filter(s => s.text === undefined) : [] }));
                    }}
                    className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full transition-colors cursor-pointer ${
                      isOtherSelected ? "bg-sol-blue text-white font-medium" : "bg-sol-border/12 text-sol-text-dim hover:bg-sol-blue/18 hover:text-sol-blue"
                    }`}
                  >
                    {isOtherSelected ? <PollCheckIcon className="w-3 h-3" /> : <span className="text-[13px] leading-none">+</span>}
                    {isOtherSelected ? otherSel!.label : "Other"}
                  </button>
                )
              )}
              {!isInteractive && (isCustom || isOtherSelected) && (
                hasRich ? (
                  <div className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 bg-sol-blue/10">
                    <span className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md bg-sol-blue text-white">
                      <PollCheckIcon className="w-2.5 h-2.5" />
                    </span>
                    <span className="min-w-0 flex-1 text-xs font-medium text-sol-blue leading-snug">{isOtherSelected ? otherSel!.label : customAnswer}</span>
                  </div>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full bg-sol-blue text-white">
                    <PollCheckIcon className="w-3 h-3" />
                    {isOtherSelected ? otherSel!.label : customAnswer}
                  </span>
                )
              )}
            </div>
            {isInteractive && otherOpen[i] && (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  type="text"
                  value={otherTexts[i] || ""}
                  onChange={e => setOtherTexts(prev => ({ ...prev, [i]: e.target.value }))}
                  onKeyDown={e => {
                    if (e.key === "Enter" && otherTexts[i]?.trim()) {
                      commitOther(i, otherTexts[i].trim(), q.options.length);
                      setOtherOpen(prev => ({ ...prev, [i]: false }));
                    } else if (e.key === "Escape") {
                      setOtherOpen(prev => ({ ...prev, [i]: false }));
                    }
                  }}
                  placeholder="Type your answer..."
                  className="flex-1 text-xs px-2.5 py-1.5 rounded-md bg-sol-bg-alt text-sol-text placeholder:text-sol-text-dim/60 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-sol-blue/50"
                />
                <button
                  onClick={() => {
                    if (otherTexts[i]?.trim()) {
                      commitOther(i, otherTexts[i].trim(), q.options.length);
                      setOtherOpen(prev => ({ ...prev, [i]: false }));
                    }
                  }}
                  disabled={!otherTexts[i]?.trim()}
                  className="text-[11px] font-medium px-2.5 py-1.5 rounded-md bg-sol-blue text-white hover:bg-sol-blue/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  OK
                </button>
                <button
                  onClick={() => setOtherOpen(prev => ({ ...prev, [i]: false }))}
                  className="text-[11px] px-1.5 py-1.5 text-sol-text-dim hover:text-sol-text transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        );
      })}
      {isInteractive && needsSubmit && (
        <div className="pt-0.5">
          <button
            onClick={handleSubmitAll}
            disabled={!allAnswered}
            className={`text-[11px] font-medium px-3 py-1.5 rounded-md transition-colors ${
              allAnswered
                ? "bg-sol-green text-white hover:bg-sol-green/90 cursor-pointer"
                : "bg-sol-border/15 text-sol-text-dim cursor-not-allowed"
            }`}
          >
            {isMultiQuestion
              ? `Submit answers (${questions.filter((_, qi) => (selections[qi]?.length ?? 0) > 0).length}/${questions.length})`
              : `Submit (${selections[0]?.length ?? 0} selected)`}
          </button>
        </div>
      )}
    </div>
  );
}

// Reasoning text, only mounted by the caller when the conversation's global
// "Show thinking" toggle is on (off by default — see showThinking in
// ConversationView). claude/codex redact thinking server-side (empty →
// nothing renders, unchanged), but opencode/pi carry real reasoning that
// would otherwise vanish — and a reasoning-ONLY turn would disappear from
// the timeline entirely. Faded, collapsed to a 2-line preview by default,
// click to expand.
export function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const isLong = lines.length > 2 || content.length > 200;
  const preview = isLong && !expanded ? lines.slice(0, 2).join("\n") : content;
  return (
    <div className="my-0.5 opacity-50">
      <div
        className={`flex items-start gap-1 ${isLong ? "cursor-pointer" : ""}`}
        onClick={() => isLong && setExpanded(!expanded)}
      >
        {isLong && (
          <svg
            className={`w-3 h-3 mt-0.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        )}
        <div className="flex-1 text-sol-text-muted font-mono whitespace-pre-wrap break-words text-xs">
          {preview}
          {isLong && !expanded && "…"}
        </div>
      </div>
    </div>
  );
}

const IMAGE_COLLAPSED_HEIGHT = 100;

export function ImageBlock({ image }: { image: ImageData }) {
  const { src, href, storageResolved, storageMissing } = useImageSrc(image);
  const gallery = useImageGallery();
  const messageId = useGalleryMessageId();

  // Seed "loaded" from the module cache so an already-decoded image skips the
  // overlay on remount instead of flashing it while the HTTP-cached bytes decode.
  const [loaded, setLoaded] = useState(() => hasDecodedSrc(src));
  const [errored, setErrored] = useState(false);

  useWatchEffect(() => {
    setLoaded(hasDecodedSrc(src));
    setErrored(false);
  }, [src]);

  useWatchEffect(() => {
    if (src && gallery) gallery.register({ src, href, messageId });
  }, [src, href, messageId, gallery]);

  // Keep the same reserved height when a stored image is missing or undecodable.
  // Returning null here used to collapse image-heavy transcript rows after load,
  // moving the virtualizer's scroll anchor by thousands of pixels.
  if (storageMissing || errored || (!src && storageResolved)) {
    return (
      <div
        className="my-2 max-w-md rounded border border-sol-border bg-sol-bg-alt flex flex-col items-center justify-center gap-1"
        style={{ height: IMAGE_COLLAPSED_HEIGHT }}
        role="status"
      >
        <span className="text-sol-text-muted text-xs">Image unavailable</span>
        <span className="text-sol-text-dim text-[10px]">
          {errored ? "The stored image could not be decoded." : "The stored image could not be found."}
        </span>
      </div>
    );
  }

  if (!src) {
    return (
      <div className="my-2 max-w-md rounded-t border-x border-t border-sol-border bg-sol-bg-alt flex items-center justify-center" style={{ height: IMAGE_COLLAPSED_HEIGHT }}>
        <span className="text-sol-text-dim text-xs">Loading image...</span>
      </div>
    );
  }

  return (
    <div
      className="my-2 cursor-pointer relative max-w-md"
      style={{ minHeight: IMAGE_COLLAPSED_HEIGHT }}
      onClick={() => gallery?.open(src)}
    >
      {!loaded && (
        <div className="absolute inset-0 rounded-t border-x border-t border-sol-border bg-sol-bg-alt flex items-center justify-center z-10" style={{ height: IMAGE_COLLAPSED_HEIGHT }}>
          <span className="text-sol-text-dim text-xs">Loading image...</span>
        </div>
      )}
      <div
        className="overflow-hidden rounded-t border-x border-t border-sol-border hover:border-sol-blue/50 transition-all"
        style={{ height: IMAGE_COLLAPSED_HEIGHT }}
      >
        <img
          src={src}
          alt="User provided image"
          className="w-full"
          style={loaded ? undefined : { width: 0, height: 0, overflow: 'hidden', position: 'absolute' }}
          onLoad={() => { markSrcDecoded(src); setLoaded(true); }}
          onError={() => setErrored(true)}
        />
      </div>
      {loaded && !image.uploading && (
        <div
          className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none"
          style={{ background: 'linear-gradient(to bottom, transparent, var(--image-fade-bg, var(--sol-bg, #0a0a0a)))' }}
        />
      )}
      {image.uploading && (
        <div className="absolute inset-0 rounded-t bg-black/40 flex items-center justify-center z-20" style={{ height: IMAGE_COLLAPSED_HEIGHT }}>
          <svg className="w-6 h-6 animate-spin text-white" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </div>
      )}
    </div>
  );
}
