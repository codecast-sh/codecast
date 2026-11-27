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
import { useRef, useState } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Mic, Radio, SquareKanban, Video, Volume2, X } from "lucide-react";
import { useInboxStore, useMyUserId } from "../../store/inboxStore";
import { rememberCamera, rememberMic, rememberDeviceCheck, rememberMicAutoOpen } from "../../lib/calls/joinPrefs";
import { setNoiseCancellation } from "../../lib/calls/callManager";
import { useWalkieDoor } from "../../hooks/useWalkie";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "../settings/ui";
import { MeetingDetectSection } from "../settings/MeetingDetectSection";
import { WalkieCuesBlock } from "../settings/WalkieCuesBlock";
import { DeviceRows } from "./DeviceRows";
import { SelectBox } from "../ui/select-box";
import { setHuddleSettings, useHuddleSetting } from "../../lib/calls/huddleSettings";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";
import { autoScribeLedger } from "../consequential/ledgers";

export function CallSettings({ compact = false }: { compact?: boolean }) {
  // Read straight off the store so a toggle made mid-call (setCamera/setMuted
  // remember on the person's own presses) shows here without a refresh.
  // Absent means ON — see lib/calls/joinPrefs — so only an explicit false is off.
  const cameraOn = useInboxStore((s) => s.clientState?.ui?.call_camera_on !== false);
  const micOn = useInboxStore((s) => s.clientState?.ui?.call_mic_on !== false);
  const micAutoOpen = useInboxStore((s) => s.clientState?.ui?.call_mic_auto_open !== false);
  const noiseCancellation = useInboxStore((s) => s.clientState?.ui?.call_noise_cancellation !== false);
  const deviceCheck = useInboxStore((s) => s.clientState?.ui?.call_device_check !== false);
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
        <SettingsRow label="Check camera and mic first" description="Starting or answering a call shows your camera and mic before you go in." className={pad}>
          <Switch checked={deviceCheck} onCheckedChange={rememberDeviceCheck} aria-label="Check camera and mic before a call" />
        </SettingsRow>
      </SettingsSection>

      <HuddlesSection pad={pad} />

      <SettingsSection
        title="Microphone"
        icon={Mic}
        description="Voice clarity and when the app may hold your microphone open."
      >
        <SettingsRow
          label="Noise cancellation"
          description="Filters typing, fans and room noise with Krisp without muffling your voice."
          className={pad}
        >
          <Switch
            checked={noiseCancellation}
            onCheckedChange={(v) => void setNoiseCancellation(v)}
            aria-label="Noise cancellation"
          />
        </SettingsRow>
        <SettingsRow
          label="Open before I press"
          description={
            micAutoOpen
              ? "Your mic opens while you rest on a talk button or a teammate's face, so the first word is heard the moment you press. It closes about a minute after you move away."
              : "Your mic opens only while you hold the talk key, unmute in a call, or press record. The first word of a talk may take a beat longer to reach them."
          }
          alignTop
          className={pad}
        >
          <Switch checked={micAutoOpen} onCheckedChange={rememberMicAutoOpen} aria-label="Microphone opens before I press" />
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

/** How huddles start in one workspace (lib/calls/huddleSettings): the
 *  person's own, chosen per workspace, the active one first. */
export function HuddlesSection({ pad }: { pad?: string }) {
  const teams = useInboxStore((s: any) => s.teams as Array<{ _id: string; name?: string }> | undefined) ?? [];
  const me = useMyUserId();
  const activeTeam = useInboxStore((s) => s.clientState?.ui?.active_team_id ?? null);
  // Personal (the person's own huddles: solo, a private session's room) or a
  // team, keyed as huddleWorkspace keys a huddle. Starts on the active workspace.
  const [picked, setPicked] = useState<string | null>(null);
  const choice = picked ?? activeTeam ?? "personal";
  const workspace = choice === "personal" ? (me ? `user:${me}` : null) : `team:${choice}`;
  const workspaceName = choice === "personal" ? "Personal" : teams.find((t) => t._id === choice)?.name ?? "this workspace";
  const boardView = useHuddleSetting("huddleBoardView", workspace);
  const autoScribe = useHuddleSetting("huddleAutoScribe", workspace);
  if (!workspace) return null;
  return (
    <SettingsSection
      title={
        <span className="flex items-center gap-1.5">
          Huddles in
          <SelectBox
            variant="bare"
            value={choice}
            onChange={(e) => setPicked(e.target.value)}
            aria-label="Workspace"
            className="normal-case tracking-normal"
          >
            <option value="personal">Personal</option>
            {teams.map((t) => (
              <option key={t._id} value={t._id}>
                {t.name ?? "Team"}
              </option>
            ))}
          </SelectBox>
        </span>
      }
      icon={SquareKanban}
      description="Yours, for every huddle in this workspace."
    >
      <SettingsRow label="Open huddles on the board" description="The board takes the stage when you join." className={pad}>
        <Switch checked={boardView} onCheckedChange={(v) => setHuddleSettings(workspace, { huddleBoardView: v })} aria-label="Open huddles on the board" />
      </SettingsRow>
      <SettingsRow label="Invite Scribe to every huddle" description="One Scribe per call." className={pad}>
        {/* An agent on the person's account in every huddle: on goes through the review, off is one press. */}
        <ConsequentialSwitch
          on={autoScribe}
          ledger={autoScribeLedger({ workspace: workspaceName })}
          onTurnOn={() => setHuddleSettings(workspace, { huddleAutoScribe: true })}
          onTurnOff={() => setHuddleSettings(workspace, { huddleAutoScribe: false })}
          trigger={({ on, press }) => <Switch checked={on} onCheckedChange={press} aria-label="Invite Scribe to every huddle" />}
        />
      </SettingsRow>
    </SettingsSection>
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
