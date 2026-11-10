// /mods: every mod you can see. Yours with a switch, logs and what each one
// adds; your team's shared ones with who wrote them. Empty, it shows the two
// ways in: one sentence to an agent, or the scaffold's commands.

import { useState } from "react";
import { useAction } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { DynamicIcon } from "./ModIcon";
import { Switch } from "../ui/switch";
import { ModLogList } from "./ModLogList";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { modHost, modNavigate, type ModRow } from "../../lib/mods/host";
import { permissionsSig } from "@codecast/shared/contracts/mods";
import { useModHostVersion, useModRows } from "../../lib/mods/useMods";
import { useInboxStore } from "../../store/inboxStore";
import { formatRelativeTime } from "../../lib/conversationFormat";
import { FeatureUpsell } from "../agentFeatures/FeatureUpsell";
import { CommandDisclosure } from "../secrets/parts";
import { PageFrame, PageHeader } from "../ui/page-header";
import { ConsequentialSwitch, type SwitchLedger, type SwitchRow } from "../consequential/ConsequentialSwitch";

function Chip({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-sol-border px-1.5 py-[1px] text-meta text-sol-text-muted">
      <DynamicIcon name={icon as any} size={11} />
      {children}
    </span>
  );
}

type ModAct = "install" | "review" | "enable";

/**
 * What installing, re-accepting or turning on a mod hands it: every grant as a
 * row of its own, and the machines its local half starts on. Plain data, so it
 * reads the row the confirm will accept.
 */
