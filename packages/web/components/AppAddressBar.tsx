"use client";
// The app's address bar: where you are, as a link you can copy, and a field
// that goes anywhere an address can name.
//
// It opens over the app the way the command palette does (same frame, same
// scrim), already holding this page's link, selected: copy it, or type over
// it. What you type is read by lib/appAddress: a codecast link from any copy
// of the app, a path, a short id or a page you visited by its title opens
// here; any other web address opens in a browser pane. The row Enter takes is
// always the highlighted one, and its glyph and label say where it goes
// before you press it.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CornerDownLeft, Globe, Link2 } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { displayPath, resolveAddress, setAppAddressBarOpen, useAppAddressBarOpen, type AddressTarget } from "../lib/appAddress";
import { resolveRecentVisits, resolveVisit, visitHref, type ResolvedVisit } from "../lib/recentVisits";
import { pathLabel } from "../lib/pathLabel";
import { displayHost } from "../lib/browserPane";
import { navigateHere } from "../lib/openIntent";
import { openBrowserPane } from "../lib/stage";
import { copyToClipboard, sharePageUrl } from "../lib/utils";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { KeyCap, ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { PageIcon, RecentVisitGlyph } from "./RecentVisitRow";
import { paletteClass } from "./paletteStyles";
import "./appAddressBar.css";

/** Mounted by the shell; draws nothing while the bar is shut. */
export function AppAddressBarHost() {
  const open = useAppAddressBarOpen();
  return open ? <AppAddressBar /> : null;
}

type Row =
  // `visit` is the place resolved the way recents are, so a typed id shows
  // the object's own title and state glyph rather than its kind.
  | { key: string; kind: "go"; target: AddressTarget; visit?: ResolvedVisit | null }
  | { key: string; kind: "visit"; href: string; visit: ResolvedVisit };

const ROWS = 7;

function herePath(): string {
  const { pathname, search, hash } = window.location;
  return pathname + search + hash;
}

function AppAddressBar() {
  const close = useCallback(() => setAppAddressBarOpen(false), []);
  // Where the window is, refreshed as back and forward move it underneath.
  const [here, setHere] = useState(herePath);
  const link = sharePageUrl(here);
  const [typed, setTyped] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const [copied, setCopied] = useState(0);
  const [refused, setRefused] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const history = useHistoryState(setHere);

  // Read once per open: the list is a place to start, and rows that shuffle
  // under the pointer are worse than ones a few seconds stale.
  const visits = useMemo(
    () =>
      resolveRecentVisits(useInboxStore.getState(), 40)
        .map((visit) => ({ visit, href: visitHref(visit) }))
        .filter((v): v is { visit: ResolvedVisit; href: string } => !!v.href),
    [],
  );

  const query = typed?.trim() ?? "";
  const target = query ? resolveAddress(query) : null;
  const rows: Row[] = useMemo(() => {
    const q = query.toLowerCase();
    const matched = visits
      .filter((v) => v.href !== here && (!q || v.visit.title.toLowerCase().includes(q) || v.href.toLowerCase().includes(q)))
      .slice(0, ROWS)
      .map((v): Row => ({ key: v.href, kind: "visit", href: v.href, visit: v.visit }));
    // The address itself comes first, unless a visit already is that place.
    const same = target?.kind === "app" && matched.some((r) => r.kind === "visit" && r.href === target.path);
    if (!target || same) return matched;
    const visit = target.kind === "app" ? resolveVisit(useInboxStore.getState(), { kind: "page", key: `page:${target.path}`, path: target.path, ts: 0 }) : null;
    return [{ key: "go", kind: "go", target, visit }, ...matched.slice(0, ROWS - 1)];
  }, [query, target, visits, here]);

  // Typing aims at the best row; an untouched field aims at nothing, so Enter
  // on the page's own link only closes the bar.
  const active = highlight >= 0 ? highlight : query && rows.length ? 0 : -1;

  useLayoutEffect(() => {
    inputRef.current?.select();
  }, []);
  // A step back or forward puts the new page's link in the field, selected.
  useLayoutEffect(() => {
    if (typed === null) inputRef.current?.select();
  }, [here, typed]);
  useLayoutEffect(() => {
    listRef.current?.querySelector('[data-on="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const go = useCallback(
    (row: Row | undefined) => {
      if (!row) {
        if (query) setRefused((n) => n + 1);
        else close();
        return;
      }
      close();
      if (row.kind === "visit") navigateHere(row.href);
      else if (row.target.kind === "app") navigateHere(row.target.path);
      else openBrowserPane({ kind: "url", url: row.target.url });
    },
    [query, close],
  );

  const copy = useCallback(() => {
    void copyToClipboard(link).then(
      () => setCopied((n) => n + 1),
      () => toast.error("Couldn't copy"),
    );
  }, [link]);
  useWatchEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(0), 1300);
    return () => clearTimeout(t);
  }, [copied]);

  const activeRow = rows[active];
  const lead = activeRow ?? (query ? undefined : null);

  return (
    <div role="dialog" aria-modal="true" aria-label="Address bar" className="fixed inset-0 z-[9999]">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] aab-scrim" onClick={close} />
      <div className="absolute inset-0 flex items-start justify-center pt-[min(20vh,160px)] pointer-events-none">
        <div className={`${paletteClass} aab-frame pointer-events-auto`} data-refused={refused ? (refused % 2 ? "odd" : "even") : undefined}>
          <div className={`flex items-center gap-1 h-12 pl-2 pr-2 ${rows.length ? "border-b border-sol-border/40" : ""}`}>
            <ShortcutTooltip label="Back" action="nav.back">
              <button type="button" className="aab-nav" aria-label="Back" disabled={!history.canBack} onClick={() => window.history.back()}>
                <ArrowLeft className="w-4 h-4" />
              </button>
            </ShortcutTooltip>
            <ShortcutTooltip label="Forward" action="nav.forward">
              <button type="button" className="aab-nav" aria-label="Forward" disabled={!history.canForward} onClick={() => window.history.forward()}>
                <ArrowRight className="w-4 h-4" />
              </button>
            </ShortcutTooltip>
            <span className="aab-mark ml-1.5" aria-hidden>
              <LeadGlyph row={lead} here={here} />
            </span>
            <input
              ref={inputRef}
              value={typed ?? link}
              onChange={(e) => {
                setTyped(e.target.value);
                setHighlight(-1);
                setRefused(0);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  go(activeRow);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  // First Esc puts this page's link back, second closes.
                  if (typed !== null) {
                    setTyped(null);
                    setHighlight(-1);
                    setRefused(0);
                  } else close();
                } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  if (!rows.length) return;
                  e.preventDefault();
                  const n = rows.length;
                  setHighlight(e.key === "ArrowDown" ? (active + 1) % n : active <= 0 ? n - 1 : active - 1);
                }
              }}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              aria-label="Address"
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls="aab-rows"
              aria-activedescendant={active >= 0 ? `aab-row-${active}` : undefined}
              placeholder="Paste a link, type a path or an id"
              className="aab-input"
            />
            {refused > 0 && <span className="aab-refused">not an address</span>}
            <ShortcutTooltip label={copied ? "Copied" : "Copy link to this page"}>
              <button type="button" className="aab-nav" data-on={copied > 0 || undefined} aria-label="Copy link to this page" onClick={copy}>
                {copied ? <Check key={copied} className="w-4 h-4 aab-pop" /> : <Link2 className="w-4 h-4" />}
              </button>
            </ShortcutTooltip>
          </div>
          {rows.length > 0 && (
            <div id="aab-rows" ref={listRef} role="listbox" className="py-1.5 max-h-[340px] overflow-y-auto">
              {!query && <div className="aab-group">Recent</div>}
              {rows.map((row, i) => (
                <div
                  key={row.key}
                  id={`aab-row-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-on={i === active}
                  className="aab-row"
                  onMouseMove={() => i !== highlight && setHighlight(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go(row)}
                >
                  <span className="aab-glyph">
                    <RowGlyph row={row} />
                  </span>
                  <RowText row={row} />
                  {i === active && (
                    <span className="aab-enter">
                      {row.kind === "go" && row.target.kind === "web" && <span>in a pane</span>}
                      <KeyCap size="xs">
                        <CornerDownLeft className="w-2.5 h-2.5" />
                      </KeyCap>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** What sits left of the field: where Enter goes while typing, else here. */
function LeadGlyph({ row, here }: { row: Row | undefined | null; here: string }) {
  if (row === undefined) return <Globe className="w-4 h-4 opacity-50" />;
  if (row === null) return <PageIcon path={here.split(/[?#]/)[0]} className="w-4 h-4" />;
  return <RowGlyph row={row} />;
}

/** The row's name, then its address, dimmed; the address is left out when it
 *  would only repeat the name (a bare domain). */
function RowText({ row }: { row: Row }) {
  const title = row.kind === "go" && !row.visit ? targetTitle(row.target) : row.visit!.title;
  const detail = displayPath(row.kind === "visit" ? row.href : targetDetail(row.target));
  return (
    <>
      <span className="aab-title">{title}</span>
      <span className="aab-path">{detail !== title ? detail : null}</span>
    </>
  );
}

function RowGlyph({ row }: { row: Row }) {
  return row.kind === "go" && !row.visit ? <TargetGlyph target={row.target} /> : <RecentVisitGlyph item={row.visit!} className="w-4 h-4" />;
}

function TargetGlyph({ target }: { target: AddressTarget }) {
  return target.kind === "web" ? <Globe className="w-4 h-4" /> : <PageIcon path={target.path.split(/[?#]/)[0]} className="w-4 h-4" />;
}

function targetTitle(target: AddressTarget): string {
  return target.kind === "app" ? pathLabel(target.path) : displayHost(target.url);
}

function targetDetail(target: AddressTarget): string {
  return target.kind === "app" ? target.path : target.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * Whether back and forward lead anywhere, from the Navigation API where the
 * runtime has it (Chromium, so the desktop app and Chrome); elsewhere both
 * stay enabled, since history.length cannot tell back from forward.
 */
function useHistoryState(onMove: (path: string) => void): { canBack: boolean; canForward: boolean } {
  const nav = typeof window !== "undefined" ? (window as any).navigation : undefined;
  const read = () => ({ canBack: nav ? !!nav.canGoBack : true, canForward: nav ? !!nav.canGoForward : true });
  const [state, setState] = useState(read);
  useWatchEffect(() => {
    const update = () => {
      setState(read());
      onMove(herePath());
    };
    window.addEventListener("popstate", update);
    nav?.addEventListener?.("currententrychange", update);
    return () => {
      window.removeEventListener("popstate", update);
      nav?.removeEventListener?.("currententrychange", update);
    };
  }, []);
  return state;
}
