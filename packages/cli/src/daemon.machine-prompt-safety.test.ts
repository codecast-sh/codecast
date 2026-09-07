import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isMachineDeliveredMessage } from "../../shared/contracts/machineMessages";
import { AGENT_CLIENTS } from "../../shared/contracts/agentClients";
import { formatSessionUpdateBatch } from "../../shared/contracts/sessionUpdates";
import { PendingDeliveryHeldError, createDeliveryAdmission } from "./pendingDeliveryAdmission";
import { clientAcceptsBracketedPaste, pasteAndSubmitText, pasteTextIntoPane as pasteTextIntoPaneWith, prepareInjectedContent, PASTE_START, PASTE_END } from "./tmuxPaste";
import { blockAt, functionBlock } from "./test-helpers/sourceRegion";

const source = fs.readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const poll = JSON.stringify({ __cc_poll: true, keys: ["Enter"], display: "Deploy" });
const session = (body: string) => `<session-message from="jxsrc01">\n${body}\n</session-message>`;
const batch = (body: string) => formatSessionUpdateBatch("batch-1", [{ id: "update-1", from: "jxsrc01", sent_at: 1, body }]);
const menu = "Ship the change?\n❯ 1. Deploy\n  2. Deny\nEnter to select · Esc to cancel";
const cursorMenu = "Ship the change?\n❯ 1. Deploy\n  2. Deny";
const confirmation = "Confirm deployment\nPress Enter to continue · Esc to cancel";
const box = (text = "", busy = false) => `────────────────────────────────────────\n❯ ${text}\n────────────────────────────────────────\n${busy ? "esc to interrupt" : "? for shortcuts"}`;
const fail = (name: string) => () => { throw new Error(`Unexpected effect: ${name}`); };

