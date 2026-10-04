"use client";
// The undo timeline card (docs/architecture/undo-history.md S8), the pure
// half: it paints the rows it is handed (lib/undoHistory) and calls back for
// every act, so the live card, the DEV preview and the mount tests draw the
// same thing. UndoTimeline.tsx reads the engine and the store.
//
// A card in the toast corner, never modal: ⌘Z keeps stepping while it is
// open, and the "now" rule slides with the head. Rows hang from the same rail
// as the org record (components/history/HistoryRail).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";
import { Ban, CornerDownLeft, History, Network, Redo2, Undo2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { visitTimeAgo, type ResolvedVisit } from "../../lib/recentVisits";
import { undoActLabel, undoLabelNamesTitle, undoSetAsideLine, undoWindowWords, type UndoTimelineModel, type UndoTimelineRow } from "../../lib/undoHistory";
import type { UndoTimelineFlash, UndoTimelineMode } from "../../lib/undoTimelineOpen";
import { HISTORY_STRUCK, HistoryFold, HistoryRailDot, HistoryRailLine } from "../history/HistoryRail";
import { RecentVisitGlyph } from "../RecentVisitRow";
import { KeyCap, MenuKeyCaps } from "../KeyboardShortcutsHelp";
import { claimKeys } from "../../shortcuts/keyOwnership";

/** How many rows a peek shows around the head. */
const PEEK_ABOVE = 3;
const PEEK_BELOW = 4;

export type UndoTimelineViewProps = {
  model: UndoTimelineModel;
  mode: UndoTimelineMode;
  onUndoTo: (id: string) => void;
  onRedoTo: (id: string) => void;
  onOpen: (visit: ResolvedVisit) => void;
  onOpenOrg: () => void;
  onClose: () => void;
  /** The first look at every key: the card's own chords (⌘Z steps while it
   *  is open). Return true when handled. */
  onKey?: (e: KeyboardEvent) => boolean;
  /** A ⌘Z stopped at this row (its undo widens access): select and mark it. */
  flash?: UndoTimelineFlash | null;
};

const HINT = "flex items-center gap-1";
const CHORD = "inline-flex items-center gap-[2px] align-middle";

/** How long a flashed row stays marked. */
const FLASH_MS = 1400;

export function UndoTimelineView({ model, mode, onUndoTo, onRedoTo, onOpen, onOpenOrg, onClose, onKey, flash }: UndoTimelineViewProps) {
  const peek = mode === "peek";
  // A peek shows the head with a few rows either side; interactive shows all.
  const { rows, headIndex, atEnd } = useMemo(() => {
    if (!peek) return { rows: model.rows, headIndex: model.headIndex, atEnd: true };
    const from = Math.max(0, model.headIndex - PEEK_ABOVE);
    const to = Math.min(model.rows.length, model.headIndex + PEEK_BELOW + 1);
    return { rows: model.rows.slice(from, to), headIndex: model.headIndex - from, atEnd: to === model.rows.length };
  }, [model, peek]);

  const [selected, setSelected] = useState<string>(() => model.headId ?? model.rows[model.rows.length - 1]?.id ?? "");
  const [folds, setFolds] = useState<ReadonlySet<string>>(() => new Set());
  const cardRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());
  const [rule, setRule] = useState<{ y: number; moved: boolean } | null>(null);

  // The selection follows the head: after ⌘Z the row just taken back is the
  // one under the cursor.
  const lastHead = useRef(model.headId);
  useLayoutEffect(() => {
    if (lastHead.current === model.headId) return;
    lastHead.current = model.headId;
    setSelected(model.headId ?? model.rows[model.rows.length - 1]?.id ?? "");
  }, [model.headId, model.rows]);

  // A ⌘Z that stopped at a row it may not take back: the press is not a dead
  // key, the row it stopped at lights up and takes the selection.
  // Only stops made while this card is mounted: an older one is history.
  const [flashing, setFlashing] = useState<string | null>(null);
  const seenFlash = useRef(flash?.n);
  const flashN = flash?.n;
  useLayoutEffect(() => {
    if (!flash || flash.n === seenFlash.current) return;
    seenFlash.current = flash.n;
    if (!rows.some((r) => r.id === flash.id)) return;
    setSelected(flash.id);
    setFlashing(flash.id);
    const t = setTimeout(() => setFlashing(null), FLASH_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one run per stop
  }, [flashN]);

  // The selected row stays in sight however the selection moved there
  // (Home, End, the head following ⌘Z): Enter acts on what the user sees.
  useLayoutEffect(() => {
    rowEls.current.get(selected)?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  // Interactive takes focus so the keys land here; a peek never does.
  useLayoutEffect(() => {
    if (!peek) rootRef.current?.focus({ preventScroll: true });
  }, [peek]);

  // Its keys (Esc included) live on the card, so an interactive card stays
  // open only while it holds focus: a press or a focus anywhere else closes
  // it, and the click lands where it was aimed.
  useEffect(() => {
    if (peek) return;
    const outside = (e: Event) => {
      const card = cardRef.current;
      if (card && e.target && !card.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
    };
  }, [peek, onClose]);

  // The "now" rule sits on top of the head row. The first placement jumps;
  // later moves slide (160ms ease-out, a jump under reduced motion).
  useLayoutEffect(() => {
    const target = headIndex < rows.length ? rowEls.current.get(rows[headIndex]!.id) : startRef.current;
    if (!target) return;
    const y = target.offsetTop;
    setRule((cur) => (cur && cur.y === y ? cur : { y, moved: cur !== null }));
  }, [headIndex, rows, folds]);

  const act = (row: UndoTimelineRow | undefined) => {
    if (!row?.act) return;
    if (row.act.kind === "org") onOpenOrg();
    else if (row.act.kind === "back") onUndoTo(row.id);
    else onRedoTo(row.id);
  };
  const open = (row: UndoTimelineRow | undefined) => {
    if (!row) return;
    if (row.state === "external") onOpenOrg();
    else if (row.visits[0]) onOpen(row.visits[0]);
  };
  const toggleFold = (id: string) => setFolds((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const move = (by: number) => {
    const at = rows.findIndex((r) => r.id === selected);
    const next = rows[Math.min(rows.length - 1, Math.max(0, at === -1 ? 0 : at + by))];
    if (next) setSelected(next.id);
  };

  // Every key the card handles, and every other plain key, is the card's
  // alone while it holds focus: it claims them in the app's first key
  // listener (claimKeys), so no shortcut, no page listener in any phase and
  // no React handler behind the card ever sees one. Tab still moves focus
  // (which closes the card); chords the card does not take pass on.
  const onKeyRef = useRef<(e: KeyboardEvent) => boolean>(() => false);
  onKeyRef.current = (e) => {
    if (onKey?.(e)) return true;
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key === "Tab" || e.key === "Shift") return false;
    const row = rows.find((r) => r.id === selected);
    const handled = (fn: () => void) => { e.preventDefault(); fn(); return true; };
    switch (e.key) {
      case "Escape": return handled(onClose);
      case "Enter": return handled(() => act(row));
      case "ArrowDown": return handled(() => move(1));
      case "ArrowUp": return handled(() => move(-1));
      case "ArrowRight":
      case " ": return handled(() => { if (row?.fold) toggleFold(row.id); });
      case "o":
      case "O": return handled(() => open(row));
      case "Home": return handled(() => { if (rows[0]) setSelected(rows[0].id); });
      case "End": return handled(() => { if (rows.length) setSelected(rows[rows.length - 1]!.id); });
    }
    return true;
  };
  useEffect(() => {
    if (peek) return;
    return claimKeys((e) => !!cardRef.current?.contains(e.target as Node | null) && onKeyRef.current(e));
  }, [peek]);

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label="Undo history"
      data-undo-timeline={mode}
      className={cn(
        "fixed z-[9990] right-4 bottom-4 w-[min(380px,calc(100vw-24px))] flex flex-col overflow-hidden",
        "rounded-xl border border-sol-border/60 bg-sol-bg/95 backdrop-blur-xl shadow-2xl shadow-black/40",
        "origin-bottom-right animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-200 motion-reduce:animate-none",
        "max-[479px]:inset-x-0 max-[479px]:bottom-0 max-[479px]:w-full max-[479px]:rounded-b-none",
        peek ? "max-h-[300px]" : "max-h-[min(560px,70vh)]",
      )}
      style={{ backgroundImage: "linear-gradient(to bottom, color-mix(in srgb, var(--sol-cyan) 7%, transparent), transparent 72px)" }}
    >
      <Command
        ref={rootRef}
        value={selected}
        onValueChange={setSelected}
        shouldFilter={false}
        label="Undo history"
        tabIndex={-1}
        data-owns-keys=""
        className="flex flex-col min-h-0 outline-none"
      >
        <Header peek={peek} windowMs={model.windowMs} />
        {model.rows.length === 0 ? (
          <p className="px-4 pb-4 pt-1 text-[12.5px] leading-relaxed text-sol-text-muted" data-undo-empty>
            Nothing to take back yet. Changes you make in this window collect here, newest first, each with a way back.
          </p>
        ) : (
          // cmdk moves focus to the list on the first arrow key (there is no
          // input): no browser ring around the rows, the selection is the cue.
          <Command.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-auto pb-1.5 outline-none">
            {/* pt-2: room above the first row for the "now" label, which rides
                7px over the rule when the head is the newest row. */}
            <div className="relative pt-2">
              <HistoryRailLine className="left-[22.5px] top-6 bottom-4" />
              {rule && <NowRule y={rule.y} slide={rule.moved} />}
              {rows.map((row, i) => (
                <Row
                  key={row.id}
                  row={row}
                  aboveHead={i < headIndex}
                  peek={peek}
                  flashing={flashing === row.id}
                  foldOpen={folds.has(row.id)}
                  onFold={() => toggleFold(row.id)}
                  onAct={() => act(row)}
                  onOpen={() => open(row)}
                  refCb={(el) => { if (el) rowEls.current.set(row.id, el); else rowEls.current.delete(row.id); }}
                />
              ))}
              {atEnd && (
                <div ref={startRef} className="relative mx-1 px-2 pt-1.5 pb-1" data-undo-start>
                  <div className="relative pl-[30px] min-h-[22px] flex items-center">
                    <span aria-hidden className="absolute left-[6px] top-[6px] w-[10px] h-[10px] rounded-full border border-dashed border-sol-text-dim/50 bg-sol-bg" />
                    <span className="text-[11.5px] text-sol-text-dim">Start · before these changes</span>
                  </div>
                </div>
              )}
            </div>
          </Command.List>
        )}
        {!peek && model.rows.length > 0 && (
          <div className="flex items-center gap-2.5 px-3 py-1.5 border-t border-sol-border/30 text-[10px] text-sol-text-dim whitespace-nowrap" data-undo-legend>
            <span className={HINT}><KeyCap size="xs">&uarr;</KeyCap><KeyCap size="xs">&darr;</KeyCap>move</span>
            <span className={HINT}><KeyCap size="xs">&#9166;</KeyCap>go</span>
            <span className={HINT}><KeyCap size="xs">&rarr;</KeyCap>fold</span>
            <span className={HINT}><KeyCap size="xs">O</KeyCap>open</span>
            <span className={cn(HINT, "ml-auto")} title="Back and forward one step">
              <MenuKeyCaps action="ui.undo" className={CHORD} /><MenuKeyCaps action="ui.redo" className={CHORD} />step
            </span>
          </div>
        )}
      </Command>
    </div>
  );
}

function Header({ peek, windowMs }: { peek: boolean; windowMs: number }) {
  return (
    <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-2">
      <span className="w-7 h-7 flex-shrink-0 rounded-lg inline-flex items-center justify-center text-sol-cyan" style={{ background: "color-mix(in srgb, var(--sol-cyan) 14%, transparent)" }}>
        <History className="w-4 h-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold leading-[18px] text-sol-text truncate">Undo history</h2>
          {/* Stepping keys sit in the footer beside the list they move; the
              header names only the way out, so the title keeps one line. */}
          {!peek && (
            <span className="ml-auto flex flex-shrink-0 items-center whitespace-nowrap text-[10px] text-sol-text-dim" data-undo-header-keys>
              <span className={HINT}><KeyCap size="xs">Esc</KeyCap>close</span>
            </span>
          )}
        </div>
        <p className="text-[11px] text-sol-text-dim leading-[18px] truncate" data-undo-subline>
          This window · <MenuKeyCaps action="ui.undo" className={CHORD} /> reaches the last {undoWindowWords(windowMs)}
        </p>
      </div>
    </div>
  );
}

/** The 1px cyan "now" line with its knot on the rail. */
function NowRule({ y, slide }: { y: number; slide: boolean }) {
  return (
    <div
      aria-hidden
      data-undo-now
      className={cn("absolute left-3 right-3 top-0 h-0 z-10 pointer-events-none", slide && "transition-transform duration-[160ms] ease-out motion-reduce:transition-none")}
      style={{ transform: `translateY(${y}px)` }}
    >
      <span className="absolute left-0 right-0 -top-px h-px" style={{ background: "linear-gradient(to right, var(--sol-cyan), color-mix(in srgb, var(--sol-cyan) 45%, transparent))" }} />
      <span className="absolute left-[7px] -top-[3.5px] w-[7px] h-[7px] rounded-full" style={{ background: "var(--sol-cyan)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--sol-cyan) 22%, transparent)" }} />
      <span className="absolute right-0 -top-[7px] px-1.5 h-[14px] inline-flex items-center rounded-full text-[9px] font-semibold uppercase tracking-[0.08em] text-sol-cyan bg-sol-bg">now</span>
    </div>
  );
}

function RowDot({ row }: { row: UndoTimelineRow }) {
  switch (row.state) {
    case "undone":
    case "partial":
      return <HistoryRailDot color="var(--sol-text-dim)"><Redo2 className="w-3 h-3" /></HistoryRailDot>;
    case "external":
      return <HistoryRailDot color="var(--sol-violet)"><Network className="w-3 h-3" /></HistoryRailDot>;
    case "refused":
      return <HistoryRailDot color="var(--sol-red)"><Ban className="w-3 h-3" /></HistoryRailDot>;
    default: {
      const ring = row.state === "conflict" ? "var(--sol-yellow)" : undefined;
      const dim = row.state === "dropped" || row.expired;
      return (
        <HistoryRailDot ring={ring} color={dim ? "var(--sol-text-dim)" : "var(--sol-text-muted)"} className={cn(ring && "border-[1.5px]")}>
          {row.visits[0] ? <RecentVisitGlyph item={row.visits[0]} className="w-3 h-3" /> : <Undo2 className="w-3 h-3" />}
        </HistoryRailDot>
      );
    }
  }
}

function Row({ row, aboveHead, peek, flashing, foldOpen, onFold, onAct, onOpen, refCb }: {
  row: UndoTimelineRow;
  aboveHead: boolean;
  /** A peek takes no keys: its selection marks the head, not a target for Enter. */
  peek: boolean;
  flashing: boolean;
  foldOpen: boolean;
  onFold: () => void;
  onAct: () => void;
  onOpen: () => void;
  refCb: (el: HTMLDivElement | null) => void;
}) {
  const undone = row.state === "undone" || row.state === "partial";
  const inert = !row.act;
  const visit = row.visits[0];
  // The live title as a quiet link, unless the label already says it. A
  // group names several objects, so no one title speaks for it. Only a live
  // object (an archived doc resolves to its kind word), and only on a row in
  // force: an undone or refused row's line 2 is its state.
  const showTitle = !!visit?.entity && !row.fold && row.state === "done" && !undoLabelNamesTitle(row.label, visit.title);
  const actLabel = undoActLabel(row.act);
  // A group with nothing to report on line 2 puts its fold there.
  const foldInline = !!row.fold && !row.detail;
  const skipped = new Set((row.item.skipped ?? []).map((s) => `${s.store}:${s.id}`));
  return (
    <Command.Item
      ref={refCb}
      value={row.id}
      data-undo-row={row.id}
      data-state={row.state}
      data-above-head={aboveHead ? "" : undefined}
      data-undo-flash={flashing ? "" : undefined}
      className={cn(
        "group relative mx-1 px-2 py-1.5 rounded-lg cursor-default border border-transparent transition-colors duration-300",
        flashing
          ? "bg-sol-yellow/[0.12] border-sol-yellow/40"
          : "data-[selected=true]:bg-sol-cyan/[0.09] data-[selected=true]:border-sol-cyan/25",
      )}
    >
      <div className="relative pl-[30px]">
        <RowDot row={row} />
        <div className="flex items-baseline gap-2 min-h-[22px]">
          <span
            className={cn("min-w-0 truncate text-[13px] leading-[22px]", row.state === "dropped" && HISTORY_STRUCK)}
            style={{ color: undone || row.state === "dropped" || inert ? "var(--sol-text-dim)" : "var(--sol-text)" }}
            title={row.label}
            data-undo-label
          >
            {row.label}
          </span>
          <span className="ml-auto flex-shrink-0 text-[10.5px] text-sol-text-dim tabular-nums">{visitTimeAgo(row.ts)}</span>
        </div>
        <div className="flex items-center gap-2 min-h-[18px]">
          {foldInline && <HistoryFold open={foldOpen} onClick={onFold} className="h-[18px]" data-undo-fold>{row.fold!.label}</HistoryFold>}
          {showTitle && (
            // Line 2 is where it happened, and the object is the first word of
            // that: its live title, a quiet link. The button truncates itself
            // (an atomic inline box would vanish whole under a wrapper's ellipsis).
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpen(); }}
              className="min-w-[6ch] truncate text-left text-[11px] text-sol-text-muted hover:text-sol-cyan hover:underline underline-offset-2"
              data-undo-open
            >
              {visit!.title}
            </button>
          )}
          {showTitle && row.detail && <span aria-hidden className="-mx-1 flex-shrink-0 text-[11px] text-sol-text-dim">·</span>}
          <span
            // After a title, the short facts keep their room and the title gives way.
            className={cn("min-w-0 truncate text-[11px]", showTitle && "flex-shrink-0 max-w-[55%]")}
            style={{ color: row.state === "conflict" || flashing ? "var(--sol-yellow)" : row.state === "refused" ? "var(--sol-red)" : row.secondsLeft !== null ? "var(--sol-orange)" : "var(--sol-text-dim)" }}
            data-undo-detail
          >
            {row.detail}
          </span>
          {actLabel && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onAct(); }}
              className={cn(
                // Out of flow until hover or selection, so the detail gets the full line.
                "ml-auto flex-shrink-0 hidden items-center gap-1 h-5 px-1.5 rounded-md text-[10.5px] font-medium",
                peek ? "group-hover:inline-flex" : "group-hover:inline-flex group-data-[selected=true]:inline-flex",
                row.act?.kind === "org" ? "text-sol-violet hover:bg-sol-violet/10" : "text-sol-cyan hover:bg-sol-cyan/10",
              )}
              data-undo-act={row.act?.kind}
            >
              {row.act?.kind === "back" ? <Undo2 className="w-3 h-3" /> : row.act?.kind === "forward" ? <Redo2 className="w-3 h-3" /> : <Network className="w-3 h-3" />}
              {actLabel}
              {!peek && <CornerDownLeft className="w-2.5 h-2.5 opacity-60 hidden group-data-[selected=true]:inline" />}
            </button>
          )}
        </div>
        {row.fold && (
          <div className={foldInline ? undefined : "mt-0.5"}>
            {!foldInline && <HistoryFold open={foldOpen} onClick={onFold} data-undo-fold>{row.fold.label}</HistoryFold>}
            {foldOpen && (
              <ul className="mt-1 mb-0.5 space-y-0.5 pl-1" data-undo-fold-rows>
                {row.fold.children.map((c) => {
                  const left = (c.objects ?? []).some((o) => skipped.has(`${o.store}:${o.id}`));
                  return (
                    <li key={c.id} className="text-[11.5px] text-sol-text-muted truncate" data-undo-child={c.id}>
                      {c.label}
                      {left && <span className="text-sol-text-dim"> · changed since, left as it is</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {row.setAside && (
          <p className={cn("mt-0.5 text-[11px] text-sol-text-dim truncate", HISTORY_STRUCK)} title={row.setAside.labels.join("\n")} data-undo-set-aside={row.setAside.count}>
            {undoSetAsideLine(row.setAside.count, row.label)}
          </p>
        )}
      </div>
    </Command.Item>
  );
}
