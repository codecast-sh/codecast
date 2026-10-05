// Draws a mod's element tree with codecast's own components (contract:
// shared/contracts/mods.ts, author types: shared/mods/authoring.d.ts). The tree
// is plain data from the sandbox; a handler in it is a { $fn } id, and pressing
// the control sends that id back to the mod's runtime. Nothing the mod sends is
// ever HTML except the Canvas element, which goes through the same sanitizer as
// a cast-canvas block.

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DynamicIcon } from "lucide-react/dynamic";
import { Button as UIButton } from "../ui/button";
import { Switch } from "../ui/switch";
import { EntityIdPill } from "../EntityIdPill";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { CodeBlock } from "../CodeBlock";
import { HtmlSnippet } from "../HtmlSnippet";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { hydrateCharts } from "../../lib/castChart";
import { formatRelativeTime } from "../../lib/conversationFormat";
import { MOD_ELEMENTS, type ModNode } from "@codecast/shared/contracts/mods";
import { isAppPath } from "../../lib/mods/host";

type Fn = { $fn: string };
type Invoke = (fn: string, args: unknown[]) => void;
type Navigate = (path: string) => void;

const Ctx = createContext<{ invoke: Invoke; navigate: Navigate }>({ invoke: () => {}, navigate: () => {} });

const KNOWN = new Set<string>([...MOD_ELEMENTS, "Fragment"]);

const TONES: Record<string, string> = {
  default: "var(--sol-text)", muted: "var(--sol-text-muted)", dim: "var(--sol-text-dim)",
  blue: "var(--sol-blue)", green: "var(--sol-green)", yellow: "var(--sol-yellow)", red: "var(--sol-red)",
  magenta: "var(--sol-magenta)", cyan: "var(--sol-cyan)", orange: "var(--sol-orange)", violet: "var(--sol-violet)",
};
const tone = (t: unknown) => (typeof t === "string" ? TONES[t] : undefined);
const soft = (t: unknown, pct = 12) => (tone(t) ? `color-mix(in srgb, ${tone(t)} ${pct}%, transparent)` : undefined);
const space = (n: unknown) => (typeof n === "number" ? `${n * 4}px` : undefined);
const dim = (v: unknown) => (typeof v === "number" ? `${v}px` : typeof v === "string" ? v : undefined);
const isFn = (v: unknown): v is Fn => !!v && typeof v === "object" && typeof (v as Fn).$fn === "string";
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

const JUSTIFY: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", between: "space-between", around: "space-around" };
const ALIGN: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch", baseline: "baseline" };
const TEXT_SIZE: Record<string, string> = { xs: "11px", sm: "12px", md: "13px", lg: "15px", xl: "18px", "2xl": "24px" };
const WEIGHT: Record<string, number> = { normal: 400, medium: 500, semibold: 600, bold: 700 };

function useHandler(v: unknown): ((...args: unknown[]) => void) | undefined {
  const { invoke } = useContext(Ctx);
  return isFn(v) ? (...args: unknown[]) => invoke(v.$fn, args) : undefined;
}

function layoutStyle(p: Record<string, any>, direction: "row" | "column"): CSSProperties {
  return {
    display: "flex",
    flexDirection: direction,
    gap: space(p.gap),
    padding: space(p.pad),
    paddingInline: space(p.padX),
    paddingBlock: space(p.padY),
    alignItems: ALIGN[p.align] ?? (direction === "row" ? "center" : undefined),
    justifyContent: JUSTIFY[p.justify],
    flexWrap: p.wrap ? "wrap" : undefined,
    flexGrow: p.grow ? 1 : undefined,
    minWidth: 0,
    width: dim(p.width),
    height: dim(p.height),
    maxWidth: dim(p.maxWidth),
    overflow: p.scroll ? "auto" : undefined,
    border: p.border ? "1px solid var(--sol-border)" : undefined,
    borderRadius: p.rounded || p.border ? 8 : undefined,
    background: p.bg === "card" ? "var(--sol-card)" : p.bg === "alt" ? "var(--sol-bg-alt)" : soft(p.bg),
    color: tone(p.tone),
    cursor: isFn(p.onPress) ? "pointer" : undefined,
  };
}

