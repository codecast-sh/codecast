"use client";
// The org record as a sheet over the screen (org-staffing.md S27, S41): what
// changed, who changed it, and for an admin the way back. Opened from the
// header's menu and by `?panel=history`, so the undo timeline's "Open in org
// record" keeps working.
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { OrgHistory, OrgHistoryPreview } from "./history/OrgHistory";
import { OrgReset } from "./OrgReset";
import type { OrgResetPreview } from "./orgMeta";

export function OrgHistorySheet({ open, onClose, preview, reset }: {
  open: boolean;
  onClose: () => void;
  /** The dev preview: the fixture's record, and a reset that changes nothing. */
  preview: boolean;
  /** The admin's reset; null for everyone else. */
  reset: { preview: () => Promise<OrgResetPreview>; reset: () => Promise<void>; onDone: () => void } | null;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-[720px] p-0 gap-0 overflow-hidden" style={{ background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }} data-org-history-sheet>
        <DialogHeader className="px-5 pt-4 pb-2">
          <DialogTitle className="text-[16px]" style={{ fontFamily: "var(--font-serif)" }}>History</DialogTitle>
          <DialogDescription className="text-[12px]" style={{ color: "var(--sol-text-muted)" }}>What changed, who changed it, and a way back</DialogDescription>
        </DialogHeader>
        <div className="max-h-[80vh] overflow-y-auto px-5 pb-5">
          {preview ? <OrgHistoryPreview /> : <OrgHistory />}
          {reset && <OrgReset preview={reset.preview} reset={reset.reset} onDone={reset.onDone} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
