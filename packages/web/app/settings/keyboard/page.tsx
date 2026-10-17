import { useMemo, useRef, useState } from "react";
import { Keyboard, Lock, Plus, RotateCcw, Search, X } from "lucide-react";
import { useTrackedStore } from "../../../store/inboxStore";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { SettingsLinkRow, SettingsPanel, SettingsSection } from "../../../components/settings/ui";
import { KeyCap } from "../../../components/KeyCap";
import { ShortcutTooltip } from "../../../components/KeyboardShortcutsHelp";
import { claimKeys } from "../../../shortcuts/keyOwnership";
import { SHORTCUTS, formatShortcutParts, isMac, useKeyBindingsVersion, type ShortcutAction } from "../../../shortcuts/registry";
import { chordFromEvent } from "../../../shortcuts/recordChord";
import { visibleShortcutSections } from "../../../shortcuts/visibleSections";
import { useSurfaceMode } from "../../../lib/surfaces";
import { useIsDesktop } from "../../../lib/desktop";
import { takePendingRebind } from "../../../lib/keyboardSettings";
import {
  applyKeyBindings,
  comboIdentity,
  currentChords,
  findConflicts,
  reservedReason,
  resetAction,
  resolveChord,
  setActionChords,
  type KeyBindingOverride,
  type KeyConflict,
} from "@codecast/shared/contracts/keyBindings";
import { cn } from "../../../lib/utils";

/** Which chord slot is listening: one of an action's chords, or a new one. */
type Recording = { action: ShortcutAction; slot: number | "add" };
type Pending = { action: ShortcutAction; slot: number | "add"; chord: string; conflicts: KeyConflict[] };

function ChordCaps({ chord, dim }: { chord: string; dim?: boolean }) {
  const parts = formatShortcutParts({ key: resolveChord(chord, isMac), action: "ui.undo", description: "" });
  return (
    <span className={cn("flex items-center gap-[3px]", dim && "opacity-50")}>
      {parts.map((p, i) => <KeyCap key={i}>{p}</KeyCap>)}
    </span>
  );
}

/** Listens for one chord while mounted: the first key press after the
 *  modifiers is the answer. Escape alone cancels; every key is held from the
 *  app's own shortcuts meanwhile, so recording ⌘K does not open the palette. */
function useChordCapture(active: boolean, onChord: (chord: string) => void, onCancel: () => void, onError: (msg: string) => void) {
  const handlers = useRef({ onChord, onCancel, onError });
  handlers.current = { onChord, onCancel, onError };
  useWatchEffect(() => {
    if (!active) return;
    return claimKeys((e) => {
      e.preventDefault();
      if (e.repeat) return true;
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        handlers.current.onCancel();
        return true;
      }
      const r = chordFromEvent(e, isMac);
      if (!r) return true;
      if ("error" in r) handlers.current.onError(r.error);
      else handlers.current.onChord(r.chord);
      return true;
    });
  }, [active]);
}

