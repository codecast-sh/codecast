import { bridge, isElectron } from "./desktop";

// ---------------------------------------------------------------------------
// Meeting detection (the desktop shell — main.js, meetingDetector.js).
//
// The setting is PER MACHINE, kept in the shell's settings.json rather than in
// the roaming client prefs, and that is a decision rather than an accident.
// Detection happens where the meeting apps run: a laptop with Zoom installed
// and a desktop without it want different answers, "never for Webex" names
// software installed on one machine, and the poller has to read the setting
// with no renderer awake at all.
// ---------------------------------------------------------------------------

/** off: no poller runs. ask: a card offers. auto: recording starts by itself. */
export type MeetingDetectMode = "off" | "ask" | "auto";

/** What the shell says when a meeting app starts. `decision` is the setting's
 *  answer already applied — "ask" means offer, "auto" means start. */
export type MeetingOffer = {
  app: string;
  name: string;
  decision: "ask" | "auto";
  at: number;
};

export type MeetingDetectConfig = {
  mode: MeetingDetectMode;
  /** App ids answered "never for this app". */
  never: string[];
  /** Every app the shell can recognize, so the settings UI holds no second
   *  copy of the table. */
  apps: Array<{ id: string; name: string }>;
  /** macOS only today. False means don't offer the setting at all. */
  supported: boolean;
};

/** Whether this build can detect meetings — false in a browser and on desktop
 *  builds older than this feature. */
export function canDetectMeetings(): boolean {
  return isElectron() && !!bridge("getMeetingDetect");
}

export function getMeetingDetect(): Promise<MeetingDetectConfig | null> {
  return bridge("getMeetingDetect")?.() ?? Promise.resolve(null);
}

export function setMeetingDetect(patch: {
  mode?: MeetingDetectMode;
  never?: string[];
}): Promise<{ mode: MeetingDetectMode; never: string[] } | null> {
  return bridge("setMeetingDetect")?.(patch) ?? Promise.resolve(null);
}

/** Subscribe to the shell's offers. A no-op everywhere it isn't supported, so
 *  the caller needs no gate of its own. */
export function onMeetingDetected(cb: (offer: MeetingOffer) => void): void {
  bridge("onMeetingDetected")?.(cb);
}

/** True only in the shell's dedicated /meeting-offer window. */
export function isMeetingOfferWindow(): boolean {
  return isElectron() && !!window.__CODECAST_ELECTRON__?.isMeetingOfferWindow;
}

/** Report the offer window's content size; the shell reshapes the window and
 *  reveals it (without focus) on the first report. */
export function meetingOfferSize(size: { width: number; height: number }): void {
  bridge("meetingOfferSize")?.(size);
}

export function meetingOfferHide(): void {
  bridge("meetingOfferHide")?.();
}

/** Open a recording's transcript in the main window (the offer window is a
 *  card, not a place to read). */
export function meetingOfferOpenCall(transcriptId: string): void {
  bridge("meetingOfferOpenCall")?.(transcriptId);
}
