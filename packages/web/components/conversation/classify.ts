import { isCommandMessage, isStrippedCommand, isSkillExpansion, isBackgroundAgentStoppedNotice, backgroundAgentStoppedName, parseBashInput, parseBashOutput, commandExpansionName, isCodexTurnAbortedMessage } from "../../lib/conversationProcessor";
import { isPollResponsePayload } from "@codecast/shared/contracts";
import { classifyApiErrorBanner, isNoResponseStub, CLIENT_ERROR_BANNER_PREFIX, parseDecisionAnswer, isAgentSwitchNotice, parseAgentSwitchNotice, isMachineSwitchNotice, parseMachineSwitchNotice, isModelSwitchCommandName, isModelSwitchStdout, modelSwitchStdoutLabel } from "@codecast/shared/contracts";
import { isAskTool, isPlanWriteToolCall, isShellTool } from "@codecast/shared/render";
import { isRoleWakeFrame, parseRoleWakeFrame } from "../roleWake";
import { isBackgroundBashToolCall, parseTaskNotificationBlock } from "../monitorRows";
import { stripPastedContent } from "@codecast/shared/contracts";
import { parseInboundSessionMessage, isSessionMessage, isAgentMessage, parseAgentAuthoredMessage, parseUnwrappedSessionReport, parseUserMessage, parseProposalMessage, isTeammateFramingOnly, isSpawnedTaskPrompt, parseSpawnedTaskPrompt, parseChatWakePrompt, parseHuddleSummaryTag, isToolResultCarrier } from "../sessionMessage";
import { parseCastCommandString, stripCdPrefix, isDecideCastCommand, type ParsedCastCommand, type DecideArgs } from "../castCommand";
import { hasRichMarkdown } from "../../lib/conversationMarkdown";
import { parseSessionHandoff } from "../../lib/sessionHandoff";
import type { Message, ParsedApiError, ParsedContextBlock, TeammateMessagePart, ToolCall, UserMessageKind } from "./types";

// Cached: this runs seven regex passes over the full message body and is called
// from renderItem/first-in-sequence logic for every visible row on every feed
// render. Message content strings are identity-stable in the store, so a small
// insertion-order LRU keyed by the string dedupes the work; a streaming row's
// growing content just misses once per tick.
const STRIP_SYSTEM_TAGS_CACHE = new Map<string, string>();
export function stripSystemTags(content: string): string {
  const hit = STRIP_SYSTEM_TAGS_CACHE.get(content);
  if (hit !== undefined) return hit;
  const out = stripPastedContent(content)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<\/?(?:command-(?:name|message|args)|antml:[a-z_]+)[^>]*>/g, '')
    .replace(/^\s*Caveat:.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  if (STRIP_SYSTEM_TAGS_CACHE.size > 2000) {
    STRIP_SYSTEM_TAGS_CACHE.delete(STRIP_SYSTEM_TAGS_CACHE.keys().next().value!);
  }
  STRIP_SYSTEM_TAGS_CACHE.set(content, out);
  return out;
}

// Assistant stub the timeline renders as nothing (see renderTimelineItem).
// Fork-point selection and branch-chip anchoring must treat it as invisible:
// a fork recorded against it would have no message to render its chips under.
export function isHiddenStubMessage(msg: { role?: string; content?: string }): boolean {
  return msg.role === "assistant" && isNoResponseStub(stripSystemTags(msg.content || ""));
}

// Can this message host branch chips? Only user/assistant blocks render a
// BranchSelector, and hidden stubs render nothing at all. Both picking a fork
// point and placing the chips must agree on this, or a fork lands on a message
// with no UI to show it.
export function canAnchorForkChips(msg: { role?: string; content?: string; message_uuid?: string }): boolean {
  if (!msg.message_uuid || isHiddenStubMessage(msg)) return false;
  return msg.role === "assistant" || (msg.role === "user" && !!msg.content?.trim());
}

export function cleanStickyContent(content: string): string {
  const stMatch = content.match(/<scheduled-task\s+title="([^"]*)"[^>]*>([\s\S]*?)<\/scheduled-task>/);
  if (stMatch) {
    const title = stMatch[1].replace(/&quot;/g, '"');
    const prompt = stMatch[2].trim();
    return prompt ? `${title} — ${prompt}` : title;
  }
  const spawned = parseSpawnedTaskPrompt(content);
  if (spawned) {
    // A spawn task's title is usually the prompt's first ~60 chars — showing
    // "title — prompt" would stutter, so prefer the prompt alone when it
    // subsumes the title.
    if (!spawned.prompt) return spawned.title;
    return spawned.prompt.startsWith(spawned.title) ? spawned.prompt : `${spawned.title} — ${spawned.prompt}`;
  }
  return stripSystemTags(content)
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/<teammate-message\s+[^>]*>[\s\S]*?<\/teammate-message>/g, "")
    .replace(/<scheduled-task[^>]*>[\s\S]*?<\/scheduled-task>/g, "")
    .replace(/\[Image[:\s][^\]]*\]/gi, "")
    .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

