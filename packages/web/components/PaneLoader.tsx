// A page's loading state inside the shell (routines, a routine, a to-do).
// Hosted mode shows quiet rows at the page's measure, the way a conversation
// shows TranscriptSkeleton, so moving between pages never flashes the logo,
// which reads as the app restarting. Developer mode keeps AppLoader.
import { AppLoader } from "./AppLoader";
import { useHostedMode } from "../lib/surfaces";

export function PaneLoader({ className = "min-h-[16rem] h-full" }: { className?: string }) {
  if (!useHostedMode()) return <AppLoader className={className} />;
  return (
    <div className={`${className} overflow-hidden pt-10`} role="status" aria-label="Loading" data-pane-skeleton>
      <div className="mx-auto max-w-[950px] space-y-5 px-6">
        <span className="block h-5 w-40 rounded-full bg-sol-text-dim/10 animate-pulse" />
        {[0.7, 0.55, 0.62].map((w) => (
          <span key={w} className="block h-3 rounded-full bg-sol-text-dim/10 animate-pulse" style={{ width: `${w * 100}%` }} />
        ))}
      </div>
    </div>
  );
}
