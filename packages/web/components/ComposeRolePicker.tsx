"use client";
// Sending a new request to a role instead of starting a plain session
// (docs/architecture/org-roles-standing.md T6). The new session composer
// grows one line: pick a role, and the request goes into that role's standing
// session, the same message `cast role wake @handle "<request>"` enqueues and
// the role page's Talk composer sends. The role then starts the work and says
// which session it started.
//
// The list is the workspace's roles as the org tree already holds them
// (hooks/useOrgRoles): the viewer's direct reports first, read as their own,
// everyone else's below and quieter. Closed and unpicked, it shows nothing:
// the composer stays a plain new session. Typing filters by name, handle,
// title or area (lib/roleRecipients). Keyboard first: ⌥R opens it from
// anywhere in the composer, ↑↓ move, ↵ picks and hands the caret back to the
// message, Esc backs out; the picked pill and every row take a click too.
import { useCallback, useMemo, useRef, useState } from "react";
import { AtSign, X } from "lucide-react";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { useOrgRoles } from "../hooks/useOrgRoles";
import { useSyncOrgTreeFeeder } from "../hooks/useSyncOrgTree";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { hasOpenModal, isMac } from "../shortcuts";
import { RoleFace } from "./org/RoleFace";
import { standingLineOf } from "./org/orgMeta";
import { filterRoleRecipients, roleRecipients, sendRequestToRole, type GateImage, type RoleRecipient } from "../lib/roleRecipients";
import { useInboxStore } from "../store/inboxStore";
import { awaitUpload } from "../lib/pendingUploads";
import { toast } from "sonner";

const ALT_CAP = isMac ? "⌥" : "Alt";

/** The chord that opens the picker: ⌥R. `code` so the mac Option dead key (®) never hides it. */
function isRolePickerChord(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === "KeyR";
}

/** The picked recipient of a new request and the send that goes with it, for
 *  every composer that hosts the picker (the Ctrl+N popup, the new-session
 *  page). The send is MessageInput's gate: it receives the text and images
 *  once the composer has emptied, and returns the role it reached. */
export function useRoleRecipient() {
  const [recipient, setRecipient] = useState<RoleRecipient | null>(null);
  const recipientRef = useRef(recipient);
  recipientRef.current = recipient;
  const wakeRole = useCallback(async (text: string, images?: GateImage[]): Promise<RoleRecipient | null> => {
    const r = recipientRef.current;
    if (!r) return null;
    const into = await sendRequestToRole(() => useInboxStore.getState(), r, text, images ?? [], awaitUpload);
    if (!into) toast.error(`${r.name} has no standing session yet`);
    return into ? r : null;
  }, []);
  return { recipient, setRecipient, recipientRef, wakeRole };
}

