// The Apps tab (X8): each app connector source with the readers and actions
// its manifest declares, the grants in force (a toggle per action), its
// watches, and the audit of every call made through it. Bodies are never
// stored, so the audit is who, what, how it went and how big.
import { useMemo } from "react";
import Link from "next/link";
import { activeGrant, parseAppManifest, watchKey, type AppManifest } from "@codecast/shared/contracts/appConnector";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpsApp, useOpsAppCalls, useOpsSources, useSyncOpsApp } from "../../hooks/useSyncOps";
import { useInboxStore } from "../../store/inboxStore";
import { relTimeShort } from "../../lib/utils";
import { Switch } from "../ui/switch";
import { EntityIdPill } from "../EntityIdPill";
import { opsHref } from "./opsPaths";
import { OpsEmpty, SourceChip } from "./parts";
import type { OpsSource } from "./opsTypes";

export function AppsTab({ app }: { app: string | null }) {
  const sources = useOpsSources();
  const apps = useMemo(() => sources.filter((s) => s.provider === "app"), [sources]);
  const selected = apps.find((s) => s.short_id === app || s._id === app || s.name === app) ?? apps[0];

  if (apps.length === 0) {
    return (
      <OpsEmpty title="No app connected">
        Your product declares what codecast may read and do at <span className="ops-mono">/codecast/manifest</span>. Connect it on
        Settings, Integrations, then grant actions here. Raw SQL is never a reader.
      </OpsEmpty>
    );
  }

  return (
    <div className="ops-pad">
      {apps.length > 1 && (
        <div className="ops-filters">
          {apps.map((s) => (
            <SourceChip key={s._id} source={s} href={opsHref.tab("apps", { app: s.short_id || s._id })} on={s._id === selected?._id} />
          ))}
        </div>
      )}
      {selected && <AppDetail source={selected} />}
    </div>
  );
}

