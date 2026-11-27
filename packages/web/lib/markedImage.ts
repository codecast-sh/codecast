// A picture with the user's pinned notes drawn on it as numbered markers, so
// the agent sees exactly where each note points instead of reading
// coordinates. Each marker is a ring around the point (what it points at stays
// visible) and a numbered badge beside it, tied to the ring by a short stem.
import { drawFitted, encodeCompact } from "./compressImage";
import { uploadBlobToStorage } from "./uploadBlob";
import { BADGE_EDGE, BADGE_TEXT, MARKER_FILL, MARKER_STROKES, markerShapes, type ImageMarker } from "./markerGeometry";

export type { ImageMarker };

export async function drawMarkers(picture: Blob, markers: readonly ImageMarker[]): Promise<Blob | null> {
  try {
    const drawn = await drawFitted(picture);
    if (!drawn) return null;
    const { ctx, w, h } = drawn;
    for (const { r, ring, stem, badge, text, number } of markerShapes(markers, w, h)) {
      const ringAndStem = () => {
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
        ctx.moveTo(stem.x1, stem.y1);
        ctx.lineTo(stem.x2, stem.y2);
      };
      ctx.lineCap = "round";
      for (const [style, width] of MARKER_STROKES) {
        ringAndStem();
        ctx.strokeStyle = style;
        ctx.lineWidth = r * width;
        ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(badge.x, badge.y, badge.r, 0, Math.PI * 2);
      ctx.fillStyle = MARKER_FILL; ctx.fill();
      ctx.lineWidth = r * BADGE_EDGE.width; ctx.strokeStyle = BADGE_EDGE.color; ctx.stroke();
      ctx.fillStyle = BADGE_TEXT;
      ctx.font = `bold ${text.size}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(number), text.x, text.y);
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
