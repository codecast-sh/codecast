import { afterEach, describe, expect, test } from "bun:test";
import { ConnectionState, Track } from "livekit-client";
import {
  __setKrispLoaderForTest,
  isKrispActiveOnRoom,
  KRISP_PROCESSOR_NAME,
  syncRoomNoiseCancellation,
} from "../calls/krispFilter";
import { bluetoothHfpConflict } from "../calls/bluetoothAudioHint";
import { getRoomAudioStats } from "../calls/audioDiagnostics";

function fakeAudioEnv(opts: { ctxState?: "running" | "suspended"; enableResult?: boolean; throwOnEnable?: boolean } = {}) {
  const appliedRaw: any[] = [];
  const appliedTrack: any[] = [];
  let resumed = 0;
  let stopped = 0;
  let enabled = false;
  let publishedTo: unknown = null;
  let currentProcessor: any = undefined;

  const rawTrack = {
    label: "MacBook Pro Microphone (Built-in)",
    getSettings: () => ({
      deviceId: "builtin-mic",
      sampleRate: 48_000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: !enabled,
      voiceIsolation: false,
      autoGainControl: true,
    }),
    applyConstraints: async (c: any) => {
      appliedRaw.push(c);
    },
  };

  const audioContext: any = {
    state: opts.ctxState ?? "running",
    sampleRate: 48_000,
    resume: async () => {
      resumed += 1;
      audioContext.state = "running";
    },
  };

  const localAudioTrack: any = {
    _mediaStreamTrack: rawTrack,
    mediaStreamTrack: rawTrack,
    audioContext,
    currentBitrate: 72_000,
    setAudioContext(ctx: any) {
      this.audioContext = ctx;
    },
    getProcessor: () => currentProcessor,
    setProcessor: async (proc: any) => {
      currentProcessor = proc;
    },
    stopProcessor: async () => {
      stopped += 1;
      currentProcessor = undefined;
      enabled = false;
    },
    applyConstraints: async (c: any) => {
      appliedTrack.push(c);
    },
    getSenderStats: async () => ({
      packetsSent: 500,
      packetsLost: 2,
      bytesSent: 180_000,
      roundTripTime: 0.024,
      jitter: 0.003,
    }),
  };

  const room: any = {
    state: ConnectionState.Connected,
    audioContext,
    engine: { url: "wss://proj.livekit.cloud" },
    localParticipant: {
      getTrackPublication: (source: unknown) =>
        source === Track.Source.Microphone
          ? { isMuted: false, audioTrack: localAudioTrack, track: localAudioTrack }
          : undefined,
    },
    remoteParticipants: new Map([
      [
        "u2",
        {
          identity: "u2",
          name: "Tushar",
          getTrackPublication: (source: unknown) =>
            source === Track.Source.Microphone
              ? {
                  isMuted: false,
                  audioTrack: {
                    currentBitrate: 68_000,
                    getReceiverStats: async () => ({
                      jitter: 0.004,
                      bytesReceived: 96_000,
                      concealedSamples: 480,
                      concealmentEvents: 1,
                      totalSamplesDuration: 10,
                    }),
                  },
                }
              : undefined,
        },
      ],
    ]),
  };

  let createdProcessors = 0;
  let selectedQuality: string | undefined;
  __setKrispLoaderForTest(async () => ({
    isKrispNoiseFilterSupported: () => true,
    KrispNoiseFilter: (kOpts) => {
      createdProcessors += 1;
      selectedQuality = kOpts?.quality;
      return {
        name: KRISP_PROCESSOR_NAME,
        init: async () => {},
        restart: async () => {},
        destroy: async () => {
          enabled = false;
        },
        onPublish: async (r: any) => {
          publishedTo = r;
        },
        setEnabled: async (on: boolean) => {
          if (opts.throwOnEnable) throw new Error("server refused enc");
          if (opts.enableResult === false && on) return false;
          enabled = on;
          return on;
        },
        isEnabled: () => enabled,
      };
    },
  }));

  return {
    room,
    appliedRaw,
    appliedTrack,
    stats: () => ({ resumed, stopped, enabled, publishedTo, createdProcessors, selectedQuality }),
  };
}

afterEach(() => {
  __setKrispLoaderForTest(null);
});

