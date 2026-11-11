// Board actions that reach outside the canvas: stickies into tasks or a
// plan, image upload, and the clipboard format. Canvas writes still go
// through the live handle so they sync, undo and show to everyone.
import { toast } from "sonner";
import type { ArtifactOp } from "@codecast/shared/artifacts";
import { clearOffset, elementBounds, elementBox, nextZ, parseItems, gridPositions, placeItems, squareCols, cloneOps, unionBox, type Pt } from "@codecast/shared/artifacts/board";
import { useInboxStore } from "../../store/inboxStore";
import { createTaskAndAdopt } from "../../lib/taskActions";
import { uploadBlobToStorage } from "../../lib/uploadBlob";
import { api } from "@codecast/convex/convex/_generated/api";
import type { BoardEl, BoardLive } from "./boardTypes";

/** A sticky's text as a task: first line is the title, the rest the description. */
export function taskFromText(text: string): { title: string; description?: string } | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const [title, ...rest] = lines;
  return { title: title.slice(0, 200), ...(rest.length ? { description: rest.join("\n") } : {}) };
}

/** Where the board's doc lives, so tasks and plans land in the same workspace and project. */
function docScope(docId: string): Record<string, any> {
  const doc = (useInboxStore.getState() as any).docs?.[docId];
  const out: Record<string, any> = {};
  if (doc?.project_id) out.project_id = String(doc.project_id);
  const ws: string | undefined = doc?.workspace;
  if (ws?.startsWith("team:")) { out.workspace = "team"; out.team_id = ws.slice(5); }
  else if (ws?.startsWith("user:")) out.workspace = "personal";
  return out;
}

const CARD = { w: 320, h: 168 };

/**
 * Turn stickies into tasks: one task per sticky, and the sticky becomes that
 * task's live card under the same key, so arrows to it stay attached. With a
 * plan title, the tasks go under a new plan whose card lands beside them.
 */
/** Stickies whose task is being created now, so a second press never makes a second task. */
const converting = new Set<string>();

export async function stickiesToTasks(live: BoardLive & { docId: string }, stickies: BoardEl[], all: BoardEl[], planTitle: string | undefined, current: (key: string) => BoardEl | undefined): Promise<void> {
  const items = stickies
    .filter((s) => !converting.has(`${live.docId}|${s.key}`))
    .map((s) => ({ el: s, task: taskFromText(String(s.text ?? "")) }))
    .filter((x) => x.task);
  if (!items.length) {
    if (stickies.some((s) => !String(s.text ?? "").trim())) toast.error("Those stickies are empty");
    return;
  }
  for (const { el } of items) converting.add(`${live.docId}|${el.key}`);
  try {
    await convert(live, items, all, planTitle, current);
  } finally {
    for (const { el } of items) converting.delete(`${live.docId}|${el.key}`);
  }
}

async function convert(live: BoardLive & { docId: string }, items: { el: BoardEl; task: ReturnType<typeof taskFromText> }[], all: BoardEl[], planTitle: string | undefined, current: (key: string) => BoardEl | undefined): Promise<void> {
  const stickies = items.map((x) => x.el);
  const scope = docScope(live.docId);
  let plan: { id: string; short_id: string } | null = null;
  if (planTitle) {
    try {
      const res = await (useInboxStore.getState() as any).createPlan({ title: planTitle, status: "active", ...scope });
      if (res?.short_id) plan = { id: String(res.id), short_id: String(res.short_id) };
    } catch {
      /* reported below */
    }
    if (!plan) {
      toast.error("Could not create the plan");
      return;
    }
  }
  const ops: ArtifactOp[] = [];
  let made = 0;
  await Promise.all(items.map(async ({ el, task }) => {
    const created = await createTaskAndAdopt({ ...task!, ...scope, ...(plan ? { plan_id: plan.short_id } : {}) });
    if (!created) return;
    made++;
    // Where the sticky is now: it may have moved while the task was being made, or been deleted.
    const now = current(el.key);
    // Someone rewrote the sticky meanwhile: keep their words on the board rather than replace them.
    if (!now || now.kind !== "sticky" || String(now.text ?? "") !== String(el.text ?? "")) return;
    const b = elementBox(now);
    ops.push({ k: el.key, put: { kind: "card", ref: created.short_id, x: Math.round(b.x), y: Math.round(b.y), w: CARD.w, h: CARD.h, z: typeof now.z === "number" ? now.z : 0, ...(typeof now.group === "string" ? { group: now.group } : {}) } });
  }));
  if (plan) {
    const u = unionBox(stickies.map(elementBox))!;
    ops.push({ k: `el_plan_${plan.short_id.replace(/[^a-z0-9]/gi, "")}`, put: { kind: "card", ref: plan.short_id, x: Math.round(u.x), y: Math.round(u.y - CARD.h - 48), w: 360, h: CARD.h, z: nextZ({ elements: all }) } });
  }
  if (ops.length) live.apply(ops);
  if (made) toast.success(plan ? `Plan ${plan.short_id} with ${made} task${made === 1 ? "" : "s"}` : `${made} task${made === 1 ? "" : "s"} created`);
}

