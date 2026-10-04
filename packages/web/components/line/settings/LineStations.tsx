"use client";
// The line's stations for one project (plan pl-838 step 3): the graph, each
// station's prompt or script, and the project's customized copy. The shipped
// line is read only; "Customize this line" forks it into one of the viewer's
// workflows (slug line-<project>), where a station's prompt, script and
// timeout are edited in place, marked where they differ from shipped, and
// reset one at a time or all at once. The roles whose area holds the project
// are listed with the line each runs, and can be moved onto the customized
// one. Every write is saveLineWorkflow or setRoleLine: the store paints it at
// once and the server echo settles it.
import { useMemo, useState, type ReactNode } from "react";
import { useInboxStore } from "../../../store/inboxStore";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useSyncOrgTree } from "../../../hooks/useSyncOrgTree";
import { useWorkflowBySlug, useWorkflows } from "../../../hooks/useSyncWorkflows";
import { WorkflowGraphView, type WFNode } from "../../WorkflowGraphView";
import { KeyCap } from "../../KeyboardShortcutsHelp";
import { isMac } from "../../../shortcuts";
import { lineOptions } from "../../org/scope/lineBoard";
import { SHIPPED_LINE } from "../../../lib/line/shippedLine.generated";
import {
  editStation, forkShippedLine, isEditableStation, lineForkSlug, resetAllStations, resetStation,
  rolesOnProject, stationDiffs, stationText, type LineNode, type LineWorkflow, type StationPatch,
} from "../../../lib/line/lineStations";

type ProjectLike = { _id: string; short_id?: string | null; title?: string | null };

const asWorkflow = (row: any): LineWorkflow => ({
  slug: row.slug, name: row.name, goal: row.goal, source: row.source, nodes: row.nodes ?? [], edges: row.edges ?? [],
});

const minutes = (seconds: number | undefined) => (seconds ? String(Math.round((seconds / 60) * 10) / 10) : "");

