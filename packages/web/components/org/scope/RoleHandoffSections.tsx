"use client";
// The role page's pieces for the line's merge step (docs/architecture/
// the-line.md L12), the knowledge handoff (org-staffing.md S32) and the split
// into two leads (S34). Mounted by ScopeSettings. The merge switch and the
// split are per view mutations (the role row carries the result; the tree
// re-syncs it), so each shows the server's answer and nothing is mirrored.
import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowRightLeft, GitMerge, Scissors } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import type { OrgRole, OrgTree } from "../orgTypes";
import { useInboxStore } from "../../../store/inboxStore";


const serverWords = (e: any, fallback: string) => String(e?.message ?? "").replace(/^\[Request ID: [^\]]+\] Server Error\s*/i, "").split("\n")[0] || fallback;

export type MergeAllowanceRow = { on: boolean; allowed: boolean; reason: string | null; used: number; limit: number | null };

/** What the merge switch says under itself. */
export function mergeStepWords(m: MergeAllowanceRow | null | undefined): string {
  if (!m) return "Reading the line";
  if (!m.on) return "Off: an approved branch is left for a person to merge.";
  const limit = m.limit === null ? "no daily limit" : `${m.used} of ${m.limit} today`;
  return m.allowed ? `On: approved branches merge into the default branch when their checks pass (${limit}).` : `On, but not now: ${m.reason}.`;
}

/** The line's merge step (L12): one switch; turning it on without a merge
 *  grant asks for the daily limit, which writes the grant in the same act. */
export function MergeStepSwitch({ role, canEdit, merge }: { role: OrgRole; canEdit: boolean; merge: MergeAllowanceRow | null | undefined }) {
  const setLineMerge = useInboxStore((s) => s.setOrgLineMerge);
  const [asking, setAsking] = useState(false);
  const [perDay, setPerDay] = useState("3");
  const [busy, setBusy] = useState(false);
  const on = merge?.on ?? !!role.line_merge;
  const flip = async (next: boolean, per_day?: number) => {
    setBusy(true);
    try {
      await setLineMerge(role._id, next, per_day);
      toast.success(next ? `${role.name}'s line merges on its own now` : `${role.name}'s line leaves merges to a person`);
      setAsking(false);
    } catch (e: any) {
      const words = serverWords(e, "Could not change the merge step");
      if (next && /--per-day/.test(words)) setAsking(true);
      else toast.error(words);
    } finally { setBusy(false); }
  };
  return (
    <div className="mt-3 pt-3 border-t" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 28%, transparent)" }} data-merge-step={on ? "on" : "off"}>
      <div className="flex items-center gap-2.5 flex-wrap">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Merge step"
          disabled={!canEdit || busy}
          onClick={() => (on ? flip(false) : merge && merge.limit !== null ? flip(true) : setAsking(true))}
          className="inline-flex items-center gap-2 rounded-full pl-1 pr-3 h-7 border transition-colors disabled:cursor-default disabled:opacity-60"
          style={{ borderColor: on ? "var(--sol-green)" : "color-mix(in srgb, var(--sol-border) 45%, transparent)", background: on ? "color-mix(in srgb, var(--sol-green) 10%, transparent)" : undefined }}
        >
          <span className="relative inline-block w-8 h-4 rounded-full transition-colors" style={{ background: on ? "var(--sol-green)" : "color-mix(in srgb, var(--sol-text-dim) 35%, transparent)" }}>
            <span className="absolute top-0.5 w-3 h-3 rounded-full transition-[left]" style={{ left: on ? 18 : 2, background: "var(--sol-bg)" }} />
          </span>
          <GitMerge className="w-3.5 h-3.5" style={{ color: on ? "var(--sol-green)" : "var(--sol-text-dim)" }} />
          <span className="text-[12px] font-semibold" style={{ color: on ? "var(--sol-green)" : "var(--sol-text-muted)" }}>Merge step {on ? "on" : "off"}</span>
        </button>
        <span className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }} data-merge-words>{mergeStepWords(merge)}</span>
      </div>
      {asking && (
        <form className="mt-2.5 flex items-center gap-2 flex-wrap" onSubmit={(e) => { e.preventDefault(); const n = parseInt(perDay, 10); if (n >= 1) flip(true, n); }} data-merge-limit-form>
          <label className="text-[12px]" style={{ color: "var(--sol-text-secondary)" }}>
            Merges a day, at most
            <input type="number" min={1} value={perDay} onChange={(e) => setPerDay(e.target.value)} className="ml-2 w-16 h-7 px-2 rounded-md border text-[12px]" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", background: "var(--sol-bg)", color: "var(--sol-text)" }} aria-label="Merges a day" />
          </label>
          <button type="submit" disabled={busy} className="h-7 px-3 rounded-md text-[12px] font-semibold" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>Turn on</button>
          <button type="button" onClick={() => setAsking(false)} className="h-7 px-2 rounded-md text-[12px]" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
          <span className="text-[11px] basis-full" style={{ color: "var(--sol-text-dim)" }}>This grants the role the authority to merge, for ninety days, with this daily limit. Revoke it under the role's authority at any time.</span>
        </form>
      )}
    </div>
  );
}

