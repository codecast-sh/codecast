import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  getDesktopWindowRole,
  hasVoiceHost,
  installWindowRoleTracker,
  isVoiceHost,
  sendVoiceCommand,
  voiceHostElsewhere,
} from "../desktop";
import {
  applyVoiceMirror,
  getWalkieStatus,
  observeWalkie,
  refreshWalkie,
  runVoiceCommand,
  startBurst,
  walkieCallState,
} from "../calls/walkie";
import { runCallCommand } from "../calls/callManager";
import { walkieDoorOpen } from "../calls/walkieDoor";
import { useInboxStore } from "../../store/inboxStore";

// ONE MICROPHONE, MANY WINDOWS.
//
// On a desktop with a voice host, the call panel window is persistent and is
// the only renderer that ever joins a room: the walkie's ear, the burst and
// the call all live there, so a burst becoming a call is that window changing
// shape and never a second window joining and evicting the first. Every other
// window is a remote — it sends its gestures there and draws the mirror the
// host sends back. These pin the two sides of that arrangement as the web
// layer sees them: the bridge, the door, the engine as a remote, and the host
// carrying a command out.

const original = (globalThis as any).window;

type Shell = {
  /** Push a window role, the way the shell does. */
  role: (r: any) => void;
  commands: Array<[string, unknown[]]>;
  shown: number;
  bridge: Record<string, unknown>;
};

// The role tracker installs once per module and keeps the first bridge's
// callback, exactly as it does in the app; every shell below pushes through
// that one callback, while the verbs are read off whichever bridge is current.
let roleCb: ((r: any) => void) | null = null;

/** A shell that has a voice host, as the renderer sees it through the bridge. */
function shell(over: { host?: boolean; takes?: boolean } = {}): Shell {
  const s: Shell = { role: (r) => roleCb?.(r), commands: [], shown: 0, bridge: {} };
  s.bridge = {
    isCallPanelWindow: !!over.host,
    voiceHostReady: () => {},
    onWindowRole: (cb: any) => {
      roleCb = cb;
    },
    voiceCommand: async (cmd: string, args: unknown[]) => {
      s.commands.push([cmd, args]);
      return over.takes !== false;
    },
    showCallPanel: async () => {
      s.shown += 1;
      return true;
    },
    reportWindowState: () => {},
  };
  (globalThis as any).window = { __CODECAST_ELECTRON__: s.bridge, addEventListener: () => {}, removeEventListener: () => {} };
  installWindowRoleTracker();
  return s;
}

const ROLE = { leader: true, appFocused: true, anyInCall: false, peopleWindow: false, callPanel: false, facesOverlay: false };

beforeEach(() => {
  useInboxStore.getState().setCallState({ roomKey: null, phase: "idle", muted: true });
});

afterEach(() => {
  // Module state outlives this file under `bun test`: the role, the mirror,
  // the store's call slice and the engine's status are all shared with
  // whatever runs next, so each test hands back an app with no shell, no
  // host, no call and a blank walkie.
  useInboxStore.getState().setCallState({ roomKey: null, phase: "idle", muted: true });
  roleCb?.({ ...ROLE });
  (globalThis as any).window = {};
  applyVoiceMirror({
    walkie: { sending: null, incoming: null, liveRoom: null, unavailable: "not-ready", canReply: false, asr: "live", error: null },
    call: { roomKey: null, phase: "idle", muted: true, micDenied: false, camera: false },
  });
  (globalThis as any).window = original;
});

describe("the bridge: who is the host, and whether one exists", () => {
  it("a browser has no host and is nobody's remote", () => {
    (globalThis as any).window = {};
    expect(isVoiceHost()).toBe(false);
    expect(hasVoiceHost()).toBe(false);
    expect(voiceHostElsewhere()).toBe(false);
  });

  it("the call panel window on a shell with the host verb IS the host", () => {
    shell({ host: true });
    expect(isVoiceHost()).toBe(true);
    expect(hasVoiceHost()).toBe(true);
    expect(voiceHostElsewhere()).toBe(false);
  });

  it("every other window learns of the host from the role push, and becomes a remote", () => {
    const s = shell();
    expect(hasVoiceHost()).toBe(false);
    s.role({ ...ROLE, voiceWindow: true });
    expect(getDesktopWindowRole().voiceWindow).toBe(true);
    expect(hasVoiceHost()).toBe(true);
    expect(voiceHostElsewhere()).toBe(true);
    // A shell that never mentions it (an older build) means "no host", never
    // undefined — and every window keeps its own microphone as before.
    s.role({ ...ROLE });
    expect(hasVoiceHost()).toBe(false);
    expect(voiceHostElsewhere()).toBe(false);
  });

  it("a command is taken or it is not, and the caller is told which", async () => {
    const s = shell();
    expect(await sendVoiceCommand("startBurst", ["c", "dm:a:b"])).toBe(true);
    expect(s.commands).toEqual([["startBurst", ["c", "dm:a:b"]]]);
    (globalThis as any).window = {};
    expect(await sendVoiceCommand("startBurst", ["c", "dm:a:b"])).toBe(false);
  });
});

describe("the door: the host hears for the whole app", () => {
  // The leader clause is what keeps one teammate's burst from arriving as
  // several voices, one per window. With a host, the host is the leader and
  // nobody else is — the shell's notification leader (the buddy list, the
  // focused window) keeps the ring and the knock and gives up the walkie.
  const open = { callsOn: true, atMachine: true, snoozed: false, pref: "team", status: "online" };

  it("opens for the leader and shuts for everybody else", () => {
    expect(walkieDoorOpen({ ...open, leader: true })).toBe(true);
    expect(walkieDoorOpen({ ...open, leader: false })).toBe(false);
  });
});