function AppDetail({ source }: { source: OpsSource }) {
  useSyncOpsApp(source._id);
  const app = useOpsApp(source._id);
  const calls = useOpsAppCalls(source._id);
  const now = useCoarseNow(60_000);
  const manifest: AppManifest | null = useMemo(() => {
    if (!app?.manifest_json) return null;
    try {
      const parsed = parseAppManifest(JSON.parse(app.manifest_json));
      return parsed.ok ? parsed.manifest : null;
    } catch {
      return null;
    }
  }, [app?.manifest_json]);
  const grant = (action: string) => activeGrant(app?.grants ?? [], action, now);
  const setGrant = (action: string, on: boolean) => {
    const store = useInboxStore.getState();
    if (on) store.grantOpsAction(source._id, action);
    else store.revokeOpsAction(source._id, action);
  };

  if (!app) return <div className="ops-quiet text-[12.5px] py-8">Reading {source.name}&apos;s manifest…</div>;
  if (!manifest) {
    return (
      <OpsEmpty title={`${source.name} has no manifest yet`}>
        {source.last_error ?? "The manifest is fetched when the app connects and refreshed daily."} Refresh it with{" "}
        <span className="ops-mono">cast app refresh {source.name}</span>.
      </OpsEmpty>
    );
  }

  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
      <div className="ops-card">
        <div className="ops-card-head">
          <span>Readers <span className="ops-dim ops-num">{manifest.readers.length}</span></span>
          <span className="ops-dim text-[11px] font-normal">
            {manifest.name} {manifest.version}
            {app.manifest_fetched_at ? `, fetched ${relTimeShort(app.manifest_fetched_at, now)} ago` : ""}
          </span>
        </div>
        <div className="ops-card-body flex flex-col gap-2">
          {manifest.readers.length === 0 && <span className="ops-dim">None declared.</span>}
          {manifest.readers.map((r) => (
            <div key={r.name}>
              <div className="flex items-baseline gap-2">
                <span className="ops-mono text-sol-text">{r.name}</span>
                <span className="ops-dim ops-mono text-[11px]">{r.method} {r.path}</span>
              </div>
              <div className="ops-quiet text-[11.5px]">{r.description ?? r.title}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="ops-card">
        <div className="ops-card-head">
          <span>Actions <span className="ops-dim ops-num">{manifest.actions.length}</span></span>
          <span className="ops-dim text-[11px] font-normal">an agent runs only what is granted</span>
        </div>
        <div className="ops-card-body flex flex-col gap-2.5">
          {manifest.actions.length === 0 && <span className="ops-dim">None declared.</span>}
          {manifest.actions.map((a) => {
            const g = grant(a.name);
            return (
              <div key={a.name} className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="ops-mono text-sol-text">{a.name}</span>
                    {a.risk === "high" && <span className="ops-pill" style={{ color: "var(--sol-red)", background: "color-mix(in srgb, var(--sol-red) 12%, transparent)" }}>high risk</span>}
                    {!a.idempotent && <span className="ops-dim text-[11px]">not idempotent</span>}
                  </div>
                  <div className="ops-quiet text-[11.5px]">{a.description ?? a.title}</div>
                  {g && <div className="ops-dim text-[11px]">granted {relTimeShort(g.granted_at, now)} ago{g.until ? `, until ${new Date(g.until).toLocaleDateString()}` : ""}</div>}
                </div>
                <Switch checked={!!g} onCheckedChange={(on) => setGrant(a.name, on)} aria-label={`Grant ${a.name}`} />
              </div>
            );
          })}
        </div>
      </div>

      {manifest.watches.length > 0 && (
        <div className="ops-card" style={{ gridColumn: "1 / -1" }}>
          <div className="ops-card-head"><span>Watches</span><span className="ops-dim text-[11px] font-normal">polled readers that become checks and jobs</span></div>
          <div className="ops-card-body">
            <table className="ops-table">
              <tbody>
                {manifest.watches.map((w) => {
                  const st = app.watch_state.find((s) => s.key === watchKey(w));
                  return (
                    <tr key={watchKey(w)}>
                      <td className="ops-mono">{w.reader}</td>
                      <td className="ops-quiet">{w.kind}</td>
                      <td className="ops-quiet">every {w.every}</td>
                      <td className="ops-num ops-quiet">{st ? `polled ${relTimeShort(st.polled_at, now)} ago` : "not polled yet"}</td>
                      <td style={{ color: "var(--sol-red)" }} className="text-[11.5px]">{st?.last_error ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="ops-card" style={{ gridColumn: "1 / -1" }}>
        <div className="ops-card-head"><span>Calls <span className="ops-dim ops-num">{calls.length}</span></span><span className="ops-dim text-[11px] font-normal">bodies are never stored</span></div>
        {calls.length === 0 ? (
          <div className="ops-card-body ops-dim">No calls yet. <span className="ops-mono">cast app {source.name} read &lt;reader&gt;</span> makes one.</div>
        ) : (
          <table className="ops-table">
            <thead>
              <tr><th>Call</th><th>Status</th><th style={{ textAlign: "right" }}>ms</th><th style={{ textAlign: "right" }}>bytes</th><th>Session</th><th>When</th></tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c._id}>
                  <td><span className="ops-dim">{c.kind}</span> <span className="ops-mono">{c.name}</span></td>
                  <td style={{ color: c.status === "ok" ? "var(--sol-green)" : "var(--sol-red)" }} title={c.error}>{c.status}{c.http_status ? ` ${c.http_status}` : ""}</td>
                  <td className="ops-num text-right ops-quiet">{c.ms}</td>
                  <td className="ops-num text-right ops-quiet">{c.bytes.toLocaleString()}</td>
                  <td>{c.conversation_id ? <EntityIdPill type="session" id={c.conversation_id} compact /> : <span className="ops-dim">person</span>}</td>
                  <td className="ops-num ops-quiet">{relTimeShort(c.created_at, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="ops-dim text-[11px]" style={{ gridColumn: "1 / -1" }}>
        Grants also work from the CLI: <span className="ops-mono">cast app grant {source.name} &lt;action&gt; --until 30d</span>. <Link href={opsHref.tab("timeline", { source: source.name })} className="hover:underline">This source on the timeline</Link>.
      </div>
    </div>
  );
}
