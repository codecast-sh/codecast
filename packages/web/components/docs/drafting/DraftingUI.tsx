import { useRef, useState, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import { Bot, FlaskConical, Loader2, PanelRight, X } from "lucide-react";
import {
  LAB_FLAGS,
  LAB_TRIMS,
  TRIM_REASON,
  fullAltList,
  normalizeAlts,
  wordCount,
  type AltOption,
  type TrimLevel,
} from "@codecast/shared/docs";
import { KeyCap } from "../../KeyboardShortcutsHelp";
import { isMac } from "../../../shortcuts";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { ContextMenu, CtxItem, CtxSeparator, useContextMenu } from "../../ui/context-menu";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import {
  addAlternativesAt,
  altRangeAt,
  clearFlags,
  cutRanges,
  cycleAlternativeAt,
  draftingState,
  ghostRanges,
  pickAlternativeAt,
  removeAlternativeAt,
  reviveAll,
  reviveAt,
  scopeOf,
  scopeRange,
  setDraftingFocus,
  stashSelection,
  toggleGhost,
  wordsWithout,
  type AltScope,
  type Range,
} from "../../editor/DraftingExtension";
import type { Drafting } from "./useDrafting";

// The doc page's drafting surfaces, after Jason Fried's Write_On: a quiet
// toggle that turns on the affordances, the alternatives panel on the left,
// the Overflow on the right, the Lab under its button, and the right-click
// menu. Every change goes through the editor (DraftingExtension), so it is
// collaborative, undoable and saved as the doc's own markup.

const MOD = isMac ? "⌘" : "Ctrl";
const SHIFT = isMac ? "⇧" : "Shift";

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-[3px]">
      {keys.map((k, i) => (
        <KeyCap key={i} size="xs">{k}</KeyCap>
      ))}
    </span>
  );
}

/** Re-render on every editor transaction (selection moves included). */
function useEditorTick(editor: Editor | null): number {
  const counter = useRef(0);
  return useSyncExternalStore(
    (notify) => {
      if (!editor) return () => {};
      const on = () => {
        counter.current++;
        notify();
      };
      editor.on("transaction", on);
      return () => {
        editor.off("transaction", on);
      };
    },
    () => counter.current,
    () => 0,
  );
}

function quoteLabel(text: string): string {
  const t = text.trim();
  if (!t) return "selection";
  if (/\s/.test(t) || t.length > 22) return "selection";
  return `“${t}”`;
}

// ── Header controls ─────────────────────────────────────────────────

