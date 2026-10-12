// The Apps tab (X8): each source codecast may act through, as a board. The
// head answers whether the connection is healthy; under it sit what agents
// may do (a switch per action, the only place a grant is made: an agent's CLI
// cannot), what is watched, the call audit folded into groups with what still
// fails first, and what codecast can read. Every row is a name and its state;
// the manifest's own description, the route, the arguments and the full error
// open under the row that names them (appsModel.ts works all of it out).
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, Eye, History, ShieldAlert } from "lucide-react";
import { activeGrant, grantableActions, parseAppManifest, sourceHasGrants, type AppManifest } from "@codecast/shared/contracts/appConnector";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpsApp, useOpsAppCalls, useOpsSources, useSyncOpsApp } from "../../hooks/useSyncOps";
import { useInboxStore } from "../../store/inboxStore";
import { relTimeShort } from "../../lib/utils";
import { Switch } from "../ui/switch";
import { EntityIdPill } from "../EntityIdPill";
import { appHealth, callReason, dayBuckets, failingNow, groupCalls, groupState, groupTone, lastFailure, schemaParams, titleLookup, usageByName, watchRows, type AppTone, type CallGroup, type DayBucket, type Param, type Usage } from "./appsModel";
import { opsHref } from "./opsPaths";
import { OpsEmpty, OpsFeedEmpty, OpsFeedError, SETUP_HREF, SOURCE_PROVIDER_LABEL, SourceChip, useOpsFeed } from "./parts";
import type { OpsApp, OpsAppCall, OpsSource } from "./opsTypes";

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
        <div className="ops-filters">
          {apps.map((s) => (
            <SourceChip key={s._id} source={s} href={opsHref.tab("apps", { app: s.short_id || s._id })} on={s._id === selected?._id} />
          ))}
        </div>
      )}
      {selected && <AppDetail key={selected._id} source={selected} />}
    </div>
  );
}

function AppDetail({ source }: { source: OpsSource }) {
  const feed = useSyncOpsApp(source._id);
  const app = useOpsApp(source._id);
  const calls = useOpsAppCalls(source._id);
  const now = useCoarseNow(60_000);
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
  return <AppBoard source={source} app={app} manifest={manifest} calls={calls} now={now} nameOf={nameOf} onGrant={setGrant} />;
}

// ── The board ──

export type AppBoardProps = {
  source: Pick<OpsSource, "_id" | "name" | "provider" | "status" | "last_error">;
  app: OpsApp;
  manifest: AppManifest | null;
  calls: OpsAppCall[];
  now: number;
  nameOf?: (userId: string) => string | null;
  onGrant: (action: string, on: boolean) => void;
};

