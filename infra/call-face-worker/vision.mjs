// What the in-call voice can see: the newest frame of every screen share and
// camera that is live right now. Split out of worker.mjs so a local LiveKit
// run can drive it (vision.test.mjs).
import { RoomEvent, TrackKind, TrackSource, VideoStream } from "@livekit/rtc-node";

// Faces are `agent:<id>` and LiveKit names agent jobs `agent-<id>`; everyone
// else in a huddle is a person.
export const isPerson = (p) => !p.identity.startsWith("agent");
export const people = (room) => [...room.remoteParticipants.values()].filter(isPerson);

// Frames shown with one answer: a share and the cameras of a small call.
const MAX_VIEWS = 4;

/** Call `fn` for every track this job subscribes to, the ones it already
 *  holds included: the room's people are usually there before the job is. */
export function eachTrack(room, fn) {
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) if (pub.track) fn(pub.track, pub, p);
  }
  room.on(RoomEvent.TrackSubscribed, fn);
}

/** Keep the newest frame of each person's video, one entry per publication.
 *  A native VideoStream never ends when its track is unsubscribed, so an
 *  entry is dropped on the room's own events, and a muted track holds no
 *  frame. Returns `look(speaker)`: every live share, then cameras with the
 *  speaker's first, each with whose it is. */
export function watchVideo(room) {
  const views = new Map();
  const drop = (sid) => {
    const view = views.get(sid);
    if (!view) return;
    views.delete(sid);
    view.reader.cancel().catch(() => {});
  };
  eachTrack(room, async (track, pub, p) => {
    if (track.kind !== TrackKind.KIND_VIDEO || !isPerson(p)) return;
    drop(pub.sid);
    const view = { pub, p, frame: null, reader: new VideoStream(track).getReader() };
    views.set(pub.sid, view);
    try {
      for (;;) {
        const { value, done } = await view.reader.read();
        if (done) break;
        if (!pub.muted) view.frame = value.frame;
      }
    } catch {}
    if (views.get(pub.sid) === view) views.delete(pub.sid);
  });
  room.on(RoomEvent.TrackUnsubscribed, (_t, pub) => drop(pub.sid));
  room.on(RoomEvent.TrackUnpublished, (pub) => drop(pub.sid));
  room.on(RoomEvent.TrackMuted, (pub) => {
    const view = views.get(pub.sid);
    if (view) view.frame = null;
  });

  return (speaker) => {
    const live = [...views.values()].filter((v) => v.frame);
    const screens = live.filter((v) => v.pub.source === TrackSource.SOURCE_SCREENSHARE);
    const cameras = live
      .filter((v) => v.pub.source === TrackSource.SOURCE_CAMERA)
      .sort((a, b) => (b.p.identity === speaker?.identity) - (a.p.identity === speaker?.identity));
    return [
      ...screens.map((v) => ({ frame: v.frame, what: `${v.p.name || "someone"}'s shared screen`, size: 1024 })),
      ...cameras.map((v) => ({ frame: v.frame, what: `${v.p.name || "someone"}'s camera`, size: 512 })),
    ].slice(0, MAX_VIEWS);
  };
}
