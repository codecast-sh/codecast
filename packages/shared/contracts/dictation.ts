// Dictation: speech streamed into a text box, the way Claude's composer does it.
//
// One controller for the web and the phone. The platform hands it two things:
// the field (read the text and the selection, write the text and the caret)
// and a way to open a recognizer on the microphone (web: asrPipe on a
// getUserMedia track; phone: asrCapture). Everything a person can see happen
// to their text lives here, so both apps behave the same:
//
// - The words go in at the cursor, or over the selection, with a space added
//   where the text on either side needs one.
// - The sentence still being spoken rewrites itself in place until the
//   recognizer closes it; closed sentences never move again.
// - Finish waits (bounded, inside the pipe) for the last words; Cancel puts
//   the field back exactly as it was before the press.
// - It stops by itself, keeping its words, after a minute with no new words or
//   ten minutes in all, and when the person edits the field under it.
// - One recording at a time: starting another finishes the one running.
//
// The text is the field's own: the controller writes through the composer's
// setter, so drafts, autosave and send see dictated words as typed ones. No
// audio or words go anywhere but the recognizer.

import { letterScript, localTranscribeLanguages } from "./transcribeLanguage";

/** A minute with no new words ends a recording (Claude Code's rule). */
export const DICTATION_SILENCE_MS = 60_000;
/** Ten minutes is the most one recording runs. */
export const DICTATION_MAX_MS = 600_000;
/** How soon typing into the box ends a recording that hears nothing more. */
const EDIT_POLL_MS = 1_000;

export type DictationPhase = "idle" | "starting" | "listening" | "finishing";

/** Why a recording ended without the person pressing Finish or Cancel. */
export type DictationStop = "silence" | "limit" | "dropped" | "edited";

export type DictationState = {
  phase: DictationPhase;
  /** The last start that failed (microphone blocked, the server refused). */
  error: string | null;
  /** How the last recording ended by itself, or null. */
  stopped: DictationStop | null;
};

export const DICTATION_IDLE: DictationState = { phase: "idle", error: null, stopped: null };

/** The one-line reason a recording stopped by itself (under 40 characters,
 *  so a phone's one-line notice bar never cuts it). */
export function dictationStopLine(stop: DictationStop | null): string | null {
  switch (stop) {
    case "silence":
      return "Dictation stopped: 1 min of silence";
    case "limit":
      return "Dictation stopped at 10 minutes";
    case "dropped":
      return "Dictation stopped: connection lost";
    // The person's own typing stopped it: they know why, so nothing to say.
    case "edited":
      return null;
    default:
      return null;
  }
}

// ── Where the words go ────────────────────────────────────────────────────

/** The field as it stood when the recording started. */
export type DictationAnchor = {
  /** Text before the insertion point. */
  before: string;
  /** Text after it (a selection between them is replaced). */
  after: string;
  /** The whole value and selection, so Cancel restores them exactly. */
  original: string;
  selection: readonly [number, number];
};

export function dictationAnchor(value: string, selection: readonly [number, number] | null): DictationAnchor {
  const clamp = (n: number) => Math.max(0, Math.min(value.length, n));
  const [a, b] = selection ? [clamp(selection[0]), clamp(selection[1])] : [value.length, value.length];
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  return { before: value.slice(0, start), after: value.slice(end), original: value, selection: [start, end] };
}

/** Scripts written without spaces between words. */
function unspaced(ch: string | undefined): boolean {
  if (!ch) return false;
  const s = letterScript(ch);
  return s === "han" || s === "kana" || s === "thai";
}

/** Join two pieces of speech: a space between them unless both sides are a
 *  script written without spaces. */
function joinSpoken(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return unspaced(a[a.length - 1]) && unspaced(b[0]) ? a + b : `${a} ${b}`;
}

/** Everything heard so far: the closed sentences, then the open one. */
export function spokenText(committed: readonly string[], partial: string): string {
  let out = "";
  for (const piece of [...committed, partial]) out = joinSpoken(out, piece.replace(/\s+/g, " ").trim());
  return out;
}

