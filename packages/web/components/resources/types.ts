// The resource monitor's view contract. The page renders only these shapes:
// machines come from the machineResources feed joined to the device roster,
// sessions from the managed fleet joined to canonical inbox rows, and the
// offload plan from lib/resourceOffload's pure planner. Nothing here is
// computed from a session's title or repo; every readiness claim arrives
// from the planner with its evidence.
import type {
  MachineResourceSnapshot,
  ResourceIncident,
  ResourcePoint,
} from "@codecast/shared/contracts";
import type { MigrationRowStatus } from "../../lib/migrationPlan";

export type MachineRole = "local" | "cloud_linux" | "cloud_mac";

export type ResourceMachine = {
  deviceId: string;
  name: string;
  role: MachineRole;
  platform: string;
  online: boolean;
  /** A cloud host that is stopped but boots when work arrives. */
  asleep?: boolean;
  /** When the server last received a snapshot; undefined = never reported. */
  receivedAt?: number;
  snapshot?: MachineResourceSnapshot;
  history: ResourcePoint[];
};

export type ResourceSessionState = "working" | "needs_input" | "idle" | "hibernated" | "dead";

export type ResourceSession = {
  sessionId: string;
  conversationId?: string;
  shortId?: string;
  title: string;
  projectPath?: string;
  agentType?: string;
  deviceId?: string;
  state: ResourceSessionState;
  lastActiveAt?: number;
  pinned?: boolean;
};

export type OffloadReadiness = "ready" | "preflight_required" | "blocked" | "unsupported";

export type OffloadDestination = {
  deviceId: string;
  name: string;
  role: MachineRole;
  online: boolean;
  asleep?: boolean;
  /** The destination's latest fresh sample; absent means its load is unknown, never idle. */
  sample?: ResourcePoint;
  /** Undefined means the cost is unknown, never free. */
  costPerHour?: number;
};

export type OffloadCandidate = {
  sessionId: string;
  /** Concrete, measured reason this session is worth moving. */
  reason: string;
  confidence: "high" | "medium" | "low";
  /** A range: resident memory counts shared pages, so relief is never exact. */
  relief: { cpu?: number; rssLow?: number; rssHigh?: number };
  staysLocal: Array<{ label: string; pid?: number; cpu?: number; rss?: number; why: string }>;
  disruption: "idle" | "between_turns" | "mid_turn";
  perDestination: Record<string, {
    readiness: OffloadReadiness;
    /** Hard stops. Never overridable from this surface. */
    blockers: string[];
    /** Checks that passed, from preflight or the server dry run. */
    passed?: string[];
    /**
     * Prerequisites no automated check can prove (project secrets, local
     * devices, browser logins). The user may attest to them per session;
     * attesting never marks them verified.
     */
    pending: string[];
    /** Worth knowing, never a reason to stay (helpers the laptop's hooks call that the host lacks). */
    notes?: string[];
    /** Why this destination fits or does not, from observed work (e.g. Xcode seen). */
    fit?: string;
  }>;
  /** Observed evidence that the session needs macOS, if any. */
  requiresMac?: string;
  suggestedDestinationId?: string;
};

export type OffloadPlan = {
  deviceId: string;
  /** The source's sample the plan was built from: the base every "after the move" figure is computed against. */
  sourceSample: ResourcePoint;
  incident: ResourceIncident;
  generatedAt: number;
  destinations: OffloadDestination[];
  candidates: OffloadCandidate[];
  notOffered: Array<{ sessionId: string; reason: string }>;
};

export type OffloadRunRow = {
  sessionId: string;
  destinationId: string;
  status: MigrationRowStatus;
  error?: string;
  startedAt?: number;
};

export type OffloadRun = {
  batchId: string;
  createdAt: number;
  waitForTurnMs: number;
  rows: OffloadRunRow[];
  /** Why cancelling is not possible yet, e.g. the batch is still being created. */
  cancelUnavailable?: string;
  /** When the last row reached a terminal state. */
  finishedAt?: number;
  /** Machine samples bracketing the batch; `after` counts only if taken after finishedAt. */
  measured?: { before: ResourcePoint; after?: ResourcePoint };
};

export type OffloadSelection = {
  sessionId: string;
  destinationId: string;
  /** The pending items the user confirmed they checked, verbatim. */
  attested: string[];
};

/**
 * Every callback is optional. An absent callback renders its control
 * disabled with the reason, so a fixture can never imply a live operation.
 */
export type ResourceActions = {
  onOpenSession?: (sessionId: string) => void;
  onPark?: (sessionIds: string[]) => void;
  onResume?: (sessionIds: string[]) => void;
  onDismissPlan?: (deviceId: string, until: number) => void;
  onPreflight?: (selections: OffloadSelection[]) => void;
  /** Always the safe mode: waits for a turn boundary, never interrupts. */
  onStartOffload?: (selections: OffloadSelection[], opts: { waitForTurnMs: number }) => void;
  onRetry?: (batchId: string, sessionId: string) => void;
  onCancel?: (batchId: string) => void;
};

export type ResourceMonitorProps = {
  machines: ResourceMachine[];
  sessions: ResourceSession[];
  /** False while the feed has never answered and the cache is empty. */
  ready: boolean;
  now: number;
  plans?: OffloadPlan[];
  runs?: OffloadRun[];
  actions?: ResourceActions;
  /** Says why actions are off, e.g. "Preview data: nothing here acts on a machine". */
  actionsDisabledReason?: string;
  /** A standing banner naming the data as sample data (the preview sets it). */
  sampleNotice?: string;
};
