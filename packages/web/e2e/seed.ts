// Seeds sessions for the e2e kill test on the e2e deployment (target.ts):
// `bun run e2e/seed.ts 3` prints three conversation ids, two messages each.
import { api } from "@codecast/convex/convex/_generated/api";
import { client as c } from "./target";
const me: any = await c.query(api.users.getCurrentUser, {});
const n = Number(process.argv[2] ?? 3);
const ids: string[] = [];
for (let i = 0; i < n; i++) {
  const id: any = await c.mutation(api.conversations.createConversation, {
    user_id: me._id, agent_type: "claude_code", session_id: crypto.randomUUID(), project_path: "/tmp/codecast-e2e",
    title: `E2E kill test ${i + 1} ${new Date().toISOString().slice(11, 19)}`, started_at: Date.now(),
  } as any);
  const convId = typeof id === "string" ? id : id?._id ?? id?.id ?? id?.conversation_id;
  await c.mutation(api.messages.addMessage, { conversation_id: convId, role: "user", content: `hello ${i + 1}`, message_uuid: crypto.randomUUID() } as any);
  await c.mutation(api.messages.addMessage, { conversation_id: convId, role: "assistant", content: `hi ${i + 1}`, message_uuid: crypto.randomUUID() } as any);
  ids.push(String(convId));
}
console.log(JSON.stringify(ids));
