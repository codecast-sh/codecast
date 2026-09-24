import { mediaFailureReason, participantImage, type ParticipantTile } from "./callMedia";
export { mediaFailureReason, listDevices, grantDeviceNames, type ParticipantTile } from "./callMedia";
// The media plane's one owner. Exactly one LiveKit Room lives here (module
// singleton, never in React state, never in the store); components render
// from the store's ephemeral `call` slice and call these methods. Convex
// stays the control plane: join/leave/heartbeat/invite go through calls.ts,
// and the access token is minted server-side after the same authorization.
//
// Media tracks are NOT store state (a MediaStreamTrack in a mutative draft is
// a bug factory): they live in a Map here, exposed to React through the
// subscribe/snapshot pair at the bottom (useSyncExternalStore, the chatLive
// pattern).
import {
  ConnectionState,
  DisconnectReason,
  LocalParticipant,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
  createAudioAnalyser,
} from "livekit-client";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";
import { mutateOnUnload } from "../keepaliveMutation";
import { memberDisplayName } from "../liveEntities";
import { RING_STUB, RING_STUB_MS, isRingStub, ringStubId, type RingStub } from "./ringStubs";
import { startScribe, stopScribe } from "./transcription";
import { readJoinPrefs, rememberCamera, rememberDevice, rememberMic } from "./joinPrefs";
import { huddleRoomOptions, SCREEN_SHARE_CAPTURE, SCREEN_SHARE_ENCODING } from "./livekitMedia";
import { bindPrewarmAudio, bindPrewarmConvex, takePrewarmedRoom, warmRoomPublishesMic } from "./roomPrewarm";
import { CALL_HEARTBEAT_MS, humanizeConvexError, localTranscribeLanguages } from "@codecast/shared/contracts";
import {
  hasCallPanel,
  isCallPanelWindow,
  isElectron,
  sendVoiceCommand,
  showCallPanel,
  voiceHostElsewhere,
} from "../desktop";
import { shouldYieldCallOnDisconnect } from "./callHandoff";
import { bindCallCursors } from "./callCursors";
import { focusExistingHuddle, huddleInOtherWindow } from "./huddleWindow";
import { readMeterLevel } from "./walkieMeter";
import { peekOsPermissions, permissionHint, refreshOsPermissions } from "../osPermissions";
import {
  soundCallJoin,
  soundCallLeave,
} from "../sounds";
type ConvexHandle = {
  mutation: (fn: any, args: any) => Promise<any>;
  action: (fn: any, args: any) => Promise<any>;
  // One-shot reads: answering a ring that just expired has to ask whether the
  // call is still going before it gives up (see roomStillLive).
  query: (fn: any, args: any) => Promise<any>;
};
let convex: ConvexHandle | null = null;
let room: Room | null = null;
let currentRoomKey: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
// Generation counter for join/leave interleaving: every joinCall bumps it and
// captures its own generation; leaveCall/teardown bump it too. A continuation
// that resumes after an await and finds the world moved on (another join, a
// leave) must abandon its work instead of writing last-writer-wins state over
// the newer call. Without this, join A → join B while A awaits connects TWO
// SFU rooms and leaks A's live mic.
let callGen = 0;
// The room a PERSON joined on purpose (JoinOpts.intent), if any. Auto-scribe
// reads it: a walkie's background seat never transcribes.
let deliberateRoomKey: string | null = null;
let audioHost: HTMLElement | null = null;
const audioEls = new Map<string, HTMLMediaElement>();

// React binds the live Convex client here (useCallSync); everything below
// no-ops politely until it has.
export function bindConvex(client: ConvexHandle) {
  convex = client;
  // The prewarm holds its own Room and mints its own token, so it needs the
  // same client — bound here rather than by a second call site, because a
  // prewarm that silently never runs is exactly the kind of thing nobody
  // notices until a join is slow again.
  bindPrewarmConvex(client);
  // The prewarm plays what it hears through THIS module's audio elements —
  // one map, one host, one idempotent attach — so a room adopted mid-voice
  // does not end up with two elements for one person.
  bindPrewarmAudio({ attach: attachAudio, detach: detachAudio });
}

// THE WALKIE'S SIDE OF A DELIBERATE JOIN.
//
// A burst and a call are the same room; what separates them is whether a
// person decided to be in it. The walkie engine holds that decision (its live
// room's mode) and a clock that hands a burst's seat back when nothing is
// happening in it — and that clock will hang up a huddle if the join that
// made the room a huddle never reached the engine. It did not reach it from
// an answered ring, or from the caller's own "ring them" off the walkie key:
// only the strip's Join live told the walkie, so a ring answered into a room
// somebody was auto-listening in was hung up by the listener's own seat clock
// seconds later, and the far side followed when the room emptied.
//
// So every deliberate join passes through this seam. The engine answers
// whether it holds the room — and if it does, the room is a call from this
// instant (the clock stops) and the seat is stamped for the far side. The
// engine imports this module, so it binds itself here rather than being
// imported.
let walkieUpgrade: ((roomKey: string) => boolean) | null = null;
export function bindWalkieUpgrade(fn: (roomKey: string) => boolean): void {
  walkieUpgrade = fn;
}

function setCall(patch: Parameters<ReturnType<typeof useInboxStore.getState>["setCallState"]>[0]) {
  useInboxStore.getState().setCallState(patch);
}

function ensureAudioHost(): HTMLElement {
  if (!audioHost) {
    audioHost = document.createElement("div");
    audioHost.style.display = "none";
    audioHost.dataset.role = "huddle-audio";
    document.body.appendChild(audioHost);
  }
  return audioHost;
}

let tilesSnapshot: ParticipantTile[] = [];
const tileSubscribers = new Set<() => void>();

export function subscribeCallTiles(cb: () => void): () => void {
  tileSubscribers.add(cb);
  return () => tileSubscribers.delete(cb);
}
export function getCallTiles(): ParticipantTile[] {
  return tilesSnapshot;
}

// Dev console seam (like window.__inboxStore): swap in fake tiles so the
// stage can be designed with N "videos" on screen without N cameras. A fake
// tile's `track` only needs attach/detach — set `el.srcObject` to a canvas
// stream. Pass null to go back to the real room's tiles.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as any).__setCallTiles = (fake: ParticipantTile[] | null) => {
    tilesOverride = fake;
    rebuildTiles();
  };
}
let tilesOverride: ParticipantTile[] | null = null;

function rebuildTiles() {
  const next: ParticipantTile[] = [];
  if (room) {
    const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    for (const p of all) {
      const isLocal = p instanceof LocalParticipant;
      const base = {
        identity: p.identity,
        name: p.name || p.identity,
        image: participantImage(p),
        isLocal,
      };
      for (const [source, kind] of [
        [Track.Source.Camera, "camera"],
        [Track.Source.ScreenShare, "screen"],
      ] as const) {
        const pub = p.getTrackPublication(source);
        // A remote track only renders once subscribed; a local one as soon
        // as it exists. Muted camera tracks stay listed (they render as a
        // frozen/black frame the tile can label) — a mute is not a removal.
        const track = pub && (isLocal || pub.isSubscribed) ? pub.track : null;
        if (!track) continue;
        next.push({ ...base, kind, track, key: `${p.identity}:${kind}:${pub!.trackSid || track.sid || "local"}` });
      }
    }
  }
  tilesSnapshot = tilesOverride ?? next;
  for (const cb of tileSubscribers) cb();
}

// ── local mic level ───────────────────────────────────────────────────────
// Own-mic level for the dock meter. Polled from an AnalyserNode on the local
// mic track (livekit-client's createAudioAnalyser), fanned out through the
// same subscribe/snapshot pattern as tiles — a level is a 20fps signal and
// has no business in the store (every write would re-render every subscriber
// of the call slice).
let micLevel = 0;
const levelSubscribers = new Set<() => void>();
let levelTimer: ReturnType<typeof setInterval> | null = null;
let levelCleanup: (() => void) | null = null;

