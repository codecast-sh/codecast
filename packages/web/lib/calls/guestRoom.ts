import {
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  createLocalAudioTrack,
  createLocalTracks,
  createLocalVideoTrack,
  type Participant,
  type RemoteTrack,
} from "livekit-client";
import { callParticipantKind, type CallParticipantKind } from "@codecast/shared/contracts";
import { huddleRoomOptions, micConstraints, SCREEN_SHARE_CAPTURE, SCREEN_SHARE_PUBLISH } from "./livekitMedia";
import { listDevices, mediaFailureReason, participantFlags, participantImage, participantTiles, type ParticipantTile } from "./callMedia";
import { bindCallCursors } from "./callCursors";
import { createMicMeter, type MicMeter } from "./micMeter";

// A GUEST'S MEDIA, apart from the app.
//
// A member's huddle runs through callManager, which is bound to the store,
// the seat lease, the walkie, the scribe and a desktop voice host. A guest has
// none of those: no account, no seat, no store (app/meet boots without it).
// What they do have is the same media room, so this is the same media built
// from the same parts: the room options and screen-share encoding
// (livekitMedia), the tiles (callMedia.participantTiles), the cursor channel
// (callCursors), the mic meter's curve (micMeter). Nothing about a guest's
// picture or sound is decided twice.
//
// Two objects, because a guest meets their devices before they meet the room:
//   GuestPreview  the lobby: camera and microphone opened on purpose, shown
//                 back to them, switchable, metered. Its tracks are HANDED to
//                 the call when they get in, so the camera does not blink
//                 and nobody is asked for permission twice.
//   GuestCall     one connection to the media room, from a token the server
//                 minted for an admitted guest. A dropped connection that
//                 LiveKit cannot recover is a new GuestCall with a new token.
//
// Both are plain subscribe/snapshot stores for useSyncExternalStore: a level
// or a speaking ring moves many times a second and must not ride React state.

export type DeviceChoice = { micId?: string; cameraId?: string; speakerId?: string };

type Listener = () => void;

class Emitter<S> {
  private listeners = new Set<Listener>();
  protected snap: S;
  constructor(initial: S) {
    this.snap = initial;
  }
  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.snap;
  protected set(patch: Partial<S>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }
}

