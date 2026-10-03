// What keeps memories from reaching Claude, and what makes them hard to find.

import type { ReactNode } from "react";
import { MEMORY_INDEX_LINE_SOFT_MAX, MEMORY_TYPES, type MemoryAtlas } from "@codecast/shared/memory";
import { memoryHealth, type MemoryHealth } from "./memoryView";
import { MemoryLinkChip } from "./parts";

function Card({ title, count, children, about }: { title: string; count: number; about: string; children: ReactNode }) {
  return (
    <section className="sol-card flex flex-col min-h-0">
      <header className="flex items-baseline gap-3 px-4 pt-3">
        <h3 className="flex-1 text-sm font-medium text-sol-text">{title}</h3>
        <span className={`font-mono text-base tabular-nums ${count ? "text-sol-orange" : "text-sol-green"}`}>{count}</span>
      </header>
      <p className="px-4 pt-1 pb-2.5 text-xs text-sol-text-dim">{about}</p>
      {count > 0 && <ul className="max-h-72 overflow-y-auto border-t border-sol-border/30 text-[13px]">{children}</ul>}
    </section>
  );
}

function Row({ children, why }: { children: ReactNode; why: string }) {
  return (
    <li className="flex items-baseline gap-3 px-4 py-1.5 border-b border-sol-border/20 last:border-0">
      <span className="flex-1 min-w-0 truncate">{children}</span>
      <span className="font-mono text-[10.5px] text-sol-text-dim truncate max-w-[45%]">{why}</span>
    </li>
  );
}

export function MemoryHealthView({ atlas, onOpen, onJumpToLine }: { atlas: MemoryAtlas; onOpen: (file: string) => void; onJumpToLine: (line: number) => void }) {
  const h: MemoryHealth = memoryHealth(atlas);
  const lineButton = (line: number, broken = false) => (
    <button type="button" onClick={() => onJumpToLine(line)} className={`underline underline-offset-2 ${broken ? "decoration-wavy decoration-sol-red/70" : "decoration-sol-border"} text-sol-text`}>
      line {line}
    </button>
  );
  const chip = (file: string) => (
    <MemoryLinkChip note={atlas.byFile.get(file)} onOpen={onOpen}>
      {atlas.byFile.get(file)?.name ?? file}
    </MemoryLinkChip>
  );
  return (
    <div className="h-full overflow-y-auto p-5 pb-16 grid gap-4 content-start grid-cols-[repeat(auto-fill,minmax(380px,1fr))]">
      <Card title="Never reached" count={h.unreached.length} about="Not in the loaded part of MEMORY.md and not linked from anything that is. Claude only finds these by searching the folder.">
        {h.unreached.map((n) => (
          <Row key={n.file} why={n.reach === "cut" ? `index line ${n.indexLine}, below the cut` : "no index line, no link in"}>
            {chip(n.file)}
          </Row>
        ))}
      </Card>
      <Card title={`Index lines over ${MEMORY_INDEX_LINE_SOFT_MAX} characters`} count={h.longLines.length} about="Each long line spends budget that pushes later lines past the cut.">
        {h.longLines.map((l) => (
          <Row key={l.line} why={`${l.length} characters`}>
            {lineButton(l.line)}
          </Row>
        ))}
      </Card>
      <Card title="Index points nowhere" count={h.danglingIndex.length} about="MEMORY.md lines whose link names no file in this folder.">
        {h.danglingIndex.map((d) => (
          <Row key={`${d.line}:${d.target}`} why={d.target}>
            {lineButton(d.line, true)}
          </Row>
        ))}
      </Card>
      <Card title="Links to unwritten memories" count={h.unwritten.length} about="A link that names no memory here: one that was deleted, or one marked as worth writing.">
        {h.unwritten.map((u) => (
          <Row key={`${u.note.file}:${u.target}`} why={`→ ${u.target}`}>
            {chip(u.note.file)}
          </Row>
        ))}
      </Card>
      <Card title="Missing a description" count={h.undescribed.length} about="Recall decides relevance from the description, so a memory without one is hard to surface.">
        {h.undescribed.map((n) => (
          <Row key={n.file} why={n.hasFrontmatter ? "no description" : "no frontmatter"}>
            {chip(n.file)}
          </Row>
        ))}
      </Card>
      <Card title="Unknown type" count={h.oddType.length} about={`Memory types are ${MEMORY_TYPES.join(", ")}.`}>
        {h.oddType.map((n) => (
          <Row key={n.file} why={n.type}>
            {chip(n.file)}
          </Row>
        ))}
      </Card>
      <Card title="Duplicate names" count={h.duplicateNames.length} about="Two files answer to the same name, so a [[link]] can only reach one of them.">
        {h.duplicateNames.map((n) => (
          <Row key={n.file} why={n.file}>
            {chip(n.file)}
          </Row>
        ))}
      </Card>
    </div>
  );
}
