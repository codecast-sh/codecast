// Product sources on Settings, Integrations (external-data.md X1, X10): every
// feed into the workspace being looked at, with pause, key rotation and
// removal, and the "Add SDK source" flow. A keyed source's ingest key is
// shown exactly once, when it is minted, beside a snippet that already
// carries it; after that the server holds only its hash.
//
// Sentry, PostHog and app connections are the token cards above this
// section (TokenConnectForm); `cast sources add` names their projects.
import { useState } from "react";
import Link from "next/link";
import { Check, Copy, Plus, Radio } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpsScope, useOpsSources, useSyncOpsSources } from "../../hooks/useSyncOps";
import { CONVEX_URL } from "../../lib/convexUrl";
import { copyText } from "../../lib/copyText";
import { relTimeShort } from "../../lib/utils";
import { SettingsSection } from "../settings/ui";
import { ConfirmButton } from "../integrations/parts";
import { sourceSnippets } from "./opsModel";
import { opsHref } from "./opsPaths";
import { ProviderIcon } from "./parts";
import type { OpsSource } from "./opsTypes";
import "./ops.css";

type Reveal = { name: string; key: string; rotated: boolean };

export function SourcesSection() {
  useSyncOpsSources();
  const sources = useOpsSources();
  const [adding, setAdding] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);

  return (
    <SettingsSection
      title={<span id="product-sources">Product sources</span>}
      icon={Radio}
      description="What your running product sends: errors, failed jobs, checks, deploys and replays. They show on the Ops page, wake triggers and file causes on the line."
      actions={
        !adding && (
          <button type="button" className="ops-btn" onClick={() => { setAdding(true); setReveal(null); }}>
            <Plus className="w-3.5 h-3.5" /> Add SDK source
          </button>
        )
      }
      padded
    >
      <div className="flex flex-col gap-3">
        {adding && <AddSourceForm onCancel={() => setAdding(false)} onCreated={(r) => { setAdding(false); setReveal(r); }} />}
        {reveal && <KeyReveal reveal={reveal} onDone={() => setReveal(null)} />}
        {sources.length === 0 && !adding && !reveal ? (
          <div className="text-[12.5px] text-sol-text-muted">
            No sources in this workspace yet. An SDK source takes a write-only key that is safe to ship in a browser bundle.
          </div>
        ) : (
          sources.map((s) => <SourceRow key={s._id} source={s} onRotated={setReveal} />)
        )}
      </div>
    </SettingsSection>
  );
}

function AddSourceForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (r: Reveal) => void }) {
  const scope = useOpsScope();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"sdk" | "http">("sdk");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!name.trim() || scope === "skip") return;
    setBusy(true);
    setError(null);
    try {
      const res = await useInboxStore.getState().createOpsSource({
        name,
        provider,
        workspace: scope.workspace,
        ...(scope.workspace === "team" ? { team_id: scope.team_id } : {}),
      });
      if (res?.ingest_key) onCreated({ name: res.name, key: res.ingest_key, rotated: false });
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
          <button type="button" data-on={provider === "sdk" ? "true" : undefined} onClick={() => setProvider("sdk")}>SDK</button>
          <button type="button" data-on={provider === "http" ? "true" : undefined} onClick={() => setProvider("http")}>HTTP</button>
        </div>
        <button type="submit" className="ops-btn" data-tone="primary" disabled={busy || !name.trim()}>{busy ? "Adding" : "Add and show key"}</button>
        <button type="button" className="ops-btn" onClick={onCancel}>Cancel</button>
      </div>
      <div className="text-[11.5px] text-sol-text-dim">
        The name is how triggers and the CLI pick it (<span className="ops-mono">--source {name.trim().toLowerCase() || "web"}</span>). New and regressed errors file causes on the line by default.
      </div>
      {error && <div className="text-[12px]" style={{ color: "var(--sol-red)" }}>{error}</div>}
    </form>
  );
}

function KeyReveal({ reveal, onDone }: { reveal: Reveal; onDone: () => void }) {
  const snippets = sourceSnippets(reveal.key, CONVEX_URL);
  const [tab, setTab] = useState<"sdk" | "curl">("sdk");
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
          <button type="button" role="tab" data-on={tab === "sdk" ? "true" : undefined} onClick={() => setTab("sdk")}>@platform/analytics</button>
          <button type="button" role="tab" data-on={tab === "curl" ? "true" : undefined} onClick={() => setTab("curl")}>HTTP</button>
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

function SourceRow({ source: s, onRotated }: { source: OpsSource; onRotated: (r: Reveal) => void }) {
  const now = useCoarseNow(60_000);
  const [rotating, setRotating] = useState(false);
  const store = () => useInboxStore.getState();
  const stub = !s.short_id;
  const rotate = async () => {
    setRotating(true);
    try {
      const res = await store().rotateOpsSourceKey(s._id);
      if (res?.ingest_key) onRotated({ name: s.name, key: res.ingest_key, rotated: true });
    } finally {
      setRotating(false);
    }
  };
  return (
    <div className="flex items-center gap-3 text-[12.5px] py-1.5 border-b last:border-b-0 border-[color:color-mix(in_srgb,var(--sol-border)_60%,transparent)]">
      <span className="ops-dot" data-status={s.status} />
      <ProviderIcon provider={s.provider} className="w-3.5 h-3.5" />
      <Link href={opsHref.tab("timeline", { source: s.name })} className="text-sol-text font-medium hover:underline">{s.name}</Link>
      <span className="ops-mono text-sol-text-dim text-[11px]">{s.short_id}</span>
      {s.key_prefix && <span className="ops-mono text-sol-text-dim text-[11px]" title="The key's first characters">{s.key_prefix}…</span>}
      <span className="text-sol-text-muted text-[11.5px] ops-num">
        {s.events_today ?? 0} today{(s.dropped_today ?? 0) > 0 ? `, ${s.dropped_today} dropped` : ""}
        {s.last_event_at ? `, last ${relTimeShort(s.last_event_at, now)} ago` : ", nothing yet"}
      </span>
      {s.last_error && <span className="text-[11.5px] truncate" style={{ color: "var(--sol-red)" }} title={s.last_error}>{s.last_error}</span>}
      <div className="flex-1" />
      {!stub && (
        <>
          <button type="button" className="text-[11px] text-sol-text-muted hover:text-sol-text" onClick={() => store().setOpsSourceStatus(s._id, s.status === "paused" ? "active" : "paused")}>
            {s.status === "paused" ? "Resume" : "Pause"}
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
  );
}
