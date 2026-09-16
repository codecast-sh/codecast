"use client";

// Who each Slack person is in codecast. The email rule matches most of them
// on its own; this is where a teammate settles the rest: a different address
// in Slack, a shared account, a contractor who is one of us. One row per Slack
// person seen in the mirrored channels, a picker of teammates on the right, the
// unmatched ones first. A change re-authors that person's past lines too, so
// the room reads as if it had always been right.
import { useMutation } from "convex/react";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, Search } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { SlackLogo } from "../SlackLogo";
import { CommentAvatar } from "../comments/CommentAvatar";
import { useTrackedStore } from "../../store/inboxStore";
import type { ChatSlackPersonRow } from "../../store/chatSlice";
import { memberName, type ChatMember } from "../../lib/chatViews";
import { memberAvatarUrl } from "../../lib/liveEntities";
import { memberListSig } from "../../hooks/useTeamRoster";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import "./chat.css";

type Person = {
  slack_user_id: string;
  name: string;
  handle: string | null;
  real_name: string | null;
  avatar_url: string | null;
  email: string | null;
  codecast_user_id: string | null;
  mapped_by: "email" | "manual" | null;
};

/** Re-render the popup only when a row it shows changes. */
function slackPeopleSig(people: Record<string, ChatSlackPersonRow> | undefined, teamId: string): string {
  let sig = "";
  for (const id in people ?? {}) {
    const p = people![id];
    if (p.team_id !== teamId) continue;
    sig += `${id}|${p.name}|${p.handle ?? ""}|${p.avatar_url ?? ""}|${p.codecast_user_id ?? ""}|${p.mapped_by ?? ""};`;
  }
  return sig;
}

const NOBODY = "__nobody__";
const AUTO = "__auto__";

