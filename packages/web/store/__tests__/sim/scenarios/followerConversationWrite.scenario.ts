// followerConversationWrite: a follower writes a conversation row that it and
// the host both hold (the host's copy came from IDB, its per-view feed is not
// mounted). The follower renames the session, and every window holds the new
// title after the settle (INV-followers). A follower's conversations write
// reaches the host as the whole value, which the host applies as a singleton;
// a registry `sync` entry on conversations once turned that into a collection
// push the engine dropped.
import { scenario, type ScenarioWorld } from "../dsl";

async function followerConversationWrite(w: ScenarioWorld): Promise<void> {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const f = a.followers[0]!;
  await w.expect(f).shows(s);
  const id = w.idOf(s);
  for (const win of a.windows) await win.run(() => (win.store.getState() as any).syncRecord("conversations", id, { _id: id, title: "t0" }));
  await w.settle();
  await f.run(() => (f.store.getState() as any).renameSession(id, "t1"));
  await w.settle();
}

scenario({ name: "followerConversationWrite", seeds: 2 }, followerConversationWrite);
