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
  LocalParticipant,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../../store/inboxStore";
import { CALL_HEARTBEAT_MS } from "@codecast/shared/contracts";
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
let audioHost: HTMLElement | null = null;
const audioEls = new Map<string, HTMLMediaElement>();

// React binds the live Convex client here (useCallSync); everything below
// no-ops politely until it has.
export function bindConvex(client: ConvexHandle) {
  convex = client;
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
export type ParticipantTile = {
  identity: string;
  name: string;
  image?: string;
  isLocal: boolean;
  cameraTrack: Track | null;
  screenTrack: Track | null;
  micMuted: boolean;
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

function participantImage(p: Participant): string | undefined {
  try {
    const meta = p.metadata ? JSON.parse(p.metadata) : null;
    return meta?.image ?? undefined;
  } catch {
    return undefined;
  }
}

function rebuildTiles() {
  if (!room) {
    tilesSnapshot = [];
  } else {
    const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    tilesSnapshot = all.map((p) => {
      const camera = p.getTrackPublication(Track.Source.Camera);
      const screen = p.getTrackPublication(Track.Source.ScreenShare);
      const mic = p.getTrackPublication(Track.Source.Microphone);
      return {
        identity: p.identity,
        name: p.name || p.identity,
        image: participantImage(p),
        isLocal: p instanceof LocalParticipant,
        cameraTrack: camera?.isSubscribed || p.isLocal ? camera?.track ?? null : null,
        screenTrack: screen?.isSubscribed || p.isLocal ? screen?.track ?? null : null,
        micMuted: mic ? mic.isMuted : true,
      };
    });
  }
  for (const cb of tileSubscribers) cb();
}

// ── lifecycle ─────────────────────────────────────────────────────────────

async function controlJoin(roomKey: string) {
  if (!convex) throw new Error("calls not bound yet");
  await convex.mutation(api.calls.joinRoom, {
    room_key: roomKey,
    muted: useInboxStore.getState().call.muted,
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
      .catch(() => {});
  }, CALL_HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function attachAudio(track: RemoteTrack, participantId: string) {
  if (track.kind !== Track.Kind.Audio) return;
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
export async function joinCall(roomKey: string): Promise<void> {
  if (!convex) return;
  const prior = useInboxStore.getState().call;
  if (prior.roomKey === roomKey && (prior.phase === "connected" || prior.phase === "connecting")) {
    return;
  }
  if (room) teardownMedia();
  setCall({
    phase: "connecting",
    roomKey,
    error: null,
    speaking: [],
    camera: false,
    sharing: false,
  });
  try {
    await controlJoin(roomKey);
    const { url, token } = await convex.action(api.calls.mintAccessToken, {
      room_key: roomKey,
    });
    const r = new Room({ adaptiveStream: true, dynacast: true });
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
    r.on(RoomEvent.TrackMuted, rebuildTiles);
    r.on(RoomEvent.TrackUnmuted, rebuildTiles);
    r.on(RoomEvent.LocalTrackPublished, rebuildTiles);
    r.on(RoomEvent.LocalTrackUnpublished, rebuildTiles);
    r.on(RoomEvent.Disconnected, () => {
      // SFU-side disconnect (kicked, server restart, network gave up after
      // livekit-client's own retries): reflect reality and free the row.
      if (useInboxStore.getState().call.roomKey === roomKey) {
        void leaveCall();
      }
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

    await r.connect(url, token);
    // Publish the mic in the muted state the user chose — join is silent by
    // default (the shoulder-tap contract), one keypress to speak.
    const muted = useInboxStore.getState().call.muted;
    await r.localParticipant.setMicrophoneEnabled(!muted);
    setCall({ phase: "connected" });
    soundCallJoin();
    startHeartbeat(roomKey);
    rebuildTiles();
  } catch (err: any) {
    teardownMedia();
    const message =
      err?.name === "NotAllowedError"
        ? "Microphone permission denied"
        : err?.message || "Could not join the huddle";
    setCall({ phase: "error", error: message });
    // Free the control-plane row so occupancy doesn't show a ghost.
    convex?.mutation(api.calls.leaveRoom, { room_key: roomKey }).catch(() => {});
  }
}

export async function leaveCall(): Promise<void> {
  const roomKey = currentRoomKey ?? useInboxStore.getState().call.roomKey;
  teardownMedia();
  setCall({
    phase: "idle",
    roomKey: null,
    speaking: [],
    camera: false,
    sharing: false,
    error: null,
    muted: true,
  });
  soundCallLeave();
  if (convex && roomKey) {
    await convex.mutation(api.calls.leaveRoom, { room_key: roomKey }).catch(() => {});
  }
}

export async function setMuted(muted: boolean): Promise<void> {
  setCall({ muted });
  if (room) {
    try {
      await room.localParticipant.setMicrophoneEnabled(!muted);
    } catch (err: any) {
      setCall({ muted: true, error: err?.name === "NotAllowedError" ? "Microphone permission denied" : null });
      return;
    }
  }
  pushFlags();
}

export async function setCamera(on: boolean): Promise<void> {
  setCall({ camera: on });
  if (room) {
    try {
      await room.localParticipant.setCameraEnabled(on);
    } catch {
      setCall({ camera: false });
      return;
    }
    rebuildTiles();
  }
  pushFlags();
}

export async function setScreenShare(on: boolean): Promise<void> {
  setCall({ sharing: on });
  if (room) {
    try {
      await room.localParticipant.setScreenShareEnabled(on);
    } catch {
      // User cancelled the picker or the platform refused — not an error state.
      setCall({ sharing: false });
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
  } catch {}
}

// ── ringing ───────────────────────────────────────────────────────────────

// Ring a teammate into a room, joining it yourself first (the caller waits
// inside — answering drops the callee straight into a live room).
export async function startHuddle(opts: {
  roomKey: string;
  toUserId: string;
  anchorTitle?: string;
}): Promise<void> {
  if (!convex) return;
  setCall({ phase: "ringing_out" as const, roomKey: opts.roomKey, error: null });
  try {
    await joinCall(opts.roomKey);
    if (useInboxStore.getState().call.phase !== "connected") return;
    await convex.mutation(api.calls.invite, {
      room_key: opts.roomKey,
      to_user: opts.toUserId,
      anchor_title: opts.anchorTitle,
    });
  } catch (err: any) {
    setCall({ phase: "error", error: err?.message || "Could not start the huddle" });
  }
}

export async function acceptInvite(inviteId: string, roomKey: string): Promise<void> {
  if (!convex) return;
  try {
    const res = await convex.mutation(api.calls.respondInvite, {
      invite_id: inviteId,
      accept: true,
    });
    if (res?.expired) return;
    await joinCall(roomKey);
  } catch {}
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

// Best-effort row cleanup when the tab dies mid-call; the 45s lease is the
// real guarantee, this just makes the common case instant.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    if (currentRoomKey && convex) {
      convex.mutation(api.calls.leaveRoom, { room_key: currentRoomKey }).catch(() => {});
    }
  });
}
