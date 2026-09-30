import { autonomyOn } from "@codecast/shared/contracts/roleAutonomy";
import { routineState } from "@codecast/shared/contracts/orgTemplateReadiness";
import { useState, type CSSProperties } from "react";
import Link from "next/link";
import { captureException } from "@sentry/react";
import { ChevronRight, Loader2, Lock } from "lucide-react";
import { Section } from "../identity/RoleScopeView";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { sealSecret, useTemplateActions, useTemplateInstance } from "../../hooks/useTemplateHire";

// A template role's right column, under its project card (docs/architecture/
// org-hire.md H5 to H8, H11): the setup list with the one open item first and
// each step's how-to guide under it, what it may do (trust, authority), the
// routines with their trigger, what each still needs and one Activate per
// ready routine, the scoreboard, and the release. Shown only when the role has
// an instance; an ordinary role renders nothing.

export function TemplateSections({ roleId, canEdit }: { roleId: string; canEdit: boolean }) {
  const { instance } = useTemplateInstance(roleId);
  const { markSetup, activate } = useTemplateActions();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which guides a person opened or closed; the one open ask starts open.
  const [guides, setGuides] = useState<Record<string, boolean>>({});
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
        <Section density="page" label="One step left" name="template-host">
          <HostStep instance={instance} canEdit={canEdit} purpose="setup" />
        </Section>
      )}
      {setup.length > 0 && (
        <Section density="page" label="Setup" name="template-setup">
          {instance.ask && <p className="px-2.5 pb-1 text-[12px] text-sol-yellow" data-template-ask={instance.ask.id}>Waiting on you: {instance.ask.title}{instance.ask.unlocks?.length ? ` (unlocks ${instance.ask.unlocks.join(", ")})` : ""}</p>}
          <ul className="space-y-0.5 px-2.5 pb-1.5 text-[12px]">
            {setup.map((s) => {
              const mine = canEdit && s.who === "human";
              const hasGuide = !!(s.guide || s.how);
              const shown = hasGuide && (guides[s.id] ?? (s.status === "open" && s.id === instance.ask?.id));
              const mark = (status: "done" | "skipped" | "open") => void act(s.id, () => markSetup(instance.instance_key, s.id, status));
              const quiet = "shrink-0 rounded-md border border-sol-border/50 px-2 py-0.5 text-[11px] text-sol-text-muted hover:bg-sol-bg-highlight hover:text-sol-text disabled:opacity-50";
              return (
                <li key={s.id} data-template-setup-item={s.id} data-status={s.status}>
                  {/* The actions wrap under the title in the narrow rail and sit beside it on a wide page. */}
                  <div className="flex flex-wrap items-start gap-x-2 gap-y-0.5">
                    <span className={s.status === "done" ? "text-sol-green" : s.status === "skipped" ? "text-sol-text-dim" : "text-sol-text"}>{s.status === "done" ? "done" : s.status === "skipped" ? "skipped" : s.who === "human" ? "you" : "the role"}</span>
                    <span className={`min-w-[12rem] flex-1 ${s.status === "open" ? "text-sol-text" : "text-sol-text-muted"}`}>{s.title}{s.price ? <span className="text-sol-text-dim"> · {s.price}</span> : null}</span>
                    {(hasGuide || mine) && (
                      <span className="ml-auto flex shrink-0 items-center gap-1.5">
                        {hasGuide && <button type="button" aria-expanded={shown} onClick={() => setGuides({ ...guides, [s.id]: !shown })} className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-[11px] text-sol-cyan hover:bg-sol-bg-highlight" data-template-guide-toggle={s.id}><ChevronRight className={`h-3 w-3 transition-transform duration-150 ${shown ? "rotate-90" : ""}`} />How</button>}
                        {mine && s.status === "open" && <button type="button" disabled={busy === s.id} onClick={() => mark("skipped")} className={quiet}>Skip</button>}
                        {mine && s.status === "open" && <button type="button" disabled={busy === s.id} onClick={() => mark("done")} className="shrink-0 rounded-md border border-sol-border/50 px-2 py-0.5 text-[11px] text-sol-text hover:bg-sol-bg-highlight disabled:opacity-50">Done</button>}
                        {mine && s.status !== "open" && <button type="button" disabled={busy === s.id} onClick={() => mark("open")} className={quiet}>Reopen</button>}
                      </span>
                    )}
                  </div>
                  {shown && (
                    <div className="mb-1.5 mt-1 rounded-lg border border-sol-border/50 bg-sol-bg-alt/60 px-2.5 py-2" data-template-guide={s.id}>
                      {s.guide
                        ? <MarkdownRenderer content={s.guide} className="cc-cmt-md prose-headings:mb-1 prose-headings:mt-2 prose-headings:text-[12.5px] prose-ol:pl-4 prose-ul:pl-4 prose-code:break-all" />
                        : <p className="text-sol-text-muted">The guide for this step is in the release on the role&apos;s machine and reaches this page the next time that machine binds. Ask {instance.handle ? `@${instance.handle}` : "the role"} for it, or run there: <code style={{ fontFamily: "var(--font-mono)" }}>cast org template instructions {instance.instance} setup:{s.id}</code></p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {open.length === 0 && <p className="px-2.5 pb-1 text-[12px] text-sol-text-dim">{setup.some((s) => s.status === "skipped") ? "Nothing is left open. A skipped step can be reopened." : "Every setup step is done."}</p>}
        </Section>
      )}
      <Section density="page" label="What it may do" name="template-authority">
        <ul className="space-y-0.5 px-2.5 pb-1.5 text-[12px] text-sol-text-muted">
          <li>Starts work on its own: <span className="text-sol-text">{autonomyOn(instance.trust) ? "on" : "off"}</span>{autonomyOn(instance.trust) ? "" : "; it reads and recommends inside codecast"}</li>
          <li data-template-authority={authority.length}>Allowed outside codecast: {authority.length ? authority.map((g) => `${g.kind} (${g.label}${g.limit?.usd_per_month !== undefined ? `, up to $${g.limit.usd_per_month} a month` : g.limit?.usd_per_day !== undefined ? `, up to $${g.limit.usd_per_day} a day` : g.limit?.per_day !== undefined ? `, up to ${g.limit.per_day} a day` : ""}${g.expires_at ? `, until ${new Date(g.expires_at).toISOString().slice(0, 10)}` : ""})`).join("; ") : "none granted"}</li>
        </ul>
      </Section>
      {routines.length > 0 && (
        <Section density="page" label="Triggers" name="template-routines">
          <ul className="space-y-1 px-2.5 pb-1.5 text-[12px]">
            {routines.map((r) => {
              const rd = readiness[r.id] ?? { ready: false, mode: "propose", missing: [] };
              const t = r.trigger;
              const state = routineState(r, rd);
              return (
                <li key={r.id} className="flex items-start gap-2" data-template-routine={r.id} data-state={state}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sol-text">{r.title} {t?.short_id && <Link href={`/triggers/${t.short_id}`} className="text-sol-cyan hover:underline" data-template-trigger={t.short_id}>{t.short_id}</Link>} <span className="text-sol-text-dim">every {r.every} · {state}{t?.status === "scheduled" || t?.status === "running" ? `, ${rd.mode}` : ""}</span></p>
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
          {instance.update_available && <li className="text-sol-text" data-template-update={instance.update_available}>Update available: {instance.update_available}{instance.pending_upgrade ? ` (accepted; on its machine, run cast org template bind ${instance.instance} --to ${instance.pending_upgrade.to})` : ""}</li>}
          {((instance.secrets ?? []) as any[]).map((s) => <li key={s.key} data-template-secret={s.key} data-bound={s.bound}>{s.label}: {s.bound ? <span className="text-sol-green">set</span> : <span className="text-sol-yellow">missing</span>}</li>)}
        </ul>
        {instance.phase === "ready" && ((instance.secrets ?? []) as any[]).some((s) => !s.bound) && <HostStep instance={instance} canEdit={canEdit} purpose="secrets" />}
      </Section>
      {error && <p role="alert" className="px-2.5 text-[12px] text-sol-red">{error}</p>}
    </div>
  );
}

/**
 * The host step as a button (org-hire.md H3): the daemon on the machine that
 * runs the role installs the template and creates its triggers, paused. A
 * secret typed here is sealed in this browser to that machine's key before it
 * leaves (H4): the server relays ciphertext it cannot open, the daemon writes
 * the value to a private file and binds its path. The terminal form stays
 * behind a fold for anyone who prefers it. The same control binds a missing
 * secret once the instance is ready (`purpose: "secrets"`).
 */
function HostStep({ instance, canEdit, purpose }: { instance: any; canEdit: boolean; purpose: "setup" | "secrets" }) {
  const { requestBind } = useTemplateActions();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = instance.bind_host as { device: { device_id: string; label: string; online: boolean; can_receive_secrets: boolean; pubkey: string | null } | null; dir: string | null; reason: string | null } | undefined;
  const step = (instance.host_step ?? { state: "idle" }) as { state: "idle" | "pending" | "failed" | "done"; device_label?: string; error?: string; result?: { phase?: string; bound?: string[] } };
  const secrets = ((instance.secrets ?? []) as { key: string; label: string; bound: boolean }[]).filter((s) => purpose === "setup" || !s.bound);
  const typed = secrets.filter((s) => (values[s.key] ?? "").length > 0);
  const device = host?.device ?? null;
  const cli = `cast org template bind ${instance.instance}${secrets.length ? ` --secret ${secrets[0]!.key}=<path>` : ""}`;
  const run = async () => {
    if (!device || !host?.dir || busy) return;
    setBusy(true); setError(null);
    try {
      if (typed.length && !device.pubkey) throw new Error(`${device.label} runs a codecast too old to receive a secret from here; update it there, or bind the secret from its terminal.`);
      const sealed = await Promise.all(typed.map((s) => sealSecret(device.pubkey!, s.key, values[s.key]!)));
      await requestBind(instance.instance_key, sealed);
      setValues({});
    } catch (e) { captureException(e); setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const label = purpose === "setup" ? `Set up on ${device?.label ?? "its machine"}` : `Bind on ${device?.label ?? "its machine"}`;
  return (
    <div className="px-2.5 pb-1.5 text-[12px] leading-relaxed" data-template-host-step={step.state} data-host-purpose={purpose}>
      {purpose === "setup" && step.state !== "pending" && <p className="text-sol-text-muted">The hire is accepted. Its machine still has to install the template and create its triggers, paused; nothing runs until you activate one.</p>}
      {step.state === "pending" ? (
        <p className="mt-1 flex items-center gap-2 text-sol-text" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin text-sol-violet" /> Setting up on {step.device_label ?? device?.label ?? "its machine"}…{device && !device.online ? <span className="text-sol-text-dim">it is offline, so this runs when it wakes.</span> : null}</p>
      ) : (
        <>
          {step.state === "failed" && <p className="mt-1 text-sol-red" role="alert" data-host-error>{step.device_label ? `${step.device_label}: ` : ""}{step.error}</p>}
          {step.state === "done" && purpose === "setup" && <p className="mt-1 text-sol-text-dim">The last run finished{step.result?.phase ? ` (${step.result.phase})` : ""}, but the record is still waiting; run it again.</p>}
          {!device && <p className="mt-1 text-sol-yellow" data-host-reason>{host?.reason ?? "No machine can run this yet."}</p>}
          {canEdit && device && secrets.length > 0 && (
            <div className="mt-2 flex flex-col gap-2 rounded-lg border border-sol-border/50 bg-sol-bg-alt/60 p-2.5" data-host-secrets>
              <p className="flex items-start gap-1.5 text-[11.5px] text-sol-text"><Lock className="mt-[3px] h-3 w-3 shrink-0 text-sol-text-dim" /> {purpose === "setup" ? "Secrets stay on that machine. Enter them here once, or leave one blank and add it later." : "Enter the value once; it is sealed to that machine and never stored here."}</p>
              {secrets.map((s) => (
                <label key={s.key} className="flex flex-col gap-1">
                  <span className="text-[11px] text-sol-text-muted">{s.label}{s.bound ? <span className="text-sol-green"> · set</span> : null}</span>
                  {/* A textarea, masked, never <input type=password>: a password input strips newlines, which breaks a pasted PEM key or multi-line JSON. */}
                  <textarea rows={2} autoComplete="off" spellCheck={false} name={`secret:${s.key}`} value={values[s.key] ?? ""} onChange={(e) => setValues({ ...values, [s.key]: e.target.value })} placeholder={s.bound ? "replace…" : "paste the credential, key or JSON"} className="min-h-8 w-full resize-y rounded-md border border-sol-border/50 bg-sol-bg px-2 py-1.5 text-[12px] text-sol-text outline-none focus:border-sol-cyan" style={{ fontFamily: "var(--font-mono)", WebkitTextSecurity: "disc" } as CSSProperties} />
                </label>
              ))}
              {typed.length > 0 && !device.can_receive_secrets && <p className="text-[11px] text-sol-yellow">{device.label} runs a codecast too old to receive a secret from here. Update it there, or bind the secret from its terminal.</p>}
            </div>
          )}
          {canEdit && device && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void run()} disabled={busy || (purpose === "secrets" && typed.length === 0) || (typed.length > 0 && !device.can_receive_secrets)} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-sol-violet px-3 text-[12px] font-semibold text-sol-bg disabled:opacity-50" data-host-run>{busy ? "Sending…" : step.state === "failed" ? `Try again on ${device.label}` : label}</button>
              <span className="text-[11px] text-sol-text-dim">{device.online ? "online" : "offline: queued until it wakes"}{host?.dir ? ` · ${host.dir}` : ""}</span>
            </div>
          )}
          {error && <p className="mt-1 text-sol-red" role="alert">{error}</p>}
        </>
      )}
      <details className="mt-2 text-[11px] text-sol-text-dim">
        <summary className="cursor-pointer select-none">Prefer the terminal?</summary>
        <p className="mt-1">On the machine that runs this role, in the project&apos;s folder: <code style={{ fontFamily: "var(--font-mono)" }}>{cli}</code></p>
      </details>
    </div>
  );
}