/** Upload an image file and place it at `at` (world), sized to fit 480px. */
export async function placeImage(live: BoardLive, convex: { mutation: any; query: any }, file: File, at: Pt, all: BoardEl[]): Promise<void> {
  const dims = await imageSize(file).catch(() => ({ w: 320, h: 220 }));
  const k = Math.min(1, 480 / Math.max(dims.w, dims.h));
  const w = Math.round(dims.w * k), h = Math.round(dims.h * k);
  const key = `el_img${Date.now().toString(36)}`;
  const base = { kind: "image", x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), w, h, alt: file.name, z: nextZ({ elements: all }) };
  live.apply([{ k: key, put: base }]);
  const storageId = await uploadBlobToStorage(convex, file, file.type);
  const src = storageId ? await convex.query((api as any).images.getImageUrl, { storageId }) : null;
  if (!src) {
    live.apply([{ k: key, del: true }], { undoable: false } as any);
    toast.error("Image upload failed");
    return;
  }
  live.apply([{ k: key, set: { src, storage_id: storageId } }], { undoable: false } as any);
}

function imageSize(file: File): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve({ w: img.naturalWidth || 320, h: img.naturalHeight || 220 }); URL.revokeObjectURL(url); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

// ── Clipboard ─────────────────────────────────────────────────────────────

const MARK = "codecast-board/v1";

export function serializeSelection(els: BoardEl[]): string {
  return JSON.stringify({ [MARK]: true, elements: els.map(({ rev, by, at, ...rest }) => rest) });
}

const REF_RE = /^(ct-\d+|pl-\d+|jx[a-z0-9]{5,}|doc:[a-z0-9]+|#\d+|tr-\d+)$/i;

/**
 * Ops for pasted clipboard text: board elements copied from a board, a
 * codecast reference (a live card), or plain lines (a sticky each, in a grid).
 */
export function pasteOps(text: string, at: Pt, all: BoardEl[], exists: (k: string) => boolean, from?: Pt | null): { ops: ArtifactOp[]; keys: string[] } {
  const z0 = nextZ({ elements: all });
  try {
    const parsed = JSON.parse(text);
    if (parsed?.[MARK] && Array.isArray(parsed.elements)) {
      const els = parsed.elements as BoardEl[];
      const u = unionBox(els.filter((e) => e.kind !== "connector").map(elementBox));
      // Pasting where the copy came from offsets it; elsewhere centers it on the pointer.
      const dx = u ? (from ? 24 : at.x - (u.x + u.w / 2)) : 24;
      const dy = u ? (from ? 24 : at.y - (u.y + u.h / 2)) : 24;
      return cloneOps(els, Math.round(dx), Math.round(dy), z0, exists);
    }
  } catch { /* not ours */ }
  const trimmed = text.trim();
  const url = /\/(?:tasks|plans|conversation)\/([A-Za-z0-9-]+)/.exec(trimmed);
  const ref = REF_RE.test(trimmed) ? trimmed : url ? url[1] : null;
  if (ref) return besideContent(placeItems([{ kind: "card", fields: { ref }, w: CARD.w, h: CARD.h }], [{ x: Math.round(at.x - CARD.w / 2), y: Math.round(at.y - CARD.h / 2) }], z0), all);
  const items = parseItems(trimmed.split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")).join("\n"));
  if (!items.length) return { ops: [], keys: [] };
  const cols = items.length === 1 ? 1 : squareCols(items.length, 5);
  const width = cols * 240 - 40;
  const positions = gridPositions(items, { cols, gap: 40, at: { x: Math.round(at.x - width / 2), y: Math.round(at.y - 80) } });
  return besideContent(placeItems(items, positions, z0), all);
}

/** Shift freshly placed content to the nearest spot clear of what is already on the board. */
function besideContent(placed: { ops: ArtifactOp[]; keys: string[] }, all: BoardEl[]): { ops: ArtifactOp[]; keys: string[] } {
  const boxes = placed.ops.flatMap((op) => ("put" in op ? [elementBox({ ...(op.put as any), key: op.k, rev: 0 })] : []));
  const block = unionBox(boxes);
  if (!block) return placed;
  const off = clearOffset(block, all.filter((e) => e.kind !== "connector" && e.kind !== "pen").map(elementBounds));
  if (!off.x && !off.y) return placed;
  for (const op of placed.ops) if ("put" in op) { op.put.x = Number(op.put.x) + off.x; op.put.y = Number(op.put.y) + off.y; }
  return placed;
}
