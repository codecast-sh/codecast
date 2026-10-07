import type { ComponentType } from "react";
import { sessionIdentity } from "./sessionIdentity";
import { cleanTitle } from "./conversationProcessor";
import { Archive, ArrowRightLeft, ArrowUp, Bot, CheckCircle2, CircleDot, Clock, Copy, CornerDownRight, Cpu, ExternalLink, EyeOff, FileText, Folder, Forward, GitBranch, Link, Moon, Pencil, Pin, PinOff, Play, RefreshCw, Square, Star, Tag, Trash2, User, CalendarDays, Plus, Smile, MessageSquare, Headphones, ArrowRight } from "lucide-react";
import { getShortcutsForAction, inputGuardBypass, isEditableTarget, matchShortcut, type ShortcutAction } from "../shortcuts/registry";
import { canControlModel } from "./modelSwitch";
import { canMoveSessionToMachine, sessionMoveVerbs } from "./sessionControl";
import { DEVELOPER_MODE, type SurfaceMode } from "./surfaceRules";
import { isForeignSession } from "./liveEntities";
import { isSessionKilled, isSessionSetAside } from "./sessionRetirement";
import { isTriggerEditable } from "./triggerEditable";

/** The entities a route or a collection names (paletteTarget). */
export type PaletteEntityType = "session" | "task" | "doc" | "plan" | "project" | "trigger";
/** Plus "person", a teammate: its row is a PalettePerson, built where the
 *  palette drills into them (CommandPalette), never read from a collection. */
export type PaletteTargetType = PaletteEntityType | "person";

/** A teammate as a palette target: the roster member plus the facts its
 *  verbs branch on, read live while the palette is drilled into them. */
export type PalettePerson = {
  _id: string;
  name: string;
  username?: string;
  member: any;
  online: boolean;
  following: boolean;
  /** The session they have open, as the row the palette opens: a stub
   *  carrying the id until the inbox row (or a fetched one) is known. */
  session: { _id: string; title?: string } | null;
};
export type PaletteAction = {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  hotkey?: string;
  shortcutAction?: ShortcutAction;
};

export function paletteObjectPath(type: PaletteTargetType, target: any): string {
  if (type === "person") return `/team/${target.username || target._id}`;
  const route = { session: "conversation", task: "tasks", doc: "docs", plan: "plans", project: "projects", trigger: "triggers" }[type];
  return `/${route}/${target._id}`;
}

/** A row already wearing a character, for the verb's wording. Reads the row
 *  alone: the palette does not know the workspace switch, and "Change" on a
 *  row that only has a face because of that switch is still honest. */
function isPersonified(target: { _id: string; character_avatar?: string | null; character_name?: string | null; standing_role_id?: string | null; role?: unknown }): boolean {
  return sessionIdentity(target as never, false).kind !== "plain";
}

/** `mode` is hosted mode's registry (lib/surfaces.ts useSurfaceMode): model
 *  and machine verbs follow its pickers and chips. */