export function LineStations({ projectId }: { projectId: string }) {
  const project = useInboxStore((s) => ((s as any).projects?.[projectId] ?? null) as ProjectLike | null);
  const me = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const save = useInboxStore((s) => (s as any).saveLineWorkflow as (wf: LineWorkflow) => void);
  const slug = useMemo(() => lineForkSlug(project ?? { _id: projectId }), [project, projectId]);
  const fork = useWorkflowBySlug(slug);
  const customized = !!fork;

  const nodes = (fork?.nodes ?? SHIPPED_LINE.nodes) as LineNode[];
  const edges = fork?.edges ?? SHIPPED_LINE.edges;
  const diffs = useMemo(() => (fork ? stationDiffs(fork.nodes ?? [], SHIPPED_LINE) : {}), [fork]);
  const marked = useMemo(() => new Set(Object.keys(diffs)), [diffs]);
  const changedCount = marked.size;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  const customize = () => save(forkShippedLine(SHIPPED_LINE, project ?? { _id: projectId }));
  const write = (next: Pick<LineWorkflow, "nodes"> & Partial<Pick<LineWorkflow, "edges">>) => {
    if (fork) save({ ...asWorkflow(fork), ...next });
  };
  const patchStation = (id: string, patch: StationPatch) => fork && write({ nodes: editStation(fork.nodes, id, patch) });
  const resetOne = (id: string) => fork && write({ nodes: resetStation(fork.nodes, id, SHIPPED_LINE) });
  const resetAll = () => write(resetAllStations(SHIPPED_LINE));

  return (
    <div className="space-y-3" data-line-stations>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[13px]" style={{ color: "var(--sol-text)" }}>
            {customized
              ? <>This project runs its own copy, <code style={{ color: "var(--sol-violet)" }}>{slug}</code>.</>
              : <>This project runs the shipped line.</>}
          </div>
          <div className="text-[11.5px] mt-0.5" style={{ color: "var(--sol-text-dim)" }}>
            {customized
              ? changedCount === 0
                ? "Every station matches shipped. Click a station to edit its prompt, script or timeout."
                : `${changedCount} ${changedCount === 1 ? "station differs" : "stations differ"} from shipped. Click a station to edit or reset it.`
              : "Click a station to read its prompt or script. Customize the line to change them for this project."}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!customized && <Button tone="accent" onClick={customize} data-customize-line>Customize this line</Button>}
          {customized && changedCount > 0 && <Button onClick={resetAll} data-reset-all>Reset all to shipped</Button>}
        </div>
      </div>

      <div className="rounded-md overflow-hidden" style={{ height: 340, border: "1px solid var(--sol-border)" }}>
        <WorkflowGraphView
          nodes={nodes as WFNode[]}
          edges={edges}
          selectedNodeId={selectedId}
          onNodeSelect={(n) => setSelectedId(n?.id ?? null)}
          markedNodeIds={marked}
          fitPadding={0.08}
        />
      </div>

      {selected && (
        <StationPanel
          key={selected.id}
          node={selected}
          editable={customized}
          changed={diffs[selected.id] ?? []}
          onPatch={(patch) => patchStation(selected.id, patch)}
          onReset={() => resetOne(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}

      <RunsThisLine projectId={projectId} forkSlug={customized ? slug : null} me={me} />
    </div>
  );
}

// ---------------------------------------------------------------- one station

function StationPanel({ node, editable, changed, onPatch, onReset, onClose }: {
  node: LineNode;
  editable: boolean;
  changed: string[];
  onPatch: (patch: StationPatch) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const body = stationText(node, SHIPPED_LINE);
  const field = body.kind;
  const canEdit = editable && isEditableStation(node);
  const [draft, setDraft] = useState(body.text);
  const [timeoutDraft, setTimeoutDraft] = useState(minutes(node.timeout));
  // A save, a reset or another window's edit moves the stored text: follow it.
  useWatchEffect(() => { setDraft(body.text); }, [body.text]);
  useWatchEffect(() => { setTimeoutDraft(minutes(node.timeout)); }, [node.timeout]);
  const dirty = draft !== body.text;
  const commitText = () => { if (field && dirty) onPatch({ [field]: draft }); };
  const commitTimeout = () => {
    const m = Number(timeoutDraft);
    const next = timeoutDraft.trim() === "" ? null : Number.isFinite(m) && m > 0 ? Math.round(m * 60) : undefined;
    if (next === undefined) { setTimeoutDraft(minutes(node.timeout)); return; }
    if ((next ?? undefined) !== node.timeout) onPatch({ timeout: next });
  };

  return (
    <div className="rounded-md p-3 space-y-2" style={{ background: "var(--sol-bg-alt)", border: "1px solid var(--sol-border)" }} data-station-panel={node.id}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[14px] font-semibold" style={{ color: "var(--sol-text)" }}>{node.label}</span>
        <code className="text-[11px]" style={{ color: "var(--sol-text-dim)" }}>{node.id}</code>
        {field && <Chip>{field}{body.file ? ` from ${body.file}` : ""}</Chip>}
        {changed.length > 0 && <Chip tone="magenta">edited: {changed.join(", ")}</Chip>}
        <span className="flex-1" />
        {editable && changed.length > 0 && <Button onClick={onReset} data-reset-station>Reset to shipped</Button>}
        <Button onClick={onClose} aria-label="Close station">Close</Button>
      </div>

      {!field && <div className="text-[12px]" style={{ color: "var(--sol-text-dim)" }}>This station routes the run and carries no prompt or script.</div>}

      {field && !canEdit && (
        <pre className="text-[11.5px] leading-[1.5] whitespace-pre-wrap max-h-[420px] overflow-auto m-0 p-2 rounded" style={{ fontFamily: "var(--font-mono)", color: "var(--sol-text)", background: "var(--sol-card)" }}>
          {body.text || "(empty)"}
        </pre>
      )}

      {field && canEdit && (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitText(); }
              if (e.key === "Escape" && dirty) { e.preventDefault(); e.stopPropagation(); setDraft(body.text); }
            }}
            spellCheck={false}
            rows={Math.min(24, Math.max(6, draft.split("\n").length + 1))}
            className="w-full text-[11.5px] leading-[1.5] p-2 rounded outline-none resize-y"
            style={{ fontFamily: "var(--font-mono)", color: "var(--sol-text)", background: "var(--sol-card)", border: `1px solid ${dirty ? "var(--sol-yellow)" : "var(--sol-border)"}` }}
            aria-label={`${node.label} ${field}`}
            data-station-text
          />
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--sol-text-dim)" }}>
            {dirty
              ? <>Saves when you leave the field, or <KeyCap>{isMac ? "⌘" : "Ctrl"}</KeyCap><KeyCap>Enter</KeyCap>. <KeyCap>Esc</KeyCap> puts it back.</>
              : <>Saved. A run started after this reads the new {field}.</>}
          </div>
        </>
      )}

      {isEditableStation(node) && (field === "script" || node.timeout !== undefined || canEdit) && (
        <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--sol-text-muted)" }}>
          <span>Timeout</span>
          {canEdit ? (
            <input
              value={timeoutDraft}
              onChange={(e) => setTimeoutDraft(e.target.value)}
              onBlur={commitTimeout}
              onKeyDown={(e) => { if (e.key === "Enter") commitTimeout(); }}
              inputMode="decimal"
              placeholder="none"
              className="w-[72px] px-1.5 py-0.5 rounded text-[12px] outline-none"
              style={{ background: "var(--sol-card)", border: "1px solid var(--sol-border)", color: "var(--sol-text)" }}
              aria-label="Timeout in minutes"
              data-station-timeout
            />
          ) : (
            <span style={{ color: "var(--sol-text)" }}>{node.timeout ? minutes(node.timeout) : "none"}</span>
          )}
          <span>minutes</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- who runs it

function RunsThisLine({ projectId, forkSlug, me }: { projectId: string; forkSlug: string | null; me: string | null }) {
  const { tree } = useSyncOrgTree();
  const { workflows } = useWorkflows();
  const setRoleLine = useInboxStore((s) => (s as any).setRoleLine as (roleId: string, slug: string) => void);
  const rows = useMemo(() => rolesOnProject((tree?.roles ?? []) as any[], projectId), [tree, projectId]);
  const labelOf = (slug: string) => lineOptions(workflows, slug).find((o) => o.slug === slug)?.label ?? slug;

  return (
    <div className="space-y-1.5" data-runs-this-line>
      <div className="text-[12px] font-medium" style={{ color: "var(--sol-text-muted)" }}>Roles that run this project's line</div>
      {rows.length === 0 && (
        <div className="text-[12px]" style={{ color: "var(--sol-text-dim)" }}>No role looks after this project yet, so nothing starts the line on its own.</div>
      )}
      {rows.map(({ role, slug }) => {
        const onFork = !!forkSlug && slug === forkSlug;
        // The sweep runs the slug from the host's own workflows (orgLine.ts),
        // so only the host's copy of this line can be the one a role runs.
        const hostedHere = !!me && String(role.host_user_id) === me;
        return (
          <div key={role._id} className="flex items-center gap-2 flex-wrap text-[12.5px]" data-role-line={role._id}>
            <span style={{ color: "var(--sol-text)" }}>{role.name}</span>
            <span style={{ color: "var(--sol-violet)", fontFamily: "var(--font-mono)" }}>@{role.handle}</span>
            <span style={{ color: "var(--sol-text-dim)" }}>runs</span>
            <Chip tone={onFork ? "magenta" : undefined}>{onFork ? "this project's copy" : labelOf(slug)}</Chip>
            <span className="flex-1" />
            {forkSlug && !onFork && hostedHere && <Button onClick={() => setRoleLine(role._id, forkSlug)}>Run the customized line</Button>}
            {forkSlug && !onFork && !hostedHere && (
              <span className="text-[11px]" style={{ color: "var(--sol-text-dim)" }}>Runs on a teammate's machine, which has no copy of your customized line</span>
            )}
            {onFork && <Button onClick={() => setRoleLine(role._id, "line")}>Back to shipped</Button>}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- bits

function Chip({ children, tone }: { children: ReactNode; tone?: "magenta" }) {
  const color = tone === "magenta" ? "var(--sol-magenta)" : "var(--sol-text-muted)";
  return (
    <span className="text-[10.5px] px-1.5 py-[1px] rounded" style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
      {children}
    </span>
  );
}

function Button({ children, onClick, tone, ...rest }: { children: ReactNode; onClick: () => void; tone?: "accent" } & Partial<Record<`data-${string}` | "aria-label", any>>) {
  const color = tone === "accent" ? "var(--sol-blue)" : "var(--sol-text-muted)";
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[11.5px] px-2 py-1 rounded transition-colors hover:brightness-110"
      style={{ color, border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} ${tone ? 14 : 6}%, transparent)` }}
      {...rest}
    >
      {children}
    </button>
  );
}
