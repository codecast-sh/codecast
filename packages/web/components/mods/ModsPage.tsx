// /mods: every mod you can see. Yours with a switch, logs and what each one
// adds; your team's shared ones with who wrote them. Empty, it teaches the
// loop: one sentence to an agent, or `cast mod new`.

import { useState } from "react";
import { DynamicIcon } from "lucide-react/dynamic";
import { Switch } from "../ui/switch";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { isMac } from "../../shortcuts/registry";
import { ModLogList } from "./ModLogList";
import { modHost, modNavigate, type ModRow } from "../../lib/mods/host";
import { permissionsSig } from "@codecast/shared/contracts/mods";
import { useModHostVersion, useModRows } from "../../lib/mods/useMods";
import { useInboxStore } from "../../store/inboxStore";
import { formatRelativeTime } from "../../lib/conversationFormat";
import { FeatureUpsell } from "../agentFeatures/FeatureUpsell";

function Chip({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-sol-border px-1.5 py-[1px] text-[11px] text-sol-text-muted">
      <DynamicIcon name={icon as any} size={11} />
      {children}
    </span>
  );
}

/**
 * A teammate's shared mod runs for you once you install it, at the grants the
 * card shows. If its author widens them, it stops until you review again.
 */
function InstallButton({ row }: { row: ModRow }) {
  const list = useInboxStore((s) => s.clientState.ui?.mods_installed) ?? [];
  const entry = list.find((x) => x.startsWith(`${row._id}:`));
  const current = `${row._id}:${permissionsSig(row.manifest)}`;
  const state = !entry ? "install" : entry === current ? "installed" : "review";
  const set = (next: string | null) => {
    const keep = (useInboxStore.getState().clientState.ui?.mods_installed ?? []).filter((x) => !x.startsWith(`${row._id}:`));
    useInboxStore.getState().updateClientUI({ mods_installed: next ? [...keep, next] : keep });
  };
  return (
    <button
      onClick={() => set(state === "installed" ? null : current)}
      title={state === "review" ? "Its author changed what it may read, write or fetch. The card lists the new grants; install again to accept them." : undefined}
      className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${state === "installed" ? "border-sol-border text-sol-text-muted hover:text-sol-text" : state === "review" ? "border-sol-yellow text-sol-yellow" : "border-sol-violet bg-[color-mix(in_srgb,var(--sol-violet)_12%,transparent)] text-sol-violet"}`}
    >
      {state === "installed" ? "Installed" : state === "review" ? "Grants changed: review" : "Install"}
    </button>
  );
}

/**
 * Where an author's local half runs: every machine whose daemon has reported
 * on it, with a switch each. A daemon starts an enabled half on its own within
 * 30s of a push; this is the one place to keep it off a machine.
 */
function LocalHalf({ row }: { row: ModRow }) {
  const off = new Set(row.local_off ?? []);
  const devices = [...new Set([...(row.local_devices ?? []).map((d) => d.device), ...off])].sort();
  const report = (device: string) => row.local_devices?.find((d) => d.device === device);
  return (
    <div className="mx-4 mt-3 rounded-lg border border-sol-border bg-sol-bg-alt/40 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-sol-text-dim">
        <DynamicIcon name="hard-drive" size={12} />
        Runs on your machines
      </div>
      {row.manifest?.local?.description ? <div className="mt-0.5 text-[12px] leading-snug text-sol-text-muted">{row.manifest.local.description}</div> : null}
      {devices.length ? (
        <ul className="mt-1.5 space-y-1">
          {devices.map((device) => {
            const r = report(device);
            const on = !off.has(device);
            const state = !row.enabled || !on ? "off" : r?.state === "running" ? "running" : r?.state === "failed" ? "failed" : "starting";
            const tone = { off: "var(--sol-text-dim)", running: "var(--sol-green)", failed: "var(--sol-red)", starting: "var(--sol-yellow)" }[state];
            return (
              <li key={device} className="flex items-center gap-2 text-[12.5px]">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: tone }} />
                <span className="truncate text-sol-text">{device}</span>
                <span className="shrink-0 text-[11px]" style={{ color: tone }}>{state}</span>
                {state === "failed" && r?.error ? <span className="min-w-0 truncate text-[11px] text-sol-text-dim" title={r.error}>{r.error}</span> : null}
                {r ? <span className="ml-auto shrink-0 text-[11px] text-sol-text-dim">{formatRelativeTime(r.at)}</span> : <span className="ml-auto" />}
                <Switch checked={on} disabled={!row.enabled} onCheckedChange={(v: boolean) => useInboxStore.getState().setModLocalDevice(row._id, device, v)} />
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-1 text-[12px] text-sol-text-muted">{row.enabled ? "Each of your machines starts it within 30 seconds." : "Turn the mod on and each of your machines starts it within 30 seconds."}</div>
      )}
    </div>
  );
}

function ModCard({ row }: { row: ModRow }) {
  useModHostVersion();
  const runtime = modHost.get(row._id);
  const [open, setOpen] = useState(false);
  const m = row.manifest ?? ({} as ModRow["manifest"]);
  const errors = runtime?.logs.filter((l) => l.level === "error") ?? [];
  const status = !row.enabled ? "off" : runtime?.status === "failed" ? "failed" : runtime?.status === "ready" ? "running" : row.is_mine === false && !runtime ? "shared" : "starting";
  const statusTone = { off: "var(--sol-text-dim)", failed: "var(--sol-red)", running: "var(--sol-green)", starting: "var(--sol-yellow)", shared: "var(--sol-cyan)" }[status];
  const firstPane = m.panes?.[0]?.id;
  return (
    <article className="group rounded-xl border border-sol-border bg-sol-card transition-colors hover:border-[color-mix(in_srgb,var(--sol-violet)_40%,var(--sol-border))]">
      <div className="flex items-start gap-3 px-4 pt-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--sol-violet)_13%,transparent)] text-sol-violet">
          <DynamicIcon name={(m.icon ?? "blocks") as any} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <button
              disabled={!firstPane || !row.enabled}
              onClick={() => firstPane && modNavigate(`/m/${row.name}/${firstPane}`)}
              className="truncate text-left text-[14px] font-semibold text-sol-text enabled:hover:underline underline-offset-2"
            >
              {row.title ?? row.name}
            </button>
            <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: statusTone }}>
              <span className="size-1.5 rounded-full" style={{ background: statusTone }} />
              {status}
            </span>
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-sol-text-dim">
            {row.name} · {row.version ? `v${row.version}` : "dev"} · rev {row.rev} · {formatRelativeTime(row.updated_at)}
            {row.is_mine === false && row.owner_name ? ` · by ${row.owner_name}` : ""}
            {row.shared && row.is_mine ? " · shared" : ""}
          </div>
        </div>
        {row.is_mine !== false ? (
          <Switch checked={row.enabled} onCheckedChange={(v: boolean) => useInboxStore.getState().setModEnabled(row._id, v)} />
        ) : (
          <InstallButton row={row} />
        )}
      </div>
      {row.description ? <p className="px-4 pt-2 text-[12.5px] leading-relaxed text-sol-text-muted">{row.description}</p> : null}
      <div className="flex flex-wrap gap-1.5 px-4 pt-3">
        {(m.panes ?? []).map((p) => <Chip key={`p${p.id}`} icon="panel-right">{p.title}</Chip>)}
        {(m.commands ?? []).map((c) => <Chip key={`c${c.id}`} icon="command">{c.title}</Chip>)}
        {(m.objects ?? []).map((o) => <Chip key={`o${o.prefix}`} icon={o.icon ?? "box"}>{o.plural ?? `${o.title}s`} · {o.prefix}-N</Chip>)}
        {(m.fences ?? []).map((f) => <Chip key={`f${f.lang}`} icon="code">```{f.lang}</Chip>)}
        {m.permissions?.read ? <Chip icon="eye">reads {m.permissions.read === "*" ? "everything" : m.permissions.read.join(", ")}</Chip> : null}
        {m.permissions?.write ? <Chip icon="pen-line">writes {m.permissions.write === "*" ? "everything" : m.permissions.write.join(", ")}</Chip> : null}
        {m.permissions?.fetch ? <Chip icon="globe">fetches {m.permissions.fetch === "*" ? "anywhere" : m.permissions.fetch.map((o) => o.replace(/^https?:\/\//, "")).join(", ")}</Chip> : null}
      </div>
      {row.is_mine !== false && row.has_local ? <LocalHalf row={row} /> : null}
      <div className="mt-3 flex items-center gap-3 border-t border-sol-border px-4 py-2">
        <button onClick={() => setOpen((v) => !v)} className="text-[12px] text-sol-text-muted hover:text-sol-text">
          {open ? "Hide logs" : "Logs"}{errors.length ? <span className="ml-1 text-sol-red tabular-nums">{errors.length} error{errors.length === 1 ? "" : "s"}</span> : null}
        </button>
        {runtime?.status === "failed" ? <span className="truncate text-[12px] text-sol-red">{runtime.error?.split("\n")[0]}</span> : null}
        {firstPane && row.enabled ? <button onClick={() => modNavigate(`/m/${row.name}/${firstPane}`)} className="ml-auto text-[12px] text-sol-blue hover:underline">Open</button> : null}
      </div>
      {open ? <div className="max-h-72 overflow-auto border-t border-sol-border px-3 py-2"><ModLogList runtime={runtime} /></div> : null}
    </article>
  );
}

function EmptyMods() {
  return (
    <div className="mx-auto mt-6 max-w-2xl rounded-2xl border border-dashed border-sol-border px-8 py-10">
      <div className="text-[18px] font-semibold text-sol-text">Make codecast yours</div>
      <p className="mt-2 text-[13px] leading-relaxed text-sol-text-muted">
        A mod adds panes, commands and new kinds of blocks agents can draw, in one small file that runs sandboxed. Describe one to any agent, or start from the scaffold.
      </p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-sol-bg-alt/60 px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-sol-text-dim">Ask an agent</div>
          <div className="mt-1.5 text-[13px] text-sol-text">"Make me a codecast mod that shows which of my sessions are waiting, grouped by repo."</div>
        </div>
        <div className="rounded-lg bg-sol-bg-alt/60 px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-sol-text-dim">Or from a terminal</div>
          <pre className="mt-1.5 font-mono text-[12px] leading-relaxed text-sol-text">cast mod new my-mod{"\n"}cd my-mod && cast mod dev</pre>
        </div>
      </div>
      <div className="mt-4 text-[12px] text-sol-text-dim">Mods open from the palette: <KeyCap>{isMac ? "⌘" : "Ctrl"}</KeyCap><KeyCap>K</KeyCap>, then the mod's name.</div>
    </div>
  );
}

export function ModsPage() {
  const rows = useModRows();
  const mine = rows.filter((r) => r.is_mine !== false);
  const shared = rows.filter((r) => r.is_mine === false);
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      <header className="mb-5 flex items-end gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-sol-text">Mods</h1>
          <p className="mt-0.5 text-[13px] text-sol-text-muted">Panes, commands and blocks you and your agents added to codecast.</p>
        </div>
        {rows.length ? <span className="ml-auto font-mono text-[12px] text-sol-text-dim">cast mod new &lt;name&gt;</span> : null}
      </header>
      <FeatureUpsell slug="mods" className="mb-5" reason="Ask an agent for a view or tool codecast does not have, and watch it get built right in the conversation." />
      {!rows.length ? <EmptyMods /> : null}
      {mine.length ? (
        <section className="grid gap-3 md:grid-cols-2">
          {mine.map((r) => <ModCard key={r._id} row={r} />)}
        </section>
      ) : null}
      {shared.length ? (
        <>
          <h2 className="mb-3 mt-8 text-[12px] uppercase tracking-wide text-sol-text-dim">Shared by your team</h2>
          <section className="grid gap-3 md:grid-cols-2">
            {shared.map((r) => <ModCard key={r._id} row={r} />)}
          </section>
        </>
      ) : null}
    </div>
  );
}
