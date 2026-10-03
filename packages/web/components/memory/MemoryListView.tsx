// Every memory in a sortable table.

import { useMemo, useState } from "react";
import { MEMORY_REACH, type MemoryNote } from "@codecast/shared/memory";
import { formatRelative } from "@codecast/shared/time";
import { formatBytes } from "./memoryView";
import { ReachBadge, TypeBadge } from "./parts";

type SortKey = "name" | "type" | "reach" | "in" | "out" | "size" | "changed";

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "name", label: "Memory" },
  { key: "type", label: "Type" },
  { key: "reach", label: "Reach" },
  { key: "in", label: "In", numeric: true },
  { key: "out", label: "Out", numeric: true },
  { key: "size", label: "Size", numeric: true },
  { key: "changed", label: "Changed", numeric: true },
];

const sortValue = (n: MemoryNote, key: SortKey): string | number =>
  ({
    name: n.name.toLowerCase(),
    type: n.type,
    reach: MEMORY_REACH.indexOf(n.reach),
    in: n.inbound.length,
    out: n.links.length,
    size: n.bytes,
    changed: n.mtime,
  })[key];

export function MemoryListView({ notes, active, onOpen }: { notes: MemoryNote[]; active: string | null; onOpen: (file: string) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "changed", dir: -1 });
  const rows = useMemo(
    () => [...notes].sort((a, b) => {
      const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
      return (x > y ? 1 : x < y ? -1 : 0) * sort.dir;
    }),
    [notes, sort],
  );
  const toggle = (key: SortKey) =>
    setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "name" || key === "type" || key === "reach" ? 1 : -1 }));

  return (
    <div className="h-full overflow-y-auto px-5 pb-16">
      <table className="w-full text-[13px] border-collapse">
        <thead className="sticky top-0 bg-sol-bg z-10">
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                onClick={() => toggle(c.key)}
                className={`py-2 px-2 font-medium text-[11px] border-b border-sol-border/50 cursor-pointer select-none whitespace-nowrap ${
                  c.numeric ? "text-right" : "text-left"
                } ${sort.key === c.key ? "text-sol-text" : "text-sol-text-dim hover:text-sol-text-muted"}`}
              >
                {c.label}
                {sort.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <tr
              key={n.file}
              onClick={() => onOpen(n.file)}
              className={`cursor-pointer border-b border-sol-border/20 transition-colors ${active === n.file ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-alt"}`}
            >
              <td className="py-2 px-2 align-top max-w-0 w-[52%]">
                <div className="text-sol-text truncate">{n.name}</div>
                <div className="text-xs text-sol-text-dim line-clamp-2">{n.description || <i>No description</i>}</div>
              </td>
              <td className="py-2 px-2 align-top"><TypeBadge type={n.type} /></td>
              <td className="py-2 px-2 align-top"><ReachBadge reach={n.reach} /></td>
              <td className="py-2 px-2 align-top text-right font-mono text-[11px] text-sol-text-muted tabular-nums">{n.inbound.length}</td>
              <td className="py-2 px-2 align-top text-right font-mono text-[11px] text-sol-text-muted tabular-nums">{n.links.length}</td>
              <td className="py-2 px-2 align-top text-right font-mono text-[11px] text-sol-text-muted tabular-nums">{formatBytes(n.bytes)}</td>
              <td className="py-2 px-2 align-top text-right text-[11px] text-sol-text-dim whitespace-nowrap">{formatRelative(n.mtime)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-10 text-center text-sm text-sol-text-dim">No memory matches.</div>}
    </div>
  );
}
