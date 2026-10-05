"use client";
// /line/settings (plan pl-838): one project's line, read and edited in one
// place. The project comes from the same switcher as /line (useLineFloor ->
// LineProjects useLineProject), so the URL's ?project= carries between the
// two pages. Every value paints from the store copy of the line's file
// (projects.line_profile); an edit paints at once and goes to the daemon on
// the machine holding the checkout (useLineProfileEdits), which writes
// `.codecast/line.toml` in place and republishes. The Stations section is
// LineStations, built beside this page.
import { useEffect, useMemo, useRef, type KeyboardEvent, useState, type UIEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { useInboxStore } from "../../../store/inboxStore";
import { useSyncDevices } from "../../../hooks/useSyncDevices";
import { ALL_PROJECTS, NO_PROJECT, buildLineFlow, scopeLine } from "../../../lib/lineFlow";
import {
  LINE_SECTIONS, commandNote, editForField, fieldText, lineSettingsTarget, lineSource, lineValue, lineWriteGate,
  type LineField, type RosterDevice,
} from "../../../lib/lineSettings";
import { KeyCap } from "../../KeyboardShortcutsHelp";
import { LineProjectSwitcher } from "../LineProjects";
import { useLineFloor } from "../useLineFloor";
import { LineFinders } from "./LineFinders";
import { EditStatus, InlineEdit, LineValueRow } from "./LineValueRow";
import { useLineProfileEdits } from "./useLineProfileEdits";
import { DAEMON_COMMAND_TTL_MS } from "@codecast/shared/contracts";
import { LineStations } from "./LineStations";
import "../line.css";
import "./settings.css";

const NAV = [...LINE_SECTIONS.map((s) => ({ id: s.id, title: s.title })), { id: "stations", title: "Stations" }];

export function LineSettingsPage() {
  useSyncDevices();
  const { now, projects, lineRows, rollup, line } = useLineFloor();
  const project = useMemo(() => projects.find((p) => p._id === line.key) ?? null, [projects, line.key]);
  // The published copy by reference (the floor's project signature watches
  // only part of it), shown with the edits still travelling laid over it.
  const published = useInboxStore((s) => (project ? ((s.projects as Record<string, { line_profile?: PublishedLineProfile | null }>)[project._id]?.line_profile ?? null) : null));
  const edits = useLineProfileEdits(project?._id ?? null, published);
  const lp = edits.lp;
  // Only a roster this session has heard live says a machine is offline; a
  // cached one from an earlier visit would lock the page on a stale flag.
  const roster = useInboxStore((s) => (s.machineRosterLive ? (s.machineRoster as RosterDevice[]) : null));
  const gate = useMemo(() => lineWriteGate(published, roster), [published, roster]);
  const device = gate.device ?? "the machine";
  // A link in names a section or a station (lineSettingsHref): the page opens
  // scrolled to it, and the target carries data-lset-target, which flashes once.
  const target = lineSettingsTarget(useSearchParams());
  const body = useRef<HTMLDivElement>(null);
  const ready = !!project && !!lp;
  // Once per arrival: a later render must never pull the reader back up.
  const landed = useRef<string | null>(null);
  useEffect(() => {
    // A station scrolls itself into view once its panel opens (LineStations).
    if (!ready || !target.section || target.station) return;
    const key = `${project?._id}:${target.section}`;
    const el = body.current?.querySelector<HTMLElement>(`[data-lset-section="${target.section}"]`);
    if (!el || landed.current === key) return;
    landed.current = key;
    el.scrollIntoView({ block: "start" });
  }, [ready, target.section, project?._id]);

  const sense = useMemo(() => (project && lp
    ? buildLineFlow({ ...scopeLine(lineRows, project._id), initiatives: [], projects: [], now, finders: lp.finders, findersSince: lp.changed_at }).sense.items
    : []), [project, lp, lineRows, now]);

  // Up and down walk the page's values the way tab does; the value's own
  // keys (return to edit, backspace to default) sit on the value.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!["ArrowDown", "ArrowUp", "j", "k"].includes(k)) return;
    const el = e.target as HTMLElement;
    if (!el.matches("[data-lset-focus]")) return;
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-lset-focus]")];
    const i = all.indexOf(el);
    const next = all[i + (k === "ArrowDown" || k === "j" ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ block: "nearest" }); }
  };

  // The rail marks the section being read: the last one whose top has passed
  // a third of the way down the view. Scroll position only, so it holds in a
  // background tab where observers stall.
  const [inView, setInView] = useState<string>(NAV[0].id);
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const line = el.getBoundingClientRect().top + el.clientHeight / 3;
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
    let id = NAV[0].id;
    for (const s of el.querySelectorAll<HTMLElement>("[data-lset-section]")) if (atEnd || s.getBoundingClientRect().top <= line) id = s.dataset.lsetSection!;
    if (id !== inView) setInView(id);
  };

  const commitField = (field: LineField) => (text: string) => {
    const r = editForField(field, text, lp);
    if ("error" in r) return r.error;
    if (r.edit) edits.send([r.edit]);
    return null;
  };

  const lineHref = `/line${line.href.slice(line.href.indexOf("?"))}`;

  return (
    <div className="line-floor lset-floor h-full flex flex-col min-h-0" data-line-settings>
      <header className="shrink-0 px-4 sm:px-6 pt-5 pb-3 flex flex-col gap-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-[13px] font-semibold text-sol-text leading-none">Line settings</h1>
          <span className="line-subtitle text-[11px] text-sol-text-dim leading-none truncate">what one project's line listens to, holds work to, checks and limits</span>
          <Link href={lineHref} className="ml-auto text-[11.5px] text-sol-text-muted hover:text-sol-text whitespace-nowrap" data-lset-back>Back to the line</Link>
        </div>
        <LineProjectSwitcher rollup={rollup} selected={line.key} onSelect={line.select} />
      </header>

      {!project || !lp ? (
        <Unset lineKey={line.key} titled={project?.title} hasLines={rollup.length > 0} />
      ) : (
        <div ref={body} className="flex-1 min-h-0 overflow-y-auto" onKeyDown={onKeyDown} onScroll={onScroll}>
          <div className="lset-body px-4 sm:px-6 pb-10">
            <nav className="lset-index" aria-label="Sections">
              {NAV.map((n) => <a key={n.id} href={`#lset-${n.id}`} className="lset-index-link" aria-current={inView === n.id ? "location" : undefined}>{n.title}</a>)}
            </nav>
            <div className="lset-main">
              <Plate lp={lp} gate={gate} />

              {LINE_SECTIONS.map((section) => (
                <section key={section.id} id={`lset-${section.id}`} className="lset-section" data-lset-section={section.id} data-lset-target={target.section === section.id ? "true" : undefined}>
                  <h2 className="lset-section-title">{section.title}</h2>
                  <p className="lset-section-what">{section.what}</p>
                  {section.id === "listens" ? (
                    <LineFinders
                      lp={lp}
                      sense={sense}
                      now={now}
                      writable={gate.writable}
                      states={edits.states}
                      device={device}
                      send={edits.send}
                      clear={edits.clear}
                    />
                  ) : (
                    <div className="lset-rows">
                      {section.fields.map((field) => {
                        const value = lineValue(lp, field.key);
                        const source = lineSource(lp, field.key);
                        const s = edits.states[field.key];
                        const reset = source === "file" && gate.writable ? () => edits.send([{ op: "remove", key: field.key }]) : undefined;
                        return (
                          <LineValueRow
                            key={field.key}
                            label={field.label}
                            what={field.what}
                            unit={field.unit}
                            source={source}
                            refused={s?.state === "refused"}
                            note={value == null && field.key.startsWith("commands.") ? commandNote(lp, field.key) : null}
                            status={<EditStatus s={s} device={device} now={now} onDismiss={() => edits.clear(field.key)} />}
                            onReset={reset}
                            defaultText={fieldText(field, lineValue(null, field.key))}
                          >
                            <InlineEdit
                              text={fieldText(field, value)}
                              label={field.label}
                              placeholder={field.placeholder}
                              multiline={field.kind === "list"}
                              disabled={!gate.writable}
                              display={field.kind === "list" && Array.isArray(value) && value.length ? <span className="lset-list">{value.map((v) => <span key={v}>{v}</span>)}</span> : undefined}
                              onCommit={commitField(field)}
                              onReset={reset}
                            />
                          </LineValueRow>
                        );
                      })}
                    </div>
                  )}
                </section>
              ))}

              <section id="lset-stations" className="lset-section" data-lset-section="stations" data-lset-target={target.section === "stations" && !target.station ? "true" : undefined}>
                <h2 className="lset-section-title">Stations</h2>
                <p className="lset-section-what">The steps a cause takes from admitted to a change card, and what each one is told.</p>
                {/* Mount point for the Stations section (ct-56913, components/line/settings/LineStations.tsx). */}
                <LineStations projectId={project._id} focusStation={target.station} />
              </section>
            </div>
          </div>
        </div>
      )}

      {/* The keys only where a value can be edited, and only where there is a
          keyboard to press them (settings.css hides it on narrow floors). */}
      {project && lp && gate.writable && (
        <footer className="lset-footer shrink-0 flex items-center gap-4 px-4 sm:px-6 py-2 border-t border-sol-border/30 text-[11px] text-sol-text-dim" data-lset-footer>
          <span className="flex items-center gap-1" title="Move between values"><KeyCap size="xs">↑</KeyCap><KeyCap size="xs">↓</KeyCap><span className="line-hint-text">values</span></span>
          <span className="flex items-center gap-1" title="Edit a value, then save it"><KeyCap size="xs">↵</KeyCap><span className="line-hint-text">edit, then save</span></span>
          <span className="flex items-center gap-1" title="Put an edit back"><KeyCap size="xs">Esc</KeyCap><span className="line-hint-text">put back</span></span>
          <span className="flex items-center gap-1" title="Back to the default"><KeyCap size="xs">⌫</KeyCap><span className="line-hint-text">back to the default</span></span>
        </footer>
      )}
    </div>
  );
}

