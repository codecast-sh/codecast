// Codecast's binding of the @platform/keys action catalog. The mechanics —
// chord matching (incl. the mac Option dead-key fallback), input/modal guards,
// keycap formatting — live in the package; this file owns what is codecast's:
// the action ids, the default bindings, and the reasoning behind each one.

import {
  createShortcutCatalog,
  hasOpenModal,
  isEditableTarget,
  inputGuardBypass,
  altChordDirection,
  type ShortcutDef as PlatformShortcutDef,
} from '@platform/keys';

export type ShortcutAction =
  | 'session.next'
  | 'session.prev'
  | 'session.jumpIdle'
  | 'session.jumpPinned'
  | 'session.pin'
  | 'session.moveToBucket'
  | 'view.switch'
  | 'session.stash'
  | 'session.stashHide'
  | 'session.kill'
  | 'session.deferAdvance'
  | 'session.dormantAdvance'
  | 'session.create'
  | 'session.compose'
  | 'session.rename'
  | 'session.mruSwitch'
  | 'tab.new'
  | 'tab.close'
  | 'tab.next'
  | 'tab.prev'
  | 'pane.split'
  | 'pane.close'
  | 'pane.expand'
  | 'pane.next'
  | 'pane.prev'
  | 'ui.zenToggle'
  | 'ui.toggleShortcutsHelp'
  | 'ui.openSettings'
  | 'ui.undo'
  | 'ui.redo'
  | 'inbox.toggleFlatView'
  | 'inbox.toggleTriageBar'
  | 'nav.inbox'
  | 'search.open'
  | 'chat.search'
  | 'chat.pushToTalk'
  | 'people.wall'
  | 'palette.toggle'
  | 'zoom.in'
  | 'zoom.out'
  | 'zoom.reset'
  | 'find.toggle'
  | 'conv.toggleDiff'
  | 'conv.toggleTree'
  | 'conv.toggleThinking'
  | 'conv.copyLink'
  | 'conv.cycleDensity'
  | 'conv.favorite'
  | 'conv.review'
  | 'msg.next'
  | 'msg.prev'
  | 'msg.fork'
  | 'msg.clearSelection'
  | 'msg.queue'
  | 'msg.sendAdvance'
  | 'msg.sendDismiss'
  | 'msg.forkSend'
  | 'permission.approve'
  | 'permission.deny'
  | 'review.nextFile'
  | 'review.prevFile'
  | 'review.comment'
  | 'compose.focus'
  | 'compose.richToggle'
  | 'sidebar.toggleLeft'
  | 'sidebar.toggleRight'
  | 'sidebar.toggleComments'
  | 'terminal.toggle'
  | 'anchor.toggle'
  | 'workbench.1'
  | 'workbench.2'
  | 'workbench.3'
  | 'workbench.4'
  | 'workbench.5'
  | 'workbench.6'
  | 'workbench.7'
  | 'workbench.8'
  | 'workbench.9'
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
  | 'list.actions'
  | 'list.create'
  | 'list.selectAll'
  | 'list.first'
  | 'list.last'
  | 'list.tab'
  | 'task.status'
  | 'task.priority'
  | 'task.labels'
  | 'task.assign'
  | 'task.back'
  | 'doc.type'
  | 'doc.labels'
  | 'doc.toggleEdit'
  | 'vault.quickSwitch'
  | 'vault.search'
  | 'vault.find'
  | 'vault.toggleEdit'
  | 'vault.sourceMode';

export type ShortcutDef = PlatformShortcutDef<ShortcutAction>;

export { hasOpenModal, isEditableTarget, inputGuardBypass, altChordDirection };

