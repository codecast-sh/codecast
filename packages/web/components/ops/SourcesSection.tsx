// Product sources on Settings, Integrations (external-data.md X1, X10): every
// feed into the workspace being looked at, with pause, key rotation and
// removal, and the add flow. A keyed source's ingest key is shown exactly
// once, when it is minted, beside a snippet that already carries it; after
// that the server holds only its hash.
//
// Sentry and PostHog connect on the token cards above this section, and a
// connection alone mirrors nothing: a source names what to read through it.
// So a connected vendor with no source gets its own "add a source" step here,
// and the add form takes it as a kind beside SDK and HTTP.
//
// An app source is added here with its base url, which makes the workspace's
// app connection in the same step with no secret: codecast signs every call,
// and the app commits the codecast.json shown once it exists.
import { useMemo, useState } from "react";
import Link from "next/link";
import { Check, Copy, Plus, Radio } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpsScope, useOpsSources, useSyncOpsSources } from "../../hooks/useSyncOps";
import { useSettingsData } from "../../hooks/useSyncSettings";
import type { CreateOpsSourceInput } from "../../store/opsSlice";
import type { AppConnectionsResult } from "@codecast/shared/contracts";
import { CONVEX_URL } from "../../lib/convexUrl";
import { copyText } from "../../lib/copyText";
import { formatRelative } from "../../lib/utils";
import { SettingsSection } from "../settings/ui";
import { ConfirmButton } from "../integrations/parts";
import { eventNameRows, KEYED_SOURCE_PROVIDERS, sourceConfigProblem } from "@codecast/shared/contracts/ingest";
import { appSourceSnippets, sourceSnippets, type ConfigSource } from "./opsModel";
import { opsHref } from "./opsPaths";
import { ProviderIcon, SOURCE_PROVIDER_LABEL } from "./parts";
import { ReplayImportLine, hasVendorRecordings } from "./ReplayImport";
import type { OpsSource } from "./opsTypes";
import "./ops.css";

/** What is shown once after a create or rotate: a keyed source's key, or an app source's setup. */
type Reveal = { name: string; key?: string; rotated: boolean; id?: string; workspace?: string };
type Kind = CreateOpsSourceInput["provider"];
type Vendor = Extract<Kind, "sentry" | "posthog">;

const VENDORS: Vendor[] = ["sentry", "posthog"];
const KIND_LABEL: Record<Kind, string> = SOURCE_PROVIDER_LABEL;
const VENDOR_READS: Record<Vendor, string> = { sentry: "its unresolved issues", posthog: "its recordings and the metrics you watch" };

/** Sources that read through a connection rather than a key: the connection's card above has to say connected. */
type Connected = Extract<OpsSource["provider"], Vendor | "app">;
const CONNECTED_PROVIDERS: Connected[] = [...VENDORS, "app"];
const CONNECTION_LABEL: Record<Connected, string> = { sentry: "Sentry", posthog: "PostHog", app: "Your app" };

/**
 * The connections in either scope (the workspace's own, or the person's that
 * follow them), or null until the list has answered, so nothing is called
 * disconnected before anyone has looked.
 */
function useConnections(): Set<Connected> | null {
  const { data } = useSettingsData("connections");
  const apps = (data as AppConnectionsResult | undefined)?.apps;
  return useMemo(() => (apps ? new Set(CONNECTED_PROVIDERS.filter((p) => apps.some((a) => a.id === p && a.status === "connected"))) : null), [apps]);
}

