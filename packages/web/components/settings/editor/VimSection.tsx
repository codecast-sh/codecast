// Settings > Editor, the Vim section: the mode, the vimrc files the daemon
// found (each with its size and what became of its directives), the report
// of every directive, and the overlay that wins over all of them, edited in
// the code editor itself.

import { lazy, Suspense, useState } from "react";
import type { CodeVimrcResponse } from "@codecast/shared/contracts";
import { SettingsBadge, SettingsOptionGroup, SettingsRow, SettingsSection } from "../ui";
import { cn, shortenHome } from "../../../lib/utils";
import { hasVimConfig, setEditorSetting, vimModeOn, type ExplicitEditorSettings, type VimModeSetting } from "../../../lib/code/editorSettings";
import type { VimConfigReport, VimReportCounts } from "../../../lib/code/vim/types";
import type { EndpointState } from "./useEditorEndpoint";
import type { VimConfigState } from "./useVimConfig";
import { VimReportTable } from "./VimReportTable";
import { STATUS_TONE } from "../../../lib/code/vim/reportTone";
import { lineCount } from "./vimReportRows";

const VimOverlayEditor = lazy(() => import("./VimOverlayEditor"));

const OVERLAY_DEFAULT = "~/.codecast/editor/vimrc";

function Counts({ counts }: { counts: VimReportCounts }) {
  return (
    <span className="flex items-center gap-2.5 font-mono text-xs tabular-nums">
      {(["applied", "translated", "skipped"] as const).map((st) => (
        <span key={st} className={cn("flex items-center gap-1", counts[st] ? STATUS_TONE[st].text : "text-sol-text-dim opacity-60")} title={`${counts[st]} ${st}`}>
          <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_TONE[st].dot)} />
          {counts[st]}
        </span>
      ))}
    </span>
  );
}

interface SourceRow {
  index: number;
  path: string;
  lines: number;
  counts: VimReportCounts | null;
  sourcedFrom?: string;
  overlay?: boolean;
  truncated?: boolean;
}

/** Each file the report covers, in load order, with its line count. */
function sourceRows(response: CodeVimrcResponse, report: VimConfigReport | null): SourceRow[] {
  const text = new Map<string, string>(response.sources.map((s) => [s.path, s.content]));
  if (response.overlay) text.set(response.overlay.path, response.overlay.content);
  if (report) {
    return report.sources.map((s, index) => ({
      index,
      path: s.path,
      lines: lineCount(text.get(s.path) ?? ""),
      counts: s.counts,
      sourcedFrom: s.sourcedFrom,
      overlay: s.overlay,
      truncated: s.truncated,
    }));
  }
  return response.sources.map((s, index) => ({ index, path: s.path, lines: lineCount(s.content), counts: null, sourcedFrom: s.sourced_from, truncated: s.truncated }));
}

