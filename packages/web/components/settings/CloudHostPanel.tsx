"use client";

/**
 * A cloud host on Settings > Machines: is it awake and what it costs, whether
 * it carries this laptop's setup, and the buttons that fix what is off.
 *
 * Two machines know a host, and each writes its own half onto the host's
 * device row: the host heartbeats `host_readiness` (what is on its disk), and
 * the laptop that manages it reports `cloud_host` (AWS state, cost, saved
 * images, logins it held back, the last action). Actions go to that laptop
 * (store cloudHostAction → cloud_host_action), which runs `cast hosts ...`.
 */

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import type { CloudHostAction, CloudHostReport, HostReadiness } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { Button } from "../ui/button";
import { ConfirmButton } from "../integrations/parts";
import { deviceDisplayName, relativeSeen, useDevices, type Device } from "../DeviceBadge";

/** An action nobody answered: the laptop went away mid-run, or never picked it up. */
const ACTION_STALE_MS = 35 * 60_000;
const REPORT_STALE_MS = 40 * 60_000;

const STATE: Record<CloudHostReport["state"], { word: string; dot: string }> = {
  running: { word: "Awake", dot: "bg-sol-green" },
  pending: { word: "Waking", dot: "bg-sol-yellow animate-pulse" },
  stopping: { word: "Going to sleep", dot: "bg-sol-yellow animate-pulse" },
  stopped: { word: "Asleep", dot: "bg-sol-text-dim" },
  missing: { word: "Gone from AWS", dot: "bg-sol-red" },
  unknown: { word: "State unknown", dot: "bg-sol-text-dim" },
};

const DOING: Record<CloudHostAction, [running: string, done: string]> = {
  wake: ["Waking", "Woke"],
  sleep: ["Putting to sleep", "Put to sleep"],
  setup: ["Applying setup", "Applied setup"],
  image: ["Saving an image", "Saved an image"],
  delete_image: ["Deleting an image", "Deleted an image"],
};

type Tone = "ok" | "warn" | "bad" | "idle";
const TONE_DOT: Record<Tone, string> = { ok: "bg-sol-green", warn: "bg-sol-yellow", bad: "bg-sol-red", idle: "bg-sol-text-dim opacity-60" };

function Row({ tone, label, children, fix }: { tone: Tone; label: string; children: ReactNode; fix?: ReactNode }) {
  return (
    <li className="grid grid-cols-[0.5rem_6.5rem_1fr] items-baseline gap-x-2 text-[11px]">
      <span className={`h-1.5 w-1.5 translate-y-[-1px] rounded-full ${TONE_DOT[tone]}`} aria-hidden />
      <span className="text-sol-text-muted">{label}</span>
      <span className="min-w-0 text-sol-text-secondary">
        <span className="break-words">{children}</span>
        {fix && <span className="mt-0.5 block text-sol-text-dim">{fix}</span>}
      </span>
    </li>
  );
}

const Code = ({ children }: { children: ReactNode }) => <code className="font-mono text-sol-text">{children}</code>;

function ago(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? relativeSeen(t) : "";
}

function money(n: number): string {
  return n < 1 ? `$${n.toFixed(3).replace(/0$/, "")}` : `$${n.toFixed(2)}`;
}

function stateLine(r: CloudHostReport): string {
  const parts = [r.instance_type, r.region].filter(Boolean).join(" · ");
  const cost = /^mac/.test(r.instance_type ?? "") ? "the dedicated host bills while allocated, awake or asleep" : [
    r.hourly_usd !== undefined ? `${money(r.hourly_usd)}/h awake` : null,
    r.disk_monthly_usd !== undefined ? `${money(r.disk_monthly_usd)}/mo disk${r.disk_gib ? ` (${r.disk_gib} GiB)` : ""}` : null,
  ].filter(Boolean).join(", ");
  const sleep = r.state === "stopped" ? "wakes when a session moves here" : r.idle_stop_minutes ? `sleeps after ${r.idle_stop_minutes} idle min` : null;
  return [parts, cost, sleep].filter(Boolean).join(" · ");
}

