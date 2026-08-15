"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, Globe, FolderGit2, MessageSquare, Monitor } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import type { CapabilityBindingRow } from "../../store/inboxStore";
import { buildProjectScopeKey } from "@codecast/shared/contracts";

/**
 * The equip control: WHERE a capability is on.
 *
 * This is the primary gesture of the whole library, and it is deliberately
 * three plain words — everywhere / this project / this session — not the five
 * scope kinds the resolver knows. Team and device are real scopes with real
 * rules, but they are admin and ops surfaces; a person choosing where a skill
 * applies thinks in "all my work", "this repo", "just right now". The resolver
 * folds the rest.
 *
 * Optimistic by law: the toggle flips in the store synchronously via
 * setCapabilityBinding, whose dispatch side effect calls the SAME upsert the
 * CLI does. The card never waits on the round trip.
 */

export type EquipScope = "everywhere" | "project" | "session";

export interface EquipTarget {
  slug: string;
  /** Repos this user has worked in recently — the "this project" choices.
   *  Keyed how the resolver keys them: git:<origin> when known, else local:. */
  projects: Array<{ label: string; scopeKey: string; isLocal: boolean }>;
  /** The conversation to bind session scope to, when one is in view. */
  sessionId?: string | null;
}

/** Which of the three plain choices a binding row corresponds to. */
export function equipScopeOf(row: CapabilityBindingRow): EquipScope | null {
  if (row.scope_kind === "user" || row.scope_kind === "team") return "everywhere";
  if (row.scope_kind === "project") return "project";
  if (row.scope_kind === "session") return "session";
  return null;
}

