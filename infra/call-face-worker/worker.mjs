// An agent's face in a call.
//
// Convex dispatches this worker into a huddle's LiveKit room under the name
// "codecast-face" when an agent is fed into the call and its team has agent
// faces on (packages/convex/convex/callFace.ts). The job seats a Tavus face
// as `agent:<conversation>` and stays exactly as long as the face does: in
// LiveKit mode Tavus keeps a face only while a participant of kind "agent" is
// in the room, and this job is that participant. Two modes, from the dispatch:
//
//   face      Each reply the session posts to the call's chat arrives on the
//             codecast.face data topic, and the face says it.
//   realtime  A live model hears the people in the room, sees the active
//             speaker's camera or a shared screen when it answers, and talks
//             through the face, or as a plain voice when no face can be
//             seated (Tavus out of minutes or down). It answers when named, when it is the only
//             one the person can be talking to, or when someone follows up
//             on what it just said. It hands real work to the session
//             (ask_agent) and tells the room what the session found.
//
// It leaves when the face leaves, when the face never comes, or once every
// person has gone, so an agent never outlives its call.
//
// Env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, TAVUS_API_KEY,
// TAVUS_PAL_ID (an echo PAL on LiveKit transport), and for realtime
// OPENAI_API_KEY, CONVEX_SITE_URL, FACE_WORKER_SECRET. FACE_AGENT_NAME
// registers a test instance under another name, out of prod's dispatches.
import { fileURLToPath } from "node:url";
import { AutoSubscribe, cli, defineAgent, llm, voice, WorkerOptions } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { AudioMixer, AudioStream, RoomEvent, TrackKind, TrackSource, VideoStream } from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";

const AGENT_NAME = process.env.FACE_AGENT_NAME || "codecast-face";
const FACE_TOPIC = "codecast.face";
const TAVUS_TOPIC = "app_messages";
// Tavus joins a few seconds after the face is created; give it ample time.
const FACE_ARRIVE_MS = 90_000;
// Everyone stepping out for a moment is not the call ending.
const ALONE_GRACE_MS = 120_000;
// A huddle can run for hours; Tavus ends a conversation at an hour unless told.
const MAX_CALL_SECONDS = 4 * 3600;
// How long a reply the face says word for word, ending on a whole sentence.
const SPOKEN_MAX = 600;
// A person's next words this soon after the voice spoke are likely for it.
const FOLLOW_UP_MS = 15_000;
const SAMPLE_RATE = 24_000;

// Faces are `agent:<id>` and LiveKit names agent jobs `agent-<id>`; everyone
// else in a huddle is a person.
const isPerson = (p) => !p.identity.startsWith("agent");
const people = (room) => [...room.remoteParticipants.values()].filter(isPerson);

/** Call `fn` for every track this job subscribes to, the ones it already
 *  holds included: the room's people are usually there before the job is. */
function eachTrack(room, fn) {
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) if (pub.track) fn(pub.track, pub, p);
  }
  room.on(RoomEvent.TrackSubscribed, fn);
}

