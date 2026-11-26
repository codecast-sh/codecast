// Live WebRTC audio diagnostics (`window.__callManager.audioStats()`).
//
// Answers in one snapshot whether a bad-sounding huddle is capture-side
// (16 kHz Bluetooth HFP, double-filtering, wrong device), encoder-side
// (starved Opus bitrate, missing Krisp), or network-side (packet loss,
// jitter, NetEQ PLC concealment).
import { Track, type LocalAudioTrack, type RemoteAudioTrack, type Room } from "livekit-client";
import { isKrispActiveOnRoom } from "./krispFilter";

export type LocalAudioDiagnostics = {
  published: boolean;
  muted: boolean;
  krispEnabled: boolean;
  bitrateBps: number;
  settings: {
    deviceId?: string;
    label?: string;
    sampleRate?: number;
    channelCount?: number;
    echoCancellation?: boolean | string;
    noiseSuppression?: boolean;
    voiceIsolation?: boolean;
    autoGainControl?: boolean;
  } | null;
  sender: {
    packetsSent?: number;
    packetsLost?: number;
    bytesSent?: number;
    roundTripTime?: number;
    jitter?: number;
  } | null;
};

export type RemoteAudioDiagnostics = {
  identity: string;
  name: string;
  muted: boolean;
  bitrateBps: number;
  jitter?: number;
  bytesReceived?: number;
  concealedSamples?: number;
  concealmentEvents?: number;
  totalSamplesDuration?: number;
  /** Fraction of decoded audio synthesized by NetEQ PLC due to packet loss/jitter. */
  concealedRatio?: number;
};

export type RoomAudioDiagnostics = {
  roomState: string;
  serverUrl?: string;
  local: LocalAudioDiagnostics;
  remotes: RemoteAudioDiagnostics[];
};

export async function getRoomAudioStats(room: Room | null): Promise<RoomAudioDiagnostics | null> {
  if (!room) return null;
  const micPub = room.localParticipant?.getTrackPublication?.(Track.Source.Microphone);
  const localTrack = (micPub?.audioTrack ?? micPub?.track ?? null) as LocalAudioTrack | null;
  const rawTrack: MediaStreamTrack | undefined =
    (localTrack as any)?._mediaStreamTrack ?? localTrack?.mediaStreamTrack;
  const rawSettings: any = rawTrack?.getSettings?.() ?? null;
  const senderStats = (await localTrack?.getSenderStats?.().catch(() => undefined)) ?? null;

  const remotes: RemoteAudioDiagnostics[] = [];
  for (const p of room.remoteParticipants?.values?.() ?? []) {
    const pub = p.getTrackPublication?.(Track.Source.Microphone);
    const track = (pub?.audioTrack ?? pub?.track ?? null) as RemoteAudioTrack | null;
    const recv = track ? await track.getReceiverStats?.().catch(() => undefined) : undefined;
    const sampleRate = 48_000;
    const totalSamples =
      recv?.totalSamplesDuration && recv.totalSamplesDuration > 0
        ? recv.totalSamplesDuration * sampleRate
        : undefined;
    remotes.push({
      identity: p.identity,
      name: p.name || p.identity,
      muted: pub ? pub.isMuted : true,
      bitrateBps: track?.currentBitrate ?? 0,
      jitter: recv?.jitter,
      bytesReceived: recv?.bytesReceived,
      concealedSamples: recv?.concealedSamples,
      concealmentEvents: recv?.concealmentEvents,
      totalSamplesDuration: recv?.totalSamplesDuration,
      concealedRatio:
        totalSamples && recv?.concealedSamples !== undefined
          ? Number((recv.concealedSamples / totalSamples).toFixed(4))
          : undefined,
    });
  }

  return {
    roomState: String(room.state ?? "unknown"),
    serverUrl: (room as any).engine?.url,
    local: {
      published: !!micPub && !!localTrack,
      muted: micPub ? micPub.isMuted : true,
      krispEnabled: isKrispActiveOnRoom(room),
      bitrateBps: localTrack?.currentBitrate ?? 0,
      settings: rawSettings
        ? {
            deviceId: rawSettings.deviceId,
            label: rawTrack?.label,
            sampleRate: rawSettings.sampleRate,
            channelCount: rawSettings.channelCount,
            echoCancellation: rawSettings.echoCancellation,
            noiseSuppression: rawSettings.noiseSuppression,
            voiceIsolation: rawSettings.voiceIsolation,
            autoGainControl: rawSettings.autoGainControl,
          }
        : null,
      sender: senderStats
        ? {
            packetsSent: senderStats.packetsSent,
            packetsLost: senderStats.packetsLost,
            bytesSent: senderStats.bytesSent,
            roundTripTime: senderStats.roundTripTime,
            jitter: senderStats.jitter,
          }
        : null,
    },
    remotes,
  };
}
