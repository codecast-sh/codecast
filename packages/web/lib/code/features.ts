// The editor's extension slots. Vim, language servers, the git gutter, session
// blame and agent highlights each plug in here without CodeEditor knowing they
// exist: a feature is a factory from the file being shown to a CodeMirror
// extension, and each lives in its own Compartment so it can be swapped
// (vim toggled, a server restarted) without rebuilding anything else.
//
// What a buffer has applied travels inside its EditorState (`appliedFeatures`),
// so a buffer coming back on screen catches up on exactly the features that
// were registered or reconfigured while it was away, and a buffer swap carries
// its features with it.

import { Compartment, Facet, StateEffect, StateField, type Extension } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";

/** Above this, the editor drops per-keystroke work that scales with the file
 *  (word completion, selection-match highlighting); features read `largeFile`. */
export const LARGE_FILE_BYTES = 1.5 * 1024 * 1024;

export interface EditorFeatureContext {
  vaultId: string;
  /** Vault-relative. */
  path: string;
  /** LSP language id ("typescript", "plaintext"); see languages.lspLanguageId. */
  languageId: string;
  /** Display name ("TypeScript"), null for plain text. */
  languageName: string | null;
  sizeBytes: number;
  largeFile: boolean;
  /** Only these features attach: a document that is not one file (the search
   *  results editor) takes vim and the theme, never git, LSP or autosave. */
  only?: ReadonlySet<string>;
  /** False for a buffer that is not a file in a vault the daemon knows (the
   *  vimrc overlay on Settings > Editor): features registered with
   *  `needsVault` (git, language servers) never run for it, so they ask the
   *  daemon about nothing. Absent means a real vault. */
  isRealVault?: boolean;
}

export interface EditorFeatureOptions {
  /** Reads the vault through the daemon; skipped where isRealVault is false. */
  needsVault?: boolean;
  /** What an async feature holds its slot with until it lands, decided
   *  synchronously from what is already known (a gutter of the width the real
   *  one will have). The file paints with its final layout, and the columns
   *  never shift the text as features arrive one by one. */
  placeholder?: (ctx: EditorFeatureContext) => Extension | null | undefined;
}

export type EditorFeatureFactory = (
  ctx: EditorFeatureContext,
) => Extension | null | undefined | Promise<Extension | null | undefined>;

interface Feature {
  factory: EditorFeatureFactory;
  needsVault: boolean;
  placeholder?: EditorFeatureOptions["placeholder"];
  compartment: Compartment;
  version: number;
}

const features = new Map<string, Feature>();
const hosts = new Set<EditorView>();
let versions = 0;
/** Async factories in flight, per file and feature, by the version they run
 *  for: a state that has not applied them yet must not start them again. */
const pending = new WeakMap<EditorFeatureContext, Map<string, number>>();

/** The file a state was built for. A pending async feature checks it before it
 *  lands, so a slow factory never configures the next file shown. */
export const featureContext = Facet.define<EditorFeatureContext, EditorFeatureContext | null>({
  combine: (values) => values[0] ?? null,
});

const markApplied = StateEffect.define<{ id: string; version: number }>();

const appliedFeatures = StateField.define<Readonly<Record<string, number>>>({
  create: () => ({}),
  update: (applied, tr) => {
    let next = applied;
    for (const e of tr.effects) if (e.is(markApplied)) next = { ...next, [e.value.id]: e.value.version };
    return next;
  },
});

/** What every buffer's state is created with. */
export function featureBase(ctx: EditorFeatureContext): Extension {
  return [featureContext.of(ctx), appliedFeatures];
}

/** Register a feature; returns the unregister function. Live editors pick it up
 *  at once, the rest when they are next shown. */