async function tavus(method, path, body) {
  const res = await fetch(`https://tavusapi.com/v2/${path}`, {
    method,
    headers: { "x-api-key": process.env.TAVUS_API_KEY, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Tavus ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Seat the face: a Tavus conversation that joins this room as `identity`,
 *  publishing on this job's behalf. Ends with the job. */
async function seatFace(ctx, meta, identity) {
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity,
    name: meta.name,
    ttl: MAX_CALL_SECONDS,
    metadata: JSON.stringify({ agent_conversation_id: meta.conversation_id }),
  });
  at.kind = "agent";
  at.addGrant({ roomJoin: true, room: ctx.room.name, canPublish: true, canSubscribe: true, canPublishData: true });
  at.attributes = { "lk.publish_on_behalf": ctx.room.localParticipant.identity };
  const created = await tavus("POST", "conversations", {
    pal_id: process.env.TAVUS_PAL_ID,
    face_id: meta.face,
    conversation_name: `${meta.name} in ${ctx.room.name}`.slice(0, 120),
    properties: { livekit_ws_url: process.env.LIVEKIT_URL, livekit_room_token: await at.toJwt(), max_call_duration: MAX_CALL_SECONDS },
  });
  ctx.addShutdownCallback(async () => {
    await tavus("POST", `conversations/${created.conversation_id}/end`).catch(() => {});
  });
  return created.conversation_id;
}

/** A reply as speech: the plain line, ending on a whole sentence. */
function speakable(text) {
  if (text.length <= SPOKEN_MAX) return text;
  const head = text.slice(0, SPOKEN_MAX);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  return end > SPOKEN_MAX / 3 ? head.slice(0, end + 1) : `${head.slice(0, head.lastIndexOf(" "))}…`;
}

/** The session's replies, as Convex sends them on the room's data channel. */
function onReply(room, conversationId, fn) {
  room.on(RoomEvent.DataReceived, (data, _p, _kind, topic) => {
    if (topic !== FACE_TOPIC) return;
    try {
      const msg = JSON.parse(new TextDecoder().decode(data));
      if (msg.conversation_id === conversationId && msg.kind === "reply" && msg.text) fn(msg.text);
    } catch {}
  });
}

/** Face mode: say each reply word for word. */
function runFace(room, meta, identity, tavusId) {
  onReply(room, meta.conversation_id, (text) => {
    const echo = {
      message_type: "conversation",
      event_type: "conversation.echo",
      conversation_id: tavusId,
      properties: { modality: "text", text: speakable(text), done: true },
    };
    room.localParticipant
      .publishData(new TextEncoder().encode(JSON.stringify(echo)), { reliable: true, topic: TAVUS_TOPIC, destination_identities: [identity] })
      .catch((e) => console.error("echo failed", e));
  });
}

async function convex(op, meta, room, extra = {}) {
  const res = await fetch(`${process.env.CONVEX_SITE_URL}/calls/face`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.FACE_WORKER_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ op, conversation_id: meta.conversation_id, room_key: room.name, ...extra }),
  });
  if (!res.ok) throw new Error(`convex ${op}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Every person's microphone, mixed into the one input the model hears. */
class RoomMix extends voice.AudioInput {
  constructor() {
    super();
    this.mixer = new AudioMixer(SAMPLE_RATE, 1, { blocksize: SAMPLE_RATE / 20, streamTimeoutMs: 50 });
    this.streams = new Map();
    this.multiStream.addInputStream(ReadableStream.from(this.mixer));
  }
  add(sid, track) {
    if (this.streams.has(sid)) return;
    const stream = new AudioStream(track, { sampleRate: SAMPLE_RATE, numChannels: 1 });
    this.streams.set(sid, stream);
    this.mixer.addStream(stream);
  }
  remove(sid) {
    const stream = this.streams.get(sid);
    if (!stream) return;
    this.streams.delete(sid);
    this.mixer.removeStream(stream);
  }
}

/** The newest frame of every person's camera and screen share. */
function watchVideo(room) {
  const latest = new Map();
  const key = (p, source) => `${p.identity}:${source}`;
  eachTrack(room, async (track, pub, p) => {
    if (track.kind !== TrackKind.KIND_VIDEO || !isPerson(p)) return;
    for await (const ev of new VideoStream(track)) latest.set(key(p, pub.source), ev.frame);
    latest.delete(key(p, pub.source));
  });
  return (speaker) => {
    for (const p of people(room)) {
      const screen = latest.get(key(p, TrackSource.SOURCE_SCREENSHARE));
      if (screen) return { frame: screen, what: `${p.name || "someone"}'s shared screen` };
    }
    const cam = speaker && latest.get(key(speaker, TrackSource.SOURCE_CAMERA));
    return cam ? { frame: cam, what: `${speaker.name || "the speaker"}'s camera` } : null;
  };
}

/** Real-time mode: a live model that hears and sees the room, speaking
 *  through the face, or as this job's own audio track when `face` is null. */
