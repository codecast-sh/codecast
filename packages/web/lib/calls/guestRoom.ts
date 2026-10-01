import {
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  createLocalAudioTrack,
  createLocalVideoTrack,
  type Participant,
  type RemoteTrack,
} from "livekit-client";
import { callParticipantKind, type CallParticipantKind } from "@codecast/shared/contracts";
import { huddleRoomOptions, micConstraints, SCREEN_SHARE_CAPTURE, SCREEN_SHARE_PUBLISH } from "./livekitMedia";
import { listDevices, mediaFailureReason, participantImage, participantTiles, type ParticipantTile } from "./callMedia";
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
  devices: { mic: MediaDeviceInfo[]; camera: MediaDeviceInfo[]; speaker: MediaDeviceInfo[] };
  choice: DeviceChoice;
};

export class GuestPreview extends Emitter<PreviewSnapshot> {
  private meter: MicMeter | null = null;
  private handedOff = false;
  private disposed = false;

  constructor(choice: DeviceChoice) {
    super({
      video: null,
      audio: null,
      cameraError: null,
      micError: null,
      asking: false,
      devices: { mic: [], camera: [], speaker: [] },
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

  /** Open what the guest asked for. Each device on its own, so a refused
   *  camera leaves the microphone working and says which one is the problem. */
  async start(want: { mic: boolean; camera: boolean }): Promise<void> {
    this.set({ asking: true });
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
    this.stopMeter();
    if (!this.handedOff) {
      this.snap.video?.stop();
      this.snap.audio?.stop();
    }
  }

  async refreshDevices(): Promise<void> {
    const [mic, camera, speaker] = await Promise.all([
      listDevices("audioinput", { prompt: false }),
      listDevices("videoinput", { prompt: false }),
      canPickSpeaker() ? listDevices("audiooutput", { prompt: false }) : Promise.resolve([]),
    ]);
    if (!this.disposed) this.set({ devices: { mic, camera, speaker } });
  }

  private async openCamera(): Promise<void> {
    if (this.snap.video) return;
    try {
      const video = await createLocalVideoTrack({
        ...(this.snap.choice.cameraId ? { deviceId: { ideal: this.snap.choice.cameraId } } : {}),
        resolution: { width: 1280, height: 720, frameRate: 30 },
      });
      if (this.disposed) return void video.stop();
      this.set({ video, cameraError: null });
    } catch (err) {
      this.set({ video: null, cameraError: await mediaFailureReason("camera", err) });
    }
  }

  private async openMic(): Promise<void> {
    if (this.snap.audio) return;
    try {
      const audio = await createLocalAudioTrack(micConstraints(this.snap.choice.micId));
      if (this.disposed) return void audio.stop();
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
  /** Why the media room let go of us, when it did on its own. */
  ended: "removed" | "room_closed" | "lost" | null;
  people: GuestPerson[];
  tiles: ParticipantTile[];
  speaking: string[];
  mic: boolean;
  camera: boolean;
  sharing: boolean;
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

  constructor(choice: DeviceChoice) {
    super({
      phase: "connecting",
      ended: null,
      people: [],
      tiles: [],
      speaking: [],
      mic: false,
      camera: false,
      sharing: false,
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
  }

  async setMic(on: boolean): Promise<void> {
    try {
      await this.room.localParticipant.setMicrophoneEnabled(on, micConstraints(this.snap.choice.micId));
    } catch (err) {
      this.set({ error: await mediaFailureReason("microphone", err) });
    }
    this.refresh();
  }

  async setCamera(on: boolean): Promise<void> {
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
        muted: !p.isMicrophoneEnabled,
        sharing: p.isScreenShareEnabled,
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