// The remedy for an "auth" card, per client. opencode authenticates via its own
// CLI (`opencode auth login`) in a separate terminal; pi and Claude/Codex re-auth
// with `/login` typed into the running session. Naming the exact fix — and letting
// the user copy it — is what turns a dead session into a one-step recovery.
export function authRemedy(agentType?: string): { command: string; where: string; inPane: boolean } {
  if (agentType === "opencode") {
    return { command: "opencode auth login", where: "in a terminal", inPane: false };
  }
  // pi, claude_code, codex, and anything else re-auth with /login in the session.
  return { command: "/login", where: "in its terminal", inPane: true };
}

export function parseApiErrorContent(content?: string | null): ParsedApiError | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (!trimmed) return null;

  if (classifyApiErrorBanner(trimmed) === "safety") {
    return { message: trimmed.replace(/^Safety stop:\s*(?:misalignment_policy_violation\s*·\s*)?/, ""), errorType: "misalignment_policy_violation", isSafety: true };
  }

  // Marked opencode/pi provider error: strip the marker, classify (auth vs
  // generic), and show the provider's own text. classifyApiErrorBanner keys on the
  // marker, so isAuth/isClientError below reflect its verdict.
  if (trimmed.startsWith(CLIENT_ERROR_BANNER_PREFIX)) {
    const body = trimmed.slice(CLIENT_ERROR_BANNER_PREFIX.length).trim();
    const kind = classifyApiErrorBanner(trimmed);
    if (kind === "auth") {
      return { message: body || "This session needs authentication.", isAuth: true };
    }
    return { message: body || "The model could not complete this turn.", isClientError: true };
  }

  // Banner detection (auth / limit / connection / fatal) shares the backend's
  // classifier in @codecast/shared/contracts: anchored prefixes + a length cap
  // keep a long prose reply that merely opens like a banner from rendering as
  // a card. The generic "API Error:"-prefixed form keeps its original anchored
  // match (no cap) so a long JSON error payload still renders as the error card.
  const bannerKind = classifyApiErrorBanner(trimmed);
  const isAuth = bannerKind === "auth";
  const isLimit = bannerKind === "limit";
  const isConnection = bannerKind === "connection";
  const isThrottle = bannerKind === "throttle";
  const isFatal = bannerKind === "fatal";
  const match = trimmed.match(/^API Error:\s*(\d{3})\s*([\s\S]*)$/i);
  if (!isAuth && !isLimit && !isConnection && !isThrottle && !isFatal && !match) return null;

  // The status code may be the leading "API Error: NNN" (generic form) or
  // embedded in an auth banner ("Please run /login · API Error: 401 …").
  const statusStr = match?.[1] ?? trimmed.match(/API Error:\s*(\d{3})/i)?.[1];
  const statusCode = statusStr ? Number(statusStr) : undefined;
  const payloadText = (match?.[2] || "").trim();
  let message = "";
  let errorType: string | undefined;
  let requestId: string | undefined;

  if (payloadText.startsWith("{")) {
    try {
      const parsed = JSON.parse(payloadText) as Record<string, unknown>;
      if (typeof parsed.request_id === "string") {
        requestId = parsed.request_id;
      }

      const parsedError = parsed.error;
      if (parsedError && typeof parsedError === "object" && !Array.isArray(parsedError)) {
        const errorRecord = parsedError as Record<string, unknown>;
        if (typeof errorRecord.type === "string") {
          errorType = errorRecord.type;
        }
        if (typeof errorRecord.message === "string") {
          message = errorRecord.message;
        }
      }
    } catch {
      // Keep fallback values for non-JSON payloads.
    }
  }

  if (!requestId) {
    requestId = trimmed.match(/\b(req_[A-Za-z0-9]+)\b/)?.[1];
  }
  if (!message) {
    if (isAuth) {
      // The card states the /login remedy itself, so drop the "Please run
      // /login" instruction (leading or trailing — "Login expired · Please run
      // /login") and the status prefix and keep just the descriptive detail
      // (e.g. "Login expired", "The socket connection was closed unexpectedly").
      message =
        trimmed
          .replace(/^please run \/login\s*[·.\-:]*\s*/i, "")
          .replace(/\s*[·.\-:]*\s*please run \/login\s*$/i, "")
          .replace(/^api error:\s*\d{3}\s*/i, "")
          .trim() || "This session was signed out.";
    } else if (isLimit) {
      // The card heading already says "limit", so drop the redundant
      // "You've hit/reached your" lead-in and keep the informative tail
      // ("Session limit · resets 11:30pm (America/New_York)").
      const detail = trimmed.replace(/^you['’]ve (?:hit|reached) your\s*/i, "");
      message = detail.charAt(0).toUpperCase() + detail.slice(1);
    } else if (isConnection) {
      // The card heading already says the error part, so keep just the detail
      // ("Connection closed mid-response. The response above may be incomplete.").
      message = trimmed.replace(/^api error:?\s*/i, "").trim() || "The connection to the provider dropped.";
    } else if (isThrottle) {
      // The heading says "rate limited"; keep the explanation and what the pane showed.
      const detail = trimmed.replace(/^rate limited\s*·\s*/i, "").trim();
      message = detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : "The provider's per-minute rate limit rejected the request.";
    } else {
      message = statusCode === 500 ? "Internal server error" : "API request failed";
    }
  }

  return { statusCode: isThrottle ? 429 : statusCode, message, errorType, requestId, isAuth, isLimit, isConnection, isThrottle, isFatal };
}

// Guess which provider an opencode auth failure is about, from its message text.
// opencode surfaces the provider by name ("OpenRouter", "no Anthropic API key") or
// its short code ("OR"); when nothing matches we let the user pick from the list.
export function detectProviderFromError(message: string): string | undefined {
  const m = message.toLowerCase();
  if (/openrouter/.test(m) || /\bOR\b/.test(message)) return "openrouter";
  if (/anthropic|claude/.test(m)) return "anthropic";
  if (/openai|\bgpt\b/.test(m)) return "openai";
  if (/vertex|gemini|google/.test(m)) return "google";
  return undefined;
}

export function summarizeBashCommand(cmd: string): string {
  let c = stripCdPrefix(cmd);
  c = c.replace(/\/Users\/\w+\//g, '~/');
  c = c.replace(/\/home\/\w+\//g, '~/');
  const rgMatch = c.match(/^(rg|grep|ripgrep)\s+([\s\S]*)$/);
  if (rgMatch) {
    const args = rgMatch[2];
    const patternMatch = args.match(/(?:^|\s)(?:-e\s+)?['"]([^'"]+)['"]/);
    const bareMatch = patternMatch ? null : args.match(/(?:^|\s)(?:-[a-zA-Z]+\s+)*([^\s-]\S*)/);
    const pattern = patternMatch?.[1] || bareMatch?.[1] || "";
    if (pattern) return `rg "${pattern.length > 40 ? pattern.slice(0, 40) + "..." : pattern}"`;
  }
  const sedMatch = c.match(/^sed\s+.*?\s+(\S+)\s*$/);
  if (sedMatch) {
    const file = sedMatch[1].split('/').pop() || sedMatch[1];
    return `sed ${file}`;
  }
  if (c.startsWith('git ')) {
    const parts = c.split(/\s+/);
    const meaningful = parts.filter(p => !p.startsWith('-') || p === '--staged' || p === '--cached' || p === '--stat' || p === '--short').slice(0, 4);
    return meaningful.join(' ');
  }
  return c.length > 80 ? c.slice(0, 80) + '...' : c;
}

// Cached by tool-call object (identity-stable in the store): the JSON.parse of
// a Bash tool's input showed up as a per-render scroll cost.
const PARSE_CAST_COMMAND_CACHE = new WeakMap<ToolCall, ParsedCastCommand | null>();
export function parseCastCommand(tool: ToolCall): ParsedCastCommand | null {
  if (!isShellTool(tool.name)) return null;
  if (PARSE_CAST_COMMAND_CACHE.has(tool)) return PARSE_CAST_COMMAND_CACHE.get(tool)!;
  let out: ParsedCastCommand | null = null;
  try {
    const input = JSON.parse(tool.input);
    out = parseCastCommandString(String(input.command || input.cmd || ""));
  } catch { out = null; }
  PARSE_CAST_COMMAND_CACHE.set(tool, out);
  return out;
}

const PLAN_PREFIXES = [
  /^implement\s+the\s+following\s+plan\s*:\s*/i,
  /^implement\s+this\s+plan\s*:\s*/i,
  /^here(?:'s| is)\s+the\s+plan\s*:\s*/i,
  /^plan\s*:\s*\n/i,
];

function extractPlanContent(text: string): string | null {
  const trimmed = text.trim();
  for (const prefix of PLAN_PREFIXES) {
    const match = trimmed.match(prefix);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      if (rest.length > 200 && hasRichMarkdown(rest)) {
        return rest;
      }
    }
  }
  return null;
}

const STICKY_NOISE_PREFIXES = ["[Request interrupted", "<task-notification>", "Your task is to create a detailed summary", "Full transcript available at:", "[Codecast import]"];

// The user rows fold mode keeps: what a person said to the agent, and a chat
// line that woke it. Everything else on the user rail was sent by a machine
// (a wake frame, a poll answer, an interrupt, a notice, a session's report).
export const FOLD_KEPT_USER_KINDS = new Set<UserMessageKind["kind"]>(['normal', 'direct_user', 'decision_answer', 'plan', 'chat_wake', 'session_handoff']);

// Dedup key for matching a still-pending message against its eventual JSONL echo.
// The daemon collapses newlines to spaces on inject (injectViaTmux) and a few control
// chars can leak in, so we strip reminders + control chars and flatten all whitespace —
// the multi-line stored pending content and the single-line echoed copy normalize equal.
export function normalizePendingContent(s: string): string {
  // Slash commands: the pending row holds what the user typed ("/cmd args") but the JSONL
  // echo holds the expanded tag form ("<command-name>/cmd</command-name><command-args>args
  // </command-args>"). Canonicalize both to "/cmd args" so they match and the pending bubble
  // drops once the echo lands (otherwise the command renders twice).
  const cmd = parseCommandInvocation(s || "");
  if (cmd.cmdName) return `/${cmd.cmdName}${cmd.args ? " " + cmd.args.replace(/\s+/g, " ").trim() : ""}`;
  return (s || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyUserMessage(
  msg: Message,
  agentType?: string,
  immediatePrev?: Message | null,
  contextPrev?: Message | null,
): UserMessageKind {
  const hasUserImages = msg.images?.some(img => !img.tool_use_id);
  // A row carrying tool results is the harness answering tool calls; a person never
  // types into one. Any text on it ("Tool loaded.", a fork directive) is the harness's
  // postscript — the parser now folds it into the result, and rows synced before that
  // still carry it as content, so the text alone never makes this a prompt.
  if (isToolResultCarrier(msg) && !hasUserImages) {
    return { kind: 'tool_results_only' };
  }
  const content = msg.content;
  if (!content || !content.trim()) {
    return hasUserImages ? { kind: 'normal' } : { kind: 'empty' };
  }
  const t = stripPastedContent(content).trim();
  const tNoReminders = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, '').trim();
  const tStripped = stripSystemTags(t).trim();
  const handoff = parseSessionHandoff(tNoReminders);
  if (handoff) return { kind: 'session_handoff', handoff };
  if (tNoReminders.startsWith('<scheduled-task')) return { kind: 'scheduled_task' };
  // A spawned schedule run's opening prompt (plain-text wire format from
  // taskScheduler.buildPrompt) gets the same rich block as injected schedules.
  if (isSpawnedTaskPrompt(tNoReminders)) return { kind: 'scheduled_task' };
  const directUser = parseUserMessage(t);
  if (directUser) return { kind: 'direct_user', from: directUser.from, body: directUser.body };
  // A message from the staffing pane into a proposal's thread (S18): the
  // person's words under a quote of the row they were looking at; the reply
  // note the wrapper carries for the agent stays out of the bubble.
  const proposalMsg = parseProposalMessage(t);
  if (proposalMsg) return { kind: 'direct_user', from: proposalMsg.from, body: proposalMsg.about ? `> ${proposalMsg.about}\n\n${proposalMsg.body}` : proposalMsg.body };
  if (isRoleWakeFrame(tNoReminders)) {
    const frame = parseRoleWakeFrame(tNoReminders);
    if (frame) return { kind: 'role_wake', frame };
  }
  const sessionMsg = parseInboundSessionMessage(t);
  if (sessionMsg) {
    // A huddle that ended in this session's room: the digest rides the
    // session-message rail, but it is a call artifact, not a teammate's words.
    const huddle = parseHuddleSummaryTag(sessionMsg.body);
    if (huddle) return { kind: 'huddle_summary', huddle };
    return { kind: 'session_message', from: sessionMsg.from, body: sessionMsg.body, name: sessionMsg.name };
  }
  // Truncated wrappers (a preview slice, a torn JSONL line) still carry the
  // opening tag with `from=`, which is enough to keep them off the human rail.
  if (isSessionMessage(t)) {
    const authored = parseAgentAuthoredMessage(t);
    if (authored) {
      const huddle = parseHuddleSummaryTag(authored.body);
      if (huddle) return { kind: 'huddle_summary', huddle };
      return { kind: 'session_message', from: authored.from, body: authored.body };
    }
  }
  // A subagent reporting back to its parent arrives in the same shape under its
  // own tag, so it rides the same rail instead of reading as the human's words.
  if (isAgentMessage(t)) {
    const report = parseAgentAuthoredMessage(t);
    if (report) return { kind: 'session_message', from: report.from, body: report.body, variant: 'agent' };
  }
  {
    const huddle = parseHuddleSummaryTag(tNoReminders);
    if (huddle) return { kind: 'huddle_summary', huddle };
  }
  const chatWake = parseChatWakePrompt(t);
  if (chatWake) return { kind: 'chat_wake', wake: chatWake };
  const decisionAnswer = parseDecisionAnswer(tNoReminders);
  if (decisionAnswer) return { kind: 'decision_answer', decision: decisionAnswer };
  if (isPollResponsePayload(t)) return { kind: 'poll_response' };
  if (immediatePrev?.role === 'assistant' && immediatePrev?.tool_calls?.some(tc => isAskTool(tc.name))) {
    return { kind: 'poll_response' };
  }
  if (!tStripped) return { kind: 'noise' };
  // `!` bash mode: the typed command and its output arrive as two consecutive
  // user messages; they pair up into one terminal block at render time.
  const bashCmd = parseBashInput(tNoReminders);
  if (bashCmd !== null) return { kind: 'bash_input', command: bashCmd };
  const bashOut = parseBashOutput(tNoReminders);
  if (bashOut) return { kind: 'bash_output', stdout: bashOut.stdout, stderr: bashOut.stderr };
  if (isCommandMessage(tNoReminders)) {
    if (isModelSwitchStdout(tNoReminders)) {
      return { kind: "agent_switch", toLabel: modelSwitchStdoutLabel(tNoReminders) || "new model" };
    }
    if (isSkillExpansion(t)) {
      const cmdMatch = t.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/);
      return { kind: 'skill_expansion', cmdName: cmdMatch?.[1]?.replace(/^\//, "") };
    }
    if (immediatePrev?.role === 'user' && immediatePrev?.content && isCommandMessage(immediatePrev.content)) {
      const cmdMatch = t.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/) ||
                       immediatePrev.content.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/);
      return { kind: 'skill_expansion', cmdName: cmdMatch?.[1]?.replace(/^\//, "") };
    }
    // Hide /compact commands — the compact_boundary system message handles the visual separator
    const cmdName = t.match(/<command-(?:name|message)>\/?compact<\/command-(?:name|message)>/);
    if (cmdName || t === '/compact') return { kind: 'compaction_prompt' };
    const parsedCmd = parseCommandInvocation(tNoReminders);
    if (isModelSwitchCommandName(parsedCmd.cmdName)) {
      const label = parsedCmd.cmdName === "effort"
        ? `${parsedCmd.args || "effort"} effort`
        : (parsedCmd.args || "new model");
      return { kind: "agent_switch", toLabel: label };
    }
    return { kind: 'command' };
  }
  // Legacy stored form: command tags were stripped at sync time, leaving "name\n/name\nargs".
  // isCommandMessage misses it (no leading tag/slash), so catch it explicitly.
  if (isStrippedCommand(tNoReminders)) return { kind: 'command' };
  // Only Codex emits <turn_aborted>; classify by the message, not the conversation's
  // CURRENT agent_type, which changes when the conversation is switched to another agent.
  if (isCodexTurnAbortedMessage(t)) return { kind: 'interrupt', tone: 'amber' };
  if (isInterruptMessage(t)) return { kind: 'interrupt', tone: 'sky' };
  if (isAgentSwitchNotice(tNoReminders) || msg.subtype === "agent_switch") {
    const parsed = parseAgentSwitchNotice(tNoReminders);
    return { kind: "agent_switch", toLabel: parsed?.toLabel || "new agent", fromLabel: parsed?.fromLabel };
  }
  if (isModelSwitchStdout(tNoReminders)) {
    return { kind: "agent_switch", toLabel: modelSwitchStdoutLabel(tNoReminders) || "new model" };
  }
  if (isMachineSwitchNotice(tNoReminders) || msg.subtype === "machine_switch") {
    const parsed = parseMachineSwitchNotice(tNoReminders);
    return {
      kind: "machine_move",
      destination: parsed?.toLabel,
      fromLabel: parsed?.fromLabel,
      machineChanged: parsed?.machineChanged ?? true,
    };
  }
  if (isBackgroundAgentStoppedNotice(t)) return { kind: 'background_agent_stopped', agentName: backgroundAgentStoppedName(t) ?? undefined };
  if (isSkillExpansion(t)) return { kind: 'skill_expansion' };
  if (isTaskNotification(t)) {
    const stripped = t.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '').trim();
    if (!stripped || stripped.length < 4 || stripped.startsWith('Read the output file to retrieve the result:') || stripped.startsWith('Full transcript available at:')) return { kind: 'task_notification' };
  }
  if (immediatePrev?.role === 'assistant' && immediatePrev?.tool_calls?.some(tc => tc.name === 'Task' || tc.name === 'Agent')) {
    if (!tStripped) return { kind: 'task_prompt' };
  }
  if (isCompactionPromptMessage(t)) return { kind: 'compaction_prompt' };
  if (t.startsWith('Read the output file to retrieve the result:') || t.startsWith('Full transcript available at:')) return { kind: 'noise' };
  if (immediatePrev?.role === 'user') {
    const echoCmd = commandExpansionName(immediatePrev, msg);
    if (echoCmd !== null) return { kind: 'skill_expansion', cmdName: echoCmd };
  }
  if (contextPrev?.role === 'system' && contextPrev?.subtype === 'compact_boundary') {
    if (!tStripped) return { kind: 'noise' };
    return { kind: 'compaction_summary' };
  }
  if (t.includes('<teammate-message')) {
    const leftover = t
      .replace(/<teammate-message\s+[^>]*>[\s\S]*?<\/teammate-message>/g, '')
      .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
      .trim();
    // Pure teammate tags, or tags wrapped only in the harness's framing boilerplate, are
    // a teammate broadcast — render as a teammate event (no human avatar), not a user turn.
    if (!leftover || isTeammateFramingOnly(leftover)) {
      return { kind: 'teammate_events' };
    }
  }
  const planContent = extractPlanContent(t);
  if (planContent) return { kind: 'plan', planContent };
  const displayable = t
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<teammate-message\s+[^>]*>[\s\S]*?<\/teammate-message>/g, '')
    .replace(/\[Image[:\s][^\]]*\]/gi, '')
    .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, '')
    .trim();
  if (!displayable) {
    if (!immediatePrev && !contextPrev) return { kind: 'normal' };
    return hasUserImages ? { kind: 'normal' } : { kind: 'noise' };
  }
  if (displayable.startsWith("This session is being continued") || displayable.startsWith("Please continue the conversation")) {
    return { kind: 'continuation' };
  }
  if (STICKY_NOISE_PREFIXES.some(p => displayable.startsWith(p))) {
    return { kind: 'noise' };
  }
  // `cast send --raw` drops the session-message wrapper (the flag is for
  // slash commands). The body still arrives as a user-role turn, so without
  // this it renders under the human's name and avatar.
  const unwrappedReport = parseUnwrappedSessionReport(t);
  if (unwrappedReport) {
    return { kind: 'session_message', from: unwrappedReport.from, body: unwrappedReport.body, name: unwrappedReport.name };
  }
  return { kind: 'normal' };
}

export function isStickyWorthy(kind: UserMessageKind): boolean {
  // The sticky pill surfaces what the human said. Machine-delivered kinds
  // (session messages, teammate broadcasts, trigger runs) never qualify.
  return kind.kind === 'normal' || kind.kind === 'plan' || kind.kind === 'decision_answer';
}

export function findMatchingChild(
  prompt: string,
  childConversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }>,
): string | undefined {
  if (!childConversations || !prompt) return undefined;
  const subagents = childConversations.filter(c => c.is_subagent && c.first_message_preview);
  if (subagents.length === 0) return undefined;

  const promptStart = prompt.slice(0, 100).toLowerCase().trim();

  for (const child of subagents) {
    const preview = child.first_message_preview!.slice(0, 100).toLowerCase().trim();
    if (promptStart === preview || promptStart.startsWith(preview) || preview.startsWith(promptStart)) {
      return child._id;
    }
  }
  return undefined;
}

