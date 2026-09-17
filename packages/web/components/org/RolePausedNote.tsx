"use client";
// A paused role reads its lines when someone resumes it (orgWakes gate 1).
// The one note every conversation with a paused role shows above its
// composer: the proposal thread and the scope page say it with these words.
import { Pause, Play } from "lucide-react";
import { cn } from "../../lib/utils";
import { OrgButton } from "./OrgButton";

export function RolePausedNote({ name, onResume, className }: { name: string; onResume?: () => void; className?: string }) {
  return (
    <div className={cn("shrink-0 rounded-lg border px-3 py-2 flex items-center gap-2 text-[12px]", className)} data-chief-paused style={{ borderColor: "color-mix(in srgb, var(--sol-yellow) 45%, transparent)", background: "color-mix(in srgb, var(--sol-yellow) 8%, transparent)", color: "var(--sol-text-secondary)" }}>
      <Pause className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--sol-yellow)" }} />
      <span className="min-w-0 flex-1">{name} is paused: what you send waits until you resume it.</span>
      {onResume && <OrgButton size="sm" onClick={onResume}><Play className="w-3 h-3" /> Resume</OrgButton>}
    </div>
  );
}
