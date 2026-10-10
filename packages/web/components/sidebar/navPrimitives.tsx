import Link from "next/link";
import { usePoppedOut } from "../../hooks/usePoppedOut";
import { DESKTOP_APPS, type DesktopApp } from "../../lib/desktopApps";
import { requestStagePlacement, startPaneDrag } from "../../lib/stage";
import { paneDragProps, railRowClass, railRowTone } from "../../lib/railRow";

// The rail's building blocks: headings, section rows, counts and the nested
// row shape. Sidebar composes them with its data; the homepage hero composes
// them with fixtures.

/** A group label in the rail. Hidden when the rail is narrow, where the icons
 *  stand on their own and a heading would just be a stripe of unreadable text. */
export function RailHeading({ label, isNarrow, action }: { label: string; isNarrow: boolean; action?: React.ReactNode }) {
  if (isNarrow) return null;
  return (
    <div data-rail-heading={label} className="group/rail flex items-center text-xs font-medium text-sol-text-dim uppercase tracking-wide px-4 mb-2 mt-4 first:mt-0">
      <span className="flex-1">{label}</span>
      {/* An action that belongs to the whole group, revealed on hover the
          way a section row reveals its own. */}
      {action}
    </div>
  );
}

/** One nested row shape for every rail list: what it's called, what opening it
 *  does, and its hover actions. NavSection's children and the pinned rail render
 *  through the same component so selection, hover, and action affordances can
 *  never drift apart. */
export type SectionRowSpec = {
  id: string;
  name: string;
  /** The route this row shows. Present = the row is draggable onto the stage
   *  and its click offers the pane picker on a split stage. */
  path?: string;
  icon?: React.ReactNode;
  /** Highlighted as the row you are currently looking at. */
  active?: boolean;
  /** Rendered at the row's end — a shared marker, an owner avatar. Markers
   *  are information, so they step aside for the hover actions. */
  trailing?: React.ReactNode;
  /** An interactive control at the row's end — the join button of a live
   *  huddle. It stays put while the row is hovered, because a control the
   *  pointer erases on its way to it can never be clicked. */
  control?: React.ReactNode;
  /** A suggestion rather than a live object — rendered quieter until hover. */
  dim?: boolean;
  /** Hover text when it should say more than the name ("Message Sam"). */
  title?: string;
  /** Hover actions, in order. Each is its own small button. */
  actions?: Array<{ key: string; title: string; icon: React.ReactNode; onClick: (e?: React.MouseEvent) => void }>;
  onSelect: () => void;
  /** Right-click, for rows that have a context menu. */
  onContextMenu?: (e: React.MouseEvent) => void;
};

export function SectionRow({ row, className }: { row: SectionRowSpec; className?: string }) {
  return (
    <div
      onContextMenu={row.onContextMenu}
      {...(row.path ? paneDragProps(row.path, row.name) : {})}
      className={`flex items-center group/v transition-colors ${
        row.active
          ? "bg-sol-bg-highlight text-sol-text"
          : "text-sol-text-muted hover:bg-sol-bg-highlight/40"
      } ${row.dim ? "opacity-60 hover:opacity-100" : ""} ${className ?? ""}`}
    >
      <button
        onClick={() => {
          // A split stage makes the destination ambiguous — offer the picker
          // (same rule as the section links above).
          if (row.path && requestStagePlacement(row.path, row.name)) return;
          row.onSelect();
        }}
        data-nav-subrow
        className="flex items-center gap-1.5 pl-2 pr-1.5 py-1 hover:text-sol-text transition-colors flex-1 min-w-0 text-left"
        title={row.title ?? row.name}
        aria-current={row.active ? "page" : undefined}
      >
        {row.icon}
        <span className={`truncate text-[13px] min-w-0 ${row.active ? "text-sol-text" : ""}`}>{row.name}</span>
      </button>
      {/* A control is the point of the row it sits on, so it survives the
          hover swap below and shares the width with the actions. */}
      {row.control && <span className="flex flex-shrink-0">{row.control}</span>}
      {/* Marker and actions trade places on hover rather than competing for the
          row's width — otherwise the name of the row you are pointing at is the
          first thing to truncate. */}
      {row.trailing && (
        <span className={row.actions?.length ? "flex group-hover/v:hidden" : "flex"}>
          {row.trailing}
        </span>
      )}
      {!!row.actions?.length && (
        <span className="hidden group-hover/v:flex items-center flex-shrink-0">
          {row.actions.map((action) => (
            <button
              key={action.key}
              onClick={(e) => { e.stopPropagation(); action.onClick(e); }}
              className="p-1 rounded text-sol-text-dim hover:text-sol-text flex-shrink-0"
              title={action.title}
            >
              {action.icon}
            </button>
          ))}
        </span>
      )}
      <span className="w-1.5 flex-shrink-0" />
    </div>
  );
}

