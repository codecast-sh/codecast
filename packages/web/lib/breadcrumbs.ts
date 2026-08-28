/**
 * The trail, derived from the route.
 *
 * A breadcrumb answers two questions: where am I, and what contains this. Both
 * are properties of the PATH you took, not of where the thing is filed — the
 * same task opened from /tasks and from inside a project sits under a different
 * trail, and that is correct. So the trail is a pure function of the pathname,
 * with names looked up by id.
 *
 * Kept free of React and of the store so it can be tested directly: callers
 * pass a `lookups` bag, and get back plain data that the bar turns into links.
 */

/** One step in the trail. `icon` is a hint the renderer turns into a marker. */
export type CrumbSpec = {
  label: string;
  /** The entity's short id ("ct-4102"), kept separate from the label so the bar
   *  can render it dimmed and monospaced — it is a handle to copy, not prose. */
  shortId?: string;
  /** Absent on the last crumb — you are already there. */
  href?: string;
  /** What kind of thing this names, so the bar can mark it (a project dot…). */
  kind?: "section" | "project" | "task" | "doc" | "plan" | "channel";
  /** The entity's id, for the renderer to resolve a colour or avatar. */
  id?: string;
};

type Named = { title?: string; name?: string; short_id?: string; color?: string } | undefined;

export type BreadcrumbLookups = {
  project?: (id: string) => Named;
  task?: (id: string) => Named;
  doc?: (id: string) => Named;
  plan?: (id: string) => Named;
  channel?: (id: string) => Named;
};

/**
 * The name each top-level surface goes by. One map, so the rail and the trail
 * can never disagree about what a section is called.
 */
export const SECTION_LABELS: Record<string, string> = {
  inbox: "Inbox",
  chat: "Chat",
  tasks: "Tasks",
  projects: "Projects",
  docs: "Docs",
  plans: "Plans",
  files: "Files",
  pages: "Pages",
  sessions: "Sessions",
  windows: "Windows",
  workflows: "Workflows",
  triggers: "Triggers",
  anchor: "Anchor",
  search: "Search",
  settings: "Settings",
  team: "Team",
  feed: "Feed",
};

/** Trim a title for a crumb — the trail is a wayfinding strip, not a headline. */
const MAX_CRUMB = 70;
function crumbLabel(text: string): string {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  return clean.length > MAX_CRUMB ? `${clean.slice(0, MAX_CRUMB - 1)}…` : clean;
}

/** What a crumb says about an entity the store has not named yet. */
const KIND_LABELS: Record<NonNullable<CrumbSpec["kind"]>, string> = {
  section: "",
  project: "Project",
  task: "Task",
  doc: "Doc",
  plan: "Plan",
  channel: "Channel",
};

/** A raw Convex document id: 32 lowercase alphanumerics. */
const CONVEX_ID = /^[a-z0-9]{32}$/;

/** The name and (separately) the short id. Falls back so a crumb never renders
 *  blank while the store is still catching up — but never to a raw Convex id:
 *  that is a handle, not a name, so the crumb shows only what kind of thing
 *  this is until it loads. */
function entityCrumb(
  row: Named,
  fallbackId: string,
  kind: NonNullable<CrumbSpec["kind"]>,
): { label: string; shortId?: string } {
  const name = row?.title || row?.name || "";
  const short = row?.short_id;
  if (name) return { label: crumbLabel(name), shortId: short };
  if (short) return { label: crumbLabel(short) };
  if (CONVEX_ID.test(fallbackId)) return { label: KIND_LABELS[kind] };
  return { label: crumbLabel(fallbackId) };
}

/**
 * Build the trail for a pathname. Returns [] for routes with nothing to say.
 *
 * A single crumb is returned for a bare section (`/tasks` → ["Tasks"]). The bar
 * chooses not to render those — a trail of one teaches the reader nothing — but
 * returning it keeps this function's job "describe the location", and leaves the
 * display rule to the display.
 */
export function buildBreadcrumbs(pathname: string, lookups: BreadcrumbLookups = {}): CrumbSpec[] {
  const parts = (pathname || "").split("/").filter(Boolean);
  if (parts.length === 0) return [];

  const [head, ...rest] = parts;
  const sectionLabel = SECTION_LABELS[head];
  if (!sectionLabel) return [];

  // The feed lives at /team/activity but reads as its own section, not as a
  // child of Team — that is how the rail names it, so the trail matches.
  if (head === "team" && rest[0] === "activity") {
    return [{ label: SECTION_LABELS.feed, kind: "section" }];
  }

  const crumbs: CrumbSpec[] = [{ label: sectionLabel, href: `/${head}`, kind: "section" }];

  const push = (
    id: string,
    kind: NonNullable<CrumbSpec["kind"]>,
    lookup: ((id: string) => Named) | undefined,
    href?: string,
  ) => {
    crumbs.push({ ...entityCrumb(lookup?.(id), id, kind), kind, id, href });
  };

  switch (head) {
    case "projects":
      if (rest[0]) push(rest[0], "project", lookups.project, `/projects/${rest[0]}`);
      // A task opened inside a project extends that project's trail — the whole
      // point of the nested route: you are in a task, inside this project.
      if (rest[1]) push(rest[1], "task", lookups.task);
      break;
    case "tasks":
      if (rest[0]) push(rest[0], "task", lookups.task);
      break;
    case "docs":
      if (rest[0]) push(rest[0], "doc", lookups.doc);
      break;
    case "plans":
      if (rest[0]) push(rest[0], "plan", lookups.plan);
      break;
    case "chat":
      if (rest[0]) push(rest[0], "channel", lookups.channel);
      break;
    default:
      // Sections with no detail route of their own stop at their own name.
      break;
  }

  // The last crumb is where you are, so it never links anywhere.
  const last = crumbs[crumbs.length - 1];
  if (last) delete last.href;
  return crumbs;
}
