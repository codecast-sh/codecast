"use client";
// The line's stations for one project (plan pl-838 step 3): the graph, each
// station's prompt or script, and the project's customized copy. The shipped
// line is read only; "Customize this line" forks it into one of the viewer's
// workflows (slug line-<project>), where a station's prompt, script and
// timeout are edited in place, marked where they differ from shipped, and
// reset one at a time or all at once. A role runs the line its own setting
// names, so the copy runs only once a role is switched onto it: the header
// says which roles do, and the roles whose area holds the project are listed
// with the line each runs. Every write is saveLineWorkflow,
// removeLineWorkflow or setRoleLine: the store paints it at once and the
// server echo settles it.
//
// A project whose line profile a machine has published (it names the root
// and the device) keeps its line in its repo instead (line-map.md LX5): the
// stations come from `.codecast/line/` as published, a station edit travels
// the profile's edit path to that machine (useLineStationEdits), and the
// first one writes the shipped line out into the repo. The workflow copy
// above is only for a project no machine has published.
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import Link from "next/link";
import { useInboxStore } from "../../../store/inboxStore";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useSyncOrgTree } from "../../../hooks/useSyncOrgTree";
import { useWorkflowBySlug, useWorkflows } from "../../../hooks/useSyncWorkflows";
import { ConfirmButton } from "../../integrations/parts";
import { WorkflowGraphView, type WFNode } from "../../WorkflowGraphView";
import { KeyCap } from "../../KeyboardShortcutsHelp";
import { isMac } from "../../../shortcuts";
import { lineOptions } from "../../org/scope/lineBoard";
import { LineChip } from "../CustomizedLineChip";
import { EditStatus } from "./LineValueRow";
import { useLineStationEdits } from "./useLineStationEdits";
import { REPO_LINE_REL_DIR } from "@codecast/shared/contracts/lineProfile";
import { SHIPPED_LINE } from "../../../lib/line/shippedLine.generated";
import {
  editStation, forkShippedLine, isEditableStation, lineForkSlug, resetAllStations, resetStation,
  rolesOnProject, stationDiffs, stationText, type LineNode, type LineWorkflow, type ShippedLine, type StationPatch,
} from "../../../lib/line/lineStations";

type ProjectLike = { _id: string; short_id?: string | null; title?: string | null };
type RoleRow = { _id: string; name: string; handle: string; short_id?: string; host_user_id?: string; status?: string; scope: { project_ids: string[] }; line_workflow_slug?: string | null };

const asWorkflow = (row: any): LineWorkflow => ({
  slug: row.slug, name: row.name, goal: row.goal, source: row.source, nodes: row.nodes ?? [], edges: row.edges ?? [],
});

const minutes = (seconds: number | undefined) => (seconds ? String(Math.round((seconds / 60) * 10) / 10) : "");
const roles = (n: number) => `${n} ${n === 1 ? "role" : "roles"}`;

/** focusStation (a link in, ?station=) opens that station's panel, opens the
 *  graph around it, and scrolls the panel into view. */
