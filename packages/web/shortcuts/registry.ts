export type ShortcutAction =
  | 'session.next'
  | 'session.prev'
  | 'session.jumpIdle'
  | 'session.jumpPinned'
  | 'session.pin'
  | 'session.stash'
  | 'session.kill'
  | 'session.deferAdvance'
  | 'session.create'
  | 'session.createIsolated'
  | 'session.rename'
  | 'session.mruSwitch'
  | 'ui.zenToggle'
  | 'ui.toggleShortcutsHelp'
  | 'ui.undo'
  | 'ui.redo'
  | 'nav.inbox'
  | 'search.open'
  | 'palette.toggle'
  | 'zoom.in'
  | 'zoom.out'
  | 'zoom.reset'
  | 'find.toggle'
  | 'conv.toggleDiff'
  | 'conv.toggleTree'
  | 'conv.copyLink'
  | 'conv.collapseAll'
  | 'conv.toggleThinking'
  | 'conv.favorite'
  | 'msg.next'
  | 'msg.prev'
  | 'msg.fork'
  | 'msg.clearSelection'
  | 'msg.queue'
  | 'msg.sendAdvance'
  | 'msg.sendDismiss'
  | 'permission.approve'
  | 'permission.deny'
  | 'review.nextFile'
  | 'review.prevFile'
  | 'review.comment'
  | 'compose.focus'
  | 'sidebar.toggleLeft'
  | 'sidebar.toggleRight'
  | 'create.open'
  | 'diff.prevChange'
  | 'diff.nextChange'
  | 'diff.toggleFileTree'
  | 'list.down'
  | 'list.up'
  | 'list.open'
  | 'list.select'
  | 'list.preview'
  | 'list.search'
  | 'list.edit'
  | 'list.actions';

export interface ShortcutDef {
  key: string;
  action: ShortcutAction;
  when?: string;
  mac?: string;
  skipInputCheck?: boolean;
  description: string;
}

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent);

const SHIFTED_KEYS = new Set(['?', '+', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '{', '}', '|', ':', '"', '<', '>', '~']);

