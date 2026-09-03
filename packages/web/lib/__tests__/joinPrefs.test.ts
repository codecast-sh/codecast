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
import { readJoinPrefs, rememberCamera, rememberDevice, rememberMic } from "../calls/joinPrefs";

function setUI(ui: Record<string, unknown>) {
  useInboxStore.setState((s: any) => ({ clientState: { ...(s.clientState ?? {}), ui } }) as any);
}

describe("join prefs", () => {
  beforeEach(() => setUI({}));

  test("camera and mic are ON when nothing has been chosen", () => {
    expect(readJoinPrefs()).toMatchObject({ cameraOn: true, micOn: true });
  });

  test("only an explicit false turns them off", () => {
    setUI({ call_camera_on: false, call_mic_on: false });
    expect(readJoinPrefs()).toMatchObject({ cameraOn: false, micOn: false });
    setUI({ call_camera_on: undefined, call_mic_on: null });
    expect(readJoinPrefs()).toMatchObject({ cameraOn: true, micOn: true });
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

  test("devices are remembered per kind", () => {
    rememberDevice("audioinput", "mic-1");
    rememberDevice("videoinput", "cam-1");
    expect(readJoinPrefs()).toMatchObject({ micDeviceId: "mic-1", cameraDeviceId: "cam-1" });
    rememberDevice("audioinput", "");
    expect(readJoinPrefs().micDeviceId).toBe("mic-1");
  });
});
