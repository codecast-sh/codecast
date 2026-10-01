/**
 * The model every surface reads: the terminal views, the HTML pages and the
 * CLI. An app maps its own rows into these shapes through the adapter
 * interfaces at the bottom, and nothing above the adapter knows a table name.
 *
 * Three subjects, one loop. A CONVERSATION is what people and the assistant
 * said to each other, numbered so a reader and a command can point at one
 * message. A FREEZE is a moment in one where the assistant had to act, cut so
 * a replay sees nothing later. A RUN is what the product did when it was run
 * forward from a scenario or a freeze against simulated people: the story
 * (both sides, in virtual time), the events, the sends, and the score.
 *
 * Multiplayer is the point. Every message names a participant, participants
 * have roles (the owner, the assistant, a paired person, a persona, a third
 * party), and both the terminal and the page colour by participant, so a
 * room of three reads as three voices and never as "in" and "out".
 */

// ── Participants ─────────────────────────────────────────────────────────

export type ParticipantRole = 'owner' | 'assistant' | 'paired' | 'persona' | 'third-party' | 'system' | 'unknown';

export interface Participant {
  /** Stable within a conversation or run. Messages point at it. */
  id: string;
  name: string;
  role: ParticipantRole;
  /** Every address this participant holds: a phone, a mailbox, a chat id. */
  addresses: string[];
  /** The rail they mostly use, when one is known. */
  rail?: string | null;
  /** What they are to the owner, in the owner's words. */
  relationship?: string | null;
  /** A persona's temperament: engaged, slow, terse, silent. */
  disposition?: string | null;
  /** A persona's private goal. Evidence only: it never reaches a prompt. */
  goal?: string | null;
}

// ── Conversations ────────────────────────────────────────────────────────

export type Direction = 'in' | 'out' | 'system';

export interface ConvoMessage {
  /** Stable chronological number for the subject: 1 is the oldest thing that ever happened. */
  n: number;
  id: string;
  /** ISO. Virtual time inside a run. */
  at: string;
  /** The rail: imessage, sms, app, email, telegram, slack. */
  channel: string;
  channelId?: string | null;
  /** The room or thread title when this was said in a group. */
  room?: string | null;
  isGroup: boolean;
  direction: Direction;
  /** Participant id. */
  from: string;
  /** Participant id, or a bare address nobody resolved. */
  to?: string | null;
  text: string;
  /** Delivery state: received, sent, delivered, held, failed, suppressed. */
  status?: string | null;
  /** The run that produced or handled it. */
  runId?: string | null;
  media?: Array<{ name?: string; kind?: string; url?: string }>;
  /** A system line's kind and payload; a persona's reason for silence. */
  meta?: Record<string, unknown>;
}

export interface ConvoSubject {
  /** user, person, room, channel, thread: the app's own vocabulary. */
  kind: string;
  id: string;
  title: string;
  subtitle?: string | null;
}

export interface Conversation {
  subject: ConvoSubject;
  participants: Participant[];
  /** Oldest first, numbered. */
  messages: ConvoMessage[];
  /** How many the subject has in all, when `messages` is a window. */
  total: number;
}

export interface InboxRow {
  messageId: string;
  at: string;
  subject: ConvoSubject;
  from: string;
  channel: string;
  preview: string;
  /** Nobody answered it yet. */
  unanswered: boolean;
}

export interface SearchHit {
  messageId: string;
  at: string;
  subject: ConvoSubject;
  channel: string;
  from: string;
  excerpt: string;
}

export interface MessageDetail {
  message: ConvoMessage;
  subject: ConvoSubject;
  participant: Participant | null;
  /** The run that produced or handled it, when the app keeps runs. */
  run?: { id: string; status: string; digest?: string | null; costUsd?: number | null; steps?: number | null } | null;
  /** The row as the app stores it, for `--json`. */
  raw?: unknown;
}

export type Resolution = { subject: ConvoSubject; focusId?: string | null } | { candidates: ConvoSubject[] };

export interface ConvoSource {
  inbox(opts: { since?: number; channel?: string; unanswered?: boolean; limit?: number }): Promise<InboxRow[]>;
  /** A ref is an id or prefix, an address, a name, or a message id; ambiguity comes back as candidates. */
  resolve(ref: string): Promise<Resolution | null>;
  load(subject: ConvoSubject, opts?: { system?: boolean }): Promise<Conversation>;
  message(id: string): Promise<MessageDetail | null>;
  find(text: string, opts: { subject?: ConvoSubject; channel?: string; since?: number; limit?: number }): Promise<SearchHit[]>;
}

