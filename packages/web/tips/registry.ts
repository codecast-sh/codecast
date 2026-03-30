import type { ShortcutAction } from '../shortcuts/registry';

export type TipType = 'whisper' | 'milestone' | 'nudge' | 'inline';

export interface TipDef {
  id: string;
  type: TipType;
  content: string;
  shortcutAction?: ShortcutAction;
  phase: 1 | 2 | 3 | 4;
}

export const TIPS: TipDef[] = [
  // ═══════════════════════════════════════════════
  // PHASE 1 — Basics (shown immediately)
  // ═══════════════════════════════════════════════

  // Whispers: show when user clicks instead of using shortcut
  { id: 'w-palette', type: 'whisper', shortcutAction: 'palette.toggle', phase: 1,
    content: 'Open command palette' },
  { id: 'w-search', type: 'whisper', shortcutAction: 'search.open', phase: 1,
    content: 'Open search' },
  { id: 'w-new-session', type: 'whisper', shortcutAction: 'session.create', phase: 1,
    content: 'Create a new session' },
  { id: 'w-focus-input', type: 'whisper', shortcutAction: 'compose.focus', phase: 1,
    content: 'Jump to message input' },

  // Inline: proactive tips shown in the session list on first use
  { id: 'i-keyboard-nav', type: 'inline', shortcutAction: 'session.next', phase: 1,
    content: 'Navigate between sessions' },
  { id: 'i-jump-idle', type: 'inline', shortcutAction: 'session.jumpIdle', phase: 1,
    content: 'Jump to the next session waiting for input' },
  { id: 'i-dismiss-sessions', type: 'inline', shortcutAction: 'session.stash', phase: 1,
    content: 'Dismiss sessions you\'re done with' },
  { id: 'i-command-palette', type: 'inline', shortcutAction: 'palette.toggle', phase: 2,
    content: 'Open the command palette for quick actions' },
  { id: 'i-search', type: 'inline', shortcutAction: 'search.open', phase: 2,
    content: 'Search across all your conversations' },
  { id: 'i-shortcuts-help', type: 'inline', shortcutAction: 'ui.toggleShortcutsHelp', phase: 2,
    content: 'View all keyboard shortcuts' },

  // Milestones: celebrate first-time discoveries
  { id: 'm-first-shortcut', type: 'milestone', phase: 1,
    content: 'Keyboard shortcut unlocked — press ? to see all shortcuts' },

  // ═══════════════════════════════════════════════
  // PHASE 2 — Session management (after 5+ sessions)
  // ═══════════════════════════════════════════════

  { id: 'w-session-next', type: 'whisper', shortcutAction: 'session.next', phase: 2,
    content: 'Next session' },
  { id: 'w-session-prev', type: 'whisper', shortcutAction: 'session.prev', phase: 2,
    content: 'Previous session' },
  { id: 'w-pin', type: 'whisper', shortcutAction: 'session.pin', phase: 2,
    content: 'Pin session to top' },
  { id: 'w-stash', type: 'whisper', shortcutAction: 'session.stash', phase: 2,
    content: 'Stash session' },
  { id: 'w-rename', type: 'whisper', shortcutAction: 'session.rename', phase: 2,
    content: 'Rename session' },

  { id: 'm-first-pin', type: 'milestone', phase: 2,
    content: 'Pinned — this session stays at the top of your list' },
  { id: 'm-first-stash', type: 'milestone', phase: 2,
    content: 'Stashed — find it later via the dismissed toggle' },

  // Nudges: contextual suggestions
  { id: 'n-many-sessions', type: 'nudge', phase: 2,
    content: 'Jump to idle sessions instantly' },
  { id: 'n-session-nav', type: 'nudge', phase: 2,
    content: 'Navigate sessions without the mouse' },

  // ═══════════════════════════════════════════════
  // PHASE 3 — Power user (after 1+ week)
  // ═══════════════════════════════════════════════

  { id: 'w-zen', type: 'whisper', shortcutAction: 'ui.zenToggle', phase: 3,
    content: 'Toggle zen mode' },
  { id: 'w-diff', type: 'whisper', shortcutAction: 'conv.toggleDiff', phase: 3,
    content: 'Toggle diff panel' },
  { id: 'w-sidebar-left', type: 'whisper', shortcutAction: 'sidebar.toggleLeft', phase: 3,
    content: 'Toggle left sidebar' },
  { id: 'w-sidebar-right', type: 'whisper', shortcutAction: 'sidebar.toggleRight', phase: 3,
    content: 'Toggle sessions panel' },
  { id: 'w-msg-next', type: 'whisper', shortcutAction: 'msg.next', phase: 3,
    content: 'Jump to next message' },
  { id: 'w-msg-prev', type: 'whisper', shortcutAction: 'msg.prev', phase: 3,
    content: 'Jump to previous message' },

  { id: 'm-first-zen', type: 'milestone', phase: 3,
    content: 'Zen mode — distraction-free focus' },
  { id: 'm-first-diff', type: 'milestone', phase: 3,
    content: 'Diff panel — see code changes inline' },
  { id: 'm-first-fork', type: 'milestone', phase: 3,
    content: 'Forked — branch the conversation from this point' },

  // ═══════════════════════════════════════════════
  // PHASE 4 — Advanced (after using 10+ features)
  // ═══════════════════════════════════════════════

  { id: 'w-mru', type: 'whisper', shortcutAction: 'session.mruSwitch', phase: 4,
    content: 'Switch to last session' },
  { id: 'w-jump-idle', type: 'whisper', shortcutAction: 'session.jumpIdle', phase: 4,
    content: 'Jump to idle session' },
  { id: 'w-collapse-all', type: 'whisper', shortcutAction: 'conv.collapseAll', phase: 4,
    content: 'Collapse all blocks' },
  { id: 'w-defer', type: 'whisper', shortcutAction: 'session.deferAdvance', phase: 4,
    content: 'Defer and advance' },
  { id: 'w-queue-msg', type: 'whisper', shortcutAction: 'msg.queue', phase: 4,
    content: 'Queue message for later' },
  { id: 'w-send-advance', type: 'whisper', shortcutAction: 'msg.sendAdvance', phase: 4,
    content: 'Send and advance to next' },

  { id: 'm-first-task', type: 'milestone', phase: 4,
    content: 'Task created — track your work from the tasks page' },
  { id: 'm-first-doc', type: 'milestone', phase: 4,
    content: 'Doc created — find it on the docs page' },
];

const tipMap = new Map(TIPS.map(t => [t.id, t]));
const whisperByAction = new Map(
  TIPS.filter(t => t.type === 'whisper' && t.shortcutAction)
    .map(t => [t.shortcutAction!, t])
);

export function getTip(id: string): TipDef | undefined {
  return tipMap.get(id);
}

export function getWhisperForAction(action: ShortcutAction): TipDef | undefined {
  return whisperByAction.get(action);
}

export function getTipsByPhase(phase: number): TipDef[] {
  return TIPS.filter(t => t.phase <= phase);
}

export function getTipsByType(type: TipType): TipDef[] {
  return TIPS.filter(t => t.type === type);
}

export function getInlineTips(): TipDef[] {
  return TIPS.filter(t => t.type === 'inline');
}
