// The floating format bar at the bottom of the grid: font size, bold /
// italic / underline, alignment, text and fill color, borders, number
// formats and decimals, conditional color, table style, more actions, and
// Ask agent on the selection. Every control shows the active cell's state.
import { AskButton } from "../live/AskAgentControl";
import { useAskDraft, useClaimAsk } from "../live/askAgent";
import { SHEET_ASK_SLOT } from "./askSlot";
import { useRef, useState, type ReactNode } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownAZ,
  ArrowUpAZ,
  Bold,
  Bot,
  ChevronDown,
  Eraser,
  Filter,
  Grid2x2,
  Italic,
  MoreHorizontal,
  PaintBucket,
  Palette,
  Pin,
  Send,
  Square,
  SquareDashed,
  Table2,
  Type,
  Underline,
  WrapText,
} from "lucide-react";
import { PALETTE, type CellStyle, type PaletteColor } from "@codecast/shared/artifacts/sheets";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { KeyCap } from "../KeyCap";
import { isMac } from "../../shortcuts/registry";
import { solVar, tint } from "./cellPaint";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";

export type FormatAction =
  | { type: "style"; patch: Record<string, unknown> }
  | { type: "toggle"; field: "b" | "i" | "u" | "wrap" | "sign" }
  | { type: "decimals"; delta: 1 | -1 }
  | { type: "border"; mode: "all" | "outer" | "bottom" | "none" }
  | { type: "cond"; rule: "sign" | "scale" | "clear"; color?: PaletteColor }
  | { type: "table"; color: PaletteColor | null }
  | { type: "sort"; desc: boolean }
  | { type: "filter" }
  | { type: "freeze"; axis: "row" | "col" | "none" }
  | { type: "insert"; axis: "row" | "col"; after: boolean }
  | { type: "delete"; axis: "row" | "col" }
  | { type: "clearFormat" };

const SIZES = [10, 11, 12, 13, 14, 16, 18, 20, 24, 28];
const MENU = "min-w-[180px] p-1 rounded-xl border border-sol-border/50 bg-sol-card/95 backdrop-blur-md shadow-xl text-sol-text";
const ITEM = "text-[13px] rounded-lg px-2.5 py-1.5 gap-2.5 text-sol-text-secondary focus:bg-sol-cyan/10 focus:text-sol-text";

/** A bar button; its hover tip names it and shows the shortcut as keycaps. */
function Btn({ on, title, onClick, children, wide, shortcut }: { on?: boolean; title: string; onClick?: () => void; children: ReactNode; wide?: boolean; shortcut?: string[] }) {
  return (
    <button
      type="button"
      aria-label={title}
      aria-pressed={on}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`sheet-fbtn ${on ? "is-on" : ""} ${wide ? "is-wide" : ""}`}
    >
      {children}
      <span className="sheet-tip" role="tooltip">
        {title}
        {shortcut?.map((k) => <KeyCap key={k} size="xs">{k}</KeyCap>)}
      </span>
    </button>
  );
}

