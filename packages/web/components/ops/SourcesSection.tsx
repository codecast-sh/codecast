// Product sources on Settings, Integrations (external-data.md X1, X10): every
// feed into the workspace being looked at, with pause, key rotation and
// removal, and the add flow. A keyed source's ingest key is shown exactly
// once, when it is minted, beside a snippet that already carries it; after
// that the server holds only its hash.
//
// Adding a source here is the Ops connect sheet (ConnectSheet), the one setup
// path: every provider in one picker, a vendor's token step inline, GitHub CI
// through its app. A connected vendor with no source gets its own step here.
//
// An app source is added with its base url, which makes the workspace's app
// connection in the same step with no secret: codecast signs every call, and
// the app commits the codecast.json shown once it exists.
//
// A link can land on one source's row (`#source-<short id>`, the overview's
// Settings button) or on the section (`#product-sources`): it scrolls there,
// and a row it names is lit.
import { useMemo, useState } from "react";
import Link from "next/link";
import { Check, Copy, Plus, Radio } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useOpsGroups, useOpsReplays, useOpsScope, useOpsSources, useSyncOpsGroups, useSyncOpsReplays, useSyncOpsSources, useSyncOpsWatches } from "../../hooks/useSyncOps";
import { useSettingsData } from "../../hooks/useSyncSettings";
import type { CreateOpsSourceInput } from "../../store/opsSlice";
import type { AppConnectionsResult } from "@codecast/shared/contracts";
import { CONVEX_URL } from "../../lib/convexUrl";
import { copyText } from "../../lib/copyText";
import { relTimeShort } from "../../lib/utils";
import { SettingsSection } from "../settings/ui";
import { RemoveSourceButton } from "./RemoveSource";
import { VendorProjectPicker } from "./VendorProjects";
import { eventNameRows, KEYED_SOURCE_PROVIDERS, sourceConfigProblem } from "@codecast/shared/contracts/ingest";
import { ConnectSheet, type SheetKind } from "./ConnectSheet";
import { openIssueCount } from "./issuesModel";
import { eventsLast24h, settingsAnchor } from "./sourceViewModel";
import { clearSettingsAnchor, peekSettingsAnchor } from "../../lib/settingsSections";
import { appSourceSnippets, sourceSnippets, type ConfigSource } from "./opsModel";
import { opsHref } from "./opsPaths";
import { ProviderIcon, SOURCE_PROVIDER_LABEL } from "./parts";
import { ReplayImportLine, hasVendorRecordings } from "./ReplayImport";
import { projectSourceName } from "./useVendorProjects";
import { useSourceHealthMap } from "./useSourceHealth";
import { HealthBadge, HealthFixButton } from "./SourceHealthParts";
import { RotateKeyButton } from "./RotateKey";
import type { SourceHealth } from "./sourceHealth";
import type { OpsSource } from "./opsTypes";
import "./ops.css";

/** What is shown once after a create or rotate: a keyed source's key, or an app source's setup. */
export type Reveal = { name: string; key?: string; rotated: boolean; id?: string; workspace?: string; /** A rotation that kept the old key: when it stops working. */ oldUntil?: number };
export type Kind = CreateOpsSourceInput["provider"];
export type Vendor = Extract<Kind, "sentry" | "posthog">;

const VENDORS: Vendor[] = ["sentry", "posthog"];
const isVendorKind = (k: Kind): k is Vendor => (VENDORS as Kind[]).includes(k);
const KIND_LABEL: Record<Kind, string> = SOURCE_PROVIDER_LABEL;

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

const ADDABLE: readonly SheetKind[] = ["sdk", "http", "app", "sentry", "posthog", "github"];
function addFromUrl(): SheetKind | null {
  if (typeof window === "undefined") return null;
  const add = new URLSearchParams(window.location.search).get("add");
  return add && (ADDABLE as readonly string[]).includes(add) ? (add as SheetKind) : null;
}

