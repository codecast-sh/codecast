"use client";

// The top bar's machine gauge: a quiet vital sign for the laptops you run
// sessions on. It sits muted while they are fine and takes a tone only when
// one is genuinely struggling (critical memory pressure, or an incident that
// has outlasted a build or a test run). Hovering it shows the vitals and the
// sessions doing the work; clicking it opens Resources. It never interrupts.
import { useContext, useMemo } from "react";
import { Gauge } from "lucide-react";
import { useRouter } from "next/navigation";
import { sustainedResourcePressure, type ResourceIncident, type ResourcePoint, type ResourcePressure } from "@codecast/shared/contracts";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { joinMachines, toResourceSession, useMachineResourceRows } from "../../hooks/useResourceMonitor";
import { useManagedSessions } from "../../hooks/useSyncManagedSessions";
import { useOpenSession } from "../../hooks/useOpenSession";
import { HoverCardClose } from "../../lib/hoverCardsOff";
import { cn } from "../../lib/utils";
import { useDevices } from "../DeviceBadge";
import { TopbarButton } from "../TopbarButton";
import { HoverCard } from "../ui/HoverCard";
import { MiniTrace } from "./HealthStrip";
import { attribute, fmtAgo, fmtBytes, fmtCpu, freshness, memoryUsedPct } from "./resourceModel";
import type { ResourceMachine } from "./types";

// The Resources page shows every incident; the gauge takes a tone only for
// critical pressure or an incident that has lasted this long.
const TONE_AFTER_MS = 10 * 60_000;
// How far back the card's traces reach.
const TRACE_MS = 30 * 60_000;

export type Level = "calm" | "elevated" | "critical";

export function levelOf(incident: ResourceIncident | null, now: number): Level {
  if (!incident) return "calm";
  if (incident.level === "critical") return "critical";
  return now - incident.since >= TONE_AFTER_MS ? "elevated" : "calm";
}

const RANK: Record<Level, number> = { calm: 0, elevated: 1, critical: 2 };
const TONE: Record<Level, string> = { calm: "", elevated: "text-sol-yellow", critical: "text-sol-red" };
const DOT: Record<Level, string> = { calm: "", elevated: "bg-sol-yellow", critical: "bg-sol-red" };

type Watched = { machine: ResourceMachine; incident: ResourceIncident | null; level: Level };

/** The local machine to show: the one in the worst state among those reporting live. */
function useWatchedMachine(now: number): Watched | null {
  const rows = useMachineResourceRows();
  const { devices } = useDevices();
  return useMemo(() => {
    let best: Watched | null = null;
    for (const machine of joinMachines(devices, rows)) {
      if (machine.role !== "local" || freshness(machine, now) !== "live") continue;
      const incident = sustainedResourcePressure(machine.history, now);
      const level = levelOf(incident, now);
      if (!best || RANK[level] > RANK[best.level]) best = { machine, incident, level };
    }
    return best;
  }, [devices, rows, now]);
}

export function ResourcePressureGauge() {
  const now = useCoarseNow(30_000);
  const router = useRouter();
  const watched = useWatchedMachine(now);
  if (!watched) return null;
  const { machine, incident, level } = watched;
  const label = level === "calm" ? `${machine.name}: resources` : `${machine.name}: ${incident!.reason.toLowerCase()}`;
  return (
    <HoverCard side="bottom" align="end" className="w-[360px]" focusable card={<GaugeCard watched={watched} now={now} />}>
      <TopbarButton onClick={() => router.push("/resources")} aria-label={label} className={cn(level !== "calm" && TONE[level])}>
        <Gauge />
        {level !== "calm" && (
          <span aria-hidden className={cn("absolute right-0.5 top-0.5 h-2 w-2 rounded-full ring-2 ring-sol-bg", DOT[level], level === "critical" && "motion-safe:animate-pulse")} />
        )}
      </TopbarButton>
    </HoverCard>
  );
}

const PRESSURE_RANK: Record<ResourcePressure, number | undefined> = { normal: 0, elevated: 1, critical: 2, unknown: undefined };

