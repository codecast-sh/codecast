"use client";
// What predicts the goal, by level (contracts/envs.ts): each environment the
// goal names, lowest level first, with its latest score and interval, the
// spread of an unchanged arm, its measured link to the level above with the
// link's age, and what a run cost. Read from the store (hooks/useEnvStandings);
// drawn only for a goal that names an environment. The CLI writes the list
// (`cast goal envs`), because the envs are declared in the product's repo.
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { ENV_LEVEL_NAME, standingCost, type EnvStanding, type GoalEnv } from "@codecast/shared/contracts/envs";
import { useGoalEnvLevels } from "../../hooks/useEnvStandings";
import { compactAge } from "../../lib/threadState";
import { RecordSection as Section } from "./InitiativeRecord";

const DIM = "var(--sol-text-dim)";
const MUTED = "var(--sol-text-muted)";
const n3 = (x: number) => x.toFixed(3).replace(/^0\./, ".").replace(/^-0\./, "-.");

/** Its linked level's age past which a link reads as stale. */
const STALE_LINK_MS = 30 * 86_400_000;

function Score({ s }: { s: EnvStanding }) {
  const a = s.attempt;
  if (!a) return <span style={{ color: DIM }}>no run yet</span>;

  return (
    <span className="tabular-nums" title={`${a.short_id} · ${a.candidate.label}${a.candidate.sha ? `@${a.candidate.sha.slice(0, 8)}` : ""} · ${a.split} · n=${a.n}${a.ci95 ? ` · 95% [${n3(a.ci95[0])}, ${n3(a.ci95[1])}]` : ""}`}>
      <span style={{ color: "var(--sol-text)" }}>{n3(a.mean)}</span>
      {a.ci95 && <span style={{ color: MUTED }}> {n3(a.ci95[0])}–{n3(a.ci95[1])}</span>}
      <span style={{ color: DIM }}> n{a.n}</span>
    </span>
  );
}

function Noise({ s }: { s: EnvStanding }) {
  const noise = s.attempt?.noise;
  if (!noise) return <span style={{ color: DIM }} title="No A/A runs recorded: a change this small may be noise">noise ?</span>;
  return <span className="tabular-nums" style={{ color: MUTED }} title={`Spread of an unchanged arm over ${noise.aa_runs} runs`}>a/a ±{n3(noise.aa_sd)}</span>;
}

function LinkCell({ s, now }: { s: EnvStanding; now: number }) {
  const l = s.link;
  if (!l) return <span style={{ color: s.level === "L5" ? DIM : "var(--sol-yellow)" }} title="Not measured against the level above">{s.level === "L5" ? "" : "unlinked"}</span>;
  const stale = now - l.measured_at > STALE_LINK_MS;
  return (
    <span className="tabular-nums" style={{ color: stale ? "var(--sol-yellow)" : MUTED }} title={`${l.measure} ${l.value} to ${l.to}, n=${l.n}${l.evidence ? `, ${l.evidence}` : ""}`}>
      {l.measure} {l.value.toFixed(2)} → {l.to.slice(0, 2)} · {compactAge(now - l.measured_at)}
    </span>
  );
}

/** The env's case sets in codecast: each split's size, with the held set's fetches; versions and last scores on hover. Never a case. */
function CaseSetsCell({ s, now }: { s: EnvStanding; now: number }) {
  const sets = (["dev", "held"] as const).flatMap((split) => (s[split] ? [{ split, h: s[split]! }] : []));
  if (!sets.length) return <span />;
  const tip = sets
    .map(({ split, h }) => {
      const last = h.last_attempt;
      return [`${split === "dev" ? "Dev" : "Held"} set ${h.version}${h.label ? ` · ${h.label}` : ""}, uploaded ${compactAge(now - h.uploaded_at)} ago`, last ? `last ${split} ${last.short_id} ${n3(last.mean)} n${last.n} ${last.candidate}, ${compactAge(now - last.finished_at)} ago` : `no ${split} run yet`, `${h.reads} fetch${h.reads === 1 ? "" : "es"}${h.last_read_at ? `, last ${compactAge(now - h.last_read_at)} ago` : ""}${h.unfiled ? `, ${h.unfiled} with no attempt filed` : ""}`].join("\n");
    })
    .join("\n\n");
  return (
    <span className="tabular-nums" style={{ color: MUTED }} title={tip} data-env-case-sets>
      {sets.map(({ split, h }, i) => (
        <span key={split} data-env-case-set={split}>
          {i ? <span style={{ color: DIM }}> · </span> : null}
          {split} {h.size}
          {split === "held" ? <span style={{ color: DIM }}> {h.reads} read{h.reads === 1 ? "" : "s"}</span> : null}
          {h.unfiled ? <span style={{ color: "var(--sol-yellow)" }}> {h.unfiled} unfiled</span> : null}
        </span>
      ))}
    </span>
  );
}

/** One environment per row: level, title, score, noise, link, case sets, cost. */
export function GoalEnvLevels({ goal, now }: { goal: InitiativeRow; now: number }) {
  const envs = (goal as InitiativeRow & { envs?: GoalEnv[] }).envs;
  const levels = useGoalEnvLevels(envs, (goal as any).workspace);
  if (!levels.length) return null;
  return (
    <div className="mt-5" data-goal-env-levels>
      <Section name="envs" label="Predicted by" count={levels.length}>
        <div className="grid items-baseline gap-x-3 gap-y-1.5 text-[12.5px]" style={{ gridTemplateColumns: "auto minmax(0,1fr) auto auto auto auto auto" }}>
          {levels.map((s) => (
            <div key={s.env} className="contents" data-goal-env={s.env} data-level={s.level}>
              <span className="font-mono text-xs px-1 rounded-sm" style={{ color: "var(--sol-cyan)", background: "color-mix(in srgb, var(--sol-cyan) 12%, transparent)" }} title={ENV_LEVEL_NAME[s.level]}>{s.level}</span>
              <span className="min-w-0 truncate" style={{ color: "var(--sol-text-secondary)" }} title={`${s.env}${s.note ? ` · ${s.note}` : ""}`}>{s.title ?? s.env}</span>
              <Score s={s} />
              <Noise s={s} />
              <LinkCell s={s} now={now} />
              <CaseSetsCell s={s} now={now} />
              <span className="tabular-nums text-right" style={{ color: DIM }}>{standingCost(s) ?? ""}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
