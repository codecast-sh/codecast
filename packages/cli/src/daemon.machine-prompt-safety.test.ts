import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isMachineDeliveredMessage } from "../../shared/contracts/machineMessages";
import { AGENT_CLIENTS, localAgentClient } from "../../shared/contracts/agentClients";
import { authorizesTeardown } from "../../shared/contracts/liveness";
import { isClaudeAutoContinueLine, isRecoveryContinueClientId, isUsageLimitDialog } from "../../shared/contracts/apiErrorBanner";
import { PendingDeliveryHeldError, createDeliveryAdmission } from "./pendingDeliveryAdmission";
import { LaunchPromptCarriedError, transcriptHasUserPrompt } from "./launchPrompt";
import { clearPromptHolds, holdConversationForPrompt, isForcedPastDialog, promptHoldRemainingMs, releasePromptHold, setForcedPastDialog, setPendingRedrive } from "./pendingPromptHold";
import { clientAcceptsBracketedPaste, deliverTextIntoPane, deliveryTimeoutMsFor, pasteAndSubmitText, prepareInjectedContent, stripComposerChrome, typedNewlineKey, PASTE_START, PASTE_END } from "./tmuxPaste";
import { blockAt, functionBlock } from "./test-helpers/sourceRegion";
import { TmuxDeliveryExhaustedError, TmuxDeliveryJournal, TmuxDeliveryUncertainError } from "./tmuxDeliveryJournal";
import { DeliveryEchoLedger } from "./deliveryEchoLedger";
import { canonicalSlashCommand, stampDeliveryId, withoutDeliveryId } from "@codecast/shared/contracts";
import { parseTranscriptFor } from "./parser";
import { DELIVERY_FAILED_SUBTYPE, formatDeliveryFailedNotice, parseDeliveryFailedNotice } from "@codecast/shared/contracts/deliveryFailed";
import { typedMenuReply, typedPollAnswer } from "./typedPollAnswer";
import { closeOwnCommandPanel, mayOpenPanel, paneDialogQuestion, rememberCommandPanel } from "./commandPanel";
import { redactSecrets } from "./redact";
import { stepTimer } from "./stepTimer";
import { setKnownValuesForTest } from "./knownValueRedaction";
import { CloudAgentHoldError, CloudAgentUnsentError } from "./cloudAgents/types";
import { SwapHeldError } from "./herdTake";
import { BlankStartHoldError, PromotionHoldError, RunLimitHoldError, TerminalHoldError } from "./terminalHold";
import { ForeignWriterHoldError } from "./foreignSessionWriter";
import { BackendSwitchHoldError } from "./claudeSdk/switchBackend";
import { ghosttyPane } from "./ghostty";
import { orcaPane } from "./orca";
import { unreachableTerminalOf } from "../../shared/contracts/deliveryHold";
import { CLAUDE_COMPOSER_SCROLLED_ABOVE, CLAUDE_COMPOSER_SCROLLED_BELOW, CLAUDE_OVERPAINTED_RULE, CLAUDE_TURN_STATUS_LINE, composerScrolledPastCaret, isClaudeRewindDialog } from "./tmuxPaneState.js";
import * as interactivePrompt from "./interactivePrompt";
import { planSessionTeardown } from "./sessionProcessMatcher";
import { planHandoffTarget } from "./planHandoff";
import { waitForHandHost } from "./handHostGrace";
import { materializeFileTags } from "../../shared/contracts/fileAttachment";
import { createHibernationHarness } from "./test-helpers/hibernationHarness";


// The fixture lifts delivery code out of daemon.ts by name; the pane classifiers
// it calls live in tmuxPaneState.ts, so both files are read as one source.
const source = ["./daemon.ts", "./tmuxPaneState.ts", "./pollMessage.ts"].map(file => fs.readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); clearPromptHolds(); setPendingRedrive(null); });
const poll = JSON.stringify({ __cc_poll: true, keys: ["Enter"], display: "Deploy" });
const session = (body: string) => `<session-message from="jxsrc01">\n${body}\n</session-message>`;
const menu = "Ship the change?\n❯ 1. Deploy\n  2. Deny\nEnter to select · Esc to cancel";
const cursorMenu = "Ship the change?\n❯ 1. Deploy\n  2. Deny";
const confirmation = "Confirm deployment\nPress Enter to continue · Esc to cancel";
const rule = "────────────────────────────────────────";
const box = (text = "", busy = false, topRule = rule) => `${topRule}\n❯ ${text}\n${rule}\n${busy ? "esc to interrupt" : "? for shortcuts"}`;
const fail = (name: string) => () => { throw new Error(`Unexpected effect: ${name}`); };

let fixtureFactory: ((...args: any[]) => any) | undefined;

