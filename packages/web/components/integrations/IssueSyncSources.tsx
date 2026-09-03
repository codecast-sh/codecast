// The imported containers inside the GitHub and Linear cards
// (docs/architecture/issue-sync.md S1.3, S9): a Linear team or project, or a
// GitHub repo, each mapped to one codecast project whose tasks are that
// container's issues.
//
// Local-first is the law: every row here comes from the store collection
// `issueSyncSources` (fed app-wide by useSyncIssueSyncSources), and every
// gesture writes the store draft first and rides a named dispatch side effect
// to the mutation. Nothing on this surface waits on a round trip to paint.
//
// The one exception is the import picker's candidate list, which is an ACTION
// (`issueSync.listRemoteCandidates` calls the provider's API live). It has no
// store to paint from, so it owns an honest loading and error state.

import { useCallback, useState } from "react";
import { useAction } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Link } from "react-router";
import { toast } from "sonner";
import { ChevronDown, Loader2, Plus, RefreshCw } from "lucide-react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useInboxStore } from "../../store/inboxStore";
import { useIssueSyncSources } from "../../hooks/useSyncIssueSyncSources";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { formatRelative } from "../../lib/utils";
import { Switch } from "../ui/switch";
import { ConfirmButton, LedgerLine, QuietButton, StatusDot, type DotTone } from "./parts";

const api = _api as any;

type Provider = "linear" | "github";

/** A candidate as listRemoteCandidates reports it (S9). */
type Candidate = {
  kind: "linear_project" | "linear_team" | "github_repo";
  external_id: string;
  external_key?: string;
  name: string;
  url?: string;
};

const KIND_LABEL: Record<string, string> = {
  linear_project: "project",
  linear_team: "team",
  github_repo: "repo",
};

/** A source's state in one dot: an error outranks a pause, which outranks running. */
function sourceTone(source: any): { tone: DotTone; label: string } {
  if (source.last_error) return { tone: "bad", label: "error" };
  if (source.status === "paused") return { tone: "idle", label: "paused" };
  return { tone: "ok", label: "syncing" };
}

/** The delegation convention: which provider-side signal hands an issue to an agent. */
function DelegationSettings({ source }: { source: any }) {
  const update = useInboxStore((s) => s.updateIssueSyncSource);
  const set = (fields: Record<string, any>) => update(source._id, fields);

  return (
    <div className="mt-2 space-y-2 rounded-md bg-sol-bg-highlight/30 px-3 py-2.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-sol-text-dim">Delegate label</span>
          <input
            type="text"
            defaultValue={source.delegate_label ?? "agent"}
            placeholder="agent"
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value !== (source.delegate_label ?? "agent")) set({ delegate_label: value });
            }}
            className="mt-1 h-7 w-full rounded border border-sol-border bg-sol-bg px-2 font-mono text-xs text-sol-text focus:border-sol-cyan focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-sol-text-dim">Delegate assignee</span>
          <input
            type="text"
            defaultValue={source.delegate_assignee ?? ""}
            placeholder={source.provider === "github" ? "github login" : "linear email"}
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value !== (source.delegate_assignee ?? "")) set({ delegate_assignee: value });
            }}
            className="mt-1 h-7 w-full rounded border border-sol-border bg-sol-bg px-2 font-mono text-xs text-sol-text focus:border-sol-cyan focus:outline-none"
          />
        </label>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs text-sol-text-muted">
          Spawn a session when an issue takes the label or assignee above
        </span>
        <Switch
          checked={!!source.auto_spawn}
          onCheckedChange={(v: boolean) => set({ auto_spawn: v })}
          aria-label="Spawn a session on delegation"
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs text-sol-text-muted">
          Create the issue on {source.provider === "github" ? "GitHub" : "Linear"} for tasks born here
        </span>
        <Switch
          checked={!!source.push_new_tasks}
          onCheckedChange={(v: boolean) => set({ push_new_tasks: v })}
          aria-label="Push new tasks to the provider"
        />
      </div>
    </div>
  );
}

