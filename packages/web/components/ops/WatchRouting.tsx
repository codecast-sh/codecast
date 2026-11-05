// The watch settings' alert routing, beside "On alert": who it tells (people
// and roles as chips, added from the same menu that assigns an issue), the
// team channel it posts to, whether it says it again while it runs and when
// it recovers, and whether a crossing starts a fix session by itself (which
// goes through the consequential review). Rows of the settings grid
// (`.mx-form`), so it lines up with the fields around it. Every write is the
// store's updateOpsWatch, so the chips move at once.
import { useMemo, useState } from "react";
import { UserPlus, X } from "lucide-react";
import { ALERT_ROUTES, RENOTIFY_CHOICES, alertRoute, type AlertNotifyInput, type AlertRoute } from "@codecast/shared/contracts/metricMonitor";
import { useInboxStore } from "../../store/inboxStore";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";
import { AssigneeFace } from "../identity/AssigneeFace";
import { AssignMenu } from "./issueOwner";
import { spanLabel } from "./metricModel";
import { autoFixLedger, useFixFolder, useFolderProjects, useNotifyTargets, type FixSubject } from "./alertRouting";
import { notifyInput, type NotifyTarget } from "./alertRoutingModel";
import type { OpsSource, OpsWatch } from "./opsTypes";
import "./issues.css";

const ROUTE_LABEL: Record<AlertRoute, string> = { task: "Problem task", timeline: "Timeline only" };

/**
 * What an alert files: a problem task or a timeline row, the watch's own
 * choice or its source's rule (alertRoute), with the way back to the
 * source's rule once the watch set its own.
 */
export function OnAlertRow({ value, source, onChange }: { value: AlertRoute | undefined; source?: OpsSource; onChange: (next: AlertRoute | null) => void }) {
  return (
    <>
      <label>On alert</label>
      <div className="mx-form-row flex-wrap">
        <span className="mx-seg" role="group" aria-label="What an alert does">
          {ALERT_ROUTES.map((r) => (
            <button key={r} type="button" aria-pressed={alertRoute(value, source?.promote ?? []) === r} onClick={() => value !== r && onChange(r)} data-watch-route={r}>
              {ROUTE_LABEL[r]}
            </button>
          ))}
        </span>
        {value && source && (
          <button type="button" className="mx-link-btn" onClick={() => onChange(null)} title={`${source.name} files a ${alertRoute(undefined, source.promote) === "task" ? "problem task" : "timeline row"} for its alerts`} data-watch-route-reset>
            Use {source.name}&apos;s
          </button>
        )}
      </div>
    </>
  );
}

export function AlertRouting({ watch, source }: { watch: OpsWatch; source?: OpsSource }) {
  const update = useInboxStore((s) => s.updateOpsWatch);
  return <NotifyRows subject={watch} workspace={watch.workspace} source={source} value={notifyInput(watch.notify)} onChange={(next) => update(watch._id, { notify: next })} />;
}

/**
 * The routing rows of the settings grid, for a saved watch or one the New
 * watch sheet is still making: who it tells, how often and on recovery, and
 * whether a crossing starts a fix (through the consequential review).
 */
export function NotifyRows({ subject, workspace, source, value: n, onChange: set }: { subject: FixSubject; workspace: string; source?: OpsSource; value: AlertNotifyInput; onChange: (next: AlertNotifyInput) => void }) {
  const myName = useInboxStore((s) => ((s as any).currentUser?.name as string | undefined) ?? "you");
  const folder = useFixFolder(source);
  const tells = !!(n.users?.length || n.roles?.length || n.channel);

  return (
    <>
      <TellRows workspace={workspace} value={n} onChange={set} />

      {/* Repeat and Recovery say how the people and channel above hear it: they appear once there is someone to tell. */}
      {tells && (
        <>
          <label htmlFor="mx-again">Repeat</label>
          <div className="mx-form-row">
            <select id="mx-again" className="mx-select" style={{ flex: 1, minWidth: 0 }} value={n.renotify_ms ?? 0} onChange={(e) => set({ ...n, renotify_ms: Number(e.target.value) || undefined })} data-watch-renotify>
              {RENOTIFY_CHOICES.map((ms) => <option key={ms} value={ms}>{ms ? `Every ${spanLabel(ms)}` : "Once"}</option>)}
            </select>
            <button type="button" className="mx-state" aria-pressed={!!n.recovery} onClick={() => set({ ...n, recovery: !n.recovery })} style={{ ["--ink" as string]: "var(--sol-green)" }} data-watch-recovery>
              <i />Recovery
            </button>
          </div>
        </>
      )}

      <label>Fix</label>
      <div className="mx-form-row flex-wrap">
        <ConsequentialSwitch
          on={!!n.fix}
          ledger={autoFixLedger(subject, source, folder, myName)}
          onTurnOn={() => set({ ...n, fix: true })}
          onTurnOff={() => set({ ...n, fix: false })}
          trigger={({ on, press }) => (
            <span className="mx-seg" role="group" aria-label="Start a fix session on alert" data-watch-autofix={on ? "on" : "off"}>
              <button type="button" aria-pressed={!on} onClick={() => on && press()} data-watch-autofix-off>Off</button>
              <button type="button" aria-pressed={on} disabled={!on && !folder} onClick={() => !on && press()} data-watch-autofix-on>Start on alert</button>
            </span>
          )}
        />
        {!folder && source && <SourceProjectPick source={source} />}
      </div>
    </>
  );
}