export function registerEditorFeature(id: string, factory: EditorFeatureFactory, opts: EditorFeatureOptions = {}): () => void {
  const previous = features.get(id);
  const feature: Feature = { factory, needsVault: !!opts.needsVault, placeholder: opts.placeholder, compartment: previous?.compartment ?? new Compartment(), version: ++versions };
  features.set(id, feature);
  for (const view of hosts) syncEditorFeatures(view);
  return () => {
    if (features.get(id) !== feature) return;
    features.delete(id);
    for (const view of hosts) {
      if (feature.compartment.get(view.state) !== undefined) {
        view.dispatch({ effects: feature.compartment.reconfigure([]) });
      }
    }
  };
}

/** Run a feature's factory again everywhere (its settings changed). */
export function reconfigureEditorFeature(id: string): void {
  const feature = features.get(id);
  if (!feature) return;
  feature.version = ++versions;
  for (const view of hosts) syncEditorFeatures(view);
}

/** The compartment a feature lives in, for a feature that reconfigures itself
 *  from inside the editor (vim's mode toggle). */
export function editorFeatureCompartment(id: string): Compartment | undefined {
  return features.get(id)?.compartment;
}

let focused: EditorView | null = null;

/** The editor the person was last in, for commands that name none (the
 *  command palette, a status bar chip). A plain `focusin` on the editor's
 *  root, so it holds whatever inside the editor took focus. */
export function focusedEditorView(): EditorView | null {
  return focused?.dom.isConnected ? focused : null;
}

/** A mounted editor; registry changes reach it until the returned release. */
export function attachFeatureHost(view: EditorView): () => void {
  hosts.add(view);
  const onFocus = () => {
    focused = view;
  };
  view.dom.addEventListener("focusin", onFocus);
  if (view.hasFocus || !focusedEditorView()) focused = view;
  syncEditorFeatures(view);
  return () => {
    hosts.delete(view);
    view.dom.removeEventListener("focusin", onFocus);
    if (focused === view) focused = null;
  };
}

function effectsFor(view: EditorView, id: string, feature: Feature, ext: Extension) {
  const slot =
    feature.compartment.get(view.state) === undefined
      ? StateEffect.appendConfig.of(feature.compartment.of(ext))
      : feature.compartment.reconfigure(ext);
  return [slot, markApplied.of({ id, version: feature.version })];
}

/** Bring the shown state up to date with the registry: each feature whose
 *  version this state has not applied runs for the state's file. Synchronous
 *  factories land in one transaction, before the next paint. */
export function syncEditorFeatures(view: EditorView): void {
  const ctx = view.state.facet(featureContext);
  if (!ctx) return;
  const applied = view.state.field(appliedFeatures, false) ?? {};
  const effects: StateEffect<unknown>[] = [];
  for (const [id, feature] of features) {
    if (ctx.only && !ctx.only.has(id)) continue;
    if (feature.needsVault && !vaultBacked(ctx)) continue;
    if (applied[id] === feature.version || pending.get(ctx)?.get(id) === feature.version) continue;
    let result: ReturnType<EditorFeatureFactory>;
    try {
      result = feature.factory(ctx);
    } catch (e) {
      console.error(`editor feature ${id} failed`, e);
      continue;
    }
    if (result instanceof Promise) {
      // Not marked applied: the real extension replaces it in the same slot.
      if (feature.placeholder && feature.compartment.get(view.state) === undefined) {
        let held: Extension | null | undefined = null;
        try {
          held = feature.placeholder(ctx);
        } catch (e) {
          console.error(`editor feature ${id} placeholder failed`, e);
        }
        if (held) effects.push(StateEffect.appendConfig.of(feature.compartment.of(held)));
      }
      const version = feature.version;
      const running = pending.get(ctx) ?? new Map<string, number>();
      pending.set(ctx, running);
      running.set(id, version);
      const settle = () => {
        if (running.get(id) === version) running.delete(id);
      };
      result.then(
        (ext) => {
          settle();
          if (features.get(id) !== feature || feature.version !== version) return;
          // Land it wherever this file is shown now: the view it started in
          // may be gone (a remount, StrictMode's double mount), and a view
          // that took the file over skipped the factory while it was pending.
          for (const v of new Set([...(view.dom.isConnected ? [view] : []), ...hosts])) {
            if (v.state.facet(featureContext) === ctx && v.state.field(appliedFeatures, false)?.[id] !== version) {
              v.dispatch({ effects: effectsFor(v, id, feature, ext ?? []) });
            }
          }
        },
        (e) => {
          settle();
          console.error(`editor feature ${id} failed`, e);
          // Give back a column its placeholder held; the next show retries.
          if (!feature.placeholder || features.get(id) !== feature) return;
          for (const v of new Set([...(view.dom.isConnected ? [view] : []), ...hosts])) {
            if (v.state.facet(featureContext) === ctx && v.state.field(appliedFeatures, false)?.[id] === undefined && feature.compartment.get(v.state) !== undefined) {
              v.dispatch({ effects: feature.compartment.reconfigure([]) });
            }
          }
        },
      );
    } else {
      effects.push(...effectsFor(view, id, feature, result ?? []));
    }
  }
  if (effects.length) view.dispatch({ effects });
}