/** Where the file is and who can change it: the machine an edit goes to, or why nothing here can. */
function Plate({ lp, gate }: { lp: PublishedLineProfile; gate: ReturnType<typeof lineWriteGate> }) {
  return (
    <div className="lset-plate" data-writable={gate.writable ? "true" : "false"} data-away={gate.writable && gate.away ? "true" : undefined} data-lset-plate>
      <div className="lset-plate-file">
        <span className="lset-plate-path">{gate.file}</span>
        {lp.root && <span className="lset-dim lset-plate-root" title={lp.root}>in {lp.root}</span>}
      </div>
      <p className="lset-plate-says" data-lset-gate={gate.writable ? "writable" : "read-only"}>
        {!gate.writable
          ? <>Read only. {gate.reason}</>
          : gate.away
            ? <><b>{gate.device}</b> has not checked in for a few minutes. An edit waits for it up to {Math.round(DAEMON_COMMAND_TTL_MS / 60_000)} minutes, then is dropped with nothing written.</>
            : <>Edits are written into the file on <b>{gate.device}</b>, comments and order kept, then republished here.</>}
      </p>
      {(lp.warnings ?? []).map((w) => <p key={w} className="lset-plate-warn">{w}</p>)}
    </div>
  );
}

/** No single project chosen, or a project whose line has no profile yet. */
function Unset({ lineKey, titled, hasLines }: { lineKey: string; titled?: string; hasLines: boolean }) {
  const say = lineKey === ALL_PROJECTS
    ? hasLines
      ? "Settings belong to one project's line. Pick a project above."
      : <>No project in this workspace has a line yet. A line lives in its repo, in <code>.codecast/line.toml</code>: run <code>cast line profile --publish</code> in the checkout and its settings appear here. A repo without the file publishes the defaults.</>
    : lineKey === NO_PROJECT
      ? "Work filed under no project has no line file to set."
      : <>{titled ?? "This project"} has no line file published yet. In its checkout, run <code>cast line profile --publish</code>; a repo without <code>.codecast/line.toml</code> publishes the defaults.</>;
  return (
    <div className="flex-1 min-h-0 px-4 sm:px-6 pt-6">
      <p className="lset-empty max-w-[60ch]" data-lset-unset>{say}</p>
    </div>
  );
}
