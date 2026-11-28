import { markerLayout } from "../lib/markedImage";
import type { ImageNote } from "../lib/imageNotes";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

// Hover areas over the numbered markers a send drew on a picture
// (lib/markedImage): hovering one shows the note it stands for beside it.
// Laid over a box exactly the size of the picture as shown; `width` and
// `height` are the picture file's own pixels, which place each badge the way
// drawMarkers did. Notes with no point (sent before the point was written)
// get no area.
export function MarkerNotes({ notes, width, height, contentClassName }: {
  notes: readonly ImageNote[];
  width: number;
  height: number;
  /** For a host drawn above the tooltip layer (the gallery). */
  contentClassName?: string;
}) {
  const placed = notes.filter((n) => n.point);
  if (!placed.length || !width || !height) return null;
  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <div className="pointer-events-none absolute inset-0" data-cc-marker-notes>
        {placed.map((note) => {
          const { r, bx, by } = markerLayout(note.point!, width, height);
          return (
            <Tooltip key={note.number}>
              <TooltipTrigger asChild>
                <span
                  className="pointer-events-auto absolute aspect-square -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{ left: `${(bx / width) * 100}%`, top: `${(by / height) * 100}%`, width: `max(18px, ${((2.6 * r) / width) * 100}%)` }}
                  aria-label={`Note ${note.number}: ${note.body}`}
                  data-cc-marker-note={note.number}
                />
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={6} className={`max-w-[20rem] ${contentClassName ?? ""}`}>
                <div className="flex items-start gap-1.5">
                  <span className="mt-px flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-sol-yellow px-1 text-meta font-bold leading-none text-black">
                    {note.number}
                  </span>
                  <span className="whitespace-pre-wrap break-words">{note.body || "(no note)"}</span>
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