function Menu({ trigger, title, children, on }: { trigger: ReactNode; title: string; children: ReactNode; on?: boolean }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" title={title} aria-label={title} className={`sheet-fbtn is-menu ${on ? "is-on" : ""}`} onMouseDown={(e) => e.preventDefault()}>
          {trigger}
          <ChevronDown className="w-3 h-3 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" sideOffset={8} className={MENU} onCloseAutoFocus={(e) => e.preventDefault()}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Swatches({ value, onPick, fill }: { value?: PaletteColor; onPick: (c: PaletteColor | null) => void; fill?: boolean }) {
  return (
    <div className="sheet-swatches">
      <button type="button" title="None" aria-label="No color" className={`sheet-swatch is-none ${!value ? "is-on" : ""}`} onClick={() => onPick(null)} />
      {PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          title={c}
          aria-label={c}
          className={`sheet-swatch ${value === c ? "is-on" : ""}`}
          style={{ background: fill ? tint(c, 45) : solVar(c) }}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  );
}

function ColorMenu({ title, icon, value, fill, onPick }: { title: string; icon: ReactNode; value?: PaletteColor; fill?: boolean; onPick: (c: PaletteColor | null) => void }) {
  return (
    <Menu
      title={title}
      on={!!value}
      trigger={
        <span className="sheet-color-icon">
          {icon}
          <span className="sheet-color-bar" style={{ background: value ? (fill ? tint(value, 70) : solVar(value)) : "var(--sol-border)" }} />
        </span>
      }
    >
      <Swatches value={value} fill={fill} onPick={onPick} />
    </Menu>
  );
}

const NUMBER_FORMATS: Array<{ nf: CellStyle["nf"] | null; label: string; sample: string }> = [
  { nf: null, label: "Automatic", sample: "1234.5" },
  { nf: "number", label: "Number", sample: "1,234.50" },
  { nf: "percent", label: "Percent", sample: "12.5%" },
  { nf: "currency", label: "Currency", sample: "$1,234.50" },
  { nf: "date", label: "Date", sample: "2026-11-10" },
  { nf: "datetime", label: "Date time", sample: "2026-11-10 09:30" },
  { nf: "text", label: "Plain text", sample: "1234.5" },
  { nf: "check", label: "Checkbox", sample: "☑" },
];

export function FormatBar({
  docId,
  style,
  onAction,
  readOnly,
  selectionLabel,
  tabName,
  autoAsk,
  onAsk,
}: {
  docId: string;
  style: CellStyle;
  onAction: (a: FormatAction) => void;
  readOnly: boolean;
  /** The selected range, "B2:F7". */
  selectionLabel: string;
  tabName: string;
  /** An empty tab opens the ask prompt: the first move on a blank sheet is usually asking an agent. */
  autoAsk?: boolean;
  onAsk: (prompt: string, target: "new" | "pick") => void;
}) {
  const [asking, setAsking] = useState(!!autoAsk);
  // This bar is the page's Ask: the shell's header button steps aside.
  useClaimAsk();
  useWatchEffect(() => { if (autoAsk) setAsking(true); }, [autoAsk]);
  const barRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useMountEffect(() => {
    // Below ~760px of room the rarer controls fold into More.
    const host = barRef.current?.parentElement;
    if (!host) return;
    const ro = new ResizeObserver(() => setCompact(host.clientWidth < 760));
    ro.observe(host);
    return () => ro.disconnect();
  });
  const { text: prompt, setText: setPrompt } = useAskDraft(docId, SHEET_ASK_SLOT, () => setAsking(true));
  const mod = isMac ? "⌘" : "Ctrl";
  if (readOnly) return null;
  const set = (patch: Record<string, unknown>) => onAction({ type: "style", patch });
  const AlignIcon = style.al === "center" ? AlignCenter : style.al === "right" ? AlignRight : AlignLeft;
  const nfLabel = style.nf === "percent" ? "%" : style.nf === "currency" ? "$" : style.nf === "date" || style.nf === "datetime" ? "Date" : style.nf === "number" ? "1,0" : "123";

  return (
    <div ref={barRef} className="sheet-formatbar" data-sheet-formatbar onMouseDown={(e) => e.stopPropagation()}>
      {asking ? (
        <div className="sheet-ask">
          <Bot className="w-4 h-4 text-sol-violet shrink-0" />
          <span className="sheet-ask-scope">{autoAsk ? tabName : `${tabName}!${selectionLabel}`}</span>
          <input
            autoFocus
            data-sheet-ask-input
            value={prompt}
            placeholder={autoAsk ? "What should this sheet track or model?" : "Describe a change"}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setAsking(false);
              if (e.key === "Enter" && prompt.trim()) {
                e.preventDefault();
                onAsk(prompt.trim(), e.metaKey || e.ctrlKey ? "pick" : "new");
                setAsking(false);
              }
            }}
          />
          <button type="button" className="sheet-ask-alt" disabled={!prompt.trim()} onClick={() => { onAsk(prompt.trim(), "pick"); setAsking(false); }}>
            Session… <KeyCap size="xs">{mod}</KeyCap><KeyCap size="xs">↵</KeyCap>
          </button>
          <button type="button" className="sheet-ask-send" disabled={!prompt.trim()} onClick={() => { onAsk(prompt.trim(), "new"); setAsking(false); }}>
            <Send className="w-3 h-3" /> New agent
          </button>
        </div>
      ) : (
        <>
          {!compact && <Menu title="Font size" trigger={<span className="sheet-fsize">{style.fs ?? 13}</span>}>
            {SIZES.map((s) => (
              <DropdownMenuItem key={s} className={ITEM} onSelect={() => set({ fs: s === 13 ? null : s })}>
                <span style={{ fontSize: Math.min(s, 18) }}>{s}</span>
              </DropdownMenuItem>
            ))}
          </Menu>}
          {!compact && <span className="sheet-fsep" />}
          <Btn title="Bold" shortcut={[mod, "B"]} on={!!style.b} onClick={() => onAction({ type: "toggle", field: "b" })}><Bold className="w-4 h-4" /></Btn>
          <Btn title="Italic" shortcut={[mod, "I"]} on={!!style.i} onClick={() => onAction({ type: "toggle", field: "i" })}><Italic className="w-4 h-4" /></Btn>
          <Btn title="Underline" shortcut={[mod, "U"]} on={!!style.u} onClick={() => onAction({ type: "toggle", field: "u" })}><Underline className="w-4 h-4" /></Btn>
          <Menu title="Align" trigger={<AlignIcon className="w-4 h-4" />}>
            <DropdownMenuItem className={ITEM} onSelect={() => set({ al: "left" })}><AlignLeft className="w-4 h-4" /> Left</DropdownMenuItem>
            <DropdownMenuItem className={ITEM} onSelect={() => set({ al: "center" })}><AlignCenter className="w-4 h-4" /> Center</DropdownMenuItem>
            <DropdownMenuItem className={ITEM} onSelect={() => set({ al: "right" })}><AlignRight className="w-4 h-4" /> Right</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "toggle", field: "wrap" })}><WrapText className="w-4 h-4" /> {style.wrap ? "Don't wrap" : "Wrap text"}</DropdownMenuItem>
          </Menu>
          <span className="sheet-fsep" />
          <ColorMenu title="Text color" icon={<Type className="w-4 h-4" />} value={style.color} onPick={(c) => set({ color: c })} />
          <ColorMenu title="Fill color" icon={<PaintBucket className="w-4 h-4" />} value={style.fill} fill onPick={(c) => set({ fill: c })} />
          {!compact && <Menu title="Borders" trigger={<Grid2x2 className="w-4 h-4" />}>
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "border", mode: "all" })}><Grid2x2 className="w-4 h-4" /> All borders</DropdownMenuItem>
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "border", mode: "outer" })}><Square className="w-4 h-4" /> Outline</DropdownMenuItem>
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "border", mode: "bottom" })}><span className="w-4 h-4 border-b-2 border-current" /> Bottom</DropdownMenuItem>
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "border", mode: "none" })}><SquareDashed className="w-4 h-4" /> No borders</DropdownMenuItem>
          </Menu>}
          <span className="sheet-fsep" />
          <Menu title="Number format" on={!!style.nf} trigger={<span className="sheet-nf">{nfLabel}</span>}>
            {NUMBER_FORMATS.map((f) => (
              <DropdownMenuItem key={f.label} className={ITEM} onSelect={() => set({ nf: f.nf })}>
                <span className={`flex-1 ${style.nf === f.nf || (!style.nf && !f.nf) ? "text-sol-text font-medium" : ""}`}>{f.label}</span>
                <span className="text-sol-text-dim tabular-nums">{f.sample}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "toggle", field: "sign" })}>
              <span className="flex-1">{style.sign ? "Hide + sign" : "Show + on gains"}</span>
              <span className="text-sol-text-dim">+10%</span>
            </DropdownMenuItem>
          </Menu>
          <Btn title="Fewer decimals" onClick={() => onAction({ type: "decimals", delta: -1 })}><span className="sheet-dec">.0</span></Btn>
          <Btn title="More decimals" onClick={() => onAction({ type: "decimals", delta: 1 })}><span className="sheet-dec">.00</span></Btn>
          <span className="sheet-fsep" />
          <Menu title="Conditional color" trigger={<Palette className="w-4 h-4" />}>
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "cond", rule: "sign" })}>
              <span className="flex-1">Gains and losses</span>
              <span style={{ color: solVar("green") }}>+4</span>
              <span style={{ color: solVar("red") }}>-2</span>
            </DropdownMenuItem>
            {(["green", "blue", "red"] as const).map((c) => (
              <DropdownMenuItem key={c} className={ITEM} onSelect={() => onAction({ type: "cond", rule: "scale", color: c })}>
                <span className="flex-1">Color scale</span>
                <span className="sheet-scale" style={{ background: `linear-gradient(90deg, ${tint(c, 6)}, ${tint(c, 45)})` }} />
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "cond", rule: "clear" })}><Eraser className="w-4 h-4" /> Clear rules here</DropdownMenuItem>
          </Menu>
          {!compact && <Menu title="Table style" trigger={<Table2 className="w-4 h-4" />}>
            <div className="px-2 pt-1 pb-2">
              <Swatches fill onPick={(c) => onAction({ type: "table", color: c })} />
            </div>
          </Menu>}
          <Menu title="More" trigger={<MoreHorizontal className="w-4 h-4" />}>
            {compact && (
              <>
                <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "border", mode: "all" })}><Grid2x2 className="w-4 h-4" /> All borders</DropdownMenuItem>
                <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "border", mode: "outer" })}><Square className="w-4 h-4" /> Outline</DropdownMenuItem>
                <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "border", mode: "none" })}><SquareDashed className="w-4 h-4" /> No borders</DropdownMenuItem>
                <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "table", color: "blue" })}><Table2 className="w-4 h-4" /> Table style</DropdownMenuItem>
                <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "style", patch: { fs: Math.min(28, (style.fs ?? 13) + 2) } })}>Larger text</DropdownMenuItem>
                <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "style", patch: { fs: (style.fs ?? 13) - 2 <= 13 ? null : (style.fs ?? 13) - 2 } })}>Smaller text</DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "sort", desc: false })}><ArrowDownAZ className="w-4 h-4" /> Sort A to Z</DropdownMenuItem>
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "sort", desc: true })}><ArrowUpAZ className="w-4 h-4" /> Sort Z to A</DropdownMenuItem>
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "filter" })}><Filter className="w-4 h-4" /> Filter</DropdownMenuItem>
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "freeze", axis: "row" })}><Pin className="w-4 h-4" /> Freeze rows to here</DropdownMenuItem>
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "freeze", axis: "col" })}><Pin className="w-4 h-4" /> Freeze columns to here</DropdownMenuItem>
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "freeze", axis: "none" })}>Unfreeze</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "insert", axis: "row", after: false })}>Insert row above</DropdownMenuItem>
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "insert", axis: "row", after: true })}>Insert row below</DropdownMenuItem>
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "insert", axis: "col", after: false })}>Insert column left</DropdownMenuItem>
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "insert", axis: "col", after: true })}>Insert column right</DropdownMenuItem>
            <DropdownMenuItem className={`${ITEM} text-sol-red/90`} onSelect={() => onAction({ type: "delete", axis: "row" })}>Delete rows</DropdownMenuItem>
            <DropdownMenuItem className={`${ITEM} text-sol-red/90`} onSelect={() => onAction({ type: "delete", axis: "col" })}>Delete columns</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className={ITEM} onSelect={() => onAction({ type: "clearFormat" })}><Eraser className="w-4 h-4" /> Clear formatting</DropdownMenuItem>
          </Menu>
          <span className="sheet-fsep" />
          <AskButton data-sheet-ask className="sheet-ask-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setAsking(true)} label={compact ? "Ask" : selectionLabel.includes(":") ? `Ask about ${selectionLabel}` : "Ask agent"} />
        </>
      )}
    </div>
  );
}
