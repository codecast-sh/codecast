// Mobile media-plane owner — the RN sibling of web's lib/calls/callManager.
// One LiveKit Room lives here (module singleton, never React state); screens
// read the small snapshot via useSyncExternalStore and call these methods.
// The convex CONTROL PLANE is the same one web ships: joinRoom / heartbeat /
// leaveRoom / invite / respondInvite / mintAccessToken — mobile adds no
// server surface.
//
// RN differences from web, deliberately:
// - AudioSession: iOS needs an explicit AVAudioSession start before capture
//   and stop after (registerGlobals auto-configures the category).
// - No DOM <audio> pool — the native SDK plays subscribed audio itself.
// - No beforeunload — AppState is not a leave signal (backgrounding a call is
//   LEGITIMATE on a phone; the 45s server lease covers a killed app).
// - Camera flip and speakerphone toggle are first-class (phone ergonomics).
import { Room, RoomEvent, Track, ConnectionState } from "livekit-client";
import type { Participant, RemoteParticipant, LocalParticipant } from "livekit-client";
import { livekit, ensureLivekitGlobals, callsNativeAvailable } from "./livekitNative";

// AudioSession from the guarded native module (null on a binary that lacks it).
const AudioSession = livekit?.AudioSession ?? null;
export { callsNativeAvailable };
import { api } from "@codecast/convex/convex/_generated/api";
import { convex } from "../convex";
import { CALL_HEARTBEAT_MS, humanizeConvexError } from "@codecast/shared/contracts";

export type CallPhase = "idle" | "connecting" | "connected" | "error";

export type CallSnapshot = {
  phase: CallPhase;
  roomKey: string | null;
  muted: boolean;
  cameraOn: boolean;
  frontCamera: boolean;
  speakerOn: boolean;
  speaking: string[];
  error: string | null;
  /** A permission-gated toggle in flight (the OS dialog may be up): the UI
   *  shows an "asking…" look instead of flipping the label optimistically. */
  pending: "mic" | "camera" | null;
  /** Roster from the SFU (identity, name, flags) — the stage's truth. */
  participants: Array<{
    identity: string;
    name: string;
    isLocal: boolean;
    micMuted: boolean;
    hasCamera: boolean;
    hasScreen: boolean;
  }>;
};

const IDLE: CallSnapshot = {
  phase: "idle",
  roomKey: null,
  muted: true,
  cameraOn: false,
  frontCamera: true,
  speakerOn: true,
  speaking: [],
  error: null,
  pending: null,
  participants: [],
};

let snap: CallSnapshot = IDLE;
const subs = new Set<() => void>();
function emit(patch: Partial<CallSnapshot>) {
  snap = { ...snap, ...patch };
  for (const cb of subs) cb();
}
export function subscribeCall(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}
export function getCallSnapshot(): CallSnapshot {
  return snap;
}

let room: Room | null = null;
let currentRoomKey: string | null = null;
// True while CallKit (expo-callkit-telecom) owns the AVAudioSession for the
// live call — see JoinOpts.callKitManaged.
let callKitOwnsAudio = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
// Join/leave generation guard — same race web hit: a continuation that
// resumes after an await must abandon when a newer join/leave superseded it.
let callGen = 0;

export function getRoom(): Room | null {
  return room;
}

