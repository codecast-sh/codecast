// Connecting a source without leaving Ops: pick a provider, fill the one form
// (SourcesSection AddSourceForm, the same one Settings shows), copy the key or
// snippet it hands back, and watch the new source's first event arrive (or
// send it from here with the key it holds). A poll, manifest or token that
// fails shows its reason and fix in place of the wait (connectWait). The
// sheet finds the new source by its id appearing in the store, so it works the
// same for a keyed source, an app and a vendor that polls. A vendor that is
// not connected yet (Sentry, PostHog) takes its token here first, through the
// same form and action the integrations card uses; once the connection lands
// the source form follows in the same sheet. GitHub CI comes from the GitHub
// app: the sheet links to its install, and the source appears once it lands.
// Escape closes it.
import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, Loader2, Send, X } from "lucide-react";
import { APP_DESCRIPTORS, type AppConnectionScope, type AppConnectionsResult } from "@codecast/shared/contracts";
import { useOpsSources } from "../../hooks/useSyncOps";
import { useSettingsData } from "../../hooks/useSyncSettings";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useAppConnection } from "../../lib/integrations";
import { hasOpenModal } from "../../shortcuts";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { TokenConnectForm } from "../integrations/TokenConnectForm";
import { opsHref } from "./opsPaths";
import { ProviderIcon, SOURCE_PROVIDER_LABEL } from "./parts";
import { AddSourceForm, AppReveal, KeyReveal, type Kind, type Reveal, type Vendor } from "./SourcesSection";
import { CONVEX_URL } from "../../lib/convexUrl";
import { HealthFixButton } from "./SourceHealthParts";
import { connectWait, sendTestEvent, type TestSend } from "./connectWait";
import type { OpsSource } from "./opsTypes";
import { useConnectedProviders, useSourceHealth } from "./useSourceHealth";
import "./connectSheet.css";

const VENDORS: readonly Vendor[] = ["sentry", "posthog"];
const isVendor = (k: string): k is Vendor => (VENDORS as readonly string[]).includes(k);

/** Where a vendor connection made from Ops is stored: the team being looked at when the vendor binds to teams, else the person. */
function connectScope(vendor: Vendor, team: AppConnectionsResult["team"] | undefined): AppConnectionScope {
  return team && APP_DESCRIPTORS[vendor].scopes.includes("team") ? "team" : "personal";
}

/** Every kind a person can connect, in the sheet's picker. SDK also carries moments (a keyed source's recorded moments). */
export type SheetKind = Kind | "github";
const SHEET_KINDS: { kind: SheetKind; label: string }[] = [
  { kind: "sdk", label: "SDK" },
  { kind: "http", label: "HTTP" },
  { kind: "app", label: "App" },
  { kind: "posthog", label: "PostHog" },
  { kind: "sentry", label: "Sentry" },
  { kind: "github", label: "GitHub CI" },
];
const GITHUB_INSTALL = "/settings/integrations#app-github";

