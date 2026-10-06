// The plain host: every slot a view reads, drawn with the area's own ev-*
// rules and nothing else, so a product with no router, key registry, sheet
// or tooltip of its own still gets a working area. A host replaces any of
// them (codecast: its router, key registry, KeyCap, Radix sheet and the
// daemon's connection screens); resolveEvalsHost fills the rest from here.

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEvalsHealth } from './hooks';
import type { EvalsHost, EvalsHostInput, EvalsShortcut, EvalsUi } from './host';
import { EvalsLink } from './shell/parts';

// ── Location ────────────────────────────────────────────────────────────────

/** The browser's own address: a navigation pushes it and announces it the way the back button does. */
function subscribeLocation(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('popstate', fn);
  window.addEventListener('hashchange', fn);
  return () => {
    window.removeEventListener('popstate', fn);
    window.removeEventListener('hashchange', fn);
  };
}
const locationPart = (part: 'search' | 'hash') => () => (typeof window === 'undefined' ? '' : window.location[part]);
const readSearch = locationPart('search');
const readHash = locationPart('hash');

function useNavigate() {
  return (href: string, opts?: { replace?: boolean }) => {
    if (opts?.replace) window.history.replaceState(null, '', href);
    else window.history.pushState(null, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
}

function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribeLocation, readSearch, () => '');
  return useMemo(() => new URLSearchParams(search), [search]);
}

const useHash = () => useSyncExternalStore(subscribeLocation, readHash, () => '');

/** Lands the target `margin` below the root's top, and keeps landing it for a few frames while the page fills in. */
function useLandOn(target: string | null, getRoot: () => HTMLElement | null | undefined, find: (root: HTMLElement, target: string) => HTMLElement | null | undefined, margin: number) {
  const args = useRef({ getRoot, find });
  args.current = { getRoot, find };
  useEffect(() => {
    if (target === null) return;
    let frame = 0;
    let id = 0;
    const land = () => {
      const root = args.current.getRoot();
      const el = root ? args.current.find(root, target) : null;
      if (root && el) root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top - margin;
      if (++frame < 20) id = requestAnimationFrame(land);
    };
    id = requestAnimationFrame(land);
    return () => cancelAnimationFrame(id);
  }, [target, margin]);
}

// ── Keys ────────────────────────────────────────────────────────────────────

/** A field, or an open modal dialog, owns the key. */
function keysBusy(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ''))) return true;
  return typeof document !== 'undefined' && !!document.querySelector('[aria-modal="true"]');
}

/** Whether a key press is `keys`: "j", "Enter", "Shift+Enter", "Mod+k" (Mod is Cmd or Ctrl). */
function pressed(e: KeyboardEvent, keys: string): boolean {
  const parts = keys.split('+');
  const key = parts.pop() || '+';
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const mod = mods.has('mod');
  if (mod ? !(e.metaKey || e.ctrlKey) : e.metaKey !== (mods.has('meta') || mods.has('cmd')) || e.ctrlKey !== mods.has('ctrl')) return false;
  if (e.altKey !== mods.has('alt') || (mods.has('shift') && !e.shiftKey)) return false;
  return e.key.toLowerCase() === key.toLowerCase();
}

function useShortcuts(map: Record<string, EvalsShortcut>, enabled = true) {
  const handlers = useRef(map);
  handlers.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || keysBusy(e.target)) return;
      for (const s of Object.values(handlers.current)) {
        if (pressed(e, s.keys) && s.run() !== false) {
          e.preventDefault();
          return;
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
}

const keyParts = (_action: string, keys: string) => (keys.length > 1 ? keys.split('+').filter(Boolean) : [keys]);

// ── Primitives ──────────────────────────────────────────────────────────────

function KeyCap({ children, size = 'sm' }: { children: ReactNode; size?: 'sm' | 'xs' }) {
  return <kbd className={size === 'xs' ? 'ev-kbd ev-kbd--xs' : 'ev-kbd'}>{children}</kbd>;
}

function HoverTip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return createPortal(
    <div className="ev-tip" role="tooltip" style={{ left: x, top: y }}>
      {children}
    </div>,
    document.body,
  );
}

const SheetState = createContext<{ open: boolean; onOpenChange(open: boolean): void } | null>(null);