/** A numeric count on a nav row. Every count in the rail renders through this
 *  so simple view restyles counts by the `data-sv-count` marker, never by
 *  colour: a colour-keyed selector cannot tell a count pill from a project dot
 *  that happens to share its hue. `small` is the pinned rail's scale.
 *  `kind: "mention"` is a chat mention: it stays red in every visual style,
 *  because that number is "someone named you", not a volume count. */
export function NavCount({ n, tone, small, kind }: { n: number; tone: string; small?: boolean; kind?: "mention" }) {
  return (
    <span
      data-sv-count={kind ?? ""}
      className={`${small ? "min-w-[16px] h-[15px] px-1 text-[9.5px]" : "-ml-0.5 min-w-[20px] h-[20px] px-1.5 text-[11px]"} flex items-center justify-center font-bold rounded-full flex-shrink-0 ${tone}`}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

export function NavSection({
  label,
  href,
  isActive,
  isNarrow,
  icon,
  title,
  simpleHide,
  onMobileClose,
  badge,
  unread,
  items,
  headerAction,
  popped,
  expanded,
  onToggle,
  alwaysOpen,
}: {
  label: string;
  href: string;
  isActive: boolean;
  isNarrow: boolean;
  icon: React.ReactNode;
  title?: string;
  simpleHide?: boolean;
  /** Rendered beside the label in the wide rail — an unread count or dot. */
  badge?: React.ReactNode;
  /** Unread carried by WEIGHT, the same rule the channel rail follows: colour is
   *  already busy marking the active row, so using it for both makes neither
   *  legible. */
  unread?: boolean;
  onMobileClose?: () => void;
  /** Rows nested under this one — the projects under Projects, the saved views
   *  under Tasks and Docs. */
  items?: SectionRowSpec[];
  /** An action that belongs to the SECTION, not to any row in it — revealed on
   *  hover beside the label, the way Calls reveals "start huddle". */
  headerAction?: React.ReactNode;
  /** The desktop app this section belongs to. While that app has a window
   *  of its own the row dims and folds: it is a door to that window, and
   *  the window is where the section lives (lib/desktopApps). */
  popped?: DesktopApp;
  expanded?: boolean;
  onToggle?: () => void;
  /** The rows under it are views of this section, not a list it holds: they
   *  always show, with no chevron to fold them and nothing to open on click. */
  alwaysOpen?: boolean;
}) {
  const inOtherWindow = usePoppedOut(popped);
  // Only the wide rail nests children; the narrow rail stays icon-only, and
  // a section living in another window keeps its list there.
  const hasChildren = !isNarrow && !!items && items.length > 0 && !inOtherWindow;
  const away = inOtherWindow ? " opacity-55 hover:opacity-90" : "";
  const rowTitle = inOtherWindow && popped ? `${label}: opens in the ${DESKTOP_APPS[popped].title} window` : (title ?? label);
  return (
    <div data-simple-hide={simpleHide ? "" : undefined}>
      <div className={`group/nav flex items-center border-l-2 transition-colors motion-reduce:transition-none ${railRowTone(isActive && !inOtherWindow)}${away}`}>
        <Link
          href={href}
          onClick={(e) => {
            onMobileClose?.();
            // Going into a section opens its list: landing on a channel while
            // the channels stay folded reads as broken. Only opens, never folds;
            // the chevron is the fold control.
            if (hasChildren && !alwaysOpen && !expanded) onToggle?.();
            // On a SPLIT stage a plain click is ambiguous — which pane? Hand
            // the choice to the user (StagePickLayer) instead of guessing.
            // Modified clicks keep their browser meaning.
            if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && requestStagePlacement(href, label)) {
              e.preventDefault();
            }
          }}
          data-nav-row
          aria-current={isActive ? "page" : undefined}
          // A section is a pane waiting to happen: drag it onto the stage to
          // split it in beside whatever is there (lib/stage).
          draggable
          onDragStart={(e) => startPaneDrag(e, { path: href, title: label })}
          className={`flex-1 flex items-center ${isNarrow ? "justify-center px-4" : "gap-3 pl-4"} py-2.5 min-w-0`}
          title={rowTitle}
        >
          {icon}
          {!isNarrow && <span className={unread && !isActive ? "font-semibold text-sol-text" : undefined}>{label}</span>}
        </Link>
        {!isNarrow && headerAction}
        {hasChildren && !alwaysOpen && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle?.(); }}
            className="p-1 text-sol-text-dim hover:text-sol-text transition-colors"
            title={expanded ? `Collapse ${label.toLowerCase()}` : `Expand ${label.toLowerCase()}`}
            aria-expanded={expanded}
          >
            <svg className={`w-3 h-3 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
        {/* Count last, after the hover control and the chevron, so it sits on
            the same right edge as Inbox / Questions / Threads — those rows
            have no trailing buttons, and a badge inside the link was shoved
            left of Chat's extras. Same href as the label, so clicking the
            number still opens the section. */}
        {!isNarrow && badge && (
          <Link
            href={href}
            tabIndex={-1}
            aria-hidden="true"
            className="flex-shrink-0"
            onClick={onMobileClose}
            draggable={false}
          >
            {badge}
          </Link>
        )}
        {!isNarrow && <span className="w-4 flex-shrink-0" aria-hidden="true" />}
      </div>
      {/* Views of the section: plain rows on a guide line from this row's
          icon, text aligned with the label above. */}
      {hasChildren && alwaysOpen && (
        <div className="ml-[27px] mb-0.5 border-l border-sol-border/60">
          {items!.map((child) => (
            <SectionRow key={child.id} row={child} className="pl-[14px]" />
          ))}
        </div>
      )}
      {/* Nested rows — a slide-open list aligned under this row's icon. */}
      {hasChildren && !alwaysOpen && (
        // A grid whose single row animates 0fr → 1fr opens to the list's own
        // height, so a section with twenty channels shows twenty. The old
        // max-height capped it at 384px and hid the rest behind a second
        // scrollbar inside a sidebar that already scrolls.
        <div
          className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
          // Inline, not a Tailwind class: `grid-rows-[1fr]` compiles to
          // minmax(0, 1fr), whose zero minimum collapses the track to nothing in
          // an auto-height container. A bare 1fr sizes to the list's content.
          style={{ gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0 }}
        >
          <div className="overflow-hidden">
            {/* The panel spans the full rail; its rows indent to sit under
                this row's icon. */}
            <div className="nav-subsection my-0.5">
              <div className="ml-[18px]">
                {items!.map((child) => (
                  <SectionRow key={child.id} row={child} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The needs-input count on the Inbox row. Silent at zero. */
export function NeedsInputCount({ n }: { n: number }) {
  if (n === 0) return null;
  return <NavCount n={n} tone="bg-teal-600 text-white" />;
}

/** The Inbox row. `badge` is the count, passed as a node so the app can hand
 *  in a badge that subscribes on its own and a heartbeat re-renders only it. */
export function InboxNavRow({ active, isNarrow, badge, onClick }: {
  active: boolean;
  isNarrow: boolean;
  badge?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={railRowClass(active, isNarrow)}
      title="Inbox"
      data-nav-page="/inbox"
    >
      <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
      </svg>
      {!isNarrow && (
        <>
          <span>Inbox</span>
          {badge}
        </>
      )}
    </button>
  );
}