function SourceRow({ source }: { source: any }) {
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const update = useInboxStore((s) => s.updateIssueSyncSource);
  const remove = useInboxStore((s) => s.removeIssueSyncSource);
  const syncNow = useAction(api.issueSync.syncNow);
  const { tone, label } = sourceTone(source);
  const paused = source.status === "paused";

  const runSync = async () => {
    setSyncing(true);
    try {
      await syncNow({ id: source._id });
      toast.success(`Syncing ${source.name}`);
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't start the sync");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="flex min-w-0 items-center gap-1.5 text-left text-xs font-medium text-sol-text hover:text-sol-cyan"
              aria-expanded={open}
            >
              <ChevronDown className={`h-3 w-3 shrink-0 text-sol-text-dim transition-transform ${open ? "" : "-rotate-90"}`} />
              <span className="truncate">{source.name}</span>
            </button>
            <span className="shrink-0 rounded bg-sol-bg-highlight px-1.5 py-[1px] font-mono text-[10px] text-sol-text-dim">
              {KIND_LABEL[source.kind] ?? source.kind}
            </span>
            <StatusDot tone={tone}>{label}</StatusDot>
          </div>
          <LedgerLine
            className="mt-0.5 pl-[18px]"
            parts={[
              source.project_id ? (
                <Link to={`/projects/${source.project_id}`} className="hover:text-sol-cyan hover:underline">
                  {source.project_name ?? "project"}
                </Link>
              ) : (
                "project pending"
              ),
              source.last_synced_at ? `synced ${formatRelative(source.last_synced_at)}` : "never synced",
              source.last_webhook_at ? `webhook ${formatRelative(source.last_webhook_at)}` : null,
            ]}
          />
          {source.last_error && (
            <p className="mt-1 pl-[18px] text-[11px] leading-relaxed text-sol-red">{source.last_error}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <QuietButton onClick={runSync} busy={syncing} title="Pull the provider's issues now">
            <RefreshCw className="h-3 w-3" />
            Sync
          </QuietButton>
          <button
            type="button"
            onClick={() => update(source._id, { status: paused ? "active" : "paused" })}
            className="text-[11px] text-sol-text-muted hover:text-sol-text"
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <ConfirmButton
            label="Remove"
            question="Tasks stay; syncing stops."
            onConfirm={() => remove(source._id)}
          />
        </div>
      </div>
      {open && <DelegationSettings source={source} />}
    </div>
  );
}

/** The picker: what this connection can import, and where its tasks should land. */
function ImportPicker({ provider, onDone }: { provider: Provider; onDone: () => void }) {
  const listCandidates = useAction(api.issueSync.listRemoteCandidates);
  const addSource = useInboxStore((s) => s.addIssueSyncSource);
  const projects = useWorkspaceCollection<any>("projects");
  const existing = useIssueSyncSources(provider);

  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [projectId, setProjectId] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res: any = await listCandidates({ provider });
      setCandidates(Array.isArray(res) ? res : (res?.candidates ?? []));
    } catch (e: any) {
      setError(e?.message ?? "Couldn't reach the provider");
    } finally {
      setLoading(false);
    }
  }, [listCandidates, provider]);

  // One fetch per opening. The picker is mounted only while open, so this asks
  // the provider when the reader asks for it and never in the background.
  useWatchEffect(() => {
    void load();
  }, [load]);

  const alreadyImported = new Set(existing.map((s) => String(s.external_id)));

  const confirmImport = () => {
    if (!picked) return;
    addSource({
      provider,
      kind: picked.kind,
      external_id: picked.external_id,
      external_key: picked.external_key,
      name: picked.name,
      url: picked.url,
      project_id: projectId || undefined,
      project_name: projectId ? projects.find((p) => p._id === projectId)?.title : picked.name,
    });
    toast.success(`Importing ${picked.name}`);
    onDone();
  };

  return (
    <div className="mt-2 rounded-md bg-sol-bg-highlight/30 px-3 py-2.5">
      {loading ? (
        <div className="flex items-center gap-2 py-2 text-xs text-sol-text-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          Asking {provider === "github" ? "GitHub" : "Linear"} what you can import
        </div>
      ) : error ? (
        <div className="space-y-2">
          <p className="text-xs leading-relaxed text-sol-red">{error}</p>
          <QuietButton onClick={load}>Try again</QuietButton>
        </div>
      ) : !candidates || candidates.length === 0 ? (
        <p className="py-1 text-xs text-sol-text-muted">
          Nothing to import — the connection can see no {provider === "github" ? "repositories" : "teams or projects"}.
        </p>
      ) : (
        <>
          <div className="max-h-52 space-y-px overflow-y-auto">
            {candidates.map((c) => {
              const taken = alreadyImported.has(String(c.external_id));
              const active = picked?.external_id === c.external_id;
              return (
                <button
                  key={`${c.kind}:${c.external_id}`}
                  type="button"
                  disabled={taken}
                  onClick={() => setPicked(c)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                    active ? "bg-sol-cyan/10 text-sol-cyan" : "text-sol-text hover:bg-sol-bg-highlight"
                  } disabled:cursor-not-allowed disabled:opacity-45`}
                >
                  <span className="truncate">{c.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-sol-text-dim">
                    {KIND_LABEL[c.kind] ?? c.kind}
                  </span>
                  {taken && <span className="ml-auto shrink-0 text-[10px] text-sol-text-dim">imported</span>}
                </button>
              );
            })}
          </div>
          {picked && (
            <div className="mt-2.5 border-t border-sol-border/40 pt-2.5">
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-sol-text-dim">
                  Its tasks land in
                </span>
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="mt-1 h-7 w-full rounded border border-sol-border bg-sol-bg px-2 text-xs text-sol-text focus:border-sol-cyan focus:outline-none"
                >
                  <option value="">Create a project named “{picked.name}”</option>
                  {projects.map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              </label>
              <div className="mt-2 flex items-center gap-2">
                <QuietButton onClick={confirmImport} className="border-sol-cyan text-sol-cyan">
                  Import {picked.name}
                </QuietButton>
                <button
                  type="button"
                  onClick={onDone}
                  className="text-[11px] text-sol-text-muted hover:text-sol-text"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The sources block folded into a provider card. Renders nothing until the
 * provider is connected — there is nothing to import through a connection that
 * does not exist.
 */
export function IssueSyncSources({ provider, connected }: { provider: Provider; connected: boolean }) {
  const sources = useIssueSyncSources(provider);
  const [importing, setImporting] = useState(false);

  if (!connected) return null;

  return (
    <div className="mt-3 border-t border-sol-border/40 pt-2.5">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sol-text-muted">
          Issues as tasks
        </h4>
        <QuietButton onClick={() => setImporting((v) => !v)}>
          <Plus className="h-3 w-3" />
          Import
        </QuietButton>
      </div>
      {importing && <ImportPicker provider={provider} onDone={() => setImporting(false)} />}
      {sources.length === 0 ? (
        !importing && (
          <p className="mt-1.5 text-xs leading-relaxed text-sol-text-muted">
            Nothing imported yet. Import a {provider === "github" ? "repository" : "team or project"} and its
            issues become tasks in a codecast project, both ways.
          </p>
        )
      ) : (
        <div className="mt-1 divide-y divide-sol-border/30">
          {sources.map((s) => (
            <SourceRow key={s._id} source={s} />
          ))}
        </div>
      )}
    </div>
  );
}
