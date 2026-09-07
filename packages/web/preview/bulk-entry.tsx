// Preview of the inbox multi-selection surfaces over fixture data: the
// selection bar with its "Move to…" menu open, and the right-click menu on a
// multi-selection. `?view=menu` shows the latter; default is the bar.
import "../app/globals.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { CTX_SURFACE } from "../components/ui/context-menu";
import { BulkSessionMenuItems, InboxSelectionBar, MoveToDeviceItems } from "../components/BulkMoveSessions";
import { candidates } from "./mocks/fixtures";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.add(params.get("theme") === "light" ? "light" : "dark");
const view = params.get("view") ?? "bar";
const sessions = candidates.slice(0, 4).map((c) => ({ ...c, has_pending: c.has_pending_messages }));

function Card({ title, id, selected }: { title: string; id: string; selected?: boolean }) {
  return (
    <div className={`relative border-b border-sol-border/30 px-3 py-2 ${selected ? "ring-1 ring-inset ring-sol-cyan/60 bg-sol-cyan/[0.08]" : "hover:bg-sol-bg-alt/80"}`}>
      {selected && <span className="pointer-events-none absolute right-1.5 top-1.5 z-10 text-sol-cyan">✓</span>}
      <div className="text-sm text-sol-text truncate pr-5">{title}</div>
      <div className="text-[11px] text-sol-text-muted font-mono">{id}</div>
    </div>
  );
}

function App() {
  return (
    <div className="min-h-screen bg-sol-bg text-sol-text p-6">
      <div className="w-[380px] rounded-lg border border-sol-border bg-sol-bg-alt overflow-hidden">
        <InboxSelectionBar sessions={sessions} onStash={() => {}} onKill={() => {}} onClear={() => {}} />
        <div className="px-3 py-1.5 text-[11px] uppercase tracking-wider text-sol-text-dim">Working</div>
        {candidates.slice(0, 7).map((c, i) => (
          <Card key={c._id} title={c.title ?? c.short_id ?? c._id} id={c.short_id ?? c._id} selected={i < 4} />
        ))}
      </div>
      <div className="mt-4">
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger asChild><span className="inline-block h-px w-px" /></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={CTX_SURFACE}>
            {view === "menu" ? <BulkSessionMenuItems sessions={sessions as any} onStash={() => {}} onKill={() => {}} onClear={() => {}} /> : <MoveToDeviceItems sessions={sessions} />}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