// ── Status bar items ─────────────────────────────────────────────────────────

export interface StatusItemView {
  dom: HTMLElement;
  /** Called on every editor update; write text nodes, never React state. */
  update?(update: ViewUpdate): void;
  destroy?(): void;
}

/**
 * A status item whose text comes from a subscription that depends on what the
 * editor is configured with (vim's mode while vim runs, a language server's
 * state while one is attached). `bind` subscribes, writing to `dom` directly,
 * and returns the unsubscribe (null when there is nothing to follow); it runs
 * at creation and again after every reconfiguration, never on a keystroke.
 */
/** Name a status item for a screen reader and a pointer at once: what it
 *  shows and what a press does, since its visible text is a bare count or a
 *  mode. Writes only when the name changes, so it may sit in a render path. */
export function nameStatusItem(el: HTMLElement, name: string, title = name): void {
  if (el.getAttribute("aria-label") !== name) el.setAttribute("aria-label", name);
  if (el.title !== title) el.title = title;
}

export function liveStatusItem(dom: HTMLElement, bind: () => (() => void) | null): StatusItemView {
  let unsubscribe = bind();
  return {
    dom,
    update(u: ViewUpdate) {
      if (!u.transactions.some((tr) => tr.reconfigured)) return;
      unsubscribe?.();
      unsubscribe = bind();
    },
    destroy() {
      unsubscribe?.();
    },
  };
}

export interface StatusItem {
  id: string;
  /** Lower first. The built-in segments sit at 0 (left) and 100+ (right). */
  order: number;
  /** What stays when the bar is narrow: the lowest priorities drop first.
   *  The built-ins: cursor 90, selection 30, file format 30. Default 50. */
  priority?: number;
  side: "left" | "right";
  /** Reads the vault through the daemon: not mounted where the editor's
   *  isRealVault is false, as registerEditorFeature's `needsVault`. */
  needsVault?: boolean;
  create(view: EditorView): StatusItemView | null;
}

/** Whether a vault-backed feature or status item may run for `ctx`. */
export const vaultBacked = (ctx: EditorFeatureContext | null): boolean => ctx?.isRealVault !== false;

const statusItems = new Map<string, StatusItem>();
const statusListeners = new Set<() => void>();

/** Add a status bar item to every editor; returns the unregister function. */
export function registerStatusItem(item: StatusItem): () => void {
  statusItems.set(item.id, item);
  statusListeners.forEach((fn) => fn());
  return () => {
    if (statusItems.get(item.id) !== item) return;
    statusItems.delete(item.id);
    statusListeners.forEach((fn) => fn());
  };
}

export function registeredStatusItems(): StatusItem[] {
  return [...statusItems.values()].sort((a, b) => a.order - b.order);
}

export function onStatusItemsChanged(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}