export function paletteActions(type: PaletteTargetType | null, targets: any[], userId?: string, chatOn = false, mode: SurfaceMode = DEVELOPER_MODE): PaletteAction[] {
  const target = targets[0];
  if (!type || !target) return [];
  const single = targets.length === 1;
  const row = (key: string, label: string, icon: PaletteAction["icon"], hotkey?: string, shortcutAction?: ShortcutAction): PaletteAction => ({ key, label, icon, hotkey: shortcutAction ? undefined : hotkey, shortcutAction });
  // A teammate: where they are first (follow), then the ways to reach them,
  // then their profile. The huddle row's word is live call state, so the
  // palette renders it from its own hook (PersonHuddleItem) and it has no
  // hotkey here.
  if (type === "person") {
    const p = target as PalettePerson;
    return [
      ...(p.following ? [row("person_follow", "Stop following", ArrowRight, "f")]
        : p.online ? [row("person_follow", p.session ? `Follow · ${p.session.title ? cleanTitle(p.session.title) : "a session"}` : "Follow", ArrowRight, "f")] : []),
      ...(chatOn ? [row("person_message", "Message", MessageSquare, "m")] : []),
      row("person_huddle", "Huddle", Headphones),
      row("open", "Open profile", User, "o"),
      row("newtab", "Open profile in new tab", ExternalLink, "n"),
      row("copylink", "Copy profile link", Link, "c"),
    ];
  }
  const common = single ? [
    row("open", "Open", ExternalLink, "o"),
    row("newtab", "Open in new tab", ExternalLink, "n"),
    row("copy", `Copy ${type} ID`, Copy, "i"),
    row("copylink", "Copy link", Link, "c", type === "session" ? "conv.copyLink" : undefined),
    ...(chatOn ? [row("forward", "Send to chat…", Forward, "h")] : []),
  ] : [];
  if (type === "session") {
    const own = !target.authorName && !!userId && !isForeignSession(target, target, userId);
    if (!own) return common;
    // Verbs that read one conversation (agent, model, rename, parent, branch,
    // files) only show for one row; the rest act on every target.
    const n = targets.length;
    const many = (one: string, several: string) => (single ? one : several.replace("#", String(n)));
    // The same move verbs the session control menu offers (none for a hosted
    // assistant conversation), and Move to machine only where one runs it.
    const verbs = sessionMoveVerbs(target.agent_type, target.session_id, target.model);
    // The mode's noun ("session", or "conversation" in hosted mode), and the
    // fleet verbs (stash and hide, defer, dormant) only where its triage bar shows.
    const { words } = mode;
    const noun = words.conversation.toLowerCase();
    const nouns = words.conversations.toLowerCase();
    const fleet = mode.shows("triageBar");
    return [
      ...(single ? [
        ...(verbs.includes("switch") ? [row("agent_switch", "Switch agent…", Bot, "a")] : []),
        ...(verbs.includes("fork") ? [row("agent_fork", `Fork ${noun} as…`, GitBranch, "f")] : []),
        ...(verbs.includes("handoff") ? [row("agent_handoff", "Hand off to…", ArrowRightLeft, "t")] : []),
        ...(mode.shows("modelPicker") && canControlModel(target.agent_type, target.session_id, target.model) ? [row("model", "Change model & effort…", Cpu, "m")] : []),
        row("rename", `Rename ${noun}…`, Pencil, "r", "session.rename"),
      ] : []),
      // Personifying is opt in, so the verb names what it does for a row that
      // has no character yet (session-characters.md S2). Hosted mode offers
      // only the change, for a row that already has one.
      ...(mode.shows("conversation.internals") || isPersonified(target) ? [row("character", isPersonified(target) ? many("Change character…", `Change character for # ${nouns}…`) : many("Give it a character…", `Give # ${nouns} characters…`), Smile, "y")] : []),
      row("session_pin", target.is_pinned ? many(`Unpin ${noun}`, `Unpin # ${nouns}`) : many(`Pin ${noun}`, `Pin # ${nouns}`), target.is_pinned ? PinOff : Pin, "p", "session.pin"),
      row("session_favorite", target.is_favorite ? many("Remove from favorites", "Remove # from favorites") : many("Add to favorites", "Add # to favorites"), Star, "v", "conv.favorite"),
      row("bucket", many(`Label ${noun}…`, `Label # ${nouns}…`), Tag, "l", "session.moveToBucket"),
      ...(mode.shows("machineChips") && targets.every((t) => canMoveSessionToMachine(t.agent_type)) ? [row("device", many("Move to machine…", `Move # ${nouns} to machine…`), ArrowRightLeft, "w")] : []),
      ...(!isSessionKilled(target) ? [row("snooze", many(`Snooze ${noun}…`, `Snooze # ${nouns}…`), Clock, "z", "session.snooze")] : []),
      ...(target.inbox_snoozed_until ? [row("session_unsnooze", "Move to Needs Input now", RefreshCw, "u")] : []),
      ...(isSessionSetAside(target) ? [row("session_restore", many(`Restore ${noun} to inbox`, `Restore # ${nouns} to inbox`), RefreshCw, "u")] : [
        row("session_stash", many(`${words.stash} ${noun}`, `${words.stash} # ${nouns}`), Archive, "s", "session.stash"),
        ...(fleet ? [
          row("session_stash_hide", many(`Stash and hide ${noun}`, `Stash and hide # ${nouns}`), EyeOff, "b", "session.stashHide"),
          row("session_defer", many(`Defer ${noun}`, `Defer # ${nouns}`), Clock, "d", "session.deferAdvance"),
          row("session_dormant", "Dormant: a machine wakes it", Moon, "z", "session.dormantAdvance"),
        ] : []),
        row("session_done", "Mark done", CheckCircle2, "e"),
        row("session_needs_input", words.markNeedsInput, CircleDot, "g"),
      ]),
      ...(!isSessionKilled(target) ? [row("session_kill", many(`${words.killConfirm} ${noun}`, `${words.killConfirm} # ${nouns}`), Square, "k", "session.kill")] : []),
      ...(!target.persistent ? [row("session_delete", many(`Delete ${noun}…`, `Delete # ${nouns}…`), Trash2, "x")] : []),
      ...(single && target.parent_conversation_id ? [row("session_parent", "View parent conversation", GitBranch)] : []),
      ...(single && target.git_branch ? [row("session_branch", "Copy branch name", GitBranch)] : []),
      ...(single && (target.project_path || target.git_root) ? [row("session_files", "Open project files", Folder)] : []),
      // A conversation's id is machinery in hosted mode.
      ...(mode.shows("conversation.internals") ? common : common.filter((action) => action.key !== "copy")),
    ];
  }
  if (type === "task") return [
    row("status", "Change status…", CircleDot, "s", "task.status"),
    row("priority", "Set priority…", ArrowUp, "p", "task.priority"),
    row("labels", "Edit labels…", Tag, "l", "task.labels"),
    row("assign", "Assign to…", User, "a", "task.assign"),
    row("project", "Move to project…", Folder, "j"),
    row("parent", "Set parent…", CornerDownRight, "t"),
    ...(targets.some(t => t.parent_id) ? [row("remove_parent", "Remove parent", CornerDownRight)] : []),
    row("agent_run", "Start agent run…", Bot, "g"),
    ...(single ? [row("rename", "Rename task…", Pencil, "r")] : []),
    ...common,
    row("drop", "Drop task", Trash2, "x"),
  ];
  if (type === "doc") return [
    row("type", "Change type…", FileText, "t", "doc.type"),
    row("labels", "Edit labels…", Tag, "l", "doc.labels"),
    ...(single ? [row("rename", "Rename document…", Pencil, "r"), row("pin", target.pinned ? "Unstar document" : "Star document", Star, "p")] : []),
    ...common,
    row("archive", "Archive document", Archive, "x"),
  ];
  if (type === "plan") return [
    row("plan_status", "Change status…", CircleDot, "s"),
    row("rename", "Rename plan…", Pencil, "r"),
    row("create_task", "Add task to plan…", Plus, "t"),
    ...common,
  ];
  if (type === "project") return [
    row("project_status", "Change status…", CircleDot, "s"),
    row("rename", "Rename project…", Pencil, "r"),
    row("deadline", "Set target date…", CalendarDays, "d"),
    ...(target.target_date ? [row("clear_deadline", "Clear target date", CalendarDays)] : []),
    row("create_task", "Add task to project…", Plus, "t"),
    row("create_plan", "Add plan to project…", Plus, "p"),
    row("create_doc", "Add document to project…", Plus, "f"),
    ...common,
  ];
  const armed = ["scheduled", "paused", "running"].includes(target.status);
  return [
    ...(armed ? [
      row("trigger_runNow", "Run trigger now", Play, "r"),
      target.status === "paused" ? row("trigger_resume", "Resume trigger", Play, "p") : row("trigger_pause", "Pause trigger", Square, "p"),
      row("trigger_cancel", "Cancel trigger…", Trash2, "x"),
    ] : [row("trigger_reactivate", "Reactivate trigger", RefreshCw, "r")]),
    ...(isTriggerEditable(target.status) ? [row("trigger_edit", "Edit prompt & cadence…", Pencil, "e")] : []),
    row("trigger_duplicate", "Duplicate trigger…", Copy, "d"),
    row("trigger_prompt", "Copy prompt", Copy, "m"),
    ...(!armed ? [row("trigger_delete", "Delete trigger…", Trash2, "x")] : []),
    ...common,
  ];
}