export const SHORTCUTS: ShortcutDef[] = [
  { key: 'ctrl+j', action: 'session.next', skipInputCheck: true, description: 'Next session' },
  { key: 'ctrl+k', action: 'session.prev', skipInputCheck: true, description: 'Previous session' },
  { key: 'ctrl+i', action: 'session.jumpIdle', skipInputCheck: true, description: 'Jump to idle session' },
  { key: 'alt+p', mac: 'ctrl+p', action: 'session.jumpPinned', skipInputCheck: true, description: 'Jump to pinned session' },
  { key: 'ctrl+shift+p', action: 'session.pin', skipInputCheck: true, description: 'Pin/unpin session' },
  { key: 'ctrl+backspace', action: 'session.stash', skipInputCheck: true, description: 'Stash session' },
  { key: 'ctrl+shift+backspace', action: 'session.kill', skipInputCheck: true, description: 'Kill session agent' },
  { key: 'shift+backspace', action: 'session.deferAdvance', skipInputCheck: true, description: 'Defer and advance' },
  { key: 'ctrl+n', action: 'session.create', skipInputCheck: true, description: 'New session' },
  { key: 'ctrl+shift+n', action: 'session.createIsolated', skipInputCheck: true, description: 'New isolated session' },
  { key: 'ctrl+shift+e', action: 'session.rename', skipInputCheck: true, description: 'Rename session' },
  { key: 'ctrl+tab', action: 'session.mruSwitch', skipInputCheck: true, description: 'Switch session (MRU)' },

  { key: 'ctrl+.', action: 'ui.zenToggle', skipInputCheck: true, description: 'Toggle zen mode' },
  { key: '?', action: 'ui.toggleShortcutsHelp', description: 'Toggle shortcuts help' },
  { key: 'ctrl+z', action: 'ui.undo', skipInputCheck: true, description: 'Undo' },
  { key: 'ctrl+shift+z', action: 'ui.redo', skipInputCheck: true, description: 'Redo' },

  { key: 'meta+shift+alt+1', action: 'nav.inbox', skipInputCheck: true, description: 'Go to inbox' },

  { key: 'meta+/', action: 'search.open', skipInputCheck: true, description: 'Open search' },
  { key: 'ctrl+/', action: 'search.open', skipInputCheck: true, description: 'Open search' },
  { key: 'meta+k', action: 'palette.toggle', skipInputCheck: true, description: 'Toggle command palette' },

  { key: 'meta+=', action: 'zoom.in', when: 'desktop', skipInputCheck: true, description: 'Zoom in' },
  { key: 'meta++', action: 'zoom.in', when: 'desktop', skipInputCheck: true, description: 'Zoom in' },
  { key: 'meta+-', action: 'zoom.out', when: 'desktop', skipInputCheck: true, description: 'Zoom out' },
  { key: 'meta+0', action: 'zoom.reset', when: 'desktop', skipInputCheck: true, description: 'Reset zoom' },
  { key: 'meta+f', action: 'find.toggle', when: 'desktop', skipInputCheck: true, description: 'Find in page' },

  { key: 'd', action: 'conv.toggleDiff', when: 'conversation', description: 'Toggle diff panel' },
  { key: 't', action: 'conv.toggleTree', when: 'conversation', description: 'Toggle tree panel' },
  { key: 'h', action: 'conv.toggleThinking', when: 'conversation', description: 'Toggle thinking blocks' },
  { key: 'f', action: 'conv.favorite', when: 'conversation', description: 'Toggle favorite' },
  { key: 'meta+shift+l', action: 'conv.copyLink', when: 'conversation', skipInputCheck: true, description: 'Copy conversation link' },
  { key: 'ctrl+shift+c', mac: 'meta+shift+c', action: 'conv.collapseAll', when: 'conversation', skipInputCheck: true, description: 'Collapse/expand all' },

  { key: 'escape', action: 'msg.clearSelection', when: 'conversation', skipInputCheck: true, description: 'Clear selection' },
  { key: 'alt+j', action: 'msg.next', when: 'conversation', description: 'Next user message' },
  { key: 'alt+k', action: 'msg.prev', when: 'conversation', description: 'Previous user message' },
  { key: 'alt+f', action: 'msg.fork', when: 'conversation', description: 'Fork from message' },
  { key: 'ctrl+enter', action: 'msg.queue', when: 'conversation', skipInputCheck: true, description: 'Queue message' },
  { key: 'alt+enter', action: 'msg.sendAdvance', when: 'conversation', skipInputCheck: true, description: 'Send and advance' },
  { key: 'alt+shift+enter', action: 'msg.sendDismiss', when: 'conversation', skipInputCheck: true, description: 'Send and dismiss' },
  { key: 'y', action: 'permission.approve', when: 'conversation', description: 'Approve permission' },
  { key: 'n', action: 'permission.deny', when: 'conversation', description: 'Deny permission' },

  { key: 'ctrl+m', action: 'compose.focus', skipInputCheck: true, description: 'Focus message input' },
  { key: 'ctrl+[', action: 'sidebar.toggleLeft', skipInputCheck: true, description: 'Toggle left sidebar' },
  { key: 'ctrl+]', action: 'sidebar.toggleRight', skipInputCheck: true, description: 'Toggle sessions panel' },

  { key: 'j', action: 'review.nextFile', when: 'review', description: 'Next file' },
  { key: 'k', action: 'review.prevFile', when: 'review', description: 'Previous file' },
  { key: 'c', action: 'review.comment', when: 'review', description: 'Comment on line' },

  { key: 'c', action: 'create.open', description: 'Create task or plan' },

  { key: '[', action: 'diff.prevChange', when: 'diff', description: 'Previous change' },
  { key: ']', action: 'diff.nextChange', when: 'diff', description: 'Next change' },
  { key: 'f', action: 'diff.toggleFileTree', when: 'diff', description: 'Toggle file tree' },

  { key: 'j', action: 'list.down', when: 'list', description: 'Move down' },
  { key: 'k', action: 'list.up', when: 'list', description: 'Move up' },
  { key: 'enter', action: 'list.open', when: 'list', description: 'Open item' },
  { key: 'x', action: 'list.select', when: 'list', description: 'Toggle select' },
  { key: 'space', action: 'list.preview', when: 'list', description: 'Preview' },
  { key: '/', action: 'list.search', when: 'list', description: 'Search' },
  { key: 'e', action: 'list.edit', when: 'list', description: 'Edit name' },
  { key: 'd', action: 'list.actions', when: 'list', description: 'Actions menu' },
];

