// The phone's Stop asks once more, in the web's own words, and only the
// destructive answer stops the room's recording, through the shared press.
// Run: bun test lib/calls/recordingMark.test.ts
import { beforeAll, beforeEach, expect, mock, test } from "bun:test";

let alerts: Array<{ title: string; body: string; buttons: any[] }> = [];
const presses: Array<{ roomKey: string; on: boolean }> = [];
let haptics = 0;

mock.module("react-native", () => ({
  Alert: { alert: (title: string, body: string, buttons: any[]) => alerts.push({ title, body, buttons }) },
}));
mock.module("expo-haptics", () => ({
  impactAsync: async () => void haptics++,
  ImpactFeedbackStyle: { Light: "light" },
}));
mock.module("@codecast/web/lib/calls/recordingPress", () => ({
  pressRoomRecording: async (roomKey: string, on: boolean) => void presses.push({ roomKey, on }),
  useRoomRecordingMark: () => ({ status: null, live: null }),
}));
mock.module("@codecast/web/store/inboxStore", () => ({ useInboxStore: () => undefined }));

let useConfirmStopRecording: typeof import("./recordingMark").useConfirmStopRecording;
let STOP_RECORDING_ASK: typeof import("@codecast/web/lib/calls/roomRecordingEnd").STOP_RECORDING_ASK;

beforeAll(async () => {
  ({ useConfirmStopRecording } = await import("./recordingMark"));
  ({ STOP_RECORDING_ASK } = await import("@codecast/web/lib/calls/roomRecordingEnd"));
}, 120_000);

beforeEach(() => {
  alerts = [];
  presses.length = 0;
  haptics = 0;
});

const answer = (text: string) => alerts[0].buttons.find((b) => b.text === text);

test("Stop asks first, in the web's words, with Keep as the cancel", () => {
  useConfirmStopRecording("channel:c1")();
  expect(alerts).toHaveLength(1);
  expect(alerts[0].title).toBe(STOP_RECORDING_ASK.title);
  expect(alerts[0].body).toBe(STOP_RECORDING_ASK.body);
  expect(answer(STOP_RECORDING_ASK.keep).style).toBe("cancel");
  expect(answer(STOP_RECORDING_ASK.stop).style).toBe("destructive");
  expect(presses).toEqual([]);
});

test("only the Stop answer stops, for the room the question was about", () => {
  useConfirmStopRecording("channel:c1")();
  answer(STOP_RECORDING_ASK.stop).onPress();
  expect(presses).toEqual([{ roomKey: "channel:c1", on: false }]);
  expect(haptics).toBe(1);
});

test("with no room to stop, the answer does nothing", () => {
  useConfirmStopRecording(null)();
  answer(STOP_RECORDING_ASK.stop).onPress();
  expect(presses).toEqual([]);
  expect(haptics).toBe(0);
});