export function parseSpawnResult(content: string): { agentName?: string; teamName?: string; agentId?: string } | null {
  if (!content.startsWith("Spawned successfully")) return null;
  const lines = content.split("\n");
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) fields[m[1]] = m[2].trim();
  }
  return { agentName: fields.name, teamName: fields.team_name, agentId: fields.agent_id };
}

export function getFileExtension(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    cpp: "cpp", c: "c", h: "c", hpp: "cpp", cs: "csharp",
    json: "json", yaml: "yaml", yml: "yaml", md: "markdown",
    html: "html", css: "css", scss: "scss", sql: "sql",
    sh: "bash", bash: "bash", zsh: "bash", swift: "swift", kt: "kotlin",
  };
  return ext ? langMap[ext] : undefined;
}

export function isAlwaysVisibleToolCall(tc: ToolCall): boolean {
  // Monitor, background Bash, Workflow, and ScheduleWakeup stay visible in
  // condensed feeds: all are standing state the reader needs to know is armed
  // (a watch, a detached command, a running multi-agent fleet, a loop's next
  // fire), not a transient tool step. A sent file is here for a different
  // reason: it is addressed to the reader. Folding a delivery into a receipt
  // chip is how the file went unseen in the first place. `cast decide` is the
  // authored twin of AskUserQuestion — the card is the ask, not a command.
  return isPlanWriteToolCall(tc) || isAskTool(tc.name) || tc.name === "SendUserFile" || tc.name === "Monitor" || tc.name === "monitor" || tc.name === "Workflow" || tc.name === "workflow" || tc.name === "ScheduleWakeup" || isBackgroundBashToolCall(tc) || isDecideCastCommand(parseCastCommand(tc));
}