export function SourcesSection() {
  useSyncOpsSources();
  const sources = useOpsSources();
  const connections = useConnections();
  const connected = useMemo(() => VENDORS.filter((v) => connections?.has(v)), [connections]);
  const [adding, setAdding] = useState<Kind | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  // A connection with no source reads nothing yet: offer the step that does.
  const unsourced = connected.filter((v) => !sources.some((s) => s.provider === v));

  return (
    <SettingsSection
      title={<span id="product-sources">Product sources</span>}
      icon={Radio}
      description="What your running product sends: errors, failed jobs, checks, deploys and replays. They show on the Ops page, wake triggers and file problems on the line."
      actions={
        !adding && (
          <button type="button" className="ops-btn" onClick={() => { setAdding("sdk"); setReveal(null); }}>
            <Plus className="w-3.5 h-3.5" /> Add source
          </button>
        )
      }
      padded
    >
      <div className="flex flex-col gap-3">
        {adding && <AddSourceForm initial={adding} vendors={connected} onCancel={() => setAdding(null)} onCreated={(r) => { setAdding(null); setReveal(r); }} />}
        {reveal && (reveal.key ? <KeyReveal reveal={{ ...reveal, key: reveal.key }} onDone={() => setReveal(null)} /> : <AppReveal reveal={reveal} onDone={() => setReveal(null)} />)}
        {!adding && unsourced.map((v) => (
          <div key={v} className="ops-card ops-card-body flex items-center gap-3 text-[12.5px]" data-ops-unsourced={v}>
            <ProviderIcon provider={v} className="w-3.5 h-3.5" />
            <span className="text-sol-text-muted flex-1">
              {KIND_LABEL[v]} is connected, but nothing reads through it yet. Add a source to mirror {VENDOR_READS[v]} into Ops.
            </span>
            <button type="button" className="ops-btn" data-tone="primary" onClick={() => { setAdding(v); setReveal(null); }}>
              <Plus className="w-3.5 h-3.5" /> Add {KIND_LABEL[v]} source
            </button>
          </div>
        ))}
        {sources.length === 0 && !adding && !reveal ? (
          <div className="text-[12.5px] text-sol-text-muted">
            No sources in this workspace yet. An SDK source takes a write-only key that is safe to ship in a browser bundle.
            Connect Sentry or PostHog above to mirror what they already collect, or from a terminal run{" "}
            <span className="ops-mono">cast sources add sentry --projects web,api</span>.
          </div>
        ) : (
          sources.map((s) => (
            <SourceRow
              key={s._id}
              source={s}
              onRotated={setReveal}
              unconnected={!!connections && (CONNECTED_PROVIDERS as string[]).includes(s.provider) && !connections.has(s.provider as Connected)}
            />
          ))
        )}
      </div>
    </SettingsSection>
  );
}

