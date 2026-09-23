import { autonomyOn } from "@codecast/shared/contracts/roleAutonomy";
import { useState } from "react";
import { captureException } from "@sentry/react";
import { Section } from "../identity/RoleScopeView";
import { useTemplateActions, useTemplateInstance } from "../../hooks/useTemplateHire";

// A template role's right column, under its project card (docs/architecture/
// org-hire.md H5 to H8, H11): the setup list with the one open item first,
// what it may do (trust, authority), the routines with what each still needs
// and one Activate per ready routine, the scoreboard, and the release. Shown
// only when the role has an instance; an ordinary role renders nothing.

export function TemplateSections({ roleId, canEdit }: { roleId: string; canEdit: boolean }) {
  const { instance } = useTemplateInstance(roleId);
  const { markSetup, activate } = useTemplateActions();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!instance) return null;
  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await run(); } catch (e) { captureException(e); setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const now = Date.now();
  const setup = (instance.setup ?? []) as any[];
  const open = setup.filter((s) => s.status === "open");
  const authority = ((instance.authority ?? []) as any[]).filter((g) => !g.expires_at || g.expires_at > now);
  const routines = (instance.routines ?? []) as any[];
  const readiness = instance.readiness ?? {};
  const age = (at?: number) => at ? `${Math.max(1, Math.round((now - at) / 3_600_000))}h ago` : "";
  return (
    <div data-scope-template={instance.instance}>
      {instance.phase === "awaiting_host" && (
        <Section density="page" label="Host step" name="template-host">
          <p className="px-2.5 pb-1.5 text-[12px] leading-relaxed text-sol-yellow" data-template-host-step>Run <code style={{ fontFamily: "var(--font-mono)" }}>cast org template bind {instance.instance}</code> in the project&apos;s checkout to pin the release and create the routines, paused.</p>
        </Section>
      )}
      {setup.length > 0 && (
        <Section density="page" label="Setup" name="template-setup">
          {instance.ask && <p className="px-2.5 pb-1 text-[12px] text-sol-yellow" data-template-ask={instance.ask.id}>Waiting on you: {instance.ask.title}{instance.ask.unlocks?.length ? ` (unlocks ${instance.ask.unlocks.join(", ")})` : ""}</p>}
          <ul className="space-y-0.5 px-2.5 pb-1.5 text-[12px]">
            {setup.map((s) => (
              <li key={s.id} className="flex items-start gap-2" data-template-setup-item={s.id} data-status={s.status}>
                <span className={s.status === "done" ? "text-sol-green" : s.status === "skipped" ? "text-sol-text-dim" : "text-sol-text"}>{s.status === "done" ? "done" : s.status === "skipped" ? "skipped" : s.who === "human" ? "you" : "the role"}</span>
                <span className={s.status === "open" ? "text-sol-text" : "text-sol-text-muted"}>{s.title}{s.price ? <span className="text-sol-text-dim"> · {s.price}</span> : null}</span>
                {canEdit && s.who === "human" && s.status === "open" && <button type="button" disabled={busy === s.id} onClick={() => void act(s.id, () => markSetup(instance.instance_key, s.id, "done"))} className="ml-auto shrink-0 rounded-md border border-sol-border/50 px-2 py-0.5 text-[11px] text-sol-text hover:bg-sol-bg-highlight disabled:opacity-50">Done</button>}
              </li>
            ))}
          </ul>
          {open.length === 0 && <p className="px-2.5 pb-1 text-[12px] text-sol-text-dim">Every setup step is done.</p>}
        </Section>
      )}
      <Section density="page" label="What it may do" name="template-authority">
        <ul className="space-y-0.5 px-2.5 pb-1.5 text-[12px] text-sol-text-muted">
          <li>Starts work on its own: <span className="text-sol-text">{autonomyOn(instance.trust) ? "on" : "off"}</span>{autonomyOn(instance.trust) ? "" : "; it reads and recommends inside codecast"}</li>
          <li data-template-authority={authority.length}>Authority outside codecast: {authority.length ? authority.map((g) => `${g.kind} (${g.label}${g.limit?.usd_per_month !== undefined ? `, up to $${g.limit.usd_per_month} a month` : g.limit?.usd_per_day !== undefined ? `, up to $${g.limit.usd_per_day} a day` : g.limit?.per_day !== undefined ? `, up to ${g.limit.per_day} a day` : ""}${g.expires_at ? `, until ${new Date(g.expires_at).toISOString().slice(0, 10)}` : ""})`).join("; ") : "none granted"}</li>
        </ul>
      </Section>
      {routines.length > 0 && (
        <Section density="page" label="Routines" name="template-routines">
          <ul className="space-y-1 px-2.5 pb-1.5 text-[12px]">
            {routines.map((r) => {
              const rd = readiness[r.id] ?? { ready: false, mode: "propose", missing: [] };
              const t = r.trigger;
              const state = r.external ? "external" : r.retired ? "retired" : !t ? "not created" : t.status === "paused" ? (rd.ready ? "paused, ready" : "paused, not ready") : t.status === "running" ? "running" : t.status === "scheduled" ? "active" : t.status;
              return (
                <li key={r.id} className="flex items-start gap-2" data-template-routine={r.id} data-state={state}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sol-text">{r.title} <span className="text-sol-text-dim">every {r.every} · {state}{t?.status === "scheduled" || t?.status === "running" ? `, ${rd.mode}` : ""}</span></p>
                    {rd.missing.length > 0 && <p className="text-sol-text-dim">{rd.missing.join("; ")}</p>}
                  </div>
                  {canEdit && t && t.status === "paused" && rd.ready && !r.external && <button type="button" disabled={busy === r.id} onClick={() => void act(r.id, () => activate(t.id))} className="shrink-0 rounded-md bg-sol-violet px-2 py-0.5 text-[11px] font-semibold text-sol-bg disabled:opacity-50">Activate</button>}
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      {(instance.scoreboard ?? []).length > 0 && (
        <Section density="page" label="Scoreboard" name="template-scoreboard">
          <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 px-2.5 pb-1.5 text-[12px]">
            {(instance.scoreboard as any[]).map((k) => <li key={k.key} className="flex justify-between gap-2"><span className="text-sol-text-muted">{k.label}</span><span className={k.value !== undefined ? "text-sol-text" : "text-sol-text-dim"} title={k.source ? `${k.source} · ${age(k.observed_at)}` : undefined}>{k.value ?? "—"}</span></li>)}
          </ul>
        </Section>
      )}
      <Section density="page" label="Template" name="template-release">
        <ul className="space-y-0.5 px-2.5 pb-1.5 text-[12px] text-sol-text-muted">
          <li>{instance.template?.name ?? instance.template_id} {instance.version} <span className="text-sol-text-dim">sha256 {String(instance.digest).slice(0, 12)}</span>{instance.host ? <span className="text-sol-text-dim"> · on {instance.host.machine}</span> : null}</li>
          {instance.update_available && <li className="text-sol-text" data-template-update={instance.update_available}>Update available: {instance.update_available}{instance.pending_upgrade ? ` (accepted; run cast org template bind ${instance.instance} --to ${instance.pending_upgrade.to})` : ""}</li>}
          {((instance.secrets ?? []) as any[]).map((s) => <li key={s.key} data-template-secret={s.key} data-bound={s.bound}>{s.label}: {s.bound ? <span className="text-sol-green">bound</span> : <span className="text-sol-yellow">missing · cast org template bind {instance.instance} --secret {s.key}=&lt;path&gt;</span>}</li>)}
        </ul>
      </Section>
      {error && <p role="alert" className="px-2.5 text-[12px] text-sol-red">{error}</p>}
    </div>
  );
}