// A row that is nothing but tool calls: one-line receipts, not prose. The
// message already sets its own tight spacing (mb-0.5), so the row wrapper must
// not add the gutter a written turn needs — that gutter on top of a 16px
// receipt is what turned a stack of commands into a ladder of gaps.
export function isToolReceiptRow(msg: Message, showThinking: boolean): boolean {
  if (msg.role !== "assistant") return false;
  if (msg.content && msg.content.trim().length > 0) return false;
  if (showThinking && msg.thinking && msg.thinking.trim().length > 0) return false;
  return (msg.tool_calls?.length ?? 0) > 0;
}

// The id this row's own CLI output named. Verb-specific: a compound command
// (`cast decide cancel; cast decide "…"`) prints several ids, and the ask's
// `id:` line must not be read as the cancel's target.
export function decideOutputId(output: string, verb: DecideArgs["verb"]): string | null {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const pattern = verb === "cancel"
    ? /Decision withdrawn:\s*([a-z0-9]{20,})\b/
    : verb === "edit"
      ? /Decision updated:\s*([a-z0-9]{20,})\b/
      : /^\s*id:\s*([a-z0-9]{20,})\b/m;
  return clean.match(pattern)?.[1] ?? null;
}

// A slash command shows up in the transcript as two consecutive user messages: the
// invocation (<command-name> + <command-args>) and its expansion (the body of the
// command's .md file). parseCommandInvocation pulls the name + the args the user
// actually typed out of the first; cleanCommandExpansion strips the wrapper tags and
// skill preamble off the second so it renders as clean markdown.
//
// Three stored forms are handled:
//   tagged    "<command-message>x</command-message>\n<command-name>/x</command-name>\n<command-args>a</command-args>"
//   slash     "/x a"                                   (user-typed, single line)
//   stripped  "x\n/x\na"                               (legacy: tags removed, values kept on lines)
// The stripped form is what older sync versions persisted; isStrippedCommand
// (conversationProcessor) recognizes it so it still classifies + renders as a command.