export function subscribeMicLevel(cb: () => void): () => void {
  levelSubscribers.add(cb);
  return () => levelSubscribers.delete(cb);
}
export function getMicLevel(): number {
  return micLevel;
}

function stopLevelMeter() {
  if (levelTimer) clearInterval(levelTimer);
  levelTimer = null;
  levelCleanup?.();
  levelCleanup = null;
  if (micLevel !== 0) {
    micLevel = 0;
    for (const cb of levelSubscribers) cb();
  }
}

function startLevelMeter() {
  stopLevelMeter();
  const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track;
  if (!track || track.kind !== Track.Kind.Audio) return;
  try {
    const { analyser, cleanup } = createAudioAnalyser(track as any, {
      fftSize: 256,
      smoothingTimeConstant: 0.6,
    });
    const bytes = new Uint8Array(analyser.fftSize);
    levelCleanup = cleanup;
    levelTimer = setInterval(() => {
      // Muted → analyser reads silence anyway, but skip the work and pin 0 so
      // the meter reads honestly the instant the user mutes.
      const muted = useInboxStore.getState().call.muted;
      const v = muted ? 0 : readMeterLevel(analyser, bytes);
      if (Math.abs(v - micLevel) > 0.02 || (v === 0 && micLevel !== 0)) {
        micLevel = v;
        for (const cb of levelSubscribers) cb();
      }
    }, 50);
  } catch {}
}

// ── lifecycle ─────────────────────────────────────────────────────────────

// The room whose seat THIS client stamped as a walkie join. The stamp lives on
// the server row, and the server sweeps that row when a heartbeat misses the
// lease (a laptop asleep past 45s while livekit-client quietly reconnects).
// The recovery join below re-takes the seat, and a re-taken seat without the
// stamp reads to every third party as a burst that ended: the far side's
// surface drops from the call back to the strip. So the stamp is remembered
// here for the life of the seat and re-sent with every re-take.
let walkieJoinedSeat: string | null = null;

async function controlJoin(roomKey: string, opts?: { walkieJoin?: boolean }) {
  if (!convex) throw new Error("calls not bound yet");
  if (opts?.walkieJoin) walkieJoinedSeat = roomKey;
  await convex.mutation(api.calls.joinRoom, {
    room_key: roomKey,
    muted: useInboxStore.getState().call.muted,
    languages: localTranscribeLanguages(),
    // Only ever true, never false: the stamp says a conversation started here
    // and nothing takes that back but leaving.
    ...(opts?.walkieJoin || walkieJoinedSeat === roomKey ? { walkie_join: true } : {}),
  });
}

/** One beat of the seat lease: refresh the row, and re-take it when the
 *  server has swept it. Exported for the seam tests; the app reaches it only
 *  through the interval `startHeartbeat` arms. */
export async function heartbeatOnce(roomKey: string): Promise<void> {
  const { call } = useInboxStore.getState();
  if (!convex || call.roomKey !== roomKey) return;
  let res: any;
  try {
    res = await convex.mutation(api.calls.heartbeat, {
      room_key: roomKey,
      muted: call.muted,
      camera: call.camera,
      sharing: call.sharing,
      languages: localTranscribeLanguages(),
    });
  } catch {
    return;
  }
  // ok:false = the server lease-swept our row (laptop slept >45s while
  // livekit-client quietly reconnected the media). Re-take the seat so
  // occupancy matches the audible truth; if authorization now fails
  // (removed from team, session privatized), fall out of the call
  // entirely rather than haunting it. The re-take carries the walkie
  // stamp the swept row had (`walkieJoinedSeat`), so a conversation that
  // survived the sleep is still a conversation to everyone watching.
  const cur = useInboxStore.getState().call;
  if (res?.ok === false && cur.roomKey === roomKey && cur.phase === "connected") {
    await controlJoin(roomKey).catch(() => void leaveCall());
  }
}

function startHeartbeat(roomKey: string) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => void heartbeatOnce(roomKey), CALL_HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function attachAudio(track: RemoteTrack, participantId: string) {
  if (track.kind !== Track.Kind.Audio) return;
  // Idempotent: the prewarm sweep below and the TrackSubscribed listener can
  // both reach the same track, and a second element would play the voice twice.
  if (audioEls.has(`${participantId}:${track.sid}`)) return;
  const el = track.attach();
  el.dataset.participant = participantId;
  ensureAudioHost().appendChild(el);
  audioEls.set(`${participantId}:${track.sid}`, el);
}

function detachAudio(track: RemoteTrack, participantId: string) {
  const key = `${participantId}:${track.sid}`;
  const el = audioEls.get(key);
  track.detach().forEach((e) => e.remove());
  if (el) {
    el.remove();
    audioEls.delete(key);
  }
}

/** Is this LiveKit identity (a user id, per `mintAccessToken`) a live seat in
 *  the room's occupancy as the store holds it? Prewarm rows never reach the
 *  store: `getRoomOccupancy` projects `liveMembers`, which drops them. */
function seatedInRoom(roomKey: string, identity: string): boolean {
  const rows = useInboxStore.getState().callOccupancy?.[roomKey] ?? [];
  return rows.some((m: any) => String(m?.user_id ?? "") === identity);
}

// Participants connected ahead of their seat row, owed a join chime when it
// lands. Cleared with the media: a seat that never came is no arrival.
const joinChimePending = new Set<string>();
let seatSoundWatch: (() => void) | null = null;

function watchSeatSounds(roomKey: string) {
  if (seatSoundWatch) return;
  seatSoundWatch = useInboxStore.subscribe((st: any, prev: any) => {
    if (st.callOccupancy?.[roomKey] === prev.callOccupancy?.[roomKey]) return;
    for (const identity of [...joinChimePending]) {
      if (!seatedInRoom(roomKey, identity)) continue;
      joinChimePending.delete(identity);
      soundCallJoin();
    }
    if (joinChimePending.size === 0) stopSeatSoundWatch();
  });
}

function stopSeatSoundWatch() {
  seatSoundWatch?.();
  seatSoundWatch = null;
  joinChimePending.clear();
}

function teardownMedia() {
  stopHeartbeat();
  stopSeatSoundWatch();
  stopLevelMeter();
  for (const el of audioEls.values()) el.remove();
  audioEls.clear();
  if (room) {
    room.removeAllListeners();
    void room.disconnect();
    room = null;
  }
  currentRoomKey = null;
  rebuildTiles();
}

// Join a room end-to-end: control-plane row, token, SFU connect, mic publish.
// The store paints "connecting" synchronously; every await settles after.
//
// `micTrack` is the one seam in the media plane's ownership, and it is a
// handover: the caller has ALREADY acquired a microphone and is already reading
// it (the walkie records and transcribes from t=0, long before this join can
// land), so opening a second one here would put two mics on one person. Given a
// track, this publishes THAT track under the microphone source and owns it from
// then on — mute, the level meter and teardown all work on the publication
// exactly as if the track had been made here, and disconnecting stops it like
// any other. A caller that still needs its own copy hands over `track.clone()`,
// which shares the one capture without sharing its lifetime.
//
// `intent` is the other seam, and it is a question about the PERSON rather than
// the media: did somebody press something to be here?
//
//   DELIBERATE — a join button, an answered ring, "Join live" on a burst. The
//   microphone opens and the camera comes back the way they left it. This is
//   the founder's rule, and it is a rule rather than a default: "mics are never
//   muted by default on a deliberate join".
//   LISTEN — the walkie taking a seat so a teammate's burst can play. Nobody
//   pressed anything, so a microphone that will not open is not a failure to
//   report: the seat still hears the room, which is what it was taken for.
//   BACKGROUND (the absent default) — a window handing the call to another
//   window of its own. These carry their own mute state, so this path never
//   writes one; the server's muted default stands behind them.
export type JoinOpts = {
  micTrack?: MediaStreamTrack;
  intent?: "deliberate" | "listen";
  /** Stamp the seat as "stepped into a burst on purpose" (schema:
   *  call_members.walkie_joined_at). It is what upgrades both sides' surfaces
   *  from the walkie strip to the call. */
  walkieJoin?: boolean;
};