// ── Freezes ──────────────────────────────────────────────────────────────

export interface Freeze {
  id: string;
  name: string;
  createdAt: string;
  /** The message or production run the moment was cut at. */
  anchor: { kind: 'message' | 'run'; id: string };
  subject: ConvoSubject;
  /** The instant the world is cut at. A replay sees nothing later. */
  asOf: string;
  /** What woke the assistant at that moment, in the app's own terms. */
  trigger?: { type: string; data?: Record<string, unknown> } | null;
  notes?: string | null;
  /** The judge's criteria, in plain words. Every replay and the production reply are graded by it. */
  judge?: string | null;
  tags: string[];
  /** Whatever the app needs to rebuild the moment: an owner id, a channel, addresses. */
  meta?: Record<string, unknown>;
}

export interface FreezeStore {
  create(freeze: Omit<Freeze, 'id' | 'createdAt'> & { id?: string }): Promise<Freeze>;
  list(filter?: { q?: string; tag?: string; subjectId?: string }): Promise<Freeze[]>;
  /** By id or id prefix. */
  get(ref: string): Promise<Freeze | null>;
  update(id: string, patch: Partial<Omit<Freeze, 'id' | 'createdAt'>>): Promise<Freeze>;
  remove(id: string): Promise<boolean>;
}

/** How the app turns "freeze here" into a moment. */
export interface FreezeResolver {
  resolve(input: { messageRef?: string; runRef?: string }): Promise<Omit<Freeze, 'id' | 'createdAt' | 'tags' | 'notes' | 'judge'>>;
}

export interface ReplayOptions {
  reps: number;
  /** A model id for the assistant under test; the judge is unaffected. */
  model?: string | null;
  /** A scripted model: proves the wiring, spends nothing, says nothing about the product. */
  dry?: boolean;
  notes?: string | null;
  /** Keep running past the reply, with personas answering, for this many virtual hours. */
  horizonHours?: number | null;
  /** Called with every line the replay prints, so the terminal streams. */
  onLine?: (line: string) => void;
}

/**
 * Runs a freeze forward. Each rep lands as a run in the app's `RunSource`
 * with `freezeId` set, so results, diffs and pages come from one place.
 */
export interface Replayer {
  replay(freeze: Freeze, opts: ReplayOptions): Promise<RunSummary[]>;
}

export interface Verdict {
  score: number;
  pass: boolean;
  reasoning?: string | null;
}

export interface ProductionReply {
  /** What the assistant actually said after the frozen moment, in production. */
  messages: ConvoMessage[];
  verdict?: Verdict | null;
}

export interface ReplyJudge {
  /** Grade a reply against the freeze's criteria. */
  judge(freeze: Freeze, messages: ConvoMessage[]): Promise<Verdict>;
}

// ── Runs ─────────────────────────────────────────────────────────────────

export type Audience = 'owner' | 'paired' | 'room' | 'third-party' | 'unknown';

export interface RunSend {
  seq: number;
  at: string;
  label?: string | null;
  rail: string | null;
  to: string | null;
  text: string;
  chars?: number;
  channelId?: string | null;
  isGroup: boolean;
  audience: Audience;
  runId?: string | null;
  messageId?: string | null;
}

export interface RunEvent {
  seq: number;
  virtualAt: string;
  realAt?: string | null;
  kind: string;
  payload: Record<string, unknown>;
}

export interface GateEvidence {
  summary: string;
  scanned?: number;
  /** Held because there was nothing to search. */
  vacuous?: boolean;
  sends?: RunSend[];
  excerpts?: Array<{ where: string; text: string }>;
  rows?: Array<{ table: string; row: unknown }>;
}

export interface GateResult {
  id: string;
  title?: string | null;
  pass: boolean;
  decidedBy?: 'mechanical' | 'judge';
  evidence: GateEvidence;
}

export interface CheckResult {
  id: string;
  ask?: string | null;
  weight: number;
  score: number;
  reasoning?: string | null;
  evidence?: string | null;
  /** A floor: under it the run fails whatever the mean says. */
  must?: number | null;
}