export function paletteDigitIndex(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean }, count: number): number {
  if (event.isComposing || event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey) || !/^[1-9]$/.test(event.key)) return -1;
  const index = Number(event.key) - 1;
  return index < count ? index : -1;
}

export function paletteActionForKey(event: KeyboardEvent, actions: PaletteAction[]): PaletteAction | undefined {
  if (event.isComposing || event.defaultPrevented) return;
  const target = event.target as HTMLElement | null;
  return actions.find(action => {
    if (action.shortcutAction) {
      return getShortcutsForAction(action.shortcutAction).some(def =>
        matchShortcut(event, def) && (!isEditableTarget(target) || inputGuardBypass(def, target)),
      );
    }
    return event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
      && !!action.hotkey && event.code === `Key${action.hotkey.toUpperCase()}`;
  });
}

const PALETTE_MATCH = 1;
// A row whose text starts with the query, which for a command is its label:
// typing a command's name ranks it above session and entity hits, which all
// score a flat PALETTE_MATCH, so Enter runs the command the person named.
const PALETTE_LABEL_HIT = 1.5;
// Every query word found in the row's label, in any order ("task new" names
// "New task"): below a label that starts with the query, above a keyword hit.
const PALETTE_LABEL_WORDS = 1.25;
const PALETTE_COMPOSE = 0.1;
// A found row (a conversation, a to-do, a note, a routine) whose title holds
// the query ranks above one found only in its words further in (a message
// snippet), across kinds, and one whose title starts with it above both.
// Both stay under a command the query names (PALETTE_LABEL_WORDS).
const PALETTE_TITLE_WORDS = 0.1;
const PALETTE_TITLE_START = 0.15;
// The rows after every hit, in this order: "N more in Everything", then
// "Open full search", then asking the assistant (PALETTE_COMPOSE).
const PALETTE_MORE = 0.2;
const PALETTE_FULL_SEARCH = 0.15;
export const PALETTE_TAIL_MORE = "__more__";
export const PALETTE_TAIL_SEARCH = "__search__page";

