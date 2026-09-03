// EVERY SETTING A CALL HAS, IN ONE PLACE.
//
// The founder: "put these meeting settings globally into a call settings thing
// that pops out of the people window". So the same body renders two ways: as
// a sheet that slides over the buddy list (CallSettingsSheet), and as the
// Calls section of the settings modal (app/settings/calls). Nothing here is
// its own source of truth — each block is the control the rest of the app
// already reads: the join prefs (lib/calls/joinPrefs), the device picker the
// stage uses (DeviceRows), the walkie door (useWalkieDoor), the sound gate and
// the cue previews (Sounds), and the desktop's meeting recorder mode
// (MeetingDetectSection). A person who changes something here changes it
// everywhere, because there is only one thing to change.
import { useRef } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Mic, Radio, Video, Volume2, X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { rememberCamera, rememberMic } from "../../lib/calls/joinPrefs";
import { useWalkieDoor } from "../../hooks/useWalkie";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "../settings/ui";
import { MeetingDetectSection } from "../settings/MeetingDetectSection";
import { WalkieCuesBlock } from "../settings/WalkieCuesBlock";
import { DeviceRows } from "./DeviceRows";

export function CallSettings({ compact = false }: { compact?: boolean }) {
  // Read straight off the store so a toggle made mid-call (setCamera/setMuted
  // remember on the person's own presses) shows here without a refresh.
  // Absent means ON — see lib/calls/joinPrefs — so only an explicit false is off.
  const cameraOn = useInboxStore((s) => s.clientState?.ui?.call_camera_on !== false);
  const micOn = useInboxStore((s) => s.clientState?.ui?.call_mic_on !== false);
  const soundsOn = useInboxStore((s) => s.clientState?.ui?.sounds_enabled !== false);
  const updateUI = useInboxStore((s) => s.updateClientUI);
  const door = useWalkieDoor();
  const pad = compact ? "px-3 sm:px-3" : undefined;
  return (
    <div className={compact ? "space-y-3" : "space-y-5"}>
      <SettingsSection
        title="When I join a call"
        icon={Video}
        description="How every call starts for you. Turning your camera or mic on or off during a call sets this too, so the next call starts the way the last one ended."
      >
        <SettingsRow label="Camera on" description="You are seen from the first second." className={pad}>
          <Switch checked={cameraOn} onCheckedChange={rememberCamera} aria-label="Camera on when I join" />
        </SettingsRow>
        <SettingsRow label="Microphone on" description="You are heard from the first word." className={pad}>
          <Switch checked={micOn} onCheckedChange={rememberMic} aria-label="Microphone on when I join" />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Devices"
        icon={Mic}
        description="Which microphone, speaker and camera a call opens. Remembered on this machine."
        padded
      >
        <div className="space-y-2">
          <DeviceRows compact={compact} />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Walkie"
        icon={Radio}
        description="A teammate talks, you hear them out loud the moment they say it, and hear nobody back until you step in."
      >
        <SettingsRow
          label="Let teammates talk to me"
          description={
            door.snoozed
              ? "Snoozed for the hour. Turn this on to open the door again — their words arrive as messages either way."
              : "Their voice plays out loud here. Turn this off and it still arrives in the chat with its transcript — it just waits to be read."
          }
          alignTop
          className={pad}
        >
          <Switch checked={door.open} onCheckedChange={door.setOpen} aria-label="Let teammates talk to me" />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Sounds"
        icon={Volume2}
        description="The cues a call and a walkie make on this machine."
      >
        <SettingsRow label="Sound effects" description="Every cue in the app, on or off." className={pad}>
          <Switch checked={soundsOn} onCheckedChange={(v) => updateUI({ sounds_enabled: v })} aria-label="Sound effects" />
        </SettingsRow>
        <WalkieCuesBlock />
      </SettingsSection>

      {/* Renders nothing in a browser or on a build without detection. */}
      <MeetingDetectSection />
    </div>
  );
}

/**
 * The sheet the people window opens: the panel body over the roster, its own
 * heading, one way out. It covers the roster rather than pushing it, because
 * the window is 320px wide and a settings form beside a buddy list would leave
 * neither readable. Escape and the X both close it; focus lands on the heading
 * so a keyboard user knows where they are.
 */
export function CallSettingsSheet({ onClose }: { onClose: () => void }) {
  const headRef = useRef<HTMLHeadingElement>(null);
  useMountEffect(() => {
    headRef.current?.focus();
  });
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="call-settings-heading"
      className="people-sheet"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="people-sheet-head">
        <h2 id="call-settings-heading" ref={headRef} tabIndex={-1} className="people-sheet-title">
          Call settings
        </h2>
        <button type="button" onClick={onClose} aria-label="Close call settings" className="people-sheet-close">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="people-sheet-body people-scroll">
        <CallSettings compact />
      </div>
    </div>
  );
}