export function ConnectSheet({ kind: initial, onClose }: { kind: SheetKind; onClose: () => void }) {
  const [kind, setKind] = useState<SheetKind>(initial);
  const sources = useOpsSources();
  // The sources there before this sheet opened: the one that appears after is the new one.
  const [known] = useState(() => new Set(sources.map((s) => s._id)));
  const [created, setCreated] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const connected = useConnectedProviders();
  const vendors = VENDORS.filter((v) => connected?.has(v));
  const fresh = created ? sources.find((s) => !known.has(s._id) && (!reveal || s.name === reveal.name)) ?? null : null;
  const health = useSourceHealth(fresh);
  const wait = connectWait(fresh, health);
  // The key a keyed source was minted with, held after its reveal is put away, so the sheet can send its first event itself.
  const [heldKey, setHeldKey] = useState<string | null>(null);
  const [test, setTest] = useState<TestSend | null>(null);
  const [sending, setSending] = useState(false);
  const sendTest = async () => {
    if (!heldKey) return;
    setSending(true);
    setTest(await sendTestEvent(CONVEX_URL, heldKey));
    setSending(false);
  };
  const label = kind === "github" ? "GitHub CI" : SOURCE_PROVIDER_LABEL[kind];
  const needsConnection = kind !== "github" && isVendor(kind) && connected !== null && !connected.has(kind);
  const github = sources.filter((s) => s.provider === "github");
  // A vendor already feeding a source: the sheet opens on it, and adding another is a deliberate second step.
  const existing = isVendor(kind) ? sources.filter((s) => s.provider === kind) : [];
  const [addingAnother, setAddingAnother] = useState(false);
  const showExisting = existing.length > 0 && !needsConnection && !created && !addingAnother;

  // Escape closes the sheet from anywhere in it, its fields included, before the shell's go-up-a-level sees it.
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || hasOpenModal()) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <section className="ops-connect" aria-label={`Connect ${label}`} data-ops-connect-sheet={kind}>
      <div className="ops-connect-head">
        <ProviderIcon provider={kind} className="w-4 h-4" />
        <span className="ops-connect-title">
          <b>{created && fresh ? fresh.name : `Connect ${label}`}</b>
          {needsConnection ? <span className="ops-connect-step ops-dim">step 1 of 2: the {label} token</span> : null}
        </span>
        <button type="button" className="ops-btn ops-connect-x" onClick={onClose} aria-label="Close" title="Close"><X className="w-3.5 h-3.5" /><KeyCap size="xs">esc</KeyCap></button>
      </div>
      {!created && (
        <div className="ops-seg ops-connect-kinds" role="group" aria-label="Kind" data-ops-connect-kinds>
          {SHEET_KINDS.map((k) => (
            <button key={k.kind} type="button" data-on={kind === k.kind ? "true" : undefined} aria-pressed={kind === k.kind} onClick={() => { setKind(k.kind); setAddingAnother(false); }} data-ops-connect-kind={k.kind}>
              <ProviderIcon provider={k.kind} className="w-3 h-3" />
              {k.label}
            </button>
          ))}
        </div>
      )}
      {kind === "github" ? (
        <div className="ops-connect-row" data-ops-connect-github={github.length ? "connected" : "install"}>
          {github.length ? (
            <>
              <Check className="w-3.5 h-3.5 ops-connect-ok" />
              <span>{github.map((s) => s.name).join(", ")}</span>
              <span className="flex-1" />
              <Link href={GITHUB_INSTALL} className="ops-btn" onClick={onClose}>Repositories</Link>
              <Link href={opsHref.home({ source: github[0].name })} className="ops-btn" data-tone="primary" onClick={onClose}>Open {github[0].name}</Link>
            </>
          ) : (
            <>
              <span className="ops-dim">Failed runs and deploys</span>
              <span className="flex-1" />
              <Link href={GITHUB_INSTALL} className="ops-btn" data-tone="primary" onClick={onClose} data-ops-connect-install="github">Install the GitHub app</Link>
            </>
          )}
        </div>
      ) : showExisting && isVendor(kind) ? (
        <ExistingVendor vendor={kind} sources={existing} onAdd={() => setAddingAnother(true)} onClose={onClose} />
      ) : needsConnection ? (
        <VendorConnect key={kind} vendor={kind} onCancel={onClose} />
      ) : !created ? (
        <AddSourceForm
          key={kind}
          kindPicked
          initial={kind}
          vendors={vendors}
          takenProjects={kind === "posthog" && existing.length ? existing.flatMap((s) => (s.config?.project_id ? [s.config.project_id] : [])) : undefined}
          onCancel={existing.length ? () => setAddingAnother(false) : onClose}
          onCreated={(r) => {
            setCreated(true);
            setReveal(r);
            if (r?.key) setHeldKey(r.key);
          }}
        />
      ) : null}
      {reveal && (reveal.key ? <KeyReveal reveal={{ ...reveal, key: reveal.key }} onDone={() => setReveal({ ...reveal, key: undefined, rotated: false })} /> : reveal.id && kind === "app" ? <AppReveal reveal={reveal} onDone={() => setReveal({ ...reveal, id: undefined })} /> : null)}
      {created && (
        <div className="ops-connect-row" role="status" data-ops-connect-wait={wait.state}>
          {wait.state === "arrived" || wait.state === "connected" ? <Check className="w-3.5 h-3.5 ops-connect-ok" /> : wait.state === "failing" ? <AlertTriangle className="w-3.5 h-3.5 ops-connect-bad" /> : <Loader2 className="w-3.5 h-3.5 animate-spin ops-dim" />}
          <span className="ops-connect-wait-label">
            <span data-tone={wait.state === "failing" ? "bad" : undefined}>{wait.label}</span>
            {wait.reason && <span className="ops-connect-err ops-connect-reason" title={wait.reason}>{wait.reason}</span>}
            {test && !test.ok && <span className="ops-connect-err ops-connect-reason" title={test.error}>Test refused: {test.error}</span>}
          </span>
          <span className="flex-1" />
          {fresh && wait.state === "failing" && health && <HealthFixButton source={fresh} health={health} />}
          {fresh && heldKey && wait.state !== "arrived" && (
            <button type="button" className="ops-btn" data-tone="primary" disabled={sending} onClick={() => void sendTest()} data-ops-connect-test>
              <Send className="w-3.5 h-3.5" />{sending ? "Sending" : test?.ok ? "Send another" : "Send a test"}
            </button>
          )}
          {fresh && <Link href={opsHref.home({ source: fresh.name })} className="ops-btn" data-tone={wait.state === "arrived" || wait.state === "connected" ? "primary" : undefined} onClick={onClose} data-ops-connect-open>Open {fresh.name}</Link>}
        </div>
      )}
    </section>
  );
}

