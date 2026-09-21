import { Link, MessageSquareQuote } from "lucide-react";
import type { PalettePick } from "../lib/palettePick";

export function PalettePickPreview({ preview }: { preview: PalettePick["preview"] }) {
  if (!preview) return null;
  const Icon = preview.text ? MessageSquareQuote : Link;
  return (
    <div aria-label="Content to send" className="mt-3 flex min-w-0 gap-2.5 border-l-2 border-sol-cyan/50 pl-3">
      <Icon aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sol-text-dim" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-sol-text" title={preview.title}>{preview.title}</div>
        {preview.text && <p className="mt-1 line-clamp-2 break-words text-xs leading-relaxed text-sol-text-muted [overflow-wrap:anywhere]">{preview.text}</p>}
        <div className="mt-1 truncate text-[10px] text-sol-text-dim" title={preview.url}>{preview.url.replace(/^https?:\/\//, "")}</div>
      </div>
    </div>
  );
}
