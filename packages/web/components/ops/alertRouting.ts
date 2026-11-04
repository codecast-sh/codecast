// Who else a watch's alert reaches (contracts/metricMonitor AlertNotify), as
// the web reads it: the names behind the stored ids, the one-line summary the
// Source card and the overview table show, the review a fix that starts on
// its own goes through, and which deliveries belong to which transition.
import { useMemo } from "react";
import { DELIVERIES_KEPT, type AlertDelivery, type AlertNotify, type AlertNotifyInput } from "@codecast/shared/contracts/metricMonitor";
import { useInboxStore } from "../../store/inboxStore";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import type { SwitchLedger } from "../consequential/ConsequentialSwitch";
import { useOwnerOptions, type OwnerOption } from "./issueAssign";
import { spanLabel, type TransitionRow } from "./metricModel";
import type { OpsSource, OpsWatch } from "./opsTypes";

export type ChannelOption = { _id: string; name: string };

type ChannelRow = { _id: string; name?: string; team_id?: string; kind?: string; archived_at?: number };

const NO_CHANNELS: Record<string, ChannelRow> = {};

/** The team channels a watch in `workspace` can post to, by name; none for a personal workspace. */
export function useChannelOptions(workspace: string): ChannelOption[] {
  const channels = useInboxStore((s) => ((s as any).chatChannels as Record<string, ChannelRow> | undefined) ?? NO_CHANNELS);
  return useMemo(() => {
    if (!workspace.startsWith("team:")) return [];
    return Object.values(channels)
      .filter((c) => c && c.name && `team:${c.team_id}` === workspace && c.kind !== "dm" && c.kind !== "group" && !c.archived_at)
      .map((c) => ({ _id: c._id, name: c.name! }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [channels, workspace]);
}

/** The settable part of a notify setting, for a write that changes one piece of it. */
export function notifyInput(n: AlertNotify | undefined): AlertNotifyInput {
  if (!n) return {};
  const { by: _by, ...rest } = n;
  return rest;
}

/**
 * Who a new watch tells to start with: the people, roles and channel of the
 * workspace's most recently changed routed watch (the routes this team last
 * set), else the person making it. Repeat, recovery and a fix that starts by
 * itself are never carried over: each is a choice made on its own watch.
 */
export function lastUsedRoutes(watches: readonly Pick<OpsWatch, "workspace" | "notify" | "updated_at">[], workspace: string, me: string | undefined): AlertNotifyInput {
  let best: (typeof watches)[number] | undefined;
  for (const w of watches) {
    const n = w.notify;
    if (w.workspace !== workspace || !n || !(n.users?.length || n.roles?.length || n.channel)) continue;
    if (!best || w.updated_at > best.updated_at) best = w;
  }
  const n = best?.notify;
  if (!n) return me ? { users: [me] } : {};
  return { ...(n.users?.length ? { users: [...n.users] } : {}), ...(n.roles?.length ? { roles: [...n.roles] } : {}), ...(n.channel ? { channel: n.channel } : {}) };
}

/** A person, role or channel the alert tells, as a chip names it. */
export type NotifyTarget = { kind: "user" | "role" | "channel"; id: string; label: string; option?: OwnerOption };

/** The targets a setting names, each with its name, the ones nobody here can name labelled as removed. */
export function notifyTargets(n: AlertNotify | undefined, options: OwnerOption[], channels: ChannelOption[]): NotifyTarget[] {
  if (!n) return [];
  const byKey = new Map(options.map((o) => [o.key, o]));
  const person = (id: string, kind: "user" | "role"): NotifyTarget => {
    const o = byKey.get(id);
    return { kind, id, option: o, label: o ? (o.info.kind === "role" ? `@${o.info.handle}` : o.label) : kind === "role" ? "removed role" : "removed person" };
  };
  const channel = n.channel ? channels.find((c) => c._id === n.channel) : undefined;
  return [
    ...(n.users ?? []).map((id) => person(id, "user")),
    ...(n.roles ?? []).map((id) => person(id, "role")),
    ...(n.channel ? [{ kind: "channel" as const, id: n.channel, label: channel ? `#${channel.name}` : "#removed" }] : []),
  ];
}

/** The routes in a few words, for the Source card and the overview table: "@cam #ops · every 1h · recovery · fix". */
export function notifySummary(n: AlertNotify | undefined, targets: NotifyTarget[]): string | null {
  if (!n) return null;
  const parts = [
    targets.map((t) => t.label).join(" "),
    n.renotify_ms ? `every ${spanLabel(n.renotify_ms)}` : "",
    n.recovery ? "recovery" : "",
    n.fix ? "fix starts" : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The people, roles and channels with their names, for a watch: what the routing control and the summaries read. */
export function useNotifyTargets(watch: Pick<OpsWatch, "notify" | "workspace">) {
  const options = useOwnerOptions();
  const channels = useChannelOptions(watch.workspace);
  const targets = useMemo(() => notifyTargets(watch.notify, options, channels), [watch.notify, options, channels]);
  return { options, channels, targets };
}

/** The folder a fix that starts on its own would run in: the source's project's. */
export function useFixFolder(source: OpsSource | undefined): string | null {
  return useInboxStore((s) => (source?.project_id ? ((s as any).projects?.[source.project_id]?.project_path as string | undefined) ?? null : null));
}

type FolderProject = { _id: string; title?: string; project_path?: string; archived_at?: number };
const folderSig = (p: FolderProject) => `${p.title ?? ""}|${p.project_path ?? ""}|${p.archived_at ?? ""}`;

/** The workspace's projects a fix can run in (those with a folder), by title. */
export function useFolderProjects(): { _id: string; title: string }[] {
  const rows = useWorkspaceCollection<FolderProject>("projects", folderSig);
  return useMemo(
    () => rows.filter((p) => p.project_path && !p.archived_at).map((p) => ({ _id: p._id, title: p.title || p.project_path!.split("/").pop()! })).sort((a, b) => a.title.localeCompare(b.title)),
    [rows],
  );
}

/** The review before a crossing may start a fix session by itself. */
/** What the auto-fix review names: a saved watch, or the one the New watch sheet is making (no short id yet). */
export type FixSubject = Pick<OpsWatch, "name" | "direction" | "threshold"> & { short_id?: string };

export function autoFixLedger(watch: FixSubject, source: OpsSource | undefined, folder: string | null, me: string): SwitchLedger {
  return {
    name: "Start fix on alert",
    subject: watch.short_id ? `${watch.name} · ${watch.short_id}` : watch.name || "New watch",
    figures: [{ value: "1", label: "session per episode" }, { value: "3", label: "a workspace an hour, at most" }],
    rows: [
      { k: "When", v: `It crosses ${watch.direction === "above" ? ">" : "<"} ${watch.threshold ?? "the line"}` },
      { k: "Runs as", v: me },
      { k: "Folder", v: folder ?? `${source?.name ?? "The source"} has no project`, tone: folder ? undefined : "warn" },
      { k: "Works on", v: "The issue and its problem task" },
      { k: "Cost", v: "One agent session each time", tone: "warn" },
    ],
    stop: "Turn off here, or Mute",
    confirm: "Start fixes on alert",
    ...(folder ? {} : { blocked: "Attach the source to a project first" }),
  };
}

/**
 * Which deliveries went out for which announced transition: a crossing's and
 * a recovery's by time (within `tol`), and each "still alerting" repeat to
 * the crossing before it. Keyed by the row's `at` and kind.
 */
export function deliveriesByRow(rows: readonly TransitionRow[], deliveries: readonly AlertDelivery[] | undefined, tol: number): Map<string, AlertDelivery[]> {
  const out = new Map<string, AlertDelivery[]>();
  if (!deliveries?.length) return out;
  const announced = rows.filter((r) => !r.inferred).sort((a, b) => a.at - b.at);
  for (const d of deliveries) {
    const want = d.kind === "recovered" ? "recovered" : "crossed";
    let row: TransitionRow | undefined;
    if (d.kind === "still") row = [...announced].reverse().find((r) => r.kind === "crossed" && r.at <= d.at);
    else row = announced.reduce<TransitionRow | undefined>((best, r) => (r.kind === want && Math.abs(r.at - d.at) <= tol && (!best || Math.abs(r.at - d.at) < Math.abs(best.at - d.at)) ? r : best), undefined);
    if (!row) continue;
    const key = rowKey(row);
    out.set(key, [...(out.get(key) ?? []), d]);
  }
  return out;
}

export const rowKey = (r: Pick<TransitionRow, "at" | "kind">) => `${r.at}-${r.kind}`;

/**
 * An announced transition its watch's routing says nothing about, though the
 * watch is routed now: a crossing (or a recovery, when recovery is told)
 * with no delivery while the kept deliveries reach back past it. The row
 * says "no routes then" rather than nothing. Called only for a row with no
 * delivery of its own.
 */
export function routedSilently(r: TransitionRow, watch: Pick<OpsWatch, "notify" | "deliveries">): boolean {
  const n = watch.notify;
  if (!n || r.inferred) return false;
  if (r.kind === "recovered" && !n.recovery) return false;
  const kept = watch.deliveries ?? [];
  // A full ring has dropped its oldest: what went out before its first entry is not known.
  if (kept.length >= DELIVERIES_KEPT && kept.length && r.at < Math.min(...kept.map((d) => d.at))) return false;
  return true;
}