interface ParsedKey {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

function parseKeyCombo(combo: string): ParsedKey {
  const parts = combo.toLowerCase().split('+');
  const result: ParsedKey = { ctrl: false, meta: false, alt: false, shift: false, key: '' };
  for (const part of parts) {
    switch (part) {
      case 'ctrl': result.ctrl = true; break;
      case 'meta': result.meta = true; break;
      case 'alt': result.alt = true; break;
      case 'shift': result.shift = true; break;
      default: result.key = part;
    }
  }
  return result;
}

function normalizeEventKey(e: KeyboardEvent): string {
  if (!e.key) return '';
  const key = e.key.toLowerCase();
  if (key === ' ') return 'space';
  return key;
}

export function matchShortcut(e: KeyboardEvent, def: ShortcutDef): boolean {
  const combo = (isMac && def.mac) ? def.mac : def.key;
  const parsed = parseKeyCombo(combo);
  const eventKey = normalizeEventKey(e);

  if (parsed.key !== eventKey) return false;
  if (parsed.ctrl !== e.ctrlKey) return false;
  if (parsed.meta !== e.metaKey) return false;
  if (parsed.alt !== e.altKey) return false;
  if (SHIFTED_KEYS.has(e.key)) return true;
  if (parsed.shift !== e.shiftKey) return false;

  return true;
}

export function getShortcutsForAction(action: ShortcutAction): ShortcutDef[] {
  return SHORTCUTS.filter(s => s.action === action);
}

export function formatShortcutParts(def: ShortcutDef): string[] {
  const combo = (isMac && def.mac) ? def.mac : def.key;
  return combo.split('+').map(part => {
    switch (part.toLowerCase()) {
      case 'ctrl': return isMac ? '\u2303' : 'Ctrl';
      case 'meta': return isMac ? '\u2318' : 'Ctrl';
      case 'alt': return isMac ? '\u2325' : 'Alt';
      case 'shift': return isMac ? '\u21e7' : 'Shift';
      case 'backspace': return isMac ? '\u232b' : 'Bksp';
      case 'escape': return 'Esc';
      case 'enter': return isMac ? '\u21a9' : 'Enter';
      case 'tab': return isMac ? '\u21e5' : 'Tab';
      case 'arrowup': return '\u2191';
      case 'arrowdown': return '\u2193';
      case 'arrowleft': return '\u2190';
      case 'arrowright': return '\u2192';
      case 'space': return '\u2423';
      case 'delete': return isMac ? '\u2326' : 'Del';
      default: return part.toUpperCase();
    }
  });
}

export function formatShortcutLabel(action: ShortcutAction): string | null {
  const defs = getShortcutsForAction(action);
  if (defs.length === 0) return null;
  return formatShortcutParts(defs[0]).join('');
}

export function getShortcutsByContext(when?: string): ShortcutDef[] {
  if (when === undefined) return SHORTCUTS.filter(s => !s.when);
  return SHORTCUTS.filter(s => s.when === when);
}

export { isMac };