/** The row (or the section) a link names in its hash: scrolled to once its rows exist, the row lit. */
function useSettingsAnchor(ready: boolean, rowIds: readonly string[]): string | null {
  const [lit, setLit] = useState<string | null>(null);
  // An in-app link hands its fragment over (the modal opens without a URL change); a hard load keeps it in the location.
  const [anchor] = useState(() => peekSettingsAnchor() ?? (typeof window === "undefined" ? "" : window.location.hash));
  useWatchEffect(() => {
    if (!ready || typeof window === "undefined") return;
    const at = settingsAnchor(anchor);
    if (!at) return;
    clearSettingsAnchor();
    const id = at.kind === "source" && rowIds.includes(at.id) ? `source-${at.id}` : "product-sources";
    // The settings dialog mounts its panel a frame after the route: scroll once it is there.
    const t = window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: at.kind === "source" ? "center" : "start" }), 60);
    if (at.kind === "source") setLit(at.id);
    return () => window.clearTimeout(t);
  }, [ready, rowIds.join(",")]);
  return lit;
}

export function SourcesSection() {
  useSyncOpsSources();
  // A source's health reads everything it leaves (sourceHealth.ts): its groups, replays and watches, not only its counters.
  useSyncOpsGroups();
  useSyncOpsReplays();
  useSyncOpsWatches();
  const health = useSourceHealthMap();
  const sources = useOpsSources();
  const groups = useOpsGroups();
  const replays = useOpsReplays();
  const connections = useConnections();
  const connected = useMemo(() => VENDORS.filter((v) => connections?.has(v)), [connections]);
  // `?add=<provider>` (the Ops home's connect tiles) opens the sheet on that kind.
  const [adding, setAdding] = useState<SheetKind | null>(addFromUrl);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  // A connection with no source reads nothing yet: offer the step that does.
  const unsourced = connected.filter((v) => !sources.some((s) => s.provider === v));
  const lit = useSettingsAnchor(sources.length > 0, sources.map((s) => s.short_id));
  const now = useCoarseNow(60_000);

  return (
    <SettingsSection
      title={<span id="product-sources">Product sources</span>}
      icon={Radio}
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
        {adding && <ConnectSheet key={adding} kind={adding} onClose={() => setAdding(null)} />}
        {reveal && (reveal.key ? <KeyReveal reveal={{ ...reveal, key: reveal.key }} onDone={() => setReveal(null)} /> : <AppReveal reveal={reveal} onDone={() => setReveal(null)} />)}
        {!adding && unsourced.map((v) => (
          <div key={v} className="ops-card ops-card-body flex items-center gap-3 text-[12.5px]" data-ops-unsourced={v}>
            <ProviderIcon provider={v} className="w-3.5 h-3.5" />
            <b className="font-medium">{KIND_LABEL[v]}</b>
            <span className="ops-tag">connected · no source</span>
            <span className="flex-1" />
            <button type="button" className="ops-btn" data-tone="primary" onClick={() => { setAdding(v); setReveal(null); }}>
              <Plus className="w-3.5 h-3.5" /> Add {KIND_LABEL[v]} source
            </button>
          </div>
        ))}
        {sources.length === 0 && !adding && !reveal ? (
          <ProviderCards onPick={(k) => { setAdding(k); setReveal(null); }} connected={connected} />
        ) : sources.length > 0 ? (
          <div className="ops-srows" role="table" aria-label="Product sources"><div className="ops-srows-grid">
            <div className="ops-srow ops-srow-head" role="row">
              <span role="columnheader">Source</span>
              <span role="columnheader">State</span>
              <span role="columnheader" data-num title="Events over the last 24 hours, rolling">24h</span>
              <span role="columnheader" data-num>Last</span>
              <span role="columnheader" data-num>Open</span>
              <span role="columnheader"><span className="sr-only">Actions</span></span>
            </div>
            {sources.map((s) => (
              <SourceRow
                key={s._id}
                source={s}
                health={health.get(s._id)}
                last24={eventsLast24h(s, groups, replays, now)}
                open={openIssueCount(groups, s._id)}
                now={now}
                lit={lit === s.short_id}
                onRotated={setReveal}
                unconnected={!!connections && (CONNECTED_PROVIDERS as string[]).includes(s.provider) && !connections.has(s.provider as Connected)}
              />
            ))}
          </div></div>
        ) : null}
      </div>
    </SettingsSection>
  );
}