export function VimSection({ endpoint, vim, explicit }: { endpoint: EndpointState; vim: VimConfigState; explicit: ExplicitEditorSettings }) {
  const [source, setSource] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const mode: VimModeSetting = explicit.vimMode ?? "auto";
  const found = vim.response ? hasVimConfig(vim.response) : null;
  const on = vimModeOn(mode, !!found);
  const { response, report } = vim;
  const rows = response ? sourceRows(response, report) : [];
  const overlayPath = response?.overlay?.path ?? OVERLAY_DEFAULT;
  const overlayText = response?.overlay?.content ?? "";
  const sourceLabel = (i: number) => shortenHome(report?.sources[i]?.path ?? "");

  return (
    <SettingsSection title="Vim">
      <SettingsRow label="Vim mode">
        {(mode !== "auto" || found !== null) && <SettingsBadge tone={on ? "green" : "muted"}>{on ? "on" : "off"}</SettingsBadge>}
        <SettingsOptionGroup
          variant="pill"
          label="Vim mode"
          value={mode}
          options={[
            { value: "auto", label: "Auto", title: found === null ? "On when a vimrc is found" : found ? "A vimrc was found: on" : "No vimrc found: off" },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          onChange={(v) => setEditorSetting("vimMode", v === "auto" ? undefined : (v as VimModeSetting))}
        />
      </SettingsRow>

      {endpoint.status === "offline" ? (
        <SettingsRow label="Vimrc">
          <SettingsBadge tone="red">daemon offline</SettingsBadge>
        </SettingsRow>
      ) : vim.error ? (
        <SettingsRow label="Vimrc">
          <span className="max-w-[24rem] truncate text-xs text-sol-red" title={vim.error}>
            {vim.error}
          </span>
        </SettingsRow>
      ) : !response ? (
        <SettingsRow label="Vimrc">
          <span className="text-xs text-sol-text-dim">reading…</span>
        </SettingsRow>
      ) : (
        <>
          <div className="px-4 py-2 sm:px-5">
            {rows.length === 0 && !response.unread?.length ? (
              <div className="py-1 text-xs text-sol-text-dim">No vimrc found</div>
            ) : (
              <ul className="divide-y divide-sol-border/30">
                {rows.map((r) => (
                  <li key={`${r.index}:${r.path}`}>
                    <button
                      type="button"
                      onClick={() => setSource(source === r.index ? null : r.index)}
                      aria-pressed={source === r.index}
                      className={cn(
                        "grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 rounded py-1.5 text-left hover:bg-sol-bg-highlight/30",
                        source === r.index && "bg-sol-violet/10",
                      )}
                    >
                      <span className={cn("flex min-w-0 items-center gap-2", r.sourcedFrom && "pl-4")}>
                        {r.sourcedFrom && <span className="text-sol-text-dim">↳</span>}
                        <span className="truncate font-mono text-xs text-sol-text" title={r.path}>
                          {shortenHome(r.path)}
                        </span>
                        {r.overlay && <SettingsBadge tone="violet">overlay</SettingsBadge>}
                        {r.truncated && <SettingsBadge tone="red">truncated</SettingsBadge>}
                      </span>
                      <span className="font-mono text-xs tabular-nums text-sol-text-dim">{r.lines} ln</span>
                      {r.counts ? <Counts counts={r.counts} /> : <span />}
                    </button>
                  </li>
                ))}
                {response.unread?.map((u) => (
                  <li key={`unread:${u.path}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-1.5">
                    <span className="flex min-w-0 items-center gap-2 pl-4">
                      <span className="text-sol-text-dim">↳</span>
                      <span className="truncate font-mono text-xs text-sol-text-dim line-through" title={`${u.path}, sourced from ${u.sourced_from}`}>
                        {shortenHome(u.path)}
                      </span>
                    </span>
                    <SettingsBadge tone="yellow">{u.reason}</SettingsBadge>
                  </li>
                ))}
              </ul>
            )}
            {report && !report.empty && (
              <div className="flex items-center gap-3 pt-1.5 font-mono text-xs text-sol-text-dim">
                <span>
                  leader <span className="text-sol-text">{report.leader === " " ? "<Space>" : report.leader}</span>
                </span>
                {report.localLeader !== report.leader && (
                  <span>
                    localleader <span className="text-sol-text">{report.localLeader === " " ? "<Space>" : report.localLeader}</span>
                  </span>
                )}
              </div>
            )}
          </div>
          {report && (
            <VimReportTable report={report} source={source} onSource={setSource} reloading={vim.reloading} onReload={vim.reload} sourceLabel={sourceLabel} />
          )}
        </>
      )}

      {endpoint.status === "ready" && response &&
        (editing ? (
          <Suspense fallback={<div className="px-5 py-3 text-xs text-sol-text-dim">loading editor…</div>}>
            <VimOverlayEditor ep={endpoint.ep} path={overlayPath} content={overlayText} reload={vim.reload} onClose={() => setEditing(false)} />
          </Suspense>
        ) : (
          <SettingsRow label="Overlay">
            <span className="font-mono text-xs text-sol-text-dim" title={overlayPath}>
              {shortenHome(overlayPath)}
              {response.overlay ? ` · ${lineCount(overlayText)} ln` : ""}
            </span>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="flex h-7 items-center rounded-md border border-sol-border bg-sol-bg-alt px-2.5 text-xs font-medium text-sol-text hover:border-sol-text-muted"
            >
              {response.overlay ? "Edit" : "Create"}
            </button>
          </SettingsRow>
        ))}
    </SettingsSection>
  );
}
