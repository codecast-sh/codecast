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
import { startScribe, stopScribe } from "./transcription";
import { micConstraints, readJoinPrefs, rememberCamera, rememberDevice } from "./joinPrefs";
import { bindPrewarmAudio, bindPrewarmConvex, takePrewarmedRoom, warmRoomPublishesMic } from "./roomPrewarm";
import { CALL_HEARTBEAT_MS, humanizeConvexError } from "@codecast/shared/contracts";
import { hasCallPanel, isCallPanelWindow, isElectron } from "../desktop";
import { shouldYieldCallOnDisconnect } from "./callHandoff";
import { peekOsPermissions, permissionHint, refreshOsPermissions } from "../osPermissions";
import {
  soundCallJoin,
  soundCallLeave,
} from "../sounds";

type ConvexHandle = {
  mutation: (fn: any, args: any) => Promise<any>;
  action: (fn: any, args: any) => Promise<any>;
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

// ── track fan-out to React ────────────────────────────────────────────────
// One tile per VIDEO TRACK, not per participant: a person can have a camera
// and a screen share up at once and both must render, each in its own
// <video>. Keyed by track sid so a tile's identity is the track's identity —
// React never remounts a <video> because a sibling track appeared, and the
// snapshot always hands out a fresh object when a track is (re)published, so
// useSyncExternalStore consumers re-run their attach effects.
export type ParticipantTile = {
  key: string;
  identity: string;
  name: string;
  image?: string;
  isLocal: boolean;
  kind: "camera" | "screen";
  track: Track;
};

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

function participantImage(p: Participant): string | undefined {
  try {
    const meta = p.metadata ? JSON.parse(p.metadata) : null;
    return meta?.image ?? undefined;
  } catch {
    return undefined;
  }
}

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
    const { calculateVolume, cleanup } = createAudioAnalyser(track as any, {
      fftSize: 256,
      smoothingTimeConstant: 0.6,
    });
    levelCleanup = cleanup;
    levelTimer = setInterval(() => {
      // Muted → analyser reads silence anyway, but skip the work and pin 0 so
      // the meter reads honestly the instant the user mutes.
      const muted = useInboxStore.getState().call.muted;
      const v = muted ? 0 : Math.min(1, calculateVolume() * 4);
      if (Math.abs(v - micLevel) > 0.02 || (v === 0 && micLevel !== 0)) {
        micLevel = v;
        for (const cb of levelSubscribers) cb();
      }
    }, 50);
  } catch {}
}

// ── lifecycle ─────────────────────────────────────────────────────────────

async function controlJoin(roomKey: string, opts?: { walkieJoin?: boolean }) {
  if (!convex) throw new Error("calls not bound yet");
  await convex.mutation(api.calls.joinRoom, {
    room_key: roomKey,
    muted: useInboxStore.getState().call.muted,
    // Only ever true, never false: the stamp says a conversation started here
    // and nothing takes that back but leaving.
    ...(opts?.walkieJoin ? { walkie_join: true } : {}),
  });
}

function startHeartbeat(roomKey: string) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    const { call } = useInboxStore.getState();
    if (!convex || call.roomKey !== roomKey) return;
    convex
      .mutation(api.calls.heartbeat, {
        room_key: roomKey,
        muted: call.muted,
        camera: call.camera,
        sharing: call.sharing,
      })
      .then((res: any) => {
        // ok:false = the server lease-swept our row (laptop slept >45s while
        // livekit-client quietly reconnected the media). Re-take the seat so
        // occupancy matches the audible truth; if authorization now fails
        // (removed from team, session privatized), fall out of the call
        // entirely rather than haunting it.
        const cur = useInboxStore.getState().call;
        if (res?.ok === false && cur.roomKey === roomKey && cur.phase === "connected") {
          controlJoin(roomKey).catch(() => void leaveCall());
        }
      })
      .catch(() => {});
  }, CALL_HEARTBEAT_MS);
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

