// What a permission ask's Yes approves (shared/contracts/commandRun.ts
// RunSubject), drawn as structure: the folder, then each piece with its exact
// lines, so the person never approves text they cannot see. RunFallbackLine is
// the terminal line, drawn small at the card's foot for whoever would rather
// type it. The transcript card and the queue row draw both.
import { fallbackLine, type CommandRun } from "@codecast/shared/contracts/commandRun";
import { FolderGit2, SquareTerminal } from "lucide-react";
import { cn } from "@/lib/utils";

type Run = Pick<CommandRun, "argv" | "cwd" | "approves" | "state">;

export function RunSubjectView({ run, className }: { run: Run | undefined; className?: string }) {
  const subject = run?.approves;
  if (!run || !subject) return null;
  return (
    <div className={cn("flex flex-col gap-2", className)} data-run-subject>
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-sol-text-muted" data-run-folder>
        <FolderGit2 className="size-3.5 shrink-0 text-sol-text-dim" aria-hidden />
        <span className="shrink-0 text-sol-text-dim">{subject.title}</span>
        <span className="min-w-0 truncate font-mono" title={subject.folder}>{subject.folder}</span>
      </div>
      {subject.items.map((item) => (
        <div key={item.label} className="overflow-hidden rounded-md border border-sol-border/70" data-run-item={item.label}>
          <div className="flex items-center justify-between gap-2 border-b border-sol-border/60 bg-sol-bg-alt px-2.5 py-1">
            <span className="min-w-0 truncate font-mono text-[11.5px] text-sol-text-muted">{item.label}</span>
            {item.note && (
              <span className={cn("shrink-0 rounded px-1.5 text-[11px]", item.note === "new" ? "bg-sol-blue/10 text-sol-blue" : "bg-sol-orange/12 text-sol-orange")}>
                {item.note}
              </span>
            )}
          </div>
          <ol className="m-0 max-h-56 list-none overflow-auto px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-sol-text">
            {item.lines.map((line, i) => (
              <li key={i} className="whitespace-pre-wrap break-all">{line || " "}</li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

/** The line a person at a terminal types instead of pressing Yes, at the foot of the card while it waits. */
export function RunFallbackLine({ run, className }: { run: Run | undefined; className?: string }) {
  if (!run || run.state !== "waiting") return null;
  const line = fallbackLine(run);
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5 text-[11px] text-sol-text-dim", className)} data-run-fallback>
      <SquareTerminal className="size-3 shrink-0" aria-hidden />
      <code className="min-w-0 select-all truncate font-mono" title={line}>{line}</code>
    </div>
  );
}
