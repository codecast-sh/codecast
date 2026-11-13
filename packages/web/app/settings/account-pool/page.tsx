"use client";

// Settings › Account pool: the Claude accounts teammates put in a team's pool
// (convex/accountPool.ts), and who is spending which. Every member sees the
// whole split (sd-1687). Accounts join and leave the pool from the pill on
// their row in Settings › Claude Accounts; this page reads the store.

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Layers } from "lucide-react";
import { rankByHeadroom } from "@codecast/shared/contracts";
import { SettingsPanel, SettingsSection } from "../../../components/settings/ui";
import { AccountUsageBars } from "../../../components/AccountUsageMeter";
import { Button } from "../../../components/ui/button";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useMyTeams } from "../../../hooks/useDeviceSharing";
import { useAccountPool, useSyncAccountPool, type PoolAccount } from "../../../hooks/useSyncAccountPool";

const PERSON_TONES = ["--sol-cyan", "--sol-violet", "--sol-yellow", "--sol-green", "--sol-orange", "--sol-blue", "--sol-magenta", "--sol-red"];

const tokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${Math.round(n / 1e6)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const sum = (split: PoolAccount["split"]) => split.reduce((a, s) => a + s.tokens, 0);
const accountName = (r: PoolAccount) => r.profile_name ?? r.email.split("@")[0];

/** One team's pool: who spent which account (people × accounts), then each account. */
function TeamPool({ teamName, rows, showTeam }: { teamName: string; rows: PoolAccount[]; showTeam: boolean }) {
  const now = useCoarseNow(60_000);
  const accounts = useMemo(() => rankByHeadroom(rows, now), [rows, now]);
  const people = useMemo(() => {
    const byId = new Map<string, { user_id: string; name: string; total: number }>();
    for (const r of rows) {
      for (const s of r.split) {
        const p = byId.get(s.user_id) ?? { user_id: s.user_id, name: s.name, total: 0 };
        p.total += s.tokens;
        byId.set(s.user_id, p);
      }
    }
    return [...byId.values()].sort((a, b) => b.total - a.total);
  }, [rows]);
  const tone = (userId: string) => PERSON_TONES[Math.max(0, people.findIndex((p) => p.user_id === userId)) % PERSON_TONES.length];
  const machines = rows.reduce((a, r) => a + r.machines, 0);
  const week = rows.reduce((a, r) => a + sum(r.split), 0);

  return (
    <SettingsSection
      title={showTeam ? teamName : "Who is spending which account"}
      icon={Layers}
      actions={
        <span className="text-[11px] tabular-nums text-sol-text-dim">
          {rows.length} account{rows.length === 1 ? "" : "s"} · {machines} machine{machines === 1 ? "" : "s"} · {tokens(week)} tokens, 7 days
        </span>
      }
    >
      {people.length > 0 ? (
        <div className="overflow-x-auto px-4 py-3 sm:px-5" data-pool-grid>
          <table className="w-full border-separate border-spacing-[3px] text-[11px]">
            <thead>
              <tr>
                <th />
                {accounts.map((a) => (
                  <th key={a._id} className="px-1 pb-1 text-center font-normal">
                    <div className="truncate font-medium text-sol-text">{accountName(a)}</div>
                    <div className="truncate text-[10px] text-sol-text-dim">{a.mine ? "you" : a.contributor_name}</div>
                  </th>
                ))}
                <th className="px-1 pb-1 text-right font-normal text-sol-text-dim">total</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.user_id}>
                  <td className="whitespace-nowrap pr-2 text-sol-text">
                    <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: `var(${tone(p.user_id)})` }} />
                    {p.name}
                  </td>
                  {accounts.map((a) => {
                    const total = sum(a.split);
                    const mine = a.split.find((s) => s.user_id === p.user_id)?.tokens ?? 0;
                    const share = total ? mine / total : 0;
                    return (
                      <td
                        key={a._id}
                        data-tip={mine ? `${p.name}: ${tokens(mine)} of ${tokens(total)} on ${a.email} this week` : undefined}
                        className={`rounded px-1 py-1.5 text-center tabular-nums ${share >= 0.5 ? "font-semibold text-sol-bg" : mine ? "text-sol-text" : "text-sol-text-dim"}`}
                        style={{ background: mine ? `color-mix(in srgb, var(--sol-cyan) ${Math.round(12 + share * 78)}%, transparent)` : "var(--sol-bg-alt)" }}
                      >
                        {mine ? `${Math.round(share * 100)}%` : "·"}
                      </td>
                    );
                  })}
                  <td className="pl-2 text-right font-medium tabular-nums text-sol-text">{tokens(p.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="px-4 py-3 text-[11px] text-sol-text-dim sm:px-5">Nobody has run on the pool this week.</div>
      )}

      {accounts.map((a) => {
        const total = sum(a.split);
        return (
          <div key={a._id} className="border-t border-sol-border/60 px-4 py-2.5 sm:px-5" data-pool-account={a.email}>
            <div className="flex items-center gap-2.5">
              <span className="h-2 w-2 shrink-0 rounded-full bg-sol-green" />
              <span className="text-sm font-medium text-sol-text">{accountName(a)}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-sol-text-muted">{a.email}</span>
              <span className="shrink-0 rounded bg-sol-cyan/10 px-1.5 py-0.5 text-[10px] text-sol-cyan">
                from {a.mine ? "you" : a.contributor_name}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-sol-text-dim">
                {a.machines} machine{a.machines === 1 ? "" : "s"}
              </span>
            </div>
            <div className="mt-2 pl-[18px]">
              <AccountUsageBars usage={a.usage} now={now} />
            </div>
            {total > 0 && (
              <div className="mt-2 ml-[18px] flex h-1.5 overflow-hidden rounded-full bg-sol-bg-alt" aria-label="Who spent this account this week">
                {a.split.map((s) => (
                  <i key={s.user_id} data-tip={`${s.name}: ${tokens(s.tokens)}`} style={{ width: `${(100 * s.tokens) / total}%`, background: `var(${tone(s.user_id)})` }} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </SettingsSection>
  );
}

export default function AccountPoolSettings() {
  useSyncAccountPool();
  const rows = useAccountPool();
  const teams = useMyTeams();
  const router = useRouter();
  const byTeam = useMemo(() => {
    const groups = new Map<string, PoolAccount[]>();
    for (const r of rows) groups.set(String(r.team_id), [...(groups.get(String(r.team_id)) ?? []), r]);
    return [...groups.entries()];
  }, [rows]);

  return (
    <SettingsPanel>
      {byTeam.length === 0 && (
        <SettingsSection title="Account pool" icon={Layers} padded>
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm text-sol-text">No shared accounts yet</div>
            <Button size="sm" variant="outline" onClick={() => router.push("/settings/claude-accounts")}>
              Share one from Claude Accounts
            </Button>
          </div>
        </SettingsSection>
      )}
      {byTeam.map(([teamId, list]) => (
        <TeamPool
          key={teamId}
          teamName={teams.find((t) => String(t._id) === teamId)?.name ?? "Team"}
          rows={list}
          showTeam={byTeam.length > 1}
        />
      ))}
      {byTeam.length > 0 && (
        <div className="flex justify-end px-1">
          <Button size="sm" variant="ghost" className="text-[11px]" onClick={() => router.push("/settings/claude-accounts")}>
            Share or take back an account
          </Button>
        </div>
      )}
    </SettingsPanel>
  );
}
