// MEMORY.md line by line against its load budget. The ruler shows what each
// line costs; the cut line marks where Claude Code stops reading, and every
// line under it is dimmed because it never reaches the model.

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Scissors } from "lucide-react";
import { MEMORY_INDEX_LINE_SOFT_MAX, lineBytes, type MemoryAtlas } from "@codecast/shared/memory";
import { parseNote } from "@codecast/shared/vault";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { formatBytes } from "./memoryView";
import { MemoryLinkChip } from "./parts";

/** One index line with its links as chips and the rest as text. */
function IndexLine({ line, atlas, onOpen }: { line: string; atlas: MemoryAtlas; onOpen: (file: string) => void }) {
  const heading = /^#{1,6}\s+(.*)$/.exec(line);
  if (heading) return <span className="font-semibold text-sol-text">{heading[1]}</span>;
  const parsed = parseNote(line);
  const spans = [
    ...parsed.markdownLinks.map((l) => ({ col: l.col, raw: l.raw, text: l.text, target: l.target })),
    ...parsed.links.map((l) => ({ col: l.col, raw: l.raw, text: l.alias ?? l.target, target: l.target })),
  ].sort((a, b) => a.col - b.col);
  const out: ReactNode[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.col < at) continue;
    out.push(line.slice(at, s.col));
    const file = atlas.resolve(s.target);
    out.push(
      <MemoryLinkChip key={s.col} note={file ? atlas.byFile.get(file) : undefined} onOpen={onOpen}>
        {s.text}
      </MemoryLinkChip>,
    );
    at = s.col + s.raw.length;
  }
  out.push(line.slice(at));
  return <>{out}</>;
}

export function MemoryIndexView({ atlas, onOpen, onEditIndex, focusLine }: { atlas: MemoryAtlas; onOpen: (file: string) => void; onEditIndex: () => void; focusLine: number | null }) {
  const { lines, budget } = atlas.index;
  const sizes = useMemo(() => lines.map(lineBytes), [lines]);
  const [hover, setHover] = useState<number | null>(null);
  const scale = Math.max(budget.bytes, budget.maxBytes);
  const lostBytes = budget.cutAt === null ? 0 : sizes.slice(budget.cutAt - 1).reduce((a, b) => a + b, 0);
  const longCount = lines.filter((l) => l.length > MEMORY_INDEX_LINE_SOFT_MAX).length;
  const isCut = (n: number) => budget.cutAt !== null && n >= budget.cutAt;
  const jump = (n: number) => document.getElementById(`memory-index-line-${n}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  useWatchEffect(() => {
    if (focusLine) jump(focusLine);
  }, [focusLine]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="sticky top-0 z-10 bg-sol-bg/95 backdrop-blur px-5 pt-4 pb-3 border-b border-sol-border/40">
        <div className="relative flex h-5 rounded border border-sol-border/60 overflow-hidden bg-sol-bg-alt">
          {sizes.map((s, i) => {
            const n = i + 1;
            const long = lines[i].length > MEMORY_INDEX_LINE_SOFT_MAX;
            return (
              <button
                key={n}
                type="button"
                title={`Line ${n}: ${s} bytes${long ? `, ${lines[i].length} characters` : ""}`}
                onClick={() => jump(n)}
                onMouseEnter={() => setHover(n)}
                onMouseLeave={() => setHover(null)}
                className="h-full shrink-0 border-r border-sol-bg/60 transition-opacity"
                style={{
                  width: `${(s / scale) * 100}%`,
                  background: hover === n ? "var(--sol-cyan)" : isCut(n) ? "repeating-linear-gradient(-45deg, var(--sol-red) 0 2px, color-mix(in srgb, var(--sol-red) 25%, transparent) 2px 4px)" : long ? "var(--sol-yellow)" : "var(--sol-text-dim)",
                  opacity: hover === n || isCut(n) ? 1 : 0.55,
                }}
              />
            );
          })}
          {budget.bytes > budget.maxBytes && (
            <div className="absolute -top-1 -bottom-1 border-l-2 border-dashed border-sol-red pointer-events-none" style={{ left: `${(budget.maxBytes / scale) * 100}%` }} />
          )}
        </div>
        <div className="flex items-center gap-3 mt-2 text-xs text-sol-text-muted">
          <span className="flex-1">
            <b className="text-sol-text font-medium">{formatBytes(budget.bytes)}</b> of {formatBytes(budget.maxBytes)}, <b className="text-sol-text font-medium">{budget.lines}</b> of {budget.maxLines} lines
            {budget.cutAt ? <> · cut at line <b className="text-sol-red font-medium">{budget.cutAt}</b></> : " · loads in full"}
            {longCount > 0 && <> · <span className="text-sol-yellow">{longCount}</span> lines over {MEMORY_INDEX_LINE_SOFT_MAX} characters</>}
          </span>
          <button type="button" onClick={onEditIndex} className="sol-btn text-xs px-2.5 py-1">
            Edit MEMORY.md
          </button>
        </div>
      </div>

      {lines.length === 0 ? (
        <div className="p-8 text-sm text-sol-text-dim">This project has no MEMORY.md yet. Claude Code writes one the first time it saves a memory here.</div>
      ) : (
        <div className="py-2 pb-16 text-[13px] leading-relaxed">
          {lines.map((line, i) => {
            const n = i + 1;
            const long = line.length > MEMORY_INDEX_LINE_SOFT_MAX;
            return (
              <Fragment key={n}>
                {n === budget.cutAt && (
                  <div className="mx-5 my-3 flex items-center gap-3 rounded-md border border-sol-red/60 bg-sol-red/10 px-3 py-2 text-sol-text">
                    <Scissors className="w-4 h-4 text-sol-red shrink-0" />
                    <span>
                      Claude stops reading here. <b className="text-sol-red font-medium">{budget.lines - budget.cutAt + 1} lines ({formatBytes(lostBytes)})</b> below never reach its context
                      {longCount > 0 && `; shortening the ${longCount} long lines is the cheapest way to win room`}.
                    </span>
                  </div>
                )}
                <div
                  id={`memory-index-line-${n}`}
                  onMouseEnter={() => setHover(n)}
                  onMouseLeave={() => setHover(null)}
                  className={`grid grid-cols-[3rem_1fr_6rem] gap-3 pr-5 py-0.5 border-l-2 transition-colors ${
                    hover === n || focusLine === n ? "bg-sol-bg-alt border-sol-cyan" : "border-transparent"
                  } ${isCut(n) ? "opacity-50 hover:opacity-100" : ""}`}
                >
                  <span className="text-right font-mono text-[11px] text-sol-text-dim pt-0.5 tabular-nums">{n}</span>
                  <span className="min-w-0 break-words text-sol-text-muted">
                    <IndexLine line={line} atlas={atlas} onOpen={onOpen} />
                  </span>
                  <span className={`text-right font-mono text-[11px] pt-0.5 tabular-nums ${long ? "text-sol-yellow" : "text-sol-text-dim"}`} title={`${line.length} characters`}>
                    {long && `${line.length}ch · `}
                    {sizes[i]}B
                  </span>
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
