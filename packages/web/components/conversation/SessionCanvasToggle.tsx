import { PanelRight } from "lucide-react";
import { toast } from "sonner";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { HEADER_CHIP } from "../../lib/headerChip";
import { canOpenBeside, stageHasRoom } from "../../lib/stage";
import { hasPaneHost } from "../../lib/browserPane";
import { canvasLeafPath, setSessionCanvas } from "../../lib/sessionCanvas";
import { useSessionCanvas } from "../../hooks/useSessionCanvas";
import { useInboxStore } from "../../store/inboxStore";

/** The header's canvas control: docks the session's published page beside the
 *  transcript and keeps it there as the agent republishes. Mounted for every
 *  session in view, so a session with its canvas off takes another session's
 *  page off the stage. */
export function SessionCanvasToggle({ conversationId }: { conversationId: string }) {
  const { on, pin, target, pages } = useSessionCanvas(conversationId);
  if (pages.length === 0 || hasPaneHost() || !canOpenBeside()) return null;
  const title = target ? (useInboxStore.getState() as any).pageEmbeds?.[target]?.title : undefined;
  const label = on ? `Close canvas${title ? `: ${title}` : ""}` : "Keep the latest page open beside";
  const toggle = () => {
    if (on) return setSessionCanvas(conversationId, false);
    if (!canvasLeafPath() && !stageHasRoom()) {
      toast.error("No room beside this conversation: close a pane first");
      return;
    }
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
        {on && pin && <span className="h-1.5 w-1.5 rounded-full bg-sol-cyan" aria-hidden />}
      </button>
    </ShortcutTooltip>
  );
}

/** Dock one page and hold it there until the person picks another or closes
 *  the canvas: the gallery's "keep beside". */
export function dockSessionPage(conversationId: string, slug: string): boolean {
  const docked = !!canvasLeafPath();
  if (!docked && !stageHasRoom()) {
    toast.error("No room beside this conversation: close a pane first");
    return false;
  }
  setSessionCanvas(conversationId, true, slug);
  return true;
}