/** Turn "the repos I have sessions in" into equip choices, deduped by key. */
export function projectChoicesFromSessions(
  sessions: Array<{ project_path?: string | null; git_remote_url?: string | null }>,
  userId: string,
): EquipTarget["projects"] {
  const seen = new Map<string, EquipTarget["projects"][number]>();
  for (const s of sessions) {
    const path = s.project_path ?? undefined;
    if (!path) continue;
    const key = buildProjectScopeKey({
      originUrl: s.git_remote_url ?? undefined,
      path,
      userId,
    });
    if (!key || seen.has(key)) continue;
    const isLocal = key.startsWith("local:");
    // A repo identity reads as "github.com/o/r"; a local path as its last two
    // segments — enough to recognise, short enough for a menu.
    const label = isLocal
      ? path.split("/").filter(Boolean).slice(-2).join("/")
      : key.replace(/^git:/, "").replace(/#.*$/, "");
    seen.set(key, { label, scopeKey: key, isLocal });
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function EquipControl({ target }: { target: EquipTarget }) {
  const bindings = useInboxStore((s) => s.capabilityBindings);
  const setBinding = useInboxStore((s) => s.setCapabilityBinding);
  const [open, setOpen] = useState(false);
  const [projectKey, setProjectKey] = useState<string | null>(target.projects[0]?.scopeKey ?? null);

  const mine = useMemo(
    () => Object.values(bindings).filter((b) => b.capability_slug === target.slug),
    [bindings, target.slug],
  );
  const everywhere = mine.find((b) => equipScopeOf(b) === "everywhere");
  // EVERY project binding for this slug, not only the picker's current choice:
  // a binding made from the CLI (keyed by git origin) may name a repo the web
  // has no session for, and the control must still say "on in <repo>" rather
  // than "Off". The picker's selection decides where a NEW toggle lands.
  const projectRows = mine.filter((b) => b.scope_kind === "project");
  const project = projectRows.find((b) => b.scope_key === projectKey) ?? projectRows.find((b) => b.enabled);
  const session = target.sessionId
    ? mine.find((b) => b.scope_kind === "session" && b.scope_key === target.sessionId)
    : undefined;

  const active: EquipScope | "off" =
    session?.enabled ? "session"
    : project?.enabled ? "project"
    : everywhere?.enabled ? "everywhere"
    : "off";

  const projectLabel = (key: string | undefined) =>
    target.projects.find((p) => p.scopeKey === key)?.label ??
    (key ? key.replace(/^git:/, "").replace(/^local:[^:]+:/, "").replace(/#.*$/, "") : "this project");
  const onProjects = projectRows.filter((b) => b.enabled).length;
  const summary =
    active === "off" ? "Off"
    : active === "everywhere" ? (onProjects > 0 ? "On everywhere +" : "On everywhere")
    : active === "project" ? (onProjects > 1 ? `On in ${onProjects} projects` : `On in ${projectLabel(project?.scope_key)}`)
    : "On this session";

  const choose = (scope: EquipScope | "off") => {
    setOpen(false);
    if (scope === "off") {
      // Off means: switch off whichever scope is currently winning. A disable
      // is a ROW (never a delete), so the broader grant does not re-inherit.
      const winning = active === "session" ? session : active === "project" ? project : everywhere;
      if (winning) {
        setBinding({
          capability_slug: target.slug,
          scope_kind: winning.scope_kind,
          scope_key: winning.scope_key,
          enabled: false,
        });
      }
      return;
    }
    if (scope === "everywhere") {
      setBinding({ capability_slug: target.slug, scope_kind: "user", scope_key: "", enabled: true });
    } else if (scope === "project" && projectKey) {
      setBinding({ capability_slug: target.slug, scope_kind: "project", scope_key: projectKey, enabled: true });
    } else if (scope === "session" && target.sessionId) {
      setBinding({ capability_slug: target.slug, scope_kind: "session", scope_key: target.sessionId, enabled: true });
    }
  };

  const Item = ({
    scope,
    icon: Icon,
    label,
    detail,
    disabled,
  }: {
    scope: EquipScope | "off";
    icon: typeof Globe;
    label: string;
    detail?: string;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => choose(scope)}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-sol-bg-alt disabled:opacity-40 disabled:cursor-not-allowed ${
        active === scope ? "text-sol-text" : "text-sol-text-muted"
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
      <span className="flex-1">
        {label}
        {detail && <span className="ml-1 text-sol-text-dim">{detail}</span>}
      </span>
      {active === scope && <Check className="h-3.5 w-3.5 text-sol-green" />}
    </button>
  );

  return (
    <div className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
          active === "off"
            ? "border-sol-border text-sol-text-muted hover:text-sol-text"
            : "border-sol-green/40 bg-[color-mix(in_srgb,var(--sol-green)_12%,transparent)] text-sol-green"
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {summary}
        <ChevronDown className="h-3 w-3" strokeWidth={1.5} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-md border border-sol-border bg-sol-card shadow-lg"
        >
          <Item scope="everywhere" icon={Globe} label="Everywhere" detail="all my sessions" />
          <div className="border-t border-sol-border">
            <Item
              scope="project"
              icon={FolderGit2}
              label="This project"
              detail={target.projects.length === 0 ? "no repos seen yet" : undefined}
              disabled={target.projects.length === 0}
            />
            {(target.projects.length > 1 || projectRows.length > 0) && (
              <div className="max-h-40 overflow-y-auto border-t border-sol-border/60 bg-sol-bg-alt/40">
                {/* Repos with a binding already, first — even ones the web has
                    no session for, so a CLI-made binding is never invisible. */}
                {projectRows
                  .filter((b) => !target.projects.some((p) => p.scopeKey === b.scope_key))
                  .map((b) => (
                    <button
                      key={b.scope_key}
                      type="button"
                      onClick={() => setProjectKey(b.scope_key)}
                      className={`flex w-full items-center gap-2 px-6 py-1.5 text-left text-[11px] hover:bg-sol-bg-alt ${
                        b.scope_key === projectKey ? "text-sol-text" : "text-sol-text-dim"
                      }`}
                    >
                      <span className="flex-1 truncate font-mono">{projectLabel(b.scope_key)}</span>
                      <span className={`text-[10px] ${b.enabled ? "text-sol-green" : "text-sol-text-dim"}`}>{b.enabled ? "on" : "off"}</span>
                      {b.scope_key === projectKey && <Check className="h-3 w-3 text-sol-green" />}
                    </button>
                  ))}
                {target.projects.map((p) => (
                  <button
                    key={p.scopeKey}
                    type="button"
                    onClick={() => setProjectKey(p.scopeKey)}
                    className={`flex w-full items-center gap-2 px-6 py-1.5 text-left text-[11px] hover:bg-sol-bg-alt ${
                      p.scopeKey === projectKey ? "text-sol-text" : "text-sol-text-dim"
                    }`}
                  >
                    <span className="flex-1 truncate font-mono">{p.label}</span>
                    {p.isLocal && (
                      <span className="text-[10px] text-sol-orange" title="No git origin: this key names one machine's disk and cannot be shared with a team">
                        local
                      </span>
                    )}
                    {p.scopeKey === projectKey && <Check className="h-3 w-3 text-sol-green" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="border-t border-sol-border">
            <Item
              scope="session"
              icon={MessageSquare}
              label="This session"
              detail={target.sessionId ? undefined : "open a session first"}
              disabled={!target.sessionId}
            />
          </div>
          <div className="border-t border-sol-border">
            <Item scope="off" icon={Monitor} label="Off" />
          </div>
        </div>
      )}
    </div>
  );
}
