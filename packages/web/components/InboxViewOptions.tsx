import { Activity, Archive, ChevronsDownUp, CircleCheck, EyeOff, Layers, List, Rows3, SlidersHorizontal, Star, Users, type LucideIcon } from "lucide-react";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

import { resolveCardBars, type CardBarsMode } from "../lib/uiPrefDefaults";
import { resolveSubagentFilter, resolveSubagentRows, type SubagentFilter, type SubagentRowsMode } from "../store/inboxStore";
export type { CardBarsMode };

const SUBAGENT_ROWS: { value: SubagentRowsMode; label: string; icon: LucideIcon }[] = [
  { value: "folded", label: "One line", icon: ChevronsDownUp },
  { value: "compact", label: "A short row each", icon: List },
  { value: "full", label: "A card each", icon: Rows3 },
  { value: "hidden", label: "Hidden", icon: EyeOff },
];

const SUBAGENT_FILTERS: { value: SubagentFilter; label: string; icon: LucideIcon }[] = [
  { value: "active", label: "Working or waiting", icon: Activity },
  { value: "active_done", label: "Also done", icon: CircleCheck },
  { value: "all", label: "All", icon: Layers },
];

const CARD_BARS: { value: CardBarsMode; label: string; icon: LucideIcon }[] = [
  { value: "strip", label: "One line", icon: ChevronsDownUp },
  { value: "full", label: "A row each", icon: Rows3 },
  { value: "hidden", label: "Hidden", icon: EyeOff },
];

/** One menu row: icon, label, and an optional count at the right edge. */
function OptionLabel({ icon: Icon, label, count }: { icon: LucideIcon; label: string; count?: number }) {
  return (
    <span className="flex flex-1 items-center gap-2">
      <Icon className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" />
      <span className="flex-1">{label}</span>
      {count !== undefined && <span className="tabular-nums text-sol-text-dim">{count}</span>}
    </span>
  );
}

// How the session rail shows its list, behind one button at the end of the
// rail header: whose sessions (mine or the team's), which extra rows
// (subagents, old sessions), how the bars under cards draw, and the favorites
// shelf. An option appears only when it would change something. The button
// carries a dot while any of them is away from its default, so a narrowed or
// widened list never looks like the plain inbox.
export function InboxViewOptions(props: {
  showTeam: boolean;
  teamScope: boolean;
  onTeamScope: (on: boolean) => void;
  subagentCount: number;
  subagentRows: SubagentRowsMode;
  onSubagentRows: (value: SubagentRowsMode) => void;
  subagentFilter: SubagentFilter;
  onSubagentFilter: (value: SubagentFilter) => void;
  oldCount: number;
  showOld: boolean;
  onShowOld: (on: boolean) => void;
  showCardBars: boolean;
  cardBars: CardBarsMode;
  onCardBars: (value: CardBarsMode) => void;
  showFavorites: boolean;
  favorites: boolean;
  onFavorites: (on: boolean) => void;
}) {
  const p = props;
  const hasList = p.showTeam || p.oldCount > 0;
  const showSubagentRows = p.subagentCount > 0;
  if (!hasList && !showSubagentRows && !p.showCardBars && !p.showFavorites) return null;
  const changed =
    (p.showTeam && p.teamScope) ||
    // Against the one default rule (the resolvers'), not a literal.
    (showSubagentRows && (p.subagentRows !== resolveSubagentRows({}) || p.subagentFilter !== resolveSubagentFilter({}))) ||
    (p.oldCount > 0 && p.showOld) ||
    // Against the one default rule (resolveCardBars), not a literal.
    (p.showCardBars && p.cardBars !== resolveCardBars({}));
  return (
    <DropdownMenu>
      <ShortcutTooltip label="View options" side="bottom">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-sv-view-options
            aria-label="View options"
            className="cc-panel__btn relative text-sol-text-dim/80 hover:text-sol-text data-[state=open]:text-sol-text data-[state=open]:bg-sol-text/[0.06]"
          >
            <SlidersHorizontal className="w-3 h-3" />
            {changed && <span aria-hidden className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-sol-cyan ring-1 ring-sol-bg-alt" />}
          </button>
        </DropdownMenuTrigger>
      </ShortcutTooltip>
      <DropdownMenuContent align="end" className="w-52 text-xs">
        {hasList && <DropdownMenuLabel className="text-mark uppercase tracking-wide text-sol-text-dim">Show</DropdownMenuLabel>}
        {p.showTeam && (
          <DropdownMenuCheckboxItem checked={p.teamScope} onCheckedChange={(on) => p.onTeamScope(!!on)} onSelect={(e) => e.preventDefault()}>
            <OptionLabel icon={Users} label="Team's sessions" />
          </DropdownMenuCheckboxItem>
        )}
        {p.oldCount > 0 && (
          <DropdownMenuCheckboxItem checked={p.showOld} onCheckedChange={(on) => p.onShowOld(!!on)} onSelect={(e) => e.preventDefault()}>
            <OptionLabel icon={Archive} label="Old sessions" count={p.oldCount} />
          </DropdownMenuCheckboxItem>
        )}
        {showSubagentRows && (
          <>
            {hasList && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="flex text-mark uppercase tracking-wide text-sol-text-dim"><span className="flex-1">Subagents on cards</span><span className="tabular-nums normal-case">{p.subagentCount}</span></DropdownMenuLabel>
            <DropdownMenuRadioGroup value={p.subagentRows} onValueChange={(v) => p.onSubagentRows(v as SubagentRowsMode)}>
              {SUBAGENT_ROWS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value} onSelect={(e) => e.preventDefault()}>
                  <OptionLabel icon={option.icon} label={option.label} />
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {p.subagentRows !== "hidden" && (
              <>
                <DropdownMenuLabel data-sv-subagent-filter-label className="pt-1 pb-0.5 text-meta font-normal text-sol-text-dim">Which ones</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={p.subagentFilter} onValueChange={(v) => p.onSubagentFilter(v as SubagentFilter)}>
                  {SUBAGENT_FILTERS.map((option) => (
                    <DropdownMenuRadioItem key={option.value} value={option.value} onSelect={(e) => e.preventDefault()}>
                      <OptionLabel icon={option.icon} label={option.label} />
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </>
            )}
          </>
        )}
        {p.showCardBars && (
          <>
            {(hasList || showSubagentRows) && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-mark uppercase tracking-wide text-sol-text-dim">Triggers and runs on cards</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={p.cardBars} onValueChange={(v) => p.onCardBars(v as CardBarsMode)}>
              {CARD_BARS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value} onSelect={(e) => e.preventDefault()}>
                  <OptionLabel icon={option.icon} label={option.label} />
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        {p.showFavorites && (
          <>
            {(hasList || showSubagentRows || p.showCardBars) && <DropdownMenuSeparator />}
            <DropdownMenuCheckboxItem checked={p.favorites} onCheckedChange={(on) => p.onFavorites(!!on)}>
              <OptionLabel icon={Star} label="Favorites only" />
            </DropdownMenuCheckboxItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
