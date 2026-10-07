// /o/<prefix>-<n>: one mod object. The declaring mod draws the top of the page
// when it hooks ui.render { object: prefix }; codecast draws the rest from the
// kind's declaration: title, status, typed fields, body. Every edit is a store
// action, so it shows at once and syncs behind.

import { useMemo, useState } from "react";
import { DynamicIcon } from "lucide-react/dynamic";
import { objectStatusIsDone, type ModSurface } from "@codecast/shared/contracts/mods";
import { useInboxStore } from "../../store/inboxStore";
import { formatRelativeTime } from "../../lib/conversationFormat";
import { modHost, modNavigate } from "../../lib/mods/host";
import { objectByShortId, objectKind, objectsHref, statusTone } from "../../lib/mods/objects";
import { useModHostVersion, useModRows } from "../../lib/mods/useMods";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { ModSurfaceView } from "./ModSurface";
import { FieldEditor } from "./objectFields";
import { useWatchEffect } from "../../hooks/useWatchEffect";

export function ObjectPage({ id }: { id: string }) {
  useModRows();
  useModHostVersion();
  const shortId = id.toLowerCase();
  const row = useInboxStore((s) => objectByShortId((s as any).modObjects, shortId));
  const kind = objectKind(shortId.split("-")[0]);
  const update = useInboxStore((s) => s.updateModObject);
  const [title, setTitle] = useState(row?.title ?? "");
  const [editingBody, setEditingBody] = useState(false);
  const [body, setBody] = useState(row?.body ?? "");
  useWatchEffect(() => setTitle(row?.title ?? ""), [row?.title]);
  useWatchEffect(() => { if (!editingBody) setBody(row?.body ?? ""); }, [row?.body, editingBody]);
  const runtime = kind ? modHost.byName(kind.mod) : undefined;
  const drawsPage = !!runtime?.hooks.some((h) => h.event === "ui.render" && (!h.matcher || h.matcher.object === kind?.prefix));
  const surface = useMemo<ModSurface | null>(() => (row && kind ? { kind: "object", id: kind.prefix, props: { object: row } } : null), [row, kind]);

  if (!row) {
    return (
      <div className="mx-auto max-w-xl px-6 py-16 text-center text-[13px] text-sol-text-muted">
        No object <span className="font-mono">{shortId}</span> in this workspace{kind ? "" : ", and no mod declares its kind"}.
        {kind ? <> <button className="text-sol-blue hover:underline" onClick={() => modNavigate(objectsHref(kind.prefix))}>All {(kind.plural ?? `${kind.title}s`).toLowerCase()}</button></> : null}
      </div>
    );
  }
  const done = objectStatusIsDone(kind, row.status);
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-6">
      <nav className="mb-3 flex items-center gap-1.5 text-[12px] text-sol-text-dim">
        <DynamicIcon name={(kind?.icon ?? "box") as any} size={13} className="text-sol-violet" />
        {kind ? <button onClick={() => modNavigate(objectsHref(kind.prefix))} className="hover:text-sol-text">{kind.plural ?? `${kind.title}s`}</button> : <span>Objects</span>}
        <span>/</span>
        <span className="font-mono">{row.short_id}</span>
        <span className="ml-auto">updated {formatRelativeTime(row.updated_at)}</span>
      </nav>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => { if (title.trim() && title !== row.title) update(row._id, { title: title.trim() }); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className={`w-full bg-transparent text-[24px] font-semibold tracking-tight text-sol-text outline-none ${done ? "opacity-60" : ""}`}
      />
      {kind?.statuses?.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {kind.statuses.map((s) => {
            const on = (row.status ?? kind.statuses![0]) === s;
            const t = statusTone(kind, s);
            return (
              <button
                key={s}
                onClick={() => !on && update(row._id, { status: s })}
                className="rounded-full border px-2.5 py-0.5 text-[12px] transition-colors"
                style={on ? { color: t, borderColor: t, background: `color-mix(in srgb, ${t} 14%, transparent)` } : { color: "var(--sol-text-muted)", borderColor: "var(--sol-border)" }}
              >
                {s.replace(/_/g, " ")}
              </button>
            );
          })}
        </div>
      ) : null}
      {drawsPage && surface ? <div className="mt-5"><ModSurfaceView runtime={runtime} surface={surface} instance={row.short_id} /></div> : null}
      {kind?.fields && Object.keys(kind.fields).length ? (
        <dl className="mt-5 grid grid-cols-[140px_1fr] items-center gap-x-3 gap-y-1 rounded-xl border border-sol-border bg-sol-card px-4 py-3">
          {Object.entries(kind.fields).map(([name, f]) => (
            <div key={name} className="contents">
              <dt className="text-[12px] text-sol-text-dim">{f.label ?? name.replace(/_/g, " ")}</dt>
              <dd className="min-w-0"><FieldEditor field={f} value={row.fields?.[name]} onChange={(v) => update(row._id, { fields: { [name]: v } })} /></dd>
            </div>
          ))}
        </dl>
      ) : null}
      <section className="mt-5">
        <div className="mb-1.5 flex items-center text-[11px] uppercase tracking-wide text-sol-text-dim">
          <span>Notes</span>
          <button onClick={() => { if (editingBody && body !== (row.body ?? "")) update(row._id, { body }); setEditingBody((v) => !v); }} className="ml-auto normal-case tracking-normal text-[12px] text-sol-text-muted hover:text-sol-text">{editingBody ? "Done" : "Edit"}</button>
        </div>
        {editingBody ? (
          <textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[180px] w-full rounded-lg border border-sol-border bg-sol-bg px-3 py-2 font-mono text-[12.5px] text-sol-text outline-none focus:border-sol-violet" />
        ) : row.body ? (
          <div className="text-[13.5px]"><MarkdownRenderer content={row.body} /></div>
        ) : (
          <button onClick={() => setEditingBody(true)} className="text-[13px] text-sol-text-dim hover:text-sol-text-muted">Add notes in markdown…</button>
        )}
      </section>
      <div className="mt-8 flex items-center gap-3 border-t border-sol-border pt-3 text-[12px] text-sol-text-dim">
        <span className="font-mono">cast obj show {row.short_id}</span>
        <button onClick={() => { update(row._id, { archived: true }); if (kind) modNavigate(objectsHref(kind.prefix)); }} className="ml-auto hover:text-sol-red">Archive</button>
      </div>
    </div>
  );
}
