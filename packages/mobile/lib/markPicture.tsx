// The phone's half of lib/markedImage on the web: a picture with its pinned
// notes drawn on as numbered markers, uploaded so the agent sees where each
// note points. React Native has no canvas, so the picture and its markers are
// laid out in an offscreen react-native-svg <Svg> and read back with its
// toDataURL snapshot (a PNG). The geometry is the web's (lib/markerGeometry).
//
// A snapshot needs a mounted view, but a send's marking finishes after the
// composer has cleared and maybe after the person left the session, so the
// view lives in one MarkerRenderHost at the app root, fed by a module-level
// queue, one picture at a time. Every failure (no host, an unreadable
// picture, a load that never lands, a snapshot error) resolves to null, and
// the send then carries the original picture: marking never blocks a send.
import { useEffect, useReducer, useRef } from 'react';
import { Image, PixelRatio, Platform, View } from 'react-native';
import Svg, { Circle, G, Image as SvgImage, Line, Text as SvgText } from 'react-native-svg';
import type { ConvexReactClient } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { BADGE_EDGE, BADGE_TEXT, MARKER_FILL, MARKER_STROKES, markerShapes, type ImageMarker } from '@codecast/web/lib/markerGeometry';
import { awaitUpload, pendingImageUploads } from '@codecast/web/lib/pendingUploads';
import type { OptimisticImage } from '@codecast/web/store/inboxStore';
import { base64Bytes, fittedSize, snapshotPlan, type SendPicture } from './pictureNotesSend';

// The whole marking of one picture, fetch to PNG: past it the send goes on
// with the original.
const MARK_TIMEOUT_MS = 20_000;
// From mounting the snapshot view to its PNG: a picture that never loads
// gives up here so the queue behind it moves.
const SNAPSHOT_TIMEOUT_MS = 10_000;

type Job = { id: number; dataUri: string; w: number; h: number; markers: readonly ImageMarker[]; done: (b64: string | null) => void };
const jobs: Job[] = [];
let nextJobId = 1;
let wakeHost: (() => void) | null = null;

/**
 * The picture at `src` (a file, remote or data URI) with `markers` drawn on,
 * capped on its long side as the web caps it, as a PNG data URI; null on any
 * failure. Exported so a dev screen can exercise the renderer on a device.
 */
export function markPicture(p: { src: string; width?: number; height?: number; markers: readonly ImageMarker[] }): Promise<string | null> {
  return withTimeout((async () => {
    if (!wakeHost) return null;
    const size = p.width && p.height ? { w: p.width, h: p.height } : await imageSize(p.src);
    if (!size) return null;
    // Loaded as bytes first: the SVG's image then needs no network, and on
    // Android a remote href inside the snapshot can be missing if it has not
    // landed yet.
    const dataUri = await asDataUri(p.src);
    if (!dataUri) return null;
    const { w, h } = fittedSize(size.w, size.h);
    const b64 = await new Promise<string | null>((done) => {
      if (!wakeHost) return done(null);
      jobs.push({ id: nextJobId++, dataUri, w, h, markers: p.markers, done });
      wakeHost();
    });
    return b64 ? `data:image/png;base64,${b64.replace(/\s+/g, '')}` : null;
  })().catch(() => null), MARK_TIMEOUT_MS);
}

/** Draw the markers, upload the marked copy, and resolve to its storage id,
 *  or to the original's when any step fails (lib/markedImage uploadMarkedImage). */
export async function uploadMarkedPicture(
  convex: ConvexReactClient,
  p: { src: string; storageId: string; width?: number; height?: number; markers: readonly ImageMarker[] },
): Promise<string> {
  if (!p.markers.length) return p.storageId;
  try {
    const marked = await markPicture(p);
    if (!marked) return p.storageId;
    const uploadUrl = await convex.mutation(api.images.generateUploadUrl, {});
    // Bytes, not the data URI: Android's fetch cannot read a data: URI as a blob.
    const res = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: base64Bytes(marked.slice(marked.indexOf(',') + 1)) });
    if (!res.ok) return p.storageId;
    const { storageId } = await res.json();
    return (storageId as string | undefined) ?? p.storageId;
  } catch {
    return p.storageId;
  }
}

/**
 * A send's pictures as the optimistic bubble and dispatchComposerSend take
 * them. A picture with markers rides as its preview, uploading: its entry in
 * pendingImageUploads (where dispatchComposerSend waits on the preview's
 * upload) becomes the marked copy's upload, chained after the original's
 * when that is still in flight, so the send goes out with the marked copy
 * once it lands, or with the original when marking fails.
 */