function fixture(transport = "tmux", cached = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-prompt-guard-"));
  scratch.push(directory);
  const state = { menu: menu as string | null, composer: "", history: "", busy: false, topRule: undefined as string | undefined, captureFailure: false, captures: 0, ghosttyScriptable: true };
  const events: string[] = [];
  const bodies: string[] = [];
  const commands: string[] = [];
  const captureSizes: number[] = [];
  const reaped: number[] = [];
  const killed: string[] = [];
  const hooks = { resume: fail("resume") as (...args: unknown[]) => unknown, capture: () => {}, input: (_event: string) => {}, loaded: () => {}, exec: async (_args: string[]) => {}, prepare: async (): Promise<unknown> => null, markWrite: undefined as undefined | ((id: string) => Promise<unknown>), promote: async (_conversationId: string): Promise<void> => {} };
  const timers: Array<{ fn: () => unknown; ms: number; cancelled: boolean }> = [];
  const clock = { now: 1_000_000, steps: 0 };
  const step = (ms = 0) => {
    if (++clock.steps > 2000) throw new Error("fixture step cap exceeded");
    clock.now += ms;
  };
  const recordTimer = (fn: () => unknown, ms: number) => {
    step();
    const timer = { fn, ms, cancelled: false };
    timers.push(timer);
    return timer;
  };
  const capture = () => {
    step();
    hooks.capture();
    state.captures++;
    if (state.captureFailure) throw new Error("fixture capture unavailable");
    return state.menu ?? `${state.history}\n${box(state.composer, state.busy, state.topRule)}`;
  };
  const input = (event: string, text?: string) => {
    events.push(event);
    if (event === "paste") state.composer += text ?? "";
    if (event === "Enter") {
      if (state.menu) state.menu = null;
      else if (state.composer) {
        bodies.push(state.composer);
        state.history += `\n${state.composer}`;
        state.composer = "";
        state.busy = true;
      }
    }
    // A number key on a numbered menu submits that row, as Claude Code's does.
    if (/^\d$/.test(event) && state.menu) state.menu = null;
    if (["C-k", "C-u"].includes(event)) state.composer = "";
    hooks.input(event);
  };
  const buffers = new Map<string, string>();
  const tmuxExec = async (args: string[]) => {
    await hooks.exec(args);
    if (args[0] === "capture-pane") {
      const size = Math.abs(Number(args[args.indexOf("-S") + 1]));
      captureSizes.push(size);
      return { stdout: capture().split("\n").slice(-size).join("\n"), stderr: "" };
    }
    if (args[0] === "load-buffer") { buffers.set(args[2], fs.readFileSync(args[3], "utf8")); hooks.loaded(); }
    else if (args[0] === "paste-buffer") input("paste", buffers.get(args[args.indexOf("-b") + 1]));
    else if (args[0] === "delete-buffer") buffers.delete(args[2]);
    else if (args[0] === "send-keys") input(args.includes("-l") ? "paste" : args.at(-1)!, args.includes("-l") ? args.at(-1) : undefined);
    else if (args[0] !== "has-session") throw new Error(`Unexpected tmux command ${args.join(" ")}`);
    return { stdout: "", stderr: "" };
  };
  const unquote = (value: string) => value.replace(/'\\''/g, "'");
  const execAsync = async (command: string) => {
    commands.push(command);
    if (command.startsWith("kitty @ get-text") || command.startsWith("wezterm cli get-text")) return { stdout: capture() };
    if (command === "kitty @ ls") return { stdout: JSON.stringify([{ tabs: [{ windows: [{ id: 7, pid: 42 }] }] }]) };
    if (command.startsWith("ps -o tty=")) return { stdout: "ttys-test" };
    if (command === "wezterm cli list --format json") return { stdout: JSON.stringify([{ tty_name: "/dev/ttys-test", pane_id: 7 }]) };
    if (command.startsWith("kitty @ send-key")) input(command.endsWith(" enter") ? "Enter" : command.split(" ").at(-1)!);
    else if (command.startsWith("kitty @ send-text") && command.includes("--from-file")) {
      input("paste", fs.readFileSync(command.match(/--from-file '([^']+)'/)![1], "utf8"));
    } else if (command.startsWith("printf '%s' '")) {
      const value = unquote(command.slice("printf '%s' '".length, command.lastIndexOf("' | wezterm")));
      if (value === "\r") input("Enter");
      else input("paste", value);
    } else if (command.startsWith("osascript ")) {
      const invocation = command.match(/^osascript "([^"]+)" (.*)$/s)!;
      const script = fs.readFileSync(invocation[1], "utf8");
      if (!script.includes("set msgText to")) {
        expect(script).toMatch(/(?:write text|do script) "Enter"/);
        input("poll-script");
        return { stdout: "ok" };
      }
      const match = invocation[2].match(/^'(.*)' '([^']+)'$/s)!;
      const value = unquote(match[1]);
      if (value === "\r") input("Enter");
      else {
        input("paste", value.replace(PASTE_START, "").replace(PASTE_END, ""));
        if (script.includes('tell s to write text ""') || script.includes("do script msgText in t")) input("Enter");
      }
    } else throw new Error(`Unexpected terminal command: ${command}`);
    return { stdout: "ok" };
  };
  const prompt = { timestamp: 1, options: [{ label: "Deploy" }, { label: "Deny" }], isConfirmation: false };
  const pendingInteractivePrompts = new Map<string, typeof prompt>([["sid", prompt]]);
  const lastEmittedSyntheticPrompt = new Map([["sid", "card-1"]]);
  const closed: unknown[][] = [];
  let journal: TmuxDeliveryJournal | undefined;
  let echoes: DeliveryEchoLedger | undefined;
  const messages = new Map<string, any>();
  const statuses: Array<{ messageId: string; status: string }> = [];
  const holds: Array<{ id: string; holdReason?: string; holdScreen?: string }> = [];
  const injectedMessageTs = new Map<string, { ts: number; conversationId: string; confirmed: boolean; pasted: boolean }>();
  const injectedMarkWrites = new Map<string, Promise<unknown>>();
  const launchPromptCarries = new Map<string, { conversationId: string; tmuxSession: string; projectPath: string; sessionId: string; transcript: string; startedAt: number }>();
  const syncService = {
    getConversationOwnerInfo: async () => null,
    claimPendingMessageForDelivery: async (id: string) => messages.get(id) ?? { _id: id, conversation_id: "conv" },
    updateMessageStatus: async (args: any) => { statuses.push(args); },
    updateSessionAgentStatus: async () => {},
    retryMessage: async (id: string, opts?: { holdReason?: string; holdScreen?: string }) => {
      events.push(opts?.holdReason ? `hold:${id}` : `retry:${id}`);
      if (opts?.holdReason) holds.push({ id, ...opts });
    },
    setSessionError: async () => {},
    cancelPendingMessage: fail("cancel pending"),
    addMessage: fail("system row"),
  };
  const deps = {
    ...interactivePrompt,
    fs, os, path, randomUUID, CONFIG_DIR: directory, EXEC_TIMEOUT_MS: 1000,
    isMachineDeliveredMessage, AGENT_CLIENTS, localAgentClient, authorizesTeardown, PendingDeliveryHeldError, createDeliveryAdmission,
    LaunchPromptCarriedError, transcriptHasUserPrompt, launchPromptCarries,
    holdConversationForPrompt, promptHoldRemainingMs, releasePromptHold, typedPollAnswer, typedMenuReply, isForcedPastDialog, setForcedPastDialog,
    closeOwnCommandPanel, mayOpenPanel, paneDialogQuestion, rememberCommandPanel,
    clientAcceptsBracketedPaste, deliverTextIntoPane, deliveryTimeoutMsFor, pasteAndSubmitText, prepareInjectedContent, stripComposerChrome, typedNewlineKey, PASTE_START, PASTE_END,
    tmuxExec, execAsync, redactSecrets, stepTimer,
    // The delivery catch also holds a cloud agent's message; a hold re-drives the scan.
    // No cloud agent owns this fixture's conversation, so every one goes to the pane.
    CloudAgentHoldError, CloudAgentUnsentError, SwapHeldError, TerminalHoldError, RunLimitHoldError, ForeignWriterHoldError, BackendSwitchHoldError, BlankStartHoldError, PromotionHoldError, backendSwitchHeld: () => false, pollPendingNow: () => {},
    cloudAgents: { deliver: async () => null, forConversation: () => undefined, interrupt: async () => null },
    // A recovery continue restarts a pane that holds its own credential first;
    // this fixture's machine has no fleet store, so no pane is restarted.
    isRecoveryContinueClientId, fleetStoreReady: () => false,
    // Nor is any of its sessions a claude.ai cloud session: the watcher is off.
    claudeCloudRef: null, isClaudeAutoContinueLine, isUsageLimitDialog,
    _execFileAsync: async (binary: string, args: string[]) => {
      expect(binary).toBe("osascript");
      expect(args[0]).toBe("-e");
      expect(args[1]).toContain("return contents of");
      expect(args[1]).not.toContain("write text");
      expect(args[2]).toBe("/dev/ttys-test");
      return { stdout: capture() };
    },
    ensureTmuxPaneWide: async () => {}, glyphlessPromptPattern: () => null,
    classifyGlyphlessClientPaneState: fail("glyphless classification"), paneHasNoAgent: async () => false,
    acceptTrustPrompt: fail("trust input"), answerResumeCwdPicker: fail("cwd input"), DEAD_PANE_ERROR: "dead",
    CLAUDE_OVERPAINTED_RULE, composerScrolledPastCaret,
    // An agent is alive in the pane and it is not a headless run: the unknown-screen path's two questions.
    panePresenceVerdict: async () => "live", paneHeadlessAgent: async () => null,
    CLAUDE_TURN_STATUS_LINE,
    CLAUDE_COMPOSER_SCROLLED_ABOVE,
    CLAUDE_COMPOSER_SCROLLED_BELOW,
    log: () => {}, logDelivery: () => {}, logConvexFailure: fail("convex failure"),
    // Free variables of the lifted delivery path. The real helper where it is
    // importable; for the two that live in daemon.ts, the answer this fixture's
    // world gives: no transcript is on disk, and these panes are not Grok.
    deliveryStep: async <T>(_messageId: string, _step: string, run: () => Promise<T>): Promise<T> => run(),
    // Background priority is a no-op here: the fixture has no processes to lift.
    holdForDelivery: async () => {},
    awaitRecentSessionFile: async () => null,
    isGrokTrustDialog: () => false, isClaudeRewindDialog,
    tmuxTargetLocks: new Map(), TMUX_LOCK_WAIT_MS: 60000, hibernationInFlight: new Map(),
    Date: class extends Date {
      static now() { step(); return clock.now; }
    },
    recordTimer,
    setTimeout: (fn: () => unknown, ms: number) => {
      if (ms > 1000) return recordTimer(fn, ms);
      step(ms);
      const timer = { fn, ms, cancelled: false };
      queueMicrotask(() => { if (!timer.cancelled) fn(); });
      return timer;
    },
    clearTimeout: (timer: { cancelled: boolean }) => { timer.cancelled = true; },
    pendingInteractivePrompts, lastEmittedSyntheticPrompt,
    closeSyntheticPrompt: async (...args: unknown[]) => { closed.push(args); lastEmittedSyntheticPrompt.delete("sid"); },
    touchHostActivity: () => {}, pendingAgentSwitches: new Set(), planHandoffChildren: new Map(), planHandoffTarget, swapHeld: () => false,
    ownedByAnotherDevice: () => false, isRemoteDevice: () => false, codexAppServerInstance: undefined, readyCodexAppServer: async () => null,
    buildReverseConversationCache: () => cached ? { conv: "sid" } : {}, findSessionFile: () => ({ agentType: "claude" }),
    startedSessionTmux: new Map([["conv", { tmuxSession: "target", agentType: "claude", startedAt: clock.now }]]),
    deleteStartedSession: fail("delete started session"), readConversationCache: fail("recreation fallback"),
    hasTmux: () => true, resumeFatalReasons: new Map(), resumeSessionCache: new Map(),
    resumeShortId: (id: string) => id, resumeTmuxName: () => "target", syncServiceRef: undefined,
    readConfig: fail("full resume fallback"), isTmuxAgentAlive: async () => true,
    classifyClaudeResumeFatalReason: fail("fatal classification"),
    resolveLiveTmuxTarget: async () => transport === "tmux"
      ? { tmuxTarget: "target:0.0", source: "started" }
      : { tmuxTarget: null, proc: { pid: 4242, tty: "ttys-test", termProgram: transport } },
    markInjectedBestEffort: (_sync: unknown, id: string) => {
      const write = hooks.markWrite?.(id); if (write) injectedMarkWrites.set(id, write);
      statuses.push({ messageId: id, status: "injected" });
      injectedMessageTs.set(id, { ts: clock.now, conversationId: "conv", confirmed: false, pasted: false });
    },
    clearUnresolvablePane: () => {}, killTmuxSessionAndTree: async (name: string) => { killed.push(name); },
    // herdr's API answers, but no pane holds the agent's tty: the injector's
    // real failure when it cannot find the pane a person resumed the session in.
    findHerdrPaneForTty: async () => null, herdrRequest: fail("herdr request"),
    // Ghostty's AppleScript dictionary: paste, named keys and the screen dump.
    // Unscriptable stands for a Ghostty before 1.3, scripting turned off, or no Automation grant.
    ghosttyPane: (tty: string, bracketed: boolean, log: (line: string) => void) => ghosttyPane(tty, bracketed, log, {
      probe: async () => state.ghosttyScriptable ? { state: "ok" } : { state: "unscriptable", detail: "Not authorized to send Apple events to Ghostty. (-1743)" },
      inputText: async (_tty: string, text: string) => { input("paste", text); },
      sendKeys: async (_tty: string, keys: string[]) => { for (const key of keys) input(["\r", "Return"].includes(key) ? "Enter" : key); },
      readScreen: async () => capture(),
    }),
    // Orca's CLI: one live terminal for the agent's pane; `send --text` writes raw bytes.
    orcaPaneKeyOf: () => "tab-1:leaf-2",
    orcaPane: (paneKey: string | undefined, bracketed: boolean, log: (line: string) => void) => orcaPane(paneKey, bracketed, log, {
      cli: () => "/Applications/Orca.app/Contents/Resources/bin/orca",
      run: async (_cli: string, args: string[]) => {
        if (args[1] === "list") return JSON.stringify({ ok: true, result: { terminals: [{ handle: "term_t", tabId: "tab-1", leafId: "leaf-2", writable: true }] } });
        if (args[1] === "read") return JSON.stringify({ ok: true, result: { terminal: { latestCursor: "100", tail: args.includes("--cursor") ? capture().split("\n") : [] } } });
        const text = args[args.indexOf("--text") + 1];
        if (text === "\r") input("Enter");
        else if (text.startsWith("\x1b[200~")) input("paste", text.slice(6, -6));
        else if (/^[0-9]$/.test(text)) input(text);
        else input("paste", text);
        return JSON.stringify({ ok: true, result: {} });
      },
    }),
    hasOpenBackgroundWork: () => false, subagentActiveAgoMs: () => Infinity,
    planSessionTeardown, acquireSessionProcessOwnership: async () => "owned",
    reapPidTree: async (pid: number) => { reaped.push(pid); return 1; }, sessionProcessCache: new Map(),
    workflowAgentTranscriptPathFor: async () => null, isSessionCircuitOpen: () => false,
    // No session here is a subagent transcript (subagentPromotion.ts).
    holdForInProcessSubagent: (file: unknown, conversationId: string) => hooks.promote(conversationId),
    // No session here last ran by hand in another terminal (handHostGrace.ts).
    waitForHandHost, deadClaims: new Map(), registryRegistrationFor: () => null, MACHINE_BOOTED_AT: 0,
    resetSessionDeliveryFailures: () => {}, materializedSessions: new Set(), postDeliveryHealthCheck: async () => {},
    autoResumeSession: (...args: unknown[]) => hooks.resume(...args), repairAndResumeSession: fail("repair"), materializeSession: fail("materialize"),
    // The delivery path's resume-then-repair step (daemon.ts resumeOrRepair), minus its transfer-cancel bookkeeping.
    resumeOrRepair: async (_session: string, resume: () => Promise<boolean>, repair: () => Promise<boolean>) =>
      (await resume()) ? "resumed" : (await repair()) ? "repaired" : null,
    restoreSuspendedAgent: async () => false,
    prepareTmuxDelivery: async () => hooks.prepare(), TmuxDeliveryUncertainError, TmuxDeliveryExhaustedError,
    DELIVERY_FAILED_SUBTYPE, formatDeliveryFailedNotice,
    // No message here carries a web-attached file tag, so nothing is fetched.
    materializeFileTags, downloadAttachedFile: fail("downloadAttachedFile"),
    // The receipt journal the inject path opens when a delivery identity rides
    // along: a private one per fixture, so no test reads the machine's.
    tmuxDeliveryJournal: () => (journal ??= new TmuxDeliveryJournal(path.join(directory, "delivery.sqlite"))),
    deliveryEchoLedger: () => (echoes ??= new DeliveryEchoLedger(path.join(directory, "echoes.sqlite"))),
    stampDeliveryId, withoutDeliveryId, canonicalSlashCommand,
    parseTranscriptFor,
    selfHealIfTimersStalled: () => {}, assertLegacyDeliveryEnvelope: () => {},
    messagesInFlight: new Map(), conversationDeliveryActive: new Set(), injectedMessageTs,
    IN_FLIGHT_HARD_TTL_MS: 10000, compactionRedeliveryBypass: new Set(), injectionDedupWindowMs: () => 10000,
    messageRetryTimers: new Set(), injectedMarkWrites, syncService, conversationCache: cached ? { sid: "conv" } : {}, titleCache: {},
    sendAgentStatus: () => {}, awaitDeliveryEcho: () => {}, recentSessionInjections: new Map(), resetReconnectDelay: () => {},
    checkForInteractivePrompt: async () => {},
    claudeSdkBackend: null,
  };
  if (!fixtureFactory) {
    const names = [
      "parsePollMessage", "pollDeclineText", "pollMenuSteps", "extractTmuxLiveRegion", "newestPaintedFrame", "isCodexTrustDialog", "isCodexUpdateDialog", "isCursorLoginScreen", "isCodexLoginScreen", "isGrokLoginScreen", "agentAtLoginScreen", "isAgentLoginScreen", "signedOutError", "composerReadHeight", "isClaudeBypassWarning",
      "classifyTmuxLiveState", "backgroundAgentPanelOnPane", "claudeTurnRunningOnPane", "livenessFromTmuxState", "isResumeCwdPicker", "turnStartedAtFor", "paneTextAfterLastMatch",
      "isDeliveryVerdict", "assertPromptAbsent", "inputGuard", "captureTmuxLiveState", "autoContinueArmedOnPane", "ensureTmuxReady", "withTmuxLock", "drainTmuxComposer", "tmuxComposerText", "tmuxComposerDraft",
      "tmuxWatchablePrefix", "promptIsOwnText", "holdScreen", "surfaceHeldDialog", "tmuxComposerPayloadMatcher", "tmuxComposerHoldsPayload", "composerShowsOnlyPayloadTail", "matchAtFullWindowSize", "awaitTmuxComposerPayload", "normalizePromptText",
      "captureTmuxComposerPane", "stripAnsi", "stripTmuxFaintText", "lineEndingAt", "skipSuggestionMenu", "composerTextStart", "tmuxComposerRegion", "tmuxPromptStillHasInput", "tmuxPromptShowsPastePlaceholder", "pasteChipLines", "pasteChipContradicts",
      "tmuxPaneShowsBlockingPrompt", "takeTmuxSubmitVerdict", "recordTmuxSubmitVerdict", "verifyTmuxSubmitAfterPaste", "runTmuxSubmitVerify",
      "deliverIntoPane", "paneInteractiveQuestion", "paneInteractivePrompt", "transcriptEchoes", "injectViaTmux", "injectViaTmuxInner",
      "planHighlightStep", "selectRowHasLabel", "highlightFailureCount", "trustHighlightHold", "selectHighlightedOption", "isClaudeIdleResumeDialog", "isIdleResumeOptionRow",
      "buildAppleScript", "captureAppleScriptPane", "injectViaAppleScript", "writeTerminalInjectionScript",
      "findKittyWindowId", "mapKeyForKitty", "kittySendText", "writeKittyInjectionPayload", "injectViaKitty",
      "findWezTermPaneId", "weztermSendText", "weztermSendKeys", "injectViaWezTerm", "injectViaGhostty", "herdrKey", "injectViaHerdr", "noteUnreachableAgent", "noteUnresolvablePane", "injectThroughPane", "normalizeTty", "getTerminalLabel", "terminalLacksInjector", "injectViaTerminal",
      "deliverMessage", "deliverMessageIntoSession", "launchPromptCarried", "settleLaunchPrompt", "injectedMarkSettled", "rependAfterAttempt",
      "autoResumeSessionInner", "probeStartedPane", "classifyStartedPane", "paneContentAfterLaunchEcho", "heldFatal",
    ];
    const constants = [
      "RESUME_CWD_PICKER_RE", "COMPOSER_RULE", "HOLD_SCREEN_ROWS", "UNREADABLE_SCREEN_HOLD_REASON", "MID_TURN_COMMAND_HOLD_REASON", "TURN_SPINNER_OR_INTERRUPT", "DRAIN_MAX_CYCLES", "TMUX_WINDOW_WIDTH", "TMUX_WINDOW_HEIGHT", "TMUX_SIZE_ARGS", "INJECTABLE_TERMINALS", "DELIVERY_TIMEOUT_MS", "IN_FLIGHT_GRACE_MS", "TRUST_PROMPT_RE",
      "PANE_TITLE_WORKING", "PANE_REBUILD_THRESHOLD", "PANE_REBUILD_WINDOW_MS", "PANE_REBUILD_MIN_GAP_MS", "unresolvablePanes", "UNRESOLVABLE_PANE_ERRORS", "highlightFailures", "highlightPane", "HIGHLIGHT_HOLD_AFTER_FAILURES", "HIGHLIGHT_HOLD_REASON", "SUBMIT_VERDICT_TTL_MS", "submitVerdicts", "INJECTED_MARK_SETTLE_CAP_MS",
      "ANSI_ESCAPE_RE", "MACHINE_WAKE_IDLE_RESUME_CHOICE", "LAUNCH_PROMPT_CARRY_MS", "LAUNCH_PROMPT_SETTLE_MS", "LAUNCH_SCRIPTS_DIRNAME", "STARTED_FATAL_CONFIRM_MS", "fatalPaneSince",
    ].map(name => {
      const line = source.split("\n").find(l => new RegExp(`^(?:export )?\\s*const ${name} =`).test(l));
      if (!line) throw new Error(`Missing constant ${name}`);
      return line.replace("export ", "");
    });
    const resume = functionBlock(source, "autoResumeSessionInner").text;
    const readiness = blockAt(resume, resume.indexOf("    while (Date.now() - startTime < maxPollMs)")).text;
    const warnings = blockAt(resume, resume.indexOf("    if (ready || !content)")).text;
    const fastProbe = blockAt(resume, resume.indexOf("  if (agentTypeHint)")).text;
    const resumeFatalStart = resume.indexOf("const fatalErrors = [");
    const resumeFatalErrors = resume.slice(resumeFatalStart, resume.indexOf("];", resumeFatalStart) + 2);
    const resumeScope = 'const sessionId = "sid", shortId = "sid", agentType = "claude", tmuxSession = "target", promptPattern = /[❯›]/;';
    const catches = [fastProbe, readiness, warnings, resume].map((region, i) => {
      const handler = region.slice(region.lastIndexOf("catch (err) {"), region.lastIndexOf("\n"));
      return `async function propagation${i}(error) { ${resumeScope} try { throw error; } ${handler} return "fallback"; }`;
    });
    const fatalStart = source.indexOf("const STARTED_PANE_FATAL_ERRORS =");
    // Multi-line array constants: the one-line reader above cannot take these.
    const arrayConst = (name: string): string => {
      const start = source.indexOf(`const ${name} =`);
      if (start < 0) throw new Error(`Missing constant ${name}`);
      return source.slice(start, source.indexOf("];", start) + 2);
    };
    const code = [
      blockAt(source, source.indexOf("class InputBlockedError")).text,
      blockAt(source, source.indexOf("class UnreadableScreenError")).text,
      blockAt(source, source.indexOf("const WEZTERM_KEY_SEQUENCES:")).text.replace(/},?$/, "};"),
      "class UndeliverableMessageError extends Error {}",
      source.slice(fatalStart, source.indexOf("];", fatalStart) + 2),
      arrayConst("CODEX_PERMISSION_PATTERNS"),
      ...constants,
      ...names.map(name => functionBlock(source, name).text),
      `const scheduleMessageRetry = ((setTimeout) => { ${functionBlock(source, "scheduleMessageRetry").text}; return scheduleMessageRetry; })(recordTimer);`,
      ...catches,
      `async function resumeReadiness(content) { ${resumeScope} ${resumeFatalErrors} const startTime = Date.now(), maxPollMs = 100; let ready = false; ${readiness} return ready; }`,
      `async function resumeWarnings(content) { ${resumeScope} const ready = true; ${warnings} }`,
      blockAt(source, source.indexOf("  const handlePendingMessageBatch = async")).text,
      "const handlePendingMessagesUpdate = handlePendingMessageBatch;",
    ].join("\n").replace(/^export /gm, "");
    fixtureFactory = new Function(...Object.keys(deps), new Bun.Transpiler({ loader: "ts" }).transformSync(code) +
      "; return { deliverMessage, injectViaTmux, injectViaTerminal, handlePendingMessagesUpdate, scheduleMessageRetry, parsePollMessage, parseInteractivePrompt, buildAppleScript, inputGuard, assertPromptAbsent, InputBlockedError, autoResumeSessionInner, probeStartedPane, resumeReadiness, resumeWarnings, propagation: [propagation0, propagation1, propagation2, propagation3], MID_TURN_COMMAND_HOLD_REASON };") as (...args: any[]) => any;
  }
  const api = fixtureFactory(...Object.values(deps));
  return {
    ...api, reaped, killed, state, events, bodies, holds, commands, captureSizes, hooks, timers, clock, prompt, launchPromptCarries, directory, pendingInteractivePrompts, lastEmittedSyntheticPrompt, closed, statuses, deps,
    deliver: (body: string, id = "update") => api.deliverMessage("conv", body, deps.conversationCache, syncService, id, {}),
    scan: async (rows: Array<{ _id: string; content: string; delivery_force?: boolean }>) => {
      for (const row of rows) messages.set(row._id, { ...row, conversation_id: "conv" });
      await api.handlePendingMessagesUpdate([...messages.values()].filter(row => rows.some(r => r._id === row._id)));
    },
  };
}