export default function KeyboardSettingsPage() {
  useKeyBindingsVersion();
  const s = useTrackedStore([(s) => s.clientState.ui?.key_bindings]);
  const bindings: KeyBindingOverride[] = s.clientState.ui?.key_bindings ?? [];
  const mode = useSurfaceMode();
  const desktop = useIsDesktop();

  const [query, setQuery] = useState("");
  const [keyFilter, setKeyFilter] = useState<string | null>(null);
  const [findingKeys, setFindingKeys] = useState(false);
  const [changedOnly, setChangedOnly] = useState(false);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<{ action: ShortcutAction; text: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [flash, setFlash] = useState<ShortcutAction | null>(null);

  const live = useMemo(() => applyKeyBindings(SHORTCUTS, bindings, isMac), [bindings]);
  const sections = useMemo(
    () => visibleShortcutSections(mode, (when) => SHORTCUTS.filter((d) => (when === undefined ? !d.when : d.when === when))),
    [mode],
  );
  const changed = new Set(bindings.map((o) => o.action));

  const commit = (next: KeyBindingOverride[]) => s.updateClientUI({ key_bindings: next });

  const place = (action: ShortcutAction, slot: number | "add", chord: string, steal: string[] = []) => {
    const chords = currentChords(bindings, action, isMac);
    const next = slot === "add" ? [...chords, chord] : chords.map((c, i) => (i === slot ? chord : c));
    commit(setActionChords(bindings, action, next, isMac, steal));
    setRecording(null);
    setPending(null);
    setNotice(null);
  };

  useChordCapture(
    !!recording,
    (chord) => {
      if (!recording) return;
      const reserved = reservedReason(chord, isMac, desktop);
      if (reserved) {
        setNotice({ action: recording.action, text: `Can't use that: ${reserved}` });
        return;
      }
      const conflicts = findConflicts(live, recording.action, chord, isMac);
      if (conflicts.length) {
        setPending({ ...recording, chord, conflicts });
        setRecording(null);
        return;
      }
      place(recording.action, recording.slot, chord);
    },
    () => { setRecording(null); setNotice(null); },
    (text) => recording && setNotice({ action: recording.action, text }),
  );

  useChordCapture(
    findingKeys,
    (chord) => { setKeyFilter(chord); setFindingKeys(false); },
    () => setFindingKeys(false),
    () => {},
  );

  // Arrived from the "?" panel or the palette on one action: show it, listening.
  useMountEffect(() => {
    const action = takePendingRebind();
    if (!action) return;
    const chords = currentChords(bindings, action, isMac);
    setRecording({ action, slot: chords.length ? 0 : "add" });
    setFlash(action);
    requestAnimationFrame(() => document.querySelector(`[data-shortcut-row="${action}"]`)?.scrollIntoView({ block: "center" }));
  });

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const keyId = keyFilter ? comboIdentity(resolveChord(keyFilter, isMac)) : null;
  const filtered = sections
    .map((sec) => ({
      ...sec,
      actions: sec.actions.filter(({ action, label }) => {
        if (changedOnly && !changed.has(action)) return false;
        if (words.length && !words.every((w) => `${label} ${action}`.toLowerCase().includes(w))) return false;
        if (keyId && !currentChords(bindings, action, isMac).some((c) => comboIdentity(resolveChord(c, isMac)) === keyId)) return false;
        return true;
      }),
    }))
    .filter((sec) => sec.actions.length > 0);

  return (
    <SettingsPanel>
      {/* Pinned flush with the scroll edge (the modal pads its body 20px), so rows never show above it. */}
      <div className="sticky -top-5 z-10 -mx-1 -mt-5 flex items-center gap-2 bg-sol-bg px-1 pb-3 pt-5">
        <div className={cn(
          "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border bg-sol-bg-alt/40 px-2.5 transition-colors",
          findingKeys ? "border-sol-cyan ring-2 ring-sol-cyan/25" : "border-sol-border/80 focus-within:border-sol-border",
        )}>
          <Search className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" />
          {keyFilter ? (
            <span className="flex flex-1 items-center gap-2">
              <ChordCaps chord={keyFilter} />
              <button onClick={() => setKeyFilter(null)} aria-label="Clear key filter" className="rounded p-0.5 text-sol-text-dim hover:text-sol-text">
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : findingKeys ? (
            <span className="flex-1 animate-pulse text-sm text-sol-cyan">Press a shortcut…</span>
          ) : (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search shortcuts"
              className="min-w-0 flex-1 bg-transparent text-sm text-sol-text outline-none placeholder:text-sol-text-dim"
            />
          )}
          <ShortcutTooltip label="Find by keys">
            <button
              onClick={() => { setFindingKeys((v) => !v); setKeyFilter(null); }}
              aria-pressed={findingKeys}
              aria-label="Find by keys"
              className={cn("rounded p-1 transition-colors", findingKeys ? "bg-sol-cyan/15 text-sol-cyan" : "text-sol-text-dim hover:text-sol-text")}
            >
              <Keyboard className="h-3.5 w-3.5" />
            </button>
          </ShortcutTooltip>
        </div>
        <button
          onClick={() => setChangedOnly((v) => !v)}
          disabled={changed.size === 0 && !changedOnly}
          aria-pressed={changedOnly}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs tabular-nums transition-colors disabled:opacity-40",
            changedOnly ? "border-sol-cyan/60 bg-sol-cyan/10 text-sol-cyan" : "border-sol-border/80 text-sol-text-muted hover:text-sol-text",
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", changed.size ? "bg-sol-cyan" : "bg-sol-text-dim")} />
          {changed.size} changed
        </button>
        {changed.size > 0 && (confirmReset ? (
          <span className="flex h-8 items-center gap-1 text-xs">
            <button onClick={() => { commit([]); setConfirmReset(false); setChangedOnly(false); }} className="rounded-lg bg-sol-red/15 px-2.5 py-1.5 text-sol-red hover:bg-sol-red/25">
              Reset {changed.size}
            </button>
            <button onClick={() => setConfirmReset(false)} className="rounded-lg px-2 py-1.5 text-sol-text-muted hover:text-sol-text">Keep</button>
          </span>
        ) : (
          <ShortcutTooltip label="Reset all to defaults">
            <button onClick={() => setConfirmReset(true)} aria-label="Reset all to defaults" className="flex h-8 w-8 items-center justify-center rounded-lg border border-sol-border/80 text-sol-text-dim hover:text-sol-text">
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </ShortcutTooltip>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="py-10 text-center text-sm text-sol-text-dim">
          {keyFilter ? <span className="inline-flex items-center gap-2"><ChordCaps chord={keyFilter} /> is free</span> : "No shortcut matches"}
        </div>
      )}

      {filtered.map((sec) => (
        <SettingsSection
          key={sec.label}
          title={<span className="flex items-center gap-2"><span className={cn("h-1.5 w-1.5 rounded-full", sec.accent)} />{sec.label}</span>}
        >
          {sec.actions.map(({ action, label, def }) => {
            const chords = currentChords(bindings, action, isMac);
            const isChanged = changed.has(action);
            const rec = recording?.action === action ? recording : null;
            const pend = pending?.action === action ? pending : null;
            const note = notice?.action === action ? notice.text : null;
            return (
              <div
                key={action}
                data-shortcut-row={action}
                onAnimationEnd={() => flash === action && setFlash(null)}
                className={cn(
                  "group px-4 py-2 sm:px-5",
                  (rec || pend) && "bg-sol-cyan/[0.06]",
                  flash === action && "animate-[pulse_1s_ease-out_1]",
                )}
              >
                <div className="flex min-h-[28px] items-center justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", isChanged ? "bg-sol-cyan" : "bg-transparent")} />
                    <span className="truncate text-sm text-sol-text">{label}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {def.fixed ? (
                      <ShortcutTooltip label="Read by its page directly; this one can't change">
                        <span className="flex items-center gap-1.5">
                          {chords.map((c) => <ChordCaps key={c} chord={c} dim />)}
                          <Lock className="h-3 w-3 text-sol-text-dim" />
                        </span>
                      </ShortcutTooltip>
                    ) : (
                      <>
                        {chords.map((c, i) => (
                          rec?.slot === i ? <Listening key={c} onCancel={() => setRecording(null)} /> : (
                            <span key={c} className="relative flex items-center">
                              <button
                                onClick={() => { setPending(null); setNotice(null); setRecording({ action, slot: i }); }}
                                aria-label={`Change ${label} shortcut`}
                                className="rounded-md p-1 transition-colors hover:bg-sol-bg-highlight/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan/40"
                              >
                                <ChordCaps chord={c} />
                              </button>
                              <button
                                onClick={() => commit(setActionChords(bindings, action, chords.filter((_, j) => j !== i), isMac))}
                                aria-label="Remove this shortcut"
                                className="absolute -right-1 -top-1 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-sol-bg-alt text-sol-text-dim shadow ring-1 ring-sol-border hover:text-sol-red group-hover:flex"
                              >
                                <X className="h-2.5 w-2.5" />
                              </button>
                            </span>
                          )
                        ))}
                        {rec?.slot === "add" ? <Listening onCancel={() => setRecording(null)} /> : (
                          <ShortcutTooltip label={chords.length ? "Add another shortcut" : "Add a shortcut"}>
                            <button
                              onClick={() => { setPending(null); setNotice(null); setRecording({ action, slot: "add" }); }}
                              aria-label="Add a shortcut"
                              className={cn(
                                "flex h-6 items-center justify-center rounded-md border border-dashed border-sol-border text-sol-text-dim transition-colors hover:border-sol-cyan hover:text-sol-cyan",
                                chords.length ? "w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" : "px-2 text-xs",
                              )}
                            >
                              {chords.length ? <Plus className="h-3 w-3" /> : "Add"}
                            </button>
                          </ShortcutTooltip>
                        )}
                        <span className="w-6">
                          {isChanged && (
                            <ShortcutTooltip label="Back to default">
                              <button
                                onClick={() => commit(resetAction(bindings, action))}
                                aria-label="Back to default"
                                className="flex h-6 w-6 items-center justify-center rounded-md text-sol-text-dim hover:bg-sol-bg-highlight/60 hover:text-sol-text"
                              >
                                <RotateCcw className="h-3 w-3" />
                              </button>
                            </ShortcutTooltip>
                          )}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                {note && <div className="mt-1 pl-3.5 text-xs text-sol-orange">{note}</div>}
                {pend && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-3.5 text-xs">
                    <ChordCaps chord={pend.chord} />
                    <span className="text-sol-text-muted">
                      is {pend.conflicts.map((c) => c.description).join(", ")}
                    </span>
                    <span className="ml-auto flex items-center gap-1">
                      <button onClick={() => place(action, pend.slot, pend.chord, pend.conflicts.map((c) => c.action))} className="rounded-md bg-sol-cyan/15 px-2 py-1 text-sol-cyan hover:bg-sol-cyan/25">
                        Move it here
                      </button>
                      <button onClick={() => place(action, pend.slot, pend.chord)} className="rounded-md px-2 py-1 text-sol-text-muted hover:bg-sol-bg-highlight/60 hover:text-sol-text">
                        Keep both
                      </button>
                      <button onClick={() => setPending(null)} className="rounded-md px-2 py-1 text-sol-text-muted hover:bg-sol-bg-highlight/60 hover:text-sol-text">
                        Cancel
                      </button>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </SettingsSection>
      ))}

      {desktop && (
        <SettingsSection>
          <SettingsLinkRow
            icon={Keyboard}
            label="System-wide shortcuts"
            value="Desktop"
            onClick={() => s.openSettingsModal("desktop")}
          />
        </SettingsSection>
      )}
    </SettingsPanel>
  );
}

function Listening({ onCancel }: { onCancel: () => void }) {
  return (
    <button
      autoFocus
      onBlur={onCancel}
      className="flex h-7 items-center gap-1.5 rounded-md border border-sol-cyan bg-sol-cyan/10 px-2 text-xs text-sol-cyan ring-2 ring-sol-cyan/20 outline-none"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sol-cyan" />
      Press keys
      <KeyCap size="xs">Esc</KeyCap>
    </button>
  );
}