const Sheet: EvalsUi['Sheet'] = {
  Root: ({ open, onOpenChange, children }) => <SheetState.Provider value={{ open, onOpenChange }}>{children}</SheetState.Provider>,
  Content({ side = 'right', hideClose, className, children, ...rest }) {
    const state = useContext(SheetState);
    const open = !!state?.open;
    useEffect(() => {
      if (!open) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') state?.onOpenChange(false);
      };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, [open, state]);
    if (!open) return null;
    return createPortal(
      <div className="ev-sheet-layer">
        <div className="ev-sheet-scrim" onClick={() => state?.onOpenChange(false)} />
        <div role="dialog" aria-modal="true" className={`ev-sheet ev-sheet--${side} ${className ?? ''}`} {...rest}>
          {children}
          {!hideClose && (
            <Sheet.Close className="ev-sheet-close" aria-label="Close">
              ×
            </Sheet.Close>
          )}
        </div>
      </div>,
      document.body,
    );
  },
  Title: ({ className, children }) => <h2 className={`ev-sheet-title ${className ?? ''}`}>{children}</h2>,
  Description: ({ className, children }) => <p className={`ev-sheet-sub ${className ?? ''}`}>{children}</p>,
  Close({ className, children, ...rest }) {
    const state = useContext(SheetState);
    return (
      <button type="button" className={className} onClick={() => state?.onOpenChange(false)} {...rest}>
        {children}
      </button>
    );
  },
};

const SegmentedToggle: EvalsUi['SegmentedToggle'] = ({ value, onChange, items }) => (
  <div className="ev-seg" role="radiogroup">
    {items.map((item) => (
      <button key={item.key} type="button" role="radio" aria-checked={item.key === value} className="ev-seg-item" title={item.title} onClick={() => onChange(item.key)}>
        {item.label ?? item.key}
        {item.count ? <span className="ev-seg-count">{item.count}</span> : null}
      </button>
    ))}
  </div>
);

const ExamplePair: EvalsUi['ExamplePair'] = ({ ex, stack = true }) => (
  <div className={stack ? 'ev-pair-box' : undefined}>
    <div className="ev-pair">
      <div className="ev-pair-side ev-pair-before">
        <span className="ev-pair-label">Before</span>
        {ex.input && <span className="ev-pair-input">for: {ex.input}</span>}
        <span className="ev-pair-text">{ex.before}</span>
      </div>
      <div className="ev-pair-side ev-pair-after">
        <span className="ev-pair-label">After</span>
        <span className="ev-pair-text">{ex.after}</span>
      </div>
    </div>
    {ex.note && <p className="ev-pair-note">{ex.note}</p>}
  </div>
);

const EmptyState: EvalsUi['EmptyState'] = ({ title, description, action }) => (
  <div className="ev-empty" data-ev-empty>
    <h3 className="ev-empty-title">{title}</h3>
    <p className="ev-empty-text">{description}</p>
    {action && (
      <EvalsLink className="ev-link ev-empty-action" href={action.href}>
        {action.label} →
      </EvalsLink>
    )}
  </div>
);

type DiffRow = { kind: 'same' | 'del' | 'add'; text: string; a: number | null; b: number | null } | { kind: 'gap'; lines: number };

/** The longest common subsequence of two line lists past a shared head and tail; above a size it gives up and shows both whole. */
function diffLines(a: string[], b: string[]): Array<{ kind: 'same' | 'del' | 'add'; text: string }> {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const mid: Array<{ kind: 'same' | 'del' | 'add'; text: string }> = [];
  if (x.length * y.length > 4_000_000) {
    for (const t of x) mid.push({ kind: 'del', text: t });
    for (const t of y) mid.push({ kind: 'add', text: t });
  } else {
    const w = y.length + 1;
    const len = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) len[i * w + j] = x[i] === y[j] ? len[(i + 1) * w + j + 1]! + 1 : Math.max(len[(i + 1) * w + j]!, len[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        mid.push({ kind: 'same', text: x[i++]! });
        j++;
      } else if (i < x.length && (j === y.length || len[(i + 1) * w + j]! >= len[i * w + j + 1]!)) mid.push({ kind: 'del', text: x[i++]! });
      else mid.push({ kind: 'add', text: y[j++]! });
    }
  }
  return [...a.slice(0, head).map((text) => ({ kind: 'same' as const, text })), ...mid, ...a.slice(a.length - tail).map((text) => ({ kind: 'same' as const, text }))];
}

/** Numbered rows, with unchanged runs longer than the context folded to one line. */
function diffRows(oldStr: string, newStr: string, context: number): DiffRow[] {
  const lines = diffLines(oldStr ? oldStr.split('\n') : [], newStr ? newStr.split('\n') : []);
  let a = 0;
  let b = 0;
  const numbered = lines.map((l) => ({ ...l, a: l.kind === 'add' ? null : ++a, b: l.kind === 'del' ? null : ++b }));
  const near = numbered.map(() => false);
  numbered.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(numbered.length - 1, i + context); k++) near[k] = true;
  });
  const out: DiffRow[] = [];
  numbered.forEach((l, i) => {
    if (near[i]) out.push(l);
    else {
      const last = out[out.length - 1];
      if (last?.kind === 'gap') last.lines++;
      else out.push({ kind: 'gap', lines: 1 });
    }
  });
  return out;
}

