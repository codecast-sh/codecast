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
  createAudioAnalyser,
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
// Generation counter for join/leave interleaving: every joinCall bumps it and
// captures its own generation; leaveCall/teardown bump it too. A continuation
// that resumes after an await and finds the world moved on (another join, a
// leave) must abandon its work instead of writing last-writer-wins state over
// the newer call. Without this, join A → join B while A awaits connects TWO
// SFU rooms and leaks A's live mic.
let callGen = 0;
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
  tilesSnapshot = next;
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
export async function joinCall(roomKey: string): Promise<void> {
  if (!convex) return;
  const prior = useInboxStore.getState().call;
  // Already in (or genuinely joining) this room: idempotent. "connecting" only
  // counts when a Room object exists — acceptInvite paints connecting before
  // any media work, and that optimistic paint must not swallow the real join.
  if (
    prior.roomKey === roomKey &&
    (prior.phase === "connected" || (prior.phase === "connecting" && room))
  ) {
    return;
  }
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
    error: null,
    speaking: [],
    camera: false,
    sharing: false,
  });
  let r: Room | undefined;
  try {
    await controlJoin(roomKey);
    if (superseded()) return;
    const { url, token } = await convex.action(api.calls.mintAccessToken, {
      room_key: roomKey,
    });
    if (superseded()) return;
    r = new Room({ adaptiveStream: true, dynacast: true });
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
    if (superseded(r)) return;
    // Publish the mic in the muted state the user chose — join is silent by
    // default (the shoulder-tap contract), one keypress to speak.
    const muted = useInboxStore.getState().call.muted;
    await r.localParticipant.setMicrophoneEnabled(!muted);
    if (superseded(r)) return;
    setCall({ phase: "connected" });
    soundCallJoin();
    startHeartbeat(roomKey);
    rebuildTiles();
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
        : err?.message || "Could not join the huddle";
    setCall({ phase: "error", error: message });
    // Free the control-plane row so occupancy doesn't show a ghost.
    convex?.mutation(api.calls.leaveRoom, { room_key: roomKey }).catch(() => {});
  }
}

export async function leaveCall(): Promise<void> {
  const roomKey = currentRoomKey ?? useInboxStore.getState().call.roomKey;
  callGen++;
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

// Why did capture fail? livekit resolves null (no throw) when getUserMedia
// yields nothing, and the Permissions API tells the two cases apart: a
// blocked site setting versus a machine with no such device. The message is
// the fix, phrased for the person holding the mouse.
async function mediaFailureReason(kind: "camera" | "microphone", err?: any): Promise<string> {
  const label = kind === "camera" ? "Camera" : "Microphone";
  if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError") {
    return `No ${kind} found`;
  }
  try {
    const state = (await navigator.permissions.query({ name: kind as PermissionName })).state;
    if (state === "denied") return `${label} blocked — allow it in the site settings (the icon left of the address bar), then try again`;
    if (state === "prompt") return `${label} permission needed — click the ${kind} icon in the address bar to allow`;
  } catch {}
  return err?.name === "NotAllowedError" ? `${label} permission denied` : `${label} unavailable`;
}

export async function setCamera(on: boolean): Promise<void> {
  setCall({ camera: on });
  if (room) {
    try {
      const pub = await room.localParticipant.setCameraEnabled(on);
      // Reconcile to what actually happened: enabling can resolve without a
      // publication (no camera, permission denied) and the button must not
      // sit lit over a black tile.
      const live = on ? !!pub?.track && !pub.isMuted : false;
      setCall({ camera: live });
      if (on && !live) setCall({ error: await mediaFailureReason("camera") });
    } catch (err: any) {
      setCall({ camera: false, error: await mediaFailureReason("camera", err) });
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
        setCall({ error: "Screen sharing not permitted" });
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
  // Local-first: the dock paints "connecting" the instant Join is clicked;
  // the accept round-trip and the media join settle after.
  setCall({ phase: "connecting", roomKey, error: null, speaking: [] });
  try {
    const res = await convex.mutation(api.calls.respondInvite, {
      invite_id: inviteId,
      accept: true,
    });
    if (res?.expired) {
      setCall({ phase: "error", error: "That ring expired" });
      return;
    }
    await joinCall(roomKey);
  } catch (err: any) {
    setCall({ phase: "error", error: err?.message || "Could not join the huddle" });
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

// Best-effort row cleanup when the tab dies mid-call; the 45s lease is the
// real guarantee, this just makes the common case instant.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    if (currentRoomKey && convex) {
      convex.mutation(api.calls.leaveRoom, { room_key: currentRoomKey }).catch(() => {});
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
  };
}