/**
 * OPEN THE MICROPHONE FOR A SEAT, OR TAKE THE SEAT WITHOUT ONE.
 *
 * A denied microphone is not a failed join, and treating it as one was the bug
 * this replaced: the walkie's auto-listen joins unmuted, so on a browser where
 * the person had refused the microphone the publish threw, the join's catch
 * tore the room down and freed the seat — and the receiver's strip went on
 * saying "Riley is talking" over a silence with no room behind it. The one
 * thing the person wanted, to hear their teammate, was the one thing the
 * failure took away.
 *
 * So the mic is the part of a join that is allowed to fail. What is left is a
 * seat that subscribes and publishes nothing, and `micDenied` says so — it
 * implies `muted`, and it is what lets a surface tell a person who chose
 * silence from one who has no choice.
 *
 * `listen` is the difference between the two callers. A person who pressed
 * Join live asked to talk and is owed the sentence, so the failure is written
 * to `call.error` and the dock shows it. A background listen asked for
 * nothing; a red notice over a burst that is playing perfectly well would be
 * the surface inventing a problem, and the strip says the true thing in its
 * own words instead.
 */
export async function openMicForJoin(
  participant: { setMicrophoneEnabled: (on: boolean) => Promise<unknown> },
  opts: { intent?: JoinOpts["intent"] },
): Promise<void> {
  // A LISTEN PUBLISHES NOTHING. A walkie is one way: the person talking is
  // seen and heard, and hears nobody back until the listener steps in on
  // purpose (Join live), which is the moment the microphone opens. Every other
  // join publishes in whatever mute state the person is already in. The rule
  // lives here rather than at the call site so that the store write below is
  // the only thing that ever claims an open microphone.
  const listen = opts.intent === "listen";
  if (listen) {
    setCall({ muted: true });
    return;
  }
  const muted = useInboxStore.getState().call.muted;
  try {
    await participant.setMicrophoneEnabled(!muted);
    // THE CLAIM FOLLOWS THE PUBLICATION AND NEVER PRECEDES IT. Writing
    // `muted: false` before the join — which is what the walkie's auto-listen
    // used to do — made the store's mute an intention rather than a fact, and
    // the gap between the SFU connecting and the device refusing is real: two
    // seconds, measured in a headless browser with the microphone denied. The
    // strip spent them saying "your mic is open, Riley can hear you" to a
    // person who had no microphone at all.
    if (!muted) setCall({ muted: false });
  } catch (err: any) {
    setCall({
      muted: true,
      micDenied: true,
      ...(listen ? {} : { error: await mediaFailureReason("microphone", err), errorFix: "microphone" as const }),
    });
  }
}

/**
 * A deliberate join into a room this window is ALREADY sitting in.
 *
 * Auto-listen means the receiver is seated and connected before they decide
 * anything, so "Join live" cannot go through the join path — there is nothing
 * left to join. Everything else the gesture means still applies, in the order
 * the join path uses: the mute state is written first so `controlJoin` records
 * it, then the seat is stamped, then the camera, which publishes a track and
 * therefore has to come last.
 */
async function applyDeliberateJoin(roomKey: string, opts: JoinOpts): Promise<void> {
  // The prefs are APPLIED here, not chosen, so they are not re-remembered.
  await setMuted(!readJoinPrefs().micOn, { remember: false });
  await controlJoin(roomKey, opts).catch(() => {});
  if (readJoinPrefs().cameraOn && !useInboxStore.getState().call.camera) {
    await setCamera(true);
  }
}
export async function joinCall(roomKey: string, opts?: JoinOpts): Promise<void> {
  // ONE MICROPHONE. On a desktop with a voice host, no other window ever
  // joins a room: the join is sent there, where the walkie's ear already sits
  // and where the call will live whatever shape it takes. That is what makes
  // "a burst becoming a call" a resize rather than a second window joining
  // and evicting the first. A track in hand is the walkie's own clone and
  // never crosses a window; it cannot reach here from a remote anyway.
  if (voiceHostElsewhere() && !opts?.micTrack) {
    const { micTrack: _t, ...rest } = opts ?? {};
    if (await sendVoiceCommand("joinCall", [roomKey, rest])) return;
  }
  return joinCallHere(roomKey, opts);
}

