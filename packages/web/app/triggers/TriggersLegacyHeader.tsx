import type { ReactNode } from "react";
import { Zap } from "lucide-react";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";

/** The Triggers page's own header, kept for Classic and Minimal (Modern draws
 *  components/ui/page-header). `action` is the page's New trigger button. */
export function TriggersLegacyHeader({ action }: { action: ReactNode }) {
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  return (
    <div ref={titlebarRef} className="flex gap-2 items-center mb-5">
      <Zap className="w-4 h-4 text-sol-amber" />
      <h1 className="text-lg font-semibold text-sol-text whitespace-nowrap">Triggers</h1>
      {action}
    </div>
  );
}