function SetupRow({ h, laptop }: { h?: HostReadiness; laptop: string }) {
  const m = h?.mirror;
  if (!m) return <Row tone="idle" label="Your setup" fix={<>Turn on the home mirror on {laptop}: <Code>cast config cloud_mirror_enabled true</Code></>}>not copied here yet</Row>;
  const when = ago(m.applied_at);
  if (!m.complete) return <Row tone="warn" label="Your setup" fix={<>It finishes on the next push from {laptop}, or now with <Code>cast hosts sync</Code></>}>partly copied · the last push did not finish</Row>;
  if (m.host_edited.length) {
    return (
      <Row tone="warn" label="Your setup" fix={`Edited on the host, so the mirror keeps the host's copy: ${m.host_edited.slice(0, 4).join(", ")}${m.host_edited.length > 4 ? ` +${m.host_edited.length - 4}` : ""}`}>
        in step · {m.files.toLocaleString()} files{when ? ` · ${when}` : ""} · {m.host_edited.length} kept as the host edited {m.host_edited.length === 1 ? "it" : "them"}
      </Row>
    );
  }
  return <Row tone="ok" label="Your setup">agent config, skills, shell and memory in step · {m.files.toLocaleString()} files{when ? ` · ${when}` : ""}</Row>;
}

function LoginsRow({ h, r, laptop }: { h?: HostReadiness; r?: CloudHostReport; laptop: string }) {
  const have = h?.logins ?? [];
  const held = r?.logins_held ?? [];
  const list = have.length > 8 ? `${have.slice(0, 8).join(", ")} +${have.length - 8}` : have.join(", ");
  if (!have.length && !held.length) return <Row tone="idle" label="Logins">none copied yet</Row>;
  return (
    <Row
      tone={held.length ? "warn" : "ok"}
      label="Logins"
      fix={held.length ? (
        <span className="block space-y-0.5">
          {held.slice(0, 5).map((x) => <span key={x.id} className="block"><span className="text-sol-yellow">{x.id}</span> held back: {x.reason}.{/expir|lapsed|stale|refresh/i.test(x.reason) ? ` Sign in again on ${laptop} and it follows.` : ""}</span>)}
        </span>
      ) : undefined}
    >
      {list || "none"}
    </Row>
  );
}

function ToolsRow({ h }: { h?: HostReadiness }) {
  const t = h?.tools;
  if (!t) return null;
  if (!t.missing.length) return <Row tone="ok" label="Tools">{t.ok} at your versions{t.installed ? ` · ${t.installed} installed on the last push` : ""}</Row>;
  return (
    <Row tone="warn" label="Tools" fix={t.missing.slice(0, 4).map((m) => `${m.tool}${m.referenced_by ? ` (used by ${m.referenced_by})` : ""}`).join(" · ")}>
      {t.ok} at your versions · {t.missing.length} missing
    </Row>
  );
}

function HostSetupRow({ h }: { h?: HostReadiness }) {
  const s = h?.setup;
  if (!s) return <Row tone="idle" label="Host setup" fix={<>Declare packages and services a repo needs in a <Code>[host]</Code> table in <Code>.codecast/workspace.toml</Code></>}>nothing declared</Row>;
  const what = [...(s.packages ?? []), ...(s.services ?? []).map((x) => `${x} (service)`)];
  if (!s.ok) {
    return (
      <Row tone="bad" label="Host setup" fix={<span className="block font-mono text-[10px] text-sol-red/80 line-clamp-3">{s.error}</span>}>
        failed{s.step ? ` at ${s.step}` : ""}{s.at ? ` · ${ago(s.at)}` : ""}
      </Row>
    );
  }
  return (
    <Row tone="ok" label="Host setup">
      in step{what.length ? `: ${what.slice(0, 6).join(", ")}${what.length > 6 ? ` +${what.length - 6}` : ""}` : ""}{s.commands ? ` · ${s.commands} command${s.commands === 1 ? "" : "s"}` : ""}{s.applied_at ? ` · ${ago(s.applied_at)}` : ""}
    </Row>
  );
}

