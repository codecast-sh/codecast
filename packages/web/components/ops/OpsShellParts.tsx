// The pieces of the Ops shell's header that are not crumbs or tabs: how fresh
// the area's numbers are, the bar that says an opened item belongs to another
// workspace (with the switch to it), and the issue stepper that walks the list
// the issue was opened from.
import { isRecordNotIssue } from "@codecast/shared/contracts/signalFingerprint";
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { TeamIcon } from "../TeamIcon";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWsConnected } from "../../hooks/useWsConnected";
import { useSwitchWorkspace } from "../../hooks/useSwitchWorkspace";
import { useActiveWorkspaceKey } from "../../hooks/useWorkspaceCollection";
import { useOpsGroup, useOpsGroups, useOpsWatches } from "../../hooks/useSyncOps";
import { useInboxStore } from "../../store/inboxStore";
import { issueListOrder, issueStep } from "./issueNav";
import { opsHref } from "./opsPaths";
import type { OpsFeeds } from "./parts";
import type { OpsSource } from "./opsTypes";
import { freshness } from "./opsFreshness";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { ConsequentialSwitch, SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";

export function OpsFreshness({ feeds, sources, scope = null }: { feeds: OpsFeeds; sources: OpsSource[]; /** The source the view is filtered to: the chip speaks for it alone. */ scope?: string | null }) {
  const connected = useWsConnected();
  const now = useCoarseNow(15_000);
  const since = useRef<number | null>(null);
  if (connected) since.current = null;
  else if (since.current === null) since.current = Date.now();
  const feedError = !!(feeds.sources.error || feeds.groups.error || feeds.replays.error || feeds.watches.error);
  const watches = useOpsWatches();
  const f = freshness({ connected, offlineSince: since.current, feedError, sources, now, scope, watches });
  if (!f) return null;
  // A source behind is named and opens its overview, where its poll and fix are.
  if (f.source) {
    return (
      <Link href={opsHref.home({ source: f.source })} className="ops-fresh" data-state="stale" title={f.title} data-ops-fresh data-ops-fresh-source={f.source}>
        <i aria-hidden />
        <span>{f.label}</span>
      </Link>
    );
  }
  return (
    <span className="ops-fresh" data-state={f.stale ? "stale" : "live"} title={f.title} data-ops-fresh>
      <i aria-hidden />
      <span>{f.label}</span>
    </span>
  );
}

// ── An item from another workspace ──

/** A workspace key as a person names it: the team's name, or Personal. */
function useWorkspaceName(key: string | null): { name: string; teamId: string | null; icon?: string; color?: string } | null {
  const teamId = key?.startsWith("team:") ? key.slice(5) : null;
  const team = useInboxStore((s) => (teamId ? (s.teams as any[] | undefined)?.find((t) => t?._id === teamId) ?? null : null));
  if (!key) return null;
  if (!teamId) return { name: "Personal", teamId: null };
  return { name: team?.name ?? "another team", teamId, icon: team?.icon, color: team?.color };
}

/** Every workspace the reader belongs to but the one Ops reads: Personal, then each team. */
function useOtherWorkspaces(active: string | null): { name: string; teamId: string | null; icon?: string; color?: string }[] {
  const teams = useInboxStore((s) => s.teams as any[] | undefined);
  return useMemo(() => {
    const all = [{ key: "user:", name: "Personal", teamId: null as string | null }, ...(teams ?? []).filter((t) => t?._id).map((t) => ({ key: `team:${t._id}`, name: t.name ?? "Team", teamId: t._id as string, icon: t.icon, color: t.color }))];
    return all.filter((w) => (w.teamId ? w.key !== active : !active?.startsWith("user:"))).map(({ key: _k, ...w }) => w);
  }, [teams, active]);
}

type WorkspaceName = { name: string; teamId: string | null; icon?: string; color?: string };

/** Switching the active workspace moves every window and the CLI with it, so the press shows that and asks once. */
function switchLedger(from: string, to: string): SwitchLedger {
  return {
    name: "Active workspace",
    subject: to,
    shift: [from, to],
    figures: [],
    rows: [{ k: "Moves", v: "Every window, phone and the CLI" }, { k: "Back", v: `Switch to ${from}` }],
    confirm: `Switch to ${to}`,
    keep: `Stay in ${from}`,
  };
}

/** A press that makes another workspace the active one, through the switch review. */
function WorkspaceSwitch({ ws, primary }: { ws: WorkspaceName; primary?: boolean }) {
  const switchTo = useSwitchWorkspace();
  const here = useWorkspaceName(useActiveWorkspaceKey());
  return (
    <ConsequentialSwitch
      on={false}
      ledger={switchLedger(here?.name ?? "this workspace", ws.name)}
      onTurnOn={() => void switchTo(ws.teamId)}
      onTurnOff={() => {}}
      trigger={({ press }) => (
        <button type="button" className="ops-btn" data-size={primary ? undefined : "sm"} data-tone={primary ? "primary" : undefined} onClick={press} data-ops-switch>
          {ws.icon || ws.color ? <TeamIcon icon={ws.icon} color={ws.color} className="w-3.5 h-3.5" /> : null}Switch to {ws.name}
        </button>
      )}
    />
  );
}

export function OpsWorkspaceBar({ itemRef, workspace }: { itemRef: string; workspace: string }) {
  const ws = useWorkspaceName(workspace);
  if (!ws) return null;
  return (
    <div className="ops-wsbar" role="status" data-ops-foreign={workspace}>
      {ws.icon || ws.color ? <TeamIcon icon={ws.icon} color={ws.color} className="w-3.5 h-3.5" /> : null}
      <span><span className="ops-mono">{itemRef}</span> is in <b>{ws.name}</b></span>
      <WorkspaceSwitch ws={ws} />
    </div>
  );
}

// ── Walking issues ──

/** Previous and next issue in the list it was opened from (k and j on the page), and where in it this one sits. */
export function IssueStepper({ id }: { id: string }) {
  const router = useRouter();
  const group = useOpsGroup(id);
  const groups = useOpsGroups();
  const ref = group ? group.short_id || group._id : id;
  const fallback = useMemo(() => (group ? groups.filter((g) => g.status === group.status && !isRecordNotIssue(g)).map((g) => g.short_id || g._id) : []), [groups, group]);
  const order = issueListOrder().includes(ref) ? issueListOrder() : fallback;
  const at = order.indexOf(ref);
  const prev = at > 0 ? issueStep(ref, -1, fallback) : null;
  const next = at >= 0 ? issueStep(ref, 1, fallback) : null;
  // An issue this list does not hold (not found, or not read yet) has nowhere to step from.
  if (!group && at < 0) return null;
  return (
    <span className="ops-step" aria-label="Move between issues" data-ops-step>
      <button type="button" disabled={!prev} onClick={() => prev && router.push(opsHref.issue(prev))} title="Previous issue"><ChevronLeft className="w-3 h-3" /><KeyCap size="xs">k</KeyCap></button>
      {at >= 0 && order.length > 1 ? <span className="ops-step-pos ops-num">{at + 1} of {order.length.toLocaleString()} issues</span> : null}
      <button type="button" disabled={!next} onClick={() => next && router.push(opsHref.issue(next))} title="Next issue"><KeyCap size="xs">j</KeyCap><ChevronRight className="w-3 h-3" /></button>
    </span>
  );
}

// ── A tab bar that fits ──

/** The tabs folded off a narrow bar, as a menu at its end; a dot when one of them holds an alert. */
export function TabMore({ tabs }: { tabs: { key: string; label: string; href: string; count?: string; alert?: boolean; disabled?: boolean }[] }) {
  if (!tabs.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="ops-tab ops-tab-more" data-ops-tab-more={tabs.length} aria-label={`More views: ${tabs.map((t) => t.label).join(", ")}`}>
          More
          {tabs.some((t) => t.alert) ? <i className="ops-tab-more-dot" aria-hidden /> : null}
          <ChevronDown className="w-3 h-3" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="ops-home-menu">
        {tabs.map((t) => (
          <DropdownMenuItem key={t.key} asChild disabled={t.disabled}>
            <Link href={t.href} data-ops-tab-folded={t.key}>
              {t.label}
              {t.count ? <span className="ops-tab-count ml-auto" data-alert={t.alert ? "true" : undefined}>{t.count}</span> : null}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── An id this workspace does not hold ──

const NOT_FOUND_LIST: Record<"issue" | "replay" | "metric" | "source" | "page", { tab: "issues" | "replays" | "metrics" | null; label: string }> = {
  issue: { tab: "issues", label: "Issues" },
  replay: { tab: "replays", label: "Replays" },
  metric: { tab: "metrics", label: "Metrics" },
  // A source has no list tab: the way back is the Overview, whose Sources table names every one.
  source: { tab: null, label: "Overview" },
  // An address under /ops that names no view (a typo, an old link).
  page: { tab: null, label: "Overview" },
};

const KIND_WORD = { issue: "Issue", replay: "Replay", metric: "Metric", source: "Source" } as const;

/**
 * An opened id that is not here, with the ways on: switch to the workspace
 * that holds it (when the server named one), back to its list, or search the
 * list for it. `checking` while a slower read may still find it.
 */
export function OpsNotFound({ id, kind, workspace, checking, lookingElsewhere }: { id: string; kind: "issue" | "replay" | "metric" | "source" | "page"; workspace?: string | null; checking?: boolean; /** The other workspaces are still being asked: a small mark beside a finished verdict. */ lookingElsewhere?: boolean }) {
  const router = useRouter();
  const ws = useWorkspaceName(workspace ?? null);
  const switchTo = useSwitchWorkspace();
  const active = useActiveWorkspaceKey();
  const here = useWorkspaceName(active);
  const others = useOtherWorkspaces(active);
  const [q, setQ] = useState(id);
  // A workspace picked from Look in waits on the same switch review the Switch press opens.
  const [lookIn, setLookIn] = useState<WorkspaceName | null>(null);
  const list = NOT_FOUND_LIST[kind];
  const listHref = list.tab ? opsHref.tab(list.tab) : opsHref.home();
  return (
    <div className="ops-notfound" data-ops-notfound={id} data-checking={checking ? "true" : undefined}>
      <div className="ops-notfound-title">
        {kind !== "page" && <span>{KIND_WORD[kind]}</span>}
        <span className="ops-mono">{id}</span>
        {ws ? <span>is in <b>{ws.name}</b></span> : <span className="ops-dim">{checking ? "not in this workspace's lists" : <>not in <b>{here?.name ?? "this workspace"}</b></>}</span>}
        {checking && <i className="ops-notfound-spin" aria-label="Still checking" />}
        {!checking && !ws && lookingElsewhere && <span className="ops-dim ops-notfound-elsewhere" data-ops-looking-elsewhere><i className="ops-notfound-spin" aria-hidden />other workspaces</span>}
      </div>
      <div className="ops-notfound-actions">
        {ws && <WorkspaceSwitch ws={ws} primary />}
        {/* Nothing names where it lives: the other workspaces the reader belongs to, one press each, as the place to look next. */}
        {!ws && !checking && others.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="ops-btn" data-ops-look-in>Look in<ChevronDown className="w-3.5 h-3.5" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              {others.map((o) => (
                <DropdownMenuItem key={o.teamId ?? "personal"} onSelect={() => setLookIn(o)} data-ops-look-in-ws={o.teamId ?? "personal"}>
                  {o.icon || o.color ? <TeamIcon icon={o.icon} color={o.color} className="w-3.5 h-3.5" /> : null}{o.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Link href={listHref} className="ops-btn" data-ops-notfound-back><ChevronLeft className="w-3.5 h-3.5" />{list.label}</Link>
        {list.tab && <form
          className="ops-notfound-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            const v = q.trim();
            router.push(v ? `${listHref}?q=${encodeURIComponent(v)}` : listHref);
          }}
        >
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${list.label}`} placeholder={`Search ${list.label.toLowerCase()}`} />
          <button type="submit" className="ops-btn" data-size="sm">Search</button>
        </form>}
      </div>
      {lookIn && <SwitchReview ledger={switchLedger(here?.name ?? "this workspace", lookIn.name)} onClose={() => setLookIn(null)} onConfirm={() => { const to = lookIn; setLookIn(null); void switchTo(to.teamId); }} />}
    </div>
  );
}
