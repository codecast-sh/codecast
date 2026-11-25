"use client";
// /goals and /projects: the document (written and arranged in place) or the
// timeline (the same goals and projects in time, Roadmap); on /goals also the
// numbers (GoalsMetrics: every goal's numbers over time against their targets).
// The view is in the address (?view=timeline, ?view=metrics), so a link opens
// on the one it was copied from.
import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChartGantt, ChartLine, FileText } from "lucide-react";
import { SegmentedToggle } from "../SegmentedToggle";
import { Roadmap, type RoadmapScope } from "./Roadmap";
import { GoalsMetrics } from "../goals/GoalsMetrics";

export function PlanningScreen({ scope, base, children }: { scope: RoadmapScope; base: string; children: ReactNode }) {
  const router = useRouter();
  const search = useSearchParams();
  const asked = search.get("view");
  const view = asked === "timeline" || (asked === "metrics" && scope === "goals") ? asked : "document";
  const setView = (next: string) => {
    const p = new URLSearchParams(search.toString());
    p.delete("range");
    if (next === "document") p.delete("view"); else p.set("view", next);
    const qs = p.toString();
    router.replace(qs ? `${base}?${qs}` : base);
  };
  const switcher = (
    <SegmentedToggle size="sm" value={view} onChange={setView} items={[{ key: "document", label: "Document", icon: FileText }, { key: "timeline", label: "Timeline", icon: ChartGantt }, ...(scope === "goals" ? [{ key: "metrics", label: "Metrics", icon: ChartLine }] : [])]} />
  );
  if (view === "timeline") return <Roadmap scope={scope} switcher={switcher} />;
  return (
    <div className="relative h-full">
      {view === "metrics" ? <GoalsMetrics /> : children}
      <div className="absolute right-6 top-4 z-10" data-planning-switch>{switcher}</div>
    </div>
  );
}
