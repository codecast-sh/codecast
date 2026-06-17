"use client";
// The "switchboard" — sessions as a constellation of nodes with curved edges for
// every pair that has exchanged a `cast send`, and little signal packets that fly
// along each edge in the direction the message travelled. Layout is a deterministic
// force simulation (seeded on a circle, no randomness) run in the container's OWN
// aspect ratio so it fills the pane at any size, and memoized on the graph shape so
// live-status polling re-colors nodes without ever reshuffling them.
import { useEffect, useMemo, useRef, useState } from "react";

export type GNode = {
  id: string;
  shortId: string;
  title: string | null;
  projectPath?: string | null;
  weight: number; // total messages in+out, drives radius
  hue: string; // stable identity color
  live: boolean;
  resolved: boolean;
  isSubagent?: boolean;
};

export type GEdge = {
  from: string;
  to: string;
  count: number;
  lastAt: number;
  key: string;
};

const ACCENTS = [
  "#268bd2", // blue
  "#2aa198", // cyan
  "#859900", // green
  "#6c71c4", // violet
  "#d33682", // magenta
  "#b58900", // yellow
  "#cb4b16", // orange
];

export function hueFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

function radius(weight: number): number {
  return 7 + Math.sqrt(weight) * 2.6;
}

function layout(
  nodes: GNode[],
  edges: GEdge[],
  W: number,
  H: number
): Map<string, { x: number; y: number }> {
  const n = nodes.length;
  const pos = new Map<string, { x: number; y: number }>();
  if (n === 0) return pos;
  // Seed on an ellipse matching the canvas, deterministically by index.
  const Rx = W * 0.4;
  const Ry = H * 0.4;
  nodes.forEach((nd, i) => {
    const a = (i / n) * Math.PI * 2;
    pos.set(nd.id, { x: W / 2 + Math.cos(a) * Rx, y: H / 2 + Math.sin(a) * Ry });
  });
  if (n === 1) {
    pos.set(nodes[0].id, { x: W / 2, y: H / 2 });
    return pos;
  }

  const area = W * H;
  const k = Math.sqrt(area / n) * 0.8; // ideal edge length
  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
  let temp = Math.min(W, H) * 0.16;
  const iters = 320;

  for (let step = 0; step < iters; step++) {
    const disp = nodes.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      const pi = pos.get(nodes[i].id)!;
      for (let j = i + 1; j < n; j++) {
        const pj = pos.get(nodes[j].id)!;
        let dx = pi.x - pj.x;
        let dy = pi.y - pj.y;
        let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const rep = (k * k) / d;
        const ux = dx / d;
        const uy = dy / d;
        disp[i].x += ux * rep;
        disp[i].y += uy * rep;
        disp[j].x -= ux * rep;
        disp[j].y -= uy * rep;
      }
    }
    for (const e of edges) {
      const a = idx.get(e.from);
      const b = idx.get(e.to);
      if (a == null || b == null || a === b) continue;
      const pa = pos.get(e.from)!;
      const pb = pos.get(e.to)!;
      let dx = pa.x - pb.x;
      let dy = pa.y - pb.y;
      let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const w = 1 + Math.log2(1 + e.count) * 0.5;
      const att = ((d * d) / k) * w;
      const ux = dx / d;
      const uy = dy / d;
      disp[a].x -= ux * att;
      disp[a].y -= uy * att;
      disp[b].x += ux * att;
      disp[b].y += uy * att;
    }
    for (let i = 0; i < n; i++) {
      const p = pos.get(nodes[i].id)!;
      disp[i].x += (W / 2 - p.x) * 0.008;
      disp[i].y += (H / 2 - p.y) * 0.008;
    }
    for (let i = 0; i < n; i++) {
      const p = pos.get(nodes[i].id)!;
      const dlen = Math.sqrt(disp[i].x * disp[i].x + disp[i].y * disp[i].y) || 0.01;
      p.x += (disp[i].x / dlen) * Math.min(dlen, temp);
      p.y += (disp[i].y / dlen) * Math.min(dlen, temp);
    }
    temp *= 0.985;
  }

  // Fit the force result to the canvas FIRST...
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const padX = Math.min(80, W * 0.08);
  const padY = Math.min(70, H * 0.07);
  const sx = (W - padX * 2) / Math.max(maxX - minX, 1);
  const sy = (H - padY * 2) / Math.max(maxY - minY, 1);
  const s = Math.min(sx, sy);
  const offX = (W - (maxX - minX) * s) / 2;
  const offY = (H - (maxY - minY) * s) / 2;
  for (const p of pos.values()) {
    p.x = offX + (p.x - minX) * s;
    p.y = offY + (p.y - minY) * s;
  }

  // ...THEN spread overlapping disks apart in FINAL canvas coordinates, so the
  // gap survives (a pre-fit pass gets rescaled away and edges vanish under nodes).
  // Connected nodes still cluster, but never stack — every edge shows a segment.
  for (let pass = 0; pass < 40; pass++) {
    for (let i = 0; i < n; i++) {
      const pi = pos.get(nodes[i].id)!;
      const ri = radius(nodes[i].weight);
      for (let j = i + 1; j < n; j++) {
        const pj = pos.get(nodes[j].id)!;
        const rj = radius(nodes[j].weight);
        let dx = pi.x - pj.x;
        let dy = pi.y - pj.y;
        let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const minD = ri + rj + 34;
        if (d < minD) {
          const push = (minD - d) / 2;
          const ux = dx / d;
          const uy = dy / d;
          pi.x += ux * push; pi.y += uy * push;
          pj.x -= ux * push; pj.y -= uy * push;
        }
      }
    }
    // Keep everyone inside the frame.
    for (const p of pos.values()) {
      p.x = Math.max(padX, Math.min(W - padX, p.x));
      p.y = Math.max(padY, Math.min(H - padY, p.y));
    }
  }
  return pos;
}

