// A picture with the user's pinned notes drawn on it as numbered markers, so
// the agent sees exactly where each note points instead of reading
// coordinates. Each marker is a ring around the point (what it points at stays
// visible) and a numbered badge beside it, tied to the ring by a short stem.
import { drawFitted, encodeCompact } from "./compressImage";
import { uploadBlobToStorage } from "./uploadBlob";

export type ImageMarker = { x: number; y: number; number: number };

// Solarized yellow, the gallery's pin color.
const MARKER_FILL = "#b58900";

// Where a marker draws on a w×h picture, in its pixels: the ring at the point
// (px, py), and the badge of radius r at (bx, by), up and to the right of the
// point, flipped near an edge so it stays on the picture. The transcript's
// hover areas (components/MarkerNotes) place themselves with the same numbers.
export function markerLayout(point: { x: number; y: number }, w: number, h: number) {
  const r = Math.max(11, Math.round(Math.min(w, h) * 0.022));
  const px = point.x * w;
  const py = point.y * h;
  const dx = px + r * 3.2 > w ? -1 : 1;
  const dy = py - r * 3.2 < 0 ? 1 : -1;
  return { r, px, py, dx, dy, bx: px + dx * r * 2, by: py + dy * r * 2 };
}

export async function drawMarkers(picture: Blob, markers: readonly ImageMarker[]): Promise<Blob | null> {
  try {
    const drawn = await drawFitted(picture);
    if (!drawn) return null;
    const { ctx, w, h } = drawn;
    for (const m of markers) {
      const { r, px, py, dx, dy, bx, by } = markerLayout(m, w, h);
      const ringAndStem = () => {
        const k = r * 0.55;
        ctx.beginPath();
        ctx.arc(px, py, k, 0, Math.PI * 2);
        ctx.moveTo(px + dx * k * Math.SQRT1_2, py + dy * k * Math.SQRT1_2);
        ctx.lineTo(bx, by);
      };
      ctx.lineCap = "round";
      // A dark under-stroke, then the yellow, so it reads on any background.
      for (const [style, width] of [["rgba(0,0,0,0.6)", 0.5], [MARKER_FILL, 0.22]] as const) {
        ringAndStem();
        ctx.strokeStyle = style;
        ctx.lineWidth = r * width;
        ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fillStyle = MARKER_FILL; ctx.fill();
      ctx.lineWidth = r * 0.18; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.stroke();
      ctx.fillStyle = "#000";
      ctx.font = `bold ${Math.round(r * 1.15)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(m.number), bx, by + r * 0.06);
    }
    return await encodeCompact(drawn.canvas);
  } catch {
    return null;
  }
}

// Fetch the picture, draw its markers and upload the result. Resolves to the
// marked copy's storage id, or the original's when any step fails: the agent
// then still gets the picture, only without the markers.
export async function uploadMarkedImage(
  convex: Parameters<typeof uploadBlobToStorage>[0],
  picture: { src: string; storageId: string; markers: readonly ImageMarker[] },
): Promise<string> {
  if (!picture.markers.length) return picture.storageId;
  try {
    const res = await fetch(picture.src);
    if (!res.ok) return picture.storageId;
    const marked = await drawMarkers(await res.blob(), picture.markers);
    if (!marked) return picture.storageId;
    return (await uploadBlobToStorage(convex, marked, marked.type)) ?? picture.storageId;
  } catch {
    return picture.storageId;
  }
}
