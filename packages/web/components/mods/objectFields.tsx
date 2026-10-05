// How a mod object's status and typed fields draw and edit: one place, so the
// list, the board and the object page agree.

import { useEffect, useState } from "react";
import type { ModObjectField, ModObjectKind } from "@codecast/shared/contracts/mods";
import { Switch } from "../ui/switch";
import { EntityIdPill } from "../EntityIdPill";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { statusTone } from "../../lib/mods/objects";

export function StatusBadge({ kind, status }: { kind: Pick<ModObjectKind, "statuses">; status: string | undefined }) {
  if (!status) return null;
  const t = statusTone(kind, status);
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[11px] font-medium whitespace-nowrap" style={{ color: t, background: `color-mix(in srgb, ${t} 14%, transparent)` }}>
      <span className="size-1.5 rounded-full" style={{ background: t }} />
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function FieldValue({ field, value }: { field: ModObjectField; value: unknown }) {
  if (value === undefined || value === null || value === "") return <span className="text-sol-text-dim">—</span>;
  switch (field.type) {
    case "bool": return <span>{value ? "Yes" : "No"}</span>;
    case "ref": return <EntityIdPill shortId={String(value)} fallback={<span className="font-mono text-[12px]">{String(value)}</span>} />;
    case "url": return <a href={String(value)} target="_blank" rel="noopener noreferrer" className="text-sol-blue hover:underline truncate">{String(value).replace(/^https?:\/\//, "")}</a>;
    case "date": return <span className="tabular-nums">{new Date(String(value)).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</span>;
    case "markdown": return <MarkdownRenderer content={String(value)} />;
    case "number": return <span className="tabular-nums">{Number(value).toLocaleString()}</span>;
    default: return <span>{String(value)}</span>;
  }
}

/** An editor for one typed field. Text commits on blur or Enter; choices commit at once. */
export function FieldEditor({ field, value, onChange }: { field: ModObjectField; value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(value === undefined || value === null ? "" : String(value));
  useEffect(() => setText(value === undefined || value === null ? "" : String(value)), [value]);
  const input = "w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-[13px] text-sol-text outline-none hover:border-sol-border focus:border-sol-violet focus:bg-sol-bg";
  const commit = () => {
    const next = field.type === "number" ? (text.trim() === "" ? null : Number(text)) : text;
    if (String(next ?? "") !== String(value ?? "")) onChange(next);
  };
  switch (field.type) {
    case "enum":
      return (
        <select className={input} value={String(value ?? "")} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case "bool":
      return <Switch checked={!!value} onCheckedChange={(v: boolean) => onChange(v)} />;
    case "markdown":
      return (
        <textarea
          className={`${input} min-h-[90px] font-mono text-[12.5px]`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
        />
      );
    default:
      return (
        <div className="flex items-center gap-2">
          <input
            className={`${input} ${field.type === "ref" || field.type === "url" ? "font-mono text-[12.5px]" : ""}`}
            type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
            value={text}
            placeholder="—"
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
          {field.type === "ref" && value ? <FieldValue field={field} value={value} /> : null}
        </div>
      );
  }
}