const areaNames = (tree: OrgTree, role: OrgRole, ids: { project_ids?: string[]; plan_ids?: string[]; project_id?: string; plan_id?: string }): string[] => {
  const projects = new Map<string, string>();
  const plans = new Map<string, string>();
  for (const r of tree.roles) {
    for (const p of r.scope_names?.projects ?? []) projects.set(p.id, p.title);
    for (const p of r.scope_names?.plans ?? []) plans.set(p.id, p.title);
  }
  for (const p of role.scope_names?.projects ?? []) projects.set(p.id, p.title);
  const out: string[] = [];
  for (const id of [...(ids.project_ids ?? []), ...(ids.project_id ? [ids.project_id] : [])]) out.push(projects.get(id) ?? "a project");
  for (const id of [...(ids.plan_ids ?? []), ...(ids.plan_id ? [ids.plan_id] : [])]) out.push(plans.get(id) ?? "a plan");
  return out;
};

const roleLink = (tree: OrgTree, roleId: string, fallback: string) => {
  const r = tree.roles.find((x) => x._id === roleId);
  return r ? <Link href={`/org/${r.short_id}`} className="font-medium hover:underline" style={{ color: "var(--sol-text)" }}>{r.name} <span style={{ color: "var(--sol-text-dim)" }}>@{r.handle}</span></Link> : <span style={{ color: "var(--sol-text)" }}>@{fallback}</span>;
};

const dayWords = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The handoff this role is giving (S32): who takes what, what is done,
 *  the deadline, and the two things a person can do about it. */