describe("the engine as a remote", () => {
  it("draws the host's status and call facts off the mirror, not its own idle slice", () => {
    const s = shell();
    s.role({ ...ROLE, voiceWindow: true });
    const sending = {
      channelId: "c1",
      roomKey: "dm:a:b",
      clientId: "burst-1",
      messageId: null,
      startedAt: 1,
      live: true,
      heardLive: true,
      openAt: 2,
      transcript: "",
    };
    applyVoiceMirror({
      walkie: { ...getWalkieStatus(), sending, liveRoom: { key: "dm:a:b", mode: "burst", since: 1 } },
      call: { roomKey: "dm:a:b", phase: "connected", muted: false, micDenied: false, camera: false },
    });
    expect(getWalkieStatus().sending?.clientId).toBe("burst-1");
    // This window's own call slice is idle — the host holds the room — and a
    // key reading it would call the burst "dropped".
    expect(useInboxStore.getState().call.phase).toBe("idle");
    expect(walkieCallState()).toEqual({ roomKey: "dm:a:b", phase: "connected", muted: false, micDenied: false });
  });

  it("sends a press to the host with a client id, and paints the bubble here first", async () => {
    const s = shell();
    s.role({ ...ROLE, voiceWindow: true });
    applyVoiceMirror({
      walkie: { ...getWalkieStatus(), sending: null, incoming: null, liveRoom: null },
      call: { roomKey: null, phase: "idle", muted: true, micDenied: false, camera: false },
    });
    await startBurst("chan-1", "dm:a:b");
    expect(s.commands.length).toBe(1);
    const [cmd, args] = s.commands[0];
    expect(cmd).toBe("startBurst");
    expect(args.slice(0, 2)).toEqual(["chan-1", "dm:a:b"]);
    const clientId = String(args[2]);
    expect(clientId.length).toBeGreaterThan(0);
    // A voice message is a message, and a message never waits for a round
    // trip to appear: the stub is in THIS window's store under the same id
    // the host will use, so the server row supersedes both.
    const row = (useInboxStore.getState() as any).chatMessages[clientId];
    expect(row?.channel_id).toBe("chan-1");
    expect(row?.voice?.status).toBe("live");
  });

  it("takes its own bubble back when the host ends a burst the server never saw", async () => {
    // A press paints a stub here under the id the host is told to use. A
    // brushed key the host throws away leaves no server row to supersede it,
    // so the stub would sit in the DM forever as a "live" voice message.
    const s = shell();
    s.role({ ...ROLE, voiceWindow: true });
    const idle = { roomKey: null, phase: "idle", muted: true, micDenied: false, camera: false };
    applyVoiceMirror({ walkie: { ...getWalkieStatus(), sending: null, incoming: null, liveRoom: null }, call: idle });
    await startBurst("chan-2", "dm:a:b");
    const clientId = String(s.commands[s.commands.length - 1][1][2]);
    expect((useInboxStore.getState() as any).chatMessages[clientId]?.voice?.status).toBe("live");
    const sending = { channelId: "chan-2", roomKey: "dm:a:b", clientId, messageId: null, startedAt: 1, live: true, heardLive: false, openAt: null, transcript: "" };
    applyVoiceMirror({ walkie: { ...getWalkieStatus(), sending }, call: idle });
    applyVoiceMirror({ walkie: { ...getWalkieStatus(), sending: null }, call: idle });
    // A beat later, not at once: the server row usually lands first.
    expect((useInboxStore.getState() as any).chatMessages[clientId]).toBeDefined();
    await new Promise((r) => setTimeout(r, 2_200));
    expect((useInboxStore.getState() as any).chatMessages[clientId]).toBeUndefined();
  });

  it("does not listen for itself: a report of live bursts changes nothing here", () => {
    const s = shell();
    s.role({ ...ROLE, voiceWindow: true });
    applyVoiceMirror({
      walkie: { ...getWalkieStatus(), sending: null, incoming: null, liveRoom: null },
      call: { roomKey: null, phase: "idle", muted: true, micDenied: false, camera: false },
    });
    observeWalkie({
      bursts: [{ messageId: "m", channelId: "c", roomKey: "dm:a:b", fromUserId: "u", fromName: "Sam", createdAt: Date.now() }],
      doorOpen: true,
    });
    refreshWalkie();
    expect(getWalkieStatus().incoming).toBeNull();
    expect(getWalkieStatus().liveRoom).toBeNull();
  });

  it("a mirror never lands on the host itself", () => {
    shell({ host: true });
    const before = getWalkieStatus();
    applyVoiceMirror({
      walkie: { ...before, liveRoom: { key: "dm:x:y", mode: "listen", since: 1 } },
      call: { roomKey: "dm:x:y", phase: "connected", muted: false, micDenied: false, camera: false },
    });
    expect(getWalkieStatus().liveRoom).toBe(before.liveRoom);
  });
});

describe("the host carrying a command out", () => {
  it("an unknown command is ignored rather than thrown", async () => {
    shell({ host: true });
    await expect(runVoiceCommand("nonsense", [])).resolves.toBeUndefined();
    await expect(runCallCommand("nonsense", [])).resolves.toBeUndefined();
  });

  it("a deliberate join for another room while talking raises the huddle instead of switching rooms", async () => {
    // What a remote's own join did when a huddle lived in another window: the
    // person is mid-sentence, and a click on a second room must not tear the
    // first one down under them.
    const s = shell({ host: true });
    useInboxStore.getState().setCallState({ roomKey: "dm:a:b", phase: "connected", muted: false });
    await runCallCommand("joinCall", ["dm:c:d", { intent: "deliberate" }]);
    expect(s.shown).toBe(1);
    expect(useInboxStore.getState().call.roomKey).toBe("dm:a:b");
  });
});