function DotsGlyph({ on }: { on: boolean }) {
  return (
    <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden>
      <circle cx="3" cy="4" r="2.4" fill="currentColor" />
      <circle cx="9" cy="4" r="2.4" fill="currentColor" opacity={on ? 1 : 0.55} />
      <circle cx="15" cy="4" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

/** Word count, the drafting toggle, the Lab and the Overflow, for the doc page's title bar. */
export function DraftingControls({ d, overflowEnabled }: { d: Drafting; overflowEnabled: boolean }) {
  useEditorTick(d.editor);
  const editor = d.editor;
  let words = 0;
  let selected = 0;
  if (editor && !editor.isDestroyed) {
    words = wordsWithout(editor.state);
    const { from, to, empty } = editor.state.selection;
    if (!empty) selected = wordCount(editor.state.doc.textBetween(from, to, " "));
  }
  const overflowLines = d.overflow.trim() ? d.overflow.trim().split(/\n\s*\n/).length : 0;
  return (
    <div className="flex items-center gap-1 mr-1">
      <button
        onClick={() => d.setEnabled(!d.enabled)}
        className="px-1.5 py-1 text-[11px] tabular-nums text-sol-text-dim hover:text-sol-text-muted transition-colors"
        title="Turn drafting on or off"
      >
        {selected ? `${selected} of ${words} words` : `${words} words`}
      </button>
      <button
        onClick={() => d.setEnabled(!d.enabled)}
        className={`draft-toggle p-1.5 rounded-md transition-colors ${d.enabled ? "draft-toggle--on" : "text-sol-text-dim hover:text-sol-text"}`}
        title={d.enabled ? "Drafting on: alternatives, ghosts and Lab marks show" : "Drafting: alternatives, ghosts and the Lab"}
        aria-pressed={d.enabled}
      >
        <DotsGlyph on={d.enabled} />
      </button>
      <LabMenu d={d} />
      {overflowEnabled && (
        <button
          onClick={() => d.setOverflowOpen(!d.overflowOpen)}
          className={`p-1.5 rounded-md text-xs flex items-center gap-1 transition-colors ${d.overflowOpen ? "draft-accent" : "text-sol-text-dim hover:text-sol-text"}`}
          title="Overflow: writing kept beside the doc"
        >
          <PanelRight className="w-3.5 h-3.5" />
          {overflowLines > 0 && <span className="tabular-nums text-[10px]">{overflowLines}</span>}
        </button>
      )}
    </div>
  );
}

// ── The Lab ─────────────────────────────────────────────────────────

function LabMenu({ d }: { d: Drafting }) {
  const [open, setOpen] = useState(false);
  useEditorTick(d.editor);
  const editor = d.editor;
  const hasFlags = !!editor && !editor.isDestroyed && editor.view.dom.querySelector("span[data-flag]") !== null;
  const hasTrim = !!editor && !editor.isDestroyed && ghostRanges(editor.state, TRIM_REASON).length > 0;
  const running = d.labRun;

  const runTrim = async (level: TrimLevel, label: string) => {
    if (!editor) return;
    setOpen(false);
    d.setEnabled(true);
    // The length as the writer has it now: earlier proposals still count.
    const before = wordsWithout(editor.state);
    const result = await d.lab({ tool: "trim", level }, label);
    if (!result || result.tool !== "trim" || editor.isDestroyed) return;
    const after = wordsWithout(editor.state, TRIM_REASON);
    d.setTrim({ level, label, before, after, applied: ghostRanges(editor.state, TRIM_REASON).length });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={`draft-lab-button px-2 py-[3px] mx-0.5 text-[10px] tracking-[0.14em] rounded-md border border-dashed transition-colors ${
            running ? "draft-accent" : "text-sol-text-dim hover:text-sol-text"
          }`}
          title="The Lab: marks and trims that never rewrite your words"
        >
          {running ? <Loader2 className="w-3 h-3 animate-spin inline" /> : "LAB"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="draft-lab w-[420px] p-1.5">
        <div className="px-2.5 pt-1.5 pb-2 text-[11px] text-sol-text-dim">
          Marks and trims. Nothing here rewrites you: findings mark the text, trims fade what could go.
        </div>
        <LabItem disabled={!!running} onClick={() => { setOpen(false); d.setEnabled(true); void d.lab({ tool: "typos" }, "Typos"); }}>
          Fix punctuation and typos
          <span className="ml-auto text-[10px] text-sol-text-dim">as versions you can flip back</span>
        </LabItem>
        {LAB_FLAGS.map((f) => (
          <LabItem key={f.flag} disabled={!!running} onClick={() => { setOpen(false); d.setEnabled(true); void d.lab({ tool: "flag", flag: f.flag }, f.label); }}>
            {f.label}
          </LabItem>
        ))}
        {hasFlags && (
          <LabItem onClick={() => { if (editor) clearFlags(editor.view); setOpen(false); }}>
            <span className="text-sol-text-dim">Clear the marks</span>
          </LabItem>
        )}
        <div className="grid grid-cols-5 gap-1 mt-2 p-1 border-t border-sol-border/30 pt-2">
          <TrimButton
            label="Original"
            sub={hasTrim ? "undo trim" : ""}
            active={!hasTrim}
            onClick={() => { if (editor) reviveAll(editor.view, TRIM_REASON); d.setTrim(null); setOpen(false); }}
          />
          {LAB_TRIMS.map((t) => (
            <TrimButton
              key={t.level}
              label={t.label}
              sub={`−${t.pct}%`}
              active={d.trim?.level === t.level && hasTrim}
              disabled={!!running}
              onClick={() => void runTrim(t.level, t.label)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LabItem({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="w-full flex items-center gap-2 text-left text-[13px] px-2.5 py-1.5 rounded-lg text-sol-text-secondary hover:bg-sol-cyan/10 hover:text-sol-text disabled:opacity-40 transition-colors"
    >
      {children}
    </button>
  );
}

function TrimButton({ label, sub, active, disabled, onClick }: { label: string; sub: string; active: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`flex flex-col items-center justify-center rounded-lg px-1 py-1.5 border text-[11px] leading-tight transition-colors disabled:opacity-40 ${
        active ? "draft-trim--on" : "border-sol-border/40 text-sol-text-muted hover:text-sol-text hover:border-sol-border"
      }`}
    >
      <span>{label}</span>
      <span className="text-[9px] text-sol-text-dim h-3">{sub}</span>
    </button>
  );
}

/** After a trim: what it proposes, and the three ways out (cut, walk, done). */
export function TrimBar({ d }: { d: Drafting }) {
  useEditorTick(d.editor);
  const [walk, setWalk] = useState<number | null>(null);
  const editor = d.editor;
  if (!d.trim || !editor || editor.isDestroyed) return null;
  const ranges = ghostRanges(editor.state, TRIM_REASON);
  const after = wordsWithout(editor.state, TRIM_REASON);
  const before = d.trim.before;
  const pct = before ? Math.round(((after - before) / before) * 100) : 0;
  const close = () => { setWalk(null); d.setTrim(null); };
  if (!ranges.length) {
    return (
      <div className="draft-trimbar">
        <span className="font-semibold text-sol-text whitespace-nowrap">{d.trim.label}</span>
        <span className="text-sol-text-dim">Nothing left to cut.</span>
        <button className="draft-chip" onClick={close}>Done</button>
      </div>
    );
  }
  const step = walk === null ? null : Math.min(walk, ranges.length - 1);
  const show = (i: number) => {
    const r = ranges[i];
    if (!r) return;
    editor.chain().setTextSelection(r).scrollIntoView().run();
    setWalk(i);
  };
  return (
    <div className="draft-trimbar">
      <div className="flex items-baseline gap-2 shrink-0 whitespace-nowrap">
        <span className="font-semibold text-sol-text">{d.trim.label}</span>
        <span className="draft-accent tabular-nums">
          {before} → {after} words · {pct < 0 ? `−${-pct}` : pct}%
        </span>
      </div>
      {step === null ? (
        <>
          <span className="text-sol-text-dim truncate">Faded words would go. Click one to keep it.</span>
          <div className="flex gap-1.5 ml-auto">
            <button className="draft-chip" onClick={() => { cutRanges(editor.view, ranges); close(); }}>Make the cuts</button>
            <button className="draft-chip" onClick={() => show(0)}>Walk through</button>
            <button className="draft-chip" onClick={close}>Done</button>
          </div>
        </>
      ) : (
        <>
          <span className="text-sol-text-dim tabular-nums">Cut {step + 1} of {ranges.length}</span>
          <div className="flex gap-1.5 ml-auto">
            <button className="draft-chip" onClick={() => { reviveAt(editor.view, ranges[step].from); show(step); }}>Keep</button>
            <button className="draft-chip" onClick={() => { cutRanges(editor.view, [ranges[step]]); requestAnimationFrame(() => show(step)); }}>Cut</button>
            <button className="draft-chip" onClick={() => show((step + 1) % ranges.length)}>Next</button>
            <button className="draft-chip" onClick={() => setWalk(null)}>Stop</button>
          </div>
        </>
      )}
    </div>
  );
}

// ── The alternatives panel ──────────────────────────────────────────

const SCOPES: Array<{ scope: AltScope; label: string }> = [
  { scope: "word", label: "Word" },
  { scope: "sentence", label: "Sentence" },
  { scope: "paragraph", label: "Paragraph" },
];

export function AlternativesPanel({ d }: { d: Drafting }) {
  useEditorTick(d.editor);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editor = d.editor;
  const focus = editor && !editor.isDestroyed ? draftingState(editor.state)?.focus ?? null : null;

  useWatchEffect(() => {
    if (d.panelOpen) requestAnimationFrame(() => inputRef.current?.focus());
  }, [d.panelOpen]);

  if (!d.panelOpen || !editor || editor.isDestroyed) return null;
  if (!focus) {
    return (
      <aside className="draft-panel draft-panel--left">
        <div className="text-[12px] text-sol-text-dim">Select a word, sentence or paragraph to try other versions of it.</div>
        <PanelFooter onClose={d.closeAlternatives} />
      </aside>
    );
  }
  const { state, view } = editor;
  const run = altRangeAt(state, focus.from);
  const exact = run && run.from === focus.from && run.to === focus.to ? run : null;
  const shown = state.doc.textBetween(focus.from, focus.to, " ");
  const list: AltOption[] = exact
    ? fullAltList({ alts: normalizeAlts(exact.mark.attrs.alts), at: exact.mark.attrs.at, ai: exact.mark.attrs.ai }, exact.text)
    : [{ t: shown }];
  const at = exact ? Math.min(exact.mark.attrs.at ?? 0, list.length - 1) : 0;
  const scope = scopeOf(state, focus);
  const aiRunning = d.labRun?.kind === "alternatives";

  const switchScope = (next: AltScope) => {
    const r = scopeRange(state, focus.from, next);
    if (!r) return;
    const existing = altRangeAt(state, r.from);
    setDraftingFocus(editor, existing && existing.from <= r.from && existing.to >= r.to ? { from: existing.from, to: existing.to } : r);
  };

  const add = () => {
    const t = draft.trim();
    if (!t) return;
    addAlternativesAt(view, focus, [t], { show: true });
    setDraft("");
  };

  return (
    <aside className="draft-panel draft-panel--left" onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== "INPUT") e.preventDefault(); }}>
      <div className="flex items-baseline gap-3 mb-3">
        {SCOPES.map((s) => (
          <button
            key={s.scope}
            onClick={() => switchScope(s.scope)}
            className={`draft-scope ${s.scope === scope ? "draft-scope--on" : ""}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <ul className="flex flex-col gap-0.5">
        {list.map((opt, i) => (
          <li key={`${i}:${opt.t}`} className="group flex items-start gap-2">
            <span className="w-3 shrink-0 h-[22px] flex items-center justify-center" title={opt.ai ? "Written by AI" : i === 0 ? "Original" : "Yours"}>
              {opt.ai ? (
                <Bot className={`w-3 h-3 ${i === at ? "draft-accent" : "text-sol-text-dim"}`} />
              ) : (
                <span className={`block rounded-full ${i === at ? "w-[6px] h-[6px] draft-accent-bg" : "w-[4px] h-[4px] bg-sol-text-dim/60"}`} />
              )}
            </span>
            <button
              onClick={() => exact && pickAlternativeAt(view, focus.from, i)}
              className={`flex-1 text-left text-[13px] leading-snug py-0.5 rounded transition-colors ${
                i === at ? "text-sol-text" : "text-sol-text-muted hover:text-sol-text"
              }`}
            >
              {opt.t}
            </button>
            {exact && i !== at && (
              <button
                onClick={() => removeAlternativeAt(view, focus.from, i)}
                className="opacity-0 group-hover:opacity-100 p-0.5 text-sol-text-dim hover:text-sol-text transition-opacity"
                title="Drop this version"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </li>
        ))}
        {aiRunning && (
          <li className="flex items-center gap-2 text-[12px] text-sol-text-dim pl-5 py-1">
            <Loader2 className="w-3 h-3 animate-spin" /> thinking of versions…
          </li>
        )}
      </ul>
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); add(); }
          else if (e.key === "Escape") { e.preventDefault(); d.closeAlternatives(); }
          else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !draft) {
            e.preventDefault();
            cycleAlternativeAt(view, focus.from, e.key === "ArrowUp" ? -1 : 1);
          }
        }}
        placeholder={list.length > 1 ? "Another version…" : `Another way to say it…`}
        className="draft-input mt-2"
      />
      <button
        disabled={aiRunning}
        onClick={() => d.aiAlternatives(focus)}
        className="mt-2 self-start flex items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-text disabled:opacity-40 transition-colors"
      >
        <Bot className="w-3 h-3" /> Suggest versions <Keys keys={[MOD, SHIFT, "G"]} />
      </button>
      <PanelFooter onClose={d.closeAlternatives} />
    </aside>
  );
}

function PanelFooter({ onClose }: { onClose: () => void }) {
  return (
    <div className="mt-auto pt-6 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10px] text-sol-text-dim">
      <span className="flex items-center gap-1 whitespace-nowrap"><KeyCap size="xs">↵</KeyCap> adds</span>
      <span className="flex items-center gap-1 whitespace-nowrap"><KeyCap size="xs">↑</KeyCap><KeyCap size="xs">↓</KeyCap> flips</span>
      <button onClick={onClose} className="flex items-center gap-1 whitespace-nowrap hover:text-sol-text"><KeyCap size="xs">esc</KeyCap> closes</button>
    </div>
  );
}

// ── The Overflow ────────────────────────────────────────────────────

export function OverflowPanel({ d }: { d: Drafting }) {
  const [local, setLocal] = useState(d.overflow);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Follow the stored text (another tab, `cast doc overflow`) while the writer
  // is not typing here; their keystrokes win while the field has focus.
  useWatchEffect(() => {
    if (!focused.current) setLocal(d.overflow);
  }, [d.overflow]);

  const commit = (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (text !== d.overflow) d.setOverflow(text);
  };
  const change = (text: string) => {
    setLocal(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(text), 500);
  };

  // Mod+Enter moves the selected text (or the paragraph at the caret) into the
  // doc at the editor's own selection.
  const useInDoc = () => {
    const el = ref.current;
    const editor = d.editor;
    if (!el || !editor || editor.isDestroyed) return;
    let { selectionStart: a, selectionEnd: b } = el;
    if (a === b) {
      const before = local.lastIndexOf("\n\n", a - 1);
      const after = local.indexOf("\n\n", a);
      a = before < 0 ? 0 : before + 2;
      b = after < 0 ? local.length : after;
    }
    const text = local.slice(a, b).trim();
    if (!text) return;
    const paragraphs = text.split(/\n\s*\n/).map((p) => ({ type: "paragraph", content: [{ type: "text", text: p.replace(/\n/g, " ") }] }));
    editor.chain().focus().insertContent(paragraphs).run();
    const rest = (local.slice(0, a) + local.slice(b)).replace(/\n{3,}/g, "\n\n").trim();
    setLocal(rest);
    commit(rest);
  };

  if (!d.overflowOpen) return null;
  return (
    <aside className="draft-panel draft-panel--right">
      <div className="flex items-center mb-3">
        <span className="draft-scope draft-scope--on">Overflow</span>
        <button onClick={() => d.setOverflowOpen(false)} className="ml-auto p-0.5 text-sol-text-dim hover:text-sol-text" title="Close">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <textarea
        ref={ref}
        value={local}
        onChange={(e) => change(e.target.value)}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; commit(local); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); useInDoc(); }
          if (e.key === "Escape") { e.preventDefault(); d.setOverflowOpen(false); d.editor?.commands.focus(); }
        }}
        placeholder={"Writing you want nearby but not in the doc: cuts, notes, words you like, an outline."}
        className="draft-overflow flex-1"
        spellCheck
      />
      <div className="pt-3 flex flex-wrap items-center gap-1.5 text-[10px] text-sol-text-dim">
        <Keys keys={[MOD, "↵"]} /> <span>or drag into the page to use</span>
      </div>
    </aside>
  );
}

// ── Right-click ─────────────────────────────────────────────────────

type MenuPayload = { range: Range; ghosted: boolean; hasSelection: boolean };

/**
 * The editor's right-click menu: alternatives, AI alternatives, ghost or
 * revive, stash. With drafting on it answers every right-click (on the word
 * under the pointer when nothing is selected); off, only a selection.
 * Shift+right-click keeps the browser's own menu.
 */
export function useDraftingMenu(d: Drafting, overflowEnabled: boolean) {
  const menu = useContextMenu<MenuPayload>();
  const onContextMenu = (e: React.MouseEvent) => {
    const editor = d.editor;
    if (!editor || editor.isDestroyed || e.shiftKey) return;
    const { state, view } = editor;
    const hasSelection = !state.selection.empty;
    let range: Range | null = null;
    if (hasSelection) range = { from: state.selection.from, to: state.selection.to };
    else if (d.enabled || (e.target as HTMLElement).closest("span[data-ghost], span[data-alts]")) {
      const pos = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos;
      if (pos != null) {
        const run = altRangeAt(state, pos);
        range = run ? { from: run.from, to: run.to } : scopeRange(state, pos, "word");
      }
    }
    if (!range) return;
    const ghostType = state.schema.marks.draftGhost;
    const ghosted = !!ghostType && (state.doc.rangeHasMark(range.from, range.to, ghostType) || !!(e.target as HTMLElement).closest("span[data-ghost]"));
    menu.open(e, { range, ghosted, hasSelection }, { force: true });
  };

  const element = (
    <ContextMenu state={menu}>
      {(p) => {
        const editor = d.editor;
        if (!editor || editor.isDestroyed) return null;
        const label = quoteLabel(editor.state.doc.textBetween(p.range.from, p.range.to, " "));
        return (
          <>
            <CtxItem onSelect={() => d.openAlternatives(p.range)} trailing={<Keys keys={[MOD, SHIFT, "O"]} />}>
              Alternatives for {label}
            </CtxItem>
            <CtxItem onSelect={() => d.aiAlternatives(p.range)} trailing={<Keys keys={[MOD, SHIFT, "G"]} />}>
              AI alternatives for {label}
            </CtxItem>
            <CtxSeparator />
            <CtxItem
              onSelect={() => {
                if (p.ghosted && !p.hasSelection) reviveAt(editor.view, p.range.from);
                else {
                  editor.chain().setTextSelection(p.range).run();
                  toggleGhost(editor.view);
                }
              }}
              trailing={<Keys keys={[MOD, SHIFT, "."]} />}
            >
              {p.ghosted ? "Revive it" : "Ghost it"}
            </CtxItem>
            {overflowEnabled && (
              <CtxItem
                onSelect={() => {
                  editor.chain().setTextSelection(p.range).run();
                  stashSelection(editor.view, d.stash);
                }}
                trailing={<Keys keys={[MOD, SHIFT, "X"]} />}
              >
                Stash this in Overflow
              </CtxItem>
            )}
          </>
        );
      }}
    </ContextMenu>
  );
  return { onContextMenu, element };
}

