import { PanelRight } from "lucide-react";
import { toast } from "sonner";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { HEADER_CHIP } from "../../lib/headerChip";
import { canOpenBeside, stageHasRoom } from "../../lib/stage";
import { hasPaneHost } from "../../lib/browserPane";
import { canvasLeafPath, setSessionCanvas } from "../../lib/sessionCanvas";
import { CANVAS_NO_ROOM, useSessionCanvas } from "../../hooks/useSessionCanvas";

/** The header's canvas control: docks the session's published page beside the
 *  transcript and keeps it there as the agent republishes. Mounted for every
 *  session on screen, so a session with its canvas off takes another session's
 *  page off the stage. */
export function SessionCanvasToggle({ conversationId }: { conversationId: string }) {
  const { on, pin, title, pages, claim } = useSessionCanvas(conversationId);
  if (pages.length === 0 || hasPaneHost() || !canOpenBeside()) return null;
  const label = on ? `Close canvas${title ? `: ${title}` : ""}` : "Keep the latest page open beside";
  const toggle = () => {
    claim();
    if (on) return setSessionCanvas(conversationId, false);
    if (!canvasLeafPath() && !stageHasRoom()) return void toast.error(CANVAS_NO_ROOM);
    setSessionCanvas(conversationId, true, null);
  };
  return (
    <ShortcutTooltip label={label} side="bottom">
      <button
        type="button"
        onClick={toggle}
        aria-pressed={on}
        aria-label={on ? "Close canvas" : "Open canvas"}
        data-session-canvas={on ? (pin ? "pinned" : "on") : "off"}
        className={`${HEADER_CHIP} flex-shrink-0 ${on ? "!border-sol-cyan/50 !bg-sol-cyan/15 !text-sol-cyan" : ""}`}
      >
        <PanelRight className="h-3 w-3" />
        {pin && <span className="h-1.5 w-1.5 rounded-full bg-sol-cyan" aria-hidden />}
      </button>
    </ShortcutTooltip>
  );
}

/** Dock one page and hold it there until the person picks another or closes
 *  the canvas: the gallery's "keep beside". */
export function dockSessionPage(conversationId: string, slug: string): boolean {
  if (!canvasLeafPath() && !stageHasRoom()) {
    toast.error(CANVAS_NO_ROOM);
    return false;
  }
  setSessionCanvas(conversationId, true, slug);
  return true;
}