function fixture(transport = "tmux", cached = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-prompt-guard-"));
  scratch.push(directory);
  const state = { menu: menu as string | null, composer: "", history: "", busy: false, captureFailure: false, captures: 0 };
  const events: string[] = [];
  const bodies: string[] = [];
  const commands: string[] = [];
  const captureSizes: number[] = [];
  const hooks = { capture: () => {}, input: (_event: string) => {}, loaded: () => {} };
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
    return state.menu ?? `${state.history}\n${box(state.composer, state.busy)}`;
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
    if (["C-k", "C-u"].includes(event)) state.composer = "";
    hooks.input(event);
  };
  const buffers = new Map<string, string>();
  const tmuxExec = async (args: string[]) => {
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
  const messages = new Map<string, any>();
  const statuses: Array<{ messageId: string; status: string }> = [];
  const injectedMessageTs = new Map<string, { ts: number; conversationId: string; confirmed: boolean }>();
  const syncService = {
    getConversationOwnerInfo: async () => null,
    claimPendingMessageForDelivery: async (id: string) => messages.get(id) ?? { _id: id, conversation_id: "conv" },
    updateMessageStatus: async (args: any) => { statuses.push(args); },
    updateSessionAgentStatus: async () => {},
    retryMessage: async (id: string) => { events.push(`retry:${id}`); },
    setSessionError: async () => {},
    cancelPendingMessage: fail("cancel pending"),
  };
  const deps = {
    fs, os, path, randomUUID, CONFIG_DIR: directory, EXEC_TIMEOUT_MS: 1000,
    isMachineDeliveredMessage, AGENT_CLIENTS, PendingDeliveryHeldError, createDeliveryAdmission,
    clientAcceptsBracketedPaste, pasteAndSubmitText, pasteTextIntoPaneWith, prepareInjectedContent, PASTE_START, PASTE_END,
    tmuxExec, execAsync,
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
    log: () => {}, logDelivery: () => {}, logConvexFailure: fail("convex failure"),
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
    touchHostActivity: () => {}, pendingAgentSwitches: new Set(), planHandoffChildren: new Map(),
    ownedByAnotherLiveDevice: () => false, isRemoteDevice: () => false, codexAppServerInstance: undefined,
    buildReverseConversationCache: () => cached ? { conv: "sid" } : {}, findSessionFile: () => ({ agentType: "claude" }),
    startedSessionTmux: new Map([["conv", { tmuxSession: "target", agentType: "claude", startedAt: clock.now }]]),
    deleteStartedSession: fail("delete started session"), readConversationCache: fail("recreation fallback"),
    hasTmux: () => true, resumeFatalReasons: new Map(), resumeSessionCache: new Map(),
    resumeShortId: (id: string) => id, resumeTmuxName: () => "target", syncServiceRef: undefined,
    readConfig: fail("full resume fallback"), isTmuxAgentAlive: async () => true,
    classifyClaudeResumeFatalReason: fail("fatal classification"),
    resolveLiveTmuxTarget: async () => transport === "tmux"
      ? { tmuxTarget: "target:0.0", source: "started" }
      : { tmuxTarget: null, proc: { tty: "ttys-test", termProgram: transport } },
    markInjectedBestEffort: (_sync: unknown, id: string) => {
      statuses.push({ messageId: id, status: "injected" });
      injectedMessageTs.set(id, { ts: clock.now, conversationId: "conv", confirmed: false });
    },
    clearUnresolvablePane: () => {}, noteUnresolvablePane: fail("rebuild"),
    autoResumeSession: fail("resume"), repairAndResumeSession: fail("repair"), materializeSession: fail("materialize"),
    selfHealIfTimersStalled: () => {}, assertLegacyDeliveryEnvelope: () => {},
    messagesInFlight: new Map(), conversationDeliveryActive: new Set(), injectedMessageTs,
    IN_FLIGHT_HARD_TTL_MS: 10000, compactionRedeliveryBypass: new Set(), injectionDedupWindowMs: () => 10000,
    messageRetryTimers: new Set(), syncService, conversationCache: cached ? { sid: "conv" } : {}, titleCache: {},
    sendAgentStatus: () => {}, recentSessionInjections: new Map(), resetReconnectDelay: () => {},
    checkForInteractivePrompt: async () => {},
  };
  const names = [
    "parsePollMessage", "pollDeclineText", "pollMenuSteps", "extractTmuxLiveRegion", "classifyTmuxLiveState", "isResumeCwdPicker",
    "assertMachinePromptAbsent", "machineInputGuard", "ensureTmuxReady", "withTmuxLock", "drainTmuxComposer", "tmuxComposerText", "tmuxComposerDraft",
    "tmuxWatchablePrefix", "awaitTmuxComposerPayload", "normalizePromptText", "tmuxPromptStillHasInput", "tmuxPromptShowsPastePlaceholder", "verifyTmuxSubmitAfterPaste",
    "pasteTextIntoPane", "paneInteractiveQuestion", "injectViaTmux", "injectViaTmuxInner",
    "buildAppleScript", "captureAppleScriptPane", "injectViaAppleScript", "writeTerminalInjectionScript",
    "findKittyWindowId", "mapKeyForKitty", "kittySendText", "writeKittyInjectionPayload", "injectViaKitty",
    "findWezTermPaneId", "weztermSendText", "weztermSendKeys", "injectViaWezTerm", "normalizeTty", "getTerminalLabel", "injectViaTerminal",
    "deliverMessage", "autoResumeSessionInner", "probeStartedPane", "classifyStartedPane", "paneContentAfterLaunchEcho",
  ];
  const constants = ["RESUME_CWD_PICKER_RE", "DRAIN_MAX_CYCLES", "stripComposerChrome", "TMUX_ONLY_TERMINALS", "DELIVERY_TIMEOUT_MS", "TRUST_PROMPT_RE"].map(name => {
    const line = source.split("\n").find(l => new RegExp(`^(?:export )?\\s*const ${name} =`).test(l));
    if (!line) throw new Error(`Missing constant ${name}`);
    return line.replace("export ", "");
  });
  const parserStart = source.indexOf("type InteractivePrompt =");
  const parserEnd = source.indexOf("\n// Claude Code's spend-limit interstitial", parserStart);
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
  const code = [
    source.slice(parserStart, parserEnd),
    blockAt(source, source.indexOf("class MachineInputBlockedError")).text,
    blockAt(source, source.indexOf("const WEZTERM_KEY_SEQUENCES:")).text.replace(/},?$/, "};"),
    "class UndeliverableMessageError extends Error {}",
    source.slice(fatalStart, source.indexOf("];", fatalStart) + 2),
    ...constants,
    ...names.map(name => functionBlock(source, name).text),
    `const scheduleMessageRetry = ((setTimeout) => { ${functionBlock(source, "scheduleMessageRetry").text}; return scheduleMessageRetry; })(recordTimer);`,
    ...catches,
    `async function resumeReadiness(content) { ${resumeScope} ${resumeFatalErrors} const startTime = Date.now(), maxPollMs = 100; let ready = false; ${readiness} return ready; }`,
    `async function resumeWarnings(content) { ${resumeScope} const ready = true; ${warnings} }`,
    blockAt(source, source.indexOf("  const handlePendingMessagesUpdate = async")).text,
  ].join("\n").replace(/^export /gm, "");
  const api = new Function(...Object.keys(deps), new Bun.Transpiler({ loader: "ts" }).transformSync(code) +
    "; return { deliverMessage, injectViaTmux, injectViaTerminal, handlePendingMessagesUpdate, scheduleMessageRetry, parsePollMessage, parseInteractivePrompt, buildAppleScript, machineInputGuard, assertMachinePromptAbsent, MachineInputBlockedError, autoResumeSessionInner, probeStartedPane, resumeReadiness, resumeWarnings, propagation: [propagation0, propagation1, propagation2, propagation3] };")(...Object.values(deps));
  return {
    ...api, state, events, bodies, commands, captureSizes, hooks, timers, clock, prompt, pendingInteractivePrompts, lastEmittedSyntheticPrompt, closed, statuses, deps,
    deliver: (body: string, id = "update") => api.deliverMessage("conv", body, deps.conversationCache, syncService, id, {}),
    scan: async (rows: Array<{ _id: string; content: string }>) => {
      for (const row of rows) messages.set(row._id, { ...row, conversation_id: "conv" });
      await api.handlePendingMessagesUpdate([...messages.values()].filter(row => rows.some(r => r._id === row._id)));
    },
  };
}

