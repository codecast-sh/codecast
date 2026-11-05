// The weekly card itself, drawn at 1200x630 (the social image size). One
// markup for three places: the owner's preview at /week, the public page at
// /share/card/<token>, and the PNG a link unfurls to (server/weekCardImage.ts
// hands this same element to satori). So it keeps to what satori lays out:
// inline styles, flex boxes, literal colors, no hooks, no classes.
import {
  DEVICE_KIND_LABEL,
  WEEK_CARD_H,
  WEEK_CARD_INSTALL,
  WEEK_CARD_W,
  WEEK_DAY_NAMES,
  formatCount,
  weekRangeLabel,
  type WeekCardStats,
} from "@codecast/shared/contracts/weeklyCard";

// Solarized dark, the product's own palette.
const C = {
  bg: "#002b36",
  panel: "#073642",
  line: "#0d4654",
  dim: "#586e75",
  muted: "#839496",
  text: "#eee8d5",
  bright: "#fdf6e3",
  cyan: "#2aa198",
  yellow: "#b58900",
  green: "#859900",
  blue: "#268bd2",
  magenta: "#d33682",
  orange: "#cb4b16",
  violet: "#6c71c4",
};
const AGENT_COLORS = [C.cyan, C.blue, C.magenta, C.yellow, C.violet, C.orange, C.green];

const row = (extra: Record<string, unknown> = {}) => ({ display: "flex", flexDirection: "row" as const, ...extra });
const col = (extra: Record<string, unknown> = {}) => ({ display: "flex", flexDirection: "column" as const, ...extra });

function Figure({ value, label, accent }: { value: string; label: string; accent?: string }) {
  return (
    <div style={col({ gap: 4 })}>
      <div style={{ display: "flex", fontSize: 44, fontWeight: 700, color: accent ?? C.bright, lineHeight: 1 }}>{value}</div>
      <div style={{ display: "flex", fontSize: 19, color: C.muted }}>{label}</div>
    </div>
  );
}

function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0]?.slice(0, 2) ?? "·").toUpperCase();
}

