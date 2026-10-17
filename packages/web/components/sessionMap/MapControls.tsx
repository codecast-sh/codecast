"use client";
// The session map's controls: the view row on top (how the map is grouped,
// sorted, ordered and filtered) and the selection bar that rises at the foot
// when cards are selected (pile, stack, move, assign, pin, stash, open).
import type { ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown, Archive, Focus, Layers, Pin, SquareStack, UserRound, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { RoleFace } from "../org/RoleFace";
import { HAIRLINE, type MapRole } from "./sessionMapModel";

export function ToolButton({ children, icon, onClick, disabled, primary, tip, ...rest }: { children?: ReactNode; icon: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean; tip?: string } & Record<`data-${string}`, boolean | string | undefined>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={tip}
      className="pointer-events-auto flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors hover:bg-sol-bg-highlight/60 disabled:cursor-default disabled:opacity-40"
      style={{ background: primary ? "color-mix(in srgb, var(--sol-blue) 16%, var(--sol-card))" : "var(--sol-card)", borderColor: primary ? "color-mix(in srgb, var(--sol-blue) 50%, transparent)" : HAIRLINE, color: "var(--sol-text)" }}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/** One view setting as a compact menu: its name, the current choice, the options as radios. */
export function ViewMenu<T extends string>({ name, value, options, onChange, ...rest }: { name: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void } & Record<`data-${string}`, string>) {
  const label = options.find((o) => o.id === value)?.label ?? value;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="pointer-events-auto flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] hover:bg-sol-bg-highlight/60" style={{ background: "var(--sol-card)", borderColor: HAIRLINE }} {...rest}>
          <span style={{ color: "var(--sol-text-dim)" }}>{name}</span>
          <span className="font-medium" style={{ color: "var(--sol-text)" }}>{label}</span>
          <ChevronDown className="h-3 w-3" style={{ color: "var(--sol-text-dim)" }} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[180px]">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
          {options.map((o) => <DropdownMenuRadioItem key={o.id} value={o.id}>{o.label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Which agents are shown, with how many sessions each has under the other filters. */
export function AgentMenu({ agents, hidden, onToggle, onOnly }: { agents: [string, number][]; hidden: ReadonlySet<string>; onToggle: (a: string) => void; onOnly: (a: string | null) => void }) {
  const shown = agents.filter(([a]) => !hidden.has(a)).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="pointer-events-auto flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] hover:bg-sol-bg-highlight/60" style={{ background: "var(--sol-card)", borderColor: HAIRLINE }} data-map-agents>
          <span style={{ color: "var(--sol-text-dim)" }}>Agents</span>
          <span className="font-medium tabular-nums" style={{ color: "var(--sol-text)" }}>{shown === agents.length ? "All" : `${shown} of ${agents.length}`}</span>
          <ChevronDown className="h-3 w-3" style={{ color: "var(--sol-text-dim)" }} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        {agents.map(([a, n]) => (
          <DropdownMenuCheckboxItem key={a} checked={!hidden.has(a)} onCheckedChange={() => onToggle(a)} onSelect={(e) => e.preventDefault()}>
            <span className="flex-1">{a}</span>
            <span className="ml-3 tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{n}</span>
          </DropdownMenuCheckboxItem>
        ))}
        {hidden.size > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onOnly(null)}>Show all</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type SelectionActions = {
  pile: () => void;
  stack: () => void;
  moveTo: (pileId: string) => void;
  assign: (role: MapRole) => void;
  pin: () => void;
  stash: () => void;
  open: () => void;
  fit: () => void;
  clear: () => void;
};

/** The bar at the foot while cards are selected: what can be done to all of them at once. */
export function SelectionBar({ count, allPinned, piles, roles, act }: { count: number; allPinned: boolean; piles: { id: string; title: string }[]; roles: MapRole[]; act: SelectionActions }) {
  const btn = "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium hover:bg-sol-bg-highlight/70";
  return (
    <div className="pointer-events-auto absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border p-1 shadow-lg" style={{ background: "var(--sol-card)", borderColor: HAIRLINE, color: "var(--sol-text)" }} data-map-selection-bar>
      <span className="px-2.5 text-[12px] font-semibold tabular-nums" style={{ color: "var(--sol-blue)" }}>{count} selected</span>
      <span className="mx-0.5 h-5 w-px" style={{ background: HAIRLINE }} />
      <button type="button" className={btn} onClick={act.pile} data-map-act="pile"><Layers className="h-3.5 w-3.5" />Pile <KeyCap>P</KeyCap></button>
      <button type="button" className={btn} onClick={act.stack} data-map-act="stack"><SquareStack className="h-3.5 w-3.5" />Stack <KeyCap>S</KeyCap></button>
      {piles.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" className={btn} data-map-act="move">Move to <ChevronDown className="h-3 w-3" /></button></DropdownMenuTrigger>
          <DropdownMenuContent side="top" className="max-h-[320px] min-w-[200px] overflow-y-auto">
            <DropdownMenuLabel>Your piles</DropdownMenuLabel>
            {piles.map((p) => <DropdownMenuItem key={p.id} onSelect={() => act.moveTo(p.id)}>{p.title}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {roles.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" className={btn} data-map-act="assign"><UserRound className="h-3.5 w-3.5" />Assign <ChevronDown className="h-3 w-3" /></button></DropdownMenuTrigger>
          <DropdownMenuContent side="top" className="max-h-[360px] min-w-[220px] overflow-y-auto">
            <DropdownMenuLabel>Reports to role</DropdownMenuLabel>
            {roles.map((r) => (
              <DropdownMenuItem key={r.id} onSelect={() => act.assign(r)}>
                <RoleFace role={r} size={18} />
                <span className="flex-1 truncate">{r.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <button type="button" className={btn} onClick={act.pin} aria-pressed={allPinned} data-map-act="pin">{allPinned ? <Check className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}{allPinned ? "Pinned" : "Pin"}</button>
      <button type="button" className={btn} onClick={act.stash} data-map-act="stash"><Archive className="h-3.5 w-3.5" />Stash</button>
      {count === 1 && <button type="button" className={btn} onClick={act.open} data-map-act="open"><ArrowUpRight className="h-3.5 w-3.5" />Open</button>}
      <button type="button" className={btn} onClick={act.fit} data-map-act="fit"><Focus className="h-3.5 w-3.5" />Zoom to <KeyCap>F</KeyCap></button>
      <span className="mx-0.5 h-5 w-px" style={{ background: HAIRLINE }} />
      <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-sol-bg-highlight/70" onClick={act.clear} aria-label="Clear selection" title="Clear selection (Esc)" data-map-act="clear"><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}
