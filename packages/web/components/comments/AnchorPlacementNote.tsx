import type { AnchorPlacement, CodeAnchorText } from "@codecast/shared/comments";

// What a line thread says when the code under it moved on
// (shared/comments/codeAnchor.ts). A moved thread names the line it was
// written on; an outdated one quotes the lines it was about, because the code
// it hangs beside is no longer what the comment means.

export function AnchorPlacementNote({
  placement,
  anchorLines,
}: {
  placement?: AnchorPlacement | null;
  anchorLines?: CodeAnchorText | null;
}) {
  if (placement?.state === "moved") {
    return (
      <div className="text-[11px] text-sol-text-dim" data-anchor-state="moved">
        moved from line {placement.from}
      </div>
    );
  }
  if (placement?.state !== "outdated") return null;
  return (
    <div className="space-y-1" data-anchor-state="outdated">
      <div className="text-[11px] text-sol-text-dim">
        <span className="mr-1.5 rounded-sm border border-sol-yellow/40 px-1 py-px text-[10px] uppercase tracking-wider text-sol-yellow">
          outdated
        </span>
        the code this was written on is gone; it read:
      </div>
      {anchorLines?.lines.length ? (
        <pre className="max-h-40 overflow-auto rounded-sm bg-sol-bg-alt/60 px-2 py-1 font-mono text-[11px] leading-snug text-sol-text-muted whitespace-pre-wrap [overflow-wrap:anywhere]">
          {anchorLines.lines.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}

/** The thread's border: quieter once it no longer sits on its own code. */
export function placementBorderClass(placement?: AnchorPlacement | null): string | undefined {
  return placement?.state === "outdated" ? "border-sol-yellow/40" : undefined;
}

/** A gutter dot on the line a moved or outdated thread hangs on. Keeps its
 *  slot when empty so line numbers never shift. */
export function AnchorGutterMark({ placement, absolute }: { placement?: AnchorPlacement | null; absolute?: boolean }) {
  const state = placement?.state;
  const title = state === "moved" ? `Comment moved from line ${placement!.from}` : state === "outdated" ? "Outdated comment: its code is gone" : undefined;
  const slot = absolute ? "absolute left-0.5 top-1/2 -translate-y-1/2" : "inline-block shrink-0";
  if (!title) return absolute ? null : <span className={`${slot} w-1.5`} aria-hidden />;
  return (
    <span
      className={`${slot} h-1.5 w-1.5 rounded-full ${state === "outdated" ? "border border-sol-yellow/70" : "bg-sol-cyan/70"}`}
      title={title}
      aria-label={title}
      data-anchor-mark={state}
    />
  );
}