describe("machine prompt delivery safety", () => {
  test("fixture resolves a one-second delivery sleep while retry timers stay controlled", async () => {
    const f = fixture();
    const start = f.clock.now;
    f.scheduleMessageRetry("update", 0, "conv", batch("context"));
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

  for (const format of [session, batch]) {
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
    await expect(f.injectViaTmux("target:0.0", batch("yes"))).rejects.toThrow("human answer");
    expect(f.events).toEqual([]);
  });

  for (const format of [session, batch]) {
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
    await expect(f.deliver(batch("context only"))).rejects.toThrow("human answer");
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

  test("human typed option and explicit poll still reach the same menu", async () => {
    for (const answer of ["Deploy", poll]) {
      const f = fixture();
      await expect(f.deliver(answer, "answer")).resolves.toBe(true);
      expect(f.events).toEqual(["Enter"]);
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
    await expect(f.deliver(batch("new evidence"))).resolves.toBe(true);
    expect(f.bodies).toEqual([batch("new evidence")]);
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

  for (const cached of [true, false]) test.each([
    menu,
    menu.replace("Enter to select", '    Explanation: "? for shortcuts" is quoted.\nEnter to select'),
    menu.replace("Enter to select", '    Explanation: "esc to interrupt" is quoted.\nEnter to select'),
  ])(`held update releases the legacy slot for a human answer and one retry (cached=${cached}): %s`, async pane => {
    const f = fixture("tmux", cached);
    f.state.menu = pane;
    const content = batch("Do not Deploy yet");
    await f.scan([{ _id: "update", content }, { _id: "answer", content: poll }]);
    expect(f.state.menu).toBeNull();
    expect(f.bodies).toEqual([]);
    expect(f.events).toEqual(["Enter"]);
    expect(f.deps.messagesInFlight.size).toBe(0);
    expect(f.deps.conversationDeliveryActive.size).toBe(0);
    expect(f.deps.tmuxTargetLocks.size).toBe(0);
    expect(f.deps.injectedMessageTs.has("update")).toBe(false);
    expect(f.statuses.filter((s: { status: string }) => s.status === "delivered" || s.status === "undeliverable")).toEqual([]);
    const retry = f.timers.find((t: { ms: number; cancelled: boolean }) => t.ms === 1000 && !t.cancelled)!;
    expect(retry).toBeDefined();
    await retry.fn();
    await f.scan([{ _id: "update", content }]);
    expect(f.bodies).toEqual([content]);
    await f.scan([{ _id: "update", content }]);
    expect(f.bodies).toEqual([content]);
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
    if (stage === "before paste") f.hooks.loaded = () => { f.state.menu = menu; };
    if (stage === "before Enter") f.hooks.input = (event: string) => { if (event === "paste") f.state.menu = menu; };
    await expect(f.deliver(batch("preserve this"))).rejects.toThrow("human answer");
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
    const guard = f.machineInputGuard(session("context"), capture);
    await expect(guard()).rejects.toThrow("human answer");
    await expect(guard()).rejects.toThrow("human answer");
    expect(captures).toBe(1);
    await expect(f.machineInputGuard(session("context"), capture)()).resolves.toBeUndefined();
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
    const error = new f.MachineInputBlockedError("fixture menu");
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
    await expect(f.resumeReadiness(batch("context"))).rejects.toThrow("human answer");
    expect(f.state.captures).toBe(1);
    expect(f.events).toEqual([]);
    f.state.menu = null;
    f.state.history = menu;
    await expect(f.resumeReadiness(batch("context"))).resolves.toBe(true);
    await expect(f.resumeReadiness("human prose")).resolves.toBe(true);
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

  test("started-pane machine callback precedes trust input without altering default probes", async () => {
    const f = fixture("tmux", false);
    f.state.menu = `Do you trust this folder?\n❯ 1. Yes\n  2. No\nEnter to select · Esc to cancel`;
    await expect(f.deliver(batch("context"))).rejects.toThrow("human answer");
    expect(f.events).toEqual([]);
    expect(f.statuses).toEqual([]);
    const entry = f.deps.startedSessionTmux.get("conv");
    f.state.menu = menu;
    await expect(f.probeStartedPane(entry)).resolves.toMatchObject({ state: "ready" });
    await expect(f.probeStartedPane(entry, f.assertMachinePromptAbsent)).rejects.toThrow("human answer");
  });

  for (const transport of ["kitty", "WezTerm", "iTerm.app", "Apple_Terminal"]) {
    for (const format of [session, batch]) test.each([menu, confirmation])(`${transport}: ${format.name} literal dialog stays composer text: %s`, async literal => {
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
      const content = batch("Do not Deploy yet");
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

  test.each(["kitty", "WezTerm", "iTerm.app"])("%s rechecks after paste before submitting", async transport => {
    const f = fixture(transport);
    f.state.menu = null;
    f.hooks.input = (event: string) => { if (event === "paste") f.state.menu = menu; };
    await expect(f.deliver(batch("preserve"))).rejects.toThrow("human answer");
    expect(f.events).toEqual(["paste"]);
  });

  test("AppleScript defaults preserve human submit and explicit poll scripts", () => {
    const f = fixture();
    const human = f.buildAppleScript("iTerm2", "/dev/ttys-test", "hello", null);
    expect(human.script).toContain('tell s to write text ""');
    const answer = f.buildAppleScript("iTerm2", "/dev/ttys-test", poll, f.parsePollMessage(poll));
    expect(answer.script).toContain('tell s to write text "Enter" without newline');
    const machinePaste = f.buildAppleScript("iTerm2", "/dev/ttys-test", batch("hello"), null, false, true, false);
    expect(machinePaste.script).not.toContain('tell s to write text ""');
  });
});
