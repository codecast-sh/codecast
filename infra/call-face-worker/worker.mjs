// The host of an agent's face in a call.
//
// Convex seats a face for an agent fed into a huddle (packages/convex/convex/
// tavusPal.ts): it dispatches this worker into the room under the name
// "codecast-face", then has Tavus join the same room as `agent:<conversation>`.
// In LiveKit mode Tavus keeps a face only while a participant of kind "agent"
// is in the room, and a huddle holds only people, so this job is that
// participant. It publishes nothing and reads nothing; it stays exactly as
// long as the face does, and leaves early only if the face never comes or
// every person has gone, so a face can never outlive its call.
//
// Env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
import { fileURLToPath } from "node:url";
import { AutoSubscribe, cli, defineAgent, WorkerOptions } from "@livekit/agents";
import { RoomEvent } from "@livekit/rtc-node";

const AGENT_NAME = "codecast-face";
// Tavus joins a few seconds after the dispatch; give it ample time.
const FACE_ARRIVE_MS = 90_000;
// Everyone stepping out for a moment is not the call ending.
const ALONE_GRACE_MS = 120_000;

// Faces are `agent:<id>` and LiveKit names agent jobs `agent-<id>`; everyone
// else in a huddle is a person.
const isPerson = (identity) => !identity.startsWith("agent");

export default defineAgent({
  entry: async (ctx) => {
    const { face } = JSON.parse(ctx.job.metadata || "{}");
    if (!face) return ctx.shutdown("no face named");
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_NONE);
    const room = ctx.room;
    const reason = await new Promise((resolve) => {
      const present = (id) => [...room.remoteParticipants.values()].some((p) => p.identity === id);
      const people = () => [...room.remoteParticipants.values()].filter((p) => isPerson(p.identity)).length;
      setTimeout(() => !present(face) && resolve("face never arrived"), FACE_ARRIVE_MS);
      let alone = null;
      const checkPeople = () => {
        if (people() > 0) {
          clearTimeout(alone);
          alone = null;
        } else if (!alone) {
          alone = setTimeout(() => resolve("nobody left in the call"), ALONE_GRACE_MS);
        }
      };
      room.on(RoomEvent.ParticipantConnected, checkPeople);
      room.on(RoomEvent.ParticipantDisconnected, (p) => {
        if (p.identity === face) resolve("face left");
        else checkPeople();
      });
      room.on(RoomEvent.Disconnected, () => resolve("room closed"));
      checkPeople();
    });
    console.log(`[${room.name}] ${face}: ${reason}`);
    ctx.shutdown(reason);
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
