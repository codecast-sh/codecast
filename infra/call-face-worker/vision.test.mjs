// What the voice sees as people share, stop sharing, and turn cameras off.
// Needs a local LiveKit with remote unmute on (`room: enable_remote_unmute: true`
// in a config passed to `livekit-server --dev --config`), then `node vision.test.mjs`.
import assert from "node:assert/strict";
import { LocalVideoTrack, Room, TrackPublishOptions, TrackSource, VideoBufferType, VideoFrame, VideoSource } from "@livekit/rtc-node";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { watchVideo } from "./vision.mjs";

const URL = process.env.LIVEKIT_TEST_URL || "ws://127.0.0.1:7880";
const ROOM = `vision-${Date.now()}`;
// A browser turning its camera off mutes the track; rtc-node cannot mute
// from the publisher, so the server does it, and subscribers see the same event.
const server = new RoomServiceClient(URL.replace(/^ws/, "http"), "devkey", "secret");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function join(identity) {
  const at = new AccessToken("devkey", "secret", { identity, name: identity });
  at.addGrant({ roomJoin: true, room: ROOM, canPublish: true, canSubscribe: true });
  const room = new Room();
  await room.connect(URL, await at.toJwt(), { autoSubscribe: true });
  return room;
}

/** A synthetic video track sending a grey frame ten times a second. */
async function publish(room, source) {
  const video = new VideoSource(320, 240);
  const track = LocalVideoTrack.createVideoTrack(String(source), video);
  const buf = new Uint8Array(320 * 240 * 4).fill(128);
  const timer = setInterval(() => video.captureFrame(new VideoFrame(buf, 320, 240, VideoBufferType.RGBA)), 100);
  const opts = new TrackPublishOptions();
  opts.source = source;
  const pub = await room.localParticipant.publishTrack(track, opts);
  return { pub, stop: () => clearInterval(timer) };
}

const ashot = await join("ashot");
const jason = await join("jason");
const agent = await join("agent-test");
const look = watchVideo(agent);
const sees = (speaker) => look(agent.remoteParticipants.get(speaker)).map((v) => v.what);

const ashotCam = await publish(ashot, TrackSource.SOURCE_CAMERA);
const jasonCam = await publish(jason, TrackSource.SOURCE_CAMERA);
const share = await publish(ashot, TrackSource.SOURCE_SCREENSHARE);
await sleep(3000);
assert.deepEqual(sees("ashot"), ["ashot's shared screen", "ashot's camera", "jason's camera"]);
assert.deepEqual(sees("jason"), ["ashot's shared screen", "jason's camera", "ashot's camera"]);

await ashot.localParticipant.unpublishTrack(share.pub.sid);
share.stop();
await sleep(2000);
assert.deepEqual(sees("ashot"), ["ashot's camera", "jason's camera"]);

await server.mutePublishedTrack(ROOM, "jason", jasonCam.pub.sid, true);
await sleep(2000);
assert.deepEqual(sees("ashot"), ["ashot's camera"]);
await server.mutePublishedTrack(ROOM, "jason", jasonCam.pub.sid, false);
await sleep(2000);
assert.deepEqual(sees("ashot"), ["ashot's camera", "jason's camera"]);

await ashot.localParticipant.unpublishTrack(ashotCam.pub.sid);
ashotCam.stop();
await jason.localParticipant.unpublishTrack(jasonCam.pub.sid);
jasonCam.stop();
await sleep(2000);
assert.deepEqual(sees("ashot"), []);

await Promise.all([ashot.disconnect(), jason.disconnect(), agent.disconnect()]);
console.log("vision: ok");
process.exit(0);