export function parseCommandInvocation(raw: string): { cmdName: string; args: string } {
  const stripImages = (s: string) =>
    s.replace(/\[Image[:\s][^\]]*\]/gi, "").replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "").trim();
  const content = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
    .trim();
  const nameMatch =
    content.match(/<command-name>([^<]*)<\/command-name>/) ||
    content.match(/<command-message>([^<]*)<\/command-message>/);
  if (nameMatch) {
    const argsMatch = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
    return { cmdName: nameMatch[1].replace(/^\//, "").trim(), args: stripImages(argsMatch?.[1] ?? "") };
  }
  const stripped = isStrippedCommand(content);
  if (stripped) return { cmdName: stripped.cmdName, args: stripImages(stripped.rest) };
  const slash = content.match(/^\/([\w-]+)([\s\S]*)$/);
  if (slash) return { cmdName: slash[1], args: stripImages(slash[2] ?? "") };
  return { cmdName: "", args: stripImages(content) };
}

export function cleanCommandExpansion(raw: string): string {
  return raw
    .replace(/<command-name>[^<]*<\/command-name>\s*/g, "")
    .replace(/<command-message>[^<]*<\/command-message>\s*/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>\s*/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
    .replace(/^Base directory for this skill:[^\n]*\n?/, "")
    .trim();
}

function isInterruptMessage(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("[Request interrupted") || trimmed.startsWith("[Request cancelled");
}

function isTaskNotification(content: string): boolean {
  return content.trim().startsWith('<task-notification>');
}

export function parseTaskNotification(content: string) {
  const match = content.match(/<task-notification>[\s\S]*?<\/task-notification>/);
  return match ? parseTaskNotificationBlock(match[0]) : null;
}

function isCompactionPromptMessage(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return (
    trimmed.includes("Your task is to create a detailed summary of the conversation so far") ||
    (trimmed.startsWith("Your task is to create a detailed summary") && trimmed.includes("<summary>"))
  );
}

export function extractCompactionSummaryContent(content: string): string {
  if (!content) return "";
  const summaryMatch = content.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i);
  if (summaryMatch?.[1]) {
    return summaryMatch[1].trim();
  }
  return content.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();
}

export function parseSkillBlocks(text: string): { parts: Array<{ type: 'text' | 'skill'; content: string; skillName?: string; skillDesc?: string; skillPath?: string }>} {
  if (!text || typeof text !== 'string') {
    return { parts: [{ type: 'text', content: String(text || '') }] };
  }
  const parts: Array<{ type: 'text' | 'skill'; content: string; skillName?: string; skillDesc?: string; skillPath?: string }> = [];
  const skillRegex = /<skill>([\s\S]*?)<\/skill>/g;
  let lastIndex = 0;
  let match;
  while ((match = skillRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) parts.push({ type: 'text', content: before });
    }
    const inner = match[1];
    const nameMatch = inner.match(/<name>(.*?)<\/name>/);
    const pathMatch = inner.match(/<path>(.*?)<\/path>/);
    const descMatch = inner.match(/description:\s*(.+)/);
    parts.push({
      type: 'skill',
      content: match[0],
      skillName: nameMatch?.[1],
      skillDesc: descMatch?.[1]?.trim(),
      skillPath: pathMatch?.[1],
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) parts.push({ type: 'text', content: remaining });
  }
  if (parts.length === 0) parts.push({ type: 'text', content: text });
  return { parts };
}

export function parseContextBlocks(text: string): { contexts: ParsedContextBlock[]; remaining: string } {
  const contexts: ParsedContextBlock[] = [];
  const remaining = text.replace(
    /<context\s+type="([^"]+)"\s+title="([^"]+)"(?:\s+id="([^"]+)")?\s*>\s*([\s\S]*?)\s*<\/context>\s*/g,
    (_, type, title, tagId, inner) => {
      const ctx: ParsedContextBlock = { type, title };
      if (tagId) ctx.id = tagId;
      const idMatch = inner.match(/ID:\s*(\S+)/);
      const statusMatch = inner.match(/Status:\s*(\S+)/);
      const priorityMatch = inner.match(/Priority:\s*(\S+)/);
      if (!ctx.id && idMatch) ctx.id = idMatch[1];
      if (statusMatch) ctx.status = statusMatch[1];
      if (priorityMatch) ctx.priority = priorityMatch[1];
      contexts.push(ctx);
      return "";
    }
  ).trim();
  return { contexts, remaining };
}

