import { useEffect, type ReactNode } from "react";
import { toast } from "sonner";

/**
 * Carry a status notice as a floating card instead of a strip in the layout.
 *
 * The status strips (offline, storage, CLI offline, tmux missing) used to sit
 * in DashboardLayout's flow above the tab bar, so every appearance pushed the
 * whole UI down and every clear snapped it back — a status that flaps reads
 * as the page jumping. A sonner toast with no timeout holds the same content
 * in the corner: keyed by id so a re-render updates the one card in place,
 * dismissed the moment the condition clears or the owner unmounts.
 *
 * Call it unconditionally with `null` while the notice has nothing to say.
 */
export function useStatusToast(id: string, content: ReactNode | null) {
  useEffect(() => {
    if (content == null) {
      toast.dismiss(id);
      return;
    }
    toast.custom(
      () => (
        <div className="w-[356px] max-w-[calc(100vw-2rem)] rounded-lg bg-sol-card shadow-lg overflow-hidden">
          {content}
        </div>
      ),
      { id, duration: Infinity },
    );
  }, [id, content]);
  useEffect(() => () => { toast.dismiss(id); }, [id]);
}
