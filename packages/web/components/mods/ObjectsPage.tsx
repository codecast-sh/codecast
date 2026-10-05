// /objects/<prefix>: every object of one mod-declared kind in the active
// workspace, as a table or a board by status, with a one-line create at the
// top. Rows render from the store and writes are store actions, so a new
// object appears the moment it is typed.

import { useMemo, useState } from "react";
import { DynamicIcon } from "lucide-react/dynamic";
import { objectStatusIsDone, type ModObjectKind } from "@codecast/shared/contracts/mods";
import { useInboxStore } from "../../store/inboxStore";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { formatRelativeTime } from "../../lib/conversationFormat";
import { modNavigate } from "../../lib/mods/host";
import { objectHref, objectKind } from "../../lib/mods/objects";
import { useModRows } from "../../lib/mods/useMods";
import { FieldValue, StatusBadge } from "./objectFields";

type Row = { _id: string; short_id: string; prefix: string; title: string; status?: string; fields?: Record<string, unknown>; updated_at: number; created_at: number };

function Board({ kind, rows }: { kind: ModObjectKind; rows: Row[] }) {
  const statuses = kind.statuses ?? [];
  const update = useInboxStore((s) => s.updateModObject);
  const [drag, setDrag] = useState<string | null>(null);
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(statuses.length, 1)}, minmax(220px, 1fr))` }}>
      {statuses.map((status) => {
        const col = rows.filter((r) => (r.status ?? statuses[0]) === status);
        return (
          <section
            key={status}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (drag) update(drag, { status }); setDrag(null); }}
            className="min-h-[200px] rounded-xl border border-sol-border bg-sol-bg-alt/40 p-2"
          >
            <header className="mb-2 flex items-center gap-2 px-1.5 pt-1">
              <StatusBadge kind={kind} status={status} />
              <span className="text-[11.5px] tabular-nums text-sol-text-dim">{col.length}</span>
            </header>
            <div className="flex flex-col gap-1.5">
              {col.map((r) => (
                <button
                  key={r._id}
                  draggable
                  onDragStart={() => setDrag(r._id)}
                  onClick={() => modNavigate(objectHref(r.short_id))}
                  className="rounded-lg border border-sol-border bg-sol-card px-2.5 py-2 text-left transition-colors hover:border-[color-mix(in_srgb,var(--sol-violet)_45%,var(--sol-border))]"
                >
                  <div className="font-mono text-[10.5px] text-sol-text-dim">{r.short_id}</div>
                  <div className={`text-[13px] text-sol-text ${objectStatusIsDone(kind, r.status) ? "line-through opacity-60" : ""}`}>{r.title}</div>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TableView({ kind, rows }: { kind: ModObjectKind; rows: Row[] }) {
  const fields = Object.entries(kind.fields ?? {}).filter(([, f]) => f.type !== "markdown").slice(0, 4);
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr className="text-[11px] uppercase tracking-wide text-sol-text-dim">
          <th className="border-b border-sol-border px-2 py-1.5 text-left font-medium w-24">Id</th>
          <th className="border-b border-sol-border px-2 py-1.5 text-left font-medium">Title</th>
          {kind.statuses?.length ? <th className="border-b border-sol-border px-2 py-1.5 text-left font-medium">Status</th> : null}
          {fields.map(([name, f]) => <th key={name} className="border-b border-sol-border px-2 py-1.5 text-left font-medium">{f.label ?? name}</th>)}
          <th className="border-b border-sol-border px-2 py-1.5 text-right font-medium">Updated</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r._id} onClick={() => modNavigate(objectHref(r.short_id))} className="cursor-pointer border-b border-[color-mix(in_srgb,var(--sol-border)_55%,transparent)] hover:bg-[color-mix(in_srgb,var(--sol-violet)_6%,transparent)]">
            <td className="px-2 py-1.5 font-mono text-[11.5px] text-sol-text-dim">{r.short_id}</td>
            <td className={`px-2 py-1.5 text-sol-text ${objectStatusIsDone(kind, r.status) ? "line-through opacity-60" : ""}`}>{r.title}</td>
            {kind.statuses?.length ? <td className="px-2 py-1.5"><StatusBadge kind={kind} status={r.status} /></td> : null}
            {fields.map(([name, f]) => <td key={name} className="px-2 py-1.5 text-sol-text-muted"><FieldValue field={f} value={r.fields?.[name]} /></td>)}
            <td className="px-2 py-1.5 text-right text-sol-text-dim tabular-nums">{formatRelativeTime(r.updated_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ObjectsPage({ prefix }: { prefix: string }) {
  useModRows();
  const kind = objectKind(prefix);
  const all = useWorkspaceCollection<Row>("modObjects");
  const rows = useMemo(() => all.filter((r) => r.prefix === prefix).sort((a, b) => b.updated_at - a.updated_at), [all, prefix]);
  const [view, setView] = useState<"table" | "board">(kind?.statuses?.length ? "board" : "table");
  const [draft, setDraft] = useState("");
  const [showDone, setShowDone] = useState(false);
  const create = useInboxStore((s) => s.createModObject);
  if (!kind) {
    return <div className="mx-auto max-w-xl px-6 py-16 text-center text-[13px] text-sol-text-muted">No mod declares <span className="font-mono">{prefix}</span> objects. <button className="text-sol-blue hover:underline" onClick={() => modNavigate("/mods")}>See mods</button></div>;
  }
  const visible = showDone || view === "board" ? rows : rows.filter((r) => !objectStatusIsDone(kind, r.status));
  const doneCount = rows.length - rows.filter((r) => !objectStatusIsDone(kind, r.status)).length;
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-6">
      <header className="mb-5 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--sol-violet)_13%,transparent)] text-sol-violet">
          <DynamicIcon name={(kind.icon ?? "box") as any} size={18} />
        </span>
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-sol-text">{kind.plural ?? `${kind.title}s`}</h1>
          <div className="text-[12px] text-sol-text-dim">{rows.length} · from the <button className="hover:underline" onClick={() => modNavigate("/mods")}>{kind.modTitle ?? kind.mod}</button> mod · <span className="font-mono">cast obj {prefix}</span></div>
        </div>
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-sol-border p-0.5">
          {(["board", "table"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={`rounded-md px-2.5 py-1 text-[12px] capitalize ${view === v ? "bg-[color-mix(in_srgb,var(--sol-text)_8%,transparent)] text-sol-text" : "text-sol-text-muted hover:text-sol-text"}`}>{v}</button>
          ))}
        </div>
      </header>
      <form
        className="mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          const title = draft.trim();
          if (!title) return;
          create({ prefix, title });
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`New ${kind.title.toLowerCase()}…`}
          className="w-full rounded-lg border border-sol-border bg-sol-card px-3 py-2 text-[13.5px] text-sol-text outline-none focus:border-sol-violet"
        />
      </form>
      {!rows.length ? (
        <div className="py-16 text-center text-[13px] text-sol-text-muted">No {(kind.plural ?? `${kind.title}s`).toLowerCase()} yet. Type one above, or let an agent file one with <span className="font-mono">cast obj {prefix} create "…"</span>.</div>
      ) : view === "board" && kind.statuses?.length ? (
        <Board kind={kind} rows={visible} />
      ) : (
        <>
          <TableView kind={kind} rows={visible} />
          {doneCount && !showDone ? <button onClick={() => setShowDone(true)} className="mt-3 text-[12px] text-sol-text-muted hover:text-sol-text">Show {doneCount} done</button> : null}
        </>
      )}
    </div>
  );
}