export function AddSourceForm({ initial, vendors, onCancel, onCreated, kindPicked, takenProjects }: { initial: Kind; vendors: Vendor[]; onCancel: () => void; onCreated: (r: Reveal | null) => void; /** The kind was picked outside the form (the Ops connect sheet's own picker): no second picker here. */ kindPicked?: boolean; /** A PostHog source already reads the connection's project: another must name a project, and not one of these. */ takenProjects?: readonly string[] }) {
  const scope = useOpsScope();
  const [provider, setProvider] = useState<Kind>(initial);
  const keyed = KEYED_SOURCE_PROVIDERS.includes(provider);
  // A vendor source is usually named for the vendor; a keyed one names the product.
  const [name, setName] = useState(keyed ? "" : provider);
  // The name the form last derived (the vendor's, then the picked project's): a name the person typed is never replaced.
  const [autoName, setAutoName] = useState(keyed ? "" : provider);
  const [projects, setProjects] = useState("");
  const [projectId, setProjectId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The vendor's project list could not be read: the form falls back to typing slugs or an id.
  const [listError, setListError] = useState<string | null>(null);
  const kinds: Kind[] = ["sdk", "http", "app", ...VENDORS.filter((v) => vendors.includes(v) || v === initial)];
  const needsUrl = provider === "app" && !baseUrl.trim();
  const pick = (k: Kind) => {
    if (!KEYED_SOURCE_PROVIDERS.includes(k) && (!name.trim() || name === provider)) setName(k);
    setProvider(k);
  };
  const projectList = projects.split(",").map((p) => p.trim()).filter(Boolean);
  const posthogProject = provider === "posthog" ? projectId.trim() : "";
  const config = provider === "sentry" && projectList.length ? { projects: projectList } : posthogProject ? { project_id: posthogProject } : undefined;
  // A PostHog source reads the project a person picks from the list; without the list, a second source on the same connection must name another.
  const projectNeeded = provider === "posthog" && (!listError || !!takenProjects) && (!posthogProject || !!takenProjects?.includes(posthogProject));
  const problem = sourceConfigProblem(provider, config) ?? (projectNeeded && posthogProject ? `Project ${posthogProject} already has a source` : null);
  const submit = async () => {
    if (!name.trim() || scope === "skip" || problem || needsUrl || projectNeeded) return;
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
        <label className="flex flex-col gap-1 text-meta text-sol-text-muted flex-1 min-w-[200px]">
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="web, api, mobile"
            title={`How triggers and the CLI pick it: --source ${name.trim().toLowerCase() || "web"}`}
            className="h-8 rounded-md border border-sol-border bg-sol-bg px-2.5 text-[13px] text-sol-text outline-none focus:border-sol-text-muted"
          />
        </label>
        {!kindPicked && <div className="ops-seg" role="group" aria-label="Kind">
          {kinds.map((k) => (
            <button key={k} type="button" data-on={provider === k ? "true" : undefined} aria-pressed={provider === k} onClick={() => pick(k)}>{KIND_LABEL[k]}</button>
          ))}
        </div>}
        {provider === "app" && (
          <label className="flex flex-col gap-1 text-meta text-sol-text-muted min-w-[260px] flex-1">
            Base URL
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/api"
              className="h-8 rounded-md border border-sol-border bg-sol-bg px-2.5 text-[13px] text-sol-text outline-none focus:border-sol-text-muted ops-mono"
            />
          </label>
        )}
        {provider === "posthog" && takenProjects && listError && (
          <label className="flex flex-col gap-1 text-meta text-sol-text-muted min-w-[160px]">
            Project id
            <input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              inputMode="numeric"
              placeholder="12345"
              aria-invalid={projectNeeded && !!posthogProject}
              className="h-8 rounded-md border border-sol-border bg-sol-bg px-2.5 text-[13px] text-sol-text outline-none focus:border-sol-text-muted ops-mono"
              data-ops-posthog-project
            />
          </label>
        )}
        {provider === "sentry" && listError && (
          <label className="flex flex-col gap-1 text-meta text-sol-text-muted min-w-[200px]">
            Projects
            <input
              value={projects}
              onChange={(e) => setProjects(e.target.value)}
              placeholder="every project, or slugs: web, api"
              className="h-8 rounded-md border border-sol-border bg-sol-bg px-2.5 text-[13px] text-sol-text outline-none focus:border-sol-text-muted ops-mono"
            />
          </label>
        )}
        <button type="submit" className="ops-btn" data-tone="primary" disabled={busy || !name.trim() || !!problem || needsUrl || projectNeeded}>{busy ? "Adding" : keyed ? "Add and show key" : "Add source"}</button>
        <button type="button" className="ops-btn" onClick={onCancel}>Cancel</button>
      </div>
      {isVendorKind(provider) && !listError && (
        <VendorProjectPicker
          key={provider}
          provider={provider}
          picked={provider === "sentry" ? projectList : posthogProject ? [posthogProject] : []}
          onPick={(next, picked) => {
            if (provider === "sentry") setProjects(next.join(", "));
            else setProjectId(next[0] ?? "");
            // One PostHog project names the source after it, until the person types a name of their own.
            const derived = provider === "posthog" && picked[0] ? projectSourceName(picked[0].name) : null;
            if (derived && (!name.trim() || name === autoName)) {
              setName(derived);
              setAutoName(derived);
            }
          }}
          onUnavailable={setListError}
        />
      )}
      {listError && isVendorKind(provider) && <div className="text-[12px]" style={{ color: "var(--sol-orange)" }} title={listError} data-ops-vendor-projects-error>Projects unlisted: {listError}</div>}
      {problem && (projects.trim() || posthogProject) && <div className="text-[12px]" style={{ color: "var(--sol-red)" }}>{problem}</div>}
      {error && <div className="text-[12px]" style={{ color: "var(--sol-red)" }}>{error}</div>}
    </form>
  );
}

/** The source a reveal is for, as codecast.json records it, once the server has answered with its id. */
const configSource = (r: Reveal): ConfigSource | undefined => (r.id && r.workspace ? { name: r.name, id: r.id, workspace: r.workspace } : undefined);

export function KeyReveal({ reveal, onDone }: { reveal: Reveal & { key: string }; onDone: () => void }) {
  const snippets = sourceSnippets(reveal.key, CONVEX_URL, configSource(reveal));
  const [tab, setTab] = useState<"config" | "sdk" | "curl">("config");
  const [copied, setCopied] = useState(false);
  return (
    <div className="ops-card ops-card-body flex flex-col gap-3" data-ops-key-reveal>
      <div className="text-[13px] text-sol-text font-medium">
        {reveal.rotated ? `New key for ${reveal.name}` : `${reveal.name} is ready`}
        <span className="text-sol-text-muted font-normal">: copy the key now, it is not shown again{!reveal.rotated ? "." : reveal.oldUntil ? `. The old key works until ${new Date(reveal.oldUntil).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}.` : ". The old key already stopped working."}</span>
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
      <div className="flex items-center gap-3 text-meta text-sol-text-dim">
        <span>Send one event, then watch it land on <Link href={opsHref.tab("timeline", { source: reveal.name })} className="text-sol-link hover:underline">the Ops timeline</Link>.</span>
        <div className="flex-1" />
        <button type="button" className="ops-btn" onClick={onDone}>I saved it</button>
      </div>
    </div>
  );
}

/** An app source's setup: the codecast.json the app commits, and the verifier that reads it. Nothing in it is secret. */
export function AppReveal({ reveal, onDone }: { reveal: Reveal; onDone: () => void }) {
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
      <div className="flex items-center gap-3 text-meta text-sol-text-dim">
        <span>Once the app is deployed with it, its readers list on <Link href={opsHref.tab("apps", { app: source.id })} className="text-sol-link hover:underline">Ops, Apps</Link>, where a person grants its actions.</span>
        <div className="flex-1" />
        <button type="button" className="ops-btn" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

function SourceRow({ source: s, health, last24, open, now, lit, onRotated, unconnected }: { source: OpsSource; health?: SourceHealth; last24: number; open: number; now: number; lit: boolean; onRotated: (r: Reveal) => void; unconnected: boolean }) {
  const store = () => useInboxStore.getState();
  const stub = !s.short_id;
  const lastAt = health?.lastAt ?? s.last_event_at ?? null;
  // Pausing a source that sends nothing changes nothing: the overview's rule, so a silent source offers no Pause here either.
  const silent = health?.state === "stopped" || health?.state === "quiet" || health?.state === "waiting";
  const problem = unconnected ? `Reads nothing: connect ${CONNECTION_LABEL[s.provider as Connected]} above` : s.last_error ?? null;
  return (
    <div id={s.short_id ? `source-${s.short_id}` : undefined} className="ops-srow-wrap" data-lit={lit ? "true" : undefined} data-ops-settings-source={s.name} role="rowgroup">
      <div className="ops-srow" role="row">
        <span className="ops-srow-name" role="cell">
          <span className="ops-dot" data-status={unconnected && s.status === "active" ? "error" : s.status} data-health={health?.tone} />
          <ProviderIcon provider={s.provider} className="w-3.5 h-3.5 shrink-0" />
          <Link href={opsHref.home({ source: s.name })} className="text-sol-text font-medium hover:underline truncate" title={`${SOURCE_PROVIDER_LABEL[s.provider]} · ${s.short_id}`}>{s.name}</Link>
        </span>
        <span role="cell" className="min-w-0">{health ? <HealthBadge health={health} /> : <span className="ops-dim">—</span>}</span>
        <span role="cell" data-num className="ops-num" title={(s.dropped_today ?? 0) > 0 ? `${s.dropped_today} dropped today` : undefined}>{last24.toLocaleString()}{(s.dropped_today ?? 0) > 0 ? <span className="ops-srow-drop"> −{s.dropped_today}</span> : null}</span>
        <span role="cell" data-num className="ops-num ops-dim" title={lastAt ? new Date(lastAt).toLocaleString() : undefined}>{lastAt ? relTimeShort(lastAt, now) : "never"}</span>
        <span role="cell" data-num className="ops-num">{open ? <Link href={opsHref.tab("issues", { source: s.name })} className="ops-link">{open.toLocaleString()}</Link> : <span className="ops-dim">0</span>}</span>
        <span role="cell" className="ops-srow-acts">
          {health?.fix && health.fix !== "resume" && health.fix !== "setup" && health.fix !== "resume_import" && <HealthFixButton source={s} health={health} />}
          {!stub && (
            <>
              {/* A source stopped on a lost connection resumes like a paused one. */}
              {(s.status !== "active" || !silent) && (
                <button type="button" className="ops-srow-act" onClick={() => store().setOpsSourceStatus(s._id, s.status === "active" ? "paused" : "active")}>
                  {s.status === "active" ? "Pause" : "Resume"}
                </button>
              )}
              {s.keyed && <RotateKeyButton source={s} events24h={last24} onRotated={onRotated} className="ops-srow-act" />}
              <RemoveSourceButton source={s} className="ops-srow-act" />
            </>
          )}
        </span>
      </div>
      {/* What is left to say: the error or the lost connection, else the busiest event names. */}
      {(problem || (s.event_names?.length ?? 0) > 0) && (
        <div className="ops-srow-sub">
          {problem ? <span className="truncate" style={{ color: unconnected ? "var(--sol-orange)" : "var(--sol-red)" }} title={problem}>{problem}</span> : <SourceEventNames source={s} now={now} />}
        </div>
      )}
      {hasVendorRecordings(s) && (
        <div className="ops-srow-sub">
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
    <span className="text-sol-text-dim text-meta ops-num truncate min-w-0" title={rows.map((r) => `${r.name}: ${r.day} in 24h`).join("\n")}>
      {shown.length ? shown.map((r) => `${r.name} ${r.day}`).join(", ") : `${rows.length} event name${rows.length === 1 ? "" : "s"}, none in 24h`}
      {rows.length > shown.length && shown.length ? `, +${rows.length - shown.length}` : ""}
    </span>
  );
}

const PROVIDER_CARDS: { kind: SheetKind; label: string; what: string }[] = [
  { kind: "posthog", label: "PostHog", what: "Replays, metrics" },
  { kind: "sentry", label: "Sentry", what: "Errors" },
  { kind: "github", label: "GitHub CI", what: "Failed runs, deploys" },
  { kind: "app", label: "Your app", what: "Readers, actions, watches" },
  { kind: "sdk", label: "SDK", what: "Errors, jobs, checks" },
  { kind: "http", label: "HTTP", what: "Any HTTP client" },
];

/** No sources yet: one card per kind, each opening the add form on that kind. */
function ProviderCards({ onPick, connected }: { onPick: (k: SheetKind) => void; connected: Vendor[] }) {
  return (
    <div className="ops-provider-cards" data-ops-provider-cards>
      {PROVIDER_CARDS.map((c) => {
        const vendor = (VENDORS as string[]).includes(c.kind);
        const ready = !vendor || connected.includes(c.kind as Vendor);
        return (
          <button key={c.kind} type="button" className="ops-provider-card" onClick={() => onPick(c.kind)} data-ready={ready ? "true" : undefined}>
            <ProviderIcon provider={c.kind} className="w-4 h-4" />
            <b>{c.label}</b>
            <span>{c.what}</span>
            <span className="ops-provider-cta">{vendor && !ready ? "Connect" : c.kind === "github" ? "Install" : "Add"}</span>
          </button>
        );
      })}
    </div>
  );
}
