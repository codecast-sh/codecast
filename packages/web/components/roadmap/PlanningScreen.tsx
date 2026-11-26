"use client";
// /goals and /projects: the document (written and arranged in place) or the
// timeline (the same goals and projects in time, Roadmap). The view is in the
// address (?view=timeline), so a link opens on the one it was copied from.
import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChartGantt, FileText } from "lucide-react";
import { SegmentedToggle } from "../SegmentedToggle";
import { Roadmap, type RoadmapScope } from "./Roadmap";

export function PlanningScreen({ scope, base, children }: { scope: RoadmapScope; base: string; children: ReactNode }) {
  const router = useRouter();
  const search = useSearchParams();
  const view = search.get("view") === "timeline" ? "timeline" : "document";
  const setView = (next: string) => {
    const p = new URLSearchParams(search.toString());
    if (next === "timeline") p.set("view", "timeline"); else p.delete("view");
    const qs = p.toString();
    router.replace(qs ? `${base}?${qs}` : base);
  };
  const switcher = (
    <SegmentedToggle size="sm" value={view} onChange={setView} items={[{ key: "document", label: "Document", icon: FileText }, { key: "timeline", label: "Timeline", icon: ChartGantt }]} />
  );
  if (view === "timeline") return <Roadmap scope={scope} switcher={switcher} />;
  return (
    <div className="relative h-full">
      {children}
      <div className="absolute right-6 top-4 z-10" data-planning-switch>{switcher}</div>
    </div>
  );
}
