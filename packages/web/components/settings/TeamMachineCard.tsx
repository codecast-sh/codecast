"use client";
// One team machine (docs/architecture/team-machines.md): who is on it, what
// each is running, how loaded the box is, and the viewer's own control:
// join, follow the join, sign in to Claude there, leave. The admin also
// removes members and renames it. Everything paints from the teamMachines
// store key; writes are its store actions.
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { Check, Loader2, Pencil, Server } from "lucide-react";
import { pickLinuxUser } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";
import { teamMachineJoinLedger } from "../consequential/ledgers";
import { ConfirmButton } from "../integrations/parts";
import { Avatar } from "../tasks/TaskCommentStream";
import { DeviceDot } from "../DeviceBadge";
import { LoginCodePaste } from "../LoginCodePaste";
import { membershipPhase, myMembership, type TeamMachine, type TeamMachineMember } from "../../lib/teamMachines";

const BTN = "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/50";

export function TeamMachineCard({ m, showTeam }: { m: TeamMachine; showTeam?: boolean }) {
  const me = useInboxStore((s) => s.currentUser);
  const mine = myMembership(m, me?._id);
  return (
    <div className="border-b border-sol-border/40 last:border-b-0" data-team-machine={m.name}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 sm:px-5">
        <Server className="h-4 w-4 shrink-0 text-sol-text-muted" />
        <MachineName m={m} />
        {showTeam && <span className="text-[11px] text-sol-text-dim">{m.team_name}</span>}
        <LoadChips m={m} />
        <span className="ml-auto flex items-center gap-2">
          <MyControl m={m} mine={mine} me={me} />
        </span>
      </div>
      {mine?.device_id && mine.login_flow?.status === "pending" && mine.login_flow.url && !mine.claude_signed_in && (
        <div className="mx-4 mb-2 rounded-md bg-amber-500/[0.08] px-3 py-2 text-[12px] sm:mx-5" data-team-machine-signin="pending">
          <span className="font-medium text-sol-text">Sign in to Claude on {m.name}</span>
          <LoginCodePaste deviceId={mine.device_id} flow={mine.login_flow} defaultOpen />
        </div>
      )}
      <div className="pb-1.5">
        {m.members.map((r) => (
          <MemberRow key={r._id} m={m} r={r} isMe={r._id === mine?._id} />
        ))}
      </div>
    </div>
  );
}