function rebuildParticipants() {
  if (!room) {
    emit({ participants: [] });
    return;
  }
  const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
  emit({
    participants: all.map((p) => {
      const mic = p.getTrackPublication(Track.Source.Microphone);
      const cam = p.getTrackPublication(Track.Source.Camera);
      const scr = p.getTrackPublication(Track.Source.ScreenShare);
      const subscribed = (pub: any) => !!pub && (p.isLocal || pub.isSubscribed) && !!pub.track;
      return {
        identity: p.identity,
        name: p.name || p.identity,
        isLocal: p === room!.localParticipant,
        micMuted: mic ? mic.isMuted : true,
        hasCamera: subscribed(cam) && !cam!.isMuted,
        hasScreen: subscribed(scr),
      };
    }),
  });
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat(roomKey: string) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (snap.roomKey !== roomKey) return;
    convex
      .mutation(api.calls.heartbeat, {
        room_key: roomKey,
        muted: snap.muted,
        camera: snap.cameraOn,
        sharing: false,
      })
      .then((res: any) => {
        // Lease swept while we were backgrounded/asleep: retake the seat, or
        // fall out honestly if authorization is gone.
        if (res?.ok === false && snap.roomKey === roomKey && snap.phase === "connected") {
          convex
            .mutation(api.calls.joinRoom, { room_key: roomKey, muted: snap.muted })
            .catch(() => void leaveCall());
        }
      })
      .catch(() => {});
  }, CALL_HEARTBEAT_MS);
}

async function teardownMedia() {
  stopHeartbeat();
  const gen = ++callGen;
  if (room) {
    room.removeAllListeners();
    try {
      await room.disconnect();
    } catch {}
    room = null;
  }
  currentRoomKey = null;
  // A join that started while we awaited disconnect owns the audio session
  // now — a trailing stop here would kill the NEW call's audio.
  if (gen === callGen && !callKitOwnsAudio) {
    try {
      await AudioSession?.stopAudioSession();
    } catch {}
  }
  callKitOwnsAudio = false;
  // Callers use this to detect whether they still own the call state: if a
  // newer join/leave bumped the gen during our awaits, their follow-up emit
  // would stomp it.
  return gen;
}

export type JoinOpts = {
  /** CallKit answered this call: it owns the AVAudioSession, so we must NOT
   *  start LiveKit's own (two owners = no audio). WebRTC's RTCAudioSession
   *  picks up CallKit's activation. */
  callKitManaged?: boolean;
};

export async function joinCall(roomKey: string, opts: JoinOpts = {}): Promise<void> {
  // The connecting-branch must also prove the live Room BELONGS to this key:
  // accepting a ring while connected elsewhere paints {connecting, roomKey:B}
  // while `room` is still call A's Room — without the currentRoomKey check
  // this guard would return and wedge "connecting…" forever.
  if (
    snap.roomKey === roomKey &&
    (snap.phase === "connected"
      ? currentRoomKey === roomKey
      : snap.phase === "connecting" && room !== null && currentRoomKey === roomKey)
  ) {
    return;
  }
  if (!callsNativeAvailable || !ensureLivekitGlobals()) {
    emit({
      phase: "error",
      roomKey,
      error: "Huddles need an app update — install the latest build to join.",
    });
    return;
  }
  if (room) await teardownMedia();
  const gen = ++callGen;
  const superseded = (r?: Room) => {
    if (gen === callGen) return false;
    if (r && r !== room) void r.disconnect();
    return true;
  };
  emit({
    phase: "connecting",
    roomKey,
    error: null,
    speaking: [],
    cameraOn: false,
    participants: [],
  });
  try {
    await convex.mutation(api.calls.joinRoom, { room_key: roomKey, muted: snap.muted });
    if (superseded()) return;
    const { url, token } = await convex.action(api.calls.mintAccessToken, { room_key: roomKey });
    if (superseded()) return;
    if (!opts.callKitManaged) {
      await AudioSession!.startAudioSession();
      if (superseded()) return;
    }
    callKitOwnsAudio = !!opts.callKitManaged;

    const r = new Room({ adaptiveStream: true, dynacast: true });
    room = r;
    currentRoomKey = roomKey;

    r.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      emit({ speaking: speakers.map((s) => s.identity) });
    });
    r.on(RoomEvent.ParticipantConnected, rebuildParticipants);
    r.on(RoomEvent.ParticipantDisconnected, rebuildParticipants);
    r.on(RoomEvent.TrackSubscribed, rebuildParticipants);
    r.on(RoomEvent.TrackUnsubscribed, rebuildParticipants);
    r.on(RoomEvent.TrackUnpublished, rebuildParticipants);
    r.on(RoomEvent.TrackMuted, rebuildParticipants);
    r.on(RoomEvent.TrackUnmuted, rebuildParticipants);
    r.on(RoomEvent.LocalTrackPublished, rebuildParticipants);
    r.on(RoomEvent.LocalTrackUnpublished, rebuildParticipants);
    r.on(RoomEvent.Disconnected, () => {
      if (snap.roomKey === roomKey) void leaveCall();
    });
    r.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
      if (snap.roomKey !== roomKey) return;
      if (state === ConnectionState.Connected && snap.phase !== "connected") {
        emit({ phase: "connected" });
      } else if (state === ConnectionState.Reconnecting) {
        emit({ phase: "connecting" });
      }
    });

    await r.connect(url, token);
    if (superseded(r)) return;
    // Speaker is the phone default for a huddle (people talk hands-free at a
    // desk); the earpiece toggle re-routes the live session.
    void applyAudioRoute(snap.speakerOn);
    // The shoulder-tap contract: join silent, one tap to speak.
    await r.localParticipant.setMicrophoneEnabled(!snap.muted);
    if (superseded(r)) return;
    emit({ phase: "connected" });
    startHeartbeat(roomKey);
    rebuildParticipants();
  } catch (err: any) {
    if (gen !== callGen) return;
    const tornGen = await teardownMedia();
    // A newer join entered during the teardown awaits: the error belongs to a
    // dead attempt — do not paint it over the new call's state.
    if (tornGen === callGen) {
      emit({
        phase: "error",
        error:
          err?.message?.includes("permission") || err?.name === "NotAllowedError"
            ? "Microphone access is off — allow it in Settings › Codecast"
            : humanizeConvexError(err, "Could not join the huddle").slice(0, 160),
      });
    }
    convex.mutation(api.calls.leaveRoom, { room_key: roomKey }).catch(() => {});
  }
}

