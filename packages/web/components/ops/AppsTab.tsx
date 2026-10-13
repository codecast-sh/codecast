// The Apps tab (X8): each source codecast may act through, as a board. The
// head answers whether the connection is healthy; under it sit what agents
// may do (a switch per action, the only place a grant is made: an agent's CLI
// cannot), what is watched, the call audit folded into groups with what still
// fails first, and what codecast can read. Every row is a name and its state;
// the manifest's own description, the route, the arguments and the full error
// open under the row that names them (appsModel.ts works all of it out).
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, History, ShieldAlert } from "lucide-react";
import { activeGrant, grantableActions, parseAppManifest, sourceHasGrants, type AppManifest, type GrantableAction } from "@codecast/shared/contracts/appConnector";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpsApp, useOpsAppCalls, useOpsSources, useSyncOpsApp } from "../../hooks/useSyncOps";
import { useInboxStore } from "../../store/inboxStore";
import { relTimeShort } from "../../lib/utils";
import { Switch } from "../ui/switch";
import { EntityIdPill } from "../EntityIdPill";
import { appHealth, callReason, failingNow, groupCalls, groupState, groupTone, lastAnswered, lastFailure, schemaParams, titleLookup, usageByName, watchRows, type AppTone, type CallGroup, type Param, type Usage } from "./appsModel";
import { opsHref } from "./opsPaths";
import { OpsEmpty, OpsFeedEmpty, OpsFeedError, ProviderIcon, SETUP_HREF, SOURCE_PROVIDER_LABEL, useOpsFeed } from "./parts";
import type { OpsAppCall, OpsSource } from "./opsTypes";

export function AppsTab({ app }: { app: string | null }) {
  const sources = useOpsSources();
  const feed = useOpsFeed("sources");
  const apps = useMemo(() => sources.filter((s) => sourceHasGrants(s.provider)), [sources]);
  const selected = apps.find((s) => s.short_id === app || s._id === app || s.name === app) ?? apps[0];

  if (apps.length === 0) {
    return (
      <OpsFeedEmpty feeds={[feed]} what="sources" title="No app connected">
        <Link href={SETUP_HREF} className="ops-btn mt-2">Connect an app</Link>
      </OpsFeedEmpty>
    );
  }

  return (
    <div className="ops-pad">
      {apps.length > 1 && (
        <nav className="ops-app-picks" aria-label="Apps">
          {apps.map((s) => (
            <Link key={s._id} href={opsHref.tab("apps", { app: s.short_id || s._id })} className="ops-app-pick" aria-current={s._id === selected?._id ? "page" : undefined} title={s.last_error}>
              <span className="ops-dot" data-status={pickState(s) ? (s.status === "paused" ? "paused" : "error") : "active"} />
              <ProviderIcon provider={s.provider} />
              <span className="truncate min-w-0">{s.name}</span>
              {pickState(s) && <span className="ops-app-pick-state">{pickState(s)}</span>}
            </Link>
          ))}
        </nav>
      )}
      {selected && <AppDetail key={selected._id} source={selected} />}
    </div>
  );
}

/** What is wrong with an app, in a word, for the switcher; nothing when it is fine. */
function pickState(s: OpsSource): string | null {
  if (s.status === "error") return "Error";
  if (s.status === "paused") return "Paused";
  return s.watch_state?.some((w) => w.last_error) ? "Failing" : null;
}