export function ComposeRolePicker({ picked, onPick, onDone, page, className = "" }: {
  picked: RoleRecipient | null;
  /** The host's placement (width, margin), applied only while something shows. */
  className?: string;
  /** The new-session page: a quiet centered line of faces over the headline,
   *  and a picked role becomes the headline itself. */
  page?: boolean;
  /** A role, or null to send to a fresh session again. */
  onPick: (r: RoleRecipient | null) => void;
  /** The picker is finished with the keyboard: the host puts the caret back in the message. */
  onDone: () => void;
}) {
  // The tree is fed here too: the composer opens from anywhere, not only after
  // the org page has mounted its feeder.
  useSyncOrgTreeFeeder();
  const { roles, workspace } = useOrgRoles();
  const { user } = useCurrentUser();
  const viewerId = user?._id ? String(user._id) : null;
  const all = useMemo(
    () => roleRecipients(roles, viewerId, { teamName: workspace?.kind === "team" ? workspace.name : null }),
    [roles, viewerId, workspace],
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => filterRoleRecipients(all, query), [all, query]);
  // Only a seat with a standing session can take the request; the rest are
  // listed so the picker can say why, and the keyboard steps over them.
  const selectable = useMemo(() => shown.filter((r) => !!r.standingId), [shown]);

  const close = useCallback((done = true) => {
    setOpen(false);
    setQuery("");
    if (done) onDone();
  }, [onDone]);

  const openPicker = useCallback(() => {
    setHi(0);
    setQuery("");
    setOpen(true);
  }, []);

  useWatchEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useWatchEffect(() => { setHi(0); }, [query]);

  const pick = useCallback((r: RoleRecipient) => {
    if (!r.standingId) return;
    onPick(r);
    close();
  }, [onPick, close]);

  // ⌥R from anywhere in the composer. Capture phase on window, like the
  // project and agent chords (NewSessionView): the message box swallows keys
  // in the bubble phase. A modal stacked above us (the draft confirm) owns the
  // keyboard; a docked composer answers only while it holds focus. The
  // new-session page has no dialog around it and always answers.
  useMountEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isRolePickerChord(e)) return;
      const root = rootRef.current;
      if (!root || hasOpenModal(root)) return;
      const dock = root.closest('[role="dialog"]:not([aria-modal="true"])');
      if (dock && !dock.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      if (open) close();
      else openPicker();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const onInputKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (selectable.length === 0) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setHi((i) => (i + d + selectable.length) % selectable.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const sel = selectable[Math.min(hi, selectable.length - 1)];
      if (sel) pick(sel);
      return;
    }
    if (e.key === "Backspace" && query === "" && picked) {
      e.preventDefault();
      onPick(null);
      return;
    }
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }, [selectable, hi, pick, query, picked, onPick, close]);

  // No roles in this workspace: the composer stays as it was.
  if (all.length === 0) return null;

  if (!open) {
    // Unpicked: nothing on screen, only the ⌥R listener's anchor.
    if (!picked) return <div ref={rootRef} hidden />;
    if (page) return (
      <div ref={rootRef} className={`flex flex-col items-center gap-2 text-center ${className}`}>
        <button type="button" onClick={openPicker} className="group flex items-center gap-3" aria-label={`Sending to ${picked.name}, ${picked.title}. Change role`}>
          <RoleFace role={picked.role} size={36} />
          <h1 className="text-xl sm:text-2xl font-medium tracking-tight text-sol-text">
            Ask <span className="underline decoration-sol-violet/60 decoration-2 underline-offset-[6px] group-hover:text-sol-violet transition-colors">{picked.name}</span>
          </h1>
        </button>
        <div className="flex items-center gap-2 text-xs text-sol-text-dim">
          <span className="text-sol-text-muted">{picked.title}</span>
          <span className="font-mono opacity-70">@{picked.handle}</span>
          <StandingDot r={picked} withLabel />
          <button type="button" onClick={() => { onPick(null); onDone(); }} className="ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-sol-text hover:bg-sol-bg-alt transition-colors" aria-label="Start a fresh session instead">
            <X className="w-3 h-3" />new session
          </button>
        </div>
      </div>
    );
    return (
      <div ref={rootRef} className={`flex items-center gap-2 w-full min-w-0 rounded-lg border border-sol-violet/40 bg-sol-violet/[0.07] pl-2.5 pr-1.5 py-1.5 text-xs ${className}`}>
        <RoleFace role={picked.role} size={20} />
        <button type="button" onClick={openPicker} className="flex items-center gap-1.5 min-w-0 flex-1 text-left hover:opacity-90" aria-label={`Sending to ${picked.name}, ${picked.title}. Change role`}>
          <span className="text-sol-text-dim shrink-0">To</span>
          <RoleLine r={picked} handle />
          <StandingDot r={picked} withLabel />
        </button>
        <span className="hidden sm:inline-flex items-center gap-1 text-[10px] text-sol-text-dim/70 shrink-0">
          <KeyCap size="xs">{ALT_CAP}</KeyCap><KeyCap size="xs">R</KeyCap> change
        </span>
        <button type="button" onClick={() => { onPick(null); onDone(); }} className="p-1 rounded text-sol-text-dim/70 hover:text-sol-red hover:bg-sol-red/10 transition-colors shrink-0" aria-label="Start a fresh session instead">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  const firstOther = shown.findIndex((r) => !r.mine);
  const byHandle = query.trimStart().startsWith("@");
  return (
    <div ref={rootRef} className={`w-full rounded-lg border border-sol-violet/40 bg-sol-bg-alt/40 ring-1 ring-sol-violet/20 text-xs ${className}`} role="combobox" aria-expanded="true" aria-haspopup="listbox" aria-controls="compose-role-list">
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-sol-border/40">
        <AtSign className="w-3.5 h-3.5 text-sol-violet shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          onBlur={() => close(false)}
          placeholder="Send to a role: name, handle or area"
          aria-label="Send to a role"
          aria-autocomplete="list"
          className="flex-1 min-w-0 bg-transparent outline-none border-0 p-0 text-sm text-sol-text placeholder:text-sol-text-dim/60"
        />
      </div>
      <ul id="compose-role-list" role="listbox" className="max-h-56 overflow-y-auto py-1">
        {shown.length === 0 && <li className="px-2.5 py-2 text-sol-text-dim">No role matches &ldquo;{query}&rdquo;</li>}
        {shown.map((r, i) => {
          const idx = selectable.indexOf(r);
          const isHi = idx >= 0 && idx === Math.min(hi, selectable.length - 1);
          const dead = !r.standingId;
          return (
            <li key={r.role._id} role="option" aria-selected={isHi} aria-disabled={dead || undefined} className="contents">
              {i === firstOther && (
                <div className={`px-2.5 pb-1 text-[10px] text-sol-text-dim/60 ${i > 0 ? "mt-1 pt-1.5 border-t border-sol-border/30" : ""}`}>Other people&rsquo;s roles</div>
              )}
              <button
                type="button"
                data-handle={r.handle}
                disabled={dead}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => { if (idx >= 0) setHi(idx); }}
                onClick={() => pick(r)}
                className={`flex items-center gap-2 w-full min-w-0 px-2.5 py-1.5 text-left transition-colors ${
                  isHi ? "bg-sol-violet/15 text-sol-text" : dead ? "cursor-default" : "hover:bg-sol-bg-alt"
                } ${r.mine ? "" : "opacity-70"} ${dead ? "opacity-50" : ""}`}
              >
                <RoleFace role={r.role} size={20} />
                <RoleLine r={r} handle={byHandle} />
                {!dead && r.role.status !== "paused" && <StandingDot r={r} withLabel />}
                {r.role.status === "paused" && <span className="shrink-0 text-[10px] text-sol-yellow/80">paused</span>}
                {dead && <span className="shrink-0 text-[10px] text-sol-text-dim">no agent yet</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-3 px-2.5 py-1.5 border-t border-sol-border/40 text-[10px] text-sol-text-dim/70">
        <Hint keys={["↑", "↓"]} label="move" />
        <Hint keys={["↵"]} label="pick" />
        <Hint keys={["Esc"]} label="back" />
        {picked && <Hint keys={["⌫"]} label="fresh session" />}
      </div>
    </div>
  );
}

/** Face aside, the role's one line: name, title, area; the handle only where
 *  there is room for it (the picked row) or the query asked by handle. */
function RoleLine({ r, handle }: { r: RoleRecipient; handle?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 min-w-0 flex-1">
      <span className="font-medium text-sol-text shrink-0">{r.name}</span>
      <span className="text-sol-text-muted truncate">{r.title}</span>
      {r.area && <span className="text-sol-text-dim truncate min-w-0 shrink-[2]">· {r.area}</span>}
      {handle && <span className="ml-auto pl-2 text-sol-text-dim/60 font-mono shrink-0">@{r.handle}</span>}
    </span>
  );
}

/** The role's standing session as a coloured dot (its declared status, else
 *  its observed work state): what the role is doing before it is handed more. */
function StandingDot({ r, withLabel }: { r: RoleRecipient; withLabel?: boolean }) {
  const line = standingLineOf(r.role.standing);
  if (!line) return null;
  return (
    <span className="inline-flex items-center gap-1 shrink-0 text-[10px]" style={{ color: line.color }} title={line.text ?? line.label}>
      <span aria-hidden className="w-1.5 h-1.5 rounded-full" style={{ background: line.color }} />
      {withLabel && line.label}
    </span>
  );
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-flex items-center gap-[2px]">{keys.map((k) => <KeyCap key={k} size="xs">{k}</KeyCap>)}</span>
      <span>{label}</span>
    </span>
  );
}
