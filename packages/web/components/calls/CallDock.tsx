import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useInboxStore } from "../../store/inboxStore";
import { CallStage } from "./CallStage";
import { useHandCallToPanel } from "../../hooks/useHandCallToPanel";
import { closeCallStage, useCallStageOpen } from "../../lib/calls/callStage";
import { canPopOutCall, voiceHostElsewhere } from "../../lib/desktop";
import "./callSurface.css";

// THE STAGE, AND ONLY THE STAGE (pl-756 F3).
//
// Every small call surface (the walkie strip, the pill, the floating dock
// window) is the face row in the header now, and this component keeps the
// one shape the row cannot be: the full stage, with video, screen share and
// the transcript. It opens only when the person asks (lib/calls/callStage:
// Open the call beside the live card) and closes when they collapse it or
// the call ends. Never on its own: video arriving, a media notice, or a flag
// nobody reset used to open it, and a stage that opens by itself over the
// work is the wrong weight for a voice.
//
// It also mounts the desktop handoff (useHandCallToPanel): on an older shell a
// huddle that starts in this window moves to the call window the moment it is
// a call, and that rule has to live somewhere on every page.
export function CallDock() {
  useHandCallToPanel();
  const open = useCallStageOpen();
  const phase = useInboxStore((st) => st.call.phase);
  // THE STAGE BELONGS TO THE CALL THAT WAS EXPANDED, and to no call after it
  // (ct-45974): the next call must not open full screen by itself.
  useWatchEffect(() => {
    if (phase === "idle") closeCallStage();
  }, [phase]);
  if (!open || phase === "idle") return null;
  // A voice host draws the call in its own window; so does the call panel on
  // an older shell. This window's call state is a mirror, and a stage off it
  // would be a second surface for a microphone this window does not hold.
  if (voiceHostElsewhere() || canPopOutCall()) return null;
  return <CallStage onCollapse={closeCallStage} />;
}
