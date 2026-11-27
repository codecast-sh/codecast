// Settings › Voice: recognizing the person's own voice in voice notes
// (docs/architecture/speaker-attribution.md, "Enrollment and consent"). The
// switch lives on currentUser.voice_id_enabled and is off by default; turning
// it on grants collection, so it goes through the consequential review. Off
// deletes every sample: with samples it arms first (the Delete button becomes
// "Turn off · delete N"), with none it is one press. Writes are store actions
// (setVoiceIdEnabled, deleteMyVoiceprints); counts come from useMyVoiceprint.
// Above it, the Dictation switch (currentUser.dictation_enabled, store
// setDictationEnabled) shows the composer mic. When any of the person's teams
// has no OpenAI BAA, the row names that team (openAiBlock, the line the mic
// says); the switch still works, so the dimmed mic can be turned off here.
import { useRef, useState } from "react";
import { AudioLines, Trash2 } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useMyVoiceprint } from "../../hooks/useSyncCalls";
import { useRelativeTime } from "../../lib/conversationFormat";
import { useEventListener } from "../../hooks/useEventListener";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { Switch } from "../ui/switch";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";
import { settleSpeakerWrite } from "../calls/speakerContext";
import { SettingsRow, SettingsSection } from "./ui";
import { voiceIdLedger } from "./voiceIdLedger";
import { openAiBlock } from "../../lib/dictation/teamBlock";

export function VoiceSettings({ pad }: { pad?: string }) {
  const enabled = useInboxStore((s) => (s.currentUser as { voice_id_enabled?: boolean } | null | undefined)?.voice_id_enabled === true);
  const dictation = useInboxStore((s) => (s.currentUser as { dictation_enabled?: boolean } | null | undefined)?.dictation_enabled === true);
  const dictationBlocked = useInboxStore(openAiBlock);
  const mine = useMyVoiceprint();
  const ago = useRelativeTime();
  const [arming, setArming] = useState<null | "delete" | "off">(null);
  const button = useRef<HTMLButtonElement>(null);
  const count = mine?.count ?? 0;
  const write = (on: boolean) => {
    setArming(null);
    settleSpeakerWrite(useInboxStore.getState().setVoiceIdEnabled(on));
  };
  const press = () => {
    if (arming === "off") return write(false);
    if (arming === null) return setArming("delete");
    setArming(null);
    settleSpeakerWrite(useInboxStore.getState().deleteMyVoiceprints());
  };
  // An armed button disarms on any press elsewhere (Safari never focuses a
  // pressed button, so blur alone would leave it armed) and on Esc.
  useEventListener(
    "pointerdown",
    (e) => {
      if (!button.current?.contains(e.target as Node)) setArming(null);
    },
    arming ? document : null,
  );
  useWatchEffect(() => {
    if (arming === "off") button.current?.focus();
  }, [arming]);
  return (
    <SettingsSection title="Voice" icon={AudioLines}>
      {/* A plain switch: on only shows the composer mic; nothing records until it is pressed. */}
      <SettingsRow label="Dictation" description={dictationBlocked ?? undefined} className={pad}>
        <Switch checked={dictation} onCheckedChange={(on) => settleSpeakerWrite(useInboxStore.getState().setDictationEnabled(on))} aria-label="Dictation" />
      </SettingsRow>
      <SettingsRow label="Recognize my voice in recordings" className={pad}>
        <ConsequentialSwitch
          on={enabled}
          ledger={voiceIdLedger()}
          onTurnOn={() => write(true)}
          onTurnOff={() => (count > 0 ? setArming("off") : write(false))}
          trigger={({ on, press: toggle, reviewing }) => (
            <Switch checked={on} onCheckedChange={toggle} aria-label="Recognize my voice in recordings" aria-haspopup={on ? undefined : "dialog"} aria-expanded={on ? undefined : reviewing} />
          )}
        />
      </SettingsRow>
      <SettingsRow label="Samples" disabled={!enabled && count === 0} className={pad}>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[12px] tabular-nums text-sol-text-muted" data-testid="voice-samples">
            {mine === undefined ? "–" : count}
            {count > 0 && mine?.last_added_at ? <span className="text-sol-text-dim"> · {ago(mine.last_added_at)}</span> : null}
          </span>
          <button
            ref={button}
            type="button"
            disabled={count === 0}
            onClick={press}
            onKeyDown={(e) => e.key === "Escape" && setArming(null)}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 ${
              arming ? "bg-sol-red text-white" : "text-sol-red hover:bg-sol-red/10"
            }`}
          >
            <Trash2 className="h-3.5 w-3.5" /> {arming === "off" ? `Turn off · delete ${count}` : arming ? `Delete ${count}` : "Delete samples"}
          </button>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