function AddSourceForm({ initial, vendors, onCancel, onCreated }: { initial: Kind; vendors: Vendor[]; onCancel: () => void; onCreated: (r: Reveal | null) => void }) {
  const scope = useOpsScope();
  const [provider, setProvider] = useState<Kind>(initial);
  const keyed = KEYED_SOURCE_PROVIDERS.includes(provider);
  // A vendor source is usually named for the vendor; a keyed one names the product.
  const [name, setName] = useState(keyed ? "" : provider);
  const [projects, setProjects] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kinds: Kind[] = ["sdk", "http", "app", ...VENDORS.filter((v) => vendors.includes(v) || v === initial)];
  const needsUrl = provider === "app" && !baseUrl.trim();
  const pick = (k: Kind) => {
    if (!KEYED_SOURCE_PROVIDERS.includes(k) && (!name.trim() || name === provider)) setName(k);
    setProvider(k);
  };
  const projectList = projects.split(",").map((p) => p.trim()).filter(Boolean);
  const config = provider === "sentry" && projectList.length ? { projects: projectList } : undefined;
  const problem = sourceConfigProblem(provider, config);
  const submit = async () => {
    if (!name.trim() || scope === "skip" || problem || needsUrl) return;
    setBusy(true);
    setError(null);
    try {
      const res = await useInboxStore.getState().createOpsSource({
        name,
        provider,
        ...(config ? { config } : {}),
        ...(provider === "app" ? { base_url: baseUrl.trim() } : {}),
        workspace: scope.workspace,
        ...(scope.workspace === "team" ? { team_id: scope.team_id } : {}),
      });
      const made = res ? { name: res.name, id: res.short_id, workspace: res.workspace } : null;
      if (provider === "app") onCreated(made ? { ...made, rotated: false } : null);
      else if (!keyed) onCreated(null);
      else if (res?.ingest_key) onCreated({ ...made!, key: res.ingest_key, rotated: false });
      else setError("The source was made but no key came back. Rotate its key to get one.");
    } catch (e: any) {
      setError(e?.data?.message ?? e?.message ?? "Could not add the source");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="ops-card ops-card-body flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1 text-[11.5px] text-sol-text-muted flex-1 min-w-[200px]">
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="web, api, mobile"
            className="h-8 rounded-md border border-sol-border bg-sol-bg px-2.5 text-[13px] text-sol-text outline-none focus:border-sol-text-muted"
          />
        </label>
        <div className="ops-seg" role="group" aria-label="Kind">
          {kinds.map((k) => (
            <button key={k} type="button" data-on={provider === k ? "true" : undefined} aria-pressed={provider === k} onClick={() => pick(k)}>{KIND_LABEL[k]}</button>
          ))}
        </div>
        {provider === "app" && (
          <label className="flex flex-col gap-1 text-[11.5px] text-sol-text-muted min-w-[260px] flex-1">
            Base URL
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/api"
              className="h-8 rounded-md border border-sol-border bg-sol-bg px-2.5 text-[13px] text-sol-text outline-none focus:border-sol-text-muted ops-mono"
            />
          </label>
        )}
        {provider === "sentry" && (
          <label className="flex flex-col gap-1 text-[11.5px] text-sol-text-muted min-w-[200px]">
            Projects
            <input
              value={projects}
              onChange={(e) => setProjects(e.target.value)}
              placeholder="every project"
              className="h-8 rounded-md border border-sol-border bg-sol-bg px-2.5 text-[13px] text-sol-text outline-none focus:border-sol-text-muted ops-mono"
            />
          </label>
        )}
        <button type="submit" className="ops-btn" data-tone="primary" disabled={busy || !name.trim() || !!problem || needsUrl}>{busy ? "Adding" : keyed ? "Add and show key" : "Add source"}</button>
        <button type="button" className="ops-btn" onClick={onCancel}>Cancel</button>
      </div>
      <div className="text-[11.5px] text-sol-text-dim">
        The name is how triggers and the CLI pick it (<span className="ops-mono">--source {name.trim().toLowerCase() || "web"}</span>). New and regressed errors file problems on the line by default.
        {provider === "sentry" && " It reads the organization of the Sentry connection; list project slugs to narrow it, comma separated."}
        {provider === "posthog" && " It reads the project of the PostHog connection."}
        {provider === "app" && " Codecast calls the routes the app declares at <base url>/codecast/manifest and signs every call, so there is no secret to paste or set. Next you commit a codecast.json to the app."}
        {!keyed && provider !== "app" && !vendors.includes(provider as Vendor) && ` Connect ${KIND_LABEL[provider]} above first, or it has nothing to read through.`}
      </div>
      {problem && projects.trim() && <div className="text-[12px]" style={{ color: "var(--sol-red)" }}>{problem}</div>}
      {error && <div className="text-[12px]" style={{ color: "var(--sol-red)" }}>{error}</div>}
    </form>
  );
}

/** The source a reveal is for, as codecast.json records it, once the server has answered with its id. */
const configSource = (r: Reveal): ConfigSource | undefined => (r.id && r.workspace ? { name: r.name, id: r.id, workspace: r.workspace } : undefined);

function KeyReveal({ reveal, onDone }: { reveal: Reveal & { key: string }; onDone: () => void }) {
  const snippets = sourceSnippets(reveal.key, CONVEX_URL, configSource(reveal));
  const [tab, setTab] = useState<"config" | "sdk" | "curl">("config");
  const [copied, setCopied] = useState(false);
  return (
    <div className="ops-card ops-card-body flex flex-col gap-3" data-ops-key-reveal>
      <div className="text-[13px] text-sol-text font-medium">
        {reveal.rotated ? `New key for ${reveal.name}` : `${reveal.name} is ready`}
        <span className="text-sol-text-muted font-normal">: copy the key now, it is not shown again{reveal.rotated ? ". The old key already stopped working." : "."}</span>
      </div>
      <div className="ops-key ops-mono">
        <span className="flex-1">{reveal.key}</span>
        <button type="button" className="ops-btn" onClick={() => { void copyText(reveal.key, "Key copied"); setCopied(true); }}>
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} Copy
        </button>
      </div>
      <div className="flex items-center gap-2">
        <div className="ops-seg" role="tablist">
          <button type="button" role="tab" data-on={tab === "config" ? "true" : undefined} aria-selected={tab === "config"} onClick={() => setTab("config")}>codecast.json</button>
          <button type="button" role="tab" data-on={tab === "sdk" ? "true" : undefined} aria-selected={tab === "sdk"} onClick={() => setTab("sdk")}>@platform/analytics</button>
          <button type="button" role="tab" data-on={tab === "curl" ? "true" : undefined} aria-selected={tab === "curl"} onClick={() => setTab("curl")}>HTTP</button>
        </div>
        <div className="flex-1" />
        <button type="button" className="ops-btn" onClick={() => void copyText(snippets[tab], "Snippet copied")}><Copy className="w-3.5 h-3.5" /> Copy snippet</button>
      </div>
      <pre className="ops-code ops-mono">{snippets[tab]}</pre>
      <div className="flex items-center gap-3 text-[11.5px] text-sol-text-dim">
        <span>Send one event, then watch it land on <Link href={opsHref.tab("timeline", { source: reveal.name })} className="text-sol-link hover:underline">the Ops timeline</Link>.</span>
        <div className="flex-1" />
        <button type="button" className="ops-btn" onClick={onDone}>I saved it</button>
      </div>
    </div>
  );
}