export function SlackPeopleDialog({ teamId, onClose }: { teamId: string; onClose: () => void }) {
  // The people come from the store (chatSlackPeople, fed app-wide by
  // useChatChannelsSync), so the popup opens on what is already here.
  const mapPerson = useMutation(api.slackSync.mapSlackPerson);
  const s = useTrackedStore([
    (st) => memberListSig(st.teamMembers as any),
    (st) => st.currentUser?._id,
    (st) => slackPeopleSig(st.chatSlackPeople, teamId),
  ]);
  const members = ((s.teamMembers ?? []) as ChatMember[]).filter((m) => !m.is_bot);
  const me = String(s.currentUser?._id ?? "");
  const rows = useMemo(
    () => Object.values(s.chatSlackPeople ?? {}).filter((p) => p.team_id === teamId).sort(
      (a, b) => Number(!!a.codecast_user_id) - Number(!!b.codecast_user_id) || a.name.localeCompare(b.name),
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slackPeopleSig(s.chatSlackPeople, teamId), teamId],
  );
  // Attribution is team wide: an admin may map anyone, a member only claim
  // themselves (the server's rule in mapSlackPerson).
  const myRole = (s.teamMembers ?? []).find((m: any) => String(m._id) === me)?.role;
  const isAdmin = myRole === "admin" || myRole === "owner";
  const data = { people: rows };
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);

  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  useWatchEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const focusable = dialogRef.current?.querySelector<HTMLElement>("input, select, button:not(.ch-slack-close)");
    (focusable ?? dialogRef.current)?.focus();
    return () => opener?.focus?.();
  }, []);

  const people = useMemo(() => {
    const rows = (data?.people ?? []) as Person[];
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((p) =>
      [p.name, p.real_name, p.handle, p.email].some((v) => (v ?? "").toLowerCase().includes(needle)),
    );
  }, [data, q]);
  const unmatched = ((data?.people ?? []) as Person[]).filter((p) => !p.codecast_user_id).length;

  const choose = async (p: Person, value: string) => {
    setErr(null);
    setBusy((b) => ({ ...b, [p.slack_user_id]: true }));
    try {
      await mapPerson({
        team_id: teamId,
        slack_user_id: p.slack_user_id,
        codecast_user_id: value === NOBODY || value === AUTO ? null : (value as any),
      } as any);
    } catch (e: any) {
      setErr(e?.data?.message ?? e?.message ?? "Couldn't save that");
    } finally {
      setBusy((b) => ({ ...b, [p.slack_user_id]: false }));
    }
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="ch-slack-overlay" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="ch-slack-dialog ch-slack-people"
        role="dialog"
        aria-modal="true"
        aria-label="People from Slack"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ch-slack-head">
          <SlackLogo className="w-5 h-5" />
          <div className="min-w-0">
            <div className="ch-slack-title">People from Slack</div>
            <div className="ch-slack-sub">
              {data ? `${data.people.length} seen` : "…"}
              {data && unmatched > 0 && <span className="ch-slack-ws"> · {unmatched} not matched to a teammate</span>}
            </div>
          </div>
          <button type="button" className="ch-slack-close" aria-label="Close" onClick={onClose}>×</button>
        </header>

        <div className="ch-slack-body">
          <p className="ch-slack-lede">
            A Slack person matched to a teammate speaks here as that teammate; anyone else shows under their
            Slack name. Changing a match rewrites their past lines too.
            {!isAdmin && " You can claim a Slack account as yourself; a team admin can match anyone."}
          </p>
          <label className="ch-slack-search">
            <Search className="w-3.5 h-3.5 text-sol-text-dim" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people from Slack" />
          </label>
          {err && <div className="ch-slack-err"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{err}</div>}
          <ul className="ch-slack-people-list" aria-label="People from Slack">
            {data && people.length === 0 && (
              <li className="ch-slack-empty">{q ? `Nobody matches “${q}”.` : "Nobody from Slack has spoken in a mirrored channel yet."}</li>
            )}
            {people.map((p) => {
              const value = p.mapped_by === "manual" ? (p.codecast_user_id ?? NOBODY) : (p.codecast_user_id ?? AUTO);
              const canEdit = isAdmin || !p.codecast_user_id || p.codecast_user_id === me;
              return (
                <li key={p.slack_user_id} className="ch-slack-person">
                  <span className="ch-slack-person-face">
                    <CommentAvatar name={p.name} image={p.avatar_url ?? undefined} size={22} letters={1} />
                  </span>
                  <span className="ch-slack-person-who">
                    <span className="ch-slack-person-name">{p.real_name && p.real_name !== p.name ? `${p.real_name} · ${p.name}` : p.name}</span>
                    <span className="ch-slack-person-meta">
                      {p.handle ? `@${p.handle}` : ""}
                      {p.handle && p.email ? " · " : ""}
                      {p.email ?? ""}
                    </span>
                  </span>
                  <span className="ch-slack-person-pick">
                    {p.codecast_user_id && <Check className="w-3 h-3 ch-slack-check" aria-hidden="true" />}
                    <select
                      className="ch-slack-select"
                      value={value}
                      disabled={!canEdit || !!busy[p.slack_user_id]}
                      onChange={(e) => choose(p, e.target.value)}
                      aria-label={`Who ${p.name} is in codecast`}
                      title={!canEdit ? "A team admin can change this match" : undefined}
                    >
                      <option value={AUTO}>{p.mapped_by === "email" ? "Matched by email" : "Not matched · Slack name"}</option>
                      <option value={NOBODY}>Keep the Slack name</option>
                      <optgroup label="Teammates">
                        {members.map((m) => (
                          <option key={String(m._id)} value={String(m._id)}>
                            {memberName(m)}{String(m._id) === me ? " (you)" : ""}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </span>
                  {p.mapped_by === "manual" && <span className="ch-slack-tag ch-slack-tag-quiet" title="Set by a teammate">set</span>}
                  {p.codecast_user_id && (
                    <span className="ch-slack-person-as" aria-hidden="true">
                      <CommentAvatar
                        name={memberName(members.find((m) => String(m._id) === p.codecast_user_id))}
                        image={memberAvatarUrl(members.find((m) => String(m._id) === p.codecast_user_id) as any)}
                        size={18}
                        letters={1}
                      />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <footer className="ch-slack-foot ch-slack-browser-foot">
          <span className="ch-slack-fine">Matches apply to every mirrored channel in the team.</span>
          <button type="button" className="ch-slack-primary" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