function Layout({ p, c, direction }: { p: Record<string, any>; c: ModNode[]; direction: "row" | "column" }) {
  const onPress = useHandler(p.onPress);
  return (
    <div style={layoutStyle(p, direction)} onClick={onPress ? () => onPress() : undefined} title={p.tip ? str(p.tip) : undefined}>
      <Children c={c} />
    </div>
  );
}

function Children({ c }: { c?: ModNode[] }) {
  if (!c?.length) return null;
  return <>{c.map((n, i) => <Node key={keyOf(n, i)} n={n} />)}</>;
}

function keyOf(n: ModNode, i: number): string {
  if (n && typeof n === "object" && n.p && (typeof n.p.key === "string" || typeof n.p.key === "number")) return String(n.p.key);
  return String(i);
}

function Card({ p, c }: { p: Record<string, any>; c: ModNode[] }) {
  const accent = tone(p.tone);
  const onPress = useHandler(p.onPress);
  const hasHead = p.title || p.subtitle || p.actions;
  return (
    <section
      onClick={onPress ? () => onPress() : undefined}
      className="rounded-lg border min-w-0"
      style={{
        borderColor: accent ? `color-mix(in srgb, ${accent} 35%, var(--sol-border))` : "var(--sol-border)",
        background: accent ? `color-mix(in srgb, ${accent} 6%, var(--sol-card))` : "var(--sol-card)",
        cursor: onPress ? "pointer" : undefined,
        width: dim(p.width),
      }}
    >
      {hasHead ? (
        <header className="flex items-center gap-2 px-3.5 pt-3 pb-1">
          <div className="min-w-0 flex-1">
            {p.title ? <div className="text-[13px] font-semibold text-sol-text truncate">{str(p.title)}</div> : null}
            {p.subtitle ? <div className="text-[11.5px] text-sol-text-dim truncate">{str(p.subtitle)}</div> : null}
          </div>
          {p.actions ? <Node n={p.actions as ModNode} /> : null}
        </header>
      ) : null}
      <div style={{ ...layoutStyle({ gap: 2, ...p, pad: p.pad ?? 3.5 }, "column"), border: undefined, background: undefined, color: undefined, cursor: undefined, paddingTop: hasHead ? space(1.5) : undefined, width: undefined }}>
        <Children c={c} />
      </div>
    </section>
  );
}

