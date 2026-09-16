"use client";
// Seating the workspace's standing agent is an explained moment (org-staffing.md
// S16). When the workspace already has a standing agent, hiring the Chief of
// Staff must never feel like a takeover of the thread the person already talks
// to, so this dialog names what will happen and offers two reversible choices.
// The default seats the existing agent: no restart, its memory, chat handle and
// Slack binding kept, the weekly review added to its job. The alternative starts
// a fresh session and retires the old one, its thread kept and linked.
import { useState } from "react";
import { Check } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";

export type ChiefSeatChoice = "existing" | "fresh";

export function ChiefSeatDialog({ open, onClose, agentName, threadShortId, messageCount, onConfirm }: {
  open: boolean;
  onClose: () => void;
  agentName: string;
  threadShortId?: string;
  messageCount?: number;
  onConfirm: (seat: ChiefSeatChoice) => void;
}) {
  const [choice, setChoice] = useState<ChiefSeatChoice>("existing");
  const thread = threadShortId ? `thread ${threadShortId}${typeof messageCount === "number" ? `, ${messageCount} message${messageCount === 1 ? "" : "s"}` : ""}` : "its existing thread";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[480px] grid-cols-1" style={{ background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }}>
        <DialogHeader>
          <DialogTitle className="text-[17px]" style={{ fontFamily: "var(--font-serif)" }}>Seat the Chief of Staff</DialogTitle>
          <DialogDescription className="text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }}>
            This workspace already has a standing agent, <span style={{ color: "var(--sol-text)" }}>{agentName}</span> ({thread}). Seating it as Chief of Staff keeps its memory, its chat handle and its Slack binding, and adds the weekly company review to its job.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 mt-1">
          <SeatChoiceCard
            selected={choice === "existing"}
            onSelect={() => setChoice("existing")}
            title="Seat the existing agent"
            sub="No restart, no second session. It keeps everything and takes on the review."
          />
          <SeatChoiceCard
            selected={choice === "fresh"}
            onSelect={() => setChoice("fresh")}
            title="Start a fresh session"
            sub="The old agent is retired in the same act, its thread kept and linked from the new role's page, so the workspace never ends with two root agents."
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="h-8 px-3 rounded-lg text-[12.5px] hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
          <button
            type="button"
            onClick={() => { onConfirm(choice); onClose(); }}
            className="h-8 px-3.5 rounded-lg text-[12.5px] font-semibold"
            style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}
          >
            {choice === "existing" ? "Seat it" : "Start fresh"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SeatChoiceCard({ selected, onSelect, title, sub }: { selected: boolean; onSelect: () => void; title: string; sub: string }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="w-full text-left rounded-lg border px-3 py-2.5 transition-colors"
      style={{
        borderColor: selected ? "var(--sol-violet)" : "color-mix(in srgb, var(--sol-border) 40%, transparent)",
        background: selected ? "color-mix(in srgb, var(--sol-violet) 9%, transparent)" : undefined,
      }}
    >
      <div className="flex items-center gap-2">
        <span className="w-4 h-4 rounded-full inline-flex items-center justify-center shrink-0" style={{ background: selected ? "var(--sol-violet)" : "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-bg)" }}>
          {selected && <Check className="w-3 h-3" />}
        </span>
        <span className="text-[13px] font-semibold" style={{ color: "var(--sol-text)" }}>{title}</span>
      </div>
      <p className="mt-1 ml-6 text-[11.5px] leading-snug" style={{ color: "var(--sol-text-muted)" }}>{sub}</p>
    </button>
  );
}