const ACTOR_LABEL = { watch: "Watch", cli: "Terminal", session: "Session" } as const;
/** Occurrences a call group lists before it counts the rest. */
const OCCURRENCES = 8;
/** Reasons a call row names before it counts the rest. */
const REASONS = 3;

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const moment = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function AppBoard({ source, app, manifest, calls, now, nameOf, onGrant }: AppBoardProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const isApp = source.provider === "app";
  const actions = grantableActions(source.provider, manifest);
  const grantOf = (name: string) => activeGrant(app.grants ?? [], name, now);
  const granted = actions.filter((a) => grantOf(a.name));
  const riskyGranted = granted.filter((a) => a.risk === "high").length;

  const watches = useMemo(() => watchRows(manifest?.watches ?? [], app.watch_state ?? [], calls, now), [manifest, app.watch_state, calls, now]);
  const groups = useMemo(
    () => groupCalls(calls, { grants: app.grants ?? [], watchState: app.watch_state ?? [], watches: manifest?.watches ?? [], now }),
    [calls, app.grants, app.watch_state, manifest, now],
  );
  const usage = useMemo(() => usageByName(calls), [calls]);
  const days = useMemo(() => dayBuckets(calls, now), [calls, now]);
  const titleOf = useMemo(() => titleLookup(manifest, actions), [manifest, actions]);
  const health = appHealth(source, watches, groups);
  const failing = failingNow(watches, groups);
  const lastFailed = useMemo(() => lastFailure(calls), [calls]);
  const live = groups.filter((g) => g.live);
  const past = groups.filter((g) => !g.live);
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
          <span className="ops-lamp" />
          <span className="ops-row-title">{titleOf(g.kind, g.name)}</span>
          {g.status === "error" && g.reasons.slice(0, REASONS).map((r) => (
            <span key={r.reason} className="ops-tag ops-tone-tag">{r.reason}{g.count > 1 && <span className="ops-num ops-tag-n">{r.count}</span>}</span>
          ))}
          {g.status === "error" && g.reasons.length > REASONS && <span className="ops-tag ops-num">+{g.reasons.length - REASONS}</span>}
          <span className="ops-row-fill" />
          <span className="ops-cols ops-cols-call">
            <span>{ACTOR_LABEL[g.actor]}</span>
            <span title={moment(g.latest)}>{relTimeShort(g.latest, now)}</span>
            <span className="ops-tone-ink">{groupState(g)}</span>
          </span>
        </>
      }
    >
      <CallGroupDetail group={g} />
    </Disclosure>
  );

  return (
    <div className="ops-app">
      <header className="ops-app-head" data-tone={health.tone}>
        <div className="ops-app-id">
          <span className="ops-app-lamp" />
          <div className="min-w-0">
            <div className="ops-app-name">
              <span className="truncate">{source.name}</span>
              <span className="ops-app-verdict">{health.label}</span>
            </div>
            <div className="ops-app-meta">
              <span>{SOURCE_PROVIDER_LABEL[source.provider] ?? source.provider}</span>
              {manifest && <span className="ops-mono" title={`${manifest.name} ${manifest.version}`}>{manifest.version.slice(0, 7)}</span>}
              {app.manifest_fetched_at && <span title={`Manifest read ${moment(app.manifest_fetched_at)}`}>synced {relTimeShort(app.manifest_fetched_at, now)}</span>}
              <Link href={opsHref.tab("timeline", { source: source.name })} className="ops-app-link"><History className="w-3 h-3" />Timeline</Link>
            </div>
          </div>
        </div>
        <div className="ops-app-stats">
          <Stat value={failing} label="failing now" tone={failing ? "bad" : "ok"} />
          {isApp && manifest && <Stat value={watches.filter((w) => w.tone === "ok").length} of={watches.length} label="watches ok" tone={watches.some((w) => w.tone === "bad") ? "bad" : watches.some((w) => w.tone === "warn") ? "warn" : undefined} />}
          <Stat value={granted.length} of={actions.length} label="actions granted">
            {riskyGranted > 0 && <span className="ops-tag" data-tone="bad" data-solid="true"><ShieldAlert className="w-3 h-3" />{riskyGranted} high risk</span>}
          </Stat>
          <div className="ops-stat">
            <DayStrip days={days} />
            <div className="ops-stat-label">failed calls by day{lastFailed ? <> · last <span className="ops-num">{relTimeShort(lastFailed, now)}</span> ago</> : ""}</div>
          </div>
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
            <Panel title="Agents can" count={`${granted.length} of ${actions.length}`} empty={actions.length === 0 && "No actions declared"} cols={["Granted"]} colClass="ops-cols-grant">
              {actions.map((a) => {
                const g = grantOf(a.name);
                const id = `do:${a.name}`;
                return (
                  <Disclosure
                    key={a.name}
                    id={id}
                    open={open}
                    toggle={toggle}
                    className={a.risk === "high" ? "ops-row-risk" : undefined}
                    summary={
                      <>
                        <span className="ops-row-title" data-off={g ? undefined : "true"}>{a.title}</span>
                        {a.risk === "high" && <span className="ops-tag" data-tone="bad" data-solid="true"><ShieldAlert className="w-3 h-3" />High risk</span>}
                        <span className="ops-row-fill" />
                        {g?.until && <span className="ops-row-when">until {day(g.until)}</span>}
                      </>
                    }
                    trail={
                      confirming === a.name ? (
                        <span className="ops-confirm" onKeyDown={(e) => e.key === "Escape" && setConfirming(null)}>
                          <button type="button" className="ops-btn" data-tone="danger" autoFocus onClick={() => { setConfirming(null); onGrant(a.name, true); }}>Grant high risk</button>
                          <button type="button" className="ops-btn" onClick={() => setConfirming(null)}>Cancel</button>
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
              })}
            </Panel>

            {manifest && manifest.watches.length > 0 && (
              <Panel title="Watches" count={watches.length} cols={["Every", "Polled", "Last failed", "State"]} colClass="ops-cols-watch">
                {watches.map((w) => (
                  <Disclosure
                    key={w.key}
                    id={`watch:${w.key}`}
                    open={open}
                    toggle={toggle}
                    tone={w.tone}
                    summary={
                      <>
                        <span className="ops-lamp" />
                        <span className="ops-row-title">{titleOf("read", w.watch.reader)}</span>
                        <span className="ops-row-fill" />
                        <span className="ops-cols ops-cols-watch">
                          <span>{w.watch.every}</span>
                          <span title={w.polledAt ? moment(w.polledAt) : undefined}>{w.polledAt ? relTimeShort(w.polledAt, now) : ""}</span>
                          <span title={w.lastFailure ? moment(w.lastFailure) : undefined}>{w.lastFailure ? relTimeShort(w.lastFailure, now) : ""}</span>
                          <span className="ops-tone-ink">{w.label}</span>
                        </span>
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

            {manifest && manifest.views.length > 0 && (
              <Panel title="Views" count={manifest.views.length} badge={viewsLocked && <span className="ops-tag" data-tone="warn">Not granted</span>}>
                <ChipSet
                  items={manifest.views.map((v) => ({
                    id: v.name,
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
                  }))}
                />
              </Panel>
            )}
          </div>

          <div className="ops-app-col">
            <Panel title="Calls" count={calls.length} empty={calls.length === 0 && "No calls yet"} cols={["By", "Last", "State"]} colClass="ops-cols-call">
              <div className="ops-sub" data-tone={live.length ? "bad" : "ok"}>
                <span>Failing now</span>
                <span className="ops-num ops-tone-ink">{live.length}</span>
              </div>
              {live.map(callRow)}
              {past.length > 0 && <div className="ops-sub"><span>History</span><span className="ops-num">{past.length}</span></div>}
              {past.map(callRow)}
            </Panel>

            {manifest && (
              <Panel title="Agents can read" count={manifest.readers.length} empty={manifest.readers.length === 0 && "No readers declared"}>
                <ChipSet
                  items={manifest.readers.map((r) => {
                    const u = usage.get(`read:${r.name}`);
                    return {
                      id: r.name,
                      label: r.title,
                      mark: watchedEvery.has(r.name) ? <span title={`Watched every ${watchedEvery.get(r.name)}`}><Eye className="w-3 h-3" /></span> : null,
                      detail: (
                        <EntryDetail entry={r} usage={u} now={now}>
                          {r.output_hint && <><dt>Returns</dt><dd>{r.output_hint}</dd></>}
                          {watchedEvery.has(r.name) && <><dt>Watched</dt><dd>every {watchedEvery.get(r.name)}</dd></>}
                        </EntryDetail>
                      ),
                    };
                  })}
                />
              </Panel>
            )}
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

/** The last days as a row of cells: a day with failures is red and carries their count, a clean day with calls is green. */
function DayStrip({ days }: { days: DayBucket[] }) {
  return (
    <div className="ops-days" role="img" aria-label={`Failed calls by day, last ${days.length} days`}>
      {days.map((d, i) => (
        <span key={d.start} className="ops-day" data-tone={d.failed ? "bad" : d.ok + d.denied ? "ok" : undefined} data-today={i === days.length - 1 ? "true" : undefined} title={`${day(d.start)}: ${d.ok} ok, ${d.failed} failed${d.denied ? `, ${d.denied} denied` : ""}`}>
          <b className="ops-num">{d.failed || ""}</b>
          <i>{new Date(d.start).toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2)}</i>
        </span>
      ))}
    </div>
  );
}

function Panel({ title, count, badge, cols, colClass, empty, children }: { title: string; count?: ReactNode; badge?: ReactNode; cols?: string[]; colClass?: string; empty?: string | false; children?: ReactNode }) {
  return (
    <section className="ops-card ops-panel" aria-label={title}>
      <div className="ops-card-head">
        <span className="ops-panel-title">{title}{count !== undefined && <span className="ops-dim ops-num font-normal">{count}</span>}</span>
        {badge}
      </div>
      {empty ? (
        <div className="ops-panel-empty">{empty}</div>
      ) : (
        <>
          {cols && <div className="ops-panel-cols"><span className={`ops-cols ${colClass ?? ""}`}>{cols.map((c) => <span key={c}>{c}</span>)}</span></div>}
          {children}
        </>
      )}
    </section>
  );
}

type Chip = { id: string; label: string; mark?: ReactNode; detail: ReactNode };

/** Many small things of one kind as chips; picking one opens what stands behind it under the set. */
function ChipSet({ items }: { items: Chip[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const item = items.find((i) => i.id === picked);
  return (
    <>
      <div className="ops-chips">
        {items.map((i) => (
          <button key={i.id} type="button" className="ops-chip" aria-expanded={i.id === picked} data-on={i.id === picked ? "true" : undefined} onClick={() => setPicked(i.id === picked ? null : i.id)}>
            {i.label}
            {i.mark}
          </button>
        ))}
      </div>
      {item && <div className="ops-row-detail ops-chip-detail">{item.detail}</div>}
    </>
  );
}

/** A row that names one thing and opens what stands behind it. `trail` holds a control that is not part of the opener. */
function Disclosure({ id, open, toggle, tone, summary, trail, className, children }: { id: string; open: ReadonlySet<string>; toggle: (id: string) => void; tone?: AppTone; summary: ReactNode; trail?: ReactNode; className?: string; children: ReactNode }) {
  const on = open.has(id);
  return (
    <div className={`ops-row ${className ?? ""}`} data-open={on ? "true" : undefined} data-tone={tone}>
      <div className="ops-row-line">
        <button type="button" className="ops-row-main" aria-expanded={on} onClick={() => toggle(id)}>
          <ChevronRight className="ops-row-chev" strokeWidth={1.75} />
          {summary}
        </button>
        {trail}
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