/** The field's value with `spoken` at the anchor, and where the caret goes. */
export function spliceDictation(anchor: DictationAnchor, spoken: string): { value: string; caret: number } {
  const { before, after } = anchor;
  if (!spoken) return { value: before + after, caret: before.length };
  const lead = before && !/\s$/.test(before) && !(unspaced(before[before.length - 1]) && unspaced(spoken[0])) ? " " : "";
  const trail = after && !/^[\s.,;:!?)\]}'"]/.test(after) && !(unspaced(spoken[spoken.length - 1]) && unspaced(after[0])) ? " " : "";
  const head = before + lead + spoken;
  return { value: head + trail + after, caret: head.length };
}

// ── Languages ─────────────────────────────────────────────────────────────

/** The caret menu's choices. `null` is Auto: the device's own languages. */
export const DICTATION_LANGUAGES: readonly { code: string | null; label: string }[] = [
  { code: null, label: "Auto" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "sv", label: "Swedish" },
  { code: "da", label: "Danish" },
  { code: "no", label: "Norwegian" },
  { code: "cs", label: "Czech" },
  { code: "el", label: "Greek" },
  { code: "tr", label: "Turkish" },
  { code: "uk", label: "Ukrainian" },
  { code: "ru", label: "Russian" },
  { code: "hi", label: "Hindi" },
  { code: "id", label: "Indonesian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh-cn", label: "Chinese" },
];

/** The allowlist a recording asks the recognizer for. */
export function dictationLanguages(choice: string | null | undefined): string[] {
  return choice ? [choice] : localTranscribeLanguages();
}

/** The label the caret menu shows for a stored choice (unknown codes read as Auto). */
export function dictationLanguageLabel(choice: string | null | undefined): string {
  return DICTATION_LANGUAGES.find((l) => l.code === (choice ?? null))?.label ?? "Auto";
}

// ── The controller ────────────────────────────────────────────────────────

export type DictationField = {
  getValue(): string;
  /** null when the field is not mounted or has no selection: words go at the end. */
  getSelection(): readonly [number, number] | null;
  /** Write the whole value and put the caret at `caret`. With `anchor`, the
   *  selection runs from `anchor` to `caret` (Cancel restoring a selection);
   *  without it the selection is collapsed. */
  setValue(value: string, caret: number, anchor?: number): void;
};

/** What a platform's recognizer reports. Mirrors asrPipe's events. */
export type DictationPipeEvents = {
  onPartial(text: string): void;
  onUtterance(u: { text: string }): void;
  /** The pipe never opened (server refused, not configured). */
  onFailed(message: string): void;
  /** The connection closed while still wanted. */
  onDropped(): void;
};

export type DictationPipe = {
  /** Commit what is buffered and wait (bounded) for its words. */
  finish(): Promise<void>;
  /** Abandon: nothing committed, nothing waited for. */
  close(): void;
};