async function joinCallHere(roomKey: string, opts?: JoinOpts): Promise<void> {
  if (opts?.intent === "deliberate" && huddleInOtherWindow() && await focusExistingHuddle()) return;
  if (!convex) return;
  // A person stepping into a room the walkie holds IS the upgrade, whichever
  // button they pressed to do it (bindWalkieUpgrade). Decided before either
  // path below, so the engine's clock is stopped before any await.
  if (opts?.intent === "deliberate" && !opts.walkieJoin && walkieUpgrade?.(roomKey)) {
    opts = { ...opts, walkieJoin: true };
  }
  const prior = useInboxStore.getState().call;
  // Already in (or genuinely joining) this room: idempotent. "connecting" only
  // counts when a Room object exists AND belongs to this key — accepting a
  // ring while connected elsewhere paints {connecting, roomKey:B} while
  // `room` is still call A's Room; without the currentRoomKey check this
  // guard would return and wedge "connecting…" forever.
  if (
    prior.roomKey === roomKey &&
    currentRoomKey === roomKey &&
    (prior.phase === "connected" || (prior.phase === "connecting" && room))
  ) {
    // Idempotent as a JOIN, and still meaningful as an INTENT. Stepping into a
    // burst you are already auto-listening to has exactly this shape — the
    // seat is taken and the room is connected — and everything the gesture
    // means is still ahead of it: open the mic, restore the camera, and tell
    // the room that a person walked in on purpose.
    if (opts?.intent === "deliberate") {
      deliberateRoomKey = roomKey;
      await applyDeliberateJoin(roomKey, opts);
    }
    return;
  }
  deliberateRoomKey = opts?.intent === "deliberate" ? roomKey : null;
  // A fresh seat starts unstamped; `controlJoin` records the stamp if this
  // join carries one.
  walkieJoinedSeat = null;
  // A deliberate join starts the way the person's last call ended: mic on
  // unless they muted once and never unmuted (lib/calls/joinPrefs).
  if (opts?.intent === "deliberate") setCall({ muted: !readJoinPrefs().micOn });
  if (room) teardownMedia();
  const gen = ++callGen;
  // Abandon this continuation if a newer join/leave superseded it; disconnect
  // any Room THIS invocation created rather than touching the module singleton
  // (which by then belongs to the newer call).
  const superseded = (r?: Room) => {
    if (gen === callGen) return false;
    if (r && r !== room) void r.disconnect();
    return true;
  };
  setCall({
    phase: "connecting",
    roomKey,
    error: null, errorFix: null,
    micDenied: false,
    speaking: [],
    camera: false,
    sharing: false,
  });
  // THE CONNECTION MAY ALREADY EXIST. Opening a DM or resting on a face holds
  // a silent one open for that room (roomPrewarm), and this is where it is
  // spent: a warm room has already paid for the token and the SFU handshake,
  // which together are the seconds between pressing a key and being audible.
  //
  // Asked on EVERY join and before any await, hit or miss, because the other
  // half of the call is standing the prewarm down: `mintAccessToken` signs the
  // identity as the user id, so a prewarm still connecting when this join lands
  // would evict it from the SFU as a duplicate identity.
  const warm = takePrewarmedRoom(roomKey);
  let r: Room | undefined = warm ?? undefined;
  try {
    // THE SEAT ROW DOES NOT GATE THE VOICE.
    //
    // Both halves of a join are authorized by the SAME rule — `mintAccessToken`
    // runs `authorizeRoom` exactly as `joinRoom` does, and a warm room's token
    // was minted through it too — so this row is bookkeeping: who the dock
    // draws, who "X hears you" counts. Awaiting it here spent a whole
    // control-plane round trip before the handshake, which on the rig was most
    // of what remained between a press and the far side hearing it once both
    // rooms were warm.
    //
    // Still awaited, below, before the call is declared connected: a refusal
    // tears the media down a beat later rather than never.
    let seatError: unknown = null;
    const seated = controlJoin(roomKey, opts).catch((e) => {
      seatError = e;
    });
    if (superseded(r)) return;
    const conn = warm
      ? null
      : await convex.action(api.calls.mintAccessToken, { room_key: roomKey });
    if (superseded(r)) return;
    // THE DEVICES THE PERSON LAST CHOSE, on every join, not only deliberate
    // ones: which microphone is a fact about their desk, and a burst arriving
    // on the laptop's built-in mic when they have a headset on is the same bug
    // as a call doing it. Whether the mic is OPEN is the separate question,
    // and that one is the intent's business, below.
    //
    // A warm room was built with these same prefs and `takePrewarmedRoom`
    // refuses to hand one over whose microphone the person has changed since,
    // so the rule holds across the seam rather than being skipped at it.
    const prefs = readJoinPrefs();
    r = warm ?? new Room(huddleRoomOptions(prefs));
    room = r;
    currentRoomKey = roomKey;

    r.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      setCall({ speaking: speakers.map((s) => s.identity) });
    });
    // THE SOUNDS FOLLOW THE ROSTER, NOT THE SFU. A prewarm (roomPrewarm) is a
    // media connection with no seat behind it: a teammate who opened this DM
    // or rested on a face is in the LiveKit room, and nobody's screen says a
    // person is here. Chiming for that connection announces an arrival that
    // did not happen. So a participant earns the join chime when their SEAT
    // shows in the occupancy this client already subscribes to: now, if the
    // row landed first, or the moment it lands (`watchSeatSounds`), which is
    // also the moment a prewarm becomes a real join. One who leaves without
    // ever having been seated leaves in silence.
    r.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      if (seatedInRoom(roomKey, p.identity)) soundCallJoin();
      else {
        joinChimePending.add(p.identity);
        watchSeatSounds(roomKey);
      }
      rebuildTiles();
    });
    r.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      if (!joinChimePending.delete(p.identity)) soundCallLeave();
      rebuildTiles();
    });
    r.on(RoomEvent.TrackSubscribed, (track, _pub, participant: RemoteParticipant) => {
      attachAudio(track, participant.identity);
      rebuildTiles();
    });
    r.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant: RemoteParticipant) => {
      detachAudio(track, participant.identity);
      rebuildTiles();
    });
    // A remote UNPUBLISH (peer stopped sharing / turned camera off) is a
    // different event from unsubscribe and must also clear the tile — without
    // this a stopped share leaves a dead hero on the stage.
    r.on(RoomEvent.TrackUnpublished, () => rebuildTiles());
    // Teammates' pointers over a screen share, on the data channel.
    bindCallCursors(r);
    r.on(RoomEvent.TrackMuted, rebuildTiles);
    r.on(RoomEvent.TrackUnmuted, rebuildTiles);
    r.on(RoomEvent.LocalTrackPublished, (pub) => {
      rebuildTiles();
      if (pub.source === Track.Source.Microphone) startLevelMeter();
    });
    r.on(RoomEvent.LocalTrackUnpublished, (pub) => {
      rebuildTiles();
      if (pub.source === Track.Source.Microphone) stopLevelMeter();
      // Share ended from the browser/OS "stop sharing" bar, camera yanked by
      // a device change: reflect it, so the toggle never lies lit.
      if (pub.source === Track.Source.ScreenShare) {
        setCall({ sharing: false });
        pushFlags();
      }
      if (pub.source === Track.Source.Camera) {
        setCall({ camera: false });
        pushFlags();
      }
    });
    r.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (useInboxStore.getState().call.roomKey !== roomKey) return;
      // Another WINDOW of mine took this call over (the call panel popping out,
      // or the main window taking it back as the panel closes). Not a
      // disconnect to recover from and not a hang-up: the call is still going,
      // one room over. Hand the room across quietly.
      //
      // The policy lives in callHandoff so a LiveKit version that reports the
      // eviction as a number, a name, or PARTICIPANT_REMOVED cannot hang up a
      // call you just popped out — leaveRoom would delete the seat the other
      // window is sitting in.
      if (
        shouldYieldCallOnDisconnect(reason, {
          elsewhere: hasCallPanel() && !isCallPanelWindow(),
          outlivesWindow: callOutlivesWindow,
        })
      ) {
        void yieldRoomToOtherWindow();
        return;
      }
      // SFU-side disconnect (kicked, server restart, network gave up after
      // livekit-client's own retries): reflect reality and free the row.
      void leaveCall();
    });
    // A RECONNECT IS STILL THE CALL. livekit-client's `Reconnecting` is the
    // media plane repairing itself under a seat that never moved: the row is
    // ours, the heartbeat keeps it, and the people on the far side hear a
    // pause, not a hang-up. Reading it as "connecting" made every consumer of
    // the phase (the desktop's in-huddle report, the seated room the knocks
    // and the auto-scribe watch, the surface lookups) say the call had ended
    // and then that it had begun again. Only a `Disconnected` that livekit
    // gave up on ends it, above.
    r.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
      const call = useInboxStore.getState().call;
      if (call.roomKey !== roomKey) return;
      if (state === ConnectionState.Connected && call.phase !== "connected") {
        setCall({ phase: "connected" });
      }
    });

    // The handshake, unless it already happened. A warm room arrives connected,
    // so this is the whole of what a prewarm buys and the reason it is worth
    // holding one: the join goes straight from here to publishing a microphone.
    if (conn) {
      await r.connect(conn.url, conn.token);
      if (superseded(r)) return;
    } else {
      // THE TRACKS THAT ARRIVED BEFORE ANYBODY WAS LISTENING.
      //
      // A warm room was connected long before the handlers above existed, and
      // RoomEvent.TrackSubscribed fires ONCE, at subscription time. So a voice
      // that started while the room was still a prewarm has already been
      // subscribed with no listener to hear it, and `attachAudio` never ran for
      // it — leaving a client that is connected, subscribed, and completely
      // silent, with nothing in its state to say so.
      //
      // Measured on the rig: adopting a warm room after the far side began
      // publishing gave 0 audio elements against a subscribed track. The
      // ordinary path only escaped it by 25ms.
      for (const p of r.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          if (pub.isSubscribed && pub.track) attachAudio(pub.track as RemoteTrack, p.identity);
        }
      }
    }
    // Publish the mic in the muted state the user chose — join is silent by
    // default (the shoulder-tap contract), one keypress to speak.
    const muted = useInboxStore.getState().call.muted;
    const given = opts?.micTrack;
    // A WARM ROOM ARRIVES ALREADY HOLDING A MICROPHONE, muted, published and
    // negotiated by the far side before anybody pressed — which is the whole
    // point of it, and the reason a press is now an unmute rather than a
    // publish. So there is nothing to publish here, and publishing anyway
    // would put two copies of one person's voice in the room.
    //
    // A track the caller handed over is redundant in that case and must be
    // STOPPED rather than dropped: `startBurst` clones the shared device for
    // this hand-off, and a clone nobody stops is a capture nobody closes.
    if (r && warmRoomPublishesMic(r)) {
      if (given) {
        try {
          given.stop();
        } catch {}
      }
      await openMicForJoin(r.localParticipant, { intent: opts?.intent });
    } else if (given && given.readyState === "live") {
      await r.localParticipant.publishTrack(given, { source: Track.Source.Microphone });
      if (superseded(r)) return;
      // The publication now answers to setMicrophoneEnabled like any other, so
      // the mute the user chose applies to it unchanged.
      if (muted) await r.localParticipant.setMicrophoneEnabled(false);
    } else {
      // The one call in this function that opens a device, and the one that
      // may fail without failing the join.
      await openMicForJoin(r.localParticipant, { intent: opts?.intent });
    }
    if (superseded(r)) return;
    // The bookkeeping catches up here, and a refusal is still this join's
    // failure — it falls to the catch below, which frees the row and tears the
    // media down exactly as it always did.
    await seated;
    if (seatError) throw seatError;
    if (superseded(r)) return;
    startLevelMeter();
    setCall({ phase: "connected" });
    soundCallJoin();
    startHeartbeat(roomKey);
    rebuildTiles();
    // The camera can only be applied after connecting: it publishes a track.
    // Not for a handoff, which carries its own camera state across the window
    // boundary and must not have it overwritten by a preference.
    if (opts?.intent === "deliberate" && prefs.cameraOn) await setCamera(true);
  } catch (err: any) {
    // A superseded continuation's failure is not this call's failure.
    if (gen !== callGen) {
      if (r && r !== room) void r.disconnect();
      return;
    }
    teardownMedia();
    const message =
      err?.name === "NotAllowedError"
        ? "Microphone permission denied"
        : humanizeConvexError(err, "Could not join the huddle");
    setCall({ phase: "error", error: message });
    // Free the control-plane row so occupancy doesn't show a ghost.
    convex?.mutation(api.calls.leaveRoom, { room_key: roomKey }).catch(() => {});
  }
}

