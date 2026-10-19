import { useState } from "react";
import { Link, MessageSquareQuote } from "lucide-react";
import type { PalettePick } from "../lib/palettePick";
import { Switch } from "./ui/switch";

/** The top of a pick: its title, its one switch when it has one, and what is
 *  being sent. */
export function PalettePickHeader({ pick }: { pick: PalettePick }) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1 truncate font-mono text-xs text-sol-text-dim">{pick.title}</div>
        {pick.toggle && <PickToggle toggle={pick.toggle} />}
      </div>
      <PalettePickPreview preview={pick.preview} />
    </>
  );
}

function PickToggle({ toggle }: { toggle: NonNullable<PalettePick["toggle"]> }) {
  const [on, setOn] = useState(toggle.value);
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-sol-text-muted">
      {toggle.label}
      <Switch
        checked={on}
        onCheckedChange={(v) => {
          setOn(v);
          toggle.onChange(v);
        }}
        aria-label={toggle.label}
      />
    </label>
  );
}

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