export function parseTeammateMessages(text: string): TeammateMessagePart[] {
  if (!text || typeof text !== 'string') {
    return [{ type: 'text', content: String(text || '') }];
  }
  const parts: TeammateMessagePart[] = [];
  const regex = /<teammate-message\s+([^>]*)>([\s\S]*?)<\/teammate-message>/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) parts.push({ type: 'text', content: before });
    }
    const attrs = match[1];
    const inner = match[2].trim();
    const idMatch = attrs.match(/teammate_id="([^"]+)"/);
    const colorMatch = attrs.match(/color="([^"]+)"/);
    const summaryMatch = attrs.match(/summary="([^"]+)"/);
    parts.push({
      type: 'teammate',
      teammateId: idMatch?.[1] || 'agent',
      color: colorMatch?.[1],
      summary: summaryMatch?.[1],
      content: inner,
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) parts.push({ type: 'text', content: remaining });
  }
  return parts;
}

export function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// A workflow anchor's content is the exact JSON the server posts
// (convex/workflow_runs.ts). Fork/resume can round-trip that anchor through a
// synthetic transcript, producing an assistant copy WITHOUT the
// "workflow_event" subtype — detect by content so those copies still render
// as the card instead of raw JSON.
export function parseWorkflowEventContent(content: string | undefined): Record<string, any> | null {
  if (!content || !content.startsWith('{"__wf"')) return null;
  try { return JSON.parse(content); } catch { return null; }
}
