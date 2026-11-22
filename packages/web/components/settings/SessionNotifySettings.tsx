"use client";
import Link from "next/link";
import { BellRing } from "lucide-react";
import { useInboxStore, useTrackedStore, type SessionNotifyItem, type SessionNotifyLevel } from "../../store/inboxStore";
import { SettingsRow, SettingsSection } from "./ui";
import { SelectBox } from "../ui/select-box";

const LEVEL_LABEL: Record<SessionNotifyLevel, string> = {
  all: "Every message",
  needs_input: "Needs input",
  muted: "Muted",
};

function titleOf(s: any, id: string): string {
  const row = s.conversations[id] ?? s.sessions[id];
  return row?.title?.trim() || row?.project_path?.split("/").pop() || "Session";
}

const unmuteClass = "text-xs px-2 py-1 rounded border border-sol-border text-sol-text-secondary hover:bg-sol-bg-alt";

/** Every session the viewer subscribed to or muted, and every project and
 *  folder they muted, each undone with one press. */
export function SessionNotifySettings() {
  const s = useTrackedStore([
    (s) => s.sessionNotify,
    (s) => s.currentUser?.muted_projects,
    (s) => s.currentUser?.muted_folders,
    (s) => Object.values(s.sessionNotify).map((r) => titleOf(s, r.conversation_id)).join("\u0000"),
    (s) => (s.currentUser?.muted_projects ?? []).map((p: string) => s.projects[p]?.title ?? "").join("\u0000"),
  ]);
  const setSessionNotify = useInboxStore((st) => st.setSessionNotify);
  const updateSettings = useInboxStore((st) => st.updateNotificationSettings);
  const rows = (Object.values(s.sessionNotify) as SessionNotifyItem[]).sort((a, b) => b.updated_at - a.updated_at);
  const projects: string[] = s.currentUser?.muted_projects ?? [];
  const folders: string[] = s.currentUser?.muted_folders ?? [];
  if (rows.length === 0 && projects.length === 0 && folders.length === 0) return null;

  return (
    <SettingsSection title="Sessions, projects and folders" icon={BellRing}>
      {rows.map((r) => (
        <SettingsRow
          key={r._id}
          label={<Link href={`/conversation/${r.conversation_id}`} className="hover:underline truncate">{titleOf(s, r.conversation_id)}</Link>}
        >
          <SelectBox
            value={r.level}
            onChange={(e) => setSessionNotify(r.conversation_id, e.target.value as SessionNotifyLevel | "default")}
            aria-label={`Notifications for ${titleOf(s, r.conversation_id)}`}
          >
            {(Object.keys(LEVEL_LABEL) as SessionNotifyLevel[]).map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
            <option value="default">Default</option>
          </SelectBox>
        </SettingsRow>
      ))}
      {projects.map((p) => (
        <SettingsRow key={p} label={<Link href={`/projects/${p}`} className="hover:underline">Project {s.projects[p]?.title ?? ""}</Link>}>
          <span className="text-xs text-sol-orange">Muted</span>
          <button className={unmuteClass} onClick={() => updateSettings({ muted_projects: projects.filter((x) => x !== p) })}>Unmute</button>
        </SettingsRow>
      ))}
      {folders.map((f) => (
        <SettingsRow key={f} label={<span className="font-mono text-xs truncate" title={f}>{f}</span>}>
          <span className="text-xs text-sol-orange">Muted</span>
          <button className={unmuteClass} onClick={() => updateSettings({ muted_folders: folders.filter((x) => x !== f) })}>Unmute</button>
        </SettingsRow>
      ))}
    </SettingsSection>
  );
}