function modInstallLedger(row: Pick<ModRow, "name" | "title" | "manifest" | "owner_name" | "has_local" | "local_devices" | "local_off">, act: ModAct): SwitchLedger {
  const p = row.manifest?.permissions ?? {};
  const mod = row.title ?? row.name;
  const grant = (v: readonly string[] | "*" | undefined, all: string, noun: string): Omit<SwitchRow, "k"> =>
    v === "*" ? { v: all, tone: "warn" } : !v?.length ? { v: "Nothing" } : v.length === 1 ? { v: v[0] } : { v: `${v.length} ${noun}`, list: [...v] };
  const fetch = p.fetch === "*" ? p.fetch : p.fetch?.map((o) => o.replace(/^https?:\/\//, ""));
  const wide = [p.read, p.write, p.fetch].filter((v) => v === "*").length;
  const count = [p.read, p.write, p.fetch, p.connectors].filter((v) => v === "*" || (Array.isArray(v) && v.length > 0)).length;
  const off = new Set(row.local_off ?? []);
  const machines = (row.local_devices ?? []).map((d) => d.device).filter((d) => !off.has(d));
  return {
    name: mod,
    subject: row.owner_name ? `By ${row.owner_name}` : row.name,
    shift: act === "install" ? ["Not installed", "Installed"] : act === "review" ? ["Old grants", "New grants"] : undefined,
    figures: [
      { value: String(count), label: count === 1 ? "grant" : "grants", tone: count ? "warn" : undefined },
      ...(wide ? [{ value: String(wide), label: "unlimited", tone: "warn" as const }] : []),
    ],
    rows: [
      { k: "Reads", ...grant(p.read, "Everything", "kinds") },
      { k: "Writes", ...grant(p.write, "Everything", "actions") },
      ...(p.connectors?.length ? [{ k: "Connectors", ...grant(p.connectors, "All", "connectors") }] : []),
      { k: "Fetches", ...grant(fetch, "Anywhere", "sites") },
      ...(row.has_local ? [machines.length ? { k: "Starts on", v: machines.length === 1 ? machines[0] : `${machines.length} machines`, list: machines.length > 1 ? machines : undefined, tone: "warn" as const } : { k: "Starts on", v: "Each of your machines", tone: "warn" as const }] : []),
      { k: "Runs as", v: "You, sandboxed" },
    ],
    stop: act === "enable" ? "Its switch" : "Press Installed",
    confirm: act === "install" ? `Install ${mod}` : act === "review" ? "Accept the new grants" : `Turn on ${mod}`,
    keep: act === "enable" ? undefined : "Not now",
  };
}

/**
 * A teammate's shared mod runs for you once you install it, at the grants the
 * card shows. If its author widens them, it stops until you review again.
 * Installing and re-accepting go through the shared review; uninstalling is one press.
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
    <ConsequentialSwitch
      on={state === "installed"}
      ledger={modInstallLedger(row, state === "review" ? "review" : "install")}
      // The signature of the grants the review just showed: the row this render read.
      onTurnOn={() => set(current)}
      onTurnOff={() => set(null)}
      trigger={({ on, press }) => (
        <button
          type="button"
          onClick={press}
          aria-haspopup={on ? undefined : "dialog"}
          title={state === "review" ? "Its author changed what it may read, write or fetch" : undefined}
          className={`shrink-0 rounded-md border px-2.5 py-1 text-[12px] transition-colors ${state === "installed" ? "border-sol-border text-sol-text-muted hover:text-sol-text" : state === "review" ? "border-sol-yellow text-sol-yellow" : "border-sol-violet bg-[color-mix(in_srgb,var(--sol-violet)_12%,transparent)] text-sol-violet"}`}
        >
          {state === "installed" ? "Installed" : state === "review" ? "Grants changed: review…" : "Install…"}
        </button>
      )}
    />
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
      <div className="flex items-center gap-1.5 text-mark uppercase tracking-wide text-sol-text-dim">
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
                <span className="shrink-0 text-meta" style={{ color: tone }}>{state}</span>
                {state === "failed" && r?.error ? <span className="min-w-0 truncate text-meta text-sol-text-dim" title={r.error}>{r.error}</span> : null}
                {r ? <span className="ml-auto shrink-0 text-meta text-sol-text-dim">{formatRelativeTime(r.at)}</span> : <span className="ml-auto" />}
                <Switch checked={on} disabled={!row.enabled} onCheckedChange={(v: boolean) => useInboxStore.getState().setModLocalDevice(row._id, device, v)} />
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-1 text-[12px] text-sol-text-muted">{row.enabled ? "Starting on each of your machines" : "Off"}</div>
      )}
    </div>
  );
}

const api = _api as any;

/**
 * The keys the author's mod declares, each with where it may be sent and
 * whether it is set. A value goes straight to the server, which encrypts it,
 * and is never shown again; it skips the store on purpose, so no outbox or
 * cache on this device ever holds it.
 */
function Secrets({ row }: { row: ModRow }) {
  const secrets = row.manifest?.secrets ?? [];
  const setAt = new Map((row.secrets_set ?? []).map((s) => [s.name, s.at]));
  return (
    <div className="mx-4 mt-3 rounded-lg border border-sol-border bg-sol-bg-alt/40 px-3 py-2">
      <div className="flex items-center gap-1.5 text-mark uppercase tracking-wide text-sol-text-dim">
        <DynamicIcon name="key-round" size={12} />
        Keys
      </div>
      <ul className="mt-1.5 space-y-1.5">
        {secrets.map((s) => <SecretRow key={s.name} modId={row._id} name={s.name} description={s.description} origins={s.origins} at={setAt.get(s.name)} />)}
      </ul>
    </div>
  );
}

function SecretRow({ modId, name, description, origins, at }: { modId: string; name: string; description?: string; origins: string[]; at?: number }) {
  const set = useAction(api.modSecrets.webSet);
  const [editing, setEditing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (next: string) => {
    setBusy(true);
    setError(null);
    const res = await set({ mod_id: modId, secret: name, value: next }).catch((err: Error) => ({ error: err.message }));
    setBusy(false);
    if (res?.error) return setError(res.error);
    setValue("");
    setEditing(false);
  };
  const tone = at ? "var(--sol-green)" : "var(--sol-yellow)";
  return (
    <li className="text-[12.5px]">
      <div className="flex items-center gap-2">
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: tone }} />
        <span className="font-mono text-sol-text" title={description}>{name}</span>
        <span className="min-w-0 truncate text-meta text-sol-text-dim">{origins.map((o) => o.replace(/^https?:\/\//, "")).join(", ")}</span>
        <span className="ml-auto shrink-0 text-meta" style={{ color: tone }}>{at ? `set ${formatRelativeTime(at)}` : "not set"}</span>
        {at && !editing && clearing ? (
          // A cleared key cannot be shown again, so clearing asks once, in place.
          <span className="inline-flex shrink-0 items-center gap-1.5 text-meta" role="group" aria-label={`Clear ${name}?`}>
            <span className="text-sol-text">Clear key?</span>
            <button type="button" onClick={() => { setClearing(false); void save(""); }} disabled={busy} className="rounded px-1 py-0.5 text-sol-red hover:bg-sol-red/10">Clear</button>
            <button type="button" onClick={() => setClearing(false)} autoFocus className="rounded px-1 py-0.5 text-sol-text-muted hover:text-sol-text">Keep</button>
          </span>
        ) : at && !editing ? (
          <>
            <button type="button" onClick={() => setEditing(true)} className="shrink-0 rounded px-1 py-0.5 text-meta text-sol-text-muted hover:text-sol-text">Replace</button>
            <button type="button" onClick={() => setClearing(true)} disabled={busy} className="shrink-0 rounded px-1 py-0.5 text-meta text-sol-text-muted hover:text-sol-red">Clear</button>
          </>
        ) : null}
      </div>
      {!at || editing ? (
        <form className="mt-1 flex items-center gap-1.5 pl-3.5" onSubmit={(e) => { e.preventDefault(); if (value.trim()) void save(value); }}>
          <input
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`Paste ${name}`}
            className="min-w-0 flex-1 rounded-md border border-sol-border bg-sol-bg px-2 py-1 font-mono text-[12px] text-sol-text outline-none focus:border-sol-violet"
          />
          <button type="submit" disabled={busy || !value.trim()} className="rounded-md border border-sol-violet px-2 py-1 text-[12px] text-sol-violet disabled:opacity-40">{busy ? "Saving" : "Save"}</button>
          {editing ? <button type="button" onClick={() => { setEditing(false); setValue(""); }} className="text-[12px] text-sol-text-muted hover:text-sol-text">Cancel</button> : null}
        </form>
      ) : null}
      {error ? <div className="mt-0.5 pl-3.5 text-meta text-sol-red">{error}</div> : null}
    </li>
  );
}

function ModCard({ row }: { row: ModRow }) {
  useModHostVersion();
  const runtime = modHost.get(row._id);
  const [open, setOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
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
            <span className="inline-flex items-center gap-1 text-meta" style={{ color: statusTone }}>
              <span className="size-1.5 rounded-full" style={{ background: statusTone }} />
              {status}
            </span>
          </div>
          <div className="mt-0.5 font-mono text-meta text-sol-text-dim">
            {row.name} · {row.version ? `v${row.version}` : "dev"} · rev {row.rev} · {formatRelativeTime(row.updated_at)}
            {row.is_mine === false && row.owner_name ? ` · by ${row.owner_name}` : ""}
            {row.shared && row.is_mine ? " · shared" : ""}
          </div>
        </div>
        {row.is_mine !== false ? (
          <ConsequentialSwitch
            on={row.enabled}
            ledger={modInstallLedger(row, "enable")}
            onTurnOn={() => useInboxStore.getState().setModEnabled(row._id, true)}
            onTurnOff={() => useInboxStore.getState().setModEnabled(row._id, false)}
            trigger={({ on, press }) => <Switch checked={on} onCheckedChange={press} aria-label={`${row.title ?? row.name} on`} aria-haspopup={on ? undefined : "dialog"} />}
          />
        ) : (
          <InstallButton row={row} />
        )}
      </div>
      {row.description ? <p className="px-4 pt-2 text-[12.5px] leading-relaxed text-sol-text-muted">{row.description}</p> : null}
      <div className="flex flex-wrap gap-1.5 px-4 pt-3">
        {(m.panes ?? []).map((p) => <Chip key={`p${p.id}`} icon="panel-right">{p.title}</Chip>)}
        {(m.commands ?? []).map((c) => <Chip key={`c${c.id}`} icon="command">{c.title}</Chip>)}
        {m.agents ? (
          <button onClick={() => setAgentsOpen((v) => !v)} aria-expanded={agentsOpen} className="rounded-md hover:bg-sol-bg-alt">
            <Chip icon="bot">for agents</Chip>
          </button>
        ) : null}
        {(m.objects ?? []).map((o) => <Chip key={`o${o.prefix}`} icon={o.icon ?? "box"}>{o.plural ?? `${o.title}s`} · {o.prefix}-N</Chip>)}
        {(m.fences ?? []).map((f) => <Chip key={`f${f.lang}`} icon="code">```{f.lang}</Chip>)}
        {m.permissions?.read ? <Chip icon="eye">reads {m.permissions.read === "*" ? "everything" : m.permissions.read.join(", ")}</Chip> : null}
        {m.permissions?.write ? <Chip icon="pen-line">writes {m.permissions.write === "*" ? "everything" : m.permissions.write.join(", ")}</Chip> : null}
        {m.permissions?.connectors?.length ? <Chip icon="plug">reads {m.permissions.connectors.join(", ")}</Chip> : null}
        {m.permissions?.fetch ? <Chip icon="globe">fetches {m.permissions.fetch === "*" ? "anywhere" : m.permissions.fetch.map((o) => o.replace(/^https?:\/\//, "")).join(", ")}</Chip> : null}
      </div>
      {agentsOpen && m.agents ? <div className="mx-4 mt-3 max-h-72 overflow-auto rounded-lg border border-sol-border bg-sol-bg-alt/40 px-3 py-2 text-[12.5px]"><MarkdownRenderer content={m.agents} /></div> : null}
      {row.is_mine !== false && m.secrets?.length ? <Secrets row={row} /> : null}
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
      <div className="mt-5 rounded-lg bg-sol-bg-alt/60 px-4 py-3">
        <div className="text-mark uppercase tracking-wide text-sol-text-dim">Ask an agent</div>
        <div className="mt-1.5 text-[13px] text-sol-text">"Make me a codecast mod that shows which of my sessions are waiting, grouped by repo."</div>
      </div>
      <div className="mt-4"><CommandDisclosure label="Start from the scaffold" text={SCAFFOLD} data-mods-scaffold /></div>
    </div>
  );
}

const SCAFFOLD = "cast mod new my-mod\ncd my-mod && cast mod dev";

export function ModsPage() {
  const rows = useModRows();
  const mine = rows.filter((r) => r.is_mine !== false);
  const shared = rows.filter((r) => r.is_mine === false);
  const forScripts = <CommandDisclosure label="For scripts" text="cast mod new <name>" />;
  const legacy = (
      <header className="mb-5 flex items-center gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight text-sol-text">Mods</h1>
        {rows.length ? <div className="ml-auto">{forScripts}</div> : null}
      </header>
  );
  return (
    <PageFrame
      header={<PageHeader legacy={legacy} title="Mods" count={rows.length || null} actions={rows.length ? forScripts : null} />}
      legacyColumn="mx-auto w-full max-w-5xl px-6 py-6"
      column="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6"
    >
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
    </PageFrame>
  );
}