/**
 * A fix runs in its source's project folder; a source without one gets the
 * workspace's projects that have a folder, right where the switch is
 * disabled, and the pick attaches the source (setOpsSourceProject).
 */
function SourceProjectPick({ source }: { source: OpsSource }) {
  const projects = useFolderProjects();
  const attached = !!source.project_id;
  return (
    <select
      className="mx-select"
      style={{ color: "var(--sol-orange)", maxWidth: "100%" }}
      value=""
      disabled={!projects.length}
      onChange={(e) => e.target.value && useInboxStore.getState().setOpsSourceProject(source._id, e.target.value)}
      aria-label={`Project for ${source.name}`}
      title={`${source.name} has no project folder for a fix to run in`}
      data-source-project-pick={source.name}
    >
      <option value="">{!projects.length ? "No project folder" : attached ? "Project has no folder" : "Needs a project"}</option>
      {projects.map((p) => <option key={p._id} value={p._id}>{p.title}</option>)}
    </select>
  );
}

/**
 * Who an alert tells: people and roles as chips (added from the menu that
 * assigns an issue) and one team channel. Rows of the settings grid, on the
 * watch page and in the New watch sheet alike.
 */
export function TellRows({ workspace, value: n, onChange: set }: { workspace: string; value: AlertNotifyInput; onChange: (next: AlertNotifyInput) => void }) {
  const notify = useMemo(() => ({ ...n, by: "" }), [n]);
  const { options, channels, targets } = useNotifyTargets({ notify, workspace });
  const [adding, setAdding] = useState(false);
  const people = targets.filter((t) => t.kind !== "channel");
  const chosen = new Set([...(n.users ?? []), ...(n.roles ?? [])]);
  const remove = (t: NotifyTarget) => set(t.kind === "user" ? { ...n, users: (n.users ?? []).filter((x) => x !== t.id) } : { ...n, roles: (n.roles ?? []).filter((x) => x !== t.id) });
  const channelGone = !!n.channel && !channels.some((c) => c._id === n.channel);
  return (
    <>
      <label>Tell</label>
      <div className="mx-form-row flex-wrap" data-watch-tell>
        {people.map((t) => (
          <span key={t.id} className="mx-chip" data-watch-tell-target={t.kind} data-gone={t.option ? undefined : ""} title={t.option?.label ?? t.label}>
            {t.option && <AssigneeFace info={t.option.info} size={14} hover={false} />}
            <span className="truncate">{t.label}</span>
            <button type="button" aria-label={`Stop telling ${t.label}`} onClick={() => remove(t)} data-watch-tell-remove><X className="w-3 h-3" /></button>
          </span>
        ))}
        <span className="relative iss-assign-anchor">
          <button type="button" className="ops-btn" data-size="sm" aria-haspopup="dialog" aria-expanded={adding} onClick={() => setAdding(true)} data-watch-tell-add>
            <UserPlus className="w-3.5 h-3.5" />{people.length ? "Add" : "Person or role"}
          </button>
          {adding && (
            <AssignMenu
              options={options.filter((o) => !chosen.has(o.key))}
              placeholder="Tell a person or role"
              onClose={() => setAdding(false)}
              onPick={(o) => {
                setAdding(false);
                set(o.info.kind === "role" ? { ...n, roles: [...(n.roles ?? []), o.key] } : { ...n, users: [...(n.users ?? []), o.key] });
              }}
            />
          )}
        </span>
      </div>

      <label htmlFor="mx-channel">Channel</label>
      <select id="mx-channel" className="mx-select" value={n.channel ?? ""} disabled={!channels.length && !n.channel} onChange={(e) => set({ ...n, channel: e.target.value || undefined })} data-watch-channel>
        <option value="">{channels.length ? "None" : "No team channels"}</option>
        {channels.map((c) => <option key={c._id} value={c._id}>#{c.name}</option>)}
        {channelGone && <option value={n.channel}>#removed</option>}
      </select>
    </>
  );
}