function MachineName({ m }: { m: TeamMachine }) {
  const rename = useInboxStore((s) => s.renameTeamMachine);
  const [editing, setEditing] = useState<string | null>(null);
  if (editing !== null) {
    const save = () => { if (editing.trim() && editing.trim() !== m.name) rename(m._id, editing); setEditing(null); };
    return (
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="flex items-center gap-1">
        <input autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }}
          aria-label="Machine name" maxLength={64}
          className="h-7 w-48 rounded border border-sol-border bg-sol-bg px-2 text-sm text-sol-text" />
      </form>
    );
  }
  return (
    <span className="group flex min-w-0 items-center gap-1.5">
      <span className="truncate text-sm font-medium text-sol-text">{m.name}</span>
      {m.can_manage && (
        <button type="button" onClick={() => setEditing(m.name)} aria-label={`Rename ${m.name}`} className="text-sol-text-dim opacity-0 hover:text-sol-text group-hover:opacity-100 focus-visible:opacity-100">
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

function LoadChips({ m }: { m: TeamMachine }) {
  if (!m.load) return <span className="text-[11px] text-sol-text-dim" data-tip="No member's daemon has reported the box's load in the last 5 minutes">no load report</span>;
  const l = m.load;
  const chip = "inline-flex h-5 items-center rounded px-1.5 text-[11px] tabular-nums";
  return (
    <span className="flex items-center gap-1" data-team-machine-load>
      {l.cpu_pct !== undefined && (
        <span className={`${chip} ${l.busy ? "bg-sol-orange/15 text-sol-orange" : "bg-sol-bg-alt text-sol-text-muted"}`} data-tip={`${l.cpus} CPUs`}>
          CPU {l.cpu_pct}%
        </span>
      )}
      <span className={`${chip} bg-sol-bg-alt text-sol-text-muted`}>{Math.round(l.mem_free_gb)}/{l.mem_total_gb} GB free</span>
    </span>
  );
}

function MyControl({ m, mine, me }: { m: TeamMachine; mine: TeamMachineMember | undefined; me: any }) {
  const join = useInboxStore((s) => s.joinTeamMachine);
  const remove = useInboxStore((s) => s.removeTeamMachineMember);
  const phase = membershipPhase(mine);
  if (!me) return null;

  if (phase.kind === "none") {
    const linuxUser = pickLinuxUser(
      { github: me.github_username, email: me.email, name: me.name },
      [m.admin_linux_user, ...m.members.map((r) => r.linux_user)],
    );
    return (
      <ConsequentialSwitch
        on={false}
        ledger={teamMachineJoinLedger({
          machine: m.name, team: m.team_name, admin: m.admin_name, linuxUser, members: m.members.length,
          load: m.load, adminOnline: m.admin_online,
        })}
        onTurnOn={() => join(m._id)}
        onTurnOff={() => {}}
        trigger={({ press }) => (
          <button type="button" onClick={press} className={`${BTN} bg-sol-blue text-sol-bg hover:brightness-110`} data-team-machine-join>
            Join
          </button>
        )}
      />
    );
  }
  if (phase.kind === "joining") {
    return (
      <span className="flex items-center gap-2 text-[12px]" data-team-machine-joining={phase.step}>
        {phase.stalled
          ? <span className="text-sol-orange" data-tip={m.admin_online ? "The box stopped answering this join" : `${m.admin_name}'s admin daemon is offline`}>Stalled</span>
          : <Loader2 className="h-3.5 w-3.5 animate-spin text-sol-blue" />}
        <span className="text-sol-text">{phase.label}</span>
        <span className="tabular-nums text-sol-text-dim">{phase.step}/{phase.total}</span>
        {phase.stalled && <button type="button" onClick={() => join(m._id)} className={`${BTN} border border-sol-border text-sol-text-muted hover:text-sol-text`}>Retry</button>}
      </span>
    );
  }
  if (phase.kind === "failed") {
    return (
      <span className="flex min-w-0 items-center gap-2 text-[12px]">
        <span className="max-w-[16rem] truncate text-sol-red" data-tip={phase.error}>Join failed: {phase.error}</span>
        <button type="button" onClick={() => join(m._id)} className={`${BTN} border border-sol-border text-sol-text-muted hover:text-sol-text`}>Retry</button>
      </span>
    );
  }
  if (phase.kind === "removing") {
    return <span className="flex items-center gap-1.5 text-[12px] text-sol-text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" />Leaving</span>;
  }
  const leave = mine && !mine.is_admin
    ? <ConfirmButton label="Leave" question={`Leave ${m.name}? Your daemon there stops; your files stay.`} confirmLabel="Leave" onConfirm={() => remove(mine._id)} />
    : null;
  if (phase.kind === "sign-in" && mine?.device_id) {
    return <span className="flex items-center gap-2"><ClaudeSignIn deviceId={mine.device_id} member={mine} />{leave}</span>;
  }
  return (
    <span className="flex items-center gap-2 text-[12px]">
      {phase.kind === "offline"
        ? <span className="text-sol-text-muted">Your daemon is offline</span>
        : <span className="inline-flex items-center gap-1 text-sol-green" data-team-machine-ready><Check className="h-3.5 w-3.5" />{mine?.linux_user}</span>}
      {leave}
    </span>
  );
}

/** Claude on your user there: the machine runs the sign-in, you finish it on the code-paste page from here. */
function ClaudeSignIn({ deviceId, member }: { deviceId: string; member: TeamMachineMember }) {
  const request = useMutation(api.accountSwitch.requestLoginFlow);
  const [starting, setStarting] = useState(false);
  const flow = member.login_flow;
  // The page and the code box get their own row under the header (TeamMachineCard).
  if (flow?.status === "pending" && flow.url) {
    return <span className="flex items-center gap-1.5 text-[12px] text-sol-text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />Signing in</span>;
  }
  const start = async () => {
    setStarting(true);
    try {
      await request({ device_id: deviceId, open_browser: false, force: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start the sign-in");
    } finally {
      setStarting(false);
    }
  };
  const waiting = starting || flow?.status === "pending";
  return (
    <span className="flex items-center gap-2 text-[12px]">
      {flow?.status === "rejected" && <span className="max-w-[12rem] truncate text-sol-red" data-tip={flow.reason}>{flow.reason ?? "Sign-in failed"}</span>}
      <button type="button" disabled={waiting} onClick={start} className={`${BTN} bg-amber-500 text-sol-bg hover:bg-amber-400 disabled:opacity-60`} data-team-machine-signin="start">
        {waiting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Sign in to Claude
      </button>
    </span>
  );
}

function MemberRow({ m, r, isMe }: { m: TeamMachine; r: TeamMachineMember; isMe: boolean }) {
  const remove = useInboxStore((s) => s.removeTeamMachineMember);
  const state = memberState(r);
  return (
    <div className="group flex items-center gap-2.5 px-4 py-1 pl-11 text-[12px] sm:px-5 sm:pl-12" data-team-machine-member={r.linux_user}>
      <Avatar name={r.name} image={r.image} />
      <span className="w-24 shrink-0 truncate font-mono text-[11.5px] text-sol-text">{r.linux_user}</span>
      <span className="min-w-0 flex-1 truncate text-sol-text-muted">
        {isMe ? "You" : r.name}{r.is_admin && <span className="ml-1.5 text-sol-text-dim">admin</span>}
      </span>
      {r.usage && r.usage.sessions > 0 && (
        <span className="shrink-0 tabular-nums text-sol-text-dim" data-tip="Their sessions' agent processes, from their daemon's last report">
          {r.usage.sessions} {r.usage.sessions === 1 ? "session" : "sessions"} · {r.usage.cpu}% · {r.usage.mem_gb} GB
        </span>
      )}
      <span className={`w-28 shrink-0 truncate text-right ${state.tone}`} data-tip={r.error}>{state.label}</span>
      <DeviceDot online={r.online} />
      {m.can_manage && !r.is_admin && !isMe ? (
        <span className="w-5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          <ConfirmButton label="×" question={`Remove ${r.name} from ${m.name}? Their daemon stops; their files stay.`} confirmLabel="Remove" onConfirm={() => remove(r._id)} />
        </span>
      ) : <span className="w-5 shrink-0" />}
    </div>
  );
}

function memberState(r: TeamMachineMember): { label: string; tone: string } {
  const p = membershipPhase(r);
  switch (p.kind) {
    case "joining": return { label: p.stalled ? "Join stalled" : `Joining ${p.step}/${p.total}`, tone: p.stalled ? "text-sol-orange" : "text-sol-blue" };
    case "failed": return { label: "Join failed", tone: "text-sol-red" };
    case "removing": return { label: "Leaving", tone: "text-sol-text-dim" };
    case "offline": return { label: "Offline", tone: "text-sol-text-dim" };
    case "sign-in": return { label: "Needs Claude", tone: "text-amber-500" };
    default: return { label: "Ready", tone: "text-sol-green" };
  }
}