/**
 * The sources a connected vendor already feeds, each with what it reads (its
 * PostHog project, its Sentry projects, else the connection's account), Open
 * as the press, and Add another behind it.
 */
function ExistingVendor({ vendor, sources, onAdd, onClose }: { vendor: Vendor; sources: OpsSource[]; onAdd: () => void; onClose: () => void }) {
  const { data } = useSettingsData("connections");
  const conn = (data as AppConnectionsResult | undefined)?.apps.find((a) => a.id === vendor && a.status === "connected");
  const account = conn && conn.status === "connected" ? conn.detail ?? null : null;
  const reads = (s: OpsSource) => (vendor === "posthog" ? (s.config?.project_id ? `project ${s.config.project_id}` : account) : s.config?.projects?.length ? s.config.projects.join(", ") : account ? `${account} · every project` : "every project");
  return (
    <div className="ops-connect-existing" data-ops-connect-existing={vendor}>
      {sources.map((s, i) => (
        <div key={s._id} className="ops-connect-row">
          <Check className="w-3.5 h-3.5 ops-connect-ok" />
          <span className="ops-connect-name">{s.name}</span>
          {reads(s) && <span className="ops-dim ops-mono ops-connect-reads">{reads(s)}</span>}
          <span className="flex-1" />
          <Link href={opsHref.home({ source: s.name })} className="ops-btn" data-tone={i === 0 ? "primary" : undefined} onClick={onClose} data-ops-connect-open-existing>Open {s.name}</Link>
        </div>
      ))}
      <button type="button" className="ops-btn self-start" onClick={onAdd} data-ops-connect-add-another>{vendor === "posthog" ? "Add another project" : "Add other projects"}</button>
    </div>
  );
}

/**
 * The vendor's token, pasted here: the integrations card's own form and
 * action (useAppConnection connectToken), stored at the workspace Ops reads.
 * The connections feed then lists the vendor as connected and the sheet moves
 * on to the source form by itself.
 */
function VendorConnect({ vendor, onCancel }: { vendor: Vendor; onCancel: () => void }) {
  const { data } = useSettingsData("connections");
  const result = data as AppConnectionsResult | undefined;
  const scope = connectScope(vendor, result?.team);
  const descriptor = APP_DESCRIPTORS[vendor];
  const connection = result?.apps.find((a) => a.id === vendor && "scope" in a && a.scope === scope);
  const { connectToken, busy, error } = useAppConnection(descriptor, connection, scope);
  return (
    <div className="ops-connect-vendor" data-ops-connect-needs={vendor} data-scope={scope}>
      <span className="ops-connect-where ops-dim">{scope === "team" ? `For ${result?.team?.name ?? "this team"}` : "For you"}</span>
      <TokenConnectForm descriptor={descriptor} busy={busy} onSubmit={connectToken} onCancel={onCancel} />
      {error && <span className="ops-connect-err" role="alert">{error}</span>}
    </div>
  );
}