export const SHORTCUTS: ShortcutDef[] = [
  { key: 'ctrl+j', action: 'session.next', skipInputCheck: true, description: 'Next session' },
  { key: 'ctrl+k', action: 'session.prev', skipInputCheck: true, description: 'Previous session' },
  { key: 'ctrl+i', action: 'session.jumpIdle', skipInputCheck: true, description: 'Jump to top needs-input session' },
  { key: 'alt+p', mac: 'ctrl+p', action: 'session.jumpPinned', skipInputCheck: true, description: 'Jump to pinned session' },
  { key: 'ctrl+shift+p', action: 'session.pin', skipInputCheck: true, description: 'Pin/unpin session' },
  // Ctrl+L = Label. Free in-app and in the browser on mac (address bar is
  // Cmd+L); Ctrl+M stays compose-focus. Non-destructive (opens the label
  // picker), so a plain `true` bypass is safe from a full composer — unlike
  // the backspace triage chords below.
  { key: 'ctrl+l', action: 'session.moveToBucket', skipInputCheck: true, description: 'Label session' },
  // Ctrl+Shift+L sits next to Ctrl+L: label THIS session vs switch which
  // label/project view the panel shows. Opens the palette's view submenu.
  { key: 'ctrl+shift+l', action: 'view.switch', skipInputCheck: true, description: 'Switch label/project view' },
  // Destructive backspace chords use 'whenEmpty', never true: ctrl+backspace is
  // the OS "delete previous word" key, so an unconditional bypass fired these
  // mid-compose — preventDefault swallowed the keystroke (no visible change)
  // while the selected session got stashed/dismissed/deferred. With 'whenEmpty'
  // they fire from an empty composer (the keyboard triage flow) but defer to
  // the editor whenever there is text to delete. Stash sets the session aside
  // with the agent still running; dismiss retires it AND kills the agent.
  { key: 'ctrl+backspace', action: 'session.stash', skipInputCheck: 'whenEmpty', description: 'Stash session (keep agent running)' },
  // Stash and hide: the stash survives trigger wakes (a plain stash pops back
  // on one). One modifier up from stash, same as dormant sits above defer.
  { key: 'ctrl+alt+backspace', action: 'session.stashHide', skipInputCheck: 'whenEmpty', description: 'Stash and hide (stays out through trigger wakes)' },
  { key: 'ctrl+shift+backspace', action: 'session.kill', skipInputCheck: 'whenEmpty', description: 'Kill session' },
  { key: 'shift+backspace', action: 'session.deferAdvance', skipInputCheck: 'whenEmpty', description: 'Defer and advance' },
  // Dormant joins the backspace triage family one modifier up from defer, its
  // nearest verb (both park a row that returns on its own; defer on activity,
  // dormant on a machine wake). Alt+Backspace alone is banned — it is the OS
  // delete-word reflex, and the 'whenEmpty' bypass fires exactly when that
  // reflex lands on an already-empty composer — but no editing reflex includes
  // Shift: ⌥⇧⌫ is only ever a deliberate press, so it is as safe as
  // Shift+Backspace itself. Non-destructive: the row moves to the Dormant
  // section and comes back on its own at the next wake.
  { key: 'alt+shift+backspace', action: 'session.dormantAdvance', skipInputCheck: 'whenEmpty', description: 'Dormant and advance (a machine wakes it)' },
  { key: 'ctrl+n', action: 'session.compose', skipInputCheck: true, description: 'New session' },
  { key: 'ctrl+alt+n', action: 'session.create', skipInputCheck: true, description: 'New session (full page)' },
  { key: 'ctrl+shift+n', action: 'session.compose', skipInputCheck: true, description: 'Quick compose (palette)' },
  { key: 'ctrl+shift+e', action: 'session.rename', skipInputCheck: true, description: 'Rename session' },
  { key: 'ctrl+tab', action: 'session.mruSwitch', skipInputCheck: true, description: 'Switch recently viewed (MRU)' },

  { key: 'ctrl+t', mac: 'meta+t', action: 'tab.new', skipInputCheck: true, description: 'New tab' },
  { key: 'ctrl+w', mac: 'meta+w', action: 'tab.close', skipInputCheck: true, description: 'Close tab' },
  // shift+bracket arrives as '[' or '{' depending on browser/layout — register
  // both spellings per action; UI shows the first def.
  { key: 'ctrl+shift+[', mac: 'meta+shift+[', action: 'tab.prev', skipInputCheck: true, description: 'Previous tab' },
  { key: 'ctrl+shift+{', mac: 'meta+shift+{', action: 'tab.prev', skipInputCheck: true, description: 'Previous tab' },
  { key: 'ctrl+shift+]', mac: 'meta+shift+]', action: 'tab.next', skipInputCheck: true, description: 'Next tab' },
  { key: 'ctrl+shift+}', mac: 'meta+shift+}', action: 'tab.next', skipInputCheck: true, description: 'Next tab' },

  // Stage panes (the tab's split layout). Handlers return false when the
  // stage isn't split so the chords fall through to whatever else owns them.
  // No ctrl/cmd+shift+w here: browsers reserve it for closing the WINDOW and
  // never let the page see it. No skipInputCheck on the split chord: Windows
  // spells AltGr as ctrl+alt, so firing inside an input would eat typed
  // characters on international layouts. Arrows first for focus motion —
  // brackets need AltGr on many European layouts and can't be typed at all.
  { key: 'ctrl+alt+d', action: 'pane.split', description: 'Split: open this view beside itself' },
  { key: 'ctrl+alt+w', action: 'pane.close', skipInputCheck: true, description: 'Close pane' },
  { key: 'ctrl+alt+enter', action: 'pane.expand', skipInputCheck: true, description: 'Pane takes the whole stage' },
  { key: 'ctrl+alt+arrowright', action: 'pane.next', skipInputCheck: true, description: 'Focus next pane' },
  { key: 'ctrl+alt+]', action: 'pane.next', skipInputCheck: true, description: 'Focus next pane' },
  { key: 'ctrl+alt+arrowleft', action: 'pane.prev', skipInputCheck: true, description: 'Focus previous pane' },
  { key: 'ctrl+alt+[', action: 'pane.prev', skipInputCheck: true, description: 'Focus previous pane' },

  { key: 'ctrl+.', action: 'ui.zenToggle', skipInputCheck: true, description: 'Toggle zen mode' },
  { key: 'ctrl+,', action: 'inbox.toggleFlatView', skipInputCheck: true, description: 'Cycle inbox view (grouped / time / label)' },
  { key: '?', action: 'ui.toggleShortcutsHelp', description: 'Toggle shortcuts help' },
  // meta+, is the OS settings convention on mac; ctrl+, is taken by the inbox
  // view cycle above, so non-mac gets the shifted variant. shift+comma arrives
  // as ',' or '<' depending on browser/layout — register both spellings.
  { key: 'ctrl+shift+,', mac: 'meta+,', action: 'ui.openSettings', skipInputCheck: true, worksInModal: true, description: 'Open settings' },
  { key: 'ctrl+shift+<', mac: 'meta+,', action: 'ui.openSettings', skipInputCheck: true, worksInModal: true, description: 'Open settings' },
  { key: 'ctrl+z', action: 'ui.undo', skipInputCheck: true, description: 'Undo' },
  { key: 'ctrl+shift+z', action: 'ui.redo', skipInputCheck: true, description: 'Redo' },

  { key: 'meta+shift+alt+1', action: 'nav.inbox', skipInputCheck: true, description: 'Go to inbox' },

  { key: 'meta+/', action: 'search.open', skipInputCheck: true, description: 'Open search' },
  { key: 'ctrl+/', action: 'search.open', skipInputCheck: true, description: 'Open search' },
  { key: 'meta+shift+f', action: 'chat.search', skipInputCheck: true, description: 'Search chat messages' },
  { key: 'ctrl+shift+f', action: 'chat.search', skipInputCheck: true, description: 'Search chat messages' },
  // Hold to talk, in an open DM. The registry fires the PRESS; the release is a
  // keyup, which this dispatcher does not have a channel for (see
  // hooks/useHoldToTalk). It is here rather than hand-rolled whole so the key is
  // listed in the shortcuts help, guarded against modals the same way every
  // other binding is, and rebindable when bindings become rebindable.
  //
  // A modifier chord, and skipInputCheck, because the hand that wants to talk is
  // resting in the composer: the binding has to survive a focused text box, and
  // anything that survives a text box must be impossible to type.
  { key: 'ctrl+shift+space', action: 'chat.pushToTalk', when: 'chat.dm', skipInputCheck: true, description: 'Hold to talk in this DM' },
  { key: 'meta+k', action: 'palette.toggle', skipInputCheck: true, description: 'Toggle command palette' },
  // THE TEAM, FROM ANYWHERE. The wall answers "who is around, and can I just
  // ask them?" — a question people have in the middle of something else, so it
  // costs one chord from wherever they are rather than a trip to a window.
  //
  // Cmd+Shift+P, and the same chord off mac, which is why it reads `meta` with
  // no variant: Ctrl+Shift+P is already Pin/unpin session, and a second def on
  // that combo would lose the race to it forever. Same choice the palette makes
  // one line above (meta+k, no ctrl variant).
  { key: 'meta+shift+p', action: 'people.wall', skipInputCheck: true, description: 'The team' },

  { key: 'meta+=', action: 'zoom.in', when: 'desktop', skipInputCheck: true, worksInModal: true, description: 'Zoom in' },
  { key: 'meta++', action: 'zoom.in', when: 'desktop', skipInputCheck: true, worksInModal: true, description: 'Zoom in' },
  { key: 'meta+-', action: 'zoom.out', when: 'desktop', skipInputCheck: true, worksInModal: true, description: 'Zoom out' },
  { key: 'meta+0', action: 'zoom.reset', when: 'desktop', skipInputCheck: true, worksInModal: true, description: 'Reset zoom' },
  // Find inside the open vault note. Listed BEFORE the desktop page-find so a
  // visible note claims the chord first; the vault handler declines (falls
  // through to find.toggle, or to the browser) whenever no note is on screen
  // in reading mode.
  { key: 'ctrl+f', mac: 'meta+f', action: 'vault.find', skipInputCheck: true, description: 'Find in note' },
  { key: 'meta+f', action: 'find.toggle', when: 'desktop', skipInputCheck: true, description: 'Find in page' },

  { key: 'd', action: 'conv.toggleDiff', when: 'conversation', description: 'Toggle diff panel' },
  { key: 't', action: 'conv.toggleTree', when: 'conversation', description: 'Toggle branch map' },
  // Ctrl+B opens the branch map, and unlike `t` it fires while the composer is
  // focused — the map lives above the message input, so you reach for it
  // mid-typing. ('B' for branches.) Ctrl (not Cmd) for consistency with the
  // app's other Ctrl chords.
  { key: 'ctrl+b', action: 'conv.toggleTree', when: 'conversation', skipInputCheck: true, description: 'Toggle branch map' },
  { key: 'h', action: 'conv.toggleThinking', when: 'conversation', description: 'Toggle thinking blocks' },
  // Obsidian's search chord, sharing keys with conv.favorite below. Listed
  // FIRST on purpose: a background conversation tab keeps the 'conversation'
  // context active while the vault tab is visible, so favorite would otherwise
  // always win. The vault handler declines (returns false) unless the vault is
  // the visible tab, and the dispatcher then falls through to favorite.
  { key: 'ctrl+shift+f', mac: 'meta+shift+f', action: 'vault.search', skipInputCheck: true, description: 'Search files' },
  { key: 'ctrl+shift+f', mac: 'meta+shift+f', action: 'conv.favorite', when: 'conversation', skipInputCheck: true, description: 'Toggle favorite' },
  { key: 'r', action: 'conv.review', when: 'conversation', description: 'Quote selected text into your reply' },
  { key: 'meta+shift+l', action: 'conv.copyLink', when: 'conversation', skipInputCheck: true, description: 'Copy conversation link' },
  { key: 'ctrl+shift+c', mac: 'meta+shift+c', action: 'conv.cycleDensity', when: 'conversation', skipInputCheck: true, description: 'Cycle message density' },
  // ⌘⇧E swaps the plain composer textarea for the rich (TipTap) editor. The
  // handler is hand-rolled inside the composer — it has to run with the
  // textarea focused and move focus into the editor it creates — so this def
  // exists to list the key in the shortcuts help (the pushToTalk pattern).
  // meta with no ctrl variant on purpose: ctrl+shift+e is session.rename,
  // which wins at the capture listener.
  { key: 'meta+shift+e', action: 'compose.richToggle', when: 'conversation', skipInputCheck: true, description: 'Toggle rich compose editor' },

  { key: 'escape', action: 'msg.clearSelection', when: 'conversation', skipInputCheck: true, description: 'Clear selection' },
  { key: 'alt+j', action: 'msg.next', when: 'conversation', description: 'Next user message' },
  { key: 'alt+k', action: 'msg.prev', when: 'conversation', description: 'Previous user message' },
  { key: 'alt+f', action: 'msg.fork', when: 'conversation', description: 'Fork from message' },
  { key: 'ctrl+enter', action: 'msg.queue', when: 'conversation', skipInputCheck: true, description: 'Queue message' },
  { key: 'alt+enter', action: 'msg.sendAdvance', when: 'conversation', skipInputCheck: true, description: 'Send and advance' },
  { key: 'alt+shift+enter', action: 'msg.sendDismiss', when: 'conversation', skipInputCheck: true, description: 'Send and stash' },
  { key: 'ctrl+shift+enter', mac: 'meta+shift+enter', action: 'msg.forkSend', when: 'conversation', skipInputCheck: true, description: 'Fork and send' },
  { key: 'y', action: 'permission.approve', when: 'conversation', description: 'Approve permission' },
  { key: 'n', action: 'permission.deny', when: 'conversation', description: 'Deny permission' },

  { key: 'ctrl+m', action: 'compose.focus', skipInputCheck: true, description: 'Focus message input' },
  { key: 'ctrl+[', action: 'sidebar.toggleLeft', skipInputCheck: true, description: 'Toggle left sidebar' },
  { key: 'ctrl+]', action: 'sidebar.toggleRight', skipInputCheck: true, description: 'Toggle sessions panel' },
  { key: 'ctrl+`', action: 'terminal.toggle', skipInputCheck: true, description: 'Toggle terminal' },
  // The anchor is reachable from anywhere: one chord opens its slide-over
  // (the last anchor you spoke to) without leaving the page you are on.
  { key: 'ctrl+shift+a', mac: 'meta+shift+a', action: 'anchor.toggle', skipInputCheck: true, description: 'Talk to Anchor' },
  // Cmd+O mirrors Obsidian's quick switcher. The handler declines when no
  // vault is connected, so the chord costs nothing in vault-less workspaces.
  { key: 'ctrl+o', mac: 'meta+o', action: 'vault.quickSwitch', skipInputCheck: true, description: 'Open a note' },
  // Obsidian's edit/read chord. skipInputCheck because the editor it toggles IS
  // an input; the handler declines unless the vault is the visible tab with a
  // note open, so the chord costs nothing anywhere else.
  { key: 'ctrl+e', mac: 'meta+e', action: 'vault.toggleEdit', skipInputCheck: true, description: 'Toggle note edit / read mode' },
  // Live preview is the editing mode Cmd+E lands on; this jumps past it to the
  // raw file, and back to live preview when you're done looking.
  { key: 'ctrl+shift+e', mac: 'meta+shift+e', action: 'vault.sourceMode', skipInputCheck: true, description: 'Toggle note source mode' },
  { key: 'ctrl+\\', action: 'sidebar.toggleComments', skipInputCheck: true, description: 'Toggle comments rail' },
  // Workbenches: switch the whole chrome to a saved arrangement (rail order —
  // see lib/workbenchSwitch). One key, wholesale — never a per-panel tweak.
  { key: 'alt+1', action: 'workbench.1', skipInputCheck: true, description: 'Switch to saved layout 1' },
  { key: 'alt+2', action: 'workbench.2', skipInputCheck: true, description: 'Switch to saved layout 2' },
  { key: 'alt+3', action: 'workbench.3', skipInputCheck: true, description: 'Switch to saved layout 3' },
  { key: 'alt+4', action: 'workbench.4', skipInputCheck: true, description: 'Switch to saved layout 4' },
  { key: 'alt+5', action: 'workbench.5', skipInputCheck: true, description: 'Switch to saved layout 5' },
  { key: 'alt+6', action: 'workbench.6', skipInputCheck: true, description: 'Switch to saved layout 6' },
  { key: 'alt+7', action: 'workbench.7', skipInputCheck: true, description: 'Switch to saved layout 7' },
  { key: 'alt+8', action: 'workbench.8', skipInputCheck: true, description: 'Switch to saved layout 8' },
  { key: 'alt+9', action: 'workbench.9', skipInputCheck: true, description: 'Switch to saved layout 9' },

  { key: 'j', action: 'review.nextFile', when: 'review', description: 'Next file' },
  { key: 'k', action: 'review.prevFile', when: 'review', description: 'Previous file' },
  { key: 'c', action: 'review.comment', when: 'review', description: 'Comment on line' },


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
  { key: 'c', action: 'list.create', when: 'list', description: 'New item' },
  { key: 'ctrl+a', mac: 'meta+a', action: 'list.selectAll', when: 'list', description: 'Select all' },
  { key: '1', action: 'list.tab', when: 'list', description: 'Switch tab (1–9)' },
  { key: 'home', action: 'list.first', when: 'list', description: 'Jump to top' },
  { key: 'end', action: 'list.last', when: 'list', description: 'Jump to bottom' },

  // Tasks and Docs keys, hand-rolled where they live (the list pages' palette
  // shortcuts in app/tasks and app/docs, the task detail page's handler, and
  // DocumentDetailLayout's edit toggle). The defs exist so the shortcuts help
  // covers them; the 'tasks'/'docs' contexts are never activated, so they are
  // inert in dispatch.
  { key: 's', action: 'task.status', when: 'tasks', description: 'Set status' },
  { key: 'p', action: 'task.priority', when: 'tasks', description: 'Set priority' },
  { key: 'l', action: 'task.labels', when: 'tasks', description: 'Edit labels' },
  { key: 'a', action: 'task.assign', when: 'tasks', description: 'Assign (task list)' },
  { key: 'backspace', action: 'task.back', when: 'tasks', description: 'Back to task list (detail page)' },
  { key: 't', action: 'doc.type', when: 'docs', description: 'Set doc type' },
  { key: 'l', action: 'doc.labels', when: 'docs', description: 'Edit labels' },
  { key: 'ctrl+e', mac: 'meta+e', action: 'doc.toggleEdit', when: 'docs', description: 'Toggle edit mode (doc page)' },
];

export const shortcutCatalog = createShortcutCatalog(SHORTCUTS);

export const isMac = shortcutCatalog.isMac;
export const matchShortcut = shortcutCatalog.matchShortcut;
export const getShortcutsForAction = shortcutCatalog.getShortcutsForAction;
export const getShortcutsByContext = shortcutCatalog.getShortcutsByContext;
export const formatShortcutParts = shortcutCatalog.formatShortcutParts;
export const formatAcceleratorParts = shortcutCatalog.formatAcceleratorParts;
export const formatShortcutLabel = shortcutCatalog.formatShortcutLabel;
