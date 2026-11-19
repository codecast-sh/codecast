// Put something on the call's stage for everyone in it: the call's board,
// a new board or sheet, a doc you have, or anything pasted (a /docs link, a
// page link, a task's short id). One field: type to find, paste to pin.
import { useMemo, useRef, useState } from "react";
import { Pin, Plus, Sheet, SquareKanban } from "lucide-react";
import { toast } from "sonner";
import { parseStagePinRef } from "@codecast/shared/contracts/stagePins";
import type { ArtifactType } from "@codecast/shared/artifacts";
import { useInboxStore } from "../../store/inboxStore";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { usePressOutside } from "../../hooks/usePressOutside";
import { createLiveArtifact, type WorkspaceStamp } from "../../lib/createLiveArtifact";
import { DocTypeMark } from "../docs/DocTypeMark";
import type { StagePinRow } from "../../hooks/useStagePins";

type DocItem = { _id: string; title?: string; display_title?: string; doc_type?: string; updated_at?: number; archived_at?: number };

const docSig = (d: DocItem) => `${d.title ?? ""}|${d.doc_type ?? ""}|${d.updated_at ?? 0}|${d.archived_at ?? 0}`;
const MAX_ROWS = 7;
// A role's charter and brief and a decision's body are records, not things a
// room works on together: the list leaves them out (a pasted link still pins them).
const NOT_FOR_THE_STAGE = new Set(["charter", "brief", "decision"]);

/** Typed text that names a thing rather than searching for one. */
function pastedRef(q: string) {
  const t = q.trim();
  if (!t) return null;
  const looksLikeRef = /^(https?:\/\/|\/|doc:|a\/|#\d)/i.test(t) || /^[a-z]{1,4}-\d+$/i.test(t) || /^jx[a-z0-9]{5,}$/i.test(t);
  return looksLikeRef ? parseStagePinRef(t) : null;
}

export function StagePinPicker({ roomKey, pins, onClose }: { roomKey: string; pins: StagePinRow[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  usePressOutside(rootRef, true, onClose, { escape: true });
  const docs = useWorkspaceCollection<DocItem>("docs", docSig);
  const onStage = useMemo(() => new Set(pins.map((p) => p.ref)), [pins]);

  const q = query.trim().toLowerCase();
  const ref = pastedRef(query);
  const matches = useMemo(
    () =>
      ref
        ? []
        : docs
            .filter((d) => !d.archived_at && !NOT_FOR_THE_STAGE.has(d.doc_type ?? "") && !onStage.has(`doc:${d._id}`) && (!q || (d.display_title ?? d.title ?? "").toLowerCase().includes(q)))
            .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
            .slice(0, MAX_ROWS),
    [docs, q, ref, onStage],
  );

  const pin = (r: string) => {
    useInboxStore.getState().pinToStage(roomKey, r);
    onClose();
  };
  const pinBoard = async () => {
    setBusy("board");
    try {
      await useInboxStore.getState().pinCallBoard(roomKey);
      onClose();
    } catch (e: any) {
      toast.error(typeof e?.data === "string" ? e.data : e?.message ?? "Could not put the board up");
      setBusy(null);
    }
  };
  const createAndPin = async (type: ArtifactType) => {
    setBusy(`${type}-new`);
    const team = (useInboxStore.getState() as any).clientState?.ui?.active_team_id as string | undefined;
    const stamp: WorkspaceStamp = team ? { workspace: "team", team_id: team } : { workspace: "personal" };
    const id = await createLiveArtifact(type, stamp, () => {});
    setBusy(null);
    if (id) pin(`doc:${id}`);
  };

  const pick = (i: number) => {
    if (ref) return pin(ref.ref);
    const d = matches[i];
    if (d) pin(`doc:${d._id}`);
  };

  return (
    <div
      ref={rootRef}
      className="absolute right-0 top-full z-20 mt-1.5 w-[340px] overflow-hidden rounded-xl bg-sol-bg-alt shadow-2xl ring-1 ring-white/[0.08]"
      role="dialog"
      aria-label="Pin to the stage"
    >
      <div className="grid grid-cols-3 gap-1 border-b border-white/[0.06] p-1.5">
        <QuickButton icon={<SquareKanban className="h-4 w-4 text-sol-cyan" />} label="Call board" busy={busy === "board"} onClick={pinBoard} />
        <QuickButton icon={<Plus className="h-4 w-4 text-sol-text-muted" />} label="New board" busy={busy === "board-new"} onClick={() => void createAndPin("board")} />
        <QuickButton icon={<Sheet className="h-4 w-4 text-sol-green" />} label="New sheet" busy={busy === "sheet-new"} onClick={() => void createAndPin("sheet")} />
      </div>
      <div className="p-1.5">
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, Math.max(matches.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(cursor);
            }
          }}
          placeholder="Find a doc, or paste a link or id"
          className="h-8 w-full rounded-md bg-white/[0.05] px-2.5 text-[13px] text-sol-text outline-none ring-1 ring-white/[0.06] placeholder:text-sol-text-dim focus:ring-sol-cyan/50"
          style={{ fontVariantLigatures: "none" }}
        />
        <div className="mt-1 max-h-[280px] overflow-y-auto">
          {ref ? (
            <button
              type="button"
              onClick={() => pin(ref.ref)}
              className="flex w-full items-center gap-2 rounded-md bg-sol-cyan/10 px-2 py-1.5 text-left"
            >
              <Pin className="h-3.5 w-3.5 shrink-0 text-sol-cyan" />
              <span className="min-w-0 flex-1 truncate font-mono text-meta text-sol-text">{ref.ref}</span>
              <span className="shrink-0 text-meta text-sol-text-muted">{ref.kind === "page" ? "page" : ref.kind === "doc" ? "doc" : "object"}</span>
            </button>
          ) : matches.length === 0 ? (
            <div className="px-2 py-3 text-center text-meta text-sol-text-dim">{q ? `No doc matches "${query.trim()}"` : "No docs yet"}</div>
          ) : (
            matches.map((d, i) => (
              <button
                key={d._id}
                type="button"
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(i)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${i === cursor ? "bg-white/[0.07]" : ""}`}
              >
                <DocTypeMark type={d.doc_type ?? "note"} size={14} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-sol-text">{d.display_title ?? d.title ?? "Untitled"}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function QuickButton({ icon, label, busy, onClick }: { icon: React.ReactNode; label: string; busy?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex flex-col items-center gap-1 rounded-lg px-2 py-2 font-mono text-meta text-sol-text-muted transition-colors hover:bg-white/[0.06] hover:text-sol-text disabled:opacity-50"
    >
      {icon}
      {busy ? "…" : label}
    </button>
  );
}

/** The stage's header control: what is pinned, and the way to pin more. */
export function StagePinButton({ roomKey, pins, className }: { roomKey: string; pins: StagePinRow[]; className: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`${className} ${open ? "bg-sol-cyan/10 text-sol-cyan" : "text-sol-text-muted hover:bg-white/[0.06] hover:text-sol-text"}`}
        title="Pin a board, doc, sheet or page to the stage for everyone in the call"
        aria-label="Pin to the stage"
        aria-expanded={open}
      >
        <Pin className="h-3.5 w-3.5" />
        <span className="stage-word">pin</span>
        {pins.length > 0 && <span className="font-mono text-meta text-sol-text-dim">{pins.length}</span>}
      </button>
      {open && <StagePinPicker roomKey={roomKey} pins={pins} onClose={() => setOpen(false)} />}
    </span>
  );
}
