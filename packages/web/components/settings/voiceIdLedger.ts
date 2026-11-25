// The review before a person lets voice notes recognize them
// (components/consequential): what is kept, who sees it, how it is used and
// how to stop. Plain data, so it is tested without a browser.
import type { SwitchLedger } from "../consequential/ConsequentialSwitch";

/** At most this many samples per person (convex voiceprints.MAX_SAMPLES_PER_ENGINE). */
export const VOICE_SAMPLES_KEPT = 50;

export function voiceIdLedger(): SwitchLedger {
  return {
    name: "Recognize my voice",
    subject: "",
    figures: [],
    rows: [
      { k: "Keeps", v: `up to ${VOICE_SAMPLES_KEPT} voice samples` },
      { k: "From", v: "recordings you're named in" },
      { k: "Sees them", v: "only you" },
      { k: "Others see", v: "your name, suggested" },
    ],
    stop: "turn off, which deletes every sample",
    confirm: "Turn on",
  };
}