function Text({ p, c }: { p: Record<string, any>; c: ModNode[] }) {
  const lines = typeof p.lines === "number" ? p.lines : undefined;
  return (
    <span
      title={p.tip ? str(p.tip) : undefined}
      className={p.mono ? "font-mono" : undefined}
      style={{
        color: tone(p.tone),
        fontSize: TEXT_SIZE[p.size] ?? undefined,
        fontWeight: WEIGHT[p.weight],
        fontStyle: p.italic ? "italic" : undefined,
        textAlign: p.align,
        flexGrow: p.grow ? 1 : undefined,
        minWidth: 0,
        ...(p.truncate ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" } : {}),
        ...(lines ? { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" } : {}),
      }}
    >
      <Children c={c} />
    </span>
  );
}

function Heading({ p, c }: { p: Record<string, any>; c: ModNode[] }) {
  const size = p.level === 1 ? "20px" : p.level === 3 ? "13px" : "16px";
  return <div style={{ fontSize: size, fontWeight: 650, color: tone(p.tone) ?? "var(--sol-text)", letterSpacing: "-0.01em" }}><Children c={c} /></div>;
}

function ModButton({ p, c }: { p: Record<string, any>; c: ModNode[] }) {
  const onPress = useHandler(p.onPress);
  const [busy, setBusy] = useState(false);
  const variant = p.variant === "primary" ? "default" : p.variant === "danger" ? "destructive" : p.variant === "ghost" ? "ghost" : "outline";
  return (
    <UIButton
      variant={variant as any}
      size={p.size === "md" ? "default" : "sm"}
      disabled={!!p.disabled || busy}
      title={p.tip ? str(p.tip) : undefined}
      onClick={async (ev) => {
        ev.stopPropagation();
        if (!onPress) return;
        setBusy(true);
        try { onPress(); } finally { setTimeout(() => setBusy(false), 250); }
      }}
    >
      {p.icon ? <DynamicIcon name={p.icon as any} /> : null}
      {p.label ? str(p.label) : <Children c={c} />}
    </UIButton>
  );
}

/** A field the mod controls: local while typing, its value prop wins whenever the mod sends a new one. */
function Field({ p, multiline }: { p: Record<string, any>; multiline?: boolean }) {
  const [value, setValue] = useState(str(p.value));
  // While the person types, the mod's echoes of earlier keystrokes would
  // overwrite newer ones: its value wins only when the field is not in use.
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setValue(str(p.value)); }, [p.value]);
  const onChange = useHandler(p.onChange);
  const onSubmit = useHandler(p.onSubmit);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const change = (v: string) => {
    setValue(v);
    if (!onChange) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(v), 180);
  };
  const cls = `w-full rounded-md border border-sol-border bg-sol-bg px-2.5 py-1.5 text-[13px] text-sol-text outline-none focus:border-sol-blue ${p.mono ? "font-mono" : ""}`;
  if (multiline) {
    return (
      <textarea
        className={cls}
        rows={typeof p.rows === "number" ? p.rows : 4}
        value={value}
        placeholder={str(p.placeholder)}
        onChange={(e) => change(e.target.value)}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; }}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onSubmit) { e.preventDefault(); onSubmit(value); } }}
      />
    );
  }
  return (
    <input
      className={cls}
      style={{ width: dim(p.width) }}
      value={value}
      autoFocus={!!p.autoFocus}
      placeholder={str(p.placeholder)}
      onChange={(e) => change(e.target.value)}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; }}
      onKeyDown={(e) => { if (e.key === "Enter" && onSubmit) { e.preventDefault(); onSubmit(value); } }}
    />
  );
}