export function LineStations({ projectId, focusStation }: { projectId: string; focusStation?: string | null }) {
  const project = useInboxStore((s) => (s.projects?.[projectId] ?? null) as ProjectLike | null);
  const me = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const save = useInboxStore((s) => s.saveLineWorkflow);
  const removeFork = useInboxStore((s) => s.removeLineWorkflow);
  const setRoleLine = useInboxStore((s) => s.setRoleLine);
  const slug = useMemo(() => lineForkSlug(project ?? { _id: projectId }), [project, projectId]);
  // The repo is the line's home once a machine has published its profile (LX5).
  const repo = useLineStationEdits(projectId);
  const inRepo = !!repo.published?.root && !!repo.published?.device_id;
  // undefined while the server has not said; null once it said there is none.
  const forkRow = useWorkflowBySlug(slug);
  const fork = inRepo ? null : forkRow;
  const customized = !!fork;

  // The sweep runs a role's slug from its host's own workflows (orgLine.ts),
  // so only roles the viewer hosts can run the viewer's copy.
  const { tree } = useSyncOrgTree();
  const rows = useMemo(() => rolesOnProject((tree?.roles ?? []) as RoleRow[], projectId), [tree, projectId]);
  const hostedHere = (r: RoleRow) => !!me && String(r.host_user_id) === me;
  const onFork = customized ? rows.filter((r) => r.slug === slug && hostedHere(r.role)) : [];

  const nodes = (inRepo ? repo.nodes : fork?.nodes ?? SHIPPED_LINE.nodes) as LineNode[];
  const edges = inRepo ? repo.edges : fork?.edges ?? SHIPPED_LINE.edges;
  const forkDiffs = useMemo(() => (fork ? stationDiffs(fork.nodes ?? [], SHIPPED_LINE) : {}), [fork]);
  const diffs = inRepo ? repo.diffs : forkDiffs;
  const marked = useMemo(() => new Set(Object.keys(diffs)), [diffs]);
  const changedCount = marked.size;

  const [selectedId, setSelectedId] = useState<string | null>(focusStation ?? null);
  useWatchEffect(() => { if (focusStation) setSelectedId(focusStation); }, [focusStation]);
  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const panel = useRef<HTMLDivElement>(null);
  const arrived = !!focusStation && selected?.id === focusStation;
  useEffect(() => {
    if (arrived) panel.current?.scrollIntoView({ block: "center" });
  }, [arrived, focusStation]);

  const customize = () => save(forkShippedLine(SHIPPED_LINE, project ?? { _id: projectId }), { create: true });
  const write = (next: Pick<LineWorkflow, "nodes"> & Partial<Pick<LineWorkflow, "edges">>) => {
    if (fork) save({ ...asWorkflow(fork), ...next });
  };
  const patchStation = (id: string, patch: StationPatch) => (inRepo ? repo.setStation(id, patch) : fork && write({ nodes: editStation(fork.nodes, id, patch) }));
  const resetOne = (id: string) => (inRepo ? repo.resetStation(id) : fork && write({ nodes: resetStation(fork.nodes, id, SHIPPED_LINE) }));
  const resetAll = () => (inRepo ? repo.resetAll() : write(resetAllStations(SHIPPED_LINE)));
  // Roles on the copy go back to the shipped line first, so none is left
  // naming a workflow that is gone.
  const stopCustomizing = () => {
    for (const { role } of onFork) setRoleLine(role._id, "line");
    removeFork(slug);
  };

  const copy = <code style={{ color: "var(--sol-violet)" }}>{slug}</code>;
  if (inRepo) {
    return (
      <div className="space-y-3" data-line-stations data-line-home="repo">
        <RepoLineHeader repo={repo} changedCount={changedCount} onResetAll={resetAll} />
        <div className="rounded-md overflow-hidden" style={{ height: 240, border: "1px solid var(--sol-border)" }}>
          <WorkflowGraphView
            nodes={nodes as WFNode[]}
            edges={edges}
            selectedNodeId={selectedId}
            onNodeSelect={(n) => setSelectedId(n?.id ?? null)}
            markedNodeIds={marked}
            fitPadding={0.08}
            fitLayers={5}
            fitAround={focusStation ?? undefined}
            minimap={false}
          />
        </div>
        {selected && (
          <StationPanel
            key={selected.id}
            ref={panel}
            arrived={arrived}
            node={selected}
            line={repo.source.kind === "repo" ? repo.source.line : SHIPPED_LINE}
            editable={repo.writable}
            runsIt
            changed={diffs[selected.id] ?? []}
            onPatch={(patch) => patchStation(selected.id, patch)}
            onReset={() => resetOne(selected.id)}
            onClose={() => setSelectedId(null)}
            status={<EditStatus s={repo.stateOf(selected.id)} device={repo.gate.device ?? "the machine"} now={repo.now} onDismiss={() => repo.clear(selected.id)} />}
            pending={isTravelling(repo.stateOf(selected.id))}
          />
        )}
        <RunsThisLine rows={rows} forkSlug={null} hostedHere={hostedHere} setRoleLine={setRoleLine} repoLine />
      </div>
    );
  }
  return (
    <div className="space-y-3" data-line-stations>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 max-w-[64ch]">
          <div className="text-[13px]" style={{ color: "var(--sol-text)" }} data-line-stations-headline>
            {fork === undefined
              ? <span style={{ color: "var(--sol-text-dim)" }}>Looking for this project's copy of the line…</span>
              : !customized
                ? <>This project runs the shipped line.</>
                : onFork.length === 0
                  ? <>Your customized copy, {copy}. No role runs it yet.</>
                  : <>{roles(onFork.length)} {onFork.length === 1 ? "runs" : "run"} this project's customized copy, {copy}.</>}
          </div>
          {fork !== undefined && (
            <div className="text-[11.5px] mt-0.5" style={{ color: "var(--sol-text-dim)" }}>
              {!customized
                ? "Click a station to read its prompt or script. Customizing makes an editable copy for this project; roles keep the shipped line until you switch them, and the copy no longer follows later updates to the shipped line."
                : `${changedCount === 0 ? "Every station matches shipped." : `${changedCount} ${changedCount === 1 ? "station differs" : "stations differ"} from shipped.`} Click a station to edit${changedCount ? " or reset" : ""} it.${onFork.length === 0 ? " Switch a role to the copy below for its runs to use it." : ""}`}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {fork === null && <button type="button" className="lset-primary" onClick={customize} data-customize-line>Customize this line</button>}
          {customized && changedCount > 0 && <button type="button" className="lset-ghost" onClick={resetAll} data-reset-all>Reset all to shipped</button>}
          {customized && (
            <ConfirmButton
              label="Stop customizing"
              confirmLabel={`Delete the copy${onFork.length ? ` and move ${roles(onFork.length)} back` : ""}`}
              className="lset-ghost"
              onConfirm={stopCustomizing}
            />
          )}
        </div>
      </div>

      <div className="rounded-md overflow-hidden" style={{ height: 240, border: "1px solid var(--sol-border)" }}>
        <WorkflowGraphView
          nodes={nodes as WFNode[]}
          edges={edges}
          selectedNodeId={selectedId}
          onNodeSelect={(n) => setSelectedId(n?.id ?? null)}
          markedNodeIds={marked}
          fitPadding={0.08}
          fitLayers={5}
          fitAround={focusStation ?? undefined}
          minimap={false}
        />
      </div>

      {selected && (
        <StationPanel
          key={selected.id}
          ref={panel}
          arrived={arrived}
          node={selected}
          editable={customized}
          runsIt={onFork.length > 0}
          changed={diffs[selected.id] ?? []}
          onPatch={(patch) => patchStation(selected.id, patch)}
          onReset={() => resetOne(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}

      <RunsThisLine rows={rows} forkSlug={customized ? slug : null} hostedHere={hostedHere} setRoleLine={setRoleLine} />
    </div>
  );
}

// ---------------------------------------------------------------- one station

// ---------------------------------------------------------------- the repo's line

const isTravelling = (s: { state: string } | undefined) => s?.state === "sending" || s?.state === "waiting" || s?.state === "publishing";

/** What the repo holds, in one sentence, and the way back to shipped. */
function RepoLineHeader({ repo, changedCount, onResetAll }: { repo: ReturnType<typeof useLineStationEdits>; changedCount: number; onResetAll: () => void }) {
  const dir = <code style={{ color: "var(--sol-violet)" }}>{REPO_LINE_REL_DIR}</code>;
  const own = repo.source.kind === "repo";
  return (
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div className="min-w-0 max-w-[64ch]">
        <div className="text-[13px]" style={{ color: "var(--sol-text)" }} data-line-stations-headline>
          {own
            ? <>This project's line lives in its repo, in {dir}{repo.version ? <>, at version <code data-line-version style={{ color: "var(--sol-text-muted)" }}>{repo.version.slice(0, 8)}</code></> : null}.</>
            : <>This project's repo has no line of its own yet, so its runs use their role's line or the shipped one.</>}
        </div>
        <div className="text-[11.5px] mt-0.5" style={{ color: "var(--sol-text-dim)" }}>
          {!repo.writable
            ? repo.gate.reason
            : own
              ? `${changedCount === 0 ? "Every station matches shipped." : `${changedCount} ${changedCount === 1 ? "station differs" : "stations differ"} from shipped.`} Click a station to edit${changedCount ? " or reset" : ""} it. An edit is written to the repo on ${repo.gate.device} and checked before it lands; each run records the version it ran.`
              : `Click a station to read it. Editing one writes the line into the repo, in ${REPO_LINE_REL_DIR}, on ${repo.gate.device}; runs in that checkout use it from then on.`}
        </div>
      </div>
      {own && repo.writable && changedCount > 0 && (
        <button type="button" className="lset-ghost shrink-0" onClick={onResetAll} data-reset-all>Reset all to shipped</button>
      )}
    </div>
  );
}

function StationPanel({ ref, arrived, node, line = SHIPPED_LINE, editable, runsIt, changed, onPatch, onReset, onClose, status, pending }: {
  ref?: Ref<HTMLDivElement>;
  /** A link in named this station: the panel flashes once (settings.css). */
  arrived?: boolean;
  node: LineNode;
  editable: boolean;
  /** A role runs the customized copy, so a saved edit reaches a run. */
  runsIt: boolean;
  changed: string[];
  onPatch: (patch: StationPatch) => void;
  onReset: () => void;
  onClose: () => void;
  /** The line the station's files are named from: the repo's when it has one. */
  line?: Pick<ShippedLine, "files">;
  /** The edit's journey to the repo, said in place of the copy's save note. */
  status?: ReactNode;
  /** An edit of this station is still travelling: the editor follows the painted text without a "saved" note. */
  pending?: boolean;
}) {
  const body = stationText(node, line as ShippedLine);
  const field = body.kind;
  const canEdit = editable && isEditableStation(node);
  const [draft, setDraft] = useState(body.text);
  const [timeoutDraft, setTimeoutDraft] = useState(minutes(node.timeout));
  const [timeoutError, setTimeoutError] = useState<string | null>(null);
  // When this panel last saved something: "saved" is said only after a save.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // A save, a reset or another window's edit moves the stored text: follow it.
  useWatchEffect(() => { setDraft(body.text); }, [body.text]);
  useWatchEffect(() => { setTimeoutDraft(minutes(node.timeout)); }, [node.timeout]);
  const dirty = draft !== body.text;
  const patch = (p: StationPatch) => { onPatch(p); setSavedAt(Date.now()); };
  const commitText = () => { if (field && dirty) patch({ [field]: draft }); };
  const commitTimeout = () => {
    const m = Number(timeoutDraft);
    const next = timeoutDraft.trim() === "" ? null : Number.isFinite(m) && m > 0 ? Math.round(m * 60) : undefined;
    if (next === undefined) { setTimeoutError("Minutes, more than 0, or empty for none"); return; }
    setTimeoutError(null);
    if ((next ?? undefined) !== node.timeout) patch({ timeout: next });
  };
  const saveKeys = <><KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap><KeyCap size="xs">↵</KeyCap></>;

  return (
    <div ref={ref} className="rounded-md p-3 space-y-2 scroll-mt-4" style={{ background: "var(--sol-bg-alt)", border: "1px solid var(--sol-border)" }} data-station-panel={node.id} data-lset-target={arrived ? "true" : undefined}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[14px] font-semibold" style={{ color: "var(--sol-text)" }}>{node.label}</span>
        <code className="text-[11px]" style={{ color: "var(--sol-text-dim)" }}>{node.id}</code>
        {field && <LineChip>{field}{body.file ? ` from ${body.file}` : ""}</LineChip>}
        {changed.length > 0 && <LineChip tone="magenta">edited: {changed.join(", ")}</LineChip>}
        <span className="flex-1" />
        <span className="inline-flex items-center gap-4">
          {editable && changed.length > 0 && <button type="button" className="lset-ghost" onClick={onReset} data-reset-station>Reset to shipped</button>}
          <button type="button" className="lset-ghost" onClick={onClose} aria-label="Close station">Close</button>
        </span>
      </div>

      {!field && <p className="lset-empty">This station routes the run and carries no prompt or script.</p>}

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
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--sol-text-dim)" }} data-station-save-state>
            {dirty
              ? <>Saves when you leave the field, or on {saveKeys}. <KeyCap size="xs">Esc</KeyCap> puts it back.</>
              : status !== undefined
                ? <>{status}{!pending && <>Edit the {field}; it saves when you leave the field, or on {saveKeys}</>}</>
              : savedAt
                ? <span key={savedAt} className="lset-status" data-state={runsIt ? "saved" : "warn"} role="status">
                    {runsIt ? `Saved. A run of the customized line started after this reads the new ${field}.` : "Saved to the copy. No role runs it yet, so no run reads it."}
                  </span>
                : <>Edit the {field}; it saves when you leave the field, or on {saveKeys}</>}
          </div>
        </>
      )}

      {isEditableStation(node) && (field === "script" || node.timeout !== undefined || canEdit) && (
        <div className="lset-row" data-station-timeout-row>
          <div className="lset-key">
            <span className="lset-label">Timeout</span>
            <span className="lset-what">How long the station may run before the line stops it.</span>
          </div>
          <div className="lset-val">
            <div className="lset-val-line">
              {canEdit ? (
                <input
                  value={timeoutDraft}
                  onChange={(e) => { setTimeoutDraft(e.target.value); setTimeoutError(null); }}
                  onBlur={commitTimeout}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitTimeout();
                    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setTimeoutDraft(minutes(node.timeout)); setTimeoutError(null); }
                  }}
                  aria-invalid={timeoutError ? true : undefined}
                  inputMode="decimal"
                  placeholder="none"
                  className="lset-input"
                  style={{ width: 88, marginLeft: 0, boxShadow: "none", borderColor: "var(--sol-border)" }}
                  aria-label="Timeout in minutes"
                  data-station-timeout
                />
              ) : (
                <span className="lset-value" aria-disabled="true">{node.timeout ? minutes(node.timeout) : "none"}</span>
              )}
              <span className="lset-unit">minutes</span>
            </div>
            {timeoutError && <span className="lset-field-error" role="alert">{timeoutError}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- who runs it

function RunsThisLine({ rows, forkSlug, hostedHere, setRoleLine, repoLine }: {
  rows: Array<{ role: RoleRow; slug: string }>;
  /** The project keeps its line in its repo: a task-bound run in its checkout runs that, whatever line the role names. */
  repoLine?: boolean;
  forkSlug: string | null;
  hostedHere: (r: RoleRow) => boolean;
  setRoleLine: (roleId: string, slug: string) => void;
}) {
  const { workflows } = useWorkflows();
  const labelOf = (slug: string) => lineOptions(workflows, slug).find((o) => o.slug === slug)?.label ?? slug;

  return (
    <div data-runs-this-line>
      <div className="lset-label mb-1">Roles that run this project's line</div>
      {repoLine && rows.length > 0 && (
        <p className="lset-empty" data-runs-repo-line>A run for a task in this project's checkout uses the repo's line when it has one, whichever line the role names below.</p>
      )}
      {rows.length === 0 ? (
        <p className="lset-empty" data-runs-this-line-empty>
          No role looks after this project yet, so nothing starts the line on its own. A role takes the project into its area on its page in <Link href="/org" className="underline underline-offset-2">the org</Link>.
        </p>
      ) : (
        <div className="lset-rows">
          {rows.map(({ role, slug }) => {
            const mine = hostedHere(role);
            const onFork = !!forkSlug && slug === forkSlug && mine;
            return (
              <div key={role._id} className="lset-row" data-role-line={role._id}>
                <div className="lset-key">
                  <span className="lset-label">
                    {role.short_id ? <Link href={`/org/${role.short_id}`} className="hover:underline">{role.name}</Link> : role.name}
                    <span className="ml-1.5 font-normal" style={{ color: "var(--sol-violet)", fontFamily: "var(--font-mono)" }}>@{role.handle}</span>
                  </span>
                </div>
                <div className="lset-val">
                  <div className="lset-val-line">
                    <span className="lset-dim text-[12px]">runs</span>
                    <LineChip tone={onFork ? "magenta" : "muted"}>{onFork ? "this project's copy" : labelOf(slug)}</LineChip>
                    <span className="flex-1" />
                    {forkSlug && !onFork && mine && <button type="button" className="lset-ghost" onClick={() => setRoleLine(role._id, forkSlug)}>Run the customized line</button>}
                    {forkSlug && !onFork && !mine && <span className="lset-dim text-[11px]">Runs on a teammate's machine, which has no copy of your customized line</span>}
                    {onFork && <button type="button" className="lset-ghost" onClick={() => setRoleLine(role._id, "line")}>Back to shipped</button>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
