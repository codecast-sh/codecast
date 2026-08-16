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
import { AudioSession } from "@livekit/react-native";
import { api } from "@codecast/convex/convex/_generated/api";
import { convex } from "../convex";
import { CALL_HEARTBEAT_MS } from "@codecast/shared/contracts";

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
  callGen++;
  if (room) {
    room.removeAllListeners();
    try {
      await room.disconnect();
    } catch {}
    room = null;
  }
  currentRoomKey = null;
  try {
    await AudioSession.stopAudioSession();
  } catch {}
}

export async function joinCall(roomKey: string): Promise<void> {
  if (snap.roomKey === roomKey && (snap.phase === "connected" || (snap.phase === "connecting" && room))) {
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
    await AudioSession.startAudioSession();
    if (superseded()) return;

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
    // The shoulder-tap contract: join silent, one tap to speak.
    await r.localParticipant.setMicrophoneEnabled(!snap.muted);
    if (superseded(r)) return;
    emit({ phase: "connected" });
    startHeartbeat(roomKey);
    rebuildParticipants();
  } catch (err: any) {
    if (gen !== callGen) return;
    await teardownMedia();
    emit({
      phase: "error",
      error:
        err?.message?.includes("permission") || err?.name === "NotAllowedError"
          ? "Microphone permission needed — enable it in Settings"
          : err?.message?.slice(0, 140) || "Could not join the huddle",
    });
    convex.mutation(api.calls.leaveRoom, { room_key: roomKey }).catch(() => {});
  }
}

export async function leaveCall(): Promise<void> {
  const roomKey = currentRoomKey ?? snap.roomKey;
  await teardownMedia();
  emit({ ...IDLE });
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
  emit({ muted });
  if (room) {
    try {
      await room.localParticipant.setMicrophoneEnabled(!muted);
    } catch (err: any) {
      emit({ muted: true, error: "Microphone permission needed — enable it in Settings" });
      return;
    }
  }
  pushFlags();
}

export async function setCamera(on: boolean): Promise<void> {
  emit({ cameraOn: on });
  if (room) {
    try {
      const pub = await room.localParticipant.setCameraEnabled(on, {
        facingMode: snap.frontCamera ? "user" : "environment",
      });
      const live = on ? !!pub?.track : false;
      emit({ cameraOn: live });
      if (on && !live) emit({ error: "Camera permission needed — enable it in Settings" });
    } catch {
      emit({ cameraOn: false, error: "Camera permission needed — enable it in Settings" });
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

export async function setSpeaker(on: boolean): Promise<void> {
  emit({ speakerOn: on });
  try {
    await AudioSession.configureAudio({
      ios: { defaultOutput: on ? "speaker" : "earpiece" },
    });
  } catch {}
}

// ── ringing (same shapes as web) ──────────────────────────────────────────

export async function startHuddle(opts: { roomKey: string; toUserId: string; anchorTitle?: string }) {
  await joinCall(opts.roomKey);
  if (getCallSnapshot().phase !== "connected") return;
  await convex
    .mutation(api.calls.invite, {
      room_key: opts.roomKey,
      to_user: opts.toUserId as any,
      anchor_title: opts.anchorTitle,
    })
    .catch(() => {});
}

export async function acceptInvite(inviteId: string, roomKey: string): Promise<void> {
  emit({ phase: "connecting", roomKey, error: null });
  try {
    const res = await convex.mutation(api.calls.respondInvite, {
      invite_id: inviteId as any,
      accept: true,
    });
    if (res?.expired) {
      emit({ phase: "error", error: "That ring expired" });
      return;
    }
    await joinCall(roomKey);
  } catch (err: any) {
    emit({ phase: "error", error: err?.message?.slice(0, 120) || "Could not join" });
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