async function runRealtime(ctx, meta, face) {
  const room = ctx.room;
  const brief = await convex("brief", meta, room);
  if (!brief) throw new Error("no brief: the feed ended or real-time is off for this team");
  const named = brief.spoken_names.map(
    (n) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu"),
  );

  const mix = new RoomMix();
  eachTrack(room, (track, pub, p) => {
    if (track.kind === TrackKind.KIND_AUDIO && isPerson(p)) mix.add(pub.sid, track);
  });
  room.on(RoomEvent.TrackUnsubscribed, (_t, pub) => mix.remove(pub.sid));
  const frameFor = watchVideo(room);
  let speaker = null;
  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    speaker = speakers.find(isPerson) ?? speaker;
  });

  const session = new voice.AgentSession({
    llm: new openai.realtime.RealtimeModel({
      voice: meta.voice,
      // The model hears everything; this worker decides when it answers.
      // Silence ends a turn: semantic turn detection waited 2.5s past the
      // last word where 600ms of silence answers in about 1s, and a person
      // who keeps talking cuts the voice off.
      turnDetection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600, create_response: false, interrupt_response: true },
    }),
  });
  session.input.audio = mix;
  if (face) {
    session.output.audio = new voice.DataStreamAudioOutput({
      room,
      destinationIdentity: face,
      sampleRate: SAMPLE_RATE,
      waitRemoteTrack: TrackKind.KIND_VIDEO,
    });
  }
  const agent = new voice.Agent({
    instructions: brief.instructions,
    tools: {
      ask_agent: llm.tool({
        description: "Hand your working session something that needs real work: a lookup in code or data, a change, anything you are not sure of. Returns at once; its answer comes back to you later.",
        parameters: { type: "object", properties: { request: { type: "string", description: "What to do or find out, with the context it needs." } }, required: ["request"] },
        execute: async ({ request }) => {
          await convex("ask", meta, room, { text: request, speaker: speaker?.name || "" });
          return "Handed to your session. Tell the room briefly that you are on it.";
        },
      }),
    },
  });
  await session.start({ agent, room, inputOptions: { textEnabled: false }, outputOptions: { transcriptionEnabled: false } });

  let lastSpokeAt = 0;
  let shownImage = null;
  const answer = async (opts = {}) => {
    const seen = frameFor(speaker);
    const ctxCopy = agent.chatCtx.copy();
    if (shownImage) ctxCopy.items = ctxCopy.items.filter((i) => i.id !== shownImage);
    if (seen) {
      shownImage = ctxCopy.addMessage({
        role: "user",
        content: [`(What you can see right now: ${seen.what}.)`, llm.createImageContent({ image: seen.frame, inferenceWidth: 1024, inferenceHeight: 1024 })],
      }).id;
    } else shownImage = null;
    await agent.updateChatCtx(ctxCopy).catch((e) => console.error("vision update failed", e));
    session.generateReply(opts);
  };

  // A turn is answered once. With one person in the call every turn is for
  // the voice, so it answers the moment the turn ends; with more, it waits
  // for the words to know whether it was named or followed up on.
  let answered = false;
  const answerTurn = () => {
    answered = true;
    answer().catch((e) => console.error("answer failed", e));
  };
  session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
    if (ev.newState === "speaking") answered = false;
    else if (ev.oldState === "speaking" && !answered && people(room).length <= 1) answerTurn();
  });
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
    if (!ev.isFinal || answered || !ev.transcript.trim()) return;
    const addressed = named.some((re) => re.test(ev.transcript));
    const followUp = Date.now() - lastSpokeAt < FOLLOW_UP_MS;
    if (addressed || followUp || people(room).length <= 1) answerTurn();
  });
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    if (ev.item.type !== "message" || ev.item.role !== "assistant") return;
    lastSpokeAt = Date.now();
    const text = ev.item.textContent?.trim();
    if (text) convex("said", meta, room, { text }).catch((e) => console.error("said failed", e));
  });
  onReply(room, meta.conversation_id, (text) => {
    answer({
      instructions: `Your working session just finished a turn. What it said, already in the call's chat: "${text}". Tell the room the gist in a sentence or two, in your own words.`,
    }).catch((e) => console.error("tell failed", e));
  });
}

export default defineAgent({
  entry: async (ctx) => {
    const meta = JSON.parse(ctx.job.metadata || "{}");
    if (!meta.conversation_id) return ctx.shutdown("no session named");
    const identity = `agent:${meta.conversation_id}`;
    await ctx.connect(undefined, meta.realtime ? AutoSubscribe.SUBSCRIBE_ALL : AutoSubscribe.SUBSCRIBE_NONE);
    const room = ctx.room;
    let tavusId = null;
    try {
      tavusId = await seatFace(ctx, meta, identity);
    } catch (e) {
      if (!meta.realtime) throw e;
      console.error(`[${room.name}] no face, speaking as a voice:`, e.message);
    }
    const face = tavusId ? identity : null;
    if (meta.realtime) await runRealtime(ctx, meta, face);
    else runFace(room, meta, identity, tavusId);

    const reason = await new Promise((resolve) => {
      if (face) setTimeout(() => !room.remoteParticipants.has(face) && resolve("face never arrived"), FACE_ARRIVE_MS);
      let alone = null;
      const checkPeople = () => {
        if (people(room).length > 0) {
          clearTimeout(alone);
          alone = null;
        } else if (!alone) {
          alone = setTimeout(() => resolve("nobody left in the call"), ALONE_GRACE_MS);
        }
      };
      room.on(RoomEvent.ParticipantConnected, checkPeople);
      room.on(RoomEvent.ParticipantDisconnected, (p) => {
        if (face && p.identity === face) resolve("face left");
        else checkPeople();
      });
      room.on(RoomEvent.Disconnected, () => resolve("room closed"));
      checkPeople();
    });
    console.log(`[${room.name}] ${identity}${face ? "" : " (voice only)"}: ${reason}`);
    ctx.shutdown(reason);
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
