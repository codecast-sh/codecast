import { useState } from "react";
import {
  MessageSquare, MousePointerClick, Phone, Play, Radio, Terminal, Volume2, VolumeX,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useInboxStore, type ClientUI } from "../../../store/inboxStore";
import { Switch } from "../../../components/ui/switch";
import { Slider } from "../../../components/ui/slider";
import { Button } from "../../../components/ui/button";
import { SettingsPanel, SettingsRow, SettingsSection } from "../../../components/settings/ui";
import {
  previewSoundCategory, previewWalkieCue, SOUND_CATEGORIES, WALKIE_PREVIEWS,
  type SoundCategory,
} from "../../../lib/sounds";
import { useWalkieDoor } from "../../../hooks/useWalkie";

const CATEGORY_ICONS: Record<SoundCategory, LucideIcon> = {
  sessions: Terminal,
  chat: MessageSquare,
  calls: Phone,
  walkie: Radio,
  ui: MousePointerClick,
};

/** Every switch here gates a cue in lib/sounds.ts; every row can be
 *  auditioned. Previews play even for a switched-off category — hearing a cue
 *  is the only honest basis for deciding whether to enable it. */
export default function SoundsSettingsPage() {
  const enabled = useInboxStore((s) => s.clientState?.ui?.sounds_enabled !== false);
  const updateUI = useInboxStore((s) => s.updateClientUI);

  return (
    <SettingsPanel>
      <SettingsSection
        title="Sound"
        icon={enabled ? Volume2 : VolumeX}
        description={
          enabled
            ? "Cues play on this machine only — each device keeps its own sound settings."
            : "All sounds are off on this machine. Previews still play so you can decide what to turn back on."
        }
        actions={<Switch checked={enabled} onCheckedChange={(v) => updateUI({ sounds_enabled: v })} aria-label="Sound effects" />}
      >
        <VolumeRow disabled={!enabled} />
      </SettingsSection>

      <SettingsSection
        title="What makes a sound"
        description="Which moments this machine announces out loud. The play button auditions each one."
      >
        {SOUND_CATEGORIES.map((c) => (
          <CategoryRow key={c.id} id={c.id} prefKey={c.key} label={c.label} desc={c.desc} masterOn={enabled} />
        ))}
      </SettingsSection>

      <WalkieSection />
    </SettingsPanel>
  );
}

function VolumeRow({ disabled }: { disabled: boolean }) {
  const stored = useInboxStore((s) => {
    const v = s.clientState?.ui?.sound_volume;
    return typeof v === "number" ? v : 1;
  });
  const updateUI = useInboxStore((s) => s.updateClientUI);
  // Local while dragging so the store (and its persistence) sees one write per
  // gesture; the commit also auditions the new level, which is what makes the
  // slider settable by ear rather than by number.
  const [drag, setDrag] = useState<number | null>(null);
  const value = drag ?? stored;
  return (
    <SettingsRow
      label="Volume"
      description="Every cue, scaled together. 100% is the level each cue was tuned at."
      disabled={disabled}
    >
      <div className="flex w-48 items-center gap-3 sm:w-64">
        <Slider
          value={value}
          min={0}
          max={1.5}
          step={0.05}
          disabled={disabled}
          aria-label="Sound volume"
          onValueChange={setDrag}
          onValueCommit={(v) => {
            setDrag(null);
            updateUI({ sound_volume: v });
            previewSoundCategory("chat");
          }}
        />
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-sol-text-muted">
          {Math.round(value * 100)}%
        </span>
      </div>
    </SettingsRow>
  );
}

function CategoryRow({ id, prefKey, label, desc, masterOn }: {
  id: SoundCategory;
  prefKey: keyof ClientUI;
  label: string;
  desc: string;
  masterOn: boolean;
}) {
  const on = useInboxStore((s) => s.clientState?.ui?.[prefKey] !== false);
  const snoozedUntil = useInboxStore((s) => (id === "chat" ? s.clientState?.ui?.chat_snooze_until ?? 0 : 0));
  const updateUI = useInboxStore((s) => s.updateClientUI);
  const snoozed = snoozedUntil > Date.now();
  return (
    <SettingsRow
      icon={CATEGORY_ICONS[id]}
      label={label}
      disabled={!masterOn}
      description={
        <>
          {desc}
          {snoozed && (
            <span className="mt-0.5 block text-sol-orange">
              Snoozed until {new Date(snoozedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              {" · "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-sol-text"
                onClick={() => updateUI({ chat_snooze_until: 0 })}
              >
                resume now
              </button>
            </span>
          )}
        </>
      }
    >
      <PreviewButton label={label} onClick={() => previewSoundCategory(id)} />
      <Switch
        checked={on}
        disabled={!masterOn}
        onCheckedChange={(v) => updateUI({ [prefKey]: v } as Partial<ClientUI>)}
        aria-label={`${label} sounds`}
      />
    </SettingsRow>
  );
}

function PreviewButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Preview the ${label} sound`}
      title="Hear it"
      className="flex h-7 w-7 items-center justify-center rounded-md text-sol-text-dim transition-colors hover:bg-sol-cyan/10 hover:text-sol-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan/50"
    >
      <Play className="h-3.5 w-3.5" />
    </button>
  );
}

function WalkieSection() {
  const { open, setOpen } = useWalkieDoor();
  return (
    <SettingsSection
      title="Walkie"
      icon={Radio}
      description="Push-to-talk between teammates: live voice, out loud, the moment they say it."
    >
      <SettingsRow
        label="Let teammates talk to me"
        description="A teammate holding push-to-talk in your DM is heard out loud here, the moment they say it. Turn this off and their voice message still arrives in the chat with its transcript — it just waits to be read."
        alignTop
      >
        <Switch checked={open} onCheckedChange={setOpen} aria-label="Let teammates talk to me" />
      </SettingsRow>
      <WalkieCuesBlock />
    </SettingsSection>
  );
}

/** The six walkie cues, each with a button that plays it.
 *
 *  Every other sound in the app answers something a person did or something
 *  that arrived, so nobody ever hears one on purpose and nobody can say
 *  whether it is right. These cues had been four times too quiet for months
 *  before the founder put it in words. This block is where they can be heard
 *  on demand, which is the only way that stays checkable. */
export function WalkieCuesBlock() {
  return (
    <div className="px-4 py-3.5 sm:px-5">
      <div className="text-sm text-sol-text">The six cues</div>
      <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-sol-text-muted">
        Live and Roger are your own key going down and coming up, Incoming and Ended are a
        teammate&apos;s burst, Joined is someone stepping into yours, Away means nobody was live
        and it went as a message.
      </p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {WALKIE_PREVIEWS.map((cue) => (
          <Button key={cue.id} variant="outline" size="sm" onClick={() => previewWalkieCue(cue.spec)}>
            {cue.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