function Select({ p }: { p: Record<string, any> }) {
  const onChange = useHandler(p.onChange);
  const options = (Array.isArray(p.options) ? p.options : []).map((o: any) => (typeof o === "string" ? { value: o, label: o } : { value: str(o?.value), label: str(o?.label ?? o?.value) }));
  return (
    <select
      className="rounded-md border border-sol-border bg-sol-bg px-2 py-1.5 text-[13px] text-sol-text outline-none focus:border-sol-blue"
      value={str(p.value)}
      onChange={(e) => onChange?.(e.target.value)}
    >
      {p.placeholder ? <option value="" disabled>{str(p.placeholder)}</option> : null}
      {options.map((o: { value: string; label: string }) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function Toggle({ p }: { p: Record<string, any> }) {
  const onChange = useHandler(p.onChange);
  const [on, setOn] = useState(!!p.value);
  useEffect(() => setOn(!!p.value), [p.value]);
  return (
    <label className="inline-flex items-center gap-2 text-[13px] text-sol-text cursor-pointer">
      <Switch checked={on} onCheckedChange={(v: boolean) => { setOn(v); onChange?.(v); }} />
      {p.label ? str(p.label) : null}
    </label>
  );
}

function Badge({ p, c }: { p: Record<string, any>; c: ModNode[] }) {
  const t = tone(p.tone) ?? "var(--sol-text-muted)";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[11px] font-medium whitespace-nowrap"
      style={{ color: t, background: `color-mix(in srgb, ${t} 14%, transparent)` }}
    >
      {p.dot ? <span className="inline-block size-1.5 rounded-full" style={{ background: t }} /> : null}
      <Children c={c} />
    </span>
  );
}

/** A reference pill sized for UI, not prose: the pill sizes itself to 1em of whatever surrounds it. */
function Ref({ id, label }: { id: string; label?: string }) {
  if (!id) return null;
  return <span className="inline-flex min-w-0 text-[13px] leading-snug"><EntityIdPill shortId={id} label={label} fallback={<span className="font-mono text-[12px] text-sol-text-muted">{label ?? id}</span>} /></span>;
}

function TimeText({ at, format }: { at: unknown; format?: string }) {
  const ms = typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : NaN;
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const text = format === "time" ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : format === "date" ? d.toLocaleDateString([], { month: "short", day: "numeric" })
    : format === "datetime" ? d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : formatRelativeTime(ms);
  return <time dateTime={d.toISOString()} title={d.toLocaleString()} className="text-sol-text-dim tabular-nums">{text}</time>;
}

function Cell({ value, as }: { value: unknown; as?: string }) {
  if (value === undefined || value === null || value === "") return <span className="text-sol-text-dim">—</span>;
  switch (as) {
    case "ref": return <Ref id={str(value)} />;
    case "time": return <TimeText at={value} />;
    case "badge": return <Badge p={{}} c={[str(value)]} />;
    case "number": return <span className="tabular-nums">{typeof value === "number" ? value.toLocaleString() : str(value)}</span>;
    case "mono": return <span className="font-mono text-[12px]">{str(value)}</span>;
    case "markdown": return <MarkdownRenderer content={str(value)} />;
    default:
      if (value && typeof value === "object" && "t" in (value as object)) return <Node n={value as ModNode} />;
      return <span className="truncate">{typeof value === "object" ? JSON.stringify(value) : str(value)}</span>;
  }
}

function Table({ p }: { p: Record<string, any> }) {
  const onRowPress = useHandler(p.onRowPress);
  const columns: { key: string; label?: string; width?: number | string; align?: string; as?: string }[] = (Array.isArray(p.columns) ? p.columns : []).filter((c: any) => c && typeof c.key === "string");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const rows: Record<string, unknown>[] = useMemo(() => {
    const list = (Array.isArray(p.rows) ? p.rows : []).filter((r: unknown) => r && typeof r === "object");
    if (sort) list.sort((a, b) => ((a[sort.key] as any) > (b[sort.key] as any) ? 1 : (a[sort.key] as any) < (b[sort.key] as any) ? -1 : 0) * sort.dir);
    return list;
  }, [p.rows, sort]);
  if (!rows.length) return <div className="py-4 text-center text-[12.5px] text-sol-text-dim">{str(p.empty ?? "Nothing here")}</div>;
  const pad = p.dense ? "py-1" : "py-1.5";
  return (
    <div style={{ maxHeight: dim(p.maxHeight), overflow: p.maxHeight ? "auto" : undefined }} className="min-w-0">
      <table className="w-full text-[12.5px] border-collapse">
        <thead>
          <tr className="text-sol-text-dim text-[11px] uppercase tracking-wide">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`${pad} px-2 font-medium border-b border-sol-border ${p.sortable !== false ? "cursor-pointer select-none hover:text-sol-text" : ""}`}
                style={{ textAlign: (col.align as any) ?? "left", width: dim(col.width) }}
                onClick={() => p.sortable !== false && setSort((s) => (s?.key === col.key ? { key: col.key, dir: (s.dir * -1) as 1 | -1 } : { key: col.key, dir: 1 }))}
              >
                {col.label ?? col.key}{sort?.key === col.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={str(row._id ?? row.id ?? i)}
              onClick={onRowPress ? () => onRowPress(row) : undefined}
              className={`border-b border-[color-mix(in_srgb,var(--sol-border)_55%,transparent)] last:border-0 ${onRowPress ? "cursor-pointer hover:bg-[color-mix(in_srgb,var(--sol-blue)_6%,transparent)]" : ""}`}
            >
              {columns.map((col) => (
                <td key={col.key} className={`${pad} px-2 text-sol-text align-middle max-w-[420px]`} style={{ textAlign: (col.align as any) ?? "left" }}>
                  <Cell value={row[col.key]} as={col.as} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tabs({ p, c }: { p: Record<string, any>; c: ModNode[] }) {
  const tabs = (c ?? []).filter((n): n is Exclude<ModNode, string | number | null> => !!n && typeof n === "object" && n.t === "Tab");
  const [local, setLocal] = useState<string | undefined>(undefined);
  const onChange = useHandler(p.onChange);
  const active = str(p.value ?? local ?? tabs[0]?.p?.id);
  return (
    <div className="min-w-0">
      <div className="flex gap-1 border-b border-sol-border mb-3 overflow-x-auto">
        {tabs.map((t) => {
          const id = str(t.p?.id);
          const on = id === active;
          return (
            <button
              key={id}
              onClick={() => { setLocal(id); onChange?.(id); }}
              className={`px-3 py-1.5 -mb-px text-[12.5px] border-b-2 whitespace-nowrap transition-colors ${on ? "border-sol-blue text-sol-text" : "border-transparent text-sol-text-muted hover:text-sol-text"}`}
            >
              {str(t.p?.label ?? id)}
              {typeof t.p?.count === "number" ? <span className="ml-1.5 text-[11px] text-sol-text-dim tabular-nums">{t.p.count as number}</span> : null}
            </button>
          );
        })}
      </div>
      {tabs.filter((t) => str(t.p?.id) === active).map((t) => <div key={str(t.p?.id)} style={layoutStyle({ gap: 3 }, "column")}><Children c={t.c} /></div>)}
    </div>
  );
}

function Chart({ p }: { p: Record<string, any> }) {
  const ref = useRef<HTMLDivElement>(null);
  const spec = useMemo(() => JSON.stringify(p.spec ?? {}), [p.spec]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = "";
    const inner = document.createElement("div");
    inner.className = "cast-chart";
    inner.setAttribute("data-spec", spec);
    el.appendChild(inner);
    void hydrateCharts(el, el.clientWidth || 600);
  }, [spec]);
  return <div ref={ref} className="min-w-0 text-sol-text" style={{ minHeight: dim(p.height) ?? 120 }} />;
}

function Sparkline({ p }: { p: Record<string, any> }) {
  const values: number[] = Array.isArray(p.values) ? p.values.filter((v: unknown) => typeof v === "number") : [];
  const w = typeof p.width === "number" ? p.width : 96, h = typeof p.height === "number" ? p.height : 24;
  if (values.length < 2) return <svg width={w} height={h} />;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (w - 2) + 1},${h - 1 - ((v - min) / span) * (h - 2)}`).join(" ");
  const color = tone(p.tone) ?? "var(--sol-blue)";
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ overflow: "visible" }}>
      <polyline points={`1,${h - 1} ${pts} ${w - 1},${h - 1}`} fill={`color-mix(in srgb, ${color} 14%, transparent)`} stroke="none" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Stat({ p }: { p: Record<string, any> }) {
  const t = tone(p.tone);
  return (
    <div className="rounded-lg border border-sol-border px-3.5 py-3 min-w-0" style={{ background: t ? `linear-gradient(160deg, color-mix(in srgb, ${t} 10%, var(--sol-card)), var(--sol-card) 70%)` : "var(--sol-card)" }} title={p.hint ? str(p.hint) : undefined}>
      <div className="text-[11px] uppercase tracking-wide text-sol-text-dim truncate">{str(p.label)}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-[24px] font-semibold tabular-nums leading-none" style={{ color: t ?? "var(--sol-text)" }}>{typeof p.value === "number" ? p.value.toLocaleString() : str(p.value)}</span>
        {p.delta ? <span className="text-[11.5px] text-sol-text-muted tabular-nums">{str(p.delta)}</span> : null}
      </div>
    </div>
  );
}

function Item({ p, c }: { p: Record<string, any>; c: ModNode[] }) {
  const onPress = useHandler(p.onPress);
  return (
    <div
      onClick={onPress ? () => onPress() : undefined}
      className={`flex items-center gap-2.5 px-2 py-1.5 rounded-md min-w-0 ${onPress ? "cursor-pointer hover:bg-[color-mix(in_srgb,var(--sol-blue)_7%,transparent)]" : ""}`}
    >
      {p.icon ? <DynamicIcon name={p.icon as any} size={15} style={{ color: tone(p.tone) ?? "var(--sol-text-dim)", flexShrink: 0 }} /> : null}
      <div className="min-w-0 flex-1">
        {p.title ? <div className="text-[13px] text-sol-text truncate">{str(p.title)}</div> : null}
        {p.subtitle ? <div className="text-[11.5px] text-sol-text-dim truncate">{str(p.subtitle)}</div> : null}
        <Children c={c} />
      </div>
      {p.trailing ? <div className="shrink-0"><Node n={p.trailing as ModNode} /></div> : null}
    </div>
  );
}

function ModLink({ p, c }: { p: Record<string, any>; c: ModNode[] }) {
  const { navigate } = useContext(Ctx);
  const href = str(p.href);
  const internal = isAppPath(href);
  const external = /^https?:\/\//.test(href);
  if (!internal && !external) return <Children c={c} />;
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      onClick={internal ? (e) => { e.preventDefault(); navigate(href); } : undefined}
      style={{ color: tone(p.tone) ?? "var(--sol-blue)" }}
      className="hover:underline underline-offset-2"
    >
      <Children c={c} />
    </a>
  );
}

function Avatar({ p }: { p: Record<string, any> }) {
  const size = typeof p.size === "number" ? p.size : 22;
  const src = str(p.src);
  const initials = str(p.name).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  if (/^https:\/\//.test(src)) return <img src={src} alt={str(p.name)} width={size} height={size} className="rounded-full object-cover" />;
  return <span className="inline-flex items-center justify-center rounded-full bg-sol-bg-alt text-sol-text-muted font-medium" style={{ width: size, height: size, fontSize: size * 0.42 }}>{initials || "?"}</span>;
}

function Unknown({ t }: { t: string }) {
  return <span className="rounded bg-[color-mix(in_srgb,var(--sol-red)_12%,transparent)] px-1.5 py-0.5 font-mono text-[11px] text-sol-red">unknown element {"<"}{t}{">"}</span>;
}

const Node = memo(function Node({ n }: { n: ModNode }): ReactNode {
  if (n === null || n === undefined) return null;
  if (typeof n === "string" || typeof n === "number") return <>{n}</>;
  if (typeof n !== "object" || typeof n.t !== "string") return null;
  const p = (n.p ?? {}) as Record<string, any>;
  const c = n.c ?? [];
  if (!KNOWN.has(n.t)) return <Unknown t={n.t} />;
  switch (n.t) {
    case "Fragment": return <Children c={c} />;
    case "Box": return <Layout p={p} c={c} direction={p.direction === "row" ? "row" : "column"} />;
    case "Row": return <Layout p={p} c={c} direction="row" />;
    case "Column": return <Layout p={p} c={c} direction="column" />;
    case "Grid": {
      const cols = typeof p.columns === "number" ? `repeat(${p.columns}, minmax(0, 1fr))` : typeof p.columns === "string" ? p.columns : `repeat(auto-fill, minmax(${p.min ?? 180}px, 1fr))`;
      return <div style={{ display: "grid", gridTemplateColumns: cols, gap: space(p.gap ?? 3), padding: space(p.pad), minWidth: 0 }}><Children c={c} /></div>;
    }
    case "Card": return <Card p={p} c={c} />;
    case "Text": return <Text p={p} c={c} />;
    case "Heading": return <Heading p={p} c={c} />;
    case "Button": return <ModButton p={p} c={c} />;
    case "Input": return <Field p={p} />;
    case "TextArea": return <Field p={p} multiline />;
    case "Select": return <Select p={p} />;
    case "Toggle": return <Toggle p={p} />;
    case "Table": return <Table p={p} />;
    case "Tabs": return <Tabs p={p} c={c} />;
    case "Tab": return <Children c={c} />;
    case "Badge": return <Badge p={p} c={c} />;
    case "Ref": return <Ref id={str(p.id)} label={p.label ? str(p.label) : undefined} />;
    case "Chart": return <Chart p={p} />;
    case "Markdown": return <div className={`min-w-0 ${p.size === "sm" ? "text-[12.5px]" : "text-[13px]"}`}><MarkdownRenderer content={str(p.text)} /></div>;
    case "Canvas": return <div style={{ minHeight: dim(p.height) }}><HtmlSnippet code={str(p.html)} /></div>;
    case "Code": return <div style={{ maxHeight: dim(p.maxHeight), overflow: p.maxHeight ? "auto" : undefined }}><CodeBlock code={str(p.code)} language={p.lang ? str(p.lang) : undefined} /></div>;
    case "Progress": {
      const max = typeof p.max === "number" && p.max > 0 ? p.max : 100;
      const pct = Math.max(0, Math.min(100, ((typeof p.value === "number" ? p.value : 0) / max) * 100));
      return (
        <div className="min-w-0">
          {p.label ? <div className="mb-1 flex justify-between text-[11.5px] text-sol-text-muted"><span>{str(p.label)}</span><span className="tabular-nums">{Math.round(pct)}%</span></div> : null}
          <div className="h-1.5 rounded-full bg-sol-bg-alt overflow-hidden"><div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: tone(p.tone) ?? "var(--sol-blue)" }} /></div>
        </div>
      );
    }
    case "Divider": return p.label
      ? <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-sol-text-dim"><span className="h-px flex-1 bg-sol-border" />{str(p.label)}<span className="h-px flex-1 bg-sol-border" /></div>
      : <hr className="border-0 h-px bg-sol-border my-1" />;
    case "Spacer": return <div style={{ flexGrow: p.size === undefined ? 1 : undefined, height: space(p.size), width: space(p.size) }} />;
    case "Icon": return <DynamicIcon name={str(p.name) as any} size={typeof p.size === "number" ? p.size : 15} style={{ color: tone(p.tone), flexShrink: 0 }} />;
    case "Link": return <ModLink p={p} c={c} />;
    case "Image": {
      const src = str(p.src);
      if (!/^(https:|data:image\/)/.test(src)) return null;
      return <img src={src} alt={str(p.alt)} style={{ width: dim(p.width), height: dim(p.height), borderRadius: p.rounded ? 8 : undefined, maxWidth: "100%" }} />;
    }
    case "Kbd": return <span className="inline-flex gap-0.5">{str(p.keys).split("+").map((k) => <KeyCap key={k}>{k}</KeyCap>)}</span>;
    case "Stat": return <Stat p={p} />;
    case "Empty": return (
      <div className="flex flex-col items-center justify-center gap-1.5 py-8 text-center">
        {p.icon ? <DynamicIcon name={str(p.icon) as any} size={20} className="text-sol-text-dim" /> : null}
        <div className="text-[13px] text-sol-text-muted">{str(p.title)}</div>
        {p.hint ? <div className="text-[12px] text-sol-text-dim max-w-[340px]">{str(p.hint)}</div> : null}
      </div>
    );
    case "List": return <div className={`flex flex-col min-w-0 ${p.divided ? "divide-y divide-sol-border" : ""}`}><Children c={c} /></div>;
    case "Item": return <Item p={p} c={c} />;
    case "Time": return <TimeText at={p.at} format={p.format} />;
    case "Avatar": return <Avatar p={p} />;
    case "Sparkline": return <Sparkline p={p} />;
    default: return <Unknown t={n.t} />;
  }
});

export function ModTree({ tree, invoke, navigate }: { tree: ModNode | undefined; invoke: Invoke; navigate: Navigate }) {
  const value = useMemo(() => ({ invoke, navigate }), [invoke, navigate]);
  if (tree === undefined) return null;
  return <Ctx.Provider value={value}><Node n={tree} /></Ctx.Provider>;
}
