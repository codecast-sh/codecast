import { SlidersHorizontal } from "lucide-react";
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

export type CardBarsMode = "strip" | "full" | "hidden";

const CARD_BARS: { value: CardBarsMode; label: string }[] = [
  { value: "strip", label: "Folded" },
  { value: "full", label: "Full rows" },
  { value: "hidden", label: "Hidden" },
];

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
  showSubagents: boolean;
  onShowSubagents: (on: boolean) => void;
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
  const hasList = p.showTeam || p.subagentCount > 0 || p.oldCount > 0;
  if (!hasList && !p.showCardBars && !p.showFavorites) return null;
  const changed =
    (p.showTeam && p.teamScope) ||
    (p.subagentCount > 0 && p.showSubagents) ||
    (p.oldCount > 0 && p.showOld) ||
    (p.showCardBars && p.cardBars !== "strip");
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
        {hasList && <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">Show</DropdownMenuLabel>}
        {p.showTeam && (
          <DropdownMenuCheckboxItem checked={p.teamScope} onCheckedChange={(on) => p.onTeamScope(!!on)} onSelect={(e) => e.preventDefault()}>
            Team's sessions
          </DropdownMenuCheckboxItem>
        )}
        {p.subagentCount > 0 && (
          <DropdownMenuCheckboxItem checked={p.showSubagents} onCheckedChange={(on) => p.onShowSubagents(!!on)} onSelect={(e) => e.preventDefault()}>
            <span className="flex-1">Subagents</span>
            <span className="tabular-nums text-sol-text-dim">{p.subagentCount}</span>
          </DropdownMenuCheckboxItem>
        )}
        {p.oldCount > 0 && (
          <DropdownMenuCheckboxItem checked={p.showOld} onCheckedChange={(on) => p.onShowOld(!!on)} onSelect={(e) => e.preventDefault()}>
            <span className="flex-1">Old sessions</span>
            <span className="tabular-nums text-sol-text-dim">{p.oldCount}</span>
          </DropdownMenuCheckboxItem>
        )}
        {p.showCardBars && (
          <>
            {hasList && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">Triggers and tasks on cards</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={p.cardBars} onValueChange={(v) => p.onCardBars(v as CardBarsMode)}>
              {CARD_BARS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value} onSelect={(e) => e.preventDefault()}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        {p.showFavorites && (
          <>
            {(hasList || p.showCardBars) && <DropdownMenuSeparator />}
            <DropdownMenuCheckboxItem checked={p.favorites} onCheckedChange={(on) => p.onFavorites(!!on)}>
              Favorites only
            </DropdownMenuCheckboxItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
