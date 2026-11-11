// The side panel that edits one memory, creates a new one, or edits MEMORY.md.
//
// The draft is the whole file as text; the name, description and type fields
// patch its frontmatter in place (writeMemoryField), so keys the editor doesn't
// own survive byte for byte. A save names the version it opened, and a newer
// file on disk (another session saving the same memory) comes back as a
// conflict for the person to settle instead of being overwritten.

import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type MutableRefObject } from "react";
import { toast } from "sonner";
import { Trash2, X } from "lucide-react";
import {
  MEMORY_FILE_RE,
  MEMORY_INDEX_FILE,
  MEMORY_TYPES,
  memoryFileFor,
  memoryIndexBudget,
  newMemoryRaw,
  readMemoryFields,
  splitFrontmatter,
  joinFrontmatter,
  writeMemoryField,
  type MemoryAtlas,
  type MemoryFields,
} from "@codecast/shared/memory";
import { formatRelative } from "@codecast/shared/time";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { isMac } from "../../shortcuts";
import { MemoryConflict, useMemoryStore } from "../../store/memoryStore";
import { TYPE_TONE, formatBytes, toneCss, typeKey } from "./memoryView";
import { BudgetMeter, MemoryLinkChip, ReachBadge } from "./parts";
import { Button } from "../ui/button";
import { modernChip } from "../ui/modernLook";

export const NEW_MEMORY = "__new__";
type BodyMode = "edit" | "preview" | "raw";

interface Disk {
  raw: string;
  mtime: number | null;
}

/** Set by the open editor while it holds unsaved edits: the page hands it every way out (close, Esc, another memory,
 *  another project), and the editor asks first instead of dropping the draft. Returns true when it held the exit. */
export type MemoryLeaveGuard = MutableRefObject<((next: () => void) => boolean) | null>;

export interface MemoryEditorProps {
  atlas: MemoryAtlas;
  /** A memory's file, MEMORY.md, or NEW_MEMORY. */
  file: string;
  onOpen: (file: string) => void;
  onClose: () => void;
  onJumpToLine: (line: number) => void;
  /** Where the editor registers its unsaved-edits guard (MemoryLeaveGuard). */
  leaveGuard?: MemoryLeaveGuard;
}

const fieldClass =
  "w-full bg-sol-bg border border-sol-border/60 rounded-md px-2.5 py-1.5 text-[13px] text-sol-text placeholder:text-sol-text-dim outline-none focus:border-sol-cyan transition-colors";

