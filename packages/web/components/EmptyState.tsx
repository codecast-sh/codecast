import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { copyToClipboard } from "../lib/utils";
import { track } from "../lib/analytics";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { cliJustConnected, markCliConnected } from "../lib/cliConnected";
import { bridge, type DaemonSetupState } from "../lib/desktop";
import { useMountEffect } from "../hooks/useMountEffect";
import { useSurface } from "../lib/surfaces";
import { useInboxStore } from "../store/inboxStore";
import { isSessionRailOpen, type WorkspaceState } from "../store/workspace";
import { AssistantIntro } from "./AssistantIntro";
import { startHostedConversation } from "../lib/startHostedConversation";
import { AgentTypeIcon } from "./AgentTypeIcon";
import { useConnectAvailable } from "./simple/assistantPromise";
import { useHostedAskGate } from "./simple/useHostedAskGate";
import { Composer } from "./simple/Composer";
import { carriedAsk, forgetCarriedAsk } from "./simple/carriedAsk";
import "./simple/simple.css";
import { TerminalSquare } from "lucide-react";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";
import { useNewResults, useWaitingOnPerson } from "../hooks/useNeedsInputCount";
import { formatRowTime, sessionCardTitle } from "../lib/sessionCard";
import { LANE_COPY } from "./simple/lane";
import Link from "next/link";
import { useTriggers } from "../hooks/useSyncTriggers";
import { isAssistantRoutine } from "../lib/assistantScope";
import { firstRunWords } from "./triggers/hostedSchedule";
import { taskDisplayTitle } from "./triggerTasks";

interface EmptyStateProps {
  title: string;
  description: string;
  action?: {
    label: string;
    href: string;
  };
  variant?: "default" | "onboarding";
  hasOtherSessions?: boolean;
}

const FAKE_SESSIONS = [
  {
    title: "Fix authentication redirect loop",
    agent: "claude_code",
    project: "webapp",
    duration: "12m",
    messages: 24,
    time: "3m ago",
    subtitle: "Debug OAuth callback URL mismatch causing infinite redirect after login",
    active: true,
  },
  {
    title: "Add rate limiting to API endpoints",
    agent: "claude_code",
    project: "api-server",
    duration: "8m",
    messages: 16,
    time: "15m ago",
    subtitle: "Implement token bucket rate limiter with Redis backing store",
  },
  {
    title: "Refactor database migration scripts",
    agent: "cursor",
    project: "platform",
    duration: "23m",
    messages: 41,
    time: "1h ago",
    subtitle: "Consolidate migration files and add rollback support",
  },
  {
    title: "Implement search indexing pipeline",
    agent: "claude_code",
    project: "search-svc",
    duration: "45m",
    messages: 67,
    time: "2h ago",
    subtitle: "Build incremental indexing with Elasticsearch bulk API",
  },
  {
    title: "Debug memory leak in worker process",
    agent: "claude_code",
    project: "workers",
    duration: "18m",
    messages: 32,
    time: "4h ago",
    subtitle: "Track down event listener accumulation in long-running queue consumer",
  },
  {
    title: "Add WebSocket reconnection logic",
    agent: "cursor",
    project: "realtime",
    duration: "6m",
    messages: 11,
    time: "Yesterday",
    subtitle: "Exponential backoff with jitter for dropped connections",
  },
];

function FakeSessionCard({ session, className = "" }: { session: typeof FAKE_SESSIONS[0]; className?: string }) {
  return (
    <div className={`relative border rounded-xl p-3 md:p-4 bg-white dark:bg-sol-bg-alt border-sol-border/40 ${className}`}>
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="w-4 h-4 rounded bg-sol-yellow flex items-center justify-center shrink-0">
            <svg className="w-2.5 h-2.5 text-sol-bg" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </span>
          <span className="font-medium text-sm text-sol-text truncate">{session.title}</span>
          {session.active && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sol-green/20 border border-sol-green/50 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-sol-green" />
              <span className="text-[10px] text-sol-green font-semibold">LIVE</span>
            </span>
          )}
        </div>
        <span className="text-[11px] text-sol-text-dim/50 shrink-0">{session.time}</span>
      </div>
      {session.subtitle && (
        <p className="text-xs text-sol-text-muted mb-2 line-clamp-1">{session.subtitle}</p>
      )}
      <div className="flex items-center gap-2 text-xs text-sol-text-muted0">
        <span className="inline-flex items-center gap-1 text-sol-text-dim">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
          </svg>
          {session.project}
        </span>
        <span className="inline-flex items-center gap-1 text-sol-text-dim">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {session.duration}
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-sol-border/30 text-sol-text-dim">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <span className="text-[10px] font-semibold">{session.messages}</span>
        </span>
      </div>
    </div>
  );
}