// ── handing the call to another window of my own ──────────────────────────
//
// A call belongs to ONE renderer at a time, because the media does: the Room,
// the mic publication and the audio elements are all module singletons here.
// Popping the call out into its own desktop window therefore has to MOVE it,
// and the move needs a signal both windows agree on.
//
// The signal comes free from the media plane. `mintAccessToken` signs the
// LiveKit identity as the user id, so a second window of mine joining the same
// room is a duplicate identity, and the SFU evicts the older participant with
// DisconnectReason.DUPLICATE_IDENTITY. That gives the exact ordering the
// handoff wants and gives it in the right order: the new window is CONNECTED
// before the old one is told to stand down, so the audio never has a hole in
// the middle of it.
//
// The control plane deliberately takes no part. `call_members` is keyed by
// (user, room), so both windows share ONE row: `joinRoom` for a room I am
// already in just refreshes it. That is why the yield below must not call
// `leaveRoom` — the seat it would free is the seat the OTHER window is now
// sitting in, and freeing it would leave that window in the room with no
// occupancy, no heartbeat and no transcript authorization.

// Set by a window whose disappearance is a HANDOFF rather than a hang-up (the
// call panel, whose closing hands the call back to the main window). It is
// declared while the window lives, not at unload: the beforeunload hook below
// runs before any listener a page registers later, so a flag set at unload time
// would be set too late to be read.
let callOutlivesWindow = false;

export function setCallOutlivesWindow(on: boolean): void {
  callOutlivesWindow = on;
}

// Release the room without ending the call: no leave sound (nothing ended),
// no `leaveRoom` (the seat moved, it did not empty) and no error state (this
// is the plan working). The scribe's local pipes close, but the transcript
// stays live on the server so the window taking over rejoins the same run.
async function yieldRoomToOtherWindow(): Promise<void> {
  callGen++;
  deliberateRoomKey = null;
  walkieJoinedSeat = null;
  callOutlivesWindow = false;
  await stopScribe({ keepLive: true });
  teardownMedia();
  setCall({
    phase: "idle",
    roomKey: null,
    speaking: [],
    camera: false,
    sharing: false,
    error: null, errorFix: null,
    muted: true,
  });
}

/** `roomKey`: the seat the card shows, for when this engine holds none of
 *  its own (a reloaded window whose row on the server outlived it): the row
 *  is what everyone else sees, so End must be able to delete it regardless. */
export async function leaveCall(roomKey?: string): Promise<void> {
  if (voiceHostElsewhere() && !currentRoomKey && (await sendVoiceCommand("leaveCall", roomKey ? [roomKey] : []))) return;
  return leaveCallHere(roomKey);
}

async function leaveCallHere(shown?: string): Promise<void> {
  const roomKey = currentRoomKey ?? useInboxStore.getState().call.roomKey ?? shown ?? null;
  callGen++;
  deliberateRoomKey = null;
  walkieJoinedSeat = null;
  // THE SEAT GOES FIRST. Hanging up is a fact about the person, and the row is
  // how everyone else learns it; the scribe's local teardown below is this
  // client's own housekeeping and can take a second or more to settle. Sent
  // ahead of it, so a teammate's row of faces drops ours the moment we press
  // End rather than after our pipes close.
  //
  // Hanging up releases our scribe run but never ENDS the transcript: the
  // huddle may go on without us, and the people still in it are the record.
  // Somebody seated adopts the run (transcripts.start, via auto-scribe) once
  // our seat lease is gone; if we were the last one out, `leaveRoom` ends it
  // server-side the moment the room empties, and the orphan sweep backstops a
  // tab that never got to say goodbye.
  const left =
    convex && roomKey
      ? convex.mutation(api.calls.leaveRoom, { room_key: roomKey }).catch(() => {})
      : null;
  // Idle first, then the scribe flush and media teardown: waiting on the flush left the row live for seconds after End.
  setCall({
    phase: "idle",
    roomKey: null,
    speaking: [],
    camera: false,
    sharing: false,
    error: null, errorFix: null,
    muted: true,
    micDenied: false,
  });
  soundCallLeave();
  await stopScribe({ keepLive: true });
  teardownMedia();
  if (left) await left;
}

/**
 * Take a call over from another window of mine — the receiving half of the
 * handoff above.
 *
 * A DELIBERATE join: no ring (I am already in this room, the seat is mine) and
 * no shoulder-tap mute, because the mic state is not a fresh decision here. It
 * is the state I was already in one window ago, handed across so that popping
 * the call out mid-sentence does not silence me. `muted` is written to the
 * store BEFORE joining, which is what makes `controlJoin` record it and the mic
 * publish honor it — the same order `startHuddle` uses for its unmuted join.
 *
 * The camera can only be applied after connecting: it publishes a track.
 */
export async function takeOverCall(opts: {
  roomKey: string;
  mic: boolean;
  camera: boolean;
  scribe?: boolean;
}): Promise<void> {
  setCall({ muted: !opts.mic });
  await joinCall(opts.roomKey);
  if (useInboxStore.getState().call.phase !== "connected") return;
  // Carried across the window, not chosen again — a camera a walkie burst
  // opened must not become the person's standing preference by being handed off.
  if (opts.camera) await setCamera(true, { remember: false });
  // The scribe follows the call. It resumes into the SAME transcript rather
  // than forking one — `transcripts.start` is idempotent per room — so the
  // words carry straight across the window boundary and the record has no seam
  // where a window happened to change.
  if (opts.scribe && convex && room) {
    await startScribe({ convex, room, roomKey: opts.roomKey, routes: [] }).catch(() => {});
  }
}

/**
 * `remember: false` changes the microphone WITHOUT changing what the person
 * chose for calls — the walkie opening a burst, a snooze closing a listen, a
 * join applying the remembered choice. Everything else is a person pressing
 * Mute or Unmute, and the NEXT deliberate join starts the way this one ended,
 * exactly as `setCamera` does for the camera.
 */
export async function setMuted(muted: boolean, opts?: { remember?: boolean }): Promise<void> {
  if (voiceHostElsewhere() && !room && (await sendVoiceCommand("setMuted", [muted, opts ?? {}]))) return;
  return setMutedHere(muted, opts);
}

async function setMutedHere(muted: boolean, opts?: { remember?: boolean }): Promise<void> {
  setCall({ muted });
  if (opts?.remember !== false) rememberMic(!muted);
  if (room) {
    try {
      await room.localParticipant.setMicrophoneEnabled(!muted);
    } catch (err: any) {
      // The same rule as a join's: a microphone that will not open leaves the
      // seat intact and says why. This is the path "Join live" takes into a
      // room it is already sitting in (applyDeliberateJoin), so a person who
      // steps into a burst with the microphone refused still gets the call —
      // subscribe-only, and told so.
      setCall({ muted: true, micDenied: true, error: await mediaFailureReason("microphone", err), errorFix: "microphone" });
      return;
    }
    // Only UNMUTING can clear it. Muting a seat that has no microphone
    // succeeds trivially — there is nothing to turn off — and reading that as
    // "the device works now" would erase a denial nobody has fixed.
    if (!muted) setCall({ micDenied: false });
  }
  pushFlags();
}

