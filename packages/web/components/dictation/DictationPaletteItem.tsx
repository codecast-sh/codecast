// The palette's dictation switch: one row whose words follow the setting, the
// same write as Settings › Voice (store setDictationEnabled).
import { Command as CommandPrimitive } from "cmdk";
import { Mic, MicOff } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";

export function DictationPaletteItem({ className, onDone }: { className?: string; onDone: () => void }) {
  const on = useInboxStore((s) => (s.currentUser as { dictation_enabled?: boolean } | null | undefined)?.dictation_enabled === true);
  const Icon = on ? MicOff : Mic;
  return (
    <CommandPrimitive.Item
      value={`${on ? "Turn off" : "Turn on"} dictation voice speech microphone mic speak talk type transcribe`}
      onSelect={() => {
        onDone();
        void useInboxStore.getState().setDictationEnabled(!on).catch(() => {});
      }}
      className={className}
    >
      <Icon className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
      <span className="truncate flex-1">{on ? "Turn off dictation" : "Turn on dictation"}</span>
    </CommandPrimitive.Item>
  );
}
