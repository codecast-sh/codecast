"use client";
/**
 * The trail for whatever surface is open, mounted once in the shell so every
 * page gets one without asking. Routes describe the location (lib/breadcrumbs);
 * this binds those names to the store and draws them.
 *
 * It renders nothing for a bare list page: a trail of one crumb repeats the
 * heading below it and teaches the reader nothing. It appears exactly when you
 * have gone INTO something and need a way back out.
 *
 * This component is ALWAYS mounted, so it must never subscribe to a whole
 * collection — the store is a mutative draft and any row's change hands back a
 * new map, which would re-render the bar on every sync tick. Instead it reads
 * the one row the route names and selects the PRIMITIVE it draws, so a re-render
 * happens only when a name on screen actually changes.
 */
import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { useInboxStore } from "../store/inboxStore";
import { channelDisplayName } from "../lib/chatViews";
import { dmOtherIds } from "@codecast/shared/chat";
import { Breadcrumbs, type Crumb } from "./Breadcrumbs";
import { buildBreadcrumbs, type BreadcrumbLookups } from "../lib/breadcrumbs";
import { tabStageLayout } from "../lib/stage";
import { projectDotClass } from "../lib/projectColors";
import { useTitlebarHead } from "../hooks/useTitlebarHead";

/** Rows are keyed by _id, but a route may carry a short id ("ct-4102") — links
 *  minted by agents do. Try the key first; only scan when that misses, which
 *  means the row has not synced yet and the scan is over a cold collection. */
function findRow(rows: Record<string, any> | undefined, id: string | undefined): any {
  if (!rows || !id) return undefined;
  return rows[id] ?? Object.values(rows).find((r: any) => r?.short_id === id);
}

/** The route's own words: which section, and which entity ids hang off it. */
function routeParts(pathname: string) {
  const parts = (pathname || "").split("/").filter(Boolean);
  return { head: parts[0], first: parts[1], second: parts[2] };
}

export function BreadcrumbBar() {
  const pathname = usePathname() ?? "";
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  const { head, first, second } = routeParts(pathname);

  // One narrow selector per surface, each returning a string. Every one is
  // inert unless the route actually names that kind of thing.
  const projectId = head === "projects" ? first : undefined;
  const projectTitle = useInboxStore((s) => (projectId ? findRow(s.projects, projectId)?.title : undefined));
  const projectColor = useInboxStore((s) => (projectId ? findRow(s.projects, projectId)?.color : undefined));

  const taskId = head === "projects" ? second : head === "tasks" ? first : undefined;
  const taskTitle = useInboxStore((s) => (taskId ? findRow(s.tasks, taskId)?.title : undefined));
  const taskShortId = useInboxStore((s) => (taskId ? findRow(s.tasks, taskId)?.short_id : undefined));

  const docId = head === "docs" ? first : undefined;
  const docTitle = useInboxStore((s) => (docId ? findRow(s.docs, docId)?.title : undefined));

  const planId = head === "plans" ? first : undefined;
  const planTitle = useInboxStore((s) => (planId ? findRow(s.plans, planId)?.title : undefined));
  const planShortId = useInboxStore((s) => (planId ? findRow(s.plans, planId)?.short_id : undefined));

  const channelId = head === "chat" ? first : undefined;
  // A DM's crumb is the other side's names — same derivation as every chat
  // surface; a channel's is its slug. Never the raw id.
  const channelName = useInboxStore((s) => {
    if (!channelId) return undefined;
    const row = findRow(s.chatChannels, channelId);
    if (!row) return undefined;
    if ((row as any).kind === "dm") {
      return channelDisplayName(
        { name: "", kind: "dm", dmMemberIds: dmOtherIds((row as any).dm_key, String((s as any).currentUser?._id ?? "")) },
        (s as any).teamMembers,
      );
    }
    return row.name;
  });

  const specs = useMemo(() => {
    const lookups: BreadcrumbLookups = {
      project: () => ({ title: projectTitle }),
      task: () => ({ title: taskTitle, short_id: taskShortId }),
      doc: () => ({ title: docTitle }),
      plan: () => ({ title: planTitle, short_id: planShortId }),
      channel: () => ({ name: channelName }),
    };
    return buildBreadcrumbs(pathname, lookups);
  }, [pathname, projectTitle, taskTitle, taskShortId, docTitle, planTitle, planShortId, channelName]);

  // A SPLIT stage has no single trail: the bar spans every pane while its
  // crumbs describe only the focused one, and each pane already names itself
  // in its strip. The trail returns when the stage is one surface again.
  const stageSplit = useInboxStore((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    return !!t && !!tabStageLayout(t);
  });

  // One crumb is a label, not a trail.
  if (stageSplit) return null;
  if (specs.length < 2) return null;

  const items: Crumb[] = specs.map((spec) => ({
    label: spec.label,
    href: spec.href,
    shortId: spec.shortId,
    icon:
      spec.kind === "project" ? (
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${projectDotClass({ color: projectColor, title: projectTitle })}`} />
      ) : undefined,
  }));

  return (
    <div ref={titlebarRef} className="flex items-center gap-2 px-6 h-10 border-b border-sol-border/20 flex-shrink-0 min-w-0">
      <Breadcrumbs items={items} className="min-w-0" />
    </div>
  );
}
