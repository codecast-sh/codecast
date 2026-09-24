import { ArrowRight, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { startSharingAgent } from "../../lib/sharingAgent";
import { cn } from "../../lib/utils";

/** Start the sharing agent and say where it went. */
export function launchSharingAgent(): void {
  startSharingAgent();
  toast.success("Agent started", {
    description: "It reads your folders first, then asks you. Nothing changes until you agree.",
  });
}

/**
 * "Decide with an agent" on the Sync & Privacy page: an agent reads the same
 * folders and teams this page lists, recommends a setting for each, and
 * applies what the person agrees to through `cast sharing`. The page updates
 * as it goes, so it opens beside it.
 */
export function SharingAgentCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border border-sol-cyan/30 px-4 py-3.5 sm:px-5",
        "bg-[radial-gradient(120%_140%_at_0%_0%,color-mix(in_srgb,var(--sol-cyan)_14%,transparent),transparent_60%)]",
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sol-cyan/15 text-sol-cyan">
            <Sparkles className="h-4 w-4 transition-transform duration-300 group-hover:rotate-12" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-sol-text">Decide with an agent</div>
            <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-sol-text-muted">
              It looks through your folders and session titles, recommends what should sync and what each team sees, and asks
              before it changes anything. The conversation stays private to you.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={launchSharingAgent}
          className="inline-flex shrink-0 items-center justify-center gap-1.5 self-start rounded-md bg-sol-cyan px-3 py-1.5 text-xs font-medium text-sol-base03 transition-opacity hover:opacity-90 sm:self-center"
        >
          Start
          <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
        </button>
      </div>
    </div>
  );
}
