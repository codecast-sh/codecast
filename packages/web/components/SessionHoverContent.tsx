import { ArrowUpRight, FolderOpen, MessageSquare } from "lucide-react";
import {
  AuthorAvatar,
  SessionSummaryBlock,
} from "./entityDisplay";
import { abbrevModel, relativeTime } from "../lib/entityDisplay";

export function SessionHoverContent({ session }: { session: any }) {
  const isActive = session.status === "active";
  const model = abbrevModel(session.model);
  const projectName = session.project_path?.split("/").pop() ?? null;
  const timeAgo = relativeTime(session.updated_at);
  const isForeign = !!(session.author_name || session.author_avatar);
  const metaParts = [
    session.message_count != null ? `${session.message_count} msgs` : null,
    model,
    timeAgo,
  ].filter(Boolean);

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <div className="relative flex-shrink-0 mt-0.5">
          {isForeign ? (
            <AuthorAvatar name={session.author_name} avatar={session.author_avatar} size={16} />
          ) : (
            <MessageSquare className="w-3.5 h-3.5 text-sol-blue" />
          )}
          {isActive && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-sol-green border border-sol-bg" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">
            {session.title || session.short_id}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-[10px] font-medium ${isActive ? "text-sol-green" : "text-gray-400"}`}>
              {isActive ? "Active" : session.status || "Stopped"}
            </span>
            {session.agent_type && (
              <>
                <span className="text-gray-600">·</span>
                <span className="text-[10px] text-gray-400">{session.agent_type}</span>
              </>
            )}
            {isForeign && session.author_name && (
              <>
                <span className="text-gray-600">·</span>
                <span className="text-[10px] text-sol-text-muted truncate">{session.author_name}</span>
              </>
            )}
          </div>
        </div>
      </div>

      <SessionSummaryBlock session={session} className="pl-[22px]" />

      {metaParts.length > 0 && (
        <div className="flex items-center gap-2 pl-[22px] text-[10px] text-gray-500 font-mono">
          {metaParts.map((part, index) => <span key={index}>{part}</span>)}
        </div>
      )}

      {projectName && (
        <div className="flex items-center gap-1.5 pl-[22px]">
          <FolderOpen className="w-2.5 h-2.5 text-gray-500 flex-shrink-0" />
          <span className="text-[10px] text-gray-400 font-mono truncate">{projectName}</span>
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500 font-mono">{session.short_id}</span>
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5">
          Click to open <ArrowUpRight className="w-2.5 h-2.5" />
        </span>
      </div>
    </div>
  );
}