describe("krisp noise cancellation", () => {
  test("resumes a suspended voice-host AudioContext, attaches high-quality Krisp, and disables browser noiseSuppression", async () => {
    const env = fakeAudioEnv({ ctxState: "suspended" });
    const active = await syncRoomNoiseCancellation(env.room, true);
    expect(active).toBe(true);
    expect(isKrispActiveOnRoom(env.room)).toBe(true);
    expect(env.stats()).toMatchObject({
      resumed: 1,
      enabled: true,
      publishedTo: env.room,
      createdProcessors: 1,
      selectedQuality: "high",
    });
    expect(env.appliedRaw.at(-1)).toEqual({ noiseSuppression: false, voiceIsolation: false });

    // Idempotent when reconciled again (e.g. after a device check or unmute).
    expect(await syncRoomNoiseCancellation(env.room, true)).toBe(true);
    expect(env.stats().createdProcessors).toBe(1);
  });

  test("toggling off stops the Krisp processor and restores single-layer browser noiseSuppression", async () => {
    const env = fakeAudioEnv();
    await syncRoomNoiseCancellation(env.room, true);
    expect(await syncRoomNoiseCancellation(env.room, false)).toBe(false);
    expect(isKrispActiveOnRoom(env.room)).toBe(false);
    expect(env.stats().stopped).toBe(1);
    expect(env.appliedTrack.at(-1)).toEqual({ noiseSuppression: true, voiceIsolation: false });
  });

  test("falls back to browser noiseSuppression when a non-Cloud server refuses Krisp", async () => {
    const env = fakeAudioEnv({ enableResult: false });
    expect(await syncRoomNoiseCancellation(env.room, true)).toBe(false);
    expect(isKrispActiveOnRoom(env.room)).toBe(false);
    expect(env.stats().stopped).toBe(1);
    expect(env.appliedTrack.at(-1)).toEqual({ noiseSuppression: true, voiceIsolation: false });
  });
});

describe("bluetooth HFP quality conflict detector", () => {
  const dev = (deviceId: string, label: string) => ({ deviceId, label });

  test("flags when default or chosen mic and speaker both point to Bluetooth headphones while a built-in mic exists", () => {
    const mics = [
      dev("default", "Default - AirPods Pro (Bluetooth)"),
      dev("bt-mic", "AirPods Pro (Bluetooth)"),
      dev("vh-1", "BlackHole 2ch (Virtual)"),
      dev("mac-mic", "MacBook Pro Microphone (Built-in)"),
    ];
    const speakers = [
      dev("default", "Default - AirPods Pro (Bluetooth)"),
      dev("bt-out", "AirPods Pro (Bluetooth)"),
      dev("mac-out", "MacBook Pro Speakers (Built-in)"),
    ];
    const conflict = bluetoothHfpConflict(mics, speakers);
    expect(conflict).toEqual({
      headsetName: "AirPods Pro",
      altMic: dev("mac-mic", "MacBook Pro Microphone (Built-in)"),
      altMicName: "MacBook Pro Microphone",
    });
  });

  test("stays silent once the user picks the built-in or USB mic while keeping AirPods as speaker", () => {
    const mics = [
      dev("bt-mic", "AirPods Pro (Bluetooth)"),
      dev("studio-mic", "Studio Display Microphone (Apple)"),
    ];
    const speakers = [dev("bt-out", "AirPods Pro (Bluetooth)")];
    expect(bluetoothHfpConflict(mics, speakers, "studio-mic", "bt-out")).toBeNull();
  });
});

describe("audio diagnostics", () => {
  test("reports local capture settings, Krisp state, sender stats and remote NetEQ concealment", async () => {
    const env = fakeAudioEnv();
    await syncRoomNoiseCancellation(env.room, true);
    const diag = await getRoomAudioStats(env.room);
    expect(diag).toMatchObject({
      roomState: ConnectionState.Connected,
      serverUrl: "wss://proj.livekit.cloud",
      local: {
        published: true,
        muted: false,
        krispEnabled: true,
        bitrateBps: 72_000,
        settings: {
          deviceId: "builtin-mic",
          sampleRate: 48_000,
          echoCancellation: true,
          noiseSuppression: false,
          voiceIsolation: false,
        },
        sender: { packetsSent: 500, packetsLost: 2 },
      },
      remotes: [
        {
          identity: "u2",
          name: "Tushar",
          bitrateBps: 68_000,
          concealedSamples: 480,
          // 480 concealed out of 10s * 48,000 = 480,000 total samples -> 0.001
          concealedRatio: 0.001,
        },
      ],
    });
  });
});