function teardownMedia() {
  stopHeartbeat();
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
  await setMuted(false);
  await controlJoin(roomKey, opts).catch(() => {});
  if (readJoinPrefs().cameraOn && !useInboxStore.getState().call.camera) {
    await setCamera(true);
  }
}
export async function joinCall(roomKey: string, opts?: JoinOpts): Promise<void> {
  if (!convex) return;
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
  if (opts?.intent === "deliberate") setCall({ muted: false });
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
    r = warm ?? new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: micConstraints(prefs.micDeviceId),
      videoCaptureDefaults: prefs.cameraDeviceId
        ? { deviceId: { ideal: prefs.cameraDeviceId } }
        : {},
    });
    room = r;
    currentRoomKey = roomKey;

    r.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      setCall({ speaking: speakers.map((s) => s.identity) });
    });
    r.on(RoomEvent.ParticipantConnected, () => {
      soundCallJoin();
      rebuildTiles();
    });
    r.on(RoomEvent.ParticipantDisconnected, () => {
      soundCallLeave();
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
    r.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
      const call = useInboxStore.getState().call;
      if (call.roomKey !== roomKey) return;
      if (state === ConnectionState.Connected && call.phase !== "connected") {
        setCall({ phase: "connected" });
      } else if (state === ConnectionState.Reconnecting) {
        setCall({ phase: "connecting" });
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

export async function leaveCall(): Promise<void> {
  const roomKey = currentRoomKey ?? useInboxStore.getState().call.roomKey;
  callGen++;
  deliberateRoomKey = null;
  // Hanging up releases our scribe run but never ENDS the transcript: the
  // huddle may go on without us, and the people still in it are the record.
  // Somebody seated adopts the run (transcripts.start, via auto-scribe) once
  // our seat lease is gone; if we were the last one out, `leaveRoom` below
  // ends it server-side the moment the room empties, and the orphan sweep
  // backstops a tab that never got to say goodbye.
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
    micDenied: false,
  });
  soundCallLeave();
  if (convex && roomKey) {
    await convex.mutation(api.calls.leaveRoom, { room_key: roomKey }).catch(() => {});
  }
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
  if (opts.camera) await setCamera(true);
  // The scribe follows the call. It resumes into the SAME transcript rather
  // than forking one — `transcripts.start` is idempotent per room — so the
  // words carry straight across the window boundary and the record has no seam
  // where a window happened to change.
  if (opts.scribe && convex && room) {
    await startScribe({ convex, room, roomKey: opts.roomKey, routes: [] }).catch(() => {});
  }
}

export async function setMuted(muted: boolean): Promise<void> {
  setCall({ muted });
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

// Why did capture fail? livekit resolves null (no throw) when getUserMedia
// yields nothing, and the OS permission state tells the cases apart: a
// denial (System Settings on the desktop, a site setting in a browser)
// versus a machine with no such device. The message is the fix, phrased for
// the person holding the mouse; the notice that shows it carries the fix
// button (`call.errorFix`).
export async function mediaFailureReason(kind: "camera" | "microphone", err?: any): Promise<string> {
  const label = kind === "camera" ? "Camera" : "Microphone";
  if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError") {
    return `No ${kind} found`;
  }
  await refreshOsPermissions().catch(() => {});
  const hint = permissionHint(kind, peekOsPermissions()[kind]);
  if (hint) return hint;
  return err?.name === "NotAllowedError" ? `${label} permission denied` : `${label} unavailable`;
}

export async function setCamera(on: boolean): Promise<void> {
  setCall({ camera: on });
  // The next deliberate join starts the way this call ends. Written on the
  // INTENT rather than on the outcome below, because a camera that failed to
  // open is still a person who wanted it open. The involuntary paths — a
  // camera yanked by a device change, a track unpublished by the browser —
  // patch `call.camera` directly and never reach here, so nothing the person
  // did not choose can rewrite the preference.
  rememberCamera(on);
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
      const pub = await room.localParticipant.setScreenShareEnabled(on, { audio: false });
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

export async function listDevices(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
  try {
    return await Room.getLocalDevices(kind);
  } catch {
    return [];
  }
}

export async function switchDevice(
  kind: "audioinput" | "audiooutput" | "videoinput",
  deviceId: string,
): Promise<void> {
  if (!room) return;
  try {
    await room.switchActiveDevice(kind, deviceId);
    // Chosen once, applied from now on. This is the write half of "devices
    // remembered" — the read half is the Room's capture defaults above.
    if (kind !== "audiooutput") rememberDevice(kind, deviceId);
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
}): Promise<void> {
  if (!convex) return;
  setCall({ phase: "ringing_out" as const, roomKey: opts.roomKey, error: null, errorFix: null, muted: false });
  try {
    await joinCall(opts.roomKey, { intent: "deliberate" });
    if (useInboxStore.getState().call.phase !== "connected") return;
    await ringInto(opts.roomKey, opts.toUserIds, opts.anchorTitle);
  } catch (err: any) {
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
  opts?: { failMessage?: string },
): Promise<RingOutcome[]> {
  if (!convex || toUserIds.length === 0) return [];
  try {
    const res = await convex.mutation(api.calls.invite, {
      room_key: roomKey,
      to_users: toUserIds,
      anchor_title: anchorTitle,
    });
    const results: RingOutcome[] = res?.results ?? [];
    reportRingOutcomes(results);
    return results;
  } catch (err: any) {
    toast.error(humanizeConvexError(err, opts?.failMessage ?? "Could not ring them"));
    return [];
  }
}

// The outcomes worth a sentence. Busy rings quietly and shows as ringing;
// in_room needs no news (they are already here); cooldown and refused mean
// "not rung", which a caller who just promised to ring N people must hear.
function reportRingOutcomes(results: RingOutcome[]): void {
  const members = useInboxStore.getState().teamMembers ?? [];
  const nameOf = (id: string) =>
    memberDisplayName(members.find((m: any) => String(m._id) === id), "A teammate");
  for (const r of results) {
    if (r.refused) toast.error(`${nameOf(r.to_user)} isn't on this huddle's team, so they can't be rung`);
    else if (r.cooldown) toast(`${nameOf(r.to_user)} declined a moment ago — try again in a minute`);
  }
}

export async function acceptInvite(inviteId: string, roomKey: string): Promise<void> {
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
  setCall({ phase: "connecting", roomKey, error: null, errorFix: null, speaking: [] });
  try {
    const res = await convex.mutation(api.calls.respondInvite, {
      invite_id: inviteId,
      accept: true,
    });
    if (res?.expired) {
      if (switching) setCall({ ...prior });
      else setCall({ phase: "error", error: "That ring expired" });
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
  if (!convex) return;
  await convex.mutation(api.calls.cancelInvite, { invite_id: inviteId }).catch(() => {});
}

// ── The locked door ───────────────────────────────────────────────────────
// A huddle is an open room by default; a lock is the exception, and knocking
// is how someone outside asks for it to be lifted for them. Admitting is not
// new machinery — someone inside rings the knocker with the ordinary invite,
// and the accepted ring is their grant (see ringInto).

// Lock or unlock the room I'm in. Local-first: the glyph flips in this tick
// and callLockPending protects it until getLiveRooms echoes the same state.
// ── Transcription entry points ────────────────────────────────────────────
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

// Best-effort row cleanup when the tab dies mid-call; the 45s lease is the
// real guarantee, this just makes the common case instant.
//
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
