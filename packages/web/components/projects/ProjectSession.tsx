"use client";
// A project's page opens on its default session (session-projects.md SP5):
// the lead's standing session, else the canonical one the project's own
// composer started; until either exists, that composer. Every other session
// in the project is the inbox beside the page, filtered to it.
import { InboxConversation } from "../../app/inbox/QueuePageClient";
import { ContextChatInput } from "../ContextChatInput";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useInboxStore } from "../../store/inboxStore";
import { projectDefaultSessionOf, type ProjectRow, type RoleSeat } from "../../lib/projectDefaultSession";

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
