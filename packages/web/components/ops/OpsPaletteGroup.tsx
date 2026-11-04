// The palette's Ops rows: a typed eg-N, mw-N, rp-N or src-N opens that item
// even when this device has not cached it (its page reads it by ref), a few
// words find issues, watches and replays by title from the store, and "ops"
// (or "ops <name>") lists each source's own Ops view as "Ops: <source>".
import { useMemo } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { BellRing, Bug, Film, Plug } from "lucide-react";
import { useOpsGroups, useOpsReplays, useOpsSources, useOpsWatches } from "../../hooks/useSyncOps";
import { groupClass, itemClass } from "../paletteStyles";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { opsHref, opsRefHref } from "./opsPaths";
import { issueAttention, replayName, watchAlerting } from "./opsHomeModel";
import { PALETTE_LIVE } from "../../lib/paletteActions";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { ATTENTION_CLOCK_MS } from "./useOpsAttention";
import { useSourceHealthMap } from "./useSourceHealth";
import type { OpsSource } from "./opsTypes";

/** `live` rows (alerting, regressed, escalating, or an exact name) rank first in the group and lift the group above sessions and tasks matching as well; an exact name leads. */
type OpsPaletteRow = { key: string; ref: string; kind: "issue" | "watch" | "replay" | "source"; title: string; href: string; status?: string; live?: boolean; exact?: boolean };

const CAP = 6;

/** A source row's place in the bare "ops" list: down, then degraded, then fine. */
const sourceRank = (r: OpsPaletteRow) => (r.live ? 0 : r.status ? 1 : 2);

const ICON = { issue: Bug, watch: BellRing, replay: Film, source: Plug } as const;

export function OpsPaletteGroup({ query, navigate }: { query: string; navigate: (href: string) => void }) {
  const groups = useOpsGroups();
  const watches = useOpsWatches();
  const replays = useOpsReplays();
  const sources = useOpsSources();
  const now = useCoarseNow(ATTENTION_CLOCK_MS);
  const health = useSourceHealthMap();
  const rows = useMemo<OpsPaletteRow[]>(() => {
    // A source's row wears its health's own label when something is wrong ("poll failing", "stopped"), the word the home, the Sources table and its overview use; a down one ranks live, as an alerting watch does.
    const sourceState = (src: OpsSource): Pick<OpsPaletteRow, "status" | "live"> => {
      const h = health.get(src._id);
      if (!h || (h.tone !== "bad" && h.tone !== "warn")) return {};
      return { status: h.label.toLowerCase(), live: h.level === "down" };
    };
    const q = query.trim().toLowerCase();
    const exact = opsRefHref(q);
    if (exact) {
      const named =
        exact.kind === "issue" ? groups.find((g) => g.short_id === exact.ref)?.title
        : exact.kind === "watch" ? watches.find((w) => w.short_id === exact.ref)?.name
        : exact.kind === "replay" ? (() => { const r = replays.find((x) => x.short_id === exact.ref); return r ? replayName(r) : undefined; })()
        : sources.find((s) => s.short_id === exact.ref)?.name;
      return [{ key: exact.ref, ref: exact.ref, kind: exact.kind, title: named ?? `Open ${exact.ref}`, href: exact.href }];
    }
    const out: OpsPaletteRow[] = [];
    // "ops", "ops posth": each source as a destination under Ops.
    const opsWord = /^ops(?::|\s|$)/.exec(q);
    if (opsWord) {
      const rest = q.slice(opsWord[0].length).trim();
      for (const s of sources) {
        if (rest && !s.name.toLowerCase().includes(rest)) continue;
        const st = sourceState(s);
        const exactHit = !!rest && s.name.toLowerCase() === rest;
        out.push({ key: `dest-${s._id}`, ref: s.short_id, kind: "source", title: `Ops: ${s.name}`, href: opsHref.home({ source: s.name }), status: st.status, live: exactHit || st.live, exact: exactHit });
      }
      // What is down first, then what is degraded, then the rest, each in the sources' order.
      if (!rest) return out.map((r, i) => ({ r, i })).sort((a, b) => sourceRank(a.r) - sourceRank(b.r) || a.i - b.i).map((x) => x.r).slice(0, CAP);
    }
    if (q.length < 3) return out.slice(0, CAP);
    const hit = (s: string | null | undefined) => !!s && s.toLowerCase().includes(q);
    // A query that is exactly a source's or a watch's name means that one: it leads the group and the group leads the palette.
    const exactName = (s: string | null | undefined) => !!s && s.toLowerCase() === q;
    for (const w of watches) {
      if (!hit(w.name)) continue;
      const alerting = watchAlerting(w) && !(w.muted_until && w.muted_until > now);
      out.push({ key: w._id, ref: w.short_id, kind: "watch", title: w.name, href: opsHref.metric(w.short_id || w._id), status: alerting ? "alerting" : w.state === "alert" ? "muted" : undefined, live: alerting || exactName(w.name), exact: exactName(w.name) });
    }
    for (const g of groups) {
      if (!hit(g.title) && !hit(g.culprit)) continue;
      const state = issueAttention(g, now)?.state;
      out.push({ key: g._id, ref: g.short_id, kind: "issue", title: g.title, href: opsHref.issue(g.short_id || g._id), status: state ?? g.status, live: state === "regressed" || state === "escalating" });
    }
    for (const s of sources) if (hit(s.name) && !out.some((r) => r.key === `dest-${s._id}`)) {
      const st = sourceState(s);
      out.push({ key: s._id, ref: s.short_id, kind: "source", title: `Ops: ${s.name}`, href: opsHref.home({ source: s.name }), status: st.status, live: exactName(s.name) || st.live, exact: exactName(s.name) });
    }
    for (const r of replays) if (hit(r.url) || hit(r.user?.email)) out.push({ key: r._id, ref: r.short_id, kind: "replay", title: replayName(r), href: opsHref.replay(r.short_id || r._id) });
    // What is live first, then what is open, keeping each kind's order.
    const rank = (r: OpsPaletteRow) => (r.exact ? -1 : r.live ? 0 : r.status === "new" || r.status === "open" ? 1 : 2);
    return out.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r).slice(0, CAP);
  }, [query, groups, watches, replays, sources, now, health]);

  if (!rows.length) return null;
  return (
    <CommandPrimitive.Group heading="Ops" className={groupClass}>
      {rows.map((r) => {
        const Icon = ICON[r.kind];
        return (
          <CommandPrimitive.Item key={`ops-${r.key}`} value={`${r.live ? PALETTE_LIVE : "__entity__"} ${r.ref} ${r.title}|||ops-${r.key}`} data-palette-type={`ops_${r.kind}`} data-palette-short-id={r.ref} onSelect={() => navigate(r.href)} className={itemClass}>
            <Icon className="w-4 h-4 flex-shrink-0 text-sol-red" />
            <span className="font-mono text-[11px] text-sol-text-dim flex-shrink-0">{r.ref}</span>
            <span className="flex-1 truncate">{r.title}</span>
            {r.status && <span className={`text-[10px] flex-shrink-0 ${r.live ? "text-sol-red font-semibold" : r.kind === "source" ? "text-sol-orange font-semibold" : "text-sol-text-dim"}`}>{r.status}</span>}
            <KeyCap size="xs">↵</KeyCap>
          </CommandPrimitive.Item>
        );
      })}
    </CommandPrimitive.Group>
  );
}