describe("machine prompt delivery safety", () => {
  test("skips the optional Codex update before delivering the original message", async () => {
    const f = fixture();
    f.state.menu = "Update available! 0.154.0 -> 0.155.1\n› 1. Update now (runs `bun install -g @openai/codex`)\n  2. Skip\n  3. Skip until next version\nPress enter to continue";
    f.hooks.input = (event: string) => {
      if (f.state.menu) {
        expect(event).toBe("Escape");
        f.state.menu = null;
      }
    };
    await expect(f.deliver("preserve the queued question")).resolves.toBe(true);
    expect(f.events[0]).toBe("Escape");
    expect(f.bodies).toEqual(["preserve the queued question"]);
  });

  // The seven panes of 2026-10-04: an armed automatic continue under a live
  // composer. A recovery "continue" must cancel the wait with one Escape and
  // then land, never press a second Escape (that opens Rewind).
  test("cancels Claude Code's armed limit wait with one Escape, then delivers", async () => {
    const f = fixture();
    f.state.menu = `${box()}\n  ⚠ Usage limit reached · limit resets Oct 5 at 3pm\n    Continuing automatically at Oct 5 at 3pm · esc to cancel · /usage-credits to continue now`;
    f.hooks.input = (event: string) => {
      if (event === "Escape") {
        expect(f.state.menu).not.toBeNull();
        f.state.menu = null;
      }
    };
    await expect(f.deliver("continue")).resolves.toBe(true);
    expect(f.events.filter((e: string) => e === "Escape")).toEqual(["Escape"]);
    expect(f.bodies).toEqual(["continue"]);
  });

  // jx7f403, 2026-11-11: the limit dialog closed on the first Escape, but the
  // next capture still showed it, so the corrective pressed twice more 0.5s
  // apart. Those Escapes landed on an empty composer and opened Rewind, which
  // then held every message. A modal gets one Escape; after it, wait for the
  // repaint.
  test("dismisses the limit dialog with one Escape even when the repaint lags", async () => {
    const f = fixture();
    const dialog = [
      "  ⎿  You've hit your weekly limit · resets Nov 16 at 1pm (America/New_York)",
      "▔".repeat(120),
      "   What do you want to do?",
      "   ❯ 1. Stop and wait for limit to reset",
      "     2. Wait here, then continue automatically at Nov 16 at 1pm",
      "     3. Switch to usage credits",
      "   Enter to confirm · Esc to cancel",
    ].join("\n");
    f.state.menu = dialog;
    let staleCaptures = 0;
    f.hooks.capture = () => { if (staleCaptures > 0 && --staleCaptures === 0) f.state.menu = null; };
    f.hooks.input = (event: string) => {
      if (event === "Escape" && staleCaptures === 0) staleCaptures = 3;
    };
    await expect(f.deliver("continue")).resolves.toBe(true);
    expect(f.events.filter((e: string) => e === "Escape")).toEqual(["Escape"]);
    expect(f.bodies).toEqual(["continue"]);
  });

  test("a timed-out waiter does not steal the active terminal writer's lock", async () => {
    const f = fixture();
    const active = new Promise<void>(() => {});
    f.deps.tmuxTargetLocks.set("target", active);
    await expect(f.injectViaTmux("target:0.0", "continue", "claude")).rejects.toThrow("earlier delivery still owns");
    expect(f.deps.tmuxTargetLocks.get("target")).toBe(active);
    expect(f.events).toEqual([]);
  });

  test("waiting for input confirmation does not exhaust the retry budget", async () => {
    const f = fixture();
    const calls: unknown[][] = [];
    f.deps.syncService.retryMessage = async (...args: unknown[]) => { calls.push(args); };
    f.scheduleMessageRetry("update", 10, "conv", "continue", "waiting for terminal input confirmation");
    expect(f.statuses).toEqual([]);
    expect(f.timers[0].ms).toBe(5000);
    await f.timers[0].fn();
    expect(calls).toEqual([["update", { holdReason: "waiting for terminal input confirmation" }]]);
  });

  test.each([10, 12, 100])("retry %s keeps the original message eligible for delivery", async retryCount => {
    const f = fixture();
    f.state.menu = null;
    f.scheduleMessageRetry("update", retryCount, "conv", "continue");
    expect(f.statuses).toEqual([]);
    expect(f.timers[0].ms).toBe(300000);
    await f.scan([{ _id: "update", content: "continue", retry_count: retryCount } as any]);
    expect(f.bodies).toEqual([]);
    await f.timers[0].fn();
    expect(f.events).toEqual(["retry:update"]);
    await f.scan([{ _id: "update", content: "continue", retry_count: retryCount + 1 } as any]);
    expect(f.bodies).toEqual(["continue"]);
    expect(f.statuses.some((row: any) => row.status === "undeliverable")).toBe(false);
  });

  test("a failed retry write schedules another attempt", async () => {
    const f = fixture();
    f.deps.syncService.retryMessage = async () => { throw new Error("connection lost"); };
    f.scheduleMessageRetry("update", 10, "conv", "continue");
    await f.timers[0].fn();
    expect(f.timers).toHaveLength(2);
    expect(f.timers[1].ms).toBe(300000);
    expect(f.deps.messageRetryTimers.has("update")).toBe(true);
    expect(f.statuses).toEqual([]);
  });

  test("a deleted message retires its retry timer", async () => {
    const f = fixture();
    f.deps.syncService.retryMessage = async () => { throw new Error("Message not found"); };
    f.scheduleMessageRetry("update", 10, "conv", "continue");
    await f.timers[0].fn();
    expect(f.timers).toHaveLength(1);
    expect(f.deps.messageRetryTimers.has("update")).toBe(false);
  });

  test.each([true, false])("a held delivery preserves observed agent status (cached=%s)", async cached => {
    const f = fixture("tmux", cached);
    const statuses: string[] = [];
    f.deps.syncService.updateSessionAgentStatus = async (_id: string, status: string) => { statuses.push(status); };
    await f.scan([{ _id: "update", content: session("continue") }]);
    expect(statuses).toEqual([]);
    expect(f.bodies).toEqual([]);
  });

  test("fixture resolves a one-second delivery sleep while retry timers stay controlled", async () => {
    const f = fixture();
    const start = f.clock.now;
    f.scheduleMessageRetry("update", 0, "conv", session("context"));
    await new Promise<void>(resolve => f.deps.setTimeout(resolve, 1000));
    expect(f.clock.now).toBe(start + 1000);
    expect(f.events).toEqual([]);
    expect(f.timers).toHaveLength(1);
    expect(f.timers[0].ms).toBe(1000);
    await f.timers[0].fn();
    expect(f.events).toEqual(["retry:update"]);
  });

  test("fixture bounds a zero-delay microtask spin", async () => {
    const f = fixture();
    const spin = async () => {
      while (true) await new Promise<void>(resolve => f.deps.setTimeout(resolve, 0));
    };
    await expect(spin()).rejects.toThrow("fixture step cap exceeded");
  });

  for (const format of [session]) {
    for (const body of ["Do not Deploy yet", "yes", "deny", poll]) {
      test(`${format.name}: ${body} preserves content and both prompt caches`, async () => {
        const f = fixture();
        const content = format(body);
        await expect(f.deliver(content)).rejects.toThrow("terminal is waiting for a human answer");
        expect(f.events).toEqual([]);
        expect(f.pendingInteractivePrompts.get("sid")).toBe(f.prompt);
        expect(f.lastEmittedSyntheticPrompt.get("sid")).toBe("card-1");
        expect(f.closed).toEqual([]);
        f.state.menu = null;
        await expect(f.deliver(content)).resolves.toBe(true);
        expect(f.bodies).toEqual([content]);
        expect(f.pendingInteractivePrompts.get("sid")).toBe(f.prompt);
      });
    }
  }

  test.each([menu, cursorMenu, confirmation])("tmux blocks a real menu before Escape, drain, paste or Enter: %s", async pane => {
    const f = fixture();
    f.state.menu = pane;
    await expect(f.injectViaTmux("target:0.0", session("yes"))).rejects.toThrow("human answer");
    expect(f.events).toEqual([]);
  });

  for (const format of [session]) {
    test.each([menu, confirmation])(`${format.name}: full literal dialog inside the composer submits once`, async literal => {
      const f = fixture();
      f.state.menu = null;
      const content = format(`Observed output:\n${literal}\nThis is quoted evidence, not an answer.`);
      await expect(f.deliver(content)).resolves.toBe(true);
      expect(f.bodies).toEqual([content]);
      expect(f.events.filter((event: string) => event === "Enter")).toHaveLength(1);
      expect(f.pendingInteractivePrompts.get("sid")).toBe(f.prompt);
    });
  }

  test.each([
    '    Explanation: the help text says "? for shortcuts".',
    '    Example input looks like ❯ ready, but this option has not been answered.',
    '    The running view says "esc to interrupt"; this is still a choice.',
  ])("a real menu still blocks when its explanation quotes composer text: %s", async explanation => {
    const f = fixture();
    f.state.menu = menu.replace("Enter to select", `${explanation}\nEnter to select`);
    await expect(f.deliver(session("context only"))).rejects.toThrow("human answer");
    expect(f.events).toEqual([]);
  });

  test.each([menu, confirmation])("long session message retains composer opening when quoting a dialog near its tail: %s", async literal => {
    const f = fixture();
    f.state.menu = null;
    const body = `${Array.from({ length: 160 }, (_, i) => `Evidence line ${i}`).join("\n")}\n${literal}`;
    const content = session(body);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(8192);
    await expect(f.deliver(content)).resolves.toBe(true);
    expect(f.bodies).toEqual([content]);
    expect(f.events.filter((event: string) => event === "Enter")).toHaveLength(1);
    expect(f.captureSizes.some((size: number) => size > 160)).toBe(true);
  });

  test("machine structural option does not change default parser behavior", () => {
    const f = fixture();
    const quoted = menu.replace("Enter to select", '    Explanation: "? for shortcuts" is quoted.\nEnter to select');
    expect(f.parseInteractivePrompt(quoted)).toBeNull();
    expect(f.parseInteractivePrompt(quoted, true)?.options.map((option: { label: string }) => option.label)).toEqual(["Deploy", "Deny"]);
    expect(f.parseInteractivePrompt(`${menu}\n${box()}`, true)).toBeNull();
  });

  test("human typed option and a card click press the same key", async () => {
    const cardClick = JSON.stringify({ __cc_poll: true, keys: ["1"], display: "Deploy" });
    for (const answer of ["Deploy", "1", cardClick]) {
      const f = fixture();
      await expect(f.deliver(answer, "answer")).resolves.toBe(true);
      expect(f.events).toEqual(["1"]);
      expect(f.state.menu).toBeNull();
      expect(f.pendingInteractivePrompts.has("sid")).toBe(false);
      expect(f.closed).toHaveLength(1);
    }
  });

  test.each(["yes", "no"])("human confirmation is preserved: %s", async answer => {
    const f = fixture();
    f.prompt.isConfirmation = true;
    f.state.menu = confirmation;
    await expect(f.deliver(answer)).resolves.toBe(true);
    expect(f.events).toEqual([answer === "yes" ? "Enter" : "Escape"]);
    expect(f.closed).toHaveLength(1);
  });

  test("unrelated web decisions and historical menu prose do not hold a fresh composer", async () => {
    const f = fixture();
    f.state.menu = null;
    f.state.history = menu;
    await expect(f.deliver(session("new evidence"))).resolves.toBe(true);
    expect(f.bodies).toEqual([session("new evidence")]);
    expect(f.closed).toHaveLength(0);
  });

  test("ordinary human prose and slash input retain their exact body", async () => {
    for (const body of ["Please continue the investigation", "/compact"]) {
      const f = fixture();
      f.state.menu = null;
      f.pendingInteractivePrompts.clear();
      await expect(f.deliver(body)).resolves.toBe(true);
      expect(f.bodies).toEqual([body]);
    }
  });

  test("a busy ready composer still receives normal machine delivery without interrupting", async () => {
    const f = fixture();
    f.state.menu = null;
    f.state.busy = true;
    await expect(f.deliver(session("new context"))).resolves.toBe(true);
    expect(f.bodies).toEqual([session("new context")]);
    expect(f.events).not.toContain("Escape");
  });

  // jx7ey2y, 2026-11-20: the web's "/model opus" was typed into the turn a
  // resumed session's "continue" had started. Claude Code queued it and never
  // ran it, so the session stayed on Fable and every resume relaunched it there.
  describe("a slash command sent mid-turn", () => {
    const queue = [{ _id: "model", content: "/model opus" }, { _id: "next", content: "continue" }];
    const midTurn = () => {
      const f = fixture();
      f.state.menu = null;
      f.pendingInteractivePrompts.clear();
      f.state.busy = true;
      return f;
    };

    test("waits out the turn, then goes in ahead of the message queued behind it", async () => {
      const f = midTurn();
      await f.scan(queue);
      // Nothing typed. The command is held with its reason, without spending a retry.
      expect(f.bodies).toEqual([]);
      expect(f.state.composer).toBe("");
      expect(f.events).toEqual(["hold:model"]);
      expect(f.holds).toEqual([{ id: "model", holdReason: f.MID_TURN_COMMAND_HOLD_REASON }]);
      expect(f.timers.filter((t: { ms: number; cancelled: boolean }) => t.ms === 1000 && !t.cancelled)).toEqual([]);
      // While the turn runs the conversation is skipped, so "continue" stays behind it.
      await f.scan(queue);
      expect(f.bodies).toEqual([]);
      expect(f.events).toEqual(["hold:model"]);
      // The turn settles: the status write releases the hold and runs the scan again.
      let redriven = 0;
      setPendingRedrive(() => { redriven++; });
      f.state.busy = false;
      const status = createHibernationHarness();
      status.trackSessionPaneForTests("sid", "target", { status: "thinking" });
      status.sendAgentStatus({ updateSessionAgentStatus: async () => true }, "conv", "sid", "idle");
      expect(redriven).toBe(1);
      expect(promptHoldRemainingMs("conv")).toBe(0);
      await f.scan(queue);
      expect(f.bodies).toEqual(["/model opus", "continue"]);
    });

    test("is not held on an idle pane that only reads busy", async () => {
      // An idle compaction leaves the turn status line painted over the
      // composer's top rule (jx7aztd). That pane reads busy, but no turn runs
      // there, and a command held on it would wait for hours.
      const f = midTurn();
      f.state.busy = false;
      f.state.topRule = `✽─Jitterbugging… ───1──4──13${"─".repeat(40)}`;
      await f.scan([queue[0]]);
      expect(f.bodies).toEqual(["/model opus"]);
    });

    test("goes in mid-turn when the sender chose Send anyway", async () => {
      const f = midTurn();
      await f.scan([{ ...queue[0], delivery_force: true }]);
      expect(f.bodies).toEqual(["/model opus"]);
    });
  });

  for (const cached of [true, false]) test.each([
    menu,
    menu.replace("Enter to select", '    Explanation: "? for shortcuts" is quoted.\nEnter to select'),
    menu.replace("Enter to select", '    Explanation: "esc to interrupt" is quoted.\nEnter to select'),
  ])(`held update releases the legacy slot for a human answer and one retry (cached=${cached}): %s`, async pane => {
    const f = fixture("tmux", cached);
    f.state.menu = pane;
    const content = session("Do not Deploy yet");
    await f.scan([{ _id: "update", content }, { _id: "answer", content: poll }]);
    expect(f.state.menu).toBeNull();
    expect(f.bodies).toEqual([]);
    // The refused update is HELD (re-pended without spending a retry), the
    // human's answer is never held, and delivering it releases the hold.
    expect(f.events).toEqual(["hold:update", "Enter"]);
    expect(f.timers.filter((t: { ms: number; cancelled: boolean }) => t.ms === 1000 && !t.cancelled)).toEqual([]);
    expect(promptHoldRemainingMs("conv")).toBe(0);
    expect(f.deps.messagesInFlight.size).toBe(0);
    expect(f.deps.conversationDeliveryActive.size).toBe(0);
    expect(f.deps.tmuxTargetLocks.size).toBe(0);
    expect(f.deps.injectedMessageTs.has("update")).toBe(false);
    expect(f.statuses.filter((s: { status: string }) => s.status === "delivered" || s.status === "undeliverable")).toEqual([]);
    await f.scan([{ _id: "update", content }]);
    expect(f.bodies).toEqual([stampDeliveryId(content, "update")]);
    await f.scan([{ _id: "update", content }]);
    expect(f.bodies).toEqual([stampDeliveryId(content, "update")]);
  });

  test("a held conversation is skipped without touching the pane until the prompt closes", async () => {
    const f = fixture();
    const content = session("status update");
    await f.scan([{ _id: "held", content }]);
    expect(f.bodies).toEqual([]);
    expect(f.events).toEqual(["hold:held"]);
    expect(f.timers.filter((t: { ms: number; cancelled: boolean }) => t.ms === 1000 && !t.cancelled)).toEqual([]);
    expect(promptHoldRemainingMs("conv")).toBeGreaterThan(0);
    const captures = f.state.captures;
    await f.scan([{ _id: "held", content }]);
    expect(f.state.captures).toBe(captures);
    expect(f.events).toEqual(["hold:held"]);
    let redriven = 0;
    setPendingRedrive(() => { redriven++; });
    f.state.menu = null;
    expect(releasePromptHold("conv")).toBe(true);
    expect(redriven).toBe(1);
    await f.scan([{ _id: "held", content }]);
    expect(f.bodies).toEqual([stampDeliveryId(content, "held")]);
  });

  // jx78gaw (2026-10-10): a message held for a dialog nobody was shown sat
  // for days with no way to move it. The hold now carries the screen it was
  // decided on, and the person's Send anyway delivers it past the check.
  test("a hold carries the screen it was decided on, and Send anyway delivers past it", async () => {
    const f = fixture();
    f.pendingInteractivePrompts.clear();
    f.state.menu = menu;
    await f.scan([{ _id: "held", content: "please continue" }]);
    expect(f.events).toEqual(["hold:held"]);
    expect(f.holds[0]?.holdScreen).toContain("❯ 1. Deploy");
    expect(promptHoldRemainingMs("conv")).toBeGreaterThan(0);
    // Past the check, the paste path clears the pane as it does any overlay:
    // Escape dismisses the dialog, then the message goes in.
    f.hooks.input = (event: string) => { if (event === "Escape") f.state.menu = null; };
    await f.scan([{ _id: "held", content: "please continue", delivery_force: true }]);
    expect(f.bodies).toEqual(["please continue"]);
    expect(f.events.filter((e: string) => e.startsWith("hold:"))).toEqual(["hold:held"]);
  });

  // jx783qs (2026-11-17): a pane the classifier could not read held its
  // session's messages for 11 hours under "waiting for terminal input
  // confirmation", which told the sender nothing. The hold now says the screen
  // is unreadable and carries it, so the sender can look and Send anyway.
  test("a screen the classifier cannot read is named and shown on the held message", async () => {
    const f = fixture();
    f.pendingInteractivePrompts.clear();
    f.state.menu = "  a screen with no composer, no rule and no dialog footer\n  that no rule in the classifier knows";
    await f.scan([{ _id: "held", content: "please continue" }]);
    expect(f.bodies).toEqual([]);
    // The hold re-pends on its own timer, at the hold pace rather than the retry ladder.
    await f.timers.find((timer: { ms: number }) => timer.ms === 5000)!.fn();
    expect(f.holds[0]?.holdReason).toBe("the terminal shows a screen Codecast can't read");
    expect(f.holds[0]?.holdScreen).toContain("that no rule in the classifier knows");
    // Send anyway on that screen writes the message instead of holding it again.
    f.hooks.input = (event: string) => { if (event === "paste") f.state.menu = null; };
    await f.scan([{ _id: "held", content: "please continue", delivery_force: true }]);
    expect(f.bodies).toEqual(["please continue"]);
  });

  // A held delivery whose pane screen cannot be read used to be held for ever:
  // the unreadable-screen error was wrapped as an unverified-input hold and
  // rethrown before the pane-rebuild count ran, so nothing ever replaced the pane.
  test("a pane whose screen stays unreadable is rebuilt after the streak, not held for ever", async () => {
    const f = fixture();
    f.pendingInteractivePrompts.clear();
    f.state.menu = "  a screen with no composer, no rule and no dialog footer\n  that no rule in the classifier knows";
    const resumes: unknown[][] = [];
    f.hooks.resume = (...args: unknown[]) => { resumes.push(args); return true; };
    // Each hold re-pends on its own timer; the scanner then takes the message again.
    const retry = async () => {
      await f.timers.find((timer: { ms: number; cancelled: boolean }) => timer.ms === 5000 && !timer.cancelled)!.fn();
      f.timers.length = 0;
      f.clock.now += 20_000;
    };
    for (let attempt = 1; attempt <= 4; attempt++) {
      await f.scan([{ _id: "held", content: "please continue" }]);
      await retry();
    }
    expect(f.killed).toEqual([]);
    expect(resumes).toEqual([]);
    await f.scan([{ _id: "held", content: "please continue" }]);
    expect(f.killed).toEqual(["target"]);
    expect(resumes).toHaveLength(1);
  });

  // The held screen syncs beside the message and goes to daemon.log, so a
  // Vault value the pane printed above the dialog is redacted like a transcript.
  test("the screen a hold carries is redacted", async () => {
    setKnownValuesForTest([{ value: "zz-held-value-77ab", name: "zz-held", vault: true }]);
    try {
      const f = fixture();
      f.pendingInteractivePrompts.clear();
      f.state.menu = `zz-held-value-77ab\n${menu}`;
      await f.scan([{ _id: "held", content: "please continue" }]);
      expect(f.holds[0]?.holdScreen).toContain("[redacted:known:zz-held]");
      expect(f.holds[0]?.holdScreen).not.toContain("zz-held-value-77ab");
    } finally {
      setKnownValuesForTest(null);
    }
  });

  // The pre-paste "injected" write and the hold's re-pend are parallel mutations; a write
  // landing second stranded the row "injected" with nothing pasted (2026-10-24).
  test("a hold re-pends only after the attempt's own injected write has landed", async () => {
    const f = fixture(), settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    f.pendingInteractivePrompts.clear(); f.state.menu = menu;
    let land!: () => void;
    f.hooks.markWrite = () => new Promise<void>((resolve) => { land = () => { f.events.push("injected-landed"); resolve(); }; });
    await f.scan([{ _id: "held", content: "please continue" }]); await settle();
    expect(f.events).toEqual([]);
    land(); await settle();
    expect(f.events).toEqual(["injected-landed", "hold:held"]);
  });

  // Claude Code clears the screen as it boots, so a capture can land on a blank
  // pane. That is a redraw, not a dialog: it held 29 of 39 launches for 45s
  // behind "waiting for a human answer" (2026-09-24).
  test("a blank capture is a short retry, never a hold for a human answer", async () => {
    const f = fixture();
    f.state.menu = "";
    f.hooks.capture = () => { if (f.state.captures >= 1) f.state.menu = null; };
    await f.scan([{ _id: "blank", content: "please continue" }]);
    expect(f.events.filter((e: string) => e.startsWith("hold:"))).toEqual([]);
    expect(promptHoldRemainingMs("conv")).toBe(0);
  }, 30_000);

  // Claude Code 2.1.270's effort recommendation: an unnumbered select list
  // with no key hint footer (real capture, 2026-09-14). Its ❯ read as an idle
  // composer, so every delivery pasted into it and wrote the message again.
  const selectDialog = (onSecond = false) => [
    "─".repeat(80),
    " We recommend Opus 5 at medium effort",
    "",
    "   Opus 5 at medium effort is faster and uses fewer tokens. Run /effort to toggle.",
    "",
    `${onSecond ? "     " : "   ❯ "}Keep high`,
    `${onSecond ? "   ❯ " : "     "}Switch Opus 5 to medium effort`,
    "",
  ].join("\n");

  test("a human message waits behind an unnumbered select dialog instead of being pasted into it", async () => {
    const f = fixture();
    f.pendingInteractivePrompts.clear();
    f.state.menu = selectDialog();
    await f.scan([{ _id: "typed", content: "please continue" }]);
    expect(f.bodies).toEqual([]);
    expect(f.events).toEqual(["hold:typed"]);
    expect(promptHoldRemainingMs("conv")).toBeGreaterThan(0);
    // The re-pended row re-fires the scan at once; the hold keeps it off the pane.
    const captures = f.state.captures;
    await f.scan([{ _id: "typed", content: "please continue" }]);
    expect(f.state.captures).toBe(captures);
    expect(f.events).toEqual(["hold:typed"]);
  });

  // The safeguards "Session paused" interstitial (2026-09-15). A typed
  // message and a cast send are the same paste to the pane, so the dialog
  // refuses and holds both; only a card answer moves its cursor.
  const sessionPaused = [
    " Session paused",
    "",
    "  Fable 5.1's safeguards flagged this message.",
    "",
    "  Details: `[cyber]`",
    "",
    "  ❯ 1. Switch to Opus 4.8",
    "    2. Edit prompt and retry with Fable 5.1",
    "",
    "✻ Waiting for API response · will retry in 2m 40s · check your network",
  ].join("\n");

  test.each([["typed", "please continue"], ["sent", session("please continue")]])("a %s message is held behind the safeguards interstitial, and a card answer goes through", async (_kind, content) => {
    const f = fixture();
    f.pendingInteractivePrompts.clear();
    f.state.menu = sessionPaused;
    await f.scan([{ _id: "msg", content }]);
    expect(f.bodies).toEqual([]);
    expect(f.events).toEqual(["hold:msg"]);
    expect(promptHoldRemainingMs("conv")).toBeGreaterThan(0);
    const captures = f.state.captures;
    await f.scan([{ _id: "msg", content }]);
    expect(f.state.captures).toBe(captures);
    expect(f.events).toEqual(["hold:msg"]);
    // The card answer is never held; it closes the dialog and releases the hold.
    f.pendingInteractivePrompts.set("sid", { ...f.prompt, options: [{ label: "Switch to Opus 4.8" }, { label: "Edit prompt and retry with Fable 5.1" }] });
    await f.scan([{ _id: "answer", content: poll }]);
    expect(f.state.menu).toBeNull();
    expect(promptHoldRemainingMs("conv")).toBe(0);
    await f.scan([{ _id: "msg", content }]);
    expect(f.bodies).toEqual([stampDeliveryId(content, "msg")]);
  });

  test("a card answer walks the highlight of an unnumbered select dialog, then confirms", async () => {
    const f = fixture();
    f.prompt.options = [{ label: "Keep high" }, { label: "Switch Opus 5 to medium effort" }];
    f.state.menu = selectDialog();
    // Digits do nothing in this widget; only the arrows move its highlight.
    f.hooks.input = (event: string) => { if (event === "Down" && f.state.menu) f.state.menu = selectDialog(true); };
    const answer = JSON.stringify({ __cc_poll: true, keys: ["2"], display: "Switch Opus 5 to medium effort" });
    await expect(f.deliver(answer, "answer")).resolves.toBe(true);
    expect(f.events).toEqual(["Down", "Enter"]);
    expect(f.state.menu).toBeNull();
    expect(f.closed).toHaveLength(1);
  });

  test("historical menu above ready composer still rejects stale human poll keys", async () => {
    const f = fixture();
    f.state.menu = null;
    f.state.history = menu;
    await expect(f.deliver(poll, "stale-answer")).resolves.toBe(true);
    expect(f.events).toEqual([]);
    expect(f.bodies).toEqual([]);
  });

  test.each(["before Escape", "before paste", "before Enter"])("fresh tmux recheck blocks a newly opened menu %s", async stage => {
    const f = fixture();
    f.state.menu = null;
    if (stage === "before Escape") f.hooks.capture = () => { if (f.state.captures === 1) f.state.menu = menu; };
    // An idle claude composer is typed into, not pasted: a busy one takes the
    // paste whose buffer load is the moment this stage opens the menu.
    if (stage === "before paste") { f.state.busy = true; f.hooks.loaded = () => { f.state.menu = menu; }; }
    if (stage === "before Enter") f.hooks.input = (event: string) => { if (event === "paste") f.state.menu = menu; };
    await expect(f.deliver(session("preserve this"))).rejects.toThrow("human answer");
    expect(f.events).not.toContain("Enter");
    if (stage !== "before Enter") expect(f.events).not.toContain("paste");
    if (stage === "before Escape") expect(f.events).toEqual([]);
  });

  test("failed capture keeps the body retryable and a later fresh capture recovers", async () => {
    const f = fixture();
    f.state.captureFailure = true;
    await expect(f.deliver(session("yes"))).rejects.toThrow("terminal capture failed");
    expect(f.events).toEqual([]);
    f.state.captureFailure = false;
    f.state.menu = null;
    await expect(f.deliver(session("yes"))).resolves.toBe(true);
    expect(f.bodies).toEqual([session("yes")]);
  });

  test("a hold cannot fall through a paste fallback, but a new attempt captures afresh", async () => {
    const f = fixture();
    let captures = 0;
    const capture = async () => captures++ === 0 ? menu : box();
    const guard = f.inputGuard(capture);
    await expect(guard()).rejects.toThrow("human answer");
    await expect(guard()).rejects.toThrow("human answer");
    expect(captures).toBe(1);
    await expect(f.inputGuard(capture)()).resolves.toBeUndefined();
    expect(captures).toBe(2);
  });

  test("fast resume propagates a menu hold, then reuses the same pane after a human answer", async () => {
    const f = fixture();
    const content = session("Do not Deploy yet");
    await expect(f.autoResumeSessionInner("sid", content, {}, undefined, "conv", "claude")).rejects.toThrow("human answer");
    expect(f.events).toEqual([]);
    expect(f.deps.tmuxTargetLocks.size).toBe(0);
    await f.deliver(poll, "answer");
    await expect(f.autoResumeSessionInner("sid", content, {}, undefined, "conv", "claude")).resolves.toBe(true);
    expect(f.bodies).toEqual([content]);
  });

  test.each([0, 1, 2, 3])("resume propagation catch %s rethrows the exact hold and preserves ordinary fallback", async index => {
    const f = fixture();
    const error = new f.InputBlockedError("fixture menu");
    await expect(f.propagation[index](error)).rejects.toBe(error);
    await expect(f.propagation[index](new Error("ordinary failure"))).resolves.toBe(index === 3 ? false : "fallback");
    expect(f.events).toEqual([]);
  });

  test.each([
    menu,
    confirmation,
    menu.replace("Enter to select", '    Explanation: "? for shortcuts" is quoted.\nEnter to select'),
    menu.replace("Enter to select", '    Error text: command not found\nEnter to select'),
    menu.replace("Enter to select", '    Exit text: Resume this session with:\nEnter to select'),
  ])("startup capture releases a real menu hold immediately: %s", async pane => {
    const f = fixture();
    f.state.menu = pane;
    await expect(f.resumeReadiness(session("context"))).rejects.toThrow("human answer");
    expect(f.state.captures).toBe(1);
    expect(f.events).toEqual([]);
    f.state.menu = null;
    f.state.history = menu;
    await expect(f.resumeReadiness(session("context"))).resolves.toBe(true);
    await expect(f.resumeReadiness("human prose")).resolves.toBe(true);
  });

  // Claude Code's idle-resume dialog (the 2026-11-08 Head of People wake): a
  // machine wake answers Resume itself; a person's resume still gets asked.
  const idleResume = (cursorOn: "Resume" | "Start a new conversation") => [
    "Resume this conversation?",
    "This conversation has been inactive for 33d 16h 10m and is 354.6k tokens long. Resuming it will use about 6% of your 5-hour usage limit.",
    `${cursorOn === "Resume" ? "❯" : " "} 1. Resume`,
    `${cursorOn === "Resume" ? " " : "❯"} 2. Start a new conversation   Claude can look this one up if you refer to it later`,
    "Enter to select · Esc to cancel",
  ].join("\n");

  test("a machine wake answers Claude's idle-resume dialog with Resume, then comes up ready", async () => {
    const f = fixture();
    f.state.menu = idleResume("Resume");
    // The fixture's 100ms poll budget ends inside the answer's settle wait, so
    // the answer is checked first, then a fresh poll finds the agent ready.
    await f.resumeReadiness(session("wake: weekly review"));
    expect(f.events).toEqual(["Enter"]);
    expect(f.state.menu).toBeNull();
    await expect(f.resumeReadiness(session("wake: weekly review"))).resolves.toBe(true);
  });

  test("a machine wake walks the highlight onto Resume before confirming", async () => {
    const f = fixture();
    f.state.menu = idleResume("Start a new conversation");
    f.hooks.input = (event: string) => { if (event === "Up" && f.state.menu) f.state.menu = idleResume("Resume"); };
    await f.resumeReadiness(session("wake: weekly review"));
    expect(f.events).toEqual(["Up", "Enter"]);
    expect(f.state.menu).toBeNull();
  });

  test("a machine wake presses nothing when the highlight cannot be placed, and the dialog is held", async () => {
    const f = fixture();
    f.state.menu = idleResume("Start a new conversation");
    await expect(f.resumeReadiness(session("wake: weekly review"))).rejects.toThrow("human answer");
    expect(f.events).not.toContain("Enter");
  });

  test("a person's resume still holds Claude's idle-resume dialog for them", async () => {
    const f = fixture();
    f.state.menu = idleResume("Resume");
    await expect(f.resumeReadiness("human prose")).rejects.toThrow("human answer");
    expect(f.events).toEqual([]);
  });

  test("startup warning Escape checks fresh menu evidence and propagates a hold", async () => {
    const f = fixture();
    f.state.menu = `Update available\n${box()}`;
    f.hooks.capture = () => { if (f.state.captures === 1) f.state.menu = confirmation; };
    await expect(f.resumeWarnings(session("context"))).rejects.toThrow("human answer");
    expect(f.state.captures).toBe(2);
    expect(f.events).toEqual([]);
  });

  test("ordinary startup warnings retain their existing Escape behavior", async () => {
    const f = fixture();
    f.state.menu = `Update available\n${box()}`;
    f.hooks.input = (event: string) => { if (event === "Escape") f.state.menu = null; };
    await f.resumeWarnings("human prose");
    expect(f.events).toEqual(["Escape"]);
  });

  test("started-pane machine callback precedes the trust path without altering default probes", async () => {
    const f = fixture("tmux", false);
    // A held prompt, not a folder-trust dialog: assertPromptAbsent returns
    // early for trust (the launch path answers it with acceptTrustPrompt), so
    // trust is the one dialog that never parks a delivery.
    f.state.menu = menu;
    await expect(f.deliver(session("context"))).rejects.toThrow("human answer");
    expect(f.events).toEqual([]);
    expect(f.statuses).toEqual([]);
    const entry = f.deps.startedSessionTmux.get("conv");
    f.state.menu = menu;
    await expect(f.probeStartedPane(entry)).resolves.toMatchObject({ state: "ready" });
    await expect(f.probeStartedPane(entry, f.assertPromptAbsent)).rejects.toThrow("human answer");
  });

  for (const transport of ["kitty", "WezTerm", "ghostty", "Orca", "iTerm.app", "Apple_Terminal"]) {
    for (const format of [session]) test.each([menu, confirmation])(`${transport}: ${format.name} literal dialog stays composer text: %s`, async literal => {
      const f = fixture(transport);
      f.state.menu = null;
      const content = format(`Captured output:\n${literal}\nEnd of quoted evidence.`);
      await expect(f.deliver(content)).resolves.toBe(true);
      expect(f.bodies).toEqual([content]);
      expect(f.events).toEqual(["paste", "Enter"]);
      expect(f.pendingInteractivePrompts.get("sid")).toBe(f.prompt);
    });

    test(`${transport}: live menu holds without input or resume; ready composer recovers`, async () => {
      const f = fixture(transport);
      const content = session("Do not Deploy yet");
      await expect(f.deliver(content)).rejects.toThrow("human answer");
      expect(f.events).toEqual([]);
      expect(f.pendingInteractivePrompts.get("sid")).toBe(f.prompt);
      expect(f.closed).toEqual([]);
      f.state.menu = null;
      f.state.history = menu;
      await expect(f.deliver(content)).resolves.toBe(true);
      expect(f.bodies).toEqual([content]);
      expect(f.events).toEqual(["paste", "Enter"]);
    });

    test(`${transport}: explicit human poll keeps its existing input path without capture`, async () => {
      const f = fixture(transport);
      f.state.captureFailure = true;
      await expect(f.deliver(poll, "answer")).resolves.toBe(true);
      expect(f.state.captures).toBe(0);
      expect(f.closed).toHaveLength(1);
      expect(f.events).toEqual(transport === "iTerm.app" || transport === "Apple_Terminal" ? ["poll-script"] : ["Enter"]);
    });

    test(`${transport}: a capture failure preserves pending input`, async () => {
      const f = fixture(transport);
      f.state.captureFailure = true;
      await expect(f.deliver(session("yes"))).rejects.toThrow("terminal capture failed");
      expect(f.events).toEqual([]);
    });
  }

  test.each(["kitty", "WezTerm", "ghostty", "Orca", "iTerm.app"])("%s rechecks after paste before submitting", async transport => {
    const f = fixture(transport);
    f.state.menu = null;
    f.hooks.input = (event: string) => { if (event === "paste") f.state.menu = menu; };
    await expect(f.deliver(session("preserve"))).rejects.toThrow("human answer");
    expect(f.events).toEqual(["paste"]);
  });

  // Issue 57: a session resumed by hand in a herdr pane got a second copy in
  // tmux on the next send whenever the pane could not be reached, forking the
  // transcript. A live agent's failures now hold the message; only a streak
  // that lasts stops the agent, and the resume then replaces it.
  test("an unreachable live agent is held, then replaced, never resumed beside", async () => {
    const f = fixture("herdr");
    const resumes: unknown[][] = [];
    f.hooks.resume = (...args: unknown[]) => {
      expect(f.reaped).toEqual([4242]);
      resumes.push(args);
      return true;
    };
    for (let attempt = 1; attempt <= 4; attempt++) {
      await expect(f.deliver(session("keep one copy"), `m${attempt}`)).resolves.toBe(false);
      f.clock.now += 20_000;
    }
    expect(f.reaped).toEqual([]);
    expect(resumes).toEqual([]);
    await expect(f.deliver(session("keep one copy"), "m5")).resolves.toBe(true);
    expect(f.reaped).toEqual([4242]);
    expect(resumes).toHaveLength(1);
  });

  // jx72xn9 (2026-11-04): a session resumed by hand in a plain Ghostty window
  // took nothing for nine hours while every send retried as a failure, and the
  // sender saw only "Connecting...". It is held now, naming the terminal, at a
  // slow recheck that spends no retries, and the person's process is left alone.
  // Ghostty is typed into through AppleScript, so it holds only when that is out of reach.
  // A terminal with no injector at all (VS Code's) once went down the iTerm2
  // AppleScript path and failed every attempt, as Orca did before it had one.
  test.each([["Alacritty", "Alacritty"], ["ghostty", "Ghostty"], ["vscode", "vscode"]])("a live agent in %s is held with the terminal named, never retried or replaced", async (transport, label) => {
    const f = fixture(transport);
    f.state.ghosttyScriptable = false;
    f.hooks.resume = () => { throw new Error("resumed beside the person's own process"); };
    for (let attempt = 0; attempt < 6; attempt++) {
      await f.scan([{ _id: "update", content: session("are you there?"), retry_count: 0 } as any]);
      f.clock.now += 60_000;
    }
    // The attempt's own delivery timeout aside, one recheck is armed, at the hold's pace.
    const rechecks = f.timers.filter((t: { ms: number }) => t.ms < 180_000);
    expect(rechecks.map((t: { ms: number }) => t.ms)).toEqual([60_000]);
    await rechecks[0].fn();
    expect(f.events).toEqual(["hold:update"]);
    expect(unreachableTerminalOf(f.holds[0]?.holdReason)).toBe(label);
    expect(f.reaped).toEqual([]);
    expect(f.bodies).toEqual([]);
  });

  // pl-1134: a subagent a person took over runs as its own process only once
  // the copy inside its parent's process has stopped. Until then the message
  // is held with that reason, at the hold's pace, before any process lookup
  // or resume could start a second copy.
  test("a subagent whose in-process copy still runs is held, never looked up or resumed", async () => {
    const f = fixture();
    f.hooks.promote = async () => { throw new PromotionHoldError("waiting for its parent to stop it"); };
    f.hooks.resume = () => { throw new Error("resumed beside the in-process copy"); };
    await f.scan([{ _id: "update", content: "take it from here", retry_count: 0 } as any]);
    const rechecks = f.timers.filter((t: { ms: number }) => t.ms < 180_000);
    expect(rechecks.map((t: { ms: number }) => t.ms)).toEqual([10_000]);
    await rechecks[0].fn();
    expect(f.holds).toEqual([{ id: "update", holdReason: "waiting for its parent to stop it" }]);
    expect(f.bodies).toEqual([]);
    expect(f.reaped).toEqual([]);
  });

  test("AppleScript defaults preserve human submit and explicit poll scripts", () => {
    const f = fixture();
    const human = f.buildAppleScript("iTerm2", "/dev/ttys-test", "hello", null);
    expect(human.script).toContain('tell s to write text ""');
    const answer = f.buildAppleScript("iTerm2", "/dev/ttys-test", poll, f.parsePollMessage(poll));
    expect(answer.script).toContain('tell s to write text "Enter" without newline');
    const machinePaste = f.buildAppleScript("iTerm2", "/dev/ttys-test", session("hello"), null, false, true, false);
    expect(machinePaste.script).not.toContain('tell s to write text ""');
  });

  // A session launched with its first message as the prompt argument: delivery
  // confirms that message from the transcript and never puts it in the composer.
  describe("a message the launch command carried", () => {
    const userRow = JSON.stringify({ type: "user", message: { role: "user", content: "the brief" } });
    const carry = (f: ReturnType<typeof fixture>, opts: { taken?: boolean; age?: number } = {}) => {
      const transcript = path.join(f.directory, "sid.jsonl");
      if (opts.taken) fs.writeFileSync(transcript, `${JSON.stringify({ type: "mode", mode: "normal" })}\n${userRow}\n`);
      f.launchPromptCarries.set("update", { conversationId: "conv", tmuxSession: "target", projectPath: f.directory, sessionId: "sid", transcript, startedAt: f.clock.now - (opts.age ?? 0) });
    };

    test.each([true, false])("is delivered by its transcript row, not a paste (session linked: %s)", async cached => {
      const f = fixture("tmux", cached);
      f.state.menu = null;
      carry(f, { taken: true });
      await expect(f.deliver("the brief")).resolves.toBe(true);
      expect(f.events).toEqual([]);
      expect(f.launchPromptCarries.size).toBe(0);
      // Terminal, from the local echo: an "injected" row waits on ingest, and the
      // healer re-pends it for a second paste when ingest stalls (jx74wc8).
      expect(f.statuses).toContainEqual(expect.objectContaining({ messageId: "update", status: "delivered" }));
    });

    // A spawn's delivery is already running when the start carries its brief,
    // and tries the cloud rail on every tick of its wait. That rail failing for
    // a local conversation must not erase the carry's echo record, or the
    // brief's transcript turn never carries its row id and the server cannot
    // name its sender.
    test.each([true, false])("leaves the launch's echo record for the transcript turn to pair (session linked: %s)", async cached => {
      const f = fixture("tmux", cached);
      f.state.menu = null;
      const ledger = f.deps.deliveryEchoLedger();
      f.deps.cloudAgents.deliver = async () => {
        if (!f.launchPromptCarries.size) {
          carry(f, { taken: true });
          ledger.expect({ messageId: "update", conversationId: "conv", payload: "the brief" });
        }
        return null;
      };
      await expect(f.deliver("the brief")).resolves.toBe(true);
      expect(f.bodies).toEqual([]);
      // The ledger keeps the real clock, not the fixture's.
      const stamped = ledger.stamp("conv", [{ messageUuid: "u1", role: "human", content: "the brief", timestamp: Date.now() + 1000 }]);
      expect(stamped[0].deliveryIds).toEqual(["update"]);
    });

    test("keeps the carry when the delivered mark fails, so the retry settles it instead of pasting", async () => {
      const f = fixture("tmux", true);
      f.state.menu = null;
      carry(f, { taken: true });
      f.deps.syncService.updateMessageStatus = async () => { throw new Error("backend down"); };
      await expect(f.deliver("the brief")).rejects.toThrow("backend down");
      expect(f.launchPromptCarries.size).toBe(1);
      expect(f.bodies).toEqual([]);
    });

    test("is not pasted by a delivery that was already waiting for the session to start", async () => {
      const f = fixture("tmux", false);
      f.state.menu = null;
      // The start registers the carry after delivery's first admission, while
      // delivery is still reading the pane for readiness.
      f.hooks.capture = () => { if (!f.launchPromptCarries.size) carry(f, { taken: true }); };
      await expect(f.deliver("the brief")).resolves.toBe(true);
      expect(f.events).toEqual([]);
      expect(f.bodies).toEqual([]);
    });

    test("is held while the agent is still booting, and pasted by nobody", async () => {
      const f = fixture();
      f.state.menu = null;
      carry(f);
      await expect(f.deliver("the brief")).rejects.toThrow("AGENT_STDIN_NOT_READY");
      expect(f.events).toEqual([]);
      expect(f.launchPromptCarries.size).toBe(1);
    }, 60_000);

    test("goes back to the composer when the launch died", async () => {
      const f = fixture();
      f.state.menu = "zsh: command not found: claude";
      carry(f);
      await expect(f.deliver("the brief")).resolves.toBe(false);
      expect(f.events).toEqual([]);
      f.state.menu = null;
      await expect(f.deliver("the brief")).resolves.toBe(true);
      expect(f.bodies).toEqual(["the brief"]);
    });

    test("goes back to the composer once the carry has lapsed", async () => {
      const f = fixture();
      f.state.menu = null;
      carry(f, { age: 11 * 60_000 });
      await expect(f.deliver("the brief")).resolves.toBe(true);
      expect(f.bodies).toEqual(["the brief"]);
    });
  });

  describe("delivery budget and write cap", () => {
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));

    test("a timed-out attempt keeps its slot until it settles, so a retry never writes over it", async () => {
      // A 157 KB prompt typed for 7 minutes was timed out at 3 and retried
      // over itself; the pane got a second copy (jx7b88a, 2026-10-05).
      const f = fixture();
      f.state.menu = null;
      let releaseHang: () => void = () => {};
      const hang = new Promise<void>(resolve => { releaseHang = resolve; });
      let writes = 0;
      f.hooks.exec = async (args: string[]) => {
        if (args[0] === "send-keys" && args.includes("-l")) { writes++; await hang; }
      };
      const first = f.scan([{ _id: "update", content: "continue" }]);
      for (let i = 0; i < 20 && writes === 0; i++) await tick();
      expect(writes).toBe(1);
      const budget = f.timers.find((t: any) => t.ms === deliveryTimeoutMsFor("continue", undefined, 180_000));
      expect(budget).toBeDefined();
      await budget!.fn();
      await first;
      // The retry is scheduled, not yet fired: the slot is still held.
      const retry = f.timers.find((t: any) => t.ms === 1000 && !t.cancelled);
      expect(retry).toBeDefined();
      expect(f.deps.messagesInFlight.has("update")).toBe(true);
      await retry!.fn();
      expect(f.events).toEqual(["retry:update"]);
      expect(f.bodies).toEqual([]);
      // The retry re-pends the row; the scan finds the attempt still in flight.
      await f.scan([{ _id: "update", content: "continue", retry_count: 1 }]);
      expect(writes).toBe(1);
      expect(f.deps.messagesInFlight.has("update")).toBe(true);
      releaseHang();
      for (let i = 0; i < 50 && f.deps.messagesInFlight.has("update"); i++) await tick();
      expect(f.bodies).toEqual(["continue"]);
      expect(f.deps.messagesInFlight.has("update")).toBe(false);
      expect(f.deps.conversationDeliveryActive.has("conv")).toBe(false);
    });

    test("an attempt that never settles is reclaimed past its ttl, and never pastes once it wakes", async () => {
      // Under load 500 an attempt hung before its paste and never returned. It
      // kept the conversation's slot, and every later message to the session
      // was skipped as "delivery already active" for hours (jx77xjt, 2026-10-16).
      const f = fixture();
      f.state.menu = null;
      let releaseHang: () => void = () => {};
      const hang = new Promise<void>(resolve => { releaseHang = resolve; });
      const claim = f.deps.syncService.claimPendingMessageForDelivery;
      let claims = 0;
      f.deps.syncService.claimPendingMessageForDelivery = async (...args: [string]) => {
        // The scanner claims first; the second claim is the attempt's own admission.
        if (++claims === 2) await hang;
        return claim(...args);
      };
      const first = f.scan([{ _id: "update", content: "continue" }]);
      for (let i = 0; i < 20 && claims < 2; i++) await tick();
      const budget = f.timers.find((t: any) => t.ms === deliveryTimeoutMsFor("continue", undefined, 180_000));
      await budget!.fn();
      await first;
      expect(f.deps.conversationDeliveryActive.has("conv")).toBe(true);
      await f.timers.find((t: any) => t.ms === 1000 && !t.cancelled)!.fn();
      const entry = f.deps.messagesInFlight.get("update");
      entry.ts -= entry.ttlMs + 1;
      await f.scan([{ _id: "update", content: "continue", retry_count: 1 }]);
      expect(f.bodies).toEqual(["continue"]);
      expect(f.deps.conversationDeliveryActive.has("conv")).toBe(false);
      // The abandoned attempt wakes: its admission is refused before any paste,
      // and it releases nothing the next delivery holds.
      f.deps.conversationDeliveryActive.add("conv");
      releaseHang();
      for (let i = 0; i < 50; i++) await tick();
      expect(f.bodies).toEqual(["continue"]);
      expect(f.deps.conversationDeliveryActive.has("conv")).toBe(true);
    });

    const exhausted = async (submitted: boolean, recovered = false) => {
      const f = fixture();
      f.state.menu = null;
      f.hooks.prepare = async () => { throw new TmuxDeliveryExhaustedError("update", 3, submitted); };
      const cancelled: string[] = [];
      const refused: string[] = [];
      const rows: any[] = [];
      f.deps.syncService.cancelPendingMessage = async (id: string) => { cancelled.push(id); };
      f.deps.syncService.reportPaneRefused = async (id: string) => { refused.push(id); return { recovered }; };
      f.deps.syncService.addMessage = async (row: any) => { rows.push(row); return "row-1"; };
      await f.scan([{ _id: "update", content: "continue" }]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.bodies).toEqual([]);
      expect(f.events.filter((e: string) => /^(retry|hold):/.test(e))).toEqual([]);
      expect(f.deps.messagesInFlight.size).toBe(0);
      return { cancelled, refused, rows };
    };

    test("a submitted message the pane took the capped number of times is cancelled and said in the session", async () => {
      const { cancelled, refused, rows } = await exhausted(true);
      expect(cancelled).toEqual(["update"]);
      expect(refused).toEqual([]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ conversationId: "conv", role: "system", subtype: "delivery_failed" });
      expect(parseDeliveryFailedNotice(rows[0].content)).toEqual({ writes: 3, submitted: true, message: "continue", complete: true });
    });

    test("a message the pane never showed is reported as refused, and said in the session when nothing recovers it", async () => {
      const { cancelled, refused, rows } = await exhausted(false);
      expect(cancelled).toEqual([]);
      expect(refused).toEqual(["update"]);
      expect(rows).toHaveLength(1);
      expect(parseDeliveryFailedNotice(rows[0].content)).toEqual({ writes: 3, submitted: false, message: "continue", complete: true });
      expect(rows[0].content).toStartWith("This message never reached the agent");
    });

    test("a refused message the server recovers (restart and resend) posts no failure", async () => {
      const { cancelled, refused, rows } = await exhausted(false, true);
      expect(cancelled).toEqual([]);
      expect(refused).toEqual(["update"]);
      expect(rows).toEqual([]);
    });
  });
});
