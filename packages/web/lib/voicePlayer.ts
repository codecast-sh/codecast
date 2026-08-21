// Playback for finished voice messages: ONE audio element for the whole app.
//
// Two bubbles playing at once is the failure everyone has met in a chat app —
// you scroll back, press a second note, and now two people are talking over
// each other. So playback is a module singleton with a single <audio>, exactly
// like callManager owns the one Room: pressing play anywhere stops whatever was
// playing before, because a person has one pair of ears.
//
// It lives outside the store on purpose. A playhead moves several times a
// second and nothing else in the app cares where it is, so putting it in a
// mutative draft would wake every chat subscriber four times a second to move
// one number. Bubbles read it through useSyncExternalStore instead, and the
// snapshot is cached so an unrelated re-render is free.
//
// The live half of the walkie is NOT here: a burst still being spoken comes out
// of the call room's own audio host (callManager), not out of a file. This is
// only the recording afterwards — which is also why the two small questions a
// bubble asks about that recording, which attachment it is and how long it
// runs, are answered here rather than in the component.

export type VoicePlayback = {
  /** The message id currently loaded, or null when nothing is. */
  key: string | null;
  playing: boolean;
  positionMs: number;
  /** From the file once it has loaded; the bubble prefers the server's
   *  duration_ms, which it knows before the audio is fetched. */
  durationMs: number;
};

const IDLE: VoicePlayback = { key: null, playing: false, positionMs: 0, durationMs: 0 };

let snapshot: VoicePlayback = IDLE;
const subscribers = new Set<() => void>();
let el: HTMLAudioElement | null = null;

function emit(next: VoicePlayback) {
  if (
    next.key === snapshot.key &&
    next.playing === snapshot.playing &&
    next.positionMs === snapshot.positionMs &&
    next.durationMs === snapshot.durationMs
  ) {
    return;
  }
  snapshot = next;
  for (const cb of subscribers) cb();
}

/** Whole seconds only. A voice note's playhead is read, not scrubbed, so waking
 *  React on every 40ms `timeupdate` would be motion nobody can see. */
function sync(playing: boolean) {
  if (!el) return;
  emit({
    key: snapshot.key,
    playing,
    positionMs: Math.floor(el.currentTime) * 1000,
    durationMs: Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : snapshot.durationMs,
  });
}

function audio(): HTMLAudioElement {
  if (el) return el;
  el = new Audio();
  el.preload = "none";
  el.addEventListener("timeupdate", () => sync(true));
  el.addEventListener("ended", () => emit({ ...snapshot, playing: false, positionMs: 0 }));
  el.addEventListener("pause", () => sync(false));
  el.addEventListener("play", () => sync(true));
  // A recording that will not decode is not worth a toast: the transcript above
  // it already carries what was said, which is the whole product argument for
  // transcribing in the first place.
  el.addEventListener("error", () => emit(IDLE));
  return el;
}

export function subscribeVoicePlayer(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function getVoicePlayback(): VoicePlayback {
  return snapshot;
}

/** Server-rendered and test renders have no Audio constructor; the button still
 *  draws, it just cannot be pressed there. */
export function getVoicePlaybackServer(): VoicePlayback {
  return IDLE;
}

/** Press play on one message. A different message already playing is stopped,
 *  not layered. Pressing the message that is already playing pauses it, and
 *  pressing it again resumes from where it stopped. */
export function toggleVoice(key: string, url: string): void {
  if (typeof window === "undefined") return;
  const a = audio();
  if (snapshot.key === key) {
    if (snapshot.playing) {
      a.pause();
      return;
    }
    void a.play().catch(() => emit({ ...snapshot, playing: false }));
    return;
  }
  a.pause();
  a.src = url;
  a.currentTime = 0;
  emit({ key, playing: false, positionMs: 0, durationMs: 0 });
  void a.play().catch(() => emit(IDLE));
}

export function stopVoice(): void {
  el?.pause();
  emit(IDLE);
}

/** "0:07" / "1:04". Voice notes are seconds long, so the minute is the ceiling
 *  the format needs. */
export function voiceDuration(ms: number | undefined): string {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The recording on a finished burst. It rides `attachments` like any other
 *  file, so the mime is what tells it apart from an image somebody sent. */
export function voiceAttachment<T extends { mime?: string }>(
  attachments: T[] | undefined,
): T | undefined {
  return attachments?.find((a) => a.mime?.startsWith("audio/"));
}
