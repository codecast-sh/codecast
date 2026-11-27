// The session the sidebar holds in place while it places its rows: its
// highlight (lib/inboxRouting sessionListActiveIdOf, read for this page's
// path), else the attended conversation, exactly as GlobalSessionPanel
// places them. Web only: the phone holds its currentSessionId.
import { usePathname } from "next/navigation";
import { sessionListActiveIdOf } from "../lib/inboxRouting";
import { useInboxStore } from "../store/inboxStore";

export function useSidebarFocusId(): string | null {
  const pathname = usePathname();
  return useInboxStore((st) => sessionListActiveIdOf(st, pathname ?? null) ?? st.currentSessionId ?? null);
}