export function CloudHostPanel({ d }: { d: Device }) {
  const { byId } = useDevices();
  const act = useInboxStore((s) => s.cloudHostAction);
  const now = useCoarseNow(d.cloud_host?.last_action?.status === "running" ? 5_000 : 60_000);
  const r = d.cloud_host;
  const h = d.host_readiness;
  if (!r && !h) return null;
  const manager = r ? byId.get(r.managed_by) : undefined;
  const laptop = manager ? deviceDisplayName(manager) : "your laptop";
  const managerOnline = !!manager?.online;
  const last = r?.last_action;
  const running = last?.status === "running" && now - last.at < ACTION_STALE_MS;
  const canAct = !!r && managerOnline && !running;
  const run = (a: CloudHostAction, imageId?: string) => act(d.device_id, a, imageId);
  const asleep = r?.state === "stopped";
  const reportOld = r && now - r.at > REPORT_STALE_MS;

  return (
    <div className="mt-3 rounded-md border border-sol-violet/25 bg-sol-violet/[0.03] px-3 py-2.5" data-cloud-host={r?.state ?? "unreported"}>
      {r && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`h-2 w-2 rounded-full ${STATE[r.state].dot}`} aria-hidden />
          <span className="text-xs font-medium text-sol-text">{STATE[r.state].word}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-sol-text-dim" title={`${r.instance_id} · ${stateLine(r)}`}>{stateLine(r)}</span>
        </div>
      )}
      {reportOld && (
        <div className="mt-1 text-[11px] text-sol-text-dim">
          As {laptop} last saw it, {relativeSeen(r!.at)}{managerOnline ? "" : `; it refreshes when ${laptop} is online`}.
        </div>
      )}

      <ul className="mt-2 space-y-1.5">
        <SetupRow h={h} laptop={laptop} />
        <LoginsRow h={h} r={r} laptop={laptop} />
        <ToolsRow h={h} />
        <HostSetupRow h={h} />
      </ul>

      {r && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {r.state !== "missing" && (
            <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={!canAct} onClick={() => run(asleep ? "wake" : "sleep")}>
              {asleep ? "Wake" : "Sleep"}
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" className="h-7 text-[11px]" disabled={!canAct || asleep} title={asleep ? "Wake it first" : "Install the repo's [host] packages and services now"} onClick={() => run("setup")}>
            Apply setup now
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 text-[11px]" disabled={!canAct || r.state === "missing"} title="Snapshot this machine so the next one starts ready" onClick={() => run("image")}>
            Save image
          </Button>
          <ActionStatus last={last} running={running} laptop={laptop} managerOnline={managerOnline} now={now} />
        </div>
      )}

      {r && r.images.length > 0 && (
        <details className="mt-2 group">
          <summary className="cursor-pointer select-none text-[11px] text-sol-text-muted hover:text-sol-text">
            {r.images.length} saved image{r.images.length === 1 ? "" : "s"} · new machines start from the newest
          </summary>
          <ul className="mt-1 space-y-1">
            {r.images.map((img, i) => (
              <li key={img.id} className="flex items-center gap-2 text-[11px]">
                <span className="min-w-0 flex-1 truncate font-mono text-sol-text-secondary" title={img.id}>{img.name}</span>
                <span className="shrink-0 text-sol-text-dim">{i === 0 ? "newest · " : ""}{ago(img.created)}</span>
                {canAct && <ConfirmButton
                  label="Delete"
                  className="text-sol-text-dim hover:text-sol-red hover:no-underline"
                  question="Deletes the image and its snapshot from AWS."
                  onConfirm={() => run("delete_image", img.id)}
                />}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ActionStatus({ last, running, laptop, managerOnline, now }: { last?: CloudHostReport["last_action"]; running: boolean; laptop: string; managerOnline: boolean; now: number }) {
  if (!managerOnline) return <span className="text-[11px] text-sol-text-dim">Actions run through {laptop}, which is offline.</span>;
  if (!last) return null;
  const [doing, did] = DOING[last.action];
  if (running) return <span className="inline-flex items-center gap-1 text-[11px] text-sol-text-muted"><Loader2 className="h-3 w-3 animate-spin" />{doing} through {laptop}…</span>;
  if (last.status === "running") return <span className="text-[11px] text-sol-yellow">{doing} got no answer from {laptop}. Try again.</span>;
  if (now - last.at > 6 * 3600_000) return null;
  if (last.status === "failed") return <span className="min-w-0 basis-full truncate text-[11px] text-sol-red" title={last.detail}>{doing} failed: {last.detail ?? "no detail"}</span>;
  return <span className="text-[11px] text-sol-text-dim">{did} {relativeSeen(last.at)}</span>;
}