const DiffView: EvalsUi['DiffView'] = ({ oldStr = '', newStr = '', showLineNumbers = false, contextLines = 3 }) => {
  const rows = useMemo(() => diffRows(oldStr, newStr, contextLines), [oldStr, newStr, contextLines]);
  return (
    <div className="ev-diff" data-ev-diff-view>
      {rows.map((r, i) =>
        r.kind === 'gap' ? (
          <div key={i} className="ev-diff-gap">
            {r.lines} unchanged {r.lines === 1 ? 'line' : 'lines'}
          </div>
        ) : (
          <div key={i} className={`ev-diff-line ev-diff-line--${r.kind}`}>
            {showLineNumbers && <span className="ev-diff-num">{r.a ?? ''}</span>}
            {showLineNumbers && <span className="ev-diff-num">{r.b ?? ''}</span>}
            <span className="ev-diff-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}</span>
            <span className="ev-diff-text">{r.text}</span>
          </div>
        ),
      )}
    </div>
  );
};

const SessionPill: EvalsUi['SessionPill'] = ({ id }) => (
  <span className="ev-chip" title={id}>
    {id.slice(0, 7)}
  </span>
);

// ── Time ────────────────────────────────────────────────────────────────────

const MIN = 60_000;
const DAY_FORMAT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const FULL_FORMAT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };

const format: EvalsHost['format'] = {
  duration(start, end = Date.now()) {
    const minutes = Math.floor((end - start) / MIN);
    if (minutes < 1) return '';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  },
  timeAgo(at, now = Date.now()) {
    const minutes = Math.floor((now - at) / MIN);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
    if (minutes < 30 * 24 * 60) return `${Math.floor(minutes / 1440)}d`;
    return new Date(at).toLocaleDateString([], DAY_FORMAT);
  },
  relativeTime(at, now = Date.now()) {
    const minutes = Math.floor((now - at) / MIN);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
    if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / 1440)}d ago`;
    return new Date(at).toLocaleDateString([], DAY_FORMAT);
  },
  fullTimestamp: (at) => new Date(at).toLocaleString([], FULL_FORMAT),
};

function useNow(granularityMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), granularityMs);
    return () => clearInterval(id);
  }, [granularityMs]);
  return now;
}

function useContainerWidth(initial = 800) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

// ── Connection ──────────────────────────────────────────────────────────────

/** What the area shows from the provider's GET /health: a wait while it is asked, the failure and a retry if it fails. */
function useConnection(): { state: string; screen: ReactNode | null } {
  const { connected, error, refresh } = useEvalsHealth();
  if (connected) return { state: 'connected', screen: null };
  if (error)
    return {
      state: 'unreachable',
      screen: (
        <div className="ev-unreachable" role="alert" data-evals-unreachable>
          <h3 className="ev-empty-title">The evals did not answer</h3>
          <p className="ev-empty-text">{error}</p>
          <button type="button" className="ev-btn ev-btn--lg" onClick={refresh}>
            Try again
          </button>
        </div>
      ),
    };
  return {
    state: 'connecting',
    screen: (
      <div className="ev-note ev-note--center" data-evals-connecting>
        Reaching the evals...
      </div>
    ),
  };
}

// ── The host ────────────────────────────────────────────────────────────────

export const defaultEvalsHost: EvalsHost = {
  basePath: '/evals',
  useNavigate,
  useSearchParams,
  useHash,
  useLandOn,
  useShortcuts,
  keyParts,
  keysBusy,
  ui: { KeyCap, HoverTip, Sheet, SegmentedToggle, ExamplePair, EmptyState, DiffView, SessionPill },
  format,
  useNow,
  useVisible: () => true,
  useActive: () => true,
  useContainerWidth,
  async copy(text) {
    await navigator.clipboard?.writeText(text);
  },
  useConnection,
};

/** A host's slots over the defaults: any slot it gives wins (one left undefined does not), and `ui` and `format` merge part by part. */
export function resolveEvalsHost(input: EvalsHostInput = {}): EvalsHost {
  const given = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  return {
    ...defaultEvalsHost,
    ...given,
    ui: { ...defaultEvalsHost.ui, ...input.ui },
    format: { ...defaultEvalsHost.format, ...input.format },
  } as EvalsHost;
}
