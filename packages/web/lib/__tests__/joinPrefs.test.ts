// What a deliberate join starts with, and what makes it sticky.
//
// The founder: "turn people's cameras on by default and make that sticky as
// well as their mic setting". Two invariants worth pinning: an ABSENT choice
// reads as ON for both camera and mic (a call is for being seen and heard),
// and a choice made once holds until the next choice — only the person's own
// toggle writes it, and writing the same value again is a no-op so a re-render
// never stamps the LWW bag.
import { beforeEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { readJoinPrefs, rememberCamera, rememberDevice, rememberMic, rememberMicAutoOpen } from "../calls/joinPrefs";
import { noteDevices } from "../calls/deviceRank";

const mic = (deviceId: string, label: string) => ({ deviceId, label });

function setUI(ui: Record<string, unknown>) {
  useInboxStore.setState((s: any) => ({ clientState: { ...(s.clientState ?? {}), ui } }) as any);
}

describe("join prefs", () => {
  beforeEach(() => setUI({}));

  test("camera and mic are ON when nothing has been chosen", () => {
    expect(readJoinPrefs()).toMatchObject({ cameraOn: true, micOn: true, micAutoOpen: true });
  });

  test("only an explicit false turns them off", () => {
    setUI({ call_camera_on: false, call_mic_on: false, call_mic_auto_open: false });
    expect(readJoinPrefs()).toMatchObject({ cameraOn: false, micOn: false, micAutoOpen: false });
    setUI({ call_camera_on: undefined, call_mic_on: null, call_mic_auto_open: null });
    expect(readJoinPrefs()).toMatchObject({ cameraOn: true, micOn: true, micAutoOpen: true });
  });

  test("opening ahead of a press is its own switch, apart from the join's mic", () => {
    rememberMicAutoOpen(false);
    expect(readJoinPrefs()).toMatchObject({ micOn: true, micAutoOpen: false });
    rememberMic(false);
    rememberMicAutoOpen(true);
    expect(readJoinPrefs()).toMatchObject({ micOn: false, micAutoOpen: true });
  });

  test("a choice sticks until the next choice", () => {
    rememberCamera(false);
    rememberMic(false);
    expect(readJoinPrefs()).toMatchObject({ cameraOn: false, micOn: false });
    rememberMic(true);
    expect(readJoinPrefs()).toMatchObject({ cameraOn: false, micOn: true });
  });

  test("remembering the current value writes nothing", () => {
    let writes = 0;
    const real = useInboxStore.getState().updateClientUI;
    useInboxStore.setState({ updateClientUI: ((p: any) => { writes++; real(p); }) as any } as any);
    try {
      rememberCamera(true); // already the default
      rememberMic(true);
      expect(writes).toBe(0);
      rememberCamera(false);
      rememberCamera(false);
      expect(writes).toBe(1);
    } finally {
      useInboxStore.setState({ updateClientUI: real } as any);
    }
  });

  test("devices are remembered per kind, by name, across a device id change", () => {
    noteDevices("audioinput", [mic("default", "Default - MacBook Pro Microphone"), mic("m1", "MacBook Pro Microphone"), mic("h1", "WH-1000XM6")]);
    noteDevices("videoinput", [mic("c1", "Studio Display Camera")]);
    rememberDevice("audioinput", "h1");
    rememberDevice("videoinput", "c1");
    expect(readJoinPrefs()).toMatchObject({ micDeviceId: "h1", cameraDeviceId: "c1" });
    // Another origin (the desktop app) salts ids differently; the name still matches.
    noteDevices("audioinput", [mic("default", "Default - WH-1000XM6"), mic("m2", "MacBook Pro Microphone"), mic("h2", "WH-1000XM6")]);
    expect(readJoinPrefs().micDeviceId).toBe("h2");
    rememberDevice("audioinput", "");
    expect(readJoinPrefs().micDeviceId).toBe("h2");
  });

  test("an unranked kind falls back to the id this machine remembered", () => {
    noteDevices("audioinput", [mic("default", "Default - X"), mic("usb-1", "USB Mic")]);
    setUI({ call_mic_device_id: "usb-1" });
    expect(readJoinPrefs().micDeviceId).toBe("usb-1");
  });
});