/**
 * `remember: false` publishes the camera WITHOUT changing what the person
 * chose for calls. The walkie is the caller: holding the key shows your own
 * face for the length of the burst, and a hold is not a decision about how
 * your next huddle should start. Everything else about the publication is
 * identical, so there is one path that opens a camera and not two.
 */
export async function setCamera(on: boolean, opts?: { remember?: boolean }): Promise<void> {
  if (voiceHostElsewhere() && !room && (await sendVoiceCommand("setCamera", [on, opts ?? {}]))) return;
  return setCameraHere(on, opts);
}

async function setCameraHere(on: boolean, opts?: { remember?: boolean }): Promise<void> {
  setCall({ camera: on });
  // The next deliberate join starts the way this call ends. Written on the
  // INTENT rather than on the outcome below, because a camera that failed to
  // open is still a person who wanted it open. The involuntary paths — a
  // camera yanked by a device change, a track unpublished by the browser —
  // patch `call.camera` directly and never reach here, so nothing the person
  // did not choose can rewrite the preference.
  if (opts?.remember !== false) rememberCamera(on);
  if (room) {
    try {
      const pub = await room.localParticipant.setCameraEnabled(on);
      // Reconcile to what actually happened: enabling can resolve without a
      // publication (no camera, permission denied) and the button must not
      // sit lit over a black tile.
      const live = on ? !!pub?.track && !pub.isMuted : false;
      setCall({ camera: live });
      if (on && !live) setCall({ error: await mediaFailureReason("camera"), errorFix: "camera" });
    } catch (err: any) {
      setCall({ camera: false, error: await mediaFailureReason("camera", err), errorFix: "camera" });
      return;
    }
    rebuildTiles();
  }
  pushFlags();
}

// `sourceId` is a desktop-only pre-selection from the web-owned picker
// (window.__CODECAST_ELECTRON__.getDisplaySources); the shell honors it for
// the very next getDisplayMedia. Browsers ignore it and show their own picker.
export async function setScreenShare(on: boolean, sourceId?: string): Promise<void> {
  // On the desktop a denied Screen Recording permission makes the capture
  // resolve to a black frame rather than fail, so it is checked up front:
  // the notice names the fix instead of publishing nothing.
  if (on && isElectron()) {
    await refreshOsPermissions().catch(() => {});
    const screen = peekOsPermissions().screen;
    if (screen === "off") {
      setCall({ sharing: false, error: permissionHint("screen", screen), errorFix: "screen" });
      return;
    }
  }
  setCall({ sharing: on });
  if (room) {
    try {
      if (on && sourceId) {
        await window.__CODECAST_ELECTRON__?.selectDisplaySource?.(sourceId);
      }
      // audio:false — a huddle shares the screen, not system audio (which
      // Chrome only offers for tabs anyway and doubles the mic path).
      // Capture/encoding for a share of UI: see livekitMedia.ts. Encoding is
      // passed here as well as on the Room so a huddle that joined before
      // those defaults existed still publishes a sharp share.
      const pub = await room.localParticipant.setScreenShareEnabled(
        on,
        on ? SCREEN_SHARE_CAPTURE : { audio: false },
        on
          ? { screenShareEncoding: SCREEN_SHARE_ENCODING, degradationPreference: "maintain-resolution" }
          : undefined,
      );
      const live = on ? !!pub?.track : false;
      setCall({ sharing: live });
    } catch (err: any) {
      // The picker was cancelled or the platform refused: quietly not shared,
      // never an error banner. Electron surfaces its own denial as
      // NotAllowedError when the display-media handler yields no source.
      setCall({ sharing: false });
      if (err?.name === "NotAllowedError" && !/cancel|abort/i.test(String(err?.message))) {
        setCall({ error: "Screen sharing not permitted", errorFix: "screen" });
      }
      return;
    }
    rebuildTiles();
  }
  pushFlags();
}

// Flag changes ride the next heartbeat anyway; this pushes them immediately
// so occupancy chips track mute/camera in ~1 RTT instead of 15s.
function pushFlags() {
  const { call } = useInboxStore.getState();
  if (!convex || !call.roomKey) return;
  convex
    .mutation(api.calls.heartbeat, {
      room_key: call.roomKey,
      muted: call.muted,
      camera: call.camera,
      sharing: call.sharing,
      languages: localTranscribeLanguages(),
    })
    .catch(() => {});
}

// The live Room, for modules that compose on the media plane (transcription
// taps its audio tracks). Null when no call is up.
export function getRoom(): Room | null {
  return room;
}

/** How many voices are actually attached to the page.
 *
 *  The one honest measure of "can this person hear the room": connected and
 *  subscribed say the media arrived, and a rig proved those can both be true
 *  while the count here is zero and nobody hears anything. Exported for the
 *  test that pins that case, and for a console checking the same thing by
 *  hand. */
export function getAudioElementCount(): number {
  return audioEls.size;
}

/** The attach path itself, for the test that proves it is idempotent — a track
 *  reaching it twice must not play the voice twice. */
export function __attachAudioForTest(track: RemoteTrack, participantId: string): void {
  attachAudio(track, participantId);
}

export async function switchDevice(
  kind: "audioinput" | "audiooutput" | "videoinput",
  deviceId: string,
): Promise<void> {
  // Chosen once, applied from now on. This is the write half of "devices
  // remembered" — the read half is the Room's capture defaults above. It is
  // written BEFORE the switch and whether or not a call is live, because the
  // call settings panel offers the same picker with no room to switch: the
  // choice is the person's either way, and the next join reads it.
  if (kind !== "audiooutput") rememberDevice(kind, deviceId);
  if (!room) return;
  try {
    await room.switchActiveDevice(kind, deviceId);
  } catch {}
}

// ── ringing ───────────────────────────────────────────────────────────────

// Ring people into a room, joining it yourself first (the caller waits
// inside — answering drops each callee straight into a live room). One or
// many recipients: a 1:1 from the avatar bar and a group start from the
// picker are the same call with a longer list. The caller's mic goes LIVE:
// clicking "huddle at someone" is the intent to talk, so they are speaking
// the moment anyone answers (joining an existing room stays muted — the
// shoulder-tap contract — this is the one deliberate exception).
export async function startHuddle(opts: {
  roomKey: string;
  toUserIds: string[];
  anchorTitle?: string;
  ringChannel?: boolean;
}): Promise<void> {
  if (voiceHostElsewhere() && (await sendVoiceCommand("startHuddle", [opts]))) return;
  return startHuddleHere(opts);
}

async function startHuddleHere(opts: {
  roomKey: string;
  toUserIds: string[];
  anchorTitle?: string;
  ringChannel?: boolean;
}): Promise<void> {
  if (huddleInOtherWindow() && await focusExistingHuddle()) return;
  if (!convex) return;
  setCall({ phase: "ringing_out" as const, roomKey: opts.roomKey, error: null, errorFix: null, muted: !readJoinPrefs().micOn });
  // The ring is on the row from the press: the join takes a second, and the
  // invite goes out only after it, so the stub rings stand from here until
  // ringInto settles them (or the join fails and they are taken back).
  ringStubs(opts.roomKey, opts.toUserIds, true);
  try {
    await joinCall(opts.roomKey, { intent: "deliberate" });
    if (useInboxStore.getState().call.phase !== "connected") {
      ringStubs(opts.roomKey, opts.toUserIds, false);
      return;
    }
    await ringInto(opts.roomKey, opts.toUserIds, opts.anchorTitle, { ringChannel: opts.ringChannel });
  } catch (err: any) {
    ringStubs(opts.roomKey, opts.toUserIds, false);
    setCall({ phase: "error", error: humanizeConvexError(err, "Could not start the huddle") });
  }
}

