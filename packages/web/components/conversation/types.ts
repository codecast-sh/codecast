import type { ThreadStateFields, DecisionAnswerMessage } from "@codecast/shared/contracts";
import type { RoleWakeFrame } from "../roleWake";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { SentFileData } from "../tools/SentFileBlock";
import type { ChatWakePrompt, HuddleSummaryTag } from "../sessionMessage";

// View density for the conversation. The first three render the message feed
// with progressively less chrome; "story" and "summary" replace the feed with
// LLM-condensed views backed by storyMode.ts.
export type ConversationDensity = "full" | "condensed" | "compact" | "story" | "summary";
export type MessageFeedDensity = "full" | "condensed" | "compact";

export type ToolCall = {
  id: string;
  name: string;
  input: string;
};

export type ToolResult = {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type ImageData = {
  media_type: string;
  data?: string;
  storage_id?: string;
  tool_use_id?: string;
  // Set on an optimistic message whose image is still uploading: a local blob:
  // URL for the thumbnail, plus a flag to overlay an upload spinner. Cleared
  // (swapped for storage_id) once the background upload completes.
  preview_url?: string;
  uploading?: boolean;
};

export type Message = {
  _id: string;
  message_uuid?: string;
  client_id?: string;
  // Sender of a user message when it differs from the conversation owner
  // (team sends, cast send, fork replies). Absent = the owner typed it.
  from_user_id?: string;
  role: string;
  content?: string;
  timestamp: number;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_results?: ToolResult[];
  images?: ImageData[];
  files?: SentFileData[];
  subtype?: string;
  model?: string;
  _isOptimistic?: true;
  _isQueued?: true;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

export type ConversationData = {
  _id: Id<"conversations">;
  user_id?: string;
  is_own?: boolean;
  title?: string;
  session_id?: string;
  agent_type?: string;
  model?: string;
  started_at?: number;
  updated_at?: number;
  share_token?: string;
  message_count?: number;
  messages: Message[];
  user?: { name?: string; email?: string; avatar_url?: string | null } | null;
  parent_conversation_id?: string | null;
  child_conversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }>;
  child_conversation_map?: Record<string, string>;
  git_branch?: string | null;
  git_status?: string | null;
  git_remote_url?: string | null;
  project_path?: string | null;
  git_root?: string | null;
  short_id?: string;
  status?: "active" | "completed";
  fork_count?: number;
  forked_from?: string;
  fork_status?: "copying" | "complete" | "failed";
  fork_copied?: number;
  fork_copy_total?: number;
  // The handoff pair (`cast handoff --to`, handoff.start): a child carries
  // where it came from, a source where it continued. Details mirror
  // forked_from_details' access rules; the bare ids ride the list payload.
  handed_off_from_conversation_id?: string | null;
  handed_off_to_conversation_id?: string | null;
  handed_off_from_details?: HandoffLinkDetails | null;
  handed_off_to_details?: HandoffLinkDetails | null;
  forked_from_details?: {
    conversation_id: string;
    title?: string;
    share_token?: string;
    username: string;
    // Triage stamps for the parent-preload seed (see inboxVisibilityFields).
    inbox_dismissed_at?: number | null;
    inbox_stashed_at?: number | null;
    inbox_killed_at?: number | null;
    inbox_pinned_at?: number | null;
  } | null;
  is_favorite?: boolean;
  profile_pinned_at?: number;
  workflow_run_id?: string | null;
  is_workflow_primary?: boolean;
  draft_message?: string;
  subtitle?: string | null;
  stable_context?: string | null;
  compaction_count?: number;
  loaded_start_index?: number;
  agent_name_map?: Record<string, string>;
  agent_name_entries?: Array<[string, string]>;
  fork_children?: Array<{
    _id: string;
    title: string;
    short_id?: string;
    started_at: number;
    username: string;
    parent_message_uuid?: string;
    message_count?: number;
    agent_type?: string;
    first_divergent_preview?: string;
  }>;
  fork_siblings?: Array<{
    _id: string;
    title: string;
    short_id?: string;
    started_at: number;
    username: string;
    parent_message_uuid?: string;
    message_count?: number;
    agent_type?: string;
    first_divergent_preview?: string;
  }>;
  main_divergent_previews_by_fork?: Record<string, string>;
  // Pinned thread state (`cast state`) — the four fields the ThreadStatePanel
  // reads. Typed via the shared contract so this can never drift from the
  // reader in lib/threadState.ts.
} & ThreadStateFields;

type CommitFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

export type Commit = {
  _id: string;
  sha: string;
  message: string;
  timestamp: number;
  files_changed: number;
  insertions: number;
  deletions: number;
  author_name: string;
  author_email: string;
  repository?: string;
  files?: CommitFile[];
};

type PRFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

export type PullRequest = {
  _id: Id<"pull_requests">;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  repository: string;
  author_github_username: string;
  head_ref?: string;
  base_ref?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits_count?: number;
  files?: PRFile[];
  created_at: number;
  updated_at: number;
  merged_at?: number;
};

export type ConversationViewProps = {
  conversation: ConversationData | null | undefined;
  commits?: Commit[];
  pullRequests?: PullRequest[];
  backHref: string;
  backLabel?: string;
  headerExtra?: React.ReactNode;
  hasMoreAbove?: boolean;
  hasMoreBelow?: boolean;
  isLoadingOlder?: boolean;
  isLoadingNewer?: boolean;
  onLoadOlder?: () => void;
  onLoadNewer?: () => void;
  onJumpToStart?: () => void;
  onJumpToEnd?: () => void;
  onJumpToTimestamp?: (ts: number) => void;
  highlightQuery?: string;
  onClearHighlight?: () => void;
  embedded?: boolean;
  showMessageInput?: boolean;
  targetMessageId?: string;
  /** Distinguishes a NEW jump request to the same message: the reset below
   *  compares ids, so without this a second "jump to the ask" click on the
   *  same decision would be a silent no-op. */
  targetNonce?: number;
  /** True while a targetMessageId jump is still fetching its message window
   * (from useConversationMessages.isJumpingToTarget). Drives the
   * "Jumping to message..." indicator so mid-conversation jumps aren't silent. */
  isJumpingToTarget?: boolean;
  isOwner?: boolean;
  // Anonymous share-link viewer: simplified defaults (condensed density, no AI
  // density modes). Distinct from !isOwner, which also covers signed-in teammates.
  guest?: boolean;
  onSendAndAdvance?: () => void;
  onSendAndDismiss?: () => void;
  autoFocusInput?: boolean;
  // Raw last user message of the session (server preview slice). The view
  // decides whether it may serve as the sticky fallback via stickyPromptContent.
  fallbackStickyContent?: string | null;
  onBack?: () => void;
  subHeaderContent?: React.ReactNode;
  headerLeft?: React.ReactNode;
  headerEnd?: React.ReactNode;
  hideHeader?: boolean;
  /**
   * Compose-popup hook. When set, the message input sends on Enter / Cmd+Enter
   * and then calls this with `navigate` = whether the user held Cmd/Ctrl
   * (Enter → fire-and-forget, Cmd+Enter → send & open). Used by ComposeView in
   * the floating new-session window; undefined everywhere else.
   */
  onSubmitWithIntent?: (navigate: boolean) => void;
  /**
   * A host that routes the composer's send elsewhere (the staffing pane sends
   * into a proposal's thread through orgProposals.say, org-staffing.md S18):
   * the box clears and hands the text over, the host owns the optimistic
   * bubble and the dispatch. The composer's own chrome goes with it: the
   * session's decision dock and its pinned state are answered and read where
   * the session's composer is, not on the host's page. Undefined everywhere else.
   */
  onSendOverride?: (content: string, images?: Array<{ storageId?: string; previewUrl: string; mime: string; uploading: boolean }>) => Promise<void>;
  /** A host's line above the box (what the next message is about). */
  composerNode?: React.ReactNode;
  /** A host's node above the first message, inside the scroll (a proposal's
   *  letter as the author's own bubble, org-staffing.md S19). Shown only when
   *  the top of the transcript is loaded, like the context cards. */
  leadNode?: React.ReactNode;
  /** Keep the lead above whatever window is loaded, not only at the
   *  transcript's start: an introduction (the scope page's), not a message
   *  in time (the proposal letter). */
  leadPinned?: boolean;
  /** The sticky first prompt header (the person's opening ask, kept in view
   *  while they read). Off where a lead already says what the thread is,
   *  and where the first prompt is a machine's (a seat's provisioning). */
  stickyPrompt?: boolean;
  /** The density this view opens in when the person has not picked one for
   *  the conversation (a proposal's thread reads as a conversation, S19). */
  initialDensity?: ConversationDensity;
  /** Fold mode (scopes-and-feed.md F4.1): the conversation as the agent
   *  talking to the person. Each turn shows its last reply in full; the steps
   *  before it (the prose between, the tools) sit behind one line, and the
   *  prompts a machine sent (wake frames, interrupts, polls, notices) render
   *  nothing. The live turn keeps its ask cards: a question the agent waits
   *  on is it talking. A person opens a folded turn to read it whole. */
  foldWorkingTurns?: boolean;
  /** Open at the top of what is loaded and do not follow the live tail: the
   *  host's lead is what the reader came for (a proposal's letter, S19). The
   *  guest reading a share link already opens this way. */
  openAtTop?: boolean;
  /** The composer's placeholder when the host owns the send ("Reply to the
   *  author"); the workflow gate's line otherwise reads in its place. */
  composerPlaceholder?: string;
};

export interface ConversationViewHandle {
  scrollToMessage: (messageId: string) => void;
}

// Imperative surface each null-state picker hands up to NewSessionView's
// ⌥-chord router (⌥↑ → project picker, ⌥↓ → agent row).
export type PickerHandle = {
  focus: () => boolean;
  isOpen: () => boolean;
  move?: (delta: -1 | 1) => boolean;
  // Commit the highlighted item and close WITHOUT restoring focus — the router
  // is about to move focus to the next picker.
  commitAndClose?: () => void;
};

// A recent-project row. `suggested` marks a padding entry — a root the picked
// machine has but has no session history in, so it reads dimmer than a real recent.
export type RecentProject = { path: string; count: number; lastActive: number; suggested?: boolean };

export interface NewSessionAgentControls {
  showWorkflow: boolean;
  onToggleWorkflow: () => void;
  selectedWorkflowId: string;
  onSelectWorkflow: (id: string) => void;
  workflows: Array<{ _id: string; name: string }> | undefined;
}

export type ParsedApiError = {
  isSafety?: boolean;
  statusCode?: number;
  message: string;
  errorType?: string;
  requestId?: string;
  // True for the auth subset (expired login / bad key / no credit / OAuth) — the
  // part the user can act on by re-running /login. Rendered as a distinct
  // "re-authenticate" card instead of the generic provider-error card.
  isAuth?: boolean;
  // True for usage/session-limit banners ("You've hit your session limit ·
  // resets 11:30pm (America/New_York)") — the session is parked until the
  // limit resets. Rendered as a distinct "usage limit" card.
  isLimit?: boolean;
  // True for statusless connection-drop banners ("API Error: Connection
  // closed mid-response. The response above may be incomplete.") — the turn
  // died mid-transmission; a plain "continue" resumes it. Rendered as a
  // distinct "connection dropped" card.
  isConnection?: boolean;
  // True for a burst throttle (the parser's "Rate limited ·" form of a
  // transient 429) — the per-minute cap rejected the request; codecast
  // continues it after a short wait. Rendered as a "rate limited" card.
  isThrottle?: boolean;
  // True for a statusful failure the CLI won't retry (400 invalid request,
  // 404, 413…) — the turn died at the prompt and stays dead until nudged.
  // Rendered as the generic error card, but the footer hint says "send
  // continue" instead of the self-retry copy.
  isFatal?: boolean;
  // True for a marked opencode/pi provider error that is NOT auth (a provider 5xx
  // or other non-actionable failure). Rendered as the generic error card with the
  // provider's own message, so a failed turn is never a silently blank session.
  isClientError?: boolean;
};

export type UserMessageKind =
  | { kind: 'normal' }
  | { kind: 'command' }
  | { kind: 'bash_input'; command: string }
  | { kind: 'bash_output'; stdout: string; stderr: string }
  | { kind: 'interrupt'; tone: 'sky' | 'amber' }
  | { kind: 'background_agent_stopped'; agentName?: string }
  | { kind: 'skill_expansion'; cmdName?: string }
  | { kind: 'task_notification' }
  | { kind: 'task_prompt' }
  | { kind: 'compaction_prompt' }
  | { kind: 'compaction_summary' }
  | { kind: 'plan'; planContent: string }
  | { kind: 'noise' }
  | { kind: 'tool_results_only' }
  | { kind: 'empty' }
  | { kind: 'teammate_events' }
  | { kind: 'continuation' }
  | { kind: 'poll_response' }
  | { kind: 'scheduled_task' }
  | { kind: 'machine_move'; destination?: string; fromLabel?: string; machineChanged: boolean }
  | { kind: 'agent_switch'; toLabel: string; fromLabel?: string }
  // `variant: 'agent'` is a subagent's report to the session that launched it
  // (<agent-message from="…">): the same card, chrome that says so, and a sender
  // that is an agent name rather than a session short id.
  | { kind: 'session_message'; from: string; body: string; name?: string; variant?: 'agent' }
  // A person typed this into the session from the dashboard (<user-message
  // from="Name">): a normal user bubble attributed to that person.
  | { kind: 'direct_user'; from: string; body: string }
  | { kind: 'huddle_summary'; huddle: HuddleSummaryTag }
  | { kind: 'chat_wake'; wake: ChatWakePrompt }
  // A standing role's wake frame (<role-wake or-N …>): the rail's own words,
  // rendered as the wake card with the role's controls.
  | { kind: 'role_wake'; frame: RoleWakeFrame }
  // The human's answer to a `cast decide` question (store answerDecision).
  | { kind: 'decision_answer'; decision: DecisionAnswerMessage };


/** One side of a handoff link on the conversation payload. */
export type HandoffLinkDetails = {
  conversation_id: string;
  short_id: string;
  title?: string | null;
  agent_type?: string | null;
  model?: string | null;
};

export interface ToolChangeRange {
  start: number;
  end: number;
}

export interface ToolCallChangeSelection {
  index: number;
  range: ToolChangeRange;
}

export type TaskRecord = { _id: string; short_id: string; title: string; status: string };
export type TaskRecordMaps = { byTitle: Record<string, TaskRecord>; byLocalId: Record<string, TaskRecord> };

export interface ParsedContextBlock {
  type: string;
  title: string;
  id?: string;
  status?: string;
  priority?: string;
}

// SUMMARY_LABELS and FormattedSummary live in ./FormattedSummary so EntityIdPill can reuse
// them without an import cycle; FormattedSummary is imported above.

export type TeammateMessagePart = { type: 'text'; content: string } | { type: 'teammate'; teammateId: string; color?: string; summary?: string; content: string; };

// ── Story & Summary densities ───────────────────────────────────────────────
// Both render storyMode.ts's chunked retelling of the WHOLE thread (not the
// paginated window). Story is a timeline of BEATS — each beat spans several
// turns: the user's request at that point, then a first-person narrative of
// what I did. Summary is the same shape one level up: a few high-level PHASES
// grouped from the beats. Each item anchors to a real message so you can jump in.

export type StoryBeat = { heading: string; body: string; anchor_prompt: string; anchor_message_id: string; anchor_timestamp: number };

// One source message's share of a condensed receipt: the hideable tools it
// ran, under its own identity (results, comments and share selection stay
// attributed to the message that ran them when the group opens).
export type ReceiptEntry = { messageId: string; messageUuid?: string; timestamp: number; tools: ToolCall[] };
export type CondensedReceipt = { entries: ReceiptEntry[]; expanded: boolean; onToggle: () => void };