/** Can this browser pick where sound plays (Chromium, Firefox; not Safari)? */
export function canPickSpeaker(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

export type DeviceLists = { mic: MediaDeviceInfo[]; camera: MediaDeviceInfo[]; speaker: MediaDeviceInfo[] };
const NO_DEVICES: DeviceLists = { mic: [], camera: [], speaker: [] };

/** Every device this guest could pick, never asking for permission (a list
 *  is no reason for a prompt; inside the lobby or the call the devices are
 *  open already, so their names come anyway). */
async function listAllDevices(): Promise<DeviceLists> {
  const [mic, camera, speaker] = await Promise.all([
    listDevices("audioinput", { prompt: false }),
    listDevices("videoinput", { prompt: false }),
    canPickSpeaker() ? listDevices("audiooutput", { prompt: false }) : Promise.resolve([]),
  ]);
  return { mic, camera, speaker };
}

/** Call `fn` whenever a device is plugged in or pulled out. */
function onDeviceChange(fn: () => void): () => void {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  md?.addEventListener?.("devicechange", fn);
  return () => md?.removeEventListener?.("devicechange", fn);
}

/** Can this browser share a screen? Phones cannot, whatever they claim. */
export function canShareScreen(): boolean {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) return false;
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

// ── The lobby ────────────────────────────────────────────────────────────────

export type PreviewSnapshot = {
  video: LocalVideoTrack | null;
  audio: LocalAudioTrack | null;
  /** Why a device is not on, in words with the fix (mediaFailureReason). */
  cameraError: string | null;
  micError: string | null;
  /** Asking the browser right now (the permission prompt may be up). */
  asking: boolean;
  devices: DeviceLists;
  choice: DeviceChoice;
};

export class GuestPreview extends Emitter<PreviewSnapshot> {
  private meter: MicMeter | null = null;
  private handedOff = false;
  private disposed = false;
  private starting: Promise<void> | null = null;
  // A headset plugged in while they choose shows up in the pickers at once.
  private stopWatching = onDeviceChange(() => void this.refreshDevices());

  constructor(choice: DeviceChoice) {
    super({
      video: null,
      audio: null,
      cameraError: null,
      micError: null,
      asking: false,
      devices: NO_DEVICES,
      choice,
    });
  }

  /** The microphone's level, 0 to 1, for a meter that writes a CSS variable. */
  level(): number {
    return this.meter?.level() ?? 0;
  }
  subscribeLevel(fn: Listener): () => void {
    return this.meter?.subscribe(fn) ?? (() => {});
  }

  /** Open what the guest asked for: both in one request first, which is one
   *  permission prompt rather than two; then whatever is still closed on its
   *  own, so a refused camera leaves the microphone working and the page can
   *  say which one is the problem. */
  start(want: { mic: boolean; camera: boolean }): Promise<void> {
    const run = this.open(want);
    this.starting = run;
    return run;
  }

  /** Resolves once the devices asked for are open or refused: a Join pressed
   *  while the browser's prompt is up waits for the answer, so the guest
   *  walks in with the camera and microphone they just allowed rather than
   *  with none (the tracks a prompt grants after the hand-off are stopped). */
  settled(): Promise<void> {
    return this.starting ?? Promise.resolve();
  }

  private async open(want: { mic: boolean; camera: boolean }): Promise<void> {
    this.set({ asking: true });
    if (want.mic && want.camera && !this.snap.audio && !this.snap.video) {
      try {
        const tracks = await createLocalTracks({ audio: micConstraints(this.snap.choice.micId), video: this.videoOptions() });
        if (this.disposed || this.handedOff) {
          for (const t of tracks) t.stop();
          return;
        }
        const audio = tracks.find((t): t is LocalAudioTrack => t.kind === Track.Kind.Audio) ?? null;
        const video = tracks.find((t): t is LocalVideoTrack => t.kind === Track.Kind.Video) ?? null;
        this.set({ audio, video, micError: null, cameraError: null });
        this.startMeter();
      } catch {
        // One of the two was refused or missing; the single requests below
        // find out which.
      }
    }
    await Promise.all([want.mic ? this.openMic() : null, want.camera ? this.openCamera() : null]);
    if (this.disposed) return;
    this.set({ asking: false });
    await this.refreshDevices();
  }

  async setCamera(on: boolean): Promise<void> {
    if (!on) {
      this.snap.video?.stop();
      this.set({ video: null, cameraError: null });
      return;
    }
    await this.openCamera();
  }

  async setMic(on: boolean): Promise<void> {
    if (!on) {
      this.stopMeter();
      this.snap.audio?.stop();
      this.set({ audio: null, micError: null });
      return;
    }
    await this.openMic();
  }

  /** Switch a device in place: the preview keeps playing and the choice is
   *  what the call will open with. */
  async choose(kind: "mic" | "camera" | "speaker", deviceId: string): Promise<void> {
    const choice = { ...this.snap.choice, [`${kind}Id`]: deviceId } as DeviceChoice;
    this.set({ choice });
    try {
      if (kind === "camera" && this.snap.video) await this.snap.video.restartTrack({ deviceId: { exact: deviceId } });
      if (kind === "mic" && this.snap.audio) {
        await this.snap.audio.restartTrack(micConstraints(deviceId));
        this.startMeter();
      }
    } catch (err) {
      if (kind === "camera") this.set({ cameraError: await mediaFailureReason("camera", err) });
      if (kind === "mic") this.set({ micError: await mediaFailureReason("microphone", err) });
    }
  }

  /** The tracks, for the call to publish; the preview no longer owns them. */
  handOff(): { video: LocalVideoTrack | null; audio: LocalAudioTrack | null } {
    this.handedOff = true;
    this.stopMeter();
    return { video: this.snap.video, audio: this.snap.audio };
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatching();
    this.stopMeter();
    if (!this.handedOff) {
      this.snap.video?.stop();
      this.snap.audio?.stop();
    }
  }

  async refreshDevices(): Promise<void> {
    const devices = await listAllDevices();
    if (!this.disposed) this.set({ devices });
  }

  private async openCamera(): Promise<void> {
    if (this.snap.video) return;
    try {
      const video = await createLocalVideoTrack(this.videoOptions());
      // Gone to the call, or gone: a camera that opened late must not stay lit.
      if (this.disposed || this.handedOff) return void video.stop();
      this.set({ video, cameraError: null });
    } catch (err) {
      this.set({ video: null, cameraError: await mediaFailureReason("camera", err) });
    }
  }

  private videoOptions() {
    return {
      ...(this.snap.choice.cameraId ? { deviceId: { ideal: this.snap.choice.cameraId } } : {}),
      resolution: { width: 1280, height: 720, frameRate: 30 },
    };
  }

  private async openMic(): Promise<void> {
    if (this.snap.audio) return;
    try {
      const audio = await createLocalAudioTrack(micConstraints(this.snap.choice.micId));
      if (this.disposed || this.handedOff) return void audio.stop();
      this.set({ audio, micError: null });
      this.startMeter();
    } catch (err) {
      this.set({ audio: null, micError: await mediaFailureReason("microphone", err) });
    }
  }

  private startMeter() {
    this.stopMeter();
    const track = this.snap.audio?.mediaStreamTrack;
    if (track) this.meter = createMicMeter(track);
  }

  private stopMeter() {
    this.meter?.stop();
    this.meter = null;
  }
}

// ── The call ─────────────────────────────────────────────────────────────────

export type GuestPerson = {
  identity: string;
  name: string;
  image?: string;
  kind: CallParticipantKind;
  isLocal: boolean;
  muted: boolean;
  sharing: boolean;
};

export type CallPhase = "connecting" | "connected" | "reconnecting" | "disconnected";

export type CallSnapshot = {
  phase: CallPhase;
  /** Why the media room let go of us, when it did on its own: put out,
   *  the room closed, the network, or this guest joining again from another
   *  tab or window (the media server keeps one connection per identity, so
   *  the newer one wins and this one must not grab it back on its own). */
  ended: "removed" | "room_closed" | "lost" | "elsewhere" | null;
  people: GuestPerson[];
  tiles: ParticipantTile[];
  speaking: string[];
  mic: boolean;
  camera: boolean;
  sharing: boolean;
  /** What the guest asked their microphone and camera to be, which is not
   *  what is published while a track is still opening or failed. The page
   *  keeps this as the guest's choice: a reconnect or the next link opens
   *  the devices the way they last left them, never back on by itself. */
  wants: { mic: boolean; camera: boolean };
  /** The devices to pick from, kept current as they come and go. */
  devices: DeviceLists;
  /** The browser blocked sound until the guest touches the page. */
  audioBlocked: boolean;
  /** The last device failure, in words with the fix; the guest dismisses it. */
  error: string | null;
  choice: DeviceChoice;
};

export class GuestCall extends Emitter<CallSnapshot> {
  readonly room: Room;
  private audioHost: HTMLDivElement;
  private audioEls = new Map<string, HTMLMediaElement>();
  private left = false;
  private stopWatching = onDeviceChange(() => void this.refreshDevices());

  constructor(choice: DeviceChoice, wants: { mic: boolean; camera: boolean }) {
    super({
      phase: "connecting",
      ended: null,
      people: [],
      tiles: [],
      speaking: [],
      mic: false,
      camera: false,
      sharing: false,
      wants,
      devices: NO_DEVICES,
      audioBlocked: false,
      error: null,
      choice,
    });
    this.room = new Room(
      huddleRoomOptions({ micDeviceId: choice.micId, cameraDeviceId: choice.cameraId, speakerDeviceId: choice.speakerId }),
    );
    this.audioHost = document.createElement("div");
    this.audioHost.style.display = "none";
    this.audioHost.dataset.role = "guest-audio";
    document.body.appendChild(this.audioHost);
    this.wire();
  }

  getRoom = (): Room | null => this.room;

  /** Join with a minted token, publishing what the lobby handed over. A
   *  device that fails here fails alone: the guest is in, and told. */
  async connect(
    creds: { url: string; token: string },
    tracks: { video: LocalVideoTrack | null; audio: LocalAudioTrack | null },
  ): Promise<void> {
    bindCallCursors(this.room);
    await this.room.connect(creds.url, creds.token);
    if (this.left) return;
    const lp = this.room.localParticipant;
    try {
      if (tracks.audio) await lp.publishTrack(tracks.audio, { source: Track.Source.Microphone });
    } catch (err) {
      tracks.audio?.stop();
      this.set({ error: await mediaFailureReason("microphone", err) });
    }
    try {
      if (tracks.video) await lp.publishTrack(tracks.video, { source: Track.Source.Camera, simulcast: true });
    } catch (err) {
      tracks.video?.stop();
      this.set({ error: await mediaFailureReason("camera", err) });
    }
    this.refresh();
    void this.refreshDevices();
  }

  /** Join again after the connection dropped, in place of the call that
   *  lost it: no lobby in between (the stage stays up under its
   *  "Reconnecting" line), so nothing is handed over and the devices open the
   *  way the guest last left them (`wants`), never back on by themselves. */
  async reconnectWith(creds: { url: string; token: string }): Promise<void> {
    await this.connect(creds, { video: null, audio: null });
    if (this.left) return;
    const { mic, camera } = this.snap.wants;
    if (mic) await this.setMic(true);
    if (camera) await this.setCamera(true);
  }

  async refreshDevices(): Promise<void> {
    const devices = await listAllDevices();
    if (!this.left) this.set({ devices });
  }

  async setMic(on: boolean): Promise<void> {
    this.set({ wants: { ...this.snap.wants, mic: on } });
    try {
      await this.room.localParticipant.setMicrophoneEnabled(on, micConstraints(this.snap.choice.micId));
    } catch (err) {
      this.set({ error: await mediaFailureReason("microphone", err) });
    }
    this.refresh();
  }

  async setCamera(on: boolean): Promise<void> {
    this.set({ wants: { ...this.snap.wants, camera: on } });
    try {
      await this.room.localParticipant.setCameraEnabled(
        on,
        this.snap.choice.cameraId ? { deviceId: { ideal: this.snap.choice.cameraId } } : undefined,
      );
    } catch (err) {
      this.set({ error: await mediaFailureReason("camera", err) });
    }
    this.refresh();
  }

  async setScreenShare(on: boolean): Promise<void> {
    try {
      await this.room.localParticipant.setScreenShareEnabled(on, on ? SCREEN_SHARE_CAPTURE : { audio: false }, on ? SCREEN_SHARE_PUBLISH : undefined);
    } catch (err: any) {
      // Closing the browser's picker is a choice, not a failure.
      if (err?.name !== "NotAllowedError" && err?.name !== "AbortError") {
        this.set({ error: "Could not share your screen" });
      }
    }
    this.refresh();
  }

  async choose(kind: "mic" | "camera" | "speaker", deviceId: string): Promise<void> {
    this.set({ choice: { ...this.snap.choice, [`${kind}Id`]: deviceId } });
    const lkKind: MediaDeviceKind = kind === "mic" ? "audioinput" : kind === "camera" ? "videoinput" : "audiooutput";
    try {
      await this.room.switchActiveDevice(lkKind, deviceId);
    } catch {
      this.set({ error: "Could not switch to that device" });
    }
  }

  /** The guest's tap that lets the browser play the room's sound. */
  async startAudio(): Promise<void> {
    await this.room.startAudio().catch(() => {});
    this.set({ audioBlocked: !this.room.canPlaybackAudio });
  }

  dismissError(): void {
    this.set({ error: null });
  }

  /** Hang up the media. The server side of leaving is the page's (leaveCall). */
  async leave(): Promise<void> {
    this.left = true;
    this.stopWatching();
    await this.room.disconnect().catch(() => {});
    this.teardownAudio();
  }

  private wire() {
    const r = this.room;
    const refresh = () => this.refresh();
    for (const ev of [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.ParticipantNameChanged,
      RoomEvent.ParticipantMetadataChanged,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
    ]) {
      r.on(ev, refresh);
    }
    r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const key = `${participant.identity}:${track.sid}`;
      const el = track.attach();
      this.audioEls.set(key, el);
      this.audioHost.appendChild(el);
    });
    r.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const key = `${participant.identity}:${track.sid}`;
      const el = this.audioEls.get(key);
      if (el) {
        track.detach(el);
        el.remove();
        this.audioEls.delete(key);
      }
    });
    r.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      this.set({ speaking: speakers.map((p) => p.identity) });
    });
    r.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      this.set({ audioBlocked: !r.canPlaybackAudio });
    });
    r.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
      const phase: CallPhase =
        state === ConnectionState.Connected
          ? "connected"
          : state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting
            ? "reconnecting"
            : state === ConnectionState.Disconnected
              ? "disconnected"
              : "connecting";
      this.set({ phase });
      if (phase === "connected") this.set({ audioBlocked: !r.canPlaybackAudio });
    });
    r.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      this.teardownAudio();
      if (this.left) return;
      this.set({
        phase: "disconnected",
        ended:
          reason === DisconnectReason.PARTICIPANT_REMOVED
            ? "removed"
            : reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.ROOM_CLOSED
              ? "room_closed"
              : reason === DisconnectReason.DUPLICATE_IDENTITY
                ? "elsewhere"
                : "lost",
      });
    });
    r.on(RoomEvent.MediaDevicesError, async (err: Error) => {
      this.set({ error: await mediaFailureReason(/video|camera/i.test(err?.message ?? "") ? "camera" : "microphone", err) });
    });
  }

  private refresh() {
    const r = this.room;
    const all: Participant[] = [r.localParticipant, ...r.remoteParticipants.values()];
    const people: GuestPerson[] = all
      .filter((p) => !!p.identity)
      .map((p) => ({
        identity: p.identity,
        name: p.name || p.identity,
        image: participantImage(p),
        kind: callParticipantKind(p.identity),
        isLocal: p === r.localParticipant,
        ...participantFlags(p),
      }));
    const lp = r.localParticipant;
    this.set({
      people,
      tiles: participantTiles(r),
      mic: lp.isMicrophoneEnabled,
      camera: lp.isCameraEnabled,
      sharing: lp.isScreenShareEnabled,
    });
  }

  private teardownAudio() {
    for (const el of this.audioEls.values()) el.remove();
    this.audioEls.clear();
    this.audioHost.remove();
  }
}
