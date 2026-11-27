// Git in the code editor: the change gutter, hunk peek/step/revert and the
// diff view (gutter.ts), plus the branch chip in the status bar. Register once
// with registerGitFeature(); every editor showing a tracked file in a local
// repository then gets the gutter.
//
// What loads when: this module is small and rides the editor chunk. The
// gutter, @codemirror/merge and the file's HEAD text load the first time a
// tracked file opens; after that a file whose base is cached gets its gutter
// in the same transaction as its first paint.

import type { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { CODE_GIT_MERGE_BASE_REF as MERGE_BASE_REF } from "@codecast/shared/contracts";
import { useVaultStore } from "../../../store/vaultStore";
import { registerCodeCommands, type CodeCommandContext } from "../commands";
import { fetchGitBase } from "../daemonClient";
import { featureContext, focusedEditorView, nameStatusItem, reconfigureEditorFeature, registerEditorFeature, registerStatusItem, type EditorFeatureContext, type StatusItemView } from "../features";
import { decodeFileText, textToDoc } from "../buffers";
import { loadMergeKit, type MergeKit } from "../merge";
import { gitGutterStandIn } from "../gutterSlots";
import { ensureGitStatus, gitStatusOf, lastNoHeadPaths, onGitHeadChange, useGitStatusStore, type VaultGitStatus } from "./status";
import type { DiffLayout, GitDiffTarget } from "./gutter";
import { lineIcon } from "../icons";

export type { DiffLayout, GitDiffTarget };

type GutterModule = typeof import("./gutter");

const FEATURE = "git";

let gutterModule: GutterModule | null = null;
let gutterLoading: Promise<GutterModule> | null = null;
function loadGutter(): Promise<GutterModule> {
  gutterLoading ??= import("./gutter").then(
    (m) => (gutterModule = m),
    (e) => {
      gutterLoading = null;
      throw e;
    },
  );
  return gutterLoading;
}

let kit: MergeKit | null = null;

// ── bases ───────────────────────────────────────────────────────────────────

/** A file's text at a ref, per HEAD it was read under: a moved HEAD reads
 *  again. Null when the ref exists and the file does not exist at it. */
const bases = new Map<string, { value?: string | null; promise: Promise<string | null> }>();
/** Files whose bases stay held; the least recently read goes first. */
const BASES_MAX = 64;

function baseKey(vaultId: string, path: string, ref: string, head: string | null) {
  return `${vaultId}\u0000${path}\u0000${ref}\u0000${head ?? ""}`;
}

function readBase(vaultId: string, path: string, ref: string): { value?: string | null; promise: Promise<string | null> } {
  const key = baseKey(vaultId, path, ref, gitStatusOf(vaultId)?.head ?? null);
  const hit = bases.get(key);
  if (hit) {
    bases.delete(key);
    bases.set(key, hit);
    return hit;
  }
  const { endpoint } = useVaultStore.getState();
  const entry: { value?: string | null; promise: Promise<string | null> } = {
    promise: endpoint
      ? fetchGitBase(endpoint, vaultId, path, ref).then(
          (res) => (res.exists ? (res.content ?? "") : null),
          (e: unknown) => {
            // A failed read is never remembered: the ref may appear, the
            // daemon may come back. The error keeps its status (404 unknown
            // ref, 413 too large) for the caller to tell apart.
            bases.delete(key);
            throw e;
          },
        )
      : Promise.reject(new Error("files not connected")),
  };
  entry.promise.then((v) => (entry.value = v), () => {});
  bases.set(key, entry);
  if (bases.size > BASES_MAX) bases.delete(bases.keys().next().value!);
  return entry;
}

function dropBases(vaultId: string): void {
  for (const key of bases.keys()) if (key.startsWith(`${vaultId}\u0000`)) bases.delete(key);
}

// ── diff targets ────────────────────────────────────────────────────────────

/** `state` is the editor's, for providers that read its other features. */
type TargetProvider = (ctx: { vaultId: string; path: string; state: EditorState }) => GitDiffTarget[];
const targetProviders = new Set<TargetProvider>();

/** Offer more refs in the diff picker (a session's base commit, say). A
 *  provider that throws offers nothing. */
export function addGitDiffTargets(provider: TargetProvider): () => void {
  targetProviders.add(provider);
  return () => targetProviders.delete(provider);
}

function targetsFor(vaultId: string, path: string, state: EditorState): GitDiffTarget[] {
  const status = gitStatusOf(vaultId);
  const out: GitDiffTarget[] = [{ ref: "HEAD~1", label: "Previous commit" }];
  if (status?.upstream) out.push({ ref: "@{u}", label: "Upstream" });
  // Everything this branch changed since it left the default branch.
  out.push({ ref: MERGE_BASE_REF, label: "Merge base" });
  for (const p of targetProviders) {
    try {
      out.push(...p({ vaultId, path, state }));
    } catch {
      // One provider's failure never empties the picker.
    }
  }
  return out;
}

// ── the feature ─────────────────────────────────────────────────────────────

/** Whether a file gets git, and how: "tracked" (the gutter against HEAD),
 *  "new" (untracked or added: nothing at HEAD, so no gutter, whose bars would
 *  all be green, but the diff opens against nothing or an older ref), or
 *  false. */
function eligibility(ctx: EditorFeatureContext, status: VaultGitStatus | undefined): "tracked" | "new" | false {
  const vault = useVaultStore.getState();
  if (!vault.endpoint || vault.isRemote || vault.activeVaultId !== ctx.vaultId) return false;
  if (!status?.repo) return false;
  // Ignored files never appear in the status and have nothing at HEAD.
  if (vault.files[ctx.path]?.ignored) return false;
  const state = status.files[ctx.path];
  return state === "untracked" || state === "added" ? "new" : "tracked";
}

/** The file gets the change gutter. */
function eligible(ctx: EditorFeatureContext, status: VaultGitStatus | undefined): boolean {
  return eligibility(ctx, status) === "tracked";
}

/** The gutter's column while its module, the status and HEAD's copy load:
 *  held for a file the status already calls eligible, or, before the first
 *  status, for a file in a repo root that the last known status (kept across
 *  reloads) and the file table don't mark untracked, added or ignored. */
export function gitPlaceholder(ctx: EditorFeatureContext) {
  const held = gitStatusOf(ctx.vaultId);
  if (held) return eligible(ctx, held) ? gitGutterStandIn : null;
  const vault = useVaultStore.getState();
  if (!vault.endpoint || vault.isRemote || vault.activeVaultId !== ctx.vaultId || !vault.isRepo) return null;
  if (vault.files[ctx.path]?.ignored || lastNoHeadPaths(ctx.vaultId)?.has(ctx.path)) return null;
  return gitGutterStandIn;
}

function build(ctx: EditorFeatureContext, m: GutterModule, k: MergeKit, base: string | null, newFile = false) {
  if (base === null && !newFile) return null;
  return m.gitEditorExtension({
    kit: k,
    vaultId: ctx.vaultId,
    path: ctx.path,
    newFile,
    base: textToDoc(decodeFileText(base ?? "").text),
    fetchBase: (ref) => readBase(ctx.vaultId, ctx.path, ref).promise,
    targets: (state) => targetsFor(ctx.vaultId, ctx.path, state),
  });
}

function gitFeature(ctx: EditorFeatureContext) {
  const held = gitStatusOf(ctx.vaultId);
  const kind = held ? eligibility(ctx, held) : undefined;
  if (kind === false) return null;
  // A new file reads nothing at HEAD: it has no gutter to wait for.
  if (kind === "new" && gutterModule && kit) return build(ctx, gutterModule, kit, null, true);
  // Everything already loaded: land with the file's first paint.
  if (kind === "tracked" && gutterModule && kit) {
    const base = readBase(ctx.vaultId, ctx.path, "HEAD");
    if (base.value !== undefined) return build(ctx, gutterModule, kit, base.value);
  }
  return (async () => {
    const status = held ?? (await ensureGitStatus(ctx.vaultId));
    const now = eligibility(ctx, status);
    if (!now) return null;
    if (now === "new") {
      const [m, k] = await Promise.all([loadGutter(), loadMergeKit()]);
      kit = k;
      return build(ctx, m, k, null, true);
    }
    // No HEAD yet (a repo with no commits) or a file too large to diff: no gutter.
    const head = readBase(ctx.vaultId, ctx.path, "HEAD").promise.catch((e: { status?: number }) => {
      if (e?.status === 404 || e?.status === 413) return null;
      throw e;
    });
    const [m, k, base] = await Promise.all([loadGutter(), loadMergeKit(), head]);
    kit = k;
    return build(ctx, m, k, base);
  })();
}

// ── commands ────────────────────────────────────────────────────────────────

function viewFor(ctx: CodeCommandContext): EditorView | null {
  const at = ctx.view ?? focusedEditorView();
  // The side-by-side diff's right pane runs vim and keys of its own; its
  // commands act on the editor it mirrors, which holds the git state.
  const view = at && gutterModule ? gutterModule.splitOwner(at) : at;
  return view && gutterModule?.hasGitGutter(view.state) ? view : null;
}

function withView(fn: (m: GutterModule, view: EditorView, args: Record<string, unknown> | undefined) => boolean) {
  return (args: Record<string, unknown> | undefined, ctx: CodeCommandContext) => {
    const view = viewFor(ctx);
    return view && gutterModule ? fn(gutterModule, view, args) : false;
  };
}

// ── status bar: branch and ahead/behind ─────────────────────────────────────

const BRANCH_ICON = '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>';

/** "main", "main ↑2 ↓1", or a detached HEAD's short sha. */
export function branchLabel(status: VaultGitStatus | undefined): string {
  if (!status?.repo) return "";
  const name = status.branch ?? (status.head ? status.head.slice(0, 7) : "");
  if (!name) return "";
  const ab = [status.ahead ? `↑${status.ahead}` : "", status.behind ? `↓${status.behind}` : ""].filter(Boolean).join(" ");
  return ab ? `${name} ${ab}` : name;
}

function branchItem(view: EditorView): StatusItemView {
  const dom = document.createElement("button");
  dom.type = "button";
  dom.className = "cm-git-branch";
  dom.append(lineIcon(BRANCH_ICON));
  const text = document.createTextNode("");
  dom.append(text);
  dom.hidden = true;
  dom.onclick = () => {
    if (gutterModule?.hasGitGutter(view.state)) gutterModule.toggleGitDiff(view);
  };
  let vaultId: string | null = null;
  const render = () => {
    const status = vaultId ? useGitStatusStore.getState().byVault[vaultId] : undefined;
    const label = branchLabel(status);
    if (text.nodeValue !== label) text.nodeValue = label;
    dom.hidden = !label;
    const title = status?.upstream ? `${status.branch ?? "HEAD"}: ${status.ahead} ahead, ${status.behind} behind upstream` : (status?.branch ?? "");
    nameStatusItem(dom, `Branch ${title}, toggle changes`, title);
  };
  const follow = () => {
    vaultId = view.state.facet(featureContext)?.vaultId ?? null;
    render();
  };
  follow();
  const off = useGitStatusStore.subscribe((s, prev) => {
    if (vaultId && s.byVault[vaultId] !== prev.byVault[vaultId]) render();
  });
  return {
    dom,
    update(u) {
      if (u.startState.facet(featureContext) !== u.state.facet(featureContext)) follow();
    },
    destroy: off,
  };
}

// ── registration ────────────────────────────────────────────────────────────

let registered = false;

/** Register git with the editor core, once. */
export function registerGitFeature(): void {
  if (registered) return;
  registered = true;

  registerEditorFeature(FEATURE, gitFeature, { needsVault: true, placeholder: gitPlaceholder });
  registerStatusItem({ id: "git.branch", side: "left", order: 20, priority: 20, needsVault: true, create: branchItem });

  // A commit or checkout moves the base every gutter compares against; the
  // first status for a vault (the daemon came up) may enable gutters.
  onGitHeadChange((vaultId) => {
    dropBases(vaultId);
    reconfigureEditorFeature(FEATURE);
  });
  useGitStatusStore.subscribe((s, prev) => {
    for (const [id, st] of Object.entries(s.byVault)) {
      const before = prev.byVault[id];
      if (!before || before.repo !== st.repo) return reconfigureEditorFeature(FEATURE);
    }
  });

  registerCodeCommands({
    // args: {ref?, label?, layout?} toggles that diff; {pick: true} opens the
    // ref picker (opening the diff against HEAD first when none is open).
    "git.diffHead": withView((m, view, args) => {
      if (args?.pick === true) return m.openGitDiffPicker(view);
      const ref = typeof args?.ref === "string" ? args.ref : undefined;
      const layout = args?.layout === "split" || args?.layout === "unified" ? (args.layout as DiffLayout) : undefined;
      return m.toggleGitDiff(view, ref ? { ref, label: typeof args?.label === "string" ? args.label : undefined } : undefined, layout);
    }),
    // args: {ref, label?, layout?}: show the diff against that ref, switching
    // an open diff to it (never closing it, unlike git.diffHead's toggle).
    "git.diffAgainst": withView((m, view, args) => {
      const ref = typeof args?.ref === "string" ? args.ref.trim() : "";
      if (!ref) return false;
      const layout = args?.layout === "split" || args?.layout === "unified" ? (args.layout as DiffLayout) : undefined;
      const label = typeof args?.label === "string" ? args.label : ref === MERGE_BASE_REF ? "Merge base" : ref;
      return m.openGitDiff(view, { ref, label }, layout);
    }),
    "git.nextHunk": withView((m, view) => m.stepGitHunk(view, 1)),
    "git.prevHunk": withView((m, view) => m.stepGitHunk(view, -1)),
    "git.revertHunk": withView((m, view) => m.revertGitHunk(view)),
    // args: {line}: show that line's change (opening, never toggling it off).
    "git.peekHunk": withView((m, view, args) => {
      const line = typeof args?.line === "number" ? args.line : undefined;
      if (line === undefined) return m.toggleGitPeek(view);
      return m.showGitPeek(view, view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines))).from);
    }),
  });
}