export type DictationHost = {
  /** Open the microphone and a recognizer on it. Rejects when the microphone
   *  cannot be had; the message is what the mic shows. `signal.aborted` turns
   *  true once nothing wants this recording any more (cancelled, another box
   *  took over, a huddle started): a host checks it after each slow step (the
   *  permission prompt, the microphone) and stops there instead of minting a
   *  key and opening a recognizer nobody will read. */
  open(events: DictationPipeEvents, signal: { readonly aborted: boolean }): Promise<DictationPipe>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type Dictation = {
  readonly state: DictationState;
  start(): void;
  /** Keep the words. Resolves once the last words are in the field: true when
   *  the recording ended by finishing, false when it was cancelled, disposed or
   *  started over before its words came back. */
  finish(): Promise<boolean>;
  /** Finish, then run `then` (a send, a create) only if the words were kept.
   *  One slot: a second press replaces the first rather than running twice,
   *  and Cancel or unmount while finishing runs nothing. Idle runs `then` now. */
  finishThen(then: () => void): void;
  /** Put the field back as it was before the press. */
  cancel(): void;
  /** The box now writes for something else (the composer switched
   *  conversations): stop at once and never write to the field again. What
   *  is already written stays, nothing is restored, and a send waiting on the
   *  recording is dropped. */
  detach(): void;
  /** True while a press of Enter or Esc belongs to the recording. */
  readonly active: boolean;
  /** Stop listening for state changes and abandon any recording. */
  dispose(): void;
};

/** The newest recording in this app, so a second press elsewhere finishes it
 *  first. */
let running: Dictation | null = null;
/** Every recording not yet idle, finishing ones included. */
const live = new Set<Dictation>();

/** A start cancelled while the recording before it was still finishing. */
const ABANDONED = Symbol("dictation abandoned");

/** Whether a recording is running anywhere in this app. */
export function dictationRunning(): boolean {
  return live.size > 0;
}

/** Keep the words of the recording running anywhere in this app and stop it.
 *  Whatever else takes the microphone (a huddle, a room recording, the app
 *  going to the background, the screen going away) calls this first, so its
 *  audio never lands in a text box. */
export function finishRunningDictation(): Promise<void> {
  return Promise.all([...live].map((d) => d.finish())).then(() => {});
}

/** For tests: forget the running recording without touching it. */
export function _resetDictationForTests() {
  running = null;
  live.clear();
}

export function createDictation(
  field: DictationField,
  host: DictationHost,
  onState: (state: DictationState) => void,
): Dictation {
  const setTimer = host.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = host.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let state: DictationState = DICTATION_IDLE;
  let anchor: DictationAnchor | null = null;
  let committed: string[] = [];
  let partial = "";
  /** What this controller last wrote, to notice the person editing under it. */
  let written: string | null = null;
  let pipe: DictationPipe | null = null;
  /** Bumped by every start and stop, so a late callback from an old
   *  recording (a mic that resolves after Cancel) does nothing. */
  let run = 0;
  let silenceTimer: unknown = null;
  let maxTimer: unknown = null;
  let editTimer: unknown = null;
  let finishing: Promise<boolean> | null = null;
  let disposed = false;
  /** finishThen's one slot, for the recording finishing now. */
  let after: { then: () => void } | null = null;

  const set = (next: Partial<DictationState>) => {
    state = { ...state, ...next };
    if (!disposed) onState(state);
  };

  const clearTimers = () => {
    if (silenceTimer != null) clearTimer(silenceTimer);
    if (maxTimer != null) clearTimer(maxTimer);
    if (editTimer != null) clearTimer(editTimer);
    silenceTimer = maxTimer = editTimer = null;
  };

  const armSilence = (id: number) => {
    if (silenceTimer != null) clearTimer(silenceTimer);
    silenceTimer = setTimer(() => {
      if (id === run) void stop("silence");
    }, DICTATION_SILENCE_MS);
  };

  /** Put the words heard so far into the field. False when the person has
   *  changed the field under the recording: then nothing is written. */
  const render = (): boolean => {
    if (!anchor) return true;
    // Before the first word the box should still hold what it held at the
    // press; after it, what this controller last wrote. Anything else is the
    // person typing, and their text wins.
    if (field.getValue() !== (written ?? anchor.original)) return false;
    const spoken = spokenText(committed, partial);
    // Nothing heard yet: leave the box exactly as it is (a selection stays).
    if (!spoken && written === null) return true;
    const { value, caret } = spliceDictation(anchor, spoken);
    if (value === written) return true;
    written = value;
    field.setValue(value, caret);
    return true;
  };

  const settle = (stopped: DictationStop | null, error: string | null = null) => {
    clearTimers();
    pipe = null;
    anchor = null;
    written = null;
    committed = [];
    partial = "";
    finishing = null;
    if (running === self) running = null;
    live.delete(self);
    run++;
    // A send waiting on this recording runs now, with the text as it stands,
    // however the recording ended (Cancel and unmount empty the slot first).
    const pending = after;
    after = null;
    set({ phase: "idle", stopped, error });
    try {
      pending?.then();
    } catch (err) {
      // A send that throws is the composer's failure, not the recording's: it
      // must not turn finish() into a rejected promise nobody awaits.
      console.error("[dictation] send after finishing threw", err);
    }
  };

  /** Typing into the box mid-recording ends it at once, not at the next word
   *  (which may never come once the person stops talking). */
  const watchEdits = (id: number) => {
    editTimer = setTimer(() => {
      if (id !== run || state.phase !== "listening" || !anchor) return;
      if (field.getValue() !== (written ?? anchor.original)) {
        pipe?.close();
        settle("edited");
        return;
      }
      watchEdits(id);
    }, EDIT_POLL_MS);
  };

  const heard = (id: number) => {
    if (id !== run) return;
    if (!render()) {
      // The person typed into the box mid-recording: their text wins, and
      // what the recognizer says from here has nowhere honest to go.
      pipe?.close();
      settle("edited");
      return;
    }
    armSilence(id);
  };

  /** Keep the words: wait for the last ones, then go idle. */
  const stop = (why: DictationStop | null): Promise<boolean> => {
    if (finishing) return finishing;
    if (state.phase === "idle") return Promise.resolve(true);
    const id = run;
    const p = pipe;
    if (!p) {
      // Still opening the microphone: nothing was heard, nothing to keep.
      settle(why);
      return Promise.resolve(true);
    }
    set({ phase: "finishing" });
    clearTimers();
    finishing = p
      .finish()
      .catch(() => {})
      .then(() => {
        // Cancelled, disposed or edited while the last words were on their way.
        if (id !== run) return false;
        // A sentence the recognizer never closed is still what the person saw
        // in the box, so it stays.
        if (partial) {
          committed.push(partial);
          partial = "";
        }
        render();
        p.close();
        settle(why);
        return true;
      });
    return finishing;
  };

  const self: Dictation = {
    get state() {
      return state;
    },
    get active() {
      return state.phase !== "idle";
    },
    start() {
      if (disposed || state.phase !== "idle") return;
      // The recording running elsewhere ends first, words kept, and this one
      // opens the microphone only once it has let go: two recognizers never
      // hold the microphone (or the phone's audio session) at once.
      const others = [...live].filter((d) => d !== self);
      const prior = others.length ? Promise.all(others.map((d) => d.finish())) : null;
      running = self;
      live.add(self);
      const id = ++run;
      anchor = dictationAnchor(field.getValue(), field.getSelection());
      committed = [];
      partial = "";
      written = null;
      set({ phase: "starting", error: null, stopped: null });
      const events: DictationPipeEvents = {
        onPartial: (text) => {
          if (id !== run) return;
          partial = text;
          heard(id);
        },
        onUtterance: (u) => {
          if (id !== run) return;
          const text = u.text.trim();
          if (text) committed.push(text);
          partial = "";
          heard(id);
        },
        onFailed: (message) => {
          if (id !== run) return;
          // Words already in the box stay; the mic says why it stopped.
          pipe?.close();
          settle(null, message || "Dictation could not start");
        },
        onDropped: () => {
          if (id === run) void stop("dropped");
        },
      };
      const signal = {
        get aborted() {
          return id !== run || disposed;
        },
      };
      const opening = prior
        ? prior.then(() => (signal.aborted ? Promise.reject(ABANDONED) : host.open(events, signal)))
        : host.open(events, signal);
      opening.then(
        (opened) => {
          if (id !== run || disposed) {
            opened.close();
            return;
          }
          pipe = opened;
          set({ phase: "listening" });
          armSilence(id);
          watchEdits(id);
          maxTimer = setTimer(() => {
            if (id === run) void stop("limit");
          }, DICTATION_MAX_MS);
        },
        (err: unknown) => {
          if (err === ABANDONED || id !== run) return;
          settle(null, err instanceof Error ? err.message : String(err || "Microphone unavailable"));
        },
      );
    },
    finish() {
      return stop(null);
    },
    finishThen(then) {
      if (state.phase === "idle") {
        then();
        return;
      }
      if (after) {
        after.then = then;
        return;
      }
      // The send runs when the recording settles, however it ends, as long
      // as the text stays: a recognizer that fails or a person who types
      // during the last words still sent what is in the box (settle drains
      // the slot). Only Cancel and unmount, which empty it, drop it.
      after = { then };
      void stop(null);
    },
    cancel() {
      after = null;
      if (state.phase === "idle") return;
      const a = anchor;
      pipe?.close();
      if (a) {
        // Back exactly as it was, selection included, unless the person has
        // already typed over the recording (then their text stands).
        if (written !== null && field.getValue() === written) field.setValue(a.original, a.selection[1], a.selection[0]);
      }
      settle(null);
    },
    detach() {
      after = null;
      if (state.phase === "idle") return;
      // settle bumps `run`, so a finish, an open or a word still on its way
      // from this recording finds itself stale and writes nothing.
      pipe?.close();
      settle(null);
    },
    dispose() {
      self.detach();
      disposed = true;
    },
  };
  return self;
}
