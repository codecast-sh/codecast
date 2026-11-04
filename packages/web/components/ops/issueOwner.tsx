// Who owns an issue: its problem task's assignee. The list shows the face on
// each row, the page names it in the header, and both assign from one menu
// (a on the page, the bulk bar on the list). Assigning an issue that has no
// problem task files one for it with the assignee, so ownership never needs a
// second trip to the task.
import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { UserPlus } from "lucide-react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { AssigneeFace } from "../identity/AssigneeFace";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { assignIssues, ownerInfo, useOwnerOptions, type OwnerOption } from "./issueAssign";
import type { OpsGroup, OpsSource } from "./opsTypes";

/** A row's owner: the face alone, the name on hover. */
export function OwnerFace({ owner }: { owner: OwnerOption | null }) {
  if (!owner) return null;
  return (
    <span className="iss-owner-face" title={owner.you ? `${owner.label} (you)` : owner.label} aria-label={`owned by ${owner.label}`}>
      <AssigneeFace info={owner.info} size={16} hover={false} />
    </span>
  );
}

/**
 * The assign menu: type to narrow, arrows to move, Enter to pick, Esc to
 * close. It opens under the control that opened it.
 */
export function AssignMenu({ options, current, onPick, onClose, placeholder = "Assign to" }: { options: OwnerOption[]; current?: string | null; onPick: (o: OwnerOption) => void; onClose: () => void; placeholder?: string }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const w = q.trim().toLowerCase();
    return w ? options.filter((o) => o.label.toLowerCase().includes(w)) : options;
  }, [options, q]);
  useWatchEffect(() => {
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onClose]);
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && shown[at]) { e.preventDefault(); e.stopPropagation(); onPick(shown[at]); }
  };
  return (
    <div ref={box} className="iss-assign-menu" role="dialog" aria-label="Assign" onKeyDown={onKey}>
      <input autoFocus value={q} placeholder={placeholder} aria-label={placeholder} onChange={(e) => { setQ(e.target.value); setAt(0); }} />
      <div role="listbox" className="iss-assign-list">
        {shown.length === 0 && <div className="iss-assign-none ops-dim">Nobody matches</div>}
        {shown.slice(0, 40).map((o, i) => (
          <button key={o.key} type="button" role="option" aria-selected={i === at} data-on={i === at ? "true" : undefined} data-current={o.key === current ? "true" : undefined} onMouseEnter={() => setAt(i)} onClick={() => onPick(o)}>
            <AssigneeFace info={o.info} size={16} hover={false} />
            <span className="truncate">{o.label}</span>
            {o.you && <span className="ops-dim">you</span>}
            {o.section === "Roles" && <span className="ops-dim">role</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The issue page's owner: who answers for it, and the press (a) that hands it to someone. */
export function OwnerControl({ group, source, assignee, open, setOpen }: { group: OpsGroup; source?: OpsSource; assignee: string | null; open: boolean; setOpen: (v: boolean) => void }) {
  const options = useOwnerOptions();
  const owner = ownerInfo(options, assignee);
  return (
    <span className="iss-owner">
      <button type="button" className="ops-btn" aria-expanded={open} onClick={() => setOpen(!open)} title={owner ? "Hand it to someone else" : "Give it an owner"}>
        {owner ? <AssigneeFace info={owner.info} size={16} hover={false} /> : <UserPlus className="w-3.5 h-3.5" />}
        <span className="truncate max-w-[140px]">{owner ? (owner.you ? "You" : owner.label) : "Assign"}</span>
        <KeyCap size="xs">a</KeyCap>
      </button>
      {open && (
        <AssignMenu
          options={options}
          current={assignee}
          onClose={() => setOpen(false)}
          onPick={(o) => {
            setOpen(false);
            assignIssues([group], o, new Map(source ? [[source._id, source]] : []));
          }}
        />
      )}
    </span>
  );
}
