import { useRef } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { InboxSession, getProjectName } from "../store/inboxStore";
import { cleanTitle } from "../lib/conversationProcessor";
import { LivenessDot, sessionLivenessState } from "./LivenessDot";

function StatusDot({ session }: { session: InboxSession }) {
  return <LivenessDot state={sessionLivenessState(session)} />;
}

export function SessionSwitcher({
  sessions,
  selectedIndex,
}: {
  sessions: InboxSession[];
  selectedIndex: number;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  useWatchEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (sessions.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto w-[380px] max-h-[min(480px,70vh)] flex flex-col rounded-lg border border-sol-border/60 bg-sol-bg/95 backdrop-blur-xl shadow-2xl shadow-black/40 overflow-hidden">
        <div className="px-3 py-2 border-b border-sol-border/40 flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-text-dim">
            Switch Session
          </span>
          <span className="ml-auto text-[10px] text-sol-text-dim/60">
            Tab / Shift-Tab
          </span>
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto py-1 scrollbar-auto">
          {sessions.map((session, i) => {
            const isSelected = i === selectedIndex;
            const project = getProjectName(session.git_root, session.project_path);
            const title = cleanTitle(session.title || "New Session");

            return (
              <div
                key={session._id}
                ref={isSelected ? selectedRef : undefined}
                className={`mx-1 px-3 py-2 rounded-md flex items-center gap-3 transition-colors ${
                  isSelected
                    ? "bg-sol-cyan/20 border border-sol-cyan/40"
                    : "border border-transparent"
                }`}
              >
                <StatusDot session={session} />
                <div className="flex-1 min-w-0">
                  <div className={`text-sm truncate ${isSelected ? "text-sol-text font-medium" : "text-sol-text/80"}`}>
                    {title}
                  </div>
                  {project !== "unknown" && (
                    <div className="text-[11px] text-sol-cyan/70 truncate">
                      {project}
                    </div>
                  )}
                </div>
                {i === 0 && (
                  <span className="text-[10px] text-sol-text-dim/50 flex-shrink-0">
                    current
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
