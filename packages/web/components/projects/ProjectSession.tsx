"use client";
// A project's page opens on its default session (session-projects.md SP5):
// the lead's standing session, else the canonical one the project's own
// composer started; until either exists, that composer. Every other session
// in the project is the inbox beside the page, filtered to it.
import { InboxConversation } from "../../app/inbox/QueuePageClient";
import { ContextChatInput } from "../ContextChatInput";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useInboxStore, type InboxSession } from "../../store/inboxStore";

type ProjectRow = { _id: string; title?: string; goal?: string; description?: string; project_path?: string; owner_role_id?: string; default_session_id?: string };
type RoleSeat = { _id: string; standing?: { conversation_id: string } | null };

/** The project's default session id: its seated lead's standing session, else
 *  its canonical session (the server's pointer, or the stub its composer just
 *  started, which the server's pointer replaces once it lands). */
export function projectDefaultSessionOf(
  project: ProjectRow,
  sessions: Record<string, InboxSession>,
  roles: readonly RoleSeat[] = [],
): string | null {
  if (project.owner_role_id) {
    const lead = String(project.owner_role_id);
    const seat = roles.find((r) => String(r._id) === lead)?.standing?.conversation_id
      ?? Object.values(sessions).find((s) => s.standing_role_id && String(s.standing_role_id) === lead)?._id;
    if (seat) return seat;
  }
  if (project.default_session_id) return project.default_session_id;
  return Object.values(sessions).find((s) => s._projectDefault && s.project_id === project._id)?._id ?? null;
}

export function ProjectSession({ project, onOpenAbout }: { project: ProjectRow; onOpenAbout?: () => void }) {
  const phone = useIsPhone();
  const defaultId = useInboxStore((s) => projectDefaultSessionOf(project, s.sessions, s.orgTree?.roles as RoleSeat[] | undefined));
  // The three fields the conversation takes from the row, not the row (its
  // ref flips on every heartbeat).
  const isIdle = useInboxStore((s) => !!(defaultId && s.sessions[defaultId]?.is_idle));
  const lastUserMessage = useInboxStore((s) => (defaultId ? s.sessions[defaultId]?.last_user_message : undefined));
  const sessionError = useInboxStore((s) => (defaultId ? (s.sessions[defaultId] as any)?.session_error : undefined));
  // The page header already names the project; a session carrying the same
  // name keeps its header controls without saying it twice.
  const sameName = useInboxStore((s) => {
    const t = defaultId ? s.sessions[defaultId]?.title : undefined;
    return !!t && !!project.title && t.trim().toLowerCase() === project.title.trim().toLowerCase();
  });

  if (defaultId) {
    return (
      <div className="flex-1 min-h-0" data-project-conversation={defaultId}>
        <InboxConversation
          sessionId={defaultId}
          isIdle={isIdle}
          lastUserMessage={lastUserMessage}
          sessionError={sessionError}
          autoFocusInput={!phone}
          diffOnlyWithChanges
          hideHeaderTitle={sameName}
        />
      </div>
    );
  }
  // No session yet: what the project is for (the header names it), over the
  // box that starts its session, in the middle of the page.
  const about = (project.goal || project.description || "").split("\n").map((l) => l.trim()).find(Boolean);
  return (
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col" data-project-conversation="none">
      {/* Above the middle, where the eye lands on a page that is mostly empty. */}
      <div className="flex-[2]" />
      <div className="w-full max-w-2xl mx-auto px-4 py-8">
        {about
          ? <p className="mb-5 text-[14px] leading-6 text-sol-text-muted line-clamp-3">{about}</p>
          : onOpenAbout && (
            <button type="button" onClick={onOpenAbout} className="mb-4 text-[13px] text-sol-text-dim underline decoration-dotted underline-offset-4 hover:text-sol-text" data-project-add-about>
              Say what this project is for
            </button>
          )}
        <ContextChatInput
          open
          inline
          contextType="project"
          contextTitle={project.title ?? "Project"}
          getContextBody={() => [project.goal && `Goal: ${project.goal}`, project.description].filter(Boolean).join("\n\n")}
          projectPath={project.project_path}
          projectId={project._id}
          projectDefault
          onSent={() => {}}
          placeholder="What should happen next?"
        />
      </div>
      <div className="flex-[3]" />
    </div>
  );
}