export function MemoryEditor({ atlas, file, onOpen, onClose, onJumpToLine, leaveGuard }: MemoryEditorProps) {
  const isIndex = file === MEMORY_INDEX_FILE;
  const isNew = file === NEW_MEMORY;
  const note = !isIndex && !isNew ? atlas.byFile.get(file) : undefined;
  const disk: Disk | null = isIndex ? { raw: atlas.index.raw, mtime: useMemoryStore.getState().project?.index.mtime ?? null } : note ? { raw: note.raw, mtime: note.mtime } : null;

  const [base, setBase] = useState<Disk>(() => disk ?? { raw: newMemoryRaw({ name: "", description: "", type: "project" }), mtime: null });
  const [draft, setDraft] = useState(base.raw);
  const [mode, setMode] = useState<BodyMode>("edit");
  const [newFile, setNewFile] = useState({ name: "", touched: false });
  const [addToIndex, setAddToIndex] = useState(true);
  const [conflict, setConflict] = useState<MemoryConflict | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ unindex: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  // A way out the person took while the draft was unsaved: it waits on Save, Discard or Keep editing.
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const save = useMemoryStore((s) => s.save);
  const create = useMemoryStore((s) => s.create);
  const addLine = useMemoryStore((s) => s.addToIndex);
  const remove = useMemoryStore((s) => s.remove);

  const dirty = draft !== base.raw;
  // Another session rewrote the file while it sat here unedited: follow it.
  const diskKey = disk ? `${disk.mtime}` : "";
  useWatchEffect(() => {
    if (!disk || disk.mtime === base.mtime || saving) return;
    if (!dirty) {
      setBase(disk);
      setDraft(disk.raw);
    }
  }, [diskKey]);

  // While the draft is unsaved, every exit the page offers comes here first.
  useWatchEffect(() => {
    if (!leaveGuard) return;
    leaveGuard.current = dirty ? (next) => { setLeaving(() => next); return true; } : null;
    return () => { leaveGuard.current = null; };
  }, [dirty, leaveGuard]);
  /** Leave on the editor's own account (after a create or a delete): nothing is lost, so the guard stands down. */
  const leave = (go: () => void) => {
    if (leaveGuard) leaveGuard.current = null;
    go();
  };

  const fields: MemoryFields = useMemo(() => readMemoryFields(draft), [draft]);
  const body = useMemo(() => splitFrontmatter(draft).body, [draft]);
  const fileName = isNew ? (newFile.touched ? newFile.name : fields.name ? memoryFileFor(fields.name) : "") : file;

  const setField = (key: keyof MemoryFields, value: string) => setDraft((d) => writeMemoryField(d, key, value));

  /** Save the draft; true once it is on disk. `then`: where to go after (an exit that waited on the save). */
  const doSave = async (overwrite?: MemoryConflict, then?: () => void): Promise<boolean> => {
    if (saving) return false;
    if (!isIndex && !fields.name.trim()) {
      toast.error("Give the memory a name first");
      return false;
    }
    if (isNew && !MEMORY_FILE_RE.test(fileName)) {
      toast.error("The file name must end in .md and use letters, digits, - or _");
      return false;
    }
    setSaving(true);
    try {
      if (isNew) {
        await create(fileName, draft, { index: addToIndex });
        toast.success(`Created ${fileName}`);
        leave(then ?? (() => onOpen(fileName)));
      } else {
        const mtime = await save(file, draft, overwrite ? overwrite.mtime : base.mtime);
        setBase({ raw: draft, mtime });
        setConflict(null);
        if (then) leave(then);
      }
      return true;
    } catch (e) {
      if (e instanceof MemoryConflict) setConflict(e);
      else toast.error(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return setConfirmDelete({ unindex: true });
    try {
      const trashed = await remove(file, { unindex: confirmDelete.unindex });
      toast.success(`Moved ${file} to the trash`, { description: trashed.replace(/^\/Users\/[^/]+/, "~") });
      leave(onClose);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void doSave();
    }
  };

  // [[links]] in the preview open the memory they name.
  const previewMarkdown = useMemo(
    () => body.replace(/\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]/g, (_m, name: string) => `[${name}](#memory:${encodeURIComponent(name)})`),
    [body],
  );
  const onPreviewClick = (e: MouseEvent) => {
    const href = (e.target as HTMLElement).closest("a")?.getAttribute("href") ?? "";
    const target = href.startsWith("#memory:") ? decodeURIComponent(href.slice(8)) : href.endsWith(".md") && !/^[a-z]+:/i.test(href) ? href : null;
    if (target === null) return;
    e.preventDefault();
    const resolved = atlas.resolve(target);
    if (resolved) onOpen(resolved);
    else toast("No memory by that name yet");
  };

  const title = isIndex ? MEMORY_INDEX_FILE : fields.name || (isNew ? "New memory" : file);
  // The footer's state word, the same in its plain row and in the unsaved-exit bar.
  const status = (text: string, warn: boolean) => <span className={`flex-1 text-meta ${warn ? "text-sol-orange" : "text-sol-text-dim"}`} role="status">{text}</span>;
  const typeChoices = [...new Set([...MEMORY_TYPES, fields.type].filter(Boolean))];

  return (
    <div ref={rootRef} onKeyDown={onKeyDown} className="h-full flex flex-col bg-sol-bg-alt/40 border-l border-sol-border/40 min-w-0">
      <header className="flex items-start gap-3 px-4 pt-3 pb-2.5 border-b border-sol-border/40">
        <div className="flex-1 min-w-0">
          <div className="font-mono text-meta text-sol-text-dim truncate">{isNew ? fileName || "new file" : file}</div>
          <h2 className="text-base font-semibold text-sol-text break-words leading-snug">{title}</h2>
          <div className="flex flex-wrap items-center gap-2 mt-1 text-meta text-sol-text-dim">
            {note && (
              <>
                <ReachBadge reach={note.reach} />
                <span>{formatBytes(note.bytes)}</span>
                <span>changed {formatRelative(note.mtime)}</span>
              </>
            )}
            {isIndex && <span>The index Claude Code loads at the start of every session in this project</span>}
          </div>
        </div>
        <button type="button" onClick={onClose} title="Close" aria-label="Close" className="text-sol-text-dim hover:text-sol-text transition-colors p-1">
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-3.5 [&>*]:shrink-0">
        {conflict && (
          <div className="rounded-md border border-sol-orange/60 bg-sol-orange/10 px-3 py-2 text-xs text-sol-text flex flex-col gap-2">
            <div>{conflict.current === null ? "This file was deleted on disk since you opened it." : "This file changed on disk since you opened it, probably from another session."}</div>
            <div className="flex gap-2">
              {conflict.current !== null && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setBase({ raw: conflict.current!, mtime: conflict.mtime });
                    setDraft(conflict.current!);
                    setConflict(null);
                  }}
                >
                  Use the disk version
                </Button>
              )}
              <Button type="button" variant="amber" size="xs" onClick={() => void doSave(conflict)}>
                {conflict.current === null ? "Write it back" : "Overwrite with mine"}
              </Button>
            </div>
          </div>
        )}

        {isIndex ? (
          <>
            <BudgetMeter budget={memoryIndexBudget(draft)} />
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} className={`${fieldClass} font-mono text-xs leading-relaxed min-h-[60vh] resize-y`} />
          </>
        ) : (
          <>
            {isNew && (
              <label className="block">
                <span className="block text-meta text-sol-text-dim mb-1">File</span>
                <input
                  value={fileName}
                  onChange={(e) => setNewFile({ name: e.target.value.trim(), touched: true })}
                  placeholder="derived from the name"
                  spellCheck={false}
                  className={`${fieldClass} font-mono text-xs`}
                />
              </label>
            )}
            <label className="block">
              <span className="block text-meta text-sol-text-dim mb-1">Name</span>
              <input value={fields.name} onChange={(e) => setField("name", e.target.value)} placeholder="short-kebab-case-slug" spellCheck={false} autoFocus={isNew} className={fieldClass} />
            </label>
            <label className="block">
              <span className="flex justify-between text-meta text-sol-text-dim mb-1">
                <span>Description</span>
                <span className={!fields.description || fields.description.length > 220 ? "text-sol-orange" : ""}>
                  {fields.description ? `${fields.description.length} characters` : "Recall reads this line first"}
                </span>
              </span>
              <textarea value={fields.description} onChange={(e) => setField("description", e.target.value.replace(/\n/g, " "))} rows={2} className={`${fieldClass} resize-y`} />
            </label>
            <div>
              <span className="block text-meta text-sol-text-dim mb-1">Type</span>
              <div className="flex flex-wrap gap-1.5">
                {typeChoices.map((t) => {
                  const on = t === fields.type;
                  const color = toneCss(TYPE_TONE[typeKey(t)]);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setField("type", t)}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${on ? "text-sol-text" : "text-sol-text-muted border-sol-border/50 hover:text-sol-text"} ${modernChip({ active: on })}`}
                      style={on ? { borderColor: color, background: `color-mix(in srgb, ${color} 14%, transparent)` } : undefined}
                    >
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-col">
              <div className="flex items-center justify-between mb-1">
                <span className="text-meta text-sol-text-dim">Body</span>
                <div className="flex rounded-md border border-sol-border/50 overflow-hidden text-meta">
                  {(["edit", "preview", "raw"] as const).map((m) => (
                    <button key={m} type="button" onClick={() => setMode(m)} className={`px-2 py-0.5 transition-colors ${mode === m ? "bg-sol-cyan text-sol-bg" : "text-sol-text-muted hover:text-sol-text"}`}>
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              {mode === "edit" && (
                <textarea
                  value={body}
                  onChange={(e) => setDraft((d) => joinFrontmatter(splitFrontmatter(d).fm, e.target.value))}
                  spellCheck={false}
                  placeholder="The fact. For feedback and project memories, follow with Why: and How to apply: lines. Link related memories with [[name]]."
                  className={`${fieldClass} font-mono text-xs leading-relaxed min-h-[280px] resize-y`}
                />
              )}
              {mode === "raw" && (
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} className={`${fieldClass} font-mono text-xs leading-relaxed min-h-[360px] resize-y`} />
              )}
              {mode === "preview" && (
                <div onClickCapture={onPreviewClick} className="rounded-md border border-sol-border/40 bg-sol-bg px-3 py-1 min-h-[280px]">
                  <MarkdownRenderer content={previewMarkdown} />
                </div>
              )}
            </div>

            {isNew && (
              <label className="flex items-center gap-2 text-xs text-sol-text-muted cursor-pointer">
                <input type="checkbox" checked={addToIndex} onChange={(e) => setAddToIndex(e.target.checked)} className="accent-sol-cyan" />
                Add a line to MEMORY.md
                {addToIndex && atlas.index.budget.cutAt !== null && <span className="text-sol-orange">(it lands below the cut and won&apos;t load)</span>}
              </label>
            )}

            {note && (
              <div className="flex flex-col gap-2.5 text-xs">
                <Related label="Index">
                  {note.indexLine ? (
                    <>
                      <button type="button" onClick={() => onJumpToLine(note.indexLine!)} className="underline underline-offset-2 decoration-sol-border text-sol-text">
                        MEMORY.md line {note.indexLine}
                      </button>
                      {note.reach === "cut" && <span className="text-sol-text-dim">is below the cut at line {atlas.index.budget.cutAt}</span>}
                    </>
                  ) : (
                    <>
                      <span className="text-sol-text-dim">Not in MEMORY.md.</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => addLine(file).then(() => toast.success("Added to MEMORY.md"), (e) => toast.error(e instanceof Error ? e.message : String(e)))}
                      >
                        Add a line
                      </Button>
                    </>
                  )}
                </Related>
                <Related label={`Links out (${note.links.length})`}>
                  {note.links.length ? (
                    note.links.map((l) => (
                      <MemoryLinkChip key={l.raw} note={l.file ? atlas.byFile.get(l.file) : undefined} onOpen={onOpen}>
                        {l.file ? atlas.byFile.get(l.file)!.name : l.raw}
                      </MemoryLinkChip>
                    ))
                  ) : (
                    <span className="text-sol-text-dim">None. Link related memories with [[name]].</span>
                  )}
                </Related>
                <Related label={`Linked from (${note.inbound.length})`}>
                  {note.inbound.length ? (
                    note.inbound.map((f) => (
                      <MemoryLinkChip key={f} note={atlas.byFile.get(f)} onOpen={onOpen}>
                        {atlas.byFile.get(f)!.name}
                      </MemoryLinkChip>
                    ))
                  ) : (
                    <span className="text-sol-text-dim">Nothing links here.</span>
                  )}
                </Related>
              </div>
            )}
          </>
        )}
      </div>

      <footer className="flex items-center gap-2 px-4 py-2.5 border-t border-sol-border/40">
        {leaving ? (
          <>
            {status("Unsaved changes", true)}
            <Button type="button" variant="ghost" size="xs" onClick={() => setLeaving(null)} autoFocus>
              Keep editing
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => { const next = leaving; setLeaving(null); leave(next); }}>
              Discard
            </Button>
            <Button type="button" variant="secondary" size="xs" disabled={saving} onClick={() => { const next = leaving; void doSave(undefined, next).then((ok) => ok && setLeaving(null)); }}>
              {isNew ? "Create" : "Save"}
            </Button>
          </>
        ) : confirmDelete ? (
          <>
            <label className="flex-1 flex items-center gap-2 text-xs text-sol-text-muted cursor-pointer">
              <input type="checkbox" checked={confirmDelete.unindex} onChange={(e) => setConfirmDelete({ unindex: e.target.checked })} className="accent-sol-cyan" />
              Also remove its MEMORY.md line
            </label>
            <Button type="button" variant="ghost" size="xs" onClick={() => setConfirmDelete(null)}>
              Keep it
            </Button>
            <Button type="button" variant="red" size="xs" onClick={() => void doDelete()}>
              Move to trash
            </Button>
          </>
        ) : (
          <>
            {status(saving ? "Saving…" : dirty ? "Unsaved changes" : isNew ? "" : "Saved", dirty)}
            {note && (
              <button type="button" onClick={() => void doDelete()} title="Move to trash" aria-label="Move to trash" className="p-1.5 rounded-md text-sol-text-dim hover:text-sol-red transition-colors">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            <Button type="button" variant="secondary" size="xs" onClick={() => void doSave()} disabled={!dirty && !isNew}>
              {isNew ? "Create" : "Save"}
              <KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap>
              <KeyCap size="xs">S</KeyCap>
            </Button>
          </>
        )}
      </footer>
    </div>
  );
}

function Related({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-meta text-sol-text-dim mb-1">{label}</div>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[13px]">{children}</div>
    </div>
  );
}