function AppDetail({ source }: { source: OpsSource }) {
  const feed = useSyncOpsApp(source._id);
  const app = useOpsApp(source._id);
  const calls = useOpsAppCalls(source._id);
  const now = useCoarseNow(60_000);
  const sourcesFeed = useOpsFeed("sources");
  const members = useInboxStore((s) => s.teamMembers);
  const me = useInboxStore((s) => s.currentUser);
  const manifest: AppManifest | null = useMemo(() => {
    if (!app?.manifest_json) return null;
    try {
      const parsed = parseAppManifest(JSON.parse(app.manifest_json));
      return parsed.ok ? parsed.manifest : null;
    } catch {
      return null;
    }
  }, [app?.manifest_json]);
  const nameOf = (userId: string) => {
    const person = String(me?._id ?? "") === userId ? me : members.find((m: any) => String(m?._id) === userId);
    return person?.name ?? null;
  };
  const setGrant = (action: string, on: boolean) => {
    const store = useInboxStore.getState();
    if (on) store.grantOpsAction(source._id, action);
    else store.revokeOpsAction(source._id, action);
  };

  const isApp = source.provider === "app";
  if (!app && feed.refused) return <OpsEmpty title={`${source.name} is not readable here`} />;
  if (!app && feed.error) return <OpsFeedError what={`${source.name}'s ${isApp ? "manifest" : "grants"}`} retry={feed.retry} />;
  if (!app) return <div className="ops-quiet text-[12.5px] py-8">Reading {source.name}…</div>;
  return <AppBoard source={source} manifest={manifest} calls={calls} now={now} fresh={!!sourcesFeed?.ready} nameOf={nameOf} onGrant={setGrant} />;
}

// ── The board ──

export type AppBoardProps = {
  /** The source's own row: its status, grants and watch state are read from here. */
  source: Pick<OpsSource, "_id" | "name" | "provider" | "status" | "last_error" | "grants" | "watch_state" | "manifest_fetched_at">;
  /** The manifest the app declares; null for a vendor source, or an app whose manifest has not been read. */
  manifest: AppManifest | null;
  calls: OpsAppCall[];
  now: number;
  /** The source row is the server's current answer, not a cached one still waiting on its feed. */
  fresh?: boolean;
  nameOf?: (userId: string) => string | null;
  onGrant: (action: string, on: boolean) => void;
};

const NONE: never[] = [];
const ACTOR_LABEL = { watch: "Watch", cli: "CLI", session: "Agent" } as const;
/** Occurrences a call group lists before it counts the rest. */
const OCCURRENCES = 8;
/** Reasons a call row names before it counts the rest. */
const REASONS = 3;