/** An app source's setup: the codecast.json the app commits, and the verifier that reads it. Nothing in it is secret. */
function AppReveal({ reveal, onDone }: { reveal: Reveal; onDone: () => void }) {
  const source = configSource(reveal);
  const [tab, setTab] = useState<"config" | "verify">("config");
  if (!source) return null;
  const snippets = appSourceSnippets(source, CONVEX_URL);
  return (
    <div className="ops-card ops-card-body flex flex-col gap-3" data-ops-app-reveal>
      <div className="text-[13px] text-sol-text font-medium">
        {reveal.name} is added
        <span className="text-sol-text-muted font-normal">: commit this codecast.json to the app and verify codecast's signature on its /codecast routes. No secret, no env var.</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="ops-seg" role="tablist">
          <button type="button" role="tab" data-on={tab === "config" ? "true" : undefined} aria-selected={tab === "config"} onClick={() => setTab("config")}>codecast.json</button>
          <button type="button" role="tab" data-on={tab === "verify" ? "true" : undefined} aria-selected={tab === "verify"} onClick={() => setTab("verify")}>Verify</button>
        </div>
        <div className="flex-1" />
        <button type="button" className="ops-btn" onClick={() => void copyText(snippets[tab], "Snippet copied")}><Copy className="w-3.5 h-3.5" /> Copy</button>
      </div>
      <pre className="ops-code ops-mono">{snippets[tab]}</pre>
      <div className="flex items-center gap-3 text-[11.5px] text-sol-text-dim">
        <span>Once the app is deployed with it, its readers list on <Link href={opsHref.tab("apps", { app: source.id })} className="text-sol-link hover:underline">Ops, Apps</Link>, where a person grants its actions.</span>
        <div className="flex-1" />
        <button type="button" className="ops-btn" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

function SourceRow({ source: s, onRotated, unconnected }: { source: OpsSource; onRotated: (r: Reveal) => void; unconnected: boolean }) {
  const now = useCoarseNow(60_000);
  const [rotating, setRotating] = useState(false);
  const store = () => useInboxStore.getState();
  const stub = !s.short_id;
  const rotate = async () => {
    setRotating(true);
    try {
      const res = await store().rotateOpsSourceKey(s._id);
      if (res?.ingest_key) onRotated({ name: s.name, key: res.ingest_key, rotated: true, id: s.short_id, workspace: s.workspace });
    } finally {
      setRotating(false);
    }
  };
  return (
    <div className="py-1.5 border-b last:border-b-0 border-[color:color-mix(in_srgb,var(--sol-border)_60%,transparent)]">
      <div className="flex items-center gap-3 text-[12.5px] whitespace-nowrap">
        <span className="ops-dot" data-status={unconnected && s.status === "active" ? "error" : s.status} />
        <ProviderIcon provider={s.provider} className="w-3.5 h-3.5" />
        <Link href={opsHref.tab("timeline", { source: s.name })} className="text-sol-text font-medium hover:underline shrink-0">{s.name}</Link>
        <span className="ops-mono text-sol-text-dim text-[11px] shrink-0">{s.short_id}</span>
        {s.key_prefix && <span className="ops-mono text-sol-text-dim text-[11px]" title="The key's first characters">{s.key_prefix}…</span>}
        <span className="text-sol-text-muted text-[11.5px] ops-num shrink-0">
          {s.events_today ?? 0} today{(s.dropped_today ?? 0) > 0 ? `, ${s.dropped_today} dropped` : ""}
          {s.last_event_at ? `, last ${formatRelative(s.last_event_at, now)}` : ", nothing yet"}
        </span>
        {/* What is left of the line: the busiest event names, or the error. It truncates; the controls never wrap. */}
        <span className="flex-1 min-w-0 flex items-center gap-3 overflow-hidden">
          <SourceEventNames source={s} now={now} />
          {unconnected && (
            <span className="text-[11.5px] truncate" style={{ color: "var(--sol-orange)" }} title="Its connection is gone, so every read through it fails until it is connected again">
              Reads nothing: connect {CONNECTION_LABEL[s.provider as Connected]} above
            </span>
          )}
          {s.last_error && <span className="text-[11.5px] truncate" style={{ color: "var(--sol-red)" }} title={s.last_error}>{s.last_error}</span>}
        </span>
        {!stub && (
          <>
            {/* A source stopped on a lost connection resumes like a paused one. */}
            <button type="button" className="text-[11px] text-sol-text-muted hover:text-sol-text" onClick={() => store().setOpsSourceStatus(s._id, s.status === "active" ? "paused" : "active")}>
              {s.status === "active" ? "Pause" : "Resume"}
            </button>
            {s.keyed && (
              <button type="button" className="text-[11px] text-sol-text-muted hover:text-sol-text" disabled={rotating} onClick={() => void rotate()}>
                {rotating ? "Rotating" : "Rotate key"}
              </button>
            )}
            <ConfirmButton label="Remove" question="Its issues go too; the timeline keeps its rows." onConfirm={() => store().removeOpsSource(s._id)} />
          </>
        )}
      </div>
      {hasVendorRecordings(s) && (
        <div className="pl-[38px] pt-1">
          <ReplayImportLine source={s} />
        </div>
      )}
    </div>
  );
}

/** The busiest analytics events over the last day, counted per name and hour (never stored); every name in the tooltip. */
function SourceEventNames({ source, now }: { source: OpsSource; now: number }) {
  const rows = eventNameRows(source.event_names, now, 50);
  if (!rows.length) return null;
  const shown = rows.slice(0, 3).filter((r) => r.day > 0);
  return (
    <span className="text-sol-text-dim text-[11px] ops-num truncate min-w-0" title={rows.map((r) => `${r.name}: ${r.day} in 24h`).join("\n")}>
      {shown.length ? shown.map((r) => `${r.name} ${r.day}`).join(", ") : `${rows.length} event name${rows.length === 1 ? "" : "s"}, none in 24h`}
      {rows.length > shown.length && shown.length ? `, +${rows.length - shown.length}` : ""}
    </span>
  );
}
