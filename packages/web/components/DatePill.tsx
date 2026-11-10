import { Calendar } from "lucide-react";
import { resolveDateDisplay } from "../lib/dateMention";

// The one date chip. The doc editor's dateMention node view and the read-mode
// markdown pipeline (`@[<label> date:<iso>]` via EntityAwareLink) both render
// this, so a date looks identical while a doc is edited, read, or quoted.
// Styled with tokens only — no editor.css dependency, so it works on any
// markdown surface (chat, comments, conversation prose).

export function DatePill({ iso, label: storedLabel }: { iso: string; label?: string | null }) {
  const { label, resolved } = resolveDateDisplay(iso, storedLabel);
  return (
    <span className="inline-flex items-center gap-1.5 pl-1.5 pr-2.5 py-0.5 rounded-full align-middle bg-sol-orange/10 border border-sol-orange/20">
      <Calendar className="w-3.5 h-3.5 flex-shrink-0 text-sol-orange" />
      <span className="text-[13px] font-medium leading-[1.3] text-sol-text">{label}</span>
      {resolved && (
        <span className="text-[11px] font-mono text-sol-text-dim opacity-80">{resolved}</span>
      )}
    </span>
  );
}