/** "3m ago", or "just now". */
const ago = (at: number, now: number) => {
  const t = relTimeShort(at, now);
  return t === "now" ? "just now" : `${t} ago`;
};
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const moment = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function AppBoard({ source, manifest, calls, now, fresh = true, nameOf, onGrant }: AppBoardProps) {
  const grants = source.grants ?? NONE;
  const watchState = source.watch_state ?? NONE;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const isApp = source.provider === "app";
  const actions = grantableActions(source.provider, manifest);
  const grantOf = (name: string) => activeGrant(grants, name, now);
  const granted = actions.filter((a) => grantOf(a.name));
  const riskyGranted = granted.filter((a) => a.risk === "high").length;

  const watches = useMemo(() => watchRows(manifest?.watches ?? [], watchState, calls, now, fresh), [manifest, watchState, calls, now, fresh]);
  const groups = useMemo(() => groupCalls(calls, { grants, watchState, watches: manifest?.watches ?? [], now }), [calls, grants, watchState, manifest, now]);
  const usage = useMemo(() => usageByName(calls), [calls]);
  const titleOf = useMemo(() => titleLookup(manifest, actions), [manifest, actions]);
  const health = appHealth(source, watches, groups);
  const failing = failingNow(source, watches, groups);
  const lastFailed = useMemo(() => lastFailure(calls), [calls]);
  const answered = useMemo(() => lastAnswered(calls, watchState), [calls, watchState]);
  const live = groups.filter((g) => g.live);
  const failingCalls = live.filter((g) => g.status === "error");
  const otherCalls = groups.filter((g) => !failingCalls.includes(g)).sort((a, b) => b.latest - a.latest);
  const watchedEvery = new Map((manifest?.watches ?? []).map((w) => [w.reader, w.every]));
  const viewsLocked = !!manifest?.views.length && actions.some((a) => a.name === "views.token") && !grantOf("views.token");

  const callRow = (g: CallGroup) => (
    <Disclosure
      key={g.key}
      id={`call:${g.key}`}
      open={open}
      toggle={toggle}
      tone={groupTone(g)}
      summary={
        <>
          <span className="ops-state ops-tone-tag" data-live={g.live && g.status === "error" ? "true" : undefined}>{groupState(g)}</span>
          <span className="ops-row-title">{titleOf(g.kind, g.name)}</span>
          {/* Why it fails is on the row only while it fails; what went wrong before is a count, with the errors behind it. */}
          {g.live && g.status === "error" && g.reasons.slice(0, REASONS).map((r) => (
            <span key={r.reason} className="ops-tag" data-tone="bad">{r.reason}{r.count > 1 && <span className="ops-num ops-tag-n">{r.count}</span>}</span>
          ))}
          {!g.live && g.status === "error" && <span className="ops-row-when ops-num">{g.reasons.reduce((n, r) => n + r.count, 0)} failed</span>}
          <span className="ops-row-fill" />
          <span className="ops-row-when ops-row-actor">{ACTOR_LABEL[g.actor]}</span>
          <span className="ops-row-when ops-watch-age" title={moment(g.latest)}>{ago(g.latest, now)}</span>
        </>
      }
    >
      <CallGroupDetail group={g} />
    </Disclosure>
  );

  const risky = actions.filter((a) => a.risk === "high");
  const safe = actions.filter((a) => a.risk !== "high");
  const actionRow = (a: GrantableAction) => {
    const g = grantOf(a.name);
    const id = `do:${a.name}`;
    // An agent was refused this lately and it is still off: the row to decide on.
    const asked = live.find((x) => x.status === "denied" && x.kind === "do" && x.name === a.name);
    return (
      <Disclosure
        key={a.name}
        id={id}
        open={open}
        toggle={toggle}
        summary={
          <>
            <span className="ops-row-title" data-off={g ? undefined : "true"}>{a.title}</span>
                        {asked && <span className="ops-tag" data-tone="warn" title={moment(asked.latest)}>Asked {ago(asked.latest, now)}</span>}
            <span className="ops-row-fill" />
            {g?.until && <span className="ops-row-when">until {day(g.until)}</span>}
          </>
        }
        lead={
          confirming === a.name ? (
            <span className="ops-confirm" onKeyDown={(e) => e.key === "Escape" && setConfirming(null)}>
              <button type="button" className="ops-btn" data-tone="danger" onClick={() => { setConfirming(null); onGrant(a.name, true); }}>Grant high risk</button>
              {/* Focus lands on the way out, so a stray Enter never grants. */}
              <button type="button" className="ops-btn" autoFocus onClick={() => setConfirming(null)}>Cancel</button>
            </span>
          ) : (
            <span className="ops-grant">
              <Switch
                checked={!!g}
                onCheckedChange={(on) => (on && a.risk === "high" ? setConfirming(a.name) : onGrant(a.name, on))}
                aria-label={`${g ? "Revoke" : "Grant"} ${a.title}`}
              />
            </span>
          )
        }
      >
        <EntryDetail entry={a} usage={usage.get(id)} now={now}>
          <dt>Repeat</dt>
          <dd>{a.idempotent ? "Safe" : <span style={{ color: "var(--sol-orange)" }}>Runs again each time</span>}</dd>
          {g && <><dt>Granted</dt><dd>{moment(g.granted_at)}{nameOf?.(g.granted_by) ? ` · ${nameOf(g.granted_by)}` : ""}</dd></>}
        </EntryDetail>
      </Disclosure>
    );
};

  return (
    <div className="ops-app">
      <header className="ops-app-head" data-tone={health.tone}>
        <div className="ops-app-id">
          <div className="min-w-0">
            <div className="ops-app-name">
              <span className="truncate">{source.name}</span>
              <span className="ops-app-verdict">{health.label}</span>
            </div>
            <div className="ops-app-meta">
              {answered && <span title={moment(answered)}>answered {ago(answered, now)}</span>}
              {lastFailed && <span title={moment(lastFailed)}>last failure {ago(lastFailed, now)}</span>}
              {!isApp && <span>{SOURCE_PROVIDER_LABEL[source.provider] ?? source.provider}</span>}
              <Link href={opsHref.tab("timeline", { source: source.name })} className="ops-app-link" title={manifest && source.manifest_fetched_at ? `${manifest.name} ${manifest.version}, read ${moment(source.manifest_fetched_at)}` : undefined}><History className="w-3 h-3" />Timeline</Link>
            </div>
          </div>
        </div>
        <div className="ops-app-stats">
          <Stat value={failing} label="failing now" tone={failing ? "bad" : "ok"} />
          {isApp && manifest && <Stat value={watches.filter((w) => w.tone === "ok").length} of={watches.length} label="watches ok" tone={watches.some((w) => w.tone === "bad") ? "bad" : watches.some((w) => w.tone === "warn") ? "warn" : undefined} />}
        </div>
        {health.detail && (
          <Disclosure id="health" open={open} toggle={toggle} className="ops-app-why" summary={<span className="ops-row-title">{callReason({ status: "error", error: health.detail })}</span>}>
            <pre className="ops-fulltext">{health.detail}</pre>
          </Disclosure>
        )}
      </header>

      {isApp && !manifest ? (
        <OpsEmpty title={`${source.name} has no manifest yet`} />
      ) : (
        <div className="ops-app-grid">
          <div className="ops-app-col">
            <Panel title="Agents can" count={`${granted.length} of ${actions.length} granted`} empty={actions.length === 0 && "No actions declared"} >
              {risky.length > 0 && <div className="ops-sub" data-tone="bad"><ShieldAlert className="w-3.5 h-3.5" /><span>High risk</span><span className="ops-num">{risky.length}</span></div>}
              {risky.map(actionRow)}
              {risky.length > 0 && safe.length > 0 && <div className="ops-sub"><span>Low risk</span><span className="ops-num">{safe.length}</span></div>}
              {safe.map(actionRow)}
            </Panel>

            {manifest && manifest.readers.length + manifest.views.length > 0 && (
              <Panel title="Agents can read" count={manifest.readers.length + manifest.views.length}>
                <ChipSet
                  groups={[
                    {
                      label: "Data",
                      items: manifest.readers.map((r) => ({
                        id: `read:${r.name}`,
                        label: r.title,
                        detail: (
                          <EntryDetail entry={r} usage={usage.get(`read:${r.name}`)} now={now}>
                            {r.output_hint && <><dt>Returns</dt><dd>{r.output_hint}</dd></>}
                            {watchedEvery.has(r.name) && <><dt>Watched</dt><dd>every {watchedEvery.get(r.name)}</dd></>}
                          </EntryDetail>
                        ),
                      })),
                    },
                    {
                      label: "Screens",
                      badge: viewsLocked && <span className="ops-tag" data-tone="warn">Not granted</span>,
                      items: manifest.views.map((v) => ({
                        id: `view:${v.name}`,
                        label: v.title,
                        detail: (
                          <>
                            {v.description && <p className="ops-prose">{v.description}</p>}
                            <dl className="ops-kv">
                              <dt>Name</dt><dd className="ops-mono">{v.name}</dd>
                              <dt>Path</dt><dd className="ops-mono">{v.path}</dd>
                              {v.params.length > 0 && <><dt>Takes</dt><dd className="ops-mono">{v.params.join("  ")}</dd></>}
                            </dl>
                          </>
                        ),
                      })),
                    },
                  ]}
                />
              </Panel>
            )}
          </div>

          <div className="ops-app-col">
            {manifest && manifest.watches.length > 0 && (
              <Panel title="Watches" count={watches.length}>
                {watches.map((w) => (
                  <Disclosure
                    key={w.key}
                    id={`watch:${w.key}`}
                    open={open}
                    toggle={toggle}
                    tone={w.tone}
                    summary={
                      <>
                        <span className="ops-state ops-tone-tag" data-live={w.tone === "bad" ? "true" : undefined}>{w.label}</span>
                        <span className="ops-row-title">{titleOf("read", w.watch.reader)}</span>
                        <span className="ops-row-fill" />
                        <span className="ops-row-when ops-watch-every">every {w.watch.every}</span>
                        <span className="ops-row-when ops-watch-age" title={w.polledAt ? moment(w.polledAt) : undefined}>{w.polledAt ? ago(w.polledAt, now) : "not yet"}</span>
                      </>
                    }
                  >
                    {w.error && <pre className="ops-fulltext">{w.error}</pre>}
                    <dl className="ops-kv">
                      <dt>Reader</dt><dd className="ops-mono">{w.watch.reader}</dd>
                      <dt>Rows become</dt><dd>{w.watch.kind === "check" ? "Checks" : "Failed jobs"}</dd>
                      <dt>Fields</dt><dd className="ops-mono">{Object.entries(w.watch.map).map(([k, v]) => `${k}=${v}`).join("  ")}</dd>
                      {w.lastFailure && <><dt>Failed</dt><dd className="ops-num">{w.failures} of the last {calls.length} calls · last {moment(w.lastFailure)}</dd></>}
                    </dl>
                  </Disclosure>
                ))}
              </Panel>
            )}

            <Panel title="Recent calls" empty={calls.length === 0 && "No calls yet"}>
              {failingCalls.length > 0 && <div className="ops-sub" data-tone="bad"><span>Failing now</span><span className="ops-num">{failingCalls.length}</span></div>}
              {failingCalls.map(callRow)}
              {failingCalls.length > 0 && otherCalls.length > 0 && <div className="ops-sub"><span>Earlier</span><span className="ops-num">{otherCalls.length}</span></div>}
              {otherCalls.map(callRow)}
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pieces ──

function Stat({ value, of, label, tone, children }: { value: number; of?: number; label: string; tone?: AppTone; children?: ReactNode }) {
  return (
    <div className="ops-stat" data-tone={tone}>
      <div className="ops-stat-value ops-num">
        {value}
        {of !== undefined && <span className="ops-stat-of">/{of}</span>}
        {children}
      </div>
      <div className="ops-stat-label">{label}</div>
    </div>
  );
}

function Panel({ title, count, badge, empty, children }: { title: string; count?: ReactNode; badge?: ReactNode; empty?: string | false; children?: ReactNode }) {
  return (
    <section className="ops-card ops-panel" aria-label={title}>
      <div className="ops-card-head">
        <span className="ops-panel-title">{title}{count !== undefined && <span className="ops-dim ops-num font-normal">{count}</span>}</span>
        {badge}
      </div>
      {empty ? <div className="ops-panel-empty">{empty}</div> : children}
    </section>
  );
}

type Chip = { id: string; label: string; detail: ReactNode };
type ChipGroup = { label: string; badge?: ReactNode; items: Chip[] };

/**
 * Many small things of a kind as one row each kind: its label, how many, and
 * the first few names. Opening the row lists them as chips, and picking a chip
 * opens what stands behind it.
 */
function ChipSet({ groups }: { groups: ChipGroup[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <>
      {groups.filter((g) => g.items.length > 0).map((g) => {
        const on = open === g.label;
        const item = on ? g.items.find((i) => i.id === picked) : undefined;
        return (
          <div key={g.label} className="ops-row" data-open={on ? "true" : undefined}>
            <div className="ops-row-line">
              <button type="button" className="ops-row-main" aria-expanded={on} onClick={() => setOpen(on ? null : g.label)}>
                <span className="ops-row-title">{g.label}</span>
                <span className="ops-row-when ops-row-count ops-num">{g.items.length}</span>
                <span className="ops-row-fill" />
                {g.badge}
                <ChevronRight className="ops-row-chev" strokeWidth={1.75} />
              </button>
            </div>
            {on && (
              <div className="ops-chips">
                {g.items.map((i) => (
                  <button key={i.id} type="button" className="ops-chip" aria-expanded={i.id === picked} data-on={i.id === picked ? "true" : undefined} onClick={() => setPicked(i.id === picked ? null : i.id)}>
                    {i.label}
                  </button>
                ))}
              </div>
            )}
            {item && <div className="ops-row-detail ops-chip-detail">{item.detail}</div>}
          </div>
        );
      })}
    </>
  );
}

/** A row that names one thing and opens what stands behind it. `lead` holds a control that is not part of the opener. */
function Disclosure({ id, open, toggle, tone, summary, lead, className, children }: { id: string; open: ReadonlySet<string>; toggle: (id: string) => void; tone?: AppTone; summary: ReactNode; lead?: ReactNode; className?: string; children: ReactNode }) {
  const on = open.has(id);
  return (
    <div className={`ops-row ${className ?? ""}`} data-open={on ? "true" : undefined} data-tone={tone}>
      <div className="ops-row-line">
        {lead}
        <button type="button" className="ops-row-main" aria-expanded={on} onClick={() => toggle(id)}>
          {summary}
          <ChevronRight className="ops-row-chev" strokeWidth={1.75} />
        </button>
      </div>
      {on && <div className="ops-row-detail">{children}</div>}
    </div>
  );
}

function Params({ params }: { params: Param[] }) {
  return (
    <span className="ops-params">
      {params.map((p) => (
        <span key={p.name} className="ops-param" data-required={p.required ? "true" : undefined} title={[p.type, p.required ? "required" : "optional", p.description].filter(Boolean).join(" · ")}>
          {p.name}
        </span>
      ))}
    </span>
  );
}

/** What stands behind a reader or an action: the manifest's own words, its name, route and arguments. */
function EntryDetail({ entry, usage, now, children }: { entry: { name: string; title: string; description?: string; method?: string; path?: string; input?: Parameters<typeof schemaParams>[0] }; usage?: Usage; now: number; children?: ReactNode }) {
  const params = schemaParams(entry.input);
  return (
    <>
      {entry.description && <p className="ops-prose">{entry.description}</p>}
      <dl className="ops-kv">
        <dt>Name</dt><dd className="ops-mono">{entry.name}</dd>
        {entry.path && <><dt>Route</dt><dd className="ops-mono">{entry.method} {entry.path}</dd></>}
        {params.length > 0 && <><dt>Takes</dt><dd><Params params={params} /></dd></>}
        {children}
        {usage && <><dt>Calls</dt><dd className="ops-num">{usage.count}{usage.failed ? `, ${usage.failed} failed` : ""}{usage.last ? ` · last ${relTimeShort(usage.last, now)}` : ""}</dd></>}
      </dl>
    </>
  );
}

function CallGroupDetail({ group }: { group: CallGroup }) {
  const more = group.count - OCCURRENCES;
  return (
    <>
      {group.reasons.filter((r) => r.error).map((r) => (
        <div key={r.reason} className="ops-reason">
          <div className="ops-reason-head"><span>{r.reason}</span><span className="ops-dim ops-num">{r.count}</span></div>
          <pre className="ops-fulltext">{r.error}</pre>
        </div>
      ))}
      <table className="ops-occ">
        <thead>
          <tr><th>{group.kind} <span className="ops-mono">{group.name}</span></th><th>ms</th><th>bytes</th><th>Session</th></tr>
        </thead>
        <tbody>
          {group.calls.slice(0, OCCURRENCES).map((c) => (
            <tr key={c._id}>
              <td>{moment(c.created_at)}{c.http_status ? <span className="ops-dim"> · {c.http_status}</span> : null}</td>
              {/* A call refused or failed before it reached the app has no time or size to show. */}
              <td className="ops-num">{c.ms || c.bytes ? c.ms.toLocaleString() : ""}</td>
              <td className="ops-num">{c.ms || c.bytes ? c.bytes.toLocaleString() : ""}</td>
              <td className="ops-ref-fit">{c.conversation_id ? <EntityIdPill type="session" id={c.conversation_id} compact /> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {more > 0 && <div className="ops-dim text-[11px] ops-num">+{more} earlier, back to {day(group.oldest)}</div>}
    </>
  );
}
