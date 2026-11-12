// The terminal line of a permission ask (`cast decide --run`), drawn small at
// the card's foot for whoever would rather type it. The transcript card and the
// queue row both draw it.
import { fallbackLine, type CommandRun } from "@codecast/shared/contracts/commandRun";
import { SquareTerminal } from "lucide-react";
import { cn } from "@/lib/utils";

type Run = Pick<CommandRun, "argv" | "cwd" | "state">;

/** The line a person at a terminal types instead of pressing Yes, at the foot of the card while it waits. */
export function RunFallbackLine({ run, className }: { run: Run | undefined; className?: string }) {
  if (!run || run.state !== "waiting") return null;
  const line = fallbackLine(run);
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5 text-meta text-sol-text-dim", className)} data-run-fallback>
      <SquareTerminal className="size-3 shrink-0" aria-hidden />
      <code className="min-w-0 select-all truncate font-mono" title={line}>{line}</code>
    </div>
  );
}
