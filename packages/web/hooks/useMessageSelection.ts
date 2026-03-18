import { useCallback } from "react";
import { useForkNavigationStore } from "../store/forkNavigationStore";
import { useEventListener } from "./useEventListener";

type TimelineItem = {
  type: string;
  data: { _id: string; role?: string; message_uuid?: string; content?: string; subtype?: string };
  timestamp: number;
};

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function useMessageSelection({
  timeline,
  virtualizer,
  onForkFromMessage,
  onSelectMessage,
  enabled = true,
}: {
  timeline: TimelineItem[];
  virtualizer: { scrollToIndex: (index: number, opts?: any) => void } | null;
  onForkFromMessage?: (messageUuid: string) => void;
  onSelectMessage?: (messageUuid: string | null, content: string | null) => void;
  enabled?: boolean;
}) {
  const selectedIndex = useForkNavigationStore((s) => s.selectedIndex);
  const setSelectedIndex = useForkNavigationStore((s) => s.setSelectedIndex);

  const getUserMessageIndices = useCallback((): number[] => {
    const SKIP_PREFIXES = ["[Request interrupted", "This session is being continued", "<task-notification>", "<system-reminder>"];
    const indices: number[] = [];
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.type !== "message") continue;
      if (item.data.role !== "human" && item.data.role !== "user") continue;
      if (item.data.subtype) continue;
      const content = (item.data.content || "").trim();
      if (!content || SKIP_PREFIXES.some(p => content.startsWith(p))) continue;
      indices.push(i);
    }
    return indices;
  }, [timeline]);

  const selectAndNotify = useCallback((index: number | null) => {
    setSelectedIndex(index);
    if (index === null) {
      onSelectMessage?.(null, null);
      return;
    }
    const item = timeline[index];
    if (item?.type === "message" && item.data.message_uuid) {
      onSelectMessage?.(item.data.message_uuid, item.data.content || null);
    }
    if (index !== null && virtualizer) {
      virtualizer.scrollToIndex(index, { align: "center" });
    }
  }, [timeline, virtualizer, setSelectedIndex, onSelectMessage]);

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!enabled) return;

    if (e.key === "Escape" && selectedIndex !== null) {
      e.preventDefault();
      e.stopImmediatePropagation();
      selectAndNotify(null);
      return;
    }

    if (e.altKey && (e.code === "KeyJ" || e.code === "KeyK")) {
      if (isInputFocused()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const indices = getUserMessageIndices();
      if (indices.length === 0) return;

      if (selectedIndex === null) {
        selectAndNotify(indices[indices.length - 1]);
        return;
      }

      const currentPos = indices.indexOf(selectedIndex);
      if (currentPos === -1) {
        const closest = indices.reduce((best, idx) =>
          Math.abs(idx - selectedIndex) < Math.abs(best - selectedIndex) ? idx : best
        );
        selectAndNotify(closest);
        return;
      }

      if (e.code === "KeyK") {
        const next = currentPos > 0 ? indices[currentPos - 1] : selectedIndex;
        selectAndNotify(next);
      } else {
        const next = currentPos < indices.length - 1 ? indices[currentPos + 1] : selectedIndex;
        selectAndNotify(next);
      }
      return;
    }

    if (e.altKey && e.code === "KeyF" && selectedIndex !== null) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const item = timeline[selectedIndex];
      if (item?.type === "message" && item.data.message_uuid && onForkFromMessage) {
        selectAndNotify(null);
        onForkFromMessage(item.data.message_uuid);
      }
      return;
    }
  }, undefined, { capture: true });

  return { selectedIndex };
}
