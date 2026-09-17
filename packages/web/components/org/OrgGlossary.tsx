"use client";
// The one place the product's words are defined (docs/architecture/
// org-staffing.md S17): a dialog with two pages. "How this works" is the
// short page the staffing pane's intro links to; "The words" is the glossary,
// eight terms with one sentence each and an example from this workspace.
// The pane and the chart both open it; nothing else restates a definition.
import { useEffect, useState } from "react";
import { BookOpen, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../ui/dialog";
import { cn } from "../../lib/utils";
import { HOW_THIS_WORKS, glossaryEntries } from "./orgGlossary";
import type { OrgTree } from "./orgTypes";
import type { OrgHealth, OrgProposalRow } from "./orgStaffingTypes";

export type GlossaryPage = "how" | "words";

export function OrgGlossary({ open, onClose, tree, health, proposal }: {
  /** Closed, or the page it opens on. */
  open: GlossaryPage | null;
  onClose: () => void;
  tree: OrgTree | null;
  health: OrgHealth | null;
  proposal: Pick<OrgProposalRow, "short_id" | "changes" | "counts"> | null;
}) {
  const [cur, setCur] = useState<GlossaryPage>(open ?? "how");
  useEffect(() => { if (open) setCur(open); }, [open]);
  const entries = glossaryEntries(tree, health, proposal);
  return (
    <Dialog open={!!open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-[440px] p-0 gap-0 overflow-hidden" style={{ background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }} data-org-glossary={cur}>
        <div className="flex items-center gap-2 px-4 pt-4 pb-3 border-b" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 25%, transparent)" }}>
          <BookOpen className="w-4 h-4 shrink-0" style={{ color: "var(--sol-violet)" }} />
          <DialogTitle className="text-[16px] font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>
            {cur === "how" ? "How this works" : "The words"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {cur === "how" ? "What the org page and a proposal are for, in four short paragraphs." : "The eight words the org page uses, each defined in one sentence with an example from this workspace."}
          </DialogDescription>
          <div className="ml-auto flex items-center rounded-lg border p-0.5" role="tablist" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 35%, transparent)" }}>
            {(["how", "words"] as const).map((p) => (
              <button key={p} type="button" role="tab" aria-selected={cur === p} onClick={() => setCur(p)} className={cn("h-6 px-2 rounded-md text-[11px] font-medium transition-colors", cur === p ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/50")} style={{ color: cur === p ? "var(--sol-text)" : "var(--sol-text-dim)" }} data-glossary-tab={p}>
                {p === "how" ? "How it works" : "Words"}
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="w-7 h-7 -mr-1.5 inline-flex items-center justify-center rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-dim)" }}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-4" style={{ maxHeight: "min(70dvh, 560px)" }}>
          {cur === "how" ? (
            <div className="flex flex-col gap-3.5" data-glossary-how>
              {HOW_THIS_WORKS.map((s) => (
                <section key={s.heading}>
                  <h3 className="text-[12.5px] font-semibold" style={{ color: "var(--sol-text)" }}>{s.heading}</h3>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-secondary)" }}>{s.body}</p>
                </section>
              ))}
              <button type="button" onClick={() => setCur("words")} className="self-start text-[12px] underline-offset-2 hover:underline" style={{ color: "var(--sol-violet)" }}>
                The eight words, defined
              </button>
            </div>
          ) : (
            <dl className="flex flex-col gap-3" data-glossary-words>
              {entries.map((e) => (
                <div key={e.word} className="rounded-lg border px-3 py-2.5" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 25%, transparent)", background: "var(--sol-bg)" }} data-glossary-word={e.word}>
                  <dt className="text-[13px] font-semibold" style={{ color: "var(--sol-text)", fontFamily: "var(--font-serif)" }}>{e.term}</dt>
                  <dd className="mt-0.5 text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-secondary)" }}>{e.definition}</dd>
                  <dd className="mt-1.5 text-[11.5px] leading-snug flex items-baseline gap-1.5" style={{ color: "var(--sol-text-muted)" }} data-glossary-example={e.own ? "own" : "general"}>
                    <span className="shrink-0 uppercase tracking-[0.08em] text-[9.5px]" style={{ color: e.own ? "var(--sol-violet)" : "var(--sol-text-dim)" }}>{e.own ? "in your workspace" : "for example"}</span>
                    <span className="min-w-0">{e.example}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