export async function leaveCall(): Promise<void> {
  const roomKey = currentRoomKey ?? snap.roomKey;
  // Local-first: the UI shows "left" NOW. Emitting after the awaited teardown
  // stomped a join that started during the ~1s disconnect window (idle over
  // its 'connecting', roomKey null under its 'connected' — dead heartbeat,
  // lease swept mid-call).
  emit({ ...IDLE });
  await teardownMedia();
  if (roomKey) {
    await convex.mutation(api.calls.leaveRoom, { room_key: roomKey }).catch(() => {});
  }
}

function pushFlags() {
  if (!snap.roomKey) return;
  convex
    .mutation(api.calls.heartbeat, {
      room_key: snap.roomKey,
      muted: snap.muted,
      camera: snap.cameraOn,
      sharing: false,
    })
    .catch(() => {});
}

export async function setMuted(muted: boolean): Promise<void> {
  emit({ muted, pending: room && !muted ? "mic" : null });
  if (room) {
    try {
      await room.localParticipant.setMicrophoneEnabled(!muted);
      emit({ pending: null });
    } catch (err: any) {
      emit({ muted: true, pending: null, error: "Microphone access is off — allow it in Settings › Codecast" });
      return;
    }
  }
  pushFlags();
}

export async function setCamera(on: boolean): Promise<void> {
  emit({ cameraOn: on, pending: room && on ? "camera" : null });
  if (room) {
    try {
      const pub = await room.localParticipant.setCameraEnabled(on, {
        facingMode: snap.frontCamera ? "user" : "environment",
      });
      const live = on ? !!pub?.track : false;
      emit({ cameraOn: live, pending: null });
      if (on && !live) emit({ error: "Camera access is off — allow it in Settings › Codecast" });
    } catch {
      emit({ cameraOn: false, pending: null, error: "Camera access is off — allow it in Settings › Codecast" });
      return;
    }
    rebuildParticipants();
  }
  pushFlags();
}

export async function flipCamera(): Promise<void> {
  const next = !snap.frontCamera;
  emit({ frontCamera: next });
  if (!room || !snap.cameraOn) return;
  // livekit-react-native camera tracks restart with new constraints.
  const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
  const track: any = pub?.track;
  if (track?.restartTrack) {
    try {
      await track.restartTrack({ facingMode: next ? "user" : "environment" });
    } catch {}
  }
}