export function HandingOverSection({ tree, role, canEdit }: { tree: OrgTree; role: OrgRole; canEdit: boolean }) {
  const hand = role.handing_over;
  const now = useCoarseNow(60_000);
  const settle = useInboxStore((s) => s.settleOrgHandoff);
  const [busy, setBusy] = useState(false);
  if (!hand) return null;
  const hoursLeft = Math.max(0, Math.round((hand.deadline - now) / 3_600_000));
  const why = hand.reason === "retire" ? "It retires once this lands, or at the deadline." : hand.reason === "split" ? "It was split into two leads and retires once this lands, or at the deadline." : "Part of its area moved to another role.";
  const act = async (how: "run" | "close") => {
    setBusy(true);
    try {
      await settle(role._id, how);
      toast.success(how === "run" ? "The handoff trigger runs now" : hand.retire ? `The handoff closed; ${role.name} retires` : "The handoff closed");
    } catch (e: any) { toast.error(serverWords(e, "Could not settle the handoff")); }
    finally { setBusy(false); }
  };
  return (
    <section className="rounded-xl border px-4 py-3.5" style={{ borderColor: "color-mix(in srgb, var(--sol-yellow) 45%, transparent)", background: "color-mix(in srgb, var(--sol-yellow) 6%, transparent)" }} data-handing-over={hand.reason}>
      <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] inline-flex items-center gap-1.5" style={{ color: "var(--sol-yellow)" }}><ArrowRightLeft className="w-3 h-3" /> Handing over</h3>
      <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>Its lines for the moved areas are already in each receiver's brief. It hands over what the lines do not say from its own thread. {why}</p>
      <ul className="mt-2.5 space-y-1 text-[12.5px]">
        {hand.receivers.map((r) => (
          <li key={r.role_id} className="flex items-center gap-2 flex-wrap" data-handoff-receiver={r.handle}>
            {roleLink(tree, r.role_id, r.handle)}
            <span style={{ color: "var(--sol-text-secondary)" }}>takes {areaNames(tree, role, r).join(", ") || "its area"}</span>
            <span className="text-[11px] px-1.5 h-[18px] inline-flex items-center rounded" style={{ background: r.done_at ? "color-mix(in srgb, var(--sol-green) 14%, transparent)" : "color-mix(in srgb, var(--sol-text-dim) 14%, transparent)", color: r.done_at ? "var(--sol-green)" : "var(--sol-text-muted)" }}>{r.done_at ? `handed ${dayWords(r.done_at)}` : "waiting"}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2.5 flex items-center gap-2 flex-wrap text-[12px]">
        <span style={{ color: "var(--sol-text-dim)" }}>{hoursLeft > 0 ? `${hoursLeft}h left` : "past its deadline"} (by {new Date(hand.deadline).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})</span>
        {canEdit && hand.trigger_id && <button type="button" disabled={busy} onClick={() => act("run")} className="h-7 px-3 rounded-md text-[12px] font-semibold" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>Hand over now</button>}
        {canEdit && <button type="button" disabled={busy} onClick={() => act("close")} className="h-7 px-3 rounded-md text-[12px]" style={{ color: "var(--sol-text-muted)" }}>{hand.retire ? "Close and retire now" : "Close now"}</button>}
      </div>
    </section>
  );
}

/** Which role this one succeeded for which area (S32), with the state of the
 *  words: the lines came at `at`; the rest came at `handed_at`, or not yet. */
export function SuccessionSection({ tree, role }: { tree: OrgTree; role: OrgRole }) {
  const rows = role.succeeded ?? [];
  if (!rows.length) return null;
  return (
    <section className="rounded-xl border px-4 py-3.5" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 28%, transparent)", background: "var(--sol-card)" }} data-succession={rows.length}>
      <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>Took over</h3>
      <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>Areas it inherited from another role. The lines in its brief marked (from @role) came with them.</p>
      <ul className="mt-2.5 space-y-1 text-[12.5px]">
        {rows.map((s, i) => (
          <li key={`${s.from_role_id}:${s.project_id ?? s.plan_id ?? i}`} className="flex items-center gap-2 flex-wrap" data-succession-row>
            <span style={{ color: "var(--sol-text)" }}>{areaNames(tree, role, s).join(", ")}</span>
            <span style={{ color: "var(--sol-text-secondary)" }}>from</span>
            {roleLink(tree, s.from_role_id, s.from_handle)}
            <span className="text-[11px]" style={{ color: "var(--sol-text-dim)" }}>{dayWords(s.at)} · {s.lines ? `${s.lines} line${s.lines === 1 ? "" : "s"}` : "no line"}{s.handed_at ? `, handoff ${dayWords(s.handed_at)}` : ", handoff pending"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Half = { handle: string; name: string };

/** The partition a split dialog holds: every area of the role goes to one of
 *  the two halves. Pure, so the dialog and its test agree on what is ready. */
export function splitReadiness(areas: Array<{ key: string }>, side: Record<string, 0 | 1>, halves: [Half, Half]): string | null {
  for (const h of halves) {
    if (!/^[a-z0-9-]{2,32}$/.test(h.handle)) return `"${h.handle || ""}" is not a handle (a-z, 0-9 and -)`;
    if (!h.name.trim()) return `@${h.handle} needs a name`;
  }
  if (halves[0].handle === halves[1].handle) return "The two roles need different handles";
  const missing = areas.filter((a) => side[a.key] === undefined);
  if (missing.length) return `Place ${missing.length} more area${missing.length === 1 ? "" : "s"}`;
  const counts = [0, 0];
  for (const a of areas) counts[side[a.key]]++;
  if (counts[0] === 0) return `@${halves[0].handle} would own nothing`;
  if (counts[1] === 0) return `@${halves[1].handle} would own nothing`;
  return null;
}

/** Split into two leads (S34): one dialog, two columns, every area placed. */
export function SplitRoleDialog({ tree, role, open, onOpenChange }: { tree: OrgTree; role: OrgRole; open: boolean; onOpenChange: (open: boolean) => void }) {
  const split = useInboxStore((s) => s.splitOrgRole);
  const areas = useMemo(() => [
    ...(role.scope_names?.projects ?? []).map((p) => ({ key: `project:${p.id}`, ref: `project:${p.id}`, title: p.title })),
    ...(role.scope_names?.plans ?? []).map((p) => ({ key: `plan:${p.id}`, ref: `plan:${p.id}`, title: p.title })),
  ], [role.scope_names]);
  const [halves, setHalves] = useState<[Half, Half]>([{ handle: `${role.handle}-a`, name: `${role.name} A` }, { handle: `${role.handle}-b`, name: `${role.name} B` }]);
  const [side, setSide] = useState<Record<string, 0 | 1>>({});
  const [retireSession, setRetireSession] = useState(false);
  const [busy, setBusy] = useState(false);
  const problem = splitReadiness(areas, side, halves);
  const edit = (i: 0 | 1, patch: Partial<Half>) => setHalves((h) => (i === 0 ? [{ ...h[0], ...patch }, h[1]] : [h[0], { ...h[1], ...patch }]) as [Half, Half]);
  const submit = async () => {
    if (problem) return;
    setBusy(true);
    try {
      const out = await split({
        role_id: role._id,
        halves: halves.map((h, i) => ({ name: h.name.trim(), handle: h.handle, refs: areas.filter((a) => side[a.key] === i).map((a) => a.ref) })),
        standing_session: retireSession ? "retire" : "keep",
      });
      toast.success(`${role.name} is now ${out.roles.map((r: any) => `@${r.handle}`).join(" and ")}; it hands its knowledge to each${out.handoff ? ` by ${new Date(out.handoff.deadline).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" })}` : ""}`);
      onOpenChange(false);
    } catch (e: any) { toast.error(serverWords(e, "Could not split the role")); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[640px]" data-split-dialog>
        <DialogHeader>
          <DialogTitle className="inline-flex items-center gap-2"><Scissors className="w-4 h-4" /> Split {role.name} into two leads</DialogTitle>
          <DialogDescription>Two roles, each with part of its area, both reporting where it does. Each gets its lines for the areas it takes, and {role.name} hands over the rest from its own thread before it retires.</DialogDescription>
        </DialogHeader>
        <div className="grid sm:grid-cols-2 gap-3">
          {([0, 1] as const).map((i) => (
            <div key={i} className="rounded-lg border p-3 space-y-2" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }} data-split-half={i}>
              <input value={halves[i].name} onChange={(e) => edit(i, { name: e.target.value })} aria-label={`Name of role ${i + 1}`} className="w-full h-8 px-2 rounded-md border text-[13px] font-semibold" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", background: "var(--sol-bg)", color: "var(--sol-text)" }} />
              <div className="flex items-center gap-1 text-[12px]" style={{ color: "var(--sol-violet)", fontFamily: "var(--font-mono)" }}>@<input value={halves[i].handle} onChange={(e) => edit(i, { handle: e.target.value.toLowerCase().replace(/^@/, "") })} aria-label={`Handle of role ${i + 1}`} className="flex-1 h-7 px-2 rounded-md border" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", background: "var(--sol-bg)", color: "var(--sol-violet)" }} /></div>
              <ul className="min-h-[40px] space-y-1">
                {areas.filter((a) => side[a.key] === i).map((a) => <li key={a.key} className="text-[12px] px-2 h-6 inline-flex items-center rounded mr-1" style={{ background: "color-mix(in srgb, var(--sol-cyan) 12%, transparent)", color: "var(--sol-cyan)" }}>{a.title}</li>)}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-3">
          <div className="text-[10.5px] mb-1.5 uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>Place each area</div>
          <ul className="space-y-1.5">
            {areas.map((a) => (
              <li key={a.key} className="flex items-center gap-2 text-[12.5px]" data-split-area={a.title}>
                <span className="flex-1 truncate" style={{ color: "var(--sol-text)" }}>{a.title}</span>
                {([0, 1] as const).map((i) => (
                  <button key={i} type="button" onClick={() => setSide((s) => ({ ...s, [a.key]: i }))} aria-pressed={side[a.key] === i} className="h-6 px-2 rounded-md text-[11.5px] border" style={{ borderColor: side[a.key] === i ? "var(--sol-violet)" : "color-mix(in srgb, var(--sol-border) 45%, transparent)", background: side[a.key] === i ? "color-mix(in srgb, var(--sol-violet) 14%, transparent)" : undefined, color: side[a.key] === i ? "var(--sol-violet)" : "var(--sol-text-muted)" }}>@{halves[i].handle}</button>
                ))}
              </li>
            ))}
          </ul>
        </div>
        <label className="mt-3 flex items-center gap-2 text-[12px]" style={{ color: "var(--sol-text-secondary)" }}>
          <input type="checkbox" checked={retireSession} onChange={(e) => setRetireSession(e.target.checked)} /> Retire its standing session with it (default: it keeps running as a plain agent)
        </label>
        <div className="mt-3 flex items-center gap-2 justify-end">
          <span className="text-[11.5px] mr-auto" style={{ color: problem ? "var(--sol-text-dim)" : "var(--sol-green)" }} data-split-readiness>{problem ?? "Ready"}</span>
          <button type="button" onClick={() => onOpenChange(false)} className="h-8 px-3 rounded-md text-[12px]" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
          <button type="button" disabled={!!problem || busy} onClick={submit} className="h-8 px-3.5 rounded-md text-[12px] font-semibold disabled:opacity-50" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>Split</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The split as a settings row with its button. */
export function SplitRoleSection({ tree, role, canEdit }: { tree: OrgTree; role: OrgRole; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const areas = (role.scope_names?.projects.length ?? 0) + (role.scope_names?.plans.length ?? 0);
  if (!canEdit || areas < 2 || role.handing_over) return null;
  return (
    <section className="rounded-xl border px-4 py-3.5" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 28%, transparent)", background: "var(--sol-card)" }} data-split-section>
      <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>Split</h3>
      <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>Turn this role into two leads with disjoint areas, both reporting where it does. Its knowledge goes to each.</p>
      <button type="button" onClick={() => setOpen(true)} className="mt-2.5 inline-flex items-center gap-1.5 h-7 px-3 rounded-md text-[12px] font-semibold border" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text)" }}><Scissors className="w-3.5 h-3.5" /> Split into two leads</button>
      {open && <SplitRoleDialog tree={tree} role={role} open={open} onOpenChange={setOpen} />}
    </section>
  );
}