export type RingOutcome = {
  to_user: string;
  busy: boolean;
  cooldown: boolean;
  in_room?: boolean;
  refused?: string;
};

// Ring people into a room you are already in ("add people"). The ring is
// their grant: a teammate outside the room's anchor may answer it while the
// huddle runs. Ringing/declined state arrives through myCalls.outgoing; the
// outcomes that DON'T ring (cooldown, refused) surface as toasts here, so
// every entry point — group start, chat header, add people — tells the
// caller who was not rung and why.
export async function ringInto(
  roomKey: string,
  toUserIds: string[],
  anchorTitle?: string,
  opts?: { failMessage?: string; ringChannel?: boolean },
): Promise<RingOutcome[]> {
  if (!convex || (toUserIds.length === 0 && !opts?.ringChannel)) return [];
  // The ring is on the row from the press. startHuddle seats the caller
  // first, so until the invite's round trip lands the row would read a live
  // call with nobody on it: an End that turns into a Cancel. A stub ring per
  // person fills that window. A rung person's stub stays until the server's
  // own list replaces it (the push lands a tick after the mutation resolves,
  // and taking the stub back first reads online in between); a person the
  // server did not ring loses theirs when the answer comes.
  ringStubs(roomKey, toUserIds, true);
  try {
    const res = await convex.mutation(api.calls.invite, {
      room_key: roomKey,
      to_users: toUserIds,
      anchor_title: anchorTitle,
      ring_channel: opts?.ringChannel,
    });
    const results: RingOutcome[] = res?.results ?? [];
    const rung = new Set(results.filter((r) => !(r.in_room || r.cooldown || r.refused)).map((r) => String(r.to_user)));
    ringStubs(roomKey, toUserIds.filter((id) => !rung.has(id)), false);
    reportRingOutcomes(results);
    return results;
  } catch (err: any) {
    ringStubs(roomKey, toUserIds, false);
    toast.error(humanizeConvexError(err, opts?.failMessage ?? "Could not ring them"));
    return [];
  }
}

/** Put up (or withdraw) a stub ring per person in myCalls.outgoing while the
 *  invite is in flight (lib/calls/ringStubs). A person the server's own list
 *  already shows ringing gets no stub. A person with a stub gets it again
 *  with a fresh clock: startHuddle stubs at the press and ringInto stubs
 *  again once the join lands, and a join that outlived the first clock would
 *  otherwise leave the stub to expire inside the invite's round trip (the
 *  face reads online, then ringing again when the row lands). A withdrawal
 *  expires the stub's clock, and the list's merge drops it. */
function ringStubs(roomKey: string, toUserIds: string[], on: boolean): void {
  const st = useInboxStore.getState();
  const cur = st.myCalls ?? { incoming: [], outgoing: [], membership: null };
  const outgoing: any[] = cur.outgoing ?? [];
  const now = Date.now();
  let next: any[];
  if (on) {
    const members = st.teamMembers ?? [];
    const listed = (id: string) =>
      outgoing.some((r) => !isRingStub(r) && String(r.to_user) === id && r.room_key === roomKey && (r.status ?? "ringing") === "ringing");
    const stubs: RingStub[] = toUserIds.filter((id) => !listed(id)).map((id) => ({
      _id: ringStubId(roomKey, id),
      room_key: roomKey,
      to_user: id,
      to_name: memberDisplayName(members.find((m: any) => String(m._id) === id), "Teammate"),
      status: "ringing",
      created_at: now,
      until: now + RING_STUB_MS,
    }));
    if (!stubs.length) return;
    const ids = new Set(stubs.map((s) => s._id));
    next = [...outgoing.filter((r) => !ids.has(String(r._id))), ...stubs];
  } else {
    const ids = new Set(toUserIds.map((id) => ringStubId(roomKey, id)));
    if (!outgoing.some((r) => ids.has(String(r._id)))) return;
    next = outgoing.map((r) => (ids.has(String(r._id)) ? { ...r, until: 0 } : r));
  }
  st.syncTable("myCalls", { ...cur, outgoing: next });
}

// The outcomes worth a sentence. Busy rings quietly and shows as ringing;
// in_room needs no news (they are already here); cooldown and refused mean
// "not rung", which a caller who just promised to ring N people must hear.
function reportRingOutcomes(results: RingOutcome[]): void {
  const members = useInboxStore.getState().teamMembers ?? [];
  const nameOf = (id: string) =>
    memberDisplayName(members.find((m: any) => String(m._id) === id), "A teammate");
  for (const r of results) {
    if (r.refused) toast.error(`${nameOf(r.to_user)} can't be rung`, { description: "They aren't on this huddle's team." });
    else if (r.cooldown) toast(`${nameOf(r.to_user)} declined a moment ago`, { description: "Try again in a minute." });
  }
}

// May we still enter this room, and is anyone actually in it? Occupancy
// answers both at once: getRoomOccupancy returns a key only for a room the
// caller may join, and only while someone live is in it.
async function roomStillLive(roomKey: string): Promise<boolean> {
  if (!convex) return false;
  const live = await convex
    .query(api.calls.getRoomOccupancy, { room_keys: [roomKey] })
    .catch(() => null);
  return !!(live as any)?.[roomKey]?.length;
}

export async function acceptInvite(inviteId: string, roomKey: string): Promise<void> {
  if (voiceHostElsewhere() && (await sendVoiceCommand("acceptInvite", [inviteId, roomKey]))) return;
  return acceptInviteHere(inviteId, roomKey);
}

async function acceptInviteHere(inviteId: string, roomKey: string): Promise<void> {
  if (huddleInOtherWindow() && await focusExistingHuddle()) return;
  if (!convex) return;
  // Local-first: the dock paints "connecting" the instant Join is clicked;
  // the accept round-trip and the media join settle after. Accepting while in
  // ANOTHER live call must not destroy that call on failure — remember it and
  // restore it if the ring is expired, instead of painting an error over a
  // still-flowing call (which also kills its heartbeat gate).
  const prior = useInboxStore.getState().call;
  const switching =
    prior.roomKey !== roomKey &&
    (prior.phase === "connected" || prior.phase === "connecting");
  // Not over a seat already taken in this very room: a ring answered while
  // auto-listening to the caller's burst joins nothing (joinCall treats it as
  // an intent), so a "connecting" painted here would never be painted over.
  const seated = prior.roomKey === roomKey && prior.phase === "connected";
  if (!seated) setCall({ phase: "connecting", roomKey, error: null, errorFix: null, speaking: [] });
  try {
    const res = await convex.mutation(api.calls.respondInvite, {
      invite_id: inviteId,
      accept: true,
    });
    // A ring always outlives its invite: the ring's clock starts when the
    // invite REACHES the callee, the invite's when the server wrote it, so the
    // last seconds of every ring answer an already-expired invite. Failing
    // there is wrong twice over — the call was still ringing, and the caller
    // is usually still in the room waiting. Answer late and you join anyway
    // whenever the call is genuinely still going; only an empty room ends it.
    if (res?.expired && !(await roomStillLive(roomKey))) {
      if (switching) setCall({ ...prior });
      else setCall({ phase: "error", error: "That call already ended" });
      return;
    }
    // Release the old seat immediately — joinCall tears down its media, but
    // only leaveRoom frees the lease before the 45s sweep.
    if (switching && prior.roomKey) {
      convex.mutation(api.calls.leaveRoom, { room_key: prior.roomKey }).catch(() => {});
    }
    // Join the room the server ACCEPTED: a re-ring can move an invite to a
    // new room after the toast captured the old key. Answering a ring is the
    // most deliberate join there is — somebody called and they picked up — so
    // the mic opens and the camera comes back the way they left it.
    await joinCall(res?.room_key ?? roomKey, { intent: "deliberate" });
  } catch (err: any) {
    if (switching) setCall({ ...prior });
    else setCall({ phase: "error", error: humanizeConvexError(err, "Could not join the huddle") });
  }
}