/** `onStart` fires when the person asks for the command (the first-run
 *  card counts it as choosing their own machine). */
function SetupTokenCommand({ onStart }: { onStart?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [setupToken, setSetupToken] = useState<string | null>(null);
  const [tokenExpiry, setTokenExpiry] = useState<number | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const createSetupToken = useMutation(api.apiTokens.createSetupToken);

  const handleCopy = async (text: string) => {
    await copyToClipboard(text);
    track("install_command_copied", { location: "onboarding_empty_state", platform: "unix", with_token: true });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const generateSetupToken = async () => {
    onStart?.();
    setIsGenerating(true);
    try {
      const result = await createSetupToken({});
      setSetupToken(result.token);
      setTokenExpiry(result.expiresAt);
    } finally {
      setIsGenerating(false);
    }
  };

  const [now, setNow] = useState(Date.now());
  useWatchEffect(() => {
    if (!tokenExpiry) return;
    const remaining = tokenExpiry - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining + 100);
    return () => clearTimeout(timer);
  }, [tokenExpiry]);
  const isTokenExpired = tokenExpiry ? now > tokenExpiry : false;
  const hasValidToken = setupToken && !isTokenExpired;
  const installCommand = hasValidToken
    ? `curl -fsSL codecast.sh/install | sh -s -- ${setupToken}`
    : null;

  if (!hasValidToken) {
    return (
      <button
        onClick={generateSetupToken}
        disabled={isGenerating}
        className="w-full px-4 py-3 bg-sol-yellow/20 hover:bg-sol-yellow/30 text-sol-yellow text-sm font-medium rounded-xl border border-sol-yellow/30 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {isGenerating ? (
          <>
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            Generating...
          </>
        ) : (
          "Generate install command"
        )}
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <div className="rounded-xl overflow-hidden border border-sol-border/80">
        <div className="flex items-center justify-between gap-3 bg-sol-base02 px-4 py-3">
          <code className="text-sol-base1 text-sm font-mono truncate">
            <span className="text-sol-base01 select-none">$ </span>
            curl -fsSL codecast.sh/install | sh -s -- <span className="text-sol-green">{setupToken?.slice(0, 8)}...</span>
          </code>
          <button
            onClick={() => handleCopy(installCommand!)}
            className="p-1.5 text-sol-text-muted hover:text-sol-text hover:bg-sol-base01 rounded-md transition-colors shrink-0"
            title="Copy to clipboard"
          >
            {copied ? (
              <svg className="w-4 h-4 text-sol-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        </div>
      </div>
      <p className="text-xs text-sol-text-dim text-center">
        Token expires in 60 minutes
      </p>
    </div>
  );
}

const SETUP_ERRORS = ["invalid_token", "unsupported_platform", "installer_failed"] as const;
const setupError = (e?: string) => SETUP_ERRORS.find((k) => k === e) ?? "threw";

// In the desktop app there is no terminal step: one click mints a setup token
// and the shell runs the installer with it. A browser tab, an older shell or a
// failed run falls back to the command to paste.
export function SetupThisMachine({ onConnected, onStart }: { onConnected: () => void; onStart?: () => void }) {
  const createSetupToken = useMutation(api.apiTokens.createSetupToken);
  const [machine, setMachine] = useState<DaemonSetupState | null>(null);
  const [phase, setPhase] = useState<"idle" | "running" | "failed">("idle");
  useMountEffect(() => {
    bridge("getDaemonSetup")?.().then(setMachine).catch(() => {});
  });
  const run = bridge("runDaemonSetup");

  if (!run || !machine?.supported || phase === "failed") {
    return (
      <>
        {phase === "failed" && (
          <p className="text-sm text-sol-text-muted text-center mb-3">
            Setup did not finish from here. Paste this in a terminal instead:
          </p>
        )}
        <SetupTokenCommand onStart={phase === "failed" ? undefined : onStart} />
      </>
    );
  }

  const start = async () => {
    onStart?.();
    setPhase("running");
    track("desktop_setup_started", { location: "onboarding_empty_state" });
    try {
      const { token } = await createSetupToken({});
      const result = await run(token);
      track("desktop_setup_finished", result.ok ? { ok: true } : { ok: false, error: setupError(result.error) });
      if (!result.ok) return setPhase("failed");
      markCliConnected();
      onConnected();
    } catch {
      track("desktop_setup_finished", { ok: false, error: "threw" });
      setPhase("failed");
    }
  };

  return (
    <div className="space-y-2">
      <button
        onClick={start}
        disabled={phase === "running"}
        className="w-full px-4 py-3 bg-sol-yellow/20 hover:bg-sol-yellow/30 text-sol-yellow text-sm font-medium rounded-xl border border-sol-yellow/30 transition-colors disabled:opacity-60"
      >
        {phase === "running" ? "Setting up this machine…" : "Set up this machine"}
      </button>
      <p className="text-xs text-sol-text-dim text-center">
        Installs the cast CLI and a background daemon, and syncs your agent sessions to your private workspace.
      </p>
    </div>
  );
}

/** The assistant start: a composer on the hosted assistant, whatever the
 *  default agent would be, since nothing has to be installed for it. */
function useAskAssistant(): () => void {
  const openCompose = useInboxStore((s) => s.openCompose);
  return () => {
    track("first_run_start_chosen", { start: "assistant" });
    openCompose(undefined, { agentType: HOSTED_AGENT_TYPE });
  };
}

const chooseMachine = () => track("first_run_start_chosen", { start: "machine" });

const SETUP_GUIDE = (
  <a href="/settings/cli" className="text-sol-yellow hover:text-sol-yellow/80 transition-colors">
    Setup guide
  </a>
);

// The first run for a signed-in person with no machine: two starts side by
// side, the hosted assistant right here or the coding tools on their own
// machine, worded so each reader knows which is theirs. A first message to
// the assistant moves them to hosted mode (lib/firstRun.ts). A machine that
// just connected replaces both with the wait for its sessions.
function OnboardingEmptyState({ hasOtherSessions }: { hasOtherSessions?: boolean }) {
  const [connected, setConnected] = useState(() => cliJustConnected());
  const onConnected = () => setConnected(true);
  const askAssistant = useAskAssistant();
  const mail = useConnectAvailable().available === true;
  if (hasOtherSessions && !connected) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center px-4">
        <div className="max-w-sm w-full">
          <p className="text-sm text-sol-text-muted mb-4">
            No personal sessions yet. Install the CLI to start syncing your own sessions.
          </p>
          <SetupThisMachine onConnected={onConnected} onStart={chooseMachine} />
          <p className="text-xs text-sol-text-dim mt-3">
            Works with Claude Code, Codex, Cursor, and Gemini. {SETUP_GUIDE}
          </p>
          <button type="button" onClick={askAssistant} className="mt-5 text-sm text-sol-text-muted underline decoration-sol-border underline-offset-4 transition-colors hover:text-sol-text">
            Or ask the Codecast assistant, nothing to install
          </button>
        </div>
      </div>
    );
  }

  return (
    // The faded sessions and the card share one grid cell, so the card sets
    // the height on a phone, where its two starts stack.
    <div className="relative grid grid-cols-1 overflow-hidden">
      <div className="[grid-area:1/1] min-w-0 space-y-3 opacity-[0.12] pointer-events-none select-none" aria-hidden="true">
        {FAKE_SESSIONS.map((session, i) => (
          <FakeSessionCard key={i} session={session} />
        ))}
      </div>

      <div className="[grid-area:1/1] min-w-0 flex items-start justify-center pt-10 pb-6 sm:pt-20">
        <div className="relative max-w-2xl w-full min-w-0 mx-1 sm:mx-4">
          <div className="rounded-2xl border border-sol-border/60 bg-sol-bg/90 dark:bg-sol-bg/95 backdrop-blur-xl shadow-2xl p-5 sm:p-8">
            {connected ? (
              <div className="text-center">
                <h2 className="text-xl sm:text-2xl font-semibold text-sol-text mb-2 font-serif">
                  This machine is connected
                </h2>
                <p className="text-sm text-sol-text-muted">
                  Your sessions start appearing here the moment the daemon starts, past ones included. If your terminal is asking setup questions, finish them first.
                </p>
              </div>
            ) : (
              <>
                <div className="text-center mb-6">
                  <h2 className="text-xl sm:text-2xl font-semibold text-sol-text mb-2 font-serif">
                    How would you like to start?
                  </h2>
                  <p className="text-sm text-sol-text-muted">
                    Ask the assistant right here, or connect the coding tools on your computer.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <section className="flex flex-col rounded-xl border border-sol-border/70 bg-sol-bg-alt/40 p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <AgentTypeIcon agentType={HOSTED_AGENT_TYPE} className="h-5 w-5" />
                      <h3 className="text-sm font-semibold text-sol-text">Ask the Codecast assistant</h3>
                    </div>
                    <p className="mb-4 flex-1 text-sm leading-relaxed text-sol-text-muted">
                      Nothing to install. Ask in plain words for research, writing and planning{mail ? ", or for help with your mail and calendar through Whisk" : ""}.
                    </p>
                    <button
                      type="button"
                      onClick={askAssistant}
                      className="w-full rounded-xl bg-sol-text px-4 py-3 text-sm font-medium text-sol-bg transition-opacity hover:opacity-90"
                    >
                      Start a conversation
                    </button>
                  </section>

                  <section className="flex flex-col rounded-xl border border-sol-border/70 bg-sol-bg-alt/40 p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <TerminalSquare aria-hidden className="h-5 w-5 text-sol-yellow" />
                      <h3 className="text-sm font-semibold text-sol-text">Connect your coding tools</h3>
                    </div>
                    <p className="mb-4 flex-1 text-sm leading-relaxed text-sol-text-muted">
                      For developers: sync your Claude Code, Codex, Cursor and Gemini sessions, and run them from anywhere. {SETUP_GUIDE}
                    </p>
                    <SetupThisMachine onConnected={onConnected} onStart={chooseMachine} />
                  </section>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Hosted mode's first run: nothing to install, so the empty inbox offers the
// assistant. Its first asks are /welcome's (firstAsks) and send on a tap, as
// they do there, landing in the new conversation; under them sits the same
// composer /welcome uses, so the first ask in one's own words is a keystroke
// away. An errand carried in from the marketing page that /welcome could not
// ask yet (thinking was down) waits in it. Someone back finds their move and
// the next routine first, with fewer asks under them (AssistantIntro
// `returning`).
function HostedEmptyState() {
  const ask = (text: string) => {
    forgetCarriedAsk();
    useInboxStore.getState().navigateToSession(startHostedConversation(text));
  };
  const held = !!useHostedAskGate();
  const [seed] = useState(() => {
    const text = carriedAsk();
    return text ? { text, at: 1 } : null;
  });
  return (
    <div className="flex h-full min-h-[360px] flex-col py-16">
      <AssistantIntro onAsk={ask} title={LANE_COPY.home.title} returning={<RailAwareReturning />}>
        {held ? null : (
          <div data-simple-lane="inline" className="mt-2 w-full max-w-md text-left">
            <Composer placeholder="Or ask in your own words" onSend={ask} seed={seed} />
          </div>
        )}
      </AssistantIntro>
    </div>
  );
}

/** What waits on the person and the next routine. The rail beside the home
 *  already leads with its Your move rows and ends on the same Coming up
 *  line, so while it shows (from lg up) the home leaves both to it; on a
 *  phone, or with the rail folded, the home says them. */
function RailAwareReturning() {
  const railOpen = useInboxStore((s) => isSessionRailOpen(s.workspace as WorkspaceState));
  return (
    <div className={`flex w-full flex-col items-center ${railOpen ? "lg:hidden" : ""}`}>
      <HostedWaitingList />
      <HostedNewList />
      <HostedComingUp />
    </div>
  );
}

/** The person's next routine run, in the rail foot's words ("Coming up:
 *  Morning review, tomorrow at 8:00 AM"), linking to Routines. Nothing
 *  scheduled, no line. */
function HostedComingUp() {
  const { tasks } = useTriggers();
  const now = Date.now();
  let next: any = null;
  for (const task of tasks) {
    if (!isAssistantRoutine(task) || task.status !== "scheduled" || !(task.run_at > now)) continue;
    if (!next || task.run_at < next.run_at) next = task;
  }
  if (!next) return null;
  return (
    <Link href="/triggers" data-cc-home-coming-up className="mt-3 block w-full max-w-md px-1 text-left text-xs text-sol-text-dim no-underline [text-wrap:pretty] transition-colors hover:text-sol-text-muted">
      {/* The when is one unit, so "8:00 AM" never sits alone on a line. */}
      {`${LANE_COPY.home.comingUp}: ${taskDisplayTitle(next)}, `}
      <span className="whitespace-nowrap">{firstRunWords(next.run_at, now)}</span>
    </Link>
  );
}

/** Under the start: the conversations waiting on the person (an OK, a
 *  reply), the same rows the Inbox count counts, so the home is a calm
 *  start page that still says what needs them. Nothing waiting, no list. */
const WAITING_SHOWN = 5;
function HostedWaitingList() {
  const rows = useWaitingOnPerson();
  if (rows.length === 0) return null;
  const open = (id: string) => useInboxStore.getState().navigateToSession(id);
  return (
    <section data-cc-home-waiting className="mt-6 w-full max-w-md text-left">
      <h2 className="mb-1.5 px-1 text-xs font-medium text-sol-text-muted">{LANE_COPY.home.waiting}</h2>
      <ul className="flex flex-col">
        {rows.slice(0, WAITING_SHOWN).map((row) => (
          <li key={row._id}>
            <button
              type="button"
              onClick={() => open(row._id)}
              className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm text-sol-text transition-colors hover:bg-sol-bg-alt"
            >
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-sol-orange" />
              <span className="min-w-0 flex-1 truncate">{sessionCardTitle(row)}</span>
            </button>
          </li>
        ))}
      </ul>
      {rows.length > WAITING_SHOWN && <p className="px-1 pt-1 text-xs text-sol-text-dim">{LANE_COPY.home.showMore(rows.length - WAITING_SHOWN)} in the inbox</p>}
    </section>
  );
}

/** Under Your move, where no rail shows them (a phone, a folded rail): the
 *  newest results the person has not read, the rail's own New rows, and a
 *  line that opens the rest in the conversations panel. */
const NEW_SHOWN = 3;
function HostedNewList() {
  const rows = useNewResults();
  if (rows.length === 0) return null;
  const store = useInboxStore.getState;
  return (
    <section data-cc-home-new className="mt-6 w-full max-w-md text-left">
      <h2 className="mb-1.5 px-1 text-xs font-medium text-sol-text-muted">New</h2>
      <ul className="flex flex-col">
        {rows.slice(0, NEW_SHOWN).map((row) => (
          <li key={row._id}>
            <button
              type="button"
              onClick={() => store().navigateToSession(row._id)}
              className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm transition-colors hover:bg-sol-bg-alt"
            >
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--pd-accent,var(--sol-orange))]" />
              <span className="min-w-0 flex-1 truncate font-medium text-sol-text">{sessionCardTitle(row)}</span>
              <span className="shrink-0 text-xs tabular-nums text-sol-text-dim">{formatRowTime(row.updated_at, true)}</span>
            </button>
          </li>
        ))}
      </ul>
      {rows.length > NEW_SHOWN && (
        <button type="button" onClick={() => store().toggleSidePanel()} className="px-1 pt-1 text-xs text-sol-text-dim underline-offset-2 hover:text-sol-text hover:underline">
          {LANE_COPY.home.showMore(rows.length - NEW_SHOWN)} in the inbox
        </button>
      )}
    </section>
  );
}

export function EmptyState({ title, description, action, variant, hasOtherSessions }: EmptyStateProps) {
  const installCli = useSurface("empty.installCli");
  if (variant === "onboarding") {
    return installCli ? <OnboardingEmptyState hasOtherSessions={hasOtherSessions} /> : <HostedEmptyState />;
  }

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-16 h-16 bg-sol-base02 rounded-full flex items-center justify-center mb-4">
        <svg
          className="w-8 h-8 text-sol-base0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
      </div>
      <h3 className="text-lg font-medium text-sol-text mb-2">{title}</h3>
      <p className="text-sol-text-muted max-w-sm mb-4">{description}</p>
      {action && (
        <a
          href={action.href}
          className="text-blue-400 hover:text-blue-300 text-sm"
        >
          {action.label} &rarr;
        </a>
      )}
    </div>
  );
}