// Route the LIVE session (configureAudio's ios.defaultOutput is only a
// pre-connect default that the native auto policy overrides): the mode
// switch (voiceChat = earpiece-preferring, videoChat = speaker-preferring)
// comes first because a category/mode change clears any existing output
// override, then the explicit override on top.
async function applyAudioRoute(speakerOn: boolean): Promise<void> {
  if (!AudioSession) return;
  try {
    await AudioSession.setAppleAudioConfiguration({
      audioCategory: "playAndRecord",
      audioCategoryOptions: ["allowBluetooth", "allowBluetoothA2DP", "allowAirPlay", "mixWithOthers"],
      audioMode: speakerOn ? "videoChat" : "voiceChat",
    } as any);
    await AudioSession.selectAudioOutput(speakerOn ? "force_speaker" : "default");
  } catch {}
}

export async function setSpeaker(on: boolean): Promise<void> {
  emit({ speakerOn: on });
  if (snap.phase === "connected" || snap.phase === "connecting") {
    await applyAudioRoute(on);
  }
}

// ── ringing (same shapes as web) ──────────────────────────────────────────

export async function startHuddle(opts: { roomKey: string; toUserIds: string[]; anchorTitle?: string }) {
  await joinCall(opts.roomKey);
  if (getCallSnapshot().phase !== "connected") return;
  await ringInto(opts.roomKey, opts.toUserIds, opts.anchorTitle);
}

// Ring people into a room you are already in ("add people"); the ring is
// their grant to a room they are not otherwise a member of.
export async function ringInto(roomKey: string, toUserIds: string[], anchorTitle?: string) {
  if (toUserIds.length === 0) return;
  await convex
    .mutation(api.calls.invite, {
      room_key: roomKey,
      to_users: toUserIds as any,
      anchor_title: anchorTitle,
    })
    .catch(() => {});
}

export async function acceptInvite(inviteId: string, roomKey: string, opts: JoinOpts = {}): Promise<void> {
  // Accepting while in ANOTHER live call must not destroy that call on
  // failure: remember it, and restore it if the ring turns out expired — an
  // error banner over a still-flowing call would also kill its heartbeat
  // (the closure gates on snap.roomKey).
  const prior = snap;
  const switching =
    prior.roomKey !== roomKey &&
    (prior.phase === "connected" || prior.phase === "connecting");
  emit({ phase: "connecting", roomKey, error: null });
  try {
    const res = await convex.mutation(api.calls.respondInvite, {
      invite_id: inviteId as any,
      accept: true,
    });
    if (res?.expired) {
      if (switching) emit({ ...prior });
      else emit({ phase: "error", error: "That ring expired" });
      return;
    }
    // Release the old seat immediately — joinCall tears down its media, but
    // only leaveRoom frees the lease before the 45s sweep.
    if (switching && prior.roomKey) {
      convex.mutation(api.calls.leaveRoom, { room_key: prior.roomKey }).catch(() => {});
    }
    await joinCall(roomKey, opts);
  } catch (err: any) {
    if (switching) emit({ ...prior });
    else emit({ phase: "error", error: humanizeConvexError(err, "Could not join").slice(0, 160) });
  }
}

export async function declineInvite(inviteId: string): Promise<void> {
  await convex
    .mutation(api.calls.respondInvite, { invite_id: inviteId as any, accept: false })
    .catch(() => {});
}

// Dev-only harness hooks, mirroring web's __callManager: the simulator e2e
// drives the app over the Hermes inspector, and a dynamic import there would
// be a second module instance with empty state.
if (__DEV__) {
  (global as any).__call = {
    joinCall,
    leaveCall,
    setMuted,
    setCamera,
    flipCamera,
    setSpeaker,
    startHuddle,
    acceptInvite,
    declineInvite,
    snapshot: getCallSnapshot,
    room: getRoom,
  };
}