/** Between a row's label and its keywords in a cmdk value (paletteValue). */
const LABEL_END = "\u2063";

/** A row's cmdk value: the label it renders (in the mode's words, so a hosted
 *  label is always searchable) and then its keywords. paletteItemScore ranks
 *  a hit in the label above a hit in the keywords. */
export function paletteValue(label: string, keywords = ""): string {
  return `${label}${LABEL_END} ${keywords}`;
}

/** How much a found row's title matches the query: its title is the text
 *  after the row's prefix up to the label end (paletteValue), or the whole
 *  text when the row has none. */
function titleHit(value: string, search: string): number {
  const needle = search.trim().toLowerCase();
  if (!needle) return 0;
  const text = value.slice(value.indexOf("__", 2) + 2).trimStart();
  const end = text.search(/\u2063|\|\|\|/);
  const title = (end >= 0 ? text.slice(0, end) : text).toLowerCase();
  if (title.startsWith(needle)) return PALETTE_TITLE_START;
  return hasEveryWord(title, needle.split(/\s+/)) ? PALETTE_TITLE_WORDS : 0;
}

/** Every word of the query appears somewhere in the text, in any order. */
function hasEveryWord(hay: string, words: string[]): boolean {
  return words.length > 0 && words.every((word) => hay.includes(word));
}

// Session filter completions: a value for a typed operator (`file:` → paths)
// leads, since the operator alone searches nothing; an operator name for a
// word that may just be text (`au` → author:) trails the real matches.
const PALETTE_FILTER_VALUE = 2;
const PALETTE_FILTER_NAME = 0.5;

/** cmdk filter score: 0 hides, higher ranks first. cmdk then sorts groups by
 *  their best item, so a row that creates from the typed query (`__compose__`)
 *  must score below a real match. Scoring it with matches puts
 *  "Files: New note" at the top and Enter creates a note instead of opening
 *  the hit. */
/** Whether a query asks to make something ("new", "create", or either with
 *  what to make): the palette then leads with its Create group, so the word
 *  reaches New conversation, task, doc and routine before any command that
 *  merely starts with it. Two letters at least, so "n" stays a search. */
export function queryAsksToCreate(query: string): boolean {
  const q = query.trim().toLowerCase();
  return q.length >= 2 && ["new", "create"].some((word) => word.startsWith(q) || q.startsWith(`${word} `));
}

export function paletteItemScore(value: string, search: string): number {
  if (value.startsWith("__compose__")) return PALETTE_COMPOSE;
  if (value.startsWith("__filter__v")) return PALETTE_FILTER_VALUE;
  if (value.startsWith("__filter__o")) return PALETTE_FILTER_NAME;
  if (value.startsWith(PALETTE_TAIL_MORE)) return PALETTE_MORE;
  if (value.startsWith(PALETTE_TAIL_SEARCH)) return PALETTE_FULL_SEARCH;
  if (
    value.startsWith("__search__") ||
    value.startsWith("__recent__") ||
    value.startsWith("__entity__")
  ) return PALETTE_MATCH + titleHit(value, search);
  if (
    value.startsWith("__chat__") ||
    value.startsWith("__pick__") ||
    value.startsWith("__teammate__")
  ) return PALETTE_MATCH;
  const idx = value.indexOf("|||");
  const searchable = idx >= 0 ? value.slice(0, idx) : value;
  const hay = searchable.toLowerCase();
  const needle = search.trim().toLowerCase();
  if (!needle) return PALETTE_MATCH;
  if (hay.startsWith(needle)) return PALETTE_LABEL_HIT;
  // Each word on its own, so "new task" finds "Create task new todo".
  const words = needle.split(/\s+/);
  const labelEnd = hay.indexOf(LABEL_END);
  if (labelEnd >= 0 && hasEveryWord(hay.slice(0, labelEnd), words)) return PALETTE_LABEL_WORDS;
  return hay.includes(needle) || hasEveryWord(hay, words) ? PALETTE_MATCH : 0;
}