function curve(a: { x: number; y: number }, b: { x: number; y: number }, bend: number) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ox = (-dy / len) * bend;
  const oy = (dx / len) * bend;
  return `M ${a.x} ${a.y} Q ${mx + ox} ${my + oy} ${b.x} ${b.y}`;
}

export function SessionConstellation({
  nodes,
  edges,
  selectedId,
  pulseKey,
  onSelect,
  onOpen,
}: {
  nodes: GNode[];
  edges: GEdge[];
  selectedId: string | null;
  pulseKey?: string | null;
  onSelect: (id: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 900, h: 620 });
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.max(360, el.clientWidth);
      const h = Math.max(320, el.clientHeight);
      setDims((d) => (Math.abs(d.w - w) < 8 && Math.abs(d.h - h) < 8 ? d : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = dims.w;
  const H = dims.h;
  // Re-solve the layout only when the TOPOLOGY changes (which sessions exist and
  // which pairs talk) — not when an existing edge's count ticks up. Otherwise a
  // live message arriving every few seconds would reshuffle the whole map and yank
  // nodes out from under the cursor. Counts still drive radius/thickness at render.
  const topoSig = useMemo(() => {
    const ns = nodes.map((n) => n.id).sort().join(",");
    const es = edges.map((e) => `${e.from}>${e.to}`).sort().join(",");
    return `${ns}|${es}|${W}x${H}`;
  }, [nodes, edges, W, H]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pos = useMemo(() => layout(nodes, edges, W, H), [topoSig]);
  const now = Date.now();

  const reverse = useMemo(() => new Set(edges.map((e) => `${e.from}>${e.to}`)), [edges]);

  const focus = hover ?? selectedId;
  const neighbors = useMemo(() => {
    if (!focus) return null;
    const set = new Set<string>([focus]);
    for (const e of edges) {
      if (e.from === focus) set.add(e.to);
      if (e.to === focus) set.add(e.from);
    }
    return set;
  }, [focus, edges]);

  const labeledIds = useMemo(() => {
    if (nodes.length <= 11) return new Set(nodes.map((n) => n.id));
    // Greedy by weight: a hub keeps its always-on label only if its text box
    // doesn't collide with one already placed — so dense centers don't smear.
    const cand = [...nodes].sort((a, b) => b.weight - a.weight).slice(0, 16);
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const out = new Set<string>();
    for (const nd of cand) {
      const p = pos.get(nd.id);
      if (!p) continue;
      const box = { x0: p.x - 72, x1: p.x + 72, y0: p.y + 6, y1: p.y + 34 };
      const hit = placed.some(
        (b) => !(box.x1 < b.x0 || box.x0 > b.x1 || box.y1 < b.y0 || box.y0 > b.y1)
      );
      if (hit) continue;
      placed.push(box);
      out.add(nd.id);
      if (out.size >= 9) break;
    }
    return out;
  }, [nodes, pos]);

  if (nodes.length === 0) return null;

  return (
    <div ref={wrapRef} className="w-full h-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-full block select-none"
        preserveAspectRatio="xMidYMid meet"
        onClick={() => onSelect(null)}
      >
        <defs>
          <radialGradient id="con-vignette" cx="50%" cy="42%" r="75%">
            <stop offset="0%" stopColor="var(--sol-blue)" stopOpacity={0.06} />
            <stop offset="100%" stopColor="var(--sol-blue)" stopOpacity={0} />
          </radialGradient>
          <pattern id="con-grid" width="34" height="34" patternUnits="userSpaceOnUse">
            <path d="M 34 0 L 0 0 0 34" fill="none" stroke="var(--sol-border)" strokeOpacity={0.08} strokeWidth={1} />
          </pattern>
          <filter id="con-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect x={0} y={0} width={W} height={H} fill="url(#con-grid)" />
        <rect x={0} y={0} width={W} height={H} fill="url(#con-vignette)" />

        {/* Edges */}
        <g>
          {edges.map((e) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const node = nodes.find((n) => n.id === e.from);
            const hue = node?.hue ?? "#268bd2";
            const bidir = reverse.has(`${e.to}>${e.from}`);
            const bend = bidir ? 26 : 10;
            const d = curve(a, b, bend);
            const active = !neighbors || (neighbors.has(e.from) && neighbors.has(e.to));
            const recent = now - e.lastAt < 1000 * 60 * 30;
            const pulsing = pulseKey === e.key;
            const sw = 1.2 + Math.log2(1 + e.count) * 1.15;
            const packets = active ? Math.min(3, 1 + Math.floor(e.count / 4)) : 0;
            const dur = recent ? 2.4 : 4.2;
            const pid = `edge-${e.key}`;
            const glowy = e.count >= 3 || pulsing;
            return (
              <g key={e.key} opacity={active ? 1 : 0.1} style={{ transition: "opacity .25s" }}>
                {glowy && (
                  <path d={d} fill="none" stroke={hue} strokeOpacity={pulsing ? 0.35 : 0.18}
                    strokeWidth={sw + 4} strokeLinecap="round" filter="url(#con-glow)" />
                )}
                <path id={pid} d={d} fill="none" stroke={hue} strokeOpacity={pulsing ? 0.95 : 0.55}
                  strokeWidth={pulsing ? sw + 1.5 : sw} strokeLinecap="round" />
                {Array.from({ length: packets }).map((_, kk) => (
                  <circle key={kk} r={pulsing ? 3.8 : 2.7} fill="#ffffff" stroke={hue} strokeWidth={1.4} filter="url(#con-glow)">
                    <animateMotion dur={`${dur}s`} begin={`${(kk * dur) / packets}s`} repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
                      <mpath href={`#${pid}`} />
                    </animateMotion>
                  </circle>
                ))}
              </g>
            );
          })}
        </g>

        {/* Nodes */}
        <g>
          {nodes.map((nd) => {
            const p = pos.get(nd.id);
            if (!p) return null;
            const r = radius(nd.weight);
            const dim = neighbors ? !neighbors.has(nd.id) : false;
            const isFocus = focus === nd.id;
            const labelOn =
              isFocus || labeledIds.has(nd.id) || (!!neighbors && neighbors.has(nd.id));
            const title = nd.title || (nd.resolved ? "Untitled session" : nd.shortId);
            return (
              <g
                key={nd.id}
                transform={`translate(${p.x},${p.y})`}
                opacity={dim ? 0.22 : 1}
                style={{ transition: "opacity .25s", cursor: "pointer" }}
                onMouseEnter={() => setHover(nd.id)}
                onMouseLeave={() => setHover(null)}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onSelect(selectedId === nd.id ? null : nd.id);
                }}
                onDoubleClick={(ev) => {
                  ev.stopPropagation();
                  if (nd.resolved) onOpen(nd.id);
                }}
              >
                {nd.live && (
                  <circle r={r + 5} fill="none" stroke={nd.hue} strokeWidth={1.5} opacity={0.5}>
                    <animate attributeName="r" values={`${r + 3};${r + 12};${r + 3}`} dur="2.4s" repeatCount="indefinite" />
                    <animate attributeName="opacity" values="0.5;0;0.5" dur="2.4s" repeatCount="indefinite" />
                  </circle>
                )}
                <circle r={r + 3} fill={nd.hue} opacity={0.16} filter="url(#con-glow)" />
                <circle
                  r={r}
                  fill={nd.resolved ? nd.hue : "var(--sol-bg-alt)"}
                  fillOpacity={nd.resolved ? 0.92 : 0.4}
                  stroke={isFocus ? "var(--sol-text)" : nd.hue}
                  strokeWidth={isFocus ? 2.4 : 1.4}
                  strokeDasharray={nd.resolved ? undefined : "3 3"}
                />
                {nd.isSubagent && <circle r={r * 0.42} fill="var(--sol-bg)" fillOpacity={0.55} />}
                {labelOn && (
                  <g>
                    <text y={r + 15} textAnchor="middle" fontSize={12} fontWeight={600}
                      fill="var(--sol-text)" style={{ paintOrder: "stroke", pointerEvents: "none" }}
                      stroke="var(--sol-bg)" strokeWidth={3}>
                      {title.length > 26 ? title.slice(0, 24) + "…" : title}
                    </text>
                    <text y={r + 29} textAnchor="middle" fontSize={9.5} fontFamily="var(--font-mono)"
                      fill="var(--sol-text-dim)" style={{ pointerEvents: "none" }}>
                      {nd.shortId}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