export interface Score {
  pass: boolean;
  /** 0 when any gate fails; otherwise the weighted mean of the checks. */
  score: number;
  passMark: number;
  gates: GateResult[];
  checks: CheckResult[];
  missedFloors?: Array<{ id: string; score: number; must: number }>;
  judgeCostUsd?: number | null;
  judgeModel?: string | null;
  scoredAt?: string | null;
  /** One verdict per side, for a scenario with several teams or households. */
  perParticipant?: Record<string, { score: number; reasoning?: string | null }>;
}

export interface RunCounters {
  endedBecause?: string | null;
  stopReason?: string | null;
  steps?: number;
  runsExecuted?: number;
  ticks?: number;
  shifts?: number;
  rowsShifted?: number;
  virtualElapsedMs: number;
  realElapsedMs: number;
  costUsd: number;
  blocks?: number;
  captures?: number;
}

export type RunStatus = 'pass' | 'fail' | 'crash' | 'unscored' | 'running';

export interface RunSummary {
  id: string;
  scenario: string;
  title: string;
  hunts?: string | null;
  seed: number;
  /** Where the run's clock began: virtual time. */
  startedAt: string;
  /** When it was run: real time. */
  createdAt: string;
  status: RunStatus;
  score: number | null;
  gatesFailed: string[];
  missedFloors: string[];
  sends: number;
  costUsd: number;
  realMs: number;
  virtualMs: number;
  /** Set when the run replayed a freeze. */
  freezeId?: string | null;
  /** Free text the replay was launched with: what was changed. */
  notes?: string | null;
  model?: string | null;
}

/** One assistant run inside a simulation, with its tool calls, for the drill down. */
export interface AgentRunRecord {
  id: string;
  at: string;
  triggerType?: string | null;
  status: string;
  costUsd?: number | null;
  /** The model that answered this run, as the runner recorded it. */
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** Wall clock for the run, model calls and tools together. */
  durationMs?: number | null;
  reply?: string | null;
  steps?: Array<{ n: number; tool: string | null; input?: unknown; output?: unknown; gate?: unknown; thinking?: string | null }>;
}

export interface RunDetail extends RunSummary {
  participants: Participant[];
  /** The story: everything said by anybody, in virtual time, plus the beats and silences between. */
  messages: ConvoMessage[];
  events: RunEvent[];
  sendsList: RunSend[];
  verdict: Score | null;
  counters: RunCounters | null;
  /** Calls the boundary caught, by label. */
  captures: Array<{ label: string; count: number }>;
  blocked: Array<{ at: string; host: string; method: string; url: string }>;
  agentRuns: AgentRunRecord[];
  evidenceDir?: string | null;
  /** The tail of the log, for a run that crashed. */
  error?: string | null;
}

export interface RunSource {
  list(filter?: { scenario?: string; since?: number; limit?: number; freezeId?: string; status?: RunStatus }): Promise<RunSummary[]>;
  /** By id or id prefix. */
  get(ref: string): Promise<RunDetail | null>;
}

// ── Simulations ──────────────────────────────────────────────────────────

export interface ScenarioInfo {
  id: string;
  title: string;
  hunts?: string | null;
}

export interface SimLauncher {
  scenarios(): Promise<ScenarioInfo[]>;
  /** `model` is the assistant's model for the run; the judge is unaffected. */
  run(scenarioId: string, opts: { seed?: number; dry?: boolean; model?: string | null; onLine: (line: string) => void }): Promise<{ exitCode: number; runId: string | null }>;
  sweep?(opts: { only?: string[]; seeds?: number[]; dry?: boolean; model?: string | null; parallel?: number; onLine: (line: string) => void }): Promise<{ exitCode: number; runIds: string[] }>;
}

// ── What an app hands the CLI ────────────────────────────────────────────

export interface EvalSources {
  /** The command name, for the "Next:" hints: `xrun`. */
  name: string;
  convo?: ConvoSource;
  freezes?: FreezeStore;
  freezeResolver?: FreezeResolver;
  replayer?: Replayer;
  productionReply?: (freeze: Freeze) => Promise<ProductionReply | null>;
  judge?: ReplyJudge;
  runs?: RunSource;
  sims?: SimLauncher;
  /** Where `html` commands write pages. */
  htmlDir?: string;
}
