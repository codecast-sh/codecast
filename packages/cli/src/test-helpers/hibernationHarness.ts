import { readFileSync } from "node:fs";
import path from "node:path";
import { ACTIVE_AGENT_STATUSES, DECLARED_VERDICT_STATUSES } from "@codecast/shared/contracts";
import * as policy from "../hibernation.js";
import { functionBlock } from "./sourceRegion.js";

const names = [
  "collectHibernationCandidates", "hibernationRefusalReason", "hibernateSessionNow", "runHibernationPass",
  "trackSessionPaneForTests", "sessionParkStateForTests", "setSyncServiceForTests",
  "wakeStatusAfterPark", "clearHibernationPark", "forgetHibernationPark", "clearSessionTrackingForKill",
  "subagentParentSessionFromPath", "noteSubagentActivity", "subagentActiveAgoMs", "resetSubagentActivityForTests",
  "sendAgentStatus", "markTurnStarted", "statusFlipStartsTurn", "reapOneTerminal", "withTmuxLock", "injectViaTmux",
] as const;

type PublicNames = Extract<typeof names[number], keyof typeof import("../daemon.js")>;
type HarnessApi = Pick<typeof import("../daemon.js"), PublicNames> & {
  reapOneTerminal(sessionId: string, tmux: string, convId: string | undefined, idleHours: number, opts?: { parkAs?: "idle" | "hibernated" }): Promise<boolean>;
  sendAgentStatus(...args: unknown[]): void;
  state: {
    resumeInFlight: Map<string, Promise<boolean>>;
    resumeSessionCache: Map<string, string>;
    lastSentAgentStatus: Map<string, string>;
    managedHeartbeatSessions: Set<string>;
    tmuxTargetLocks: Map<string, Promise<void>>;
  };
};

export function createHibernationHarness() {
  const source = readFileSync(new URL("../daemon.ts", import.meta.url), "utf8");
  const effects: Array<{ kind: string; args: unknown[] }> = [];
  const record = (kind: string) => (...args: unknown[]) => { effects.push({ kind, args }); };
  const forbidden = (kind: string) => (...args: unknown[]): never => {
    record(kind)(...args);
    throw new Error(`Unexpected IO: ${kind}`);
  };
  const deps = {
    ...policy, path, ACTIVE_AGENT_STATUSES, DECLARED_VERDICT_STATUSES,
    hasTmux: () => true,
    log: record("log"), reaperLog: record("log"),
    stopCodexPermissionPoller: record("poller-stop"),
    ensureHeartbeatFlushLoop: forbidden("heartbeat-start"),
    tmuxExec: forbidden("terminal"), killTmuxSessionAndTree: forbidden("kill"),
    tmuxPaneCwd: forbidden("cwd"), releaseSessionWorktree: forbidden("gc"),
    classifyLivePaneFor: forbidden("classify"), detectSessionAgentType: forbidden("agent-type"),
    injectViaTmuxInner: async (...args: unknown[]) => { record("inject")(...args); },
    readConversationCache: () => ({}),
    productionHibernationIo: Object.fromEntries([
      "policy", "tmuxSessions", "awakeIdleMs", "subagentActiveAgoMs", "conversationIds",
      "askSidecarMtimeMs", "transcriptLastRealMs", "lifecycle", "canReapPidTree", "deliveryActive", "park", "now",
    ].map((key) => [key, forbidden(`production-${key}`)])),
    summarizeReapSkips: (skips: string[]) => skips.join(","),
  };
  const maps = [
    "resumeSessionCache", "lastSentAgentStatus", "lastResumeAt", "lastHeartbeatLogged", "subagentActivityByParent",
    "sessionProcessCache", "resumeInFlight", "resumeInFlightStarted", "lastWorkingStatusSent", "turnStartedAt",
    "pendingOpenTaskReports", "lastOpenTasksSentAt", "lastOpenTasksSentJson", "tmuxTargetLocks",
  ].map((name) => `const ${name} = new Map();`).join("\n");
  const sets = ["managedHeartbeatSessions", "hibernatedSessions", "hibernationStampCleared", "restartingSessionIds"]
    .map((name) => `const ${name} = new Set();`).join("\n");
  const body = names.map((name) => functionBlock(source, name).text.replace(/^export /, "")).join("\n");
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`
    ${maps}
    ${sets}
    let syncServiceRef = null;
    const SUBAGENT_ACTIVITY_MAX_ENTRIES = 500;
    const WORKING_STATUS_THROTTLE_MS = 10_000;
    const TMUX_LOCK_WAIT_MS = 60_000;
    const SETTLE_STATUSES_WITH_TASKS = new Set(["idle", "waiting", "dormant", "done"]);
    const stopManagedSessionHeartbeat = (id) => managedHeartbeatSessions.delete(id);
    ${body}
    return { ${names.join(",")}, state: { resumeInFlight, resumeSessionCache, lastSentAgentStatus, managedHeartbeatSessions, tmuxTargetLocks } };
  `);
  const api = new Function(...Object.keys(deps), code)(...Object.values(deps)) as HarnessApi;
  return { ...api, effects };
}