function GaugeCard({ watched: { machine, incident, level }, now }: { watched: Watched; now: number }) {
  const snap = machine.snapshot!;
  const sample = snap.sample;
  const points = machine.history.filter((p) => p.at >= now - TRACE_MS);
  const memPct = memoryUsedPct(sample);
  const status = incident
    ? `${incident.reason} for ${fmtAgo(incident.since, now).replace(" ago", "")}`
    : "Running normally";
  return (
    <div className="p-3 text-sol-text">
      <div className="flex items-baseline gap-2">
        <span className="truncate text-[13px] font-semibold">{machine.name}</span>
        <span className="ml-auto shrink-0 text-[10.5px] text-sol-text-dim">
          {sample.logicalCpus} cores · {fmtBytes(sample.memoryTotal)}
        </span>
      </div>
      <div className={cn("mt-0.5 text-[11.5px]", level === "calm" ? "text-sol-text-muted" : TONE[level])}>{status}</div>

      <div className="mt-2.5 grid grid-cols-3 gap-1.5">
        <Vital label="CPU" value={sample.cpuPercent === undefined ? "n/a" : `${sample.cpuPercent.toFixed(0)}%`} hot={(sample.cpuPercent ?? 0) >= 90}
          trace={<MiniTrace points={points} f={(p: ResourcePoint) => p.cpuPercent} max={100} className="h-[18px] w-full text-sol-blue" />} />
        <Vital label="Memory" value={memPct === undefined ? "n/a" : `${memPct.toFixed(0)}%`} hot={sample.pressure === "critical"}
          trace={<MiniTrace points={points} f={memoryUsedPct} max={100} className="h-[18px] w-full text-sol-violet" />} />
        <Vital label="Pressure" value={sample.pressure} hot={sample.pressure === "critical" || sample.pressure === "elevated"}
          trace={<MiniTrace points={points} f={(p: ResourcePoint) => PRESSURE_RANK[p.pressure]} max={2} className="h-[18px] w-full text-sol-cyan" />} />
      </div>

      <TopUsers machine={machine} level={level} />

      <ResourcesLink />
    </div>
  );
}

function Vital({ label, value, hot, trace }: { label: string; value: string; hot: boolean; trace: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-md bg-sol-bg-alt px-2 pb-1 pt-1.5">
      <div className="text-[10px] text-sol-text-dim">{label}</div>
      <div className={cn("text-[13px] font-semibold tabular-nums", hot && "text-sol-red")}>{value}</div>
      <div className="mt-0.5">{trace}</div>
    </div>
  );
}

/** The sessions using the machine most, by CPU, with whatever no session owns as one row. */
function TopUsers({ machine, level }: { machine: ResourceMachine; level: Level }) {
  const { sessions } = useManagedSessions();
  const openSession = useOpenSession();
  const close = useContext(HoverCardClose);
  const rows = useMemo(() => {
    const byId = new Map(sessions.map((m) => [m.session_id, toResourceSession(m, false)]));
    const attributed = attribute(machine.deviceId, machine.snapshot!);
    const named = attributed
      .filter((r) => r.type === "session" && r.sessionId)
      .map((r) => {
        const s = byId.get(r.sessionId!);
        return { key: r.key, title: s?.title ?? `Session ${r.sessionId!.slice(0, 7)}`, conversationId: s?.conversationId, usage: r.usage };
      })
      .sort((a, b) => b.usage.cpu - a.usage.cpu)
      .slice(0, 3);
    const other = attributed.filter((r) => r.type !== "session").reduce((u, r) => ({ cpu: u.cpu + r.usage.cpu, rss: u.rss + r.usage.rss }), { cpu: 0, rss: 0 });
    return other.cpu > 0 || other.rss > 0
      ? [...named, { key: "other", title: "Everything else", conversationId: undefined, usage: other }]
      : named;
  }, [sessions, machine]);
  if (rows.length === 0) return null;
  const max = Math.max(1, ...rows.map((r) => r.usage.cpu));
  const bar = level === "critical" ? "bg-sol-red" : level === "elevated" ? "bg-sol-yellow" : "bg-sol-blue";
  return (
    <div className="mt-3">
      <div className="mb-1 text-[10px] text-sol-text-dim">Using it most</div>
      {rows.map((r) => {
        const body = (
          <>
            <div className="min-w-0">
              <div className="truncate text-[11.5px]">{r.title}</div>
              <div className="mt-1 h-[3px] rounded-full bg-sol-bg-highlight">
                <div className={cn("h-full rounded-full", bar)} style={{ width: `${(r.usage.cpu / max) * 100}%` }} />
              </div>
            </div>
            <span className="text-right text-[11px] tabular-nums text-sol-text-muted">{fmtCpu(r.usage.cpu)}</span>
            <span className="text-right text-[11px] tabular-nums text-sol-text-muted">{fmtBytes(r.usage.rss)}</span>
          </>
        );
        const grid = "grid w-full grid-cols-[1fr_64px_56px] items-center gap-2 rounded px-1.5 py-1 text-left";
        return r.conversationId ? (
          <button key={r.key} type="button" className={cn(grid, "hover:bg-sol-bg-alt")} onClick={() => { close?.(); openSession(r.conversationId!); }}>
            {body}
          </button>
        ) : (
          <div key={r.key} className={grid}>{body}</div>
        );
      })}
    </div>
  );
}

function ResourcesLink() {
  const router = useRouter();
  const close = useContext(HoverCardClose);
  return (
    <div className="mt-2.5 flex border-t border-sol-border/30 pt-2.5">
      <button
        type="button"
        onClick={() => { close?.(); router.push("/resources"); }}
        className="h-7 rounded-md border border-sol-border/50 px-2.5 text-[11.5px] text-sol-text hover:bg-sol-bg-alt"
      >
        Open Resources
      </button>
    </div>
  );
}