export function WeekCardView({ stats, name }: { stats: WeekCardStats; name: string | null }) {
  const maxHours = Math.max(1, ...stats.days.map((d) => d.hours));
  const totalAgentSessions = stats.agents.reduce((t, a) => t + a.sessions, 0) || 1;
  const agents = stats.agents.slice(0, 5);
  const otherAgents = stats.agents.slice(5).reduce((t, a) => t + a.sessions, 0);
  const shares = otherAgents ? [...agents, { name: "Other", sessions: otherAgents }] : agents;
  const busiest = stats.busiest_day >= 0 ? stats.days[stats.busiest_day] : null;
  const machines = stats.machines.kinds.map((k) => `${k.count} ${DEVICE_KIND_LABEL[k.kind]}${k.count === 1 || k.kind === "linux" ? "" : "s"}`).join(" · ");
  const pct = (n: number) => {
    const p = (n / totalAgentSessions) * 100;
    return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
  };
  const extras: Array<[string, string]> = [];
  if (busiest) extras.push(["busiest day", `${WEEK_DAY_NAMES[stats.busiest_day]} · ${busiest.hours}h`]);
  if (stats.active_days > 0) extras.push(["per active day", `${Math.round((stats.agent_hours / stats.active_days) * 10) / 10}h`]);
  if (stats.tokens !== null) extras.push(["tokens", formatCount(stats.tokens)]);

  return (
    <div
      style={col({
        width: WEEK_CARD_W,
        height: WEEK_CARD_H,
        backgroundColor: C.bg,
        backgroundImage: `radial-gradient(circle at 88% 0%, ${C.panel} 0%, ${C.bg} 55%)`,
        color: C.text,
        fontFamily: "JetBrains Mono",
        padding: "44px 56px 36px",
        boxSizing: "border-box",
        lineHeight: 1.2,
        overflow: "hidden",
      })}
    >
      {/* Who and when */}
      <div style={row({ alignItems: "center", justifyContent: "space-between" })}>
        <div style={row({ alignItems: "center", gap: 18 })}>
          <div style={row({ width: 56, height: 56, borderRadius: 28, backgroundColor: C.cyan, color: C.bg, fontSize: 22, fontWeight: 700, alignItems: "center", justifyContent: "center" })}>
            {initials(name)}
          </div>
          <div style={col({ gap: 2 })}>
            <div style={{ display: "flex", fontSize: 28, fontWeight: 700, color: C.bright }}>{name ? `${name}'s week with agents` : "A week with coding agents"}</div>
            <div style={{ display: "flex", fontSize: 20, color: C.muted }}>
              {weekRangeLabel(stats)}{stats.partial ? " · so far" : ""}
            </div>
          </div>
        </div>
        <div style={row({ alignItems: "center", gap: 10, fontSize: 22, fontWeight: 700, color: C.muted })}>
          <div style={{ display: "flex", width: 14, height: 14, borderRadius: 7, backgroundColor: C.green }} />
          codecast
        </div>
      </div>

      {/* Numbers and the week */}
      <div style={row({ flexGrow: 1, minHeight: 0, marginTop: 30, gap: 48 })}>
        <div style={col({ width: 470, justifyContent: "space-between" })}>
          <div style={col({ gap: 4 })}>
            <div style={{ display: "flex", fontSize: 112, fontWeight: 700, color: C.bright, lineHeight: 1, letterSpacing: "-0.04em" }}>{formatCount(stats.sessions)}</div>
            <div style={{ display: "flex", fontSize: 22, color: C.muted }}>agent sessions</div>
          </div>
          <div style={row({ gap: 40 })}>
            <Figure value={`${stats.agent_hours}h`} label="agents working" accent={C.cyan} />
            <Figure value={`${stats.active_days}/7`} label="active days" />
            <Figure value={String(stats.machines.count)} label={stats.machines.count === 1 ? "machine" : "machines"} />
          </div>
          {machines ? <div style={{ display: "flex", fontSize: 18, color: C.dim }}>{machines}</div> : <div style={{ display: "flex" }} />}
        </div>

        <div style={col({ flexGrow: 1, gap: 12 })}>
          <div style={row({ height: 252, alignItems: "flex-end", gap: 14 })}>
            {stats.days.map((d, i) => {
              const best = i === stats.busiest_day;
              return (
                <div key={i} style={col({ flexGrow: 1, flexBasis: 0, alignItems: "center", justifyContent: "flex-end", gap: 8 })}>
                  <div style={{ display: "flex", fontSize: 17, color: best ? C.yellow : C.dim }}>{d.hours ? `${d.hours}h` : ""}</div>
                  <div
                    style={{
                      display: "flex",
                      width: "100%",
                      height: Math.max(4, Math.round((d.hours / maxHours) * 190)),
                      borderRadius: 6,
                      backgroundColor: d.hours ? (best ? C.yellow : C.cyan) : C.line,
                    }}
                  />
                  <div style={{ display: "flex", fontSize: 17, color: best ? C.text : C.muted }}>{WEEK_DAY_NAMES[i]}</div>
                </div>
              );
            })}
          </div>
          <div style={row({ gap: 24, paddingTop: 14, borderTop: `1px solid ${C.line}` })}>
            {extras.map(([k, v]) => (
              <div key={k} style={col({ flexGrow: 1, flexBasis: 0, gap: 4 })}>
                <div style={{ display: "flex", fontSize: 26, fontWeight: 700, color: k === "busiest day" ? C.yellow : C.text }}>{v}</div>
                <div style={{ display: "flex", fontSize: 17, color: C.dim }}>{k}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Agents by share of sessions */}
      <div style={col({ marginTop: 26, gap: 10 })}>
        <div style={row({ height: 14, borderRadius: 7, overflow: "hidden", backgroundColor: C.line })}>
          {shares.map((a, i) => (
            <div key={a.name} style={{ display: "flex", width: `${(a.sessions / totalAgentSessions) * 100}%`, height: "100%", backgroundColor: AGENT_COLORS[i % AGENT_COLORS.length] }} />
          ))}
        </div>
        <div style={row({ gap: 26, flexWrap: "wrap" })}>
          {shares.map((a, i) => (
            <div key={a.name} style={row({ alignItems: "center", gap: 8, fontSize: 18 })}>
              <div style={{ display: "flex", width: 10, height: 10, borderRadius: 5, backgroundColor: AGENT_COLORS[i % AGENT_COLORS.length] }} />
              <div style={{ display: "flex", color: C.text }}>{a.name}</div>
              <div style={{ display: "flex", color: C.dim }}>{pct(a.sessions)}</div>
            </div>
          ))}
          {stats.projects.length > 0 && (
            <div style={row({ gap: 8, fontSize: 18, marginLeft: "auto", color: C.muted })}>
              {stats.projects.slice(0, 3).map((p) => p.name).join(" · ")}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={row({ marginTop: 22, paddingTop: 16, borderTop: `1px solid ${C.line}`, justifyContent: "space-between", alignItems: "center", fontSize: 18 })}>
        <div style={row({ color: C.muted, gap: 8 })}>
          Made with <span style={{ color: C.text, fontWeight: 700 }}>Codecast</span>
        </div>
        <div style={row({ gap: 12 })}>
          <span style={{ color: C.green }}>$</span>
          <span style={{ color: C.muted }}>{WEEK_CARD_INSTALL}</span>
        </div>
      </div>
    </div>
  );
}