export function stageSendPictures(convex: ConvexReactClient, pictures: readonly SendPicture[]): OptimisticImage[] {
  return pictures.map((p): OptimisticImage => {
    if (!p.markers?.length) {
      return p.storageId ? { media_type: p.mime, storage_id: p.storageId } : { media_type: p.mime, preview_url: p.src, uploading: true };
    }
    const markers = p.markers;
    const original = p.storageId ? Promise.resolve<string | null>(p.storageId) : awaitUpload(p.src);
    pendingImageUploads.set(p.src, original.then((storageId) => (storageId ? uploadMarkedPicture(convex, { ...p, storageId, markers }) : null)));
    return { media_type: 'image/png', preview_url: p.src, uploading: true };
  });
}

/** Mounted once at the app root; draws the queue's head offscreen. */
export function MarkerRenderHost() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    wakeHost = bump;
    if (jobs.length) bump();
    return () => {
      wakeHost = null;
      jobs.splice(0).forEach((job) => job.done(null));
    };
  }, []);
  const job = jobs[0];
  if (!job) return null;
  return (
    <MarkerSnapshot
      key={job.id}
      job={job}
      onDone={(b64) => {
        if (jobs[0] === job) jobs.shift();
        job.done(b64);
        bump();
      }}
    />
  );
}

function MarkerSnapshot({ job, onDone }: { job: Job; onDone: (b64: string | null) => void }) {
  const svg = useRef<Svg>(null);
  const state = useRef({ laidOut: false, loaded: false, settled: false });
  const { w, h } = job;
  const plan = snapshotPlan(Platform.OS, w, h, PixelRatio.get());

  const finish = (b64: string | null) => {
    if (state.current.settled) return;
    state.current.settled = true;
    onDone(b64);
  };
  const shoot = () => {
    const s = state.current;
    if (!s.laidOut || s.settled) return;
    if (s.loaded) {
      // A frame after the load, so the decoded picture is what the snapshot draws.
      requestAnimationFrame(() => svg.current?.toDataURL((b64) => finish(b64 || null), plan.options));
    } else if (Platform.OS === 'android') {
      // Android's SVG image starts loading only when it is first drawn, and an
      // offscreen view is never drawn: a throwaway snapshot draws it once, and
      // its onLoad then takes the real one.
      svg.current?.toDataURL(() => {}, plan.options);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => finish(null), SNAPSHOT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: -100_000, top: 0, ...plan.layout }}
      onLayout={() => { state.current.laidOut = true; shoot(); }}
    >
      <Svg ref={svg} width={plan.layout.width} height={plan.layout.height} viewBox={`0 0 ${w} ${h}`}>
        <SvgImage
          href={job.dataUri}
          x={0}
          y={0}
          width={w}
          height={h}
          preserveAspectRatio="none"
          onLoad={() => { state.current.loaded = true; shoot(); }}
        />
        {markerShapes(job.markers, w, h).map((shape, i) => <Marker key={i} {...shape} />)}
      </Svg>
    </View>
  );
}

function Marker({ number, r, ring, stem, badge, text }: ReturnType<typeof markerShapes>[number]) {
  return (
    <>
      {/* Ring and stem take each stroke together, the dark one first, as the
          canvas strokes them as one path. */}
      {MARKER_STROKES.map(([color, width]) => (
        <G key={color}>
          <Circle cx={ring.x} cy={ring.y} r={ring.r} fill="none" stroke={color} strokeWidth={r * width} />
          <Line x1={stem.x1} y1={stem.y1} x2={stem.x2} y2={stem.y2} stroke={color} strokeWidth={r * width} strokeLinecap="round" />
        </G>
      ))}
      <Circle cx={badge.x} cy={badge.y} r={badge.r} fill={MARKER_FILL} stroke={BADGE_EDGE.color} strokeWidth={r * BADGE_EDGE.width} />
      {/* The canvas centers on the em box ("middle"); SVG sets the alphabetic
          baseline, about 0.35em below that middle for digits. */}
      <SvgText x={text.x} y={text.y + text.size * 0.35} fontSize={text.size} fontWeight="bold" textAnchor="middle" fill={BADGE_TEXT}>
        {String(number)}
      </SvgText>
    </>
  );
}

function imageSize(src: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => Image.getSize(src, (w, h) => resolve(w && h ? { w, h } : null), () => resolve(null)));
}

async function asDataUri(src: string): Promise<string | null> {
  if (src.startsWith('data:')) return src;
  const res = await fetch(src);
  if (!res.ok) return null;
  const blob = await res.blob();
  return await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

function withTimeout<T>(task: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void task.then((v) => { clearTimeout(timer); resolve(v); });
  });
}
