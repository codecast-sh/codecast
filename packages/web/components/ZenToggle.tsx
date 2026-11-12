"use client";

// Zen mode's one control, in the top bar. The arrows say what pressing does to
// the chrome: inward folds it away, outward brings it back. In zen the bar is
// hidden; resting the pointer on the window's top edge slides it back down
// with this toggle on it (ZenBarPeek).

import { Maximize2, Minimize2 } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useShortcuts } from "../shortcuts";
import { useTipActions } from "../tips";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { TopbarButton } from "./TopbarButton";

export function ZenToggle() {
  const zen = useInboxStore((s) => s.clientState.ui?.zen_mode ?? false);
  const { dispatchAction } = useShortcuts();
  const tipActions = useTipActions();
  const label = zen ? "Exit zen mode" : "Enter zen mode";
  return (
    <ShortcutTooltip label={label} action="ui.zenToggle" side="bottom">
      <TopbarButton
        onClick={(e) => { dispatchAction("ui.zenToggle"); tipActions.whisper("ui.zenToggle", e); }}
        aria-label={label}
        desktopOnly
      >
        {zen ? <Maximize2 /> : <Minimize2 />}
      </TopbarButton>
    </ShortcutTooltip>
  );
}