export async function declineInvite(inviteId: string): Promise<void> {
  if (!convex) return;
  await convex
    .mutation(api.calls.respondInvite, { invite_id: inviteId, accept: false })
    .catch(() => {});
}

export async function cancelOutgoing(inviteId: string): Promise<void> {
  // A stub (the invite still in flight) has nothing to cancel yet.
  if (!convex || inviteId.startsWith(RING_STUB)) return;
  await convex.mutation(api.calls.cancelInvite, { invite_id: inviteId }).catch(() => {});
}

// ── The locked door ───────────────────────────────────────────────────────
// A huddle is an open room by default; a lock is the exception, and knocking
// is how someone outside asks for it to be lifted for them. Admitting is not

// Every huddle transcribes; the server decides which seated client scribes
// (transcripts.start). Three ways in, one engine: the auto path a connected
// window takes on its own, the manual toggle, and "stop" — which is written
// on the ROOM (calls.setRoomTranscribeOff) so the next client to look does
// not start it straight back up.

export function isDeliberateRoom(roomKey: string | null): boolean {
  return !!roomKey && deliberateRoomKey === roomKey;
}

let autoScribeInFlight: Promise<unknown> | null = null;

/** Ask to scribe the room this window is connected to. Idempotent and quiet:
 *  the server answers observer/off with no pipes opened, and a refusal is
 *  not this window's news (the huddle works without a transcript). */
export function autoScribe(roomKey: string): void {
  if (!convex || !room || currentRoomKey !== roomKey || autoScribeInFlight) return;
  autoScribeInFlight = startScribe({ convex, room, roomKey, routes: [], auto: true })
    .catch(() => false)
    .finally(() => {
      autoScribeInFlight = null;
    });
}

/** The manual Transcribe toggle (and "feed an agent", which needs words):
 *  reopens the room's opt-out, then scribes. */
export async function startTranscribing(
  roomKey: string,
  routes: Array<{ kind: "session" | "doc" | "slack"; target: string; mode: "live" | "after" }> = [],
): Promise<boolean> {
  if (!convex || !room) return false;
  await convex.mutation(api.calls.setRoomTranscribeOff, { room_key: roomKey, off: false }).catch(() => {});
  return await startScribe({ convex, room, roomKey, routes });
}

/** "Stop transcribing", for the whole huddle: the room opts out first, so no
 *  seated client's auto-scribe restarts it, then this run ends — which posts
 *  the digest of what was said so far. */
export async function stopTranscribing(roomKey: string): Promise<void> {
  if (convex) {
    await convex.mutation(api.calls.setRoomTranscribeOff, { room_key: roomKey, off: true }).catch(() => {});
  }
  await stopScribe();
}

export async function setRoomLock(roomKey: string, locked: boolean): Promise<void> {
  if (!convex) return;
  const store = useInboxStore.getState();
  store.noteLockPending(roomKey, locked);
  try {
    await convex.mutation(api.calls.setRoomLocked, { room_key: roomKey, locked });
  } catch (err: any) {
    store.revertLockPending(roomKey, !locked);
    toast.error(humanizeConvexError(err, "Could not change the lock"));
  }
}

// Knock at a locked room. The row paints "knocked" immediately; when someone
// inside admits, their ring arrives and useCallRing answers it for us — a
// door you knocked on does not ask you to answer it.
export async function knockRoom(roomKey: string): Promise<void> {
  if (huddleInOtherWindow() && await focusExistingHuddle()) return;
  if (!convex) return;
  const store = useInboxStore.getState();
  store.noteKnock(roomKey);
  try {
    await convex.mutation(api.calls.knock, { room_key: roomKey });
  } catch (err: any) {
    store.clearKnock(roomKey);
    toast.error(humanizeConvexError(err, "Could not knock"));
  }
}

// Let a knocker in: ring them into the room. The ring IS the grant, so this
// works while the door stays locked to everyone else — and their client
// answers it by itself, since they asked for this door.
//
// The authority to widen a room is MEMBERSHIP, not a seat (calls.invite): a
// teammate who walked in through the open door can lock the room but cannot
// admit into it. That refusal gets its own words rather than the ring's.
export async function admitKnock(roomKey: string, userId: string): Promise<void> {
  await ringInto(roomKey, [userId], undefined, {
    failMessage: "Could not let them in — only this room's own people can admit",
  });
}

/**
 * Host: carry out a call gesture another window sent (lib/calls/walkie's
 * `runVoiceCommand` hands the ones it does not own here). The same functions
 * the remote would have run, minus the forwarding they begin with.
 *
 * A deliberate join for a room OTHER than the one this host is already
 * talking in does what the remote's own join used to do when a huddle lived
 * in another window: it raises the huddle rather than switching rooms under
 * the person mid-sentence.
 */
export async function runCallCommand(cmd: string, args: unknown[]): Promise<void> {
  const a = args as any[];
  switch (cmd) {
    case "joinCall": {
      const roomKey = String(a[0]);
      const opts = (a[1] && typeof a[1] === "object" ? a[1] : {}) as JoinOpts;
      const call = useInboxStore.getState().call;
      const busy = call.roomKey && call.roomKey !== roomKey && (call.phase === "connected" || call.phase === "connecting");
      if (opts.intent === "deliberate" && busy && !opts.walkieJoin) {
        await showCallPanel();
        return;
      }
      return joinCallHere(roomKey, opts);
    }
    case "leaveCall":
      return leaveCallHere(typeof a[0] === "string" ? a[0] : undefined);
    case "setMuted":
      return setMutedHere(!!a[0], a[1] && typeof a[1] === "object" ? a[1] : undefined);
    case "setCamera":
      return setCameraHere(!!a[0], a[1] && typeof a[1] === "object" ? a[1] : undefined);
    case "startHuddle":
      return a[0] && typeof a[0] === "object" ? startHuddleHere(a[0]) : undefined;
    case "acceptInvite":
      return acceptInviteHere(String(a[0]), String(a[1]));
    default:
      return;
  }
}

// Over HTTP, not through the client. This used to write the mutation to the
// WebSocket, which is torn down before the frame leaves — measured while
// chasing the same bug one file over, and it meant this guard had never once
// done its job: every tab that died mid-call left its row for the lease to
// clear. See lib/keepaliveMutation.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    // `callOutlivesWindow` is the call panel closing on purpose: the seat is
    // shared with the window taking the call back, so freeing it here would
    // evict the window that is mid-join. The row is not ours alone to drop.
    if (currentRoomKey && !callOutlivesWindow) {
      mutateOnUnload(api.calls.leaveRoom, { room_key: currentRoomKey });
    }
  });
}

// Dev console access, mirroring window.__inboxStore: inspect the live Room,
// tiles and mic level from the browser console / a verification harness
// without a second module instance (a dynamic import() of this file resolves
// to a DIFFERENT instance whose Room is null — see the __inboxStore note).
if (typeof window !== "undefined" && import.meta.env.DEV) {
  (window as any).__callManager = {
    room: () => room,
    tiles: getCallTiles,
    micLevel: getMicLevel,
    rebuildTiles,
    bound: () => !!convex,
    convexHandle: () => convex,
    // Actions exposed for dev-console driving and e2e harnesses: a dynamic
    // import() of this file creates a SECOND module instance whose room/convex
    // are null, so a harness must reach the app's instance through here.
    joinCall,
    leaveCall,
    takeOverCall,
    startTranscribing,
    stopTranscribing,
    setMuted,
    setCamera,
    setScreenShare,
    startHuddle,
    ringInto,
  };
}

// Editing this file mid call reloads the window on purpose. The room lives in
// this module's state, and a hot swap hands every caller a fresh instance
// with no room while the old one stays connected: End then did nothing and
// the float stayed up over the founder's screen (2026-09-23). A reload drops
// the call honestly instead of leaving a call nobody can end.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
